/**
 * Unphased — premiere.js
 * Host operations via the Premiere UXP DOM API (require("premierepro")).
 * Every host read and edit the panel performs goes through here, and each entry
 * point returns a plain serialisable shape so main.js never touches a live
 * Premiere object.
 *
 * Editing is transactional: build Actions, add them with
 * compoundAction.addAction(action), run them inside
 * project.lockedAccess(() => project.executeTransaction(cb, undoLabel)).
 * Everything must be built synchronously inside the callback — an await in
 * there lets the host mutate underneath us and the objects go "no longer valid".
 *
 * Three constraints the UXP DOM imposes, all of them shaping the code below:
 *
 *  - **No nodeId.** There is no stable per-track-item identifier, so clips
 *    cannot be addressed by identity. They are addressed by (trackIndex, clipIndex)
 *    with the start tick as a sanity check, and items are always re-fetched
 *    fresh from their track rather than held across an await.
 *
 *  - **No QE addTracks — and none needed.** createOverwriteItemAction creates
 *    the track when the index passed exceeds the track count, so no undocumented
 *    QE dance is required. ensureTracks() survives only to report the count and,
 *    if a build ever stops auto-creating, to say so plainly.
 *
 *  - **Selection is read per clip.** Sequence.getSelection() returns a
 *    TrackItemSelection with no positional mapping back to tracks, so
 *    trackItem.getIsSelected() is the reliable route here.
 */
"use strict";

const ppro = require("premierepro");

const BIN_NAME = "Unphased";

async function val(x) { return (x && typeof x.then === "function") ? await x : x; }
function tSec(t) { return t ? t.seconds : null; }
function tTicks(t) { return t ? String(t.ticks) : null; }

// Verified on PPro 26.3 (Syncitol): TrackItemType = { EMPTY:0, CLIP:1, ... }.
const TRACK_ITEM_CLIP =
    (ppro.Constants && ppro.Constants.TrackItemType && ppro.Constants.TrackItemType.CLIP) || 1;

async function lockedTransaction(project, label, builder) {
    if (typeof project.lockedAccess === "function") {
        let result;
        project.lockedAccess(() => { result = project.executeTransaction(builder, label); });
        return val(result);
    }
    return val(project.executeTransaction(builder, label));
}

function describe(obj) {
    try {
        const own = Object.getOwnPropertyNames(obj || {});
        const proto = obj ? Object.getOwnPropertyNames(Object.getPrototypeOf(obj) || {}) : [];
        return [...own, ...proto].filter((k) => k !== "constructor").slice(0, 25).join(", ");
    } catch (e) { return "?"; }
}

// Every entry point resolves to { ok: true, ... } or { ok: false, error } and
// never rejects — the panel shows the error rather than losing it to an
// unhandled rejection.
function wrap(fn) {
    return async function (...args) {
        try {
            return await fn(...args);
        } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
        }
    };
}

async function getActiveProject() {
    if (!ppro || !ppro.Project || typeof ppro.Project.getActiveProject !== "function") {
        throw new Error('require("premierepro").Project.getActiveProject is unavailable — module shape mismatch.');
    }
    const project = await val(ppro.Project.getActiveProject());
    if (!project) throw new Error("No active project — open a project in Premiere first.");
    return project;
}

async function getActiveSequence(project) {
    if (!project) project = await getActiveProject();
    if (typeof project.getActiveSequence !== "function") {
        throw new Error("project.getActiveSequence is not a function — API shape mismatch (keys: " + describe(project) + ").");
    }
    const seq = await val(project.getActiveSequence());
    if (seq) return seq;
    // A freshly opened timeline sometimes isn't "active" yet; a project with
    // exactly one sequence has no ambiguity to resolve.
    let list = [];
    try { list = (await val(project.getSequences())) || []; } catch (e) { /* older build */ }
    if (list.length === 1) return list[0];
    throw new Error(
        "No active sequence. Open a sequence in the Timeline and click into it, then press Refresh." +
        (list.length ? ` (project has ${list.length} sequences; none reported active)` : ""));
}

// Light read for the idle poll: active sequence's name (or null), no scan.
// Never throws — a transient failure here should not spam the log every tick.
//
// Why polling exists at all: project.getActiveSequence() is unreliable right
// when a panel first loads (Premiere hasn't always settled which sequence is
// "active" yet), and nothing pushes an event when the user switches sequences
// later. Both are covered by re-checking the name periodically and letting the
// caller re-scan when it changes — the same pattern Syncitol uses.
async function getActiveSequenceName() {
    try {
        const project = await val(ppro.Project.getActiveProject());
        if (!project) return null;
        const seq = await val(project.getActiveSequence());
        if (!seq) return null;
        return String(await val(seq.name));
    } catch (e) {
        return null;
    }
}

// ─── ping / project info ──────────────────────────────────────────────────────

const ping = wrap(async function () {
    const project = await val(ppro.Project.getActiveProject());
    let seq = null;
    try { seq = project ? await val(project.getActiveSequence()) : null; } catch (e) { /* none open */ }
    return {
        ok: true,
        version: "1.2.2",
        appVersion: (ppro.version || (ppro.Constants && ppro.Constants.version) || "UXP"),
        project: project ? String(await val(project.name)) : null,
        hasActiveSequence: !!seq
    };
});

/**
 * Where the project lives on disk, so rendered audio can be written beside it
 * rather than into a temp folder Windows is free to delete. `path` is null on a
 * project that has never been saved.
 */
const getProjectInfo = wrap(async function () {
    const project = await getActiveProject();
    let p = null;
    try { p = String((await val(project.path)) || "") || null; } catch (e) { /* unsaved */ }
    return { ok: true, name: String(await val(project.name)), path: p };
});

// ─── Sequence enumeration ─────────────────────────────────────────────────────

/**
 * Two passes on purpose. Pass 1 reads timing off each track item and converts
 * every TickTime to a plain number immediately; pass 2 resolves media paths via
 * the durable ClipProjectItem refs. getMediaFilePath() yields to the host and
 * invalidates transient trackItem/TickTime objects, so it must not be
 * interleaved with the timing reads (learned the hard way in Syncitol).
 */
const getSequenceInfo = wrap(async function () {
    const project = await getActiveProject();
    const sequence = await getActiveSequence(project);

    const seqName = String(await val(sequence.name));
    let timebase = null;
    try { timebase = String(await val(sequence.getTimebase())); } catch (e) { /* optional */ }
    let sampleRate = null;
    try {
        const settings = await val(sequence.getSettings());
        const sr = settings && settings.audioSampleRate;
        sampleRate = (sr && sr.seconds !== undefined) ? sr.seconds : (sr || null);
    } catch (e) { /* informational only */ }

    const trackCount = await val(sequence.getAudioTrackCount());
    const pending = [];
    const trackMeta = [];

    for (let t = 0; t < trackCount; t++) {
        const track = await val(sequence.getAudioTrack(t));
        let name = `A${t + 1}`;
        try { if (track.name) name = String(await val(track.name)); } catch (e) { /* default */ }
        let muted = false;
        try { muted = !!(await val(track.isMuted())); } catch (e) { /* default */ }

        const items = track.getTrackItems(TRACK_ITEM_CLIP, false) || []; // sync
        const clips = [];
        for (let c = 0; c < items.length; c++) {
            const item = items[c];
            const info = {
                trackIndex: t,
                clipIndex: c,
                name: "",
                nodeId: null,
                mediaPath: null,
                startSeconds: null,
                startTicks: null,
                endSeconds: null,
                inPointSeconds: null,
                outPointSeconds: null,
                disabled: false,
                speedFactor: 1,
                channelCount: null,
                selected: false
            };
            try {
                const startT = await val(item.getStartTime());
                info.startSeconds = tSec(startT);
                info.startTicks = tTicks(startT);
                info.endSeconds = tSec(await val(item.getEndTime()));
                info.inPointSeconds = tSec(await val(item.getInPoint()));
                info.outPointSeconds = tSec(await val(item.getOutPoint()));
            } catch (e) { /* leave nulls; pairing skips the clip with a warning */ }
            try { info.name = String(await val(item.getName())); } catch (e) { /* unnamed */ }
            try { info.disabled = !!(await val(item.isDisabled())); } catch (e) { /* default */ }
            try { info.selected = !!(await val(item.getIsSelected())); } catch (e) { /* default */ }
            try {
                const s = await val(item.getSpeed());
                if (typeof s === "number" && isFinite(s)) info.speedFactor = s;
            } catch (e) { /* assume 100% */ }
            // Synthetic identity — UXP has no nodeId. Same shape pairing.js
            // already falls back to, and importAndPlace parses it back.
            info.nodeId = `t${t}c${c}@${info.startTicks}`;

            let clipPI = null;
            try {
                const projectItem = await val(item.getProjectItem());
                clipPI = (projectItem && ppro.ClipProjectItem && ppro.ClipProjectItem.cast)
                    ? ppro.ClipProjectItem.cast(projectItem) : projectItem;
            } catch (e) { /* offline or synthetic */ }
            pending.push({ info, clipPI });
            clips.push(info);
        }
        trackMeta.push({ index: t, name, muted, clipCount: clips.length, clips });
    }

    // Pass 2 — media paths, now that no transient handles are in flight.
    for (const p of pending) {
        try {
            if (p.clipPI && typeof p.clipPI.getMediaFilePath === "function") {
                p.info.mediaPath = (await val(p.clipPI.getMediaFilePath())) || null;
            }
        } catch (e) { /* offline media: pairing warns and skips */ }
    }

    const selected = pending.filter((p) => p.info.selected).length;
    let reported = selected;
    try {
        const sel = await val(sequence.getSelection());
        const items = sel && typeof sel.getTrackItems === "function" ? await val(sel.getTrackItems()) : null;
        if (items && items.length !== undefined) reported = items.length;
    } catch (e) { /* per-clip count stands */ }

    return {
        ok: true,
        sequence: { name: seqName, timebase },
        sampleRate,
        audioTracks: trackMeta,
        selection: {
            method: "per-clip",
            reportedByHost: reported,
            matchedOnAudioTracks: selected
        }
    };
});

/**
 * Selection only, for the panel's live "selected clips" preview — no timing,
 * no media paths, no clipPI lookups. Same per-clip getIsSelected() cost as
 * getSequenceInfo()'s pass 1, but skipping everything else keeps it light
 * enough to poll every second or two while the panel is open, so the scope
 * preview can track the timeline selection without a full Scan.
 */
const getSelectionOnly = wrap(async function () {
    const project = await getActiveProject();
    const sequence = await getActiveSequence(project);
    const trackCount = await val(sequence.getAudioTrackCount());
    const audioTracks = [];
    let matched = 0;

    for (let t = 0; t < trackCount; t++) {
        const track = await val(sequence.getAudioTrack(t));
        const items = track.getTrackItems(TRACK_ITEM_CLIP, false) || []; // sync
        let n = 0;
        for (let c = 0; c < items.length; c++) {
            try { if (await val(items[c].getIsSelected())) n++; } catch (e) { /* default not selected */ }
        }
        matched += n;
        audioTracks.push({ index: t, selectedClipCount: n });
    }

    let reported = matched;
    try {
        const sel = await val(sequence.getSelection());
        const its = sel && typeof sel.getTrackItems === "function" ? await val(sel.getTrackItems()) : null;
        if (its && its.length !== undefined) reported = its.length;
    } catch (e) { /* per-clip count stands */ }

    return { ok: true, audioTracks, reportedByHost: reported, matchedOnAudioTracks: matched };
});

// ─── Bin handling ─────────────────────────────────────────────────────────────

function isFolder(item) {
    try {
        if (ppro.FolderItem && ppro.FolderItem.cast) return !!ppro.FolderItem.cast(item);
    } catch (e) { /* not a folder */ }
    return false;
}

async function findBin(root, name) {
    const items = (await val(root.getItems())) || [];
    for (const item of items) {
        let n = "";
        try { n = String(await val(item.name)); } catch (e) { continue; }
        if (n === name && isFolder(item)) return ppro.FolderItem.cast(item);
    }
    return null;
}

async function ensureBin(project, name) {
    const root = await val(project.getRootItem());
    const existing = await findBin(root, name);
    if (existing) return existing;
    await lockedTransaction(project, `Unphased: create ${name} bin`, (compound) => {
        compound.addAction(root.createBinAction(name, false)); // makeUnique = false
    });
    const created = await findBin(root, name);
    if (!created) throw new Error(`Could not create the "${name}" bin in the project.`);
    return created;
}

async function findInBin(bin, fileName) {
    const base = fileName.replace(/\.[^.]+$/, "");
    const items = (await val(bin.getItems())) || [];
    for (const item of items) {
        let n = "";
        try { n = String(await val(item.name)); } catch (e) { continue; }
        if (n === fileName || n === base) return item;
    }
    return null;
}

// ─── Import + place ───────────────────────────────────────────────────────────

/**
 * payload: { items: [{ id, path, fileName, trackIndex, startSeconds, muteNodeId }] }
 *
 * `trackIndex` may exceed the sequence's current audio track count —
 * createOverwriteItemAction creates the track. That is the whole reason no QE
 * addTracks hack is needed here.
 *
 * Two transactions, not one: placement and muting are independent, and a
 * placement that fails must not roll back the mutes of clips that did land
 * (nor vice versa). The originals are re-scanned AFTER placement so their
 * indices are read from the timeline as it actually is.
 */
const importAndPlace = wrap(async function (payload) {
    const items = (payload && payload.items) || [];
    if (!items.length) return { ok: true, results: [] };

    const project = await getActiveProject();
    const sequence = await getActiveSequence(project);
    const bin = await ensureBin(project, BIN_NAME);

    const imported = await val(project.importFiles(items.map((i) => i.path), true, bin, false));
    if (imported === false) {
        return { ok: false, error: "Premiere refused to import the rendered audio — check the render folder path." };
    }

    // Resolve every project item BEFORE opening the transaction: getItems()
    // yields, and yielding inside executeTransaction invalidates the compound.
    const resolved = [];
    for (const item of items) {
        const res = { id: item.id, ok: false, error: null };
        const pi = await findInBin(bin, item.fileName);
        if (!pi) res.error = `imported item not found in the ${BIN_NAME} bin: ${item.fileName}`;
        resolved.push({ item, pi, res });
    }

    const editor = ppro.SequenceEditor.getEditor(sequence);
    await lockedTransaction(project, "Unphased: place aligned audio", (compound) => {
        for (const r of resolved) {
            if (!r.pi) continue;
            try {
                const at = ppro.TickTime.createWithSeconds(r.item.startSeconds);
                // videoTrackIndex 0 is ignored for audio-only media; the audio
                // index is the one that matters and may be beyond the last track.
                const action = editor.createOverwriteItemAction(r.pi, at, 0, r.item.trackIndex);
                if (compound.addAction(action)) r.res.ok = true;
                else r.res.error = "Premiere rejected the placement action";
            } catch (e) {
                r.res.error = String((e && e.message) || e);
            }
        }
    });

    // ── Mute the originals the aligned audio replaces ─────────────────────────
    const wantMuted = new Map(); // "t<track>c<clip>" -> result row
    for (const r of resolved) {
        if (!r.res.ok || !r.item.muteNodeId) continue;
        const m = /^t(\d+)c(\d+)@/.exec(r.item.muteNodeId);
        if (!m) { r.res.muteError = `unrecognised clip id ${r.item.muteNodeId}`; continue; }
        wantMuted.set(`t${m[1]}c${m[2]}`, r.res);
    }

    if (wantMuted.size) {
        const trackCount = await val(sequence.getAudioTrackCount());
        const tracks = [];
        for (let t = 0; t < trackCount; t++) tracks.push(await val(sequence.getAudioTrack(t)));
        await lockedTransaction(project, "Unphased: mute original audio", (compound) => {
            for (let t = 0; t < tracks.length; t++) {
                const clips = tracks[t].getTrackItems(TRACK_ITEM_CLIP, false) || []; // sync
                for (let c = 0; c < clips.length; c++) {
                    const row = wantMuted.get(`t${t}c${c}`);
                    if (!row) continue;
                    try { compound.addAction(clips[c].createSetDisabledAction(true)); wantMuted.delete(`t${t}c${c}`); }
                    catch (e) { row.muteError = String((e && e.message) || e); }
                }
            }
        });
        for (const row of wantMuted.values()) {
            if (!row.muteError) row.muteError = "original clip not found for mute";
        }
    }

    return { ok: true, results: resolved.map((r) => r.res) };
});

/**
 * Report the audio track count. This never has to add tracks —
 * createOverwriteItemAction does it — but the panel still asks, so it can say
 * how many tracks a run will add and so a future host that stops auto-creating
 * fails loudly instead of silently dropping clips.
 */
const ensureTracks = wrap(async function (arg) {
    const project = await getActiveProject();
    const sequence = await getActiveSequence(project);
    const have = await val(sequence.getAudioTrackCount());
    const total = (arg && arg.total) || 0;
    return {
        ok: true,
        added: 0,
        numTracks: have,
        willCreate: Math.max(0, total - have),
        autoCreates: true
    };
});

module.exports = {
    BIN_NAME,
    ping,
    getProjectInfo,
    getSequenceInfo,
    getSelectionOnly,
    getActiveSequenceName,
    importAndPlace,
    ensureTracks,
    // exported for diagnostics from the panel's Settings card
    getActiveProject,
    getActiveSequence,
    describe
};
