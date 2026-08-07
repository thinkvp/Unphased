/**
 * Unphased — main.js (UXP)
 * Panel orchestration: scan sequence -> pick tracks -> build pairs ->
 * run the engine in-panel -> import & place -> report.
 *
 * Layered over:
 *   premiere.js — host reads and edits via the Premiere UXP DOM
 *   pairing.js  — the CEP panel's clip-pair matcher, shared verbatim
 *   runner.js   — the engine's runJob, ported off child_process
 *   audio.js    — decode + probe via the bundled FFmpeg native addon
 *
 * UXP idioms this port uses, all of them differences from the CEP panel:
 *   - Actions are <div class="btn"> with .is-disabled; UXP's native <button>
 *     widget ignores author CSS backgrounds.
 *   - Visibility is style.display, not the `hidden` attribute.
 *   - No <select>: the Time/Phase/Scope pickers are segmented controls and the
 *     per-track source picker is a chip that cycles through the file's channels.
 *   - No <input type="checkbox">: REF/TGT are divs carrying an .is-on class.
 *
 * NOTE: main.js is loaded via <script src="js/main.js">, so UXP resolves its
 * require() base at the plugin ROOT, not js/.
 */
"use strict";

const premiere = require("./js/premiere");
const pairing = require("./js/pairing");
const runner = require("./js/runner");
const audio = require("./js/audio");

const RENDER_DIR_KEY = "unphased.renderDir";
const BIN_NAME = "Unphased Audio";
const TIPS_DISMISSED_KEY = "unphased.tipsDismissed";

const state = {
    seqInfo: null,
    refTrack: null,
    // No targetTracks: every non-reference track with a live-selected clip is
    // a target automatically. Whole-sequence mode is gone — Unphased only
    // ever aligns what is selected in the timeline.
    running: false,
    cancelRequested: false,
    probe: {},          // mediaPath -> { streams: [{index, channels, ...}] }
    sourceMap: {},      // trackIndex -> { audioStream, channel }
    sourceOverrides: {},
    showSources: false, // source pickers stay closed until asked for
    projectPath: null,
    renderDir: null,
    params: { mode: "dynamic", phase: "spectral" },
    addonOk: null,
    lastLiveSeqName: undefined, // undefined = not polled yet; null = polled, none active
    polling: false,
    liveSelection: null,        // trackIndex -> selected clip count, kept fresh by pollSelection()
    liveSelectionReported: null, // last getSelectionOnly() reportedByHost, for the "video not audio" hint
    pollingSelection: false
};

const $ = (id) => document.getElementById(id);
const show = (el, visible) => { if (el) el.style.display = visible ? "" : "none"; };
const enable = (el, on) => { if (el) el.className = el.className.replace(/\s*is-disabled/g, "") + (on ? "" : " is-disabled"); };

// ─── Log ──────────────────────────────────────────────────────────────────────
function log(msg, type) {
    const el = $("log");
    const entry = document.createElement("div");
    entry.className = "log-entry log-" + (type || "info");
    const d = new Date();
    const p = (n) => ("0" + n).slice(-2);
    entry.textContent = `[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}] ${msg}`;
    el.appendChild(entry);
    el.scrollTop = el.scrollHeight;
}

// ─── Busy / progress ──────────────────────────────────────────────────────────
function setBusy(text, cancellable) {
    if (text) {
        $("busy-text").textContent = text;
        show($("busy-row"), true);
        show($("btn-cancel"), !!cancellable);
        enable($("btn-cancel"), true);
    } else {
        show($("busy-row"), false);
    }
}

function setProgress(pct, visible) {
    $("progress-wrap").style.display = visible === false ? "none" : "block";
    $("progress-bar").style.width = Math.max(0, Math.min(100, pct)) + "%";
}

function setSeqInfo(html) { $("seq-info").innerHTML = html; }

// Compact local timestamp, used to keep each run's rendered files distinct.
function stamp() {
    const d = new Date();
    const p = (n) => ("0" + n).slice(-2);
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function formatDuration(ms) {
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function dirNameOf(p) {
    const s = String(p).replace(/\\/g, "/");
    const i = s.lastIndexOf("/");
    return i > 0 ? s.slice(0, i) : s;
}

// ─── Render folder ────────────────────────────────────────────────────────────
/**
 * Where the aligned WAVs go. These are *project media*: Premiere references
 * them for the life of the project, so a temp folder is the wrong home — Disk
 * Cleanup and Storage Sense both take it and the timeline goes offline weeks
 * later with no clue why. Default to a folder beside the project file.
 *
 * @returns {{ dir: string, source: 'settings'|'project'|'fallback' }}
 */
async function resolveRenderDir(projectPath) {
    const custom = (localStorage.getItem(RENDER_DIR_KEY) || "").trim();
    if (custom) {
        const dir = custom.replace(/\\/g, "/").replace(/\/+$/, "");
        await runner.ensureDir(dir);
        return { dir, source: "settings" };
    }
    if (projectPath) {
        const dir = `${dirNameOf(projectPath)}/${BIN_NAME}`;
        try {
            await runner.ensureDir(dir);
            return { dir, source: "project" };
        } catch (e) { /* read-only or missing volume — fall through */ }
    }
    // Unsaved project: the plugin's own data folder at least survives a reboot,
    // unlike %TEMP%, but it does not travel with the project — hence the warning.
    const lfs = require("uxp").storage.localFileSystem;
    const data = await lfs.getDataFolder();
    const dir = String(data.nativePath).replace(/\\/g, "/").replace(/\/+$/, "") + "/render";
    await runner.ensureDir(dir);
    return { dir, source: "fallback" };
}

// ─── Tool status ──────────────────────────────────────────────────────────────
function renderToolStatus(detail) {
    const el = $("tool-status");
    if (state.addonOk === null) {
        el.innerHTML = '<span class="tool-chip">decoder …</span>';
    } else if (state.addonOk) {
        el.innerHTML = '<span class="tool-chip tool-ok" title="Bundled FFmpeg decoder loaded">decoder ✓</span>';
    } else {
        el.innerHTML = `<span class="tool-chip tool-missing" title="${escapeHtml(detail || "The bundled audio decoder failed to load.")}">decoder ✗</span>`;
    }
}

async function checkAddon() {
    try {
        await audio.ensureAddon();
        state.addonOk = true;
        renderToolStatus();
        return true;
    } catch (e) {
        state.addonOk = false;
        renderToolStatus(String((e && e.message) || e));
        return false;
    }
}

// ─── Segmented controls ───────────────────────────────────────────────────────
// `getAttribute` and `querySelectorAll` rather than `dataset`/`children`: the
// former pair is what UXP's DOM subset reliably implements.
function bindSegment(id, key, onChange) {
    const opts = Array.prototype.slice.call($(id).querySelectorAll(".seg-opt"));
    opts.forEach((opt) => {
        const value = opt.getAttribute("data-value");
        opt.addEventListener("click", () => {
            if (state.params[key] === value) return;
            state.params[key] = value;
            opts.forEach((o) => { o.className = "seg-opt" + (o === opt ? " is-on" : ""); });
            if (onChange) onChange();
        });
    });
}

// ─── Params ───────────────────────────────────────────────────────────────────
// Only the two choices an editor can actually answer are sent. Everything else
// the engine derives: the search window widens on evidence, and polarity, drift
// agility and band weighting have no setting a user could pick better than the
// default — a wrong one only degrades the result silently.
function readParams() {
    const phase = state.params.phase;
    return {
        mode: state.params.mode,
        phase: phase === "off" ? "off" : "auto",
        // 0 collapses the measurement to a single curve for the whole clip
        phaseBlockSeconds: phase === "spectral" ? 20 : 0
    };
}

// ─── Track list ───────────────────────────────────────────────────────────────
function channelOptionsFor(track) {
    let path = null;
    for (const clip of track.clips) {
        if (clip.mediaPath) { path = clip.mediaPath; break; }
    }
    const probe = path && state.probe[path];
    const streams = (probe && probe.streams) || [];
    const opts = [];
    if (streams.length > 1) {
        streams.forEach((s, i) => {
            if (s.channels > 1) {
                for (let ch = 0; ch < s.channels; ch++) {
                    opts.push({ value: `${i}:${ch}`, label: `src ${i + 1}.${ch + 1}` });
                }
            } else {
                opts.push({ value: `${i}:null`, label: `src ${i + 1}` });
            }
        });
    } else if (streams.length === 1 && streams[0].channels > 1) {
        const n = streams[0].channels;
        // "stereo" first — it is the default for a file only one track uses, and
        // the only option that keeps every channel through to the render.
        opts.push({ value: "0:null", label: n === 2 ? "stereo" : `all ${n} ch` });
        for (let ch = 0; ch < n; ch++) opts.push({ value: `0:${ch}`, label: channelName(ch, n) });
    }
    return opts;
}

// A 2-channel file is either a stereo mic or two mics interleaved; either way
// channel 0 is the left one, so name it that. Beyond stereo the positional
// names stop being reliable, so fall back to numbers.
function channelName(index, total) {
    if (total === 2) return index === 0 ? "left" : "right";
    return `ch ${index + 1}`;
}

// Where the current selection actually sits: on the reference track (inert —
// the reference is never filtered by selection) or on some other track
// (a target, automatically — no separate TGT tick to set). Reads
// state.liveSelection when the poll has filled it in — kept fresh every
// couple of seconds while the panel is open — and falls back to the
// selection baked into the last Scan for the moment before the first poll
// tick lands.
function selectionTally() {
    const tracks = state.seqInfo ? state.seqInfo.audioTracks : [];
    const live = state.liveSelection;
    const t = { onTargets: 0, onRef: 0, targetTrackCount: 0 };
    for (const track of tracks) {
        const n = live ? (live[track.index] || 0) : track.clips.filter((c) => c.selected).length;
        if (!n) continue;
        if (track.index === state.refTrack) t.onRef += n;
        else { t.onTargets += n; t.targetTrackCount++; }
    }
    return t;
}

// What Align will actually do, live — no Scan required. Just clicking
// around the timeline re-tallies on the next poll tick. Must never just say
// "nothing selected" — a selection sitting on the reference track is a
// different problem with a different fix than no selection at all.
function updateAlignNote() {
    const note = $("align-note");
    if (!state.seqInfo) { show(note, false); return; }
    show(note, true);
    let warn = true;
    let msg;
    const t = selectionTally();
    if (state.refTrack === null) {
        msg = "Pick a reference track below, then select the clips you want aligned in the timeline.";
    } else if (t.onTargets) {
        msg = `${t.onTargets} selected clip(s) across ${t.targetTrackCount} track(s) will be aligned.`;
        warn = false;
    } else if (t.onRef) {
        msg = `${t.onRef} selected clip(s) are on the reference track, which is the yardstick — ` +
            "select clips on another track instead.";
    } else {
        const reported = state.liveSelection ? state.liveSelectionReported : (state.seqInfo.selection || {}).reportedByHost;
        msg = "No clips selected in the timeline — select the clips you want aligned.";
        if (reported > 0) {
            msg = `Premiere reports ${reported} selected item(s), but none of them are ` +
                "audio clips on this sequence's audio tracks — select the audio, not just the video.";
        }
    }
    note.textContent = msg;
    note.className = "param-note" + (warn ? " param-note-warn" : "");
}

// onClick receives the pill element itself — closing over it beats relying on
// event.currentTarget, which UXP's event object does not reliably carry.
function makePill(type, on, disabled, onClick) {
    const el = document.createElement("div");
    el.className = "pill" + (on ? " is-on" : "") + (disabled ? " is-off" : "");
    el.textContent = type;
    if (!disabled) el.addEventListener("click", () => onClick(el));
    return el;
}

// The Sources button only earns its place when some track actually offers a
// choice; with plain single-stream mono files there is nothing to reveal.
function updateSourcesToggle(anyOptions) {
    const btn = $("btn-sources");
    if (anyOptions !== undefined) show(btn, !!anyOptions);
    btn.className = "btn-mini" + (state.showSources ? " is-on" : "");
    $("tracks").className = state.showSources ? "show-sources" : "";
}

function renderTracks() {
    const host = $("tracks");
    host.innerHTML = "";
    const tracks = state.seqInfo ? state.seqInfo.audioTracks : [];
    show($("tracks-empty"), tracks.length === 0);
    if (!tracks.length) { updateSourcesToggle(false); return; }

    let anyOptions = false;
    for (const track of tracks) {
        const row = document.createElement("div");
        row.className = "track-row" +
            (state.refTrack === track.index ? " is-ref" : "") +
            (track.clipCount === 0 ? " track-empty" : "");

        // The REF pill doubles as the "dropdown": click any track's pill to
        // make it the reference — mutually exclusive across rows, so this one
        // control is the whole picker. There is no TGT pill any more — any
        // other track with a selected clip is a target automatically, and the
        // live badge below says so.
        row.appendChild(makePill("REF", state.refTrack === track.index, track.clipCount === 0, () => {
            state.refTrack = track.index;
            renderTracks();
            updateAlignButton();
        }));

        const name = document.createElement("span");
        name.className = "track-name";
        name.textContent = track.name;
        name.title = track.name;
        row.appendChild(name);

        const isRef = state.refTrack === track.index;
        const live = state.liveSelection;
        const selectedCount = live ? (live[track.index] || 0) : track.clips.filter((c) => c.selected).length;
        const badge = document.createElement("span");
        badge.className = "track-live" + (selectedCount > 0 ? (isRef ? " is-ref-live" : " is-target") : "");
        badge.title = isRef
            ? "The reference track is never filtered by selection — it supplies material wherever it overlaps a target."
            : (selectedCount > 0 ? "This track becomes a target automatically because it has a selected clip."
                : "No clips selected on this track — select some in the timeline to make it a target.");
        badge.textContent = selectedCount > 0 ? `${selectedCount} selected` : "—";
        row.appendChild(badge);

        const meta = document.createElement("span");
        meta.className = "track-meta";
        meta.textContent = track.clipCount + (track.clipCount === 1 ? " clip" : " clips");
        row.appendChild(meta);

        // Source picker, shown only when the media offers a choice. Premiere's
        // API can't say which channel a clip uses, so this is a heuristic default
        // the user can correct. UXP has no usable <select>, so the chip cycles.
        const opts = channelOptionsFor(track);
        if (opts.length > 1) {
            anyOptions = true;
            const chip = document.createElement("div");
            chip.className = "chansel";
            chip.title = "Click to cycle this track's source channel: " + opts.map((o) => o.label).join(" · ");
            const cur = state.sourceMap[track.index] || { audioStream: 0, channel: null };
            let idx = Math.max(0, opts.findIndex((o) => o.value === `${cur.audioStream}:${cur.channel}`));
            chip.textContent = opts[idx].label;
            chip.addEventListener("click", () => {
                idx = (idx + 1) % opts.length;
                const [s, c] = opts[idx].value.split(":");
                state.sourceOverrides[track.index] = {
                    audioStream: parseInt(s, 10),
                    channel: c === "null" ? null : parseInt(c, 10)
                };
                state.sourceMap[track.index] = state.sourceOverrides[track.index];
                chip.textContent = opts[idx].label;
                log(`Track "${track.name}" source set to ${opts[idx].label}`);
            });
            row.appendChild(chip);
        }
        host.appendChild(row);
    }
    updateSourcesToggle(anyOptions);
}

function updateAlignButton() {
    const t = selectionTally();
    enable($("btn-align"),
        !state.running && state.refTrack !== null && t.onTargets > 0 && !!state.seqInfo);
    updateAlignNote();
}

// ─── Refresh ──────────────────────────────────────────────────────────────────
// `quiet` suppresses the "No active sequence" error log — used only for the
// very first automatic refresh at boot, where that outcome is a known, benign
// startup race (see pollActiveSequence) that self-resolves within a couple of
// seconds. A manual Refresh click, or any later automatic re-refresh, always
// logs.
async function refresh({ quiet = false } = {}) {
    setBusy("Reading sequence…");
    // Resolved before every run rather than once at boot: the user can save an
    // untitled project, or Save As onto another volume, between two aligns.
    const proj = await premiere.getProjectInfo();
    state.projectPath = (proj && proj.ok && proj.path) || null;
    return readSequence({ quiet });
}

/**
 * Detects an active sequence appearing or changing, and re-scans automatically.
 *
 * Two problems this solves, both because Premiere pushes no event for either:
 *  - `getActiveSequence()` is unreliable in the first moment a panel loads — a
 *    fresh Unphased instance can open before Premiere has settled which
 *    sequence is "active", so the very first scan attempt sees none.
 *  - the user switches to a different sequence while the panel is already open.
 *
 * `getActiveSequenceName()` is a cheap, non-throwing read — no track/clip
 * enumeration — so it is safe to call every couple of seconds. A full
 * `refresh()` (which probes every media file) only runs when the name has
 * actually changed from what is already scanned.
 */
async function pollActiveSequence() {
    if (state.running || state.polling) return;
    state.polling = true;
    try {
        const liveName = await premiere.getActiveSequenceName();
        if (liveName === state.lastLiveSeqName) return; // nothing changed since the last tick
        state.lastLiveSeqName = liveName;

        const alreadyScanned = state.seqInfo && state.seqInfo.sequence.name === liveName;
        if (liveName && !alreadyScanned) {
            await refresh();
        } else if (!liveName && state.seqInfo) {
            state.seqInfo = null;
            setSeqInfo('<span class="seq-meta">No active sequence</span>');
            renderTracks();
            updateAlignButton();
        }
    } finally {
        state.polling = false;
    }
}

/**
 * Keeps state.liveSelection current, so the track list and the align note
 * always reflect what is selected in the timeline right now — no Scan
 * needed. Uses getSelectionOnly(), a per-clip read with no media probing, so
 * it is cheap enough for the same 2s tick as pollActiveSequence. Skipped
 * entirely when nothing has been scanned yet, since nothing on screen
 * depends on it before then.
 */
async function pollSelection() {
    if (state.running || state.pollingSelection || !state.seqInfo) return;
    state.pollingSelection = true;
    try {
        const res = await premiere.getSelectionOnly();
        if (!res.ok) return; // transient — keep the last-known tally rather than blanking it
        const map = {};
        for (const t of res.audioTracks) map[t.index] = t.selectedClipCount;
        state.liveSelection = map;
        state.liveSelectionReported = res.reportedByHost;
        renderTracks();
        updateAlignButton();
    } finally {
        state.pollingSelection = false;
    }
}

async function readSequence({ quiet = false } = {}) {
    const res = await premiere.getSequenceInfo();
    if (!res.ok) {
        state.seqInfo = null;
        setSeqInfo('<span class="seq-meta">No active sequence</span>');
        setBusy(null);
        if (!quiet) log(res.error || "Failed to read sequence", "error");
        renderTracks();
        updateAlignButton();
        return false;
    }
    state.seqInfo = res;
    if (state.refTrack !== null && !res.audioTracks[state.refTrack]) state.refTrack = null;
    // Seed the live selection tally from this scan's own per-clip reads, so
    // the align note is accurate immediately rather than waiting for the
    // next poll tick.
    const liveMap = {};
    for (const track of res.audioTracks) liveMap[track.index] = track.clips.filter((c) => c.selected).length;
    state.liveSelection = liveMap;
    state.liveSelectionReported = res.selection ? res.selection.reportedByHost : null;

    let clipTotal = 0;
    const paths = [];
    for (const track of res.audioTracks) {
        clipTotal += track.clips.length;
        for (const c of track.clips) {
            if (c.mediaPath && paths.indexOf(c.mediaPath) === -1) paths.push(c.mediaPath);
        }
    }
    setSeqInfo(
        `<span class="seq-name">${escapeHtml(res.sequence.name)}</span>` +
        `<span class="seq-meta">${res.audioTracks.length} audio tracks · ${clipTotal} clips · ${paths.length} source files</span>`
    );

    setBusy("Inspecting media…");
    try {
        state.probe = await audio.probeMany(paths);
    } catch (err) {
        state.probe = {};
        log("Media probe failed: " + ((err && err.message) || err), "warn");
    }

    state.sourceMap = pairing.defaultSourceMap(res, state.probe);
    for (const idx of Object.keys(state.sourceOverrides)) {
        if (res.audioTracks[idx]) state.sourceMap[idx] = state.sourceOverrides[idx];
    }
    // Only warn where the assignment is genuinely a guess: several streams, or
    // one multi-channel stream split across several tracks. A stereo file on a
    // single track is just a stereo file.
    const shared = pairing.tracksPerPath(res);
    let multi = 0;
    for (const p of Object.keys(state.probe)) {
        const st = state.probe[p].streams || [];
        if (st.length > 1 || (st.length === 1 && st[0].channels > 1 && shared[p] > 1)) multi++;
    }

    renderTracks();
    updateAlignButton();
    setBusy(null);
    log(`Refreshed "${res.sequence.name}" — ${res.audioTracks.length} tracks, ${clipTotal} clips`, "success");
    if (multi) {
        log(`${multi} source file(s) carry multiple mics — press Sources and check which ` +
            "channel each track is set to", "warn");
    }
    const sel = res.selection;
    if (sel) {
        log(`Selection: ${sel.matchedOnAudioTracks} audio clip(s) selected ` +
            `(host reported ${sel.reportedByHost} item(s) via ${sel.method})`,
            sel.reportedByHost && !sel.matchedOnAudioTracks ? "warn" : "info");
    }
    return true;
}

// ─── Results ──────────────────────────────────────────────────────────────────
function fmtMs(v) { return (v >= 0 ? "+" : "") + v.toFixed(1); }

function nullBadge(db) {
    if (db === undefined || db === null) return '<span class="badge badge-none">—</span>';
    const v = db.toFixed(0) + " dB";
    if (db > 40) {
        return `<span class="badge badge-suspect" title="Suspiciously deep — both sides may be decoding the same audio. Check the source chips.">${v} ?</span>`;
    }
    if (db >= 10) return `<span class="badge badge-high">${v}</span>`;
    if (db >= 3) return `<span class="badge badge-mid">${v}</span>`;
    return `<span class="badge badge-low" title="Little real correlation — treat this result with suspicion.">${v}</span>`;
}

function renderResults(rows) {
    const tbody = $("results").querySelector("tbody");
    tbody.innerHTML = "";
    show($("results-section"), rows.length > 0);
    for (const r of rows) {
        const tr = document.createElement("tr");
        let cells;
        if (r.status === "failed") {
            cells = [
                { html: escapeHtml(r.label), cls: "cell-name" },
                { html: "—", cls: "cell-dim" },
                { html: "—", cls: "cell-dim" },
                { html: "—", cls: "cell-dim" },
                { html: '<span class="badge badge-none">—</span>' },
                { html: escapeHtml(r.reason || "failed"), cls: "res-bad" }
            ];
        } else {
            const span = r.driftRangeMs ? (r.driftRangeMs[1] - r.driftRangeMs[0]) : 0;
            let statusHtml, statusCls;
            if (r.placed === false) {
                statusHtml = "place failed"; statusCls = "res-bad";
            } else if (r.status === "lowConfidence") {
                statusHtml = "low confidence"; statusCls = "res-warn";
            } else {
                statusHtml = r.placed ? "placed" : "aligned"; statusCls = "res-ok";
            }
            cells = [
                { html: escapeHtml(r.label), cls: "cell-name" },
                { html: fmtMs(r.staticDelayMs), cls: "cell-num" },
                { html: span > 0.05 ? span.toFixed(1) : "—", cls: span > 0.05 ? "cell-num" : "cell-dim" },
                {
                    html: r.polarityInverted ? '<span class="flag" title="Polarity was inverted and has been corrected">inv</span>' : "ok",
                    cls: r.polarityInverted ? "" : "cell-dim"
                },
                { html: nullBadge(r.nullDepthDb) },
                { html: statusHtml, cls: statusCls }
            ];
        }
        cells.forEach((cell, i) => {
            const td = document.createElement("td");
            td.innerHTML = cell.html;
            if (cell.cls) td.className = cell.cls;
            if (i === 0) td.title = r.label;
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    }
}

function renderWarnings(warnings) {
    const host = $("warnings");
    host.innerHTML = "";
    show($("warnings-section"), warnings.length > 0);
    for (const w of warnings) {
        const div = document.createElement("div");
        div.className = "warn-item";
        div.innerHTML = (w.clip ? `<span class="warn-clip">${escapeHtml(w.clip)}</span> — ` : "") + escapeHtml(w.reason);
        host.appendChild(div);
    }
}

// ─── Tips card (shown once per install after a successful Align) ──────────────
function tipsDismissed() {
    try { return localStorage.getItem(TIPS_DISMISSED_KEY) === "1"; }
    catch (_) { return false; }
}
function dismissTipsCard() {
    try { localStorage.setItem(TIPS_DISMISSED_KEY, "1"); } catch (_) {}
    show($("tips-card"), false);
}
function maybeShowTipsCard(statsText) {
    if (tipsDismissed()) return;
    const stats = $("tips-card-stats");
    if (stats) stats.textContent = statsText || "Aligned!";
    show($("tips-card"), true);
}

// ─── Align ────────────────────────────────────────────────────────────────────
function finish(msg, type) {
    state.running = false;
    state.cancelRequested = false;
    updateAlignButton();
    setBusy(null);
    setProgress(0, false);
    if (msg) log(msg, type);
}

// Installed into audio.js: every decode checks it, so a Cancel click unwinds
// the run between segments rather than after all of them.
function throwIfCancelled() {
    if (!state.cancelRequested) return;
    const err = new Error("cancelled");
    err.cancelled = true;
    throw err;
}

async function runAlign() {
    if (state.running) return;
    const startedAt = Date.now();
    if (!(await checkAddon())) {
        log("The bundled audio decoder is not available — this build cannot decode media. " +
            "Reinstall the plugin, or use the CEP version on Premiere 24/25.", "error");
        return;
    }
    if (!(await refresh())) return;

    // Targets are derived fresh off this scan's own selection reads, not the
    // (possibly one poll tick stale) live preview — deterministic at the
    // moment it actually matters.
    const targets = state.seqInfo.audioTracks
        .filter((t) => t.index !== state.refTrack && t.clips.some((c) => c.selected))
        .map((t) => t.index)
        .sort((a, b) => a - b);
    const pr = pairing.buildPairs(state.seqInfo, state.refTrack, targets, {
        minOverlapSec: 2,
        sourceMap: state.sourceMap,
        selectedOnly: true
    });
    renderWarnings(pr.warnings);
    for (const w of pr.warnings) log((w.clip ? w.clip + ": " : "") + w.reason, "warn");
    if (!pr.pairs.length) {
        log("Nothing to align — see warnings", "error");
        return;
    }

    state.running = true;
    state.cancelRequested = false;
    updateAlignButton();

    let render;
    try {
        render = await resolveRenderDir(state.projectPath);
    } catch (e) {
        finish(String((e && e.message) || e), "error");
        return;
    }
    state.renderDir = render.dir;
    log("Rendering to " + render.dir);
    if (render.source === "fallback") {
        log("This project has not been saved, so the aligned audio is going to the plugin's data " +
            "folder rather than travelling with the project — save the project (or set a rendered " +
            "audio folder in Settings) and align again to keep it beside the .prproj.", "warn");
    }

    // Rendered files are permanent project media in a folder that persists across
    // runs, so their names must be unique per run: reusing a name would overwrite
    // audio the timeline already points at, and would make the import find the
    // previous run's item in the bin.
    const runStamp = stamp();
    const outputName = (pair) => pair.outputFileName.replace(/\.wav$/i, "") + "-" + runStamp + ".wav";

    const distinctTargets = [];
    for (const p of pr.pairs) {
        if (distinctTargets.indexOf(p.tgtTrackIndex) === -1) distinctTargets.push(p.tgtTrackIndex);
    }
    distinctTargets.sort((a, b) => a - b);

    // Reuse empty tracks already at the bottom rather than appending a fresh set
    // on every run, which would pile up abandoned tracks.
    const allTracks = state.seqInfo.audioTracks;
    let trailingEmpty = 0;
    for (let k = allTracks.length - 1; k >= 0; k--) {
        if (allTracks[k].clipCount === 0) trailingEmpty++;
        else break;
    }
    const reuse = Math.min(trailingEmpty, distinctTargets.length);
    const baseTrackCount = allTracks.length - reuse;

    log(`Aligning ${pr.pairs.length} segment(s) from ${distinctTargets.length} track(s)`);

    const tr = await premiere.ensureTracks({ total: baseTrackCount + distinctTargets.length });
    if (!tr.ok) { finish(tr.error, "error"); return; }
    if (tr.willCreate) log(`${tr.willCreate} audio track(s) will be created for the aligned audio`);

    const { normalizeJob } = require("./js/engine/job.js");
    let job;
    try {
        job = normalizeJob({
            params: readParams(),
            pairs: pr.pairs.map((p) => ({
                id: p.id, ref: p.ref, target: p.target,
                outputPath: `${render.dir}/${outputName(p)}`
            }))
        });
    } catch (e) {
        finish(String((e && e.message) || e), "error");
        return;
    }

    const labelById = {};
    const pairById = {};
    for (const p of pr.pairs) { labelById[p.id] = p.label; pairById[p.id] = p; }

    let doneCount = 0;
    const total = pr.pairs.length;
    setProgress(0, true);
    setBusy("Aligning…", true);

    let out;
    try {
        out = await runner.runJob(job, (evt) => {
            if (evt.event === "phase") {
                setBusy(`${labelById[evt.id] || evt.id} — ${evt.phase}…`, true);
            } else if (evt.event === "result") {
                doneCount++;
                setProgress((doneCount / total) * 100, true);
                if (evt.status === "failed") {
                    log(`${labelById[evt.id] || evt.id}: ${evt.reason || "failed"}`, "error");
                } else {
                    // Report a widened search: with the control gone, this is the only
                    // visible sign that the sources started far apart.
                    const widened = evt.searchWindowMs > 250
                        ? ", search widened to ±" + (evt.searchWindowMs >= 1000
                            ? (evt.searchWindowMs / 1000) + " s" : evt.searchWindowMs + " ms")
                        : "";
                    log(`${labelById[evt.id] || evt.id}: ${fmtMs(evt.staticDelayMs)} ms, null ` +
                        `${evt.nullDepthDb.toFixed(0)} dB` +
                        (evt.polarityInverted ? ", polarity inverted" : "") + widened);
                }
            }
        });
    } catch (err) {
        finish(String((err && err.message) || err), "error");
        return;
    }

    const rows = out.results.map((r) => { r.label = labelById[r.id] || r.id; return r; });
    if (out.cancelled) {
        renderResults(rows);
        finish(`Cancelled — ${rows.length} segment(s) finished before stopping; nothing was placed`, "warn");
        return;
    }

    const okResults = rows.filter((r) => r.status !== "failed");
    if (!okResults.length) {
        renderResults(rows);
        finish("No segments aligned — see results", "error");
        return;
    }

    setBusy(`Placing ${okResults.length} clip(s)…`);
    const items = okResults.map((r) => {
        const p = pairById[r.id];
        return {
            id: r.id,
            path: r.outputPath,
            fileName: outputName(p),
            trackIndex: baseTrackCount + distinctTargets.indexOf(p.tgtTrackIndex),
            startSeconds: p.placeStartSeconds,
            // only silence the original when aligned audio replaces all of it
            muteNodeId: p.muteOriginal ? p.tgtNodeId : null
        };
    });

    const res = await premiere.importAndPlace({ items });
    if (!res.ok) {
        renderResults(rows);
        finish("Import/placement failed: " + res.error, "error");
        return;
    }
    const placeById = {};
    for (const r of (res.results || [])) placeById[r.id] = r;
    for (const r of rows) {
        const pl = placeById[r.id];
        if (pl) { r.placed = pl.ok; r.placeError = pl.error; }
    }
    renderResults(rows);

    const failedCount = rows.length - okResults.length;
    const placeFailed = okResults.filter((r) => r.placed !== true).length;
    const placed = okResults.length - placeFailed;
    let msg = `${placed} clip(s) aligned and placed`;
    if (failedCount) msg += `, ${failedCount} failed`;
    if (placeFailed) msg += `, ${placeFailed} could not be placed`;
    finish(msg, failedCount + placeFailed > 0 ? "warn" : "success");
    if (placed) log("Originals muted where fully replaced — unmute to A/B", "info");
    if (placed) {
        const placedRows = okResults.filter((r) => r.placed === true);
        const footageMs = placedRows.reduce((sum, r) => {
            const p = pairById[r.id];
            return sum + ((p && p.target.durationSec) || 0) * 1000;
        }, 0);
        const elapsedMs = Date.now() - startedAt;
        maybeShowTipsCard(footageMs > 0
            ? `Aligned ${formatDuration(footageMs)} of footage across ${placed} clip${placed !== 1 ? "s" : ""} in ${formatDuration(elapsedMs)}!`
            : "Aligned!");
    }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
// Any throw inside a handler must reach the log — a silent console-only failure
// looks identical to "the button does nothing".
function guard(fn) {
    return async function (...args) {
        try {
            await fn(...args);
        } catch (e) {
            state.running = false;
            updateAlignButton();
            setBusy(null);
            log((e && e.message) ? e.message : String(e), "error");
        }
    };
}

function boot() {
    audio.setCancelCheck(throwIfCancelled);

    const renderInput = $("set-render");
    renderInput.value = localStorage.getItem(RENDER_DIR_KEY) || "";
    renderInput.addEventListener("change", () => {
        const v = String(renderInput.value || "").trim();
        if (v) localStorage.setItem(RENDER_DIR_KEY, v);
        else localStorage.removeItem(RENDER_DIR_KEY);
    });

    bindSegment("param-mode", "mode");
    bindSegment("param-phase", "phase");

    $("btn-refresh").addEventListener("click", guard(refresh));
    $("btn-align").addEventListener("click", guard(runAlign));
    $("btn-sources").addEventListener("click", guard(() => {
        state.showSources = !state.showSources;
        updateSourcesToggle();
    }));
    $("btn-cancel").addEventListener("click", guard(() => {
        if (!state.running || state.cancelRequested) return;
        state.cancelRequested = true;
        enable($("btn-cancel"), false);
        setBusy("Stopping…");
        log("Cancelling — waiting for the current segment to stop", "warn");
    }));
    $("btn-clear-log").addEventListener("click", () => { $("log").innerHTML = ""; });
    $("btn-clear-results").addEventListener("click", () => { renderResults([]); renderWarnings([]); });
    $("btn-instructions").addEventListener("click", () => $("instructions-panel").classList.add("visible"));
    $("btn-instructions-close").addEventListener("click", () => $("instructions-panel").classList.remove("visible"));

    $("tips-card-close").addEventListener("click", dismissTipsCard);
    const tipsCardLink = $("tips-card-link");
    if (tipsCardLink) {
        tipsCardLink.addEventListener("click", (e) => {
            e.preventDefault();
            require("uxp").shell.openExternal(tipsCardLink.href);
        });
    }
    const footerTips = $("footer-tips");
    if (footerTips) {
        footerTips.addEventListener("click", (e) => {
            e.preventDefault();
            require("uxp").shell.openExternal(footerTips.href);
        });
    }

    const settingsToggle = $("settings-toggle");
    settingsToggle.addEventListener("click", () => {
        const body = $("settings-body");
        const open = body.style.display === "none";
        show(body, open);
        settingsToggle.textContent = (open ? "▾" : "▸") + " Settings";
    });

    $("btn-ping").addEventListener("click", guard(async () => {
        const res = await premiere.ping();
        await checkAddon();
        let render;
        try { render = await resolveRenderDir(state.projectPath); }
        catch (e) { render = { dir: String((e && e.message) || e), source: "error" }; }
        const out = $("dev-out");
        show(out, true);
        out.textContent = JSON.stringify(res, null, 2) +
            `\ndecoder: ${state.addonOk ? "loaded" : "NOT AVAILABLE"}` +
            `\nrender:  ${render.dir} (${render.source})`;
    }));

    window.addEventListener("error", (ev) => log("Panel error: " + ev.message, "error"));
    window.addEventListener("unhandledrejection", (ev) => {
        const r = ev.reason;
        log("Panel error: " + (r && r.message ? r.message : String(r)), "error");
    });

    renderToolStatus();
    checkAddon().then((ok) => {
        if (!ok) {
            const el = $("boot-error");
            show(el, true);
            el.textContent = "The bundled audio decoder failed to load — alignment is unavailable. " +
                "See the log for the loader's own message.";
        }
        log("Panel ready");
        return guard(refresh)({ quiet: true });
    }).then(() => {
        // Start the active-sequence poll once the initial scan has settled,
        // successfully or not — it is what catches the case this boot-time
        // attempt just missed (see pollActiveSequence's comment), and keeps
        // catching it for as long as the panel stays open. pollSelection()
        // rides the same tick, keeping the scope preview live (see its own
        // comment) — it is a no-op whenever the scope pill is off.
        setInterval(() => {
            guard(pollActiveSequence)();
            guard(pollSelection)();
        }, 2000);
    });
}

boot();
