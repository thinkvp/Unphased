/**
 * Unphased — audio.js
 * Wraps the bundled FFmpeg native addon and hands the DSP exactly the buffers
 * the CEP/Node engine used to get from `ffmpeg -ss … -t … -c:a pcm_f32le`.
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
 * The addon's decode is synchronous on UXP's scripting thread, so — as in
 * Syncitol — a cancel check runs before each decode and a setTimeout(0) yield
 * lets the panel repaint and the Cancel click land.
 */
"use strict";

const ANALYSIS_RATE = 48000;

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
                _addonError = new Error(
                    "Unphased audio addon failed to load (unphased.uxpaddon). " + detail);
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
    const startSec = opts.startSec;
    const durationSec = opts.durationSec;
    const wantRate = opts.sampleRate === undefined ? ANALYSIS_RATE : opts.sampleRate;
    const streamIndex = opts.streamIndex || 0;
    const channel = (opts.channel === null || opts.channel === undefined) ? -1 : opts.channel;

    if (!(durationSec > 0)) throw new Error(`decode: durationSec must be > 0 (${baseName(filePath)})`);

    const key = opts.reuse
        ? [filePath, startSec, durationSec, wantRate, streamIndex, channel].join("|")
        : null;
    if (key !== null && decodeSlot && decodeSlot.key === key) return decodeSlot.value;

    throwIfCancelled();
    await yieldToUI(); // let the panel repaint before a blocking decode
    throwIfCancelled();

    // A negative start means the requested window reaches before the media
    // begins; decode from 0 and make up the difference with silence.
    const padSec = startSec < 0 ? -startSec : 0;
    const a = await addon();
    const r = a.decode(filePath, streamIndex, channel,
        Math.max(0, startSec), Math.max(0, durationSec - padSec), wantRate);
    if (!r || !r.samples) throw new Error(`decode returned nothing: ${baseName(filePath)}`);

    const rate = r.sampleRate || wantRate || ANALYSIS_RATE;
    const decoded = new Float32Array(r.samples);
    if (!decoded.length) throw new Error(`No audio samples: ${baseName(filePath)}`);

    const total = Math.round(durationSec * rate);
    const offset = Math.round(padSec * rate);
    const samples = new Float64Array(total); // zero-filled: front pad + tail pad
    const n = Math.min(decoded.length, total - offset);
    for (let i = 0; i < n; i++) samples[offset + i] = decoded[i];
    const out = { sampleRate: rate, samples };
    // replaces whatever was held before, so at most one region is ever pinned
    if (key !== null) decodeSlot = { key, value: out };
    return out;
}

function baseName(p) {
    const m = /[^\\/]+$/.exec(p || "");
    return m ? m[0] : (p || "");
}

module.exports = {
    ANALYSIS_RATE,
    ensureAddon,
    __setAddon,
    setCancelCheck,
    probeStreams,
    probeMany,
    clearProbeCache,
    clearDecodeCache,
    decodeMono,
    baseName
};
