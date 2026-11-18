/**
 * Unphased — audio.js
 * Wraps the bundled FFmpeg native addon and hands the DSP exactly the buffers
 * the same buffers `ffmpeg -ss … -t … -c:a pcm_f32le` produces, which is what
 * the headless engine (`engine/cli.js`) still feeds the DSP.
 * There is no external ffmpeg/ffprobe install and — since UXP has no
 * child_process — no way to have one.
 *
 * Addon contract (see native/src/unphased_decode.h):
 *
 *   probe(path) -> { ok, error, durationSec,
 *                    streams: [{ index, channels, sampleRate, bits,
 *                                sampleFmt, codec }] }
 *
 *   decode(path, streamIndex, channel, startSec, durationSec, sampleRate)
 *        -> { sampleRate, samples: ArrayBuffer }   // float32 mono, LE
 *   decodeAsync(...same arguments)
 *        -> Promise<same result>   // on the addon's background decode pool
 *   decodeThreads() -> pool size;  cpuCount() -> logical CPU threads
 *
 *   channel: -1 downmixes the stream to mono, 0..n-1 picks one channel
 *            (the `pan=mono|c0=cN` the engine's decode.js used).
 *   sampleRate: 0 keeps the stream's own rate.
 *   Seeking is accurate (output-seek semantics), not keyframe-snapped —
 *   engine/src/decode.js puts -ss after -i for exactly this reason, and
 *   alignment ground truth depends on it.
 *
 * Two behaviours the ffmpeg command line gave us for free are reproduced here
 * in JS, because they are pure buffer arithmetic:
 *   - a negative start (a clip at the timeline head whose handles reach before
 *     the media) decodes from 0 and is zero-padded at the front (`adelay`);
 *   - every result is padded to the exact requested duration (`apad`), so a
 *     short tail at the end of a file can't shorten a render.
 *
 * Decoding runs on the addon's background pool (decodeAsync) when it has one,
 * so the panel stays responsive and the runners can decode upcoming audio while
 * the DSP works on the current pair — see prefetch(). An older addon, or
 * localStorage "unphased-decode" = "sync", falls back to the synchronous
 * decode on the scripting thread, one at a time, exactly as before: a cancel
 * check runs before each decode and a setTimeout(0) yield lets the panel
 * repaint and the Cancel click land.
 */
"use strict";

const ANALYSIS_RATE = 48000;

// ─── Platform ─────────────────────────────────────────────────────────────────
// UXP's os module reports "darwin" on macOS; the user agent is the fallback.
function isMac() {
    try {
        const p = require("os").platform();
        if (p) return String(p).toLowerCase() === "darwin";
    } catch (e) { /* no os module in this host */ }
    try {
        return /mac/i.test((navigator && (navigator.platform || navigator.userAgent)) || "");
    } catch (e) { return false; }
}

// The addon is not signed with a paid Apple Developer ID, so macOS blocks it
// the first time until the user allows it once. That is by far the likeliest
// reason it fails to load on a Mac, so the message says how to fix it.
const MAC_UNBLOCK_HINT =
    "On a Mac this is usually macOS blocking it the first time: open System Settings → " +
    "Privacy & Security, click Allow Anyway next to the message about unphased.uxpaddon, " +
    "then restart Premiere Pro.";

// ─── Native addon (lazy) ──────────────────────────────────────────────────────
let _addon = null;
let _addonError = null;
let _addonPromise = null;

function addon() {
    if (_addon) return Promise.resolve(_addon);
    if (_addonError) return Promise.reject(_addonError);
    if (!_addonPromise) {
        _addonPromise = (async () => {
            try {
                const mod = require("unphased.uxpaddon");
                _addon = (mod && typeof mod.then === "function") ? await mod : mod;
                if (!_addon || typeof _addon.decode !== "function" || typeof _addon.probe !== "function") {
                    const keys = _addon ? Object.keys(_addon).join(",") : "(falsy)";
                    throw new Error("addon loaded but decode/probe missing — exports: [" + keys + "]");
                }
                return _addon;
            } catch (e) {
                // UXP's native loader often throws something whose .message is
                // empty, so capture every field we can before giving up.
                let detail = "";
                try {
                    detail = [
                        e && e.message ? "msg=" + e.message : "",
                        e && e.name ? "name=" + e.name : "",
                        e && e.code ? "code=" + e.code : "",
                        "str=" + String(e)
                    ].filter(Boolean).join(" | ");
                } catch (_) { detail = "(uncapturable)"; }
                try { console.error("[unphased] addon load failed:", e); } catch (_) {}
                _addonError = new Error(isMac()
                    ? "Unphased's audio decoder (unphased.uxpaddon) didn't load. " + MAC_UNBLOCK_HINT +
                      " (" + detail + ")"
                    : "Unphased audio addon failed to load (unphased.uxpaddon). " + detail);
                throw _addonError;
            }
        })();
    }
    return _addonPromise;
}

async function ensureAddon() { await addon(); } // throws a clear error if unavailable

// Test seam: lets the offline suite drive decode/probe from WAV fixtures
// without a native addon. Never called by the panel.
function __setAddon(mod) {
    _addon = mod;
    _addonError = null;
    _addonPromise = mod ? Promise.resolve(mod) : null;
    probeCache.clear();
    clearPrefetch();
}

// ─── Cancellation + UI yields ─────────────────────────────────────────────────
let cancelCheck = null;
function setCancelCheck(fn) { cancelCheck = fn; }
function throwIfCancelled() { if (cancelCheck) cancelCheck(); }
function yieldToUI() { return new Promise((resolve) => setTimeout(resolve, 0)); }

// ─── Probe (cached per file) ──────────────────────────────────────────────────
// Shape matches engine/src/decode.js probeAudio() so pairing.defaultSourceMap
// and the panel's source dropdowns consume it unchanged.
const probeCache = new Map();

function probeStreams(filePath) {
    if (probeCache.has(filePath)) return probeCache.get(filePath);
    const task = (async () => {
        const a = await addon();
        const r = a.probe(filePath);
        if (!r || !r.ok) {
            return { streams: [], error: (r && r.error) || "probe failed" };
        }
        const streams = (r.streams || []).map((s, i) => ({
            index: i,
            channels: s.channels || 1,
            sampleRate: s.sampleRate || null,
            bits: s.bits || null,
            sampleFmt: s.sampleFmt || null,
            codec: s.codec || null
        }));
        return { streams, durationSec: r.durationSec || 0 };
    })().catch((e) => ({ streams: [], error: String((e && e.message) || e) }));
    probeCache.set(filePath, task);
    return task;
}

async function probeMany(paths) {
    const out = {};
    for (const p of paths) out[p] = await probeStreams(p);
    return out;
}

function clearProbeCache() { probeCache.clear(); }

// ─── Background decoding ──────────────────────────────────────────────────────
const DECODE_SWITCH_KEY = "unphased-decode";        // "sync" = never use the pool
const DECODE_BUDGET_KEY = "unphased-decode-budget-mb";

function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; } // no storage: defaults
}

function useAsyncDecode(a) {
    if (!a || typeof a.decodeAsync !== "function") return false;
    return storageGet(DECODE_SWITCH_KEY) !== "sync";
}

// How many decodes the addon runs at once (its pool is sized from the CPU
// thread count), and that CPU count, for the log. Before the addon loads, or
// when decoding is synchronous: one.
function backgroundDecoding() { return useAsyncDecode(_addon); }
function decodeConcurrency() {
    if (!useAsyncDecode(_addon)) return 1;
    try { return Math.max(1, Number(_addon.decodeThreads()) || 1); } catch (e) { return 1; }
}
function cpuCount() {
    try {
        return _addon && typeof _addon.cpuCount === "function" ? Number(_addon.cpuCount()) || null : null;
    } catch (e) { return null; }
}

// Wall-clock time with at least one decode running — overlapping decodes count
// once, so the log reports how long decoding actually held the run up.
// waitMs: time the run actually stood still waiting for audio — a decode that
// finished in the background before it was needed adds nothing to it.
const decodeStats = { decodes: 0, decodeMs: 0, prefetched: 0, waitMs: 0 };
let inFlight = 0;
let busySince = 0;
function decodeStarted() { if (inFlight++ === 0) busySince = Date.now(); }
function decodeEnded() { if (--inFlight === 0) decodeStats.decodeMs += Date.now() - busySince; }
function resetDecodeStats() { decodeStats.decodes = 0; decodeStats.decodeMs = 0; decodeStats.prefetched = 0; decodeStats.waitMs = 0; }
function getDecodeStats() { return Object.assign({}, decodeStats); }

// ─── Decoded-region reuse ─────────────────────────────────────────────────────
// Every lav in a take is matched against the same boom region, so a job with N
// targets decodes that reference N times. Reusing it removes N-1 decodes.
//
// Deliberately a SINGLE slot rather than a Map: this heap is Premiere's, a
// 5-minute 48 kHz mono region is ~115 MB as Float64, and runner.js already
// decodes render channels one at a time specifically to keep the peak down. A
// growing cache would quietly undo that. Consecutive pairs sharing one
// reference is the whole pattern worth exploiting, and one slot captures it.
//
// Callers opt in with `reuse: true`, so a target decode can never evict the
// reference or pin memory nobody will ask for again.
let decodeSlot = null; // { key, value }

function clearDecodeCache() { decodeSlot = null; }

// ─── Decoding ahead, under a memory budget ────────────────────────────────────
// The DSP is single-threaded JS, so decoding in parallel only pays by overlap:
// the pool decodes what the runner will need next while the current pair is
// being aligned. Everything decoded ahead sits in Premiere's heap until its
// turn, so how much may be decoded ahead is capped by MEMORY, not by the
// thread count. A 30 s clip costs ~12 MB here and many fit; a 5-minute region
// ~115 MB, so a few; a 30-minute interview ~690 MB, so none — it decodes when
// its turn comes, exactly as before, and the peak is never worse than it was.
//
// A decoded-ahead result is held as the addon's float32 buffer and only
// widened to Float64 when it is used, so it costs half what it would as
// Float64, and the widening is the same arithmetic either way. Its cost is
// counted at 8 bytes a sample — the native buffer while decoding plus the JS
// copy it is handed over as — from the moment it starts until it is used or
// dropped.
const DEFAULT_PREFETCH_BUDGET_MB = 512;
const PREFETCH_BYTES_PER_SAMPLE = 8;
// Native-rate requests (sampleRate 0) are sized at this rate: an overestimate
// for most sources, which only means decoding a little less far ahead.
const UNKNOWN_RATE_ESTIMATE = 96000;

const prefetched = new Map(); // key -> { bytes, promise, released }
let prefetchBytes = 0;

// localStorage "unphased-decode-budget-mb" overrides it (0 = never decode ahead).
function prefetchBudgetBytes() {
    const mb = parseFloat(storageGet(DECODE_BUDGET_KEY));
    return (Number.isFinite(mb) && mb >= 0 ? mb : DEFAULT_PREFETCH_BUDGET_MB) * 1024 * 1024;
}

function normalizeRequest(filePath, opts) {
    const r = {
        filePath,
        startSec: opts.startSec,
        durationSec: opts.durationSec,
        wantRate: opts.sampleRate === undefined ? ANALYSIS_RATE : opts.sampleRate,
        streamIndex: opts.streamIndex || 0,
        channel: (opts.channel === null || opts.channel === undefined) ? -1 : opts.channel
    };
    r.key = [filePath, r.startSec, r.durationSec, r.wantRate, r.streamIndex, r.channel].join("|");
    return r;
}

function releasePrefetch(entry) {
    if (entry.released) return;
    entry.released = true;
    prefetchBytes -= entry.bytes;
}

/**
 * Start decoding a region the caller will ask decodeMono for soon, if the
 * background pool is available and the result fits the memory budget. A later
 * decodeMono with the same file and options picks it up instead of decoding
 * again. Returns whether it is (now, or already) on its way.
 *
 * Never blocks and never throws: a decode error surfaces when decodeMono asks
 * for the region, exactly as it would have without the prefetch.
 */
function prefetch(filePath, opts) {
    if (!useAsyncDecode(_addon)) return false;
    if (!(opts && opts.durationSec > 0)) return false;
    const req = normalizeRequest(filePath, opts);
    if (prefetched.has(req.key)) return true;
    if (decodeSlot && decodeSlot.key === req.key) return true;

    const bytes = Math.ceil(req.durationSec * (req.wantRate || UNKNOWN_RATE_ESTIMATE)) * PREFETCH_BYTES_PER_SAMPLE;
    if (prefetchBytes + bytes > prefetchBudgetBytes()) return false;

    const entry = { bytes, released: false, promise: null };
    prefetchBytes += bytes;
    entry.promise = decodeRaw(req);
    entry.promise.catch(() => { /* reported to whoever asks for it */ });
    prefetched.set(req.key, entry);
    decodeStats.prefetched++;
    return true;
}

function dropEntry(key) {
    const entry = prefetched.get(key);
    if (!entry) return;
    prefetched.delete(key);
    // The native decode cannot be stopped; its memory is only free once it has
    // finished and been handed over, so the budget is returned then.
    entry.promise.then(() => releasePrefetch(entry), () => releasePrefetch(entry));
}

/** Forget a region prefetched for a step that is no longer going to run. */
function dropPrefetch(filePath, opts) { dropEntry(normalizeRequest(filePath, opts).key); }

/** Forget everything decoded ahead — the end of a run, or a cancel. */
function clearPrefetch() { for (const key of Array.from(prefetched.keys())) dropEntry(key); }

function prefetchState() { return { pending: prefetched.size, bytes: prefetchBytes, budget: prefetchBudgetBytes() }; }

// One addon decode, as the addon's float32 result plus the front padding a
// negative start needs. A negative start means the requested window reaches
// before the media begins; decode from 0 and make up the difference later.
async function decodeRaw(req) {
    const a = await addon();
    const padSec = req.startSec < 0 ? -req.startSec : 0;
    const args = [req.filePath, req.streamIndex, req.channel,
        Math.max(0, req.startSec), Math.max(0, req.durationSec - padSec), req.wantRate];
    let r;
    decodeStarted();
    try {
        r = useAsyncDecode(a) ? await a.decodeAsync(...args) : a.decode(...args);
    } finally {
        decodeEnded();
    }
    decodeStats.decodes++;
    if (!r || !r.samples) throw new Error(`decode returned nothing: ${baseName(req.filePath)}`);
    return { r, padSec };
}

// The DSP's view: Float64, exactly durationSec long, padded front and back.
function widen(req, raw) {
    const rate = raw.r.sampleRate || req.wantRate || ANALYSIS_RATE;
    const decoded = new Float32Array(raw.r.samples);
    if (!decoded.length) throw new Error(`No audio samples: ${baseName(req.filePath)}`);

    const total = Math.round(req.durationSec * rate);
    const offset = Math.round(raw.padSec * rate);
    const samples = new Float64Array(total); // zero-filled: front pad + tail pad
    const n = Math.min(decoded.length, total - offset);
    for (let i = 0; i < n; i++) samples[offset + i] = decoded[i];
    return { sampleRate: rate, samples };
}

/**
 * Decode one mono signal, exactly `durationSec` long, as the DSP wants it.
 *
 * With `reuse`, the returned `samples` may be the same buffer a previous call
 * returned, so callers must treat it as read-only. alignPair does: it only
 * reads its `ref`, and copies the target before inverting polarity.
 *
 * @param {string} filePath
 * @param {object} opts { startSec, durationSec, sampleRate=48000 (0 = native),
 *                        streamIndex=0, channel=null (null = downmix),
 *                        reuse=false (cache this region for the next caller) }
 * @returns {Promise<{ sampleRate:number, samples:Float64Array }>}
 */
async function decodeMono(filePath, opts) {
    if (!(opts.durationSec > 0)) throw new Error(`decode: durationSec must be > 0 (${baseName(filePath)})`);
    const req = normalizeRequest(filePath, opts);

    if (opts.reuse && decodeSlot && decodeSlot.key === req.key) return decodeSlot.value;

    throwIfCancelled();
    const entry = prefetched.get(req.key);
    const waitStart = Date.now();
    let raw;
    if (entry) {
        prefetched.delete(req.key);
        try {
            raw = await entry.promise;
        } catch (e) {
            releasePrefetch(entry);
            throw e;
        }
    } else {
        // The synchronous fallback blocks the scripting thread, so let the
        // panel repaint first; awaiting the pool yields on its own.
        if (!useAsyncDecode(await addon())) {
            await yieldToUI();
            throwIfCancelled();
        }
        raw = await decodeRaw(req);
    }
    decodeStats.waitMs += Date.now() - waitStart;

    let out;
    try {
        throwIfCancelled();
        out = widen(req, raw);
    } finally {
        if (entry) releasePrefetch(entry);
    }
    // replaces whatever was held before, so at most one region is ever pinned
    if (opts.reuse) decodeSlot = { key: req.key, value: out };
    return out;
}

function baseName(p) {
    const m = /[^\\/]+$/.exec(p || "");
    return m ? m[0] : (p || "");
}

module.exports = {
    ANALYSIS_RATE,
    MAC_UNBLOCK_HINT,
    isMac,
    ensureAddon,
    __setAddon,
    setCancelCheck,
    probeStreams,
    probeMany,
    clearProbeCache,
    clearDecodeCache,
    decodeMono,
    prefetch,
    dropPrefetch,
    clearPrefetch,
    prefetchState,
    backgroundDecoding,
    decodeConcurrency,
    cpuCount,
    resetDecodeStats,
    getDecodeStats,
    baseName
};
