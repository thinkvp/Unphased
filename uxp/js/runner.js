/**
 * Unphased — runner.js
 * The UXP counterpart of `engine/cli.js run job.json`. Same job schema, same
 * pipeline, same event names — but the whole thing runs in-panel instead of in
 * a spawned system Node, because UXP has no child_process.
 *
 * Differences from the CEP path, all forced by the runtime:
 *
 *  - No scratch WAVs. ffmpeg used to write ref/target segments to job.tempDir
 *    and the engine read them back; here audio.decodeMono hands us Float64Array
 *    directly, so tempDir is unused and nothing needs cleaning up.
 *
 *  - Rendering decodes ONE CHANNEL AT A TIME at the source's native rate. The
 *    CEP path re-extracted the whole interleaved stream to a WAV and read every
 *    channel out of it; holding a 5-minute 96 kHz stereo file in memory as
 *    Float64 is ~460 MB, and UXP's heap is shared with Premiere. Decoding per
 *    channel caps the peak at one channel's worth, and `pan=mono|c0=cN` is a
 *    thing the addon does anyway.
 *
 *  - Progress arrives as callbacks rather than NDJSON on stdout. The event
 *    objects are identical, so main.js reads them the same way the CEP panel
 *    read the engine's output.
 *
 * Everything else — pairing, the job schema, and the entire DSP — is the shared
 * engine, unchanged.
 */
"use strict";

const audio = require("./audio");
const { alignPair, renderChannel } = require("./engine/align.js");
const { encodeWav } = require("./engine/wav.js");

// UXP's fs is promise-based; Node's built-in `fs` is not, so it is resolved
// lazily and swappable rather than required at load time. The offline suite
// injects a node:fs/promises shim through __setFs.
let _fs = null;
function fs() { return _fs || (_fs = require("fs")); }
function __setFs(mod) { _fs = mod; }

/** Map a probed sample format / bit depth onto a WAV output format. */
function pickFormat(stream, requested) {
    if (requested && requested !== "auto") return requested;
    if (!stream) return "pcm24";
    const fmt = String(stream.sampleFmt || "");
    if (fmt.startsWith("flt") || fmt.startsWith("dbl")) return "f32";
    const bits = stream.bits || (fmt.startsWith("s16") ? 16 : fmt.startsWith("s32") ? 32 : null);
    if (bits === 16) return "pcm16";
    if (bits === 32) return "f32";
    return "pcm24";
}

// UXP's fs.mkdir is not recursive; walk the path and ignore "already exists".
async function ensureDir(dir) {
    const parts = String(dir).replace(/\\/g, "/").replace(/\/+$/, "").split("/");
    let acc = "";
    for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        if (!acc || /^[A-Za-z]:$/.test(acc)) continue; // drive root
        try { await fs().mkdir(acc); } catch (e) { /* exists, or we'll fail on write */ }
    }
}

function dirNameOf(p) {
    const s = String(p).replace(/\\/g, "/");
    const i = s.lastIndexOf("/");
    return i > 0 ? s.slice(0, i) : s;
}

/**
 * Re-render the target at its own rate and channel count, replaying the
 * measured correction onto every channel. Falls back to the 48 kHz mono
 * analysis render when the source offers nothing better.
 */
async function renderOutput({ job, pair, correction, fallback }) {
    const { target, handleSec } = pair;
    const requested = job.outputFormat;
    const analysisRate = job.sampleRate;

    if (job.preserveSourceFormat === false) {
        return { data: [fallback], sampleRate: analysisRate, format: pickFormat(null, requested) };
    }

    const probe = await audio.probeStreams(target.mediaPath);
    const stream = (probe.streams || [])[target.audioStream || 0];
    const srcRate = (stream && stream.sampleRate) ? stream.sampleRate : analysisRate;
    const srcChannels = stream ? stream.channels : 1;

    // A specific channel was selected for analysis: that channel IS the clip's
    // audio, so render it alone. Otherwise render every channel of the stream.
    const wantAll = (target.channel === null || target.channel === undefined) && srcChannels > 1;
    if (!wantAll && srcRate === analysisRate) {
        return { data: [fallback], sampleRate: analysisRate, format: pickFormat(stream, requested) };
    }

    const channels = wantAll
        ? Array.from({ length: srcChannels }, (_, c) => c)
        : [target.channel === undefined ? null : target.channel];

    const outLen = Math.round(target.durationSec * srcRate);
    const data = [];
    for (const ch of channels) {
        const decoded = await audio.decodeMono(target.mediaPath, {
            startSec: target.startSec - handleSec,
            durationSec: target.durationSec + 2 * handleSec,
            sampleRate: srcRate,
            streamIndex: target.audioStream,
            channel: ch
        });
        data.push(renderChannel(decoded.samples, correction, outLen, decoded.sampleRate));
    }
    return { data, sampleRate: srcRate, format: pickFormat(stream, requested) };
}

/**
 * @param {object} job normalized job (see engine/src/job.js) — pairs carry
 *   absolute outputPaths, exactly as the CEP panel builds them.
 * @param {function} onEvent called with { event: 'start'|'phase'|'result'|'error'|'done', ... }
 * @returns {Promise<{results: object[], ok: number, failed: number, cancelled: boolean}>}
 */
async function runJob(job, onEvent) {
    const emit = (obj) => { try { onEvent && onEvent(obj); } catch (e) { /* UI errors never stop a run */ } };
    const results = [];
    const fs48 = job.sampleRate;
    let ok = 0;
    let failed = 0;
    let cancelled = false;

    await audio.ensureAddon();
    emit({ event: "start", pairs: job.pairs.length });

    for (const pair of job.pairs) {
        const { id, ref, target, outputPath, handleSec } = pair;
        try {
            emit({ event: "phase", id, phase: "extract", pct: 0 });
            // Pairs in a take share one reference region, so this decode is
            // reused across them rather than repeated. Read-only downstream.
            const refAudio = await audio.decodeMono(ref.mediaPath, {
                startSec: ref.startSec,
                durationSec: ref.durationSec,
                sampleRate: fs48,
                streamIndex: ref.audioStream,
                channel: ref.channel,
                reuse: true
            });
            const tgtAudio = await audio.decodeMono(target.mediaPath, {
                startSec: target.startSec - handleSec,
                durationSec: target.durationSec + 2 * handleSec,
                sampleRate: fs48,
                streamIndex: target.audioStream,
                channel: target.channel
            });

            emit({ event: "phase", id, phase: "align", pct: 25 });
            const r = alignPair({
                ref: refAudio.samples,
                tgt: tgtAudio.samples,
                sampleRate: fs48,
                params: job.params,
                tgtOffsetSamples: Math.round(handleSec * fs48)
            });

            if (r.status === "failed") {
                failed++;
                const payload = { event: "result", id, status: "failed", reason: r.reason };
                results.push(payload);
                emit(payload);
                continue;
            }

            emit({ event: "phase", id, phase: "write", pct: 75 });
            const render = await renderOutput({ job, pair, correction: r.correction, fallback: r.aligned });
            const bytes = encodeWav({ sampleRate: render.sampleRate, data: render.data }, render.format);
            await ensureDir(dirNameOf(outputPath));
            await fs().writeFile(outputPath, bytes.buffer);

            ok++;
            const payload = Object.assign({
                event: "result",
                id,
                status: r.status,
                outputPath,
                outputChannels: render.data.length,
                outputSampleRate: render.sampleRate,
                outputFormat: render.format
            }, r.report);
            results.push(payload);
            emit(payload);
        } catch (err) {
            if (err && err.cancelled) { cancelled = true; break; }
            failed++;
            const payload = { event: "result", id, status: "failed", reason: String((err && err.message) || err) };
            results.push(payload);
            emit(payload);
        }
    }

    // Hand the reference region back to the collector. Premiere shares this
    // heap, and nothing after the job needs it.
    audio.clearDecodeCache();

    emit({ event: "done", ok, failed, cancelled });
    return { results, ok, failed, cancelled };
}

module.exports = { runJob, pickFormat, ensureDir, dirNameOf, __setFs };
