/**
 * Unphased — runner.js
 * The UXP counterpart of `engine/cli.js run job.json`. Same job schema, same
 * pipeline, same event names — but the whole thing runs in-panel instead of in
 * a spawned system Node, because UXP has no child_process.
 *
 * Differences from the headless CLI path, all forced by the runtime:
 *
 *  - No scratch WAVs. The CLI has ffmpeg write ref/target segments to
 *    job.tempDir and reads them back; here audio.decodeMono hands us a
 *    Float64Array directly, so tempDir is unused and nothing needs cleaning up.
 *
 *  - Rendering decodes ONE CHANNEL AT A TIME at the source's native rate,
 *    rather than extracting the whole interleaved stream to a WAV and reading
 *    every channel out of it. Holding a 5-minute 96 kHz stereo file in memory
 *    as Float64 is ~460 MB, and UXP's heap is shared with Premiere. Decoding
 *    per channel caps the peak at one channel's worth, and `pan=mono|c0=cN` is
 *    a thing the addon does anyway.
 *
 *  - Decoding overlaps the DSP. While one pair is aligned, the addon's
 *    background pool decodes what comes next — this pair's render channels,
 *    then the next pair's reference and target — as far as audio.js's memory
 *    budget allows (see audio.prefetch). Without the pool, or over budget,
 *    each decode simply happens when its turn comes, as before.
 *
 *  - Progress arrives as callbacks rather than NDJSON on stdout. The event
 *    objects are identical either way, so main.js and the CLI's consumers read
 *    the same shapes.
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

// The decode requests a pair needs, as [path, opts] for audio.decodeMono and
// audio.prefetch — built in one place so a prefetch always matches the decode
// that later picks it up.
function refRequest(pair, rate) {
    const { ref } = pair;
    return [ref.mediaPath, {
        startSec: ref.startSec,
        durationSec: ref.durationSec,
        sampleRate: rate,
        streamIndex: ref.audioStream,
        channel: ref.channel,
        // Pairs in a take share one reference region, so this decode is reused
        // across them rather than repeated. Read-only downstream.
        reuse: true
    }];
}
function targetRequest(pair, rate, channel) {
    const { target, handleSec } = pair;
    return [target.mediaPath, {
        startSec: target.startSec - handleSec,
        durationSec: target.durationSec + 2 * handleSec,
        sampleRate: rate,
        streamIndex: target.audioStream,
        channel: channel === undefined ? target.channel : channel
    }];
}

/**
 * How the target will be rendered: at its own rate and channel count when the
 * source offers more than the 48 kHz mono analysis render, which then needs one
 * decode per channel (`requests`); otherwise the analysis render itself.
 */
async function planRender(job, pair) {
    const { target } = pair;
    const requested = job.outputFormat;
    const analysisRate = job.sampleRate;

    if (job.preserveSourceFormat === false) {
        return { useFallback: true, sampleRate: analysisRate, format: pickFormat(null, requested), requests: [] };
    }

    const probe = await audio.probeStreams(target.mediaPath);
    const stream = (probe.streams || [])[target.audioStream || 0];
    const srcRate = (stream && stream.sampleRate) ? stream.sampleRate : analysisRate;
    const srcChannels = stream ? stream.channels : 1;
    const format = pickFormat(stream, requested);

    // A specific channel was selected for analysis: that channel IS the clip's
    // audio, so render it alone. Otherwise render every channel of the stream.
    const wantAll = (target.channel === null || target.channel === undefined) && srcChannels > 1;
    if (!wantAll && srcRate === analysisRate) {
        return { useFallback: true, sampleRate: analysisRate, format, requests: [] };
    }

    const channels = wantAll
        ? Array.from({ length: srcChannels }, (_, c) => c)
        : [target.channel === undefined ? null : target.channel];
    return {
        useFallback: false,
        sampleRate: srcRate,
        format,
        requests: channels.map((ch) => targetRequest(pair, srcRate, ch))
    };
}

/**
 * Re-render the target at its own rate and channel count, replaying the
 * measured correction onto every channel. Falls back to the 48 kHz mono
 * analysis render when the source offers nothing better.
 *
 * Channels are decoded and rendered one at a time: holding a long multichannel
 * source as Float64 all at once is what this avoids. `ahead(i)` is called
 * before channel i so freed budget goes straight to decoding what comes next.
 */
async function renderOutput({ pair, plan, correction, fallback, ahead }) {
    if (plan.useFallback) {
        return { data: [fallback], sampleRate: plan.sampleRate, format: plan.format };
    }
    const outLen = Math.round(pair.target.durationSec * plan.sampleRate);
    const data = [];
    for (let i = 0; i < plan.requests.length; i++) {
        if (ahead) ahead(i);
        const decoded = await audio.decodeMono(...plan.requests[i]);
        data.push(renderChannel(decoded.samples, correction, outLen, decoded.sampleRate));
    }
    return { data, sampleRate: plan.sampleRate, format: plan.format };
}

/**
 * @param {object} job normalized job (see engine/src/job.js) — pairs carry
 *   absolute outputPaths.
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

    try {
        for (let k = 0; k < job.pairs.length; k++) {
            const pair = job.pairs[k];
            const next = job.pairs[k + 1];
            const { id, outputPath, handleSec } = pair;
            let plan = null;
            // Where this pair's time went, for the log. Decode waits are
            // counted by audio.js, so render here is the DSP plus any wait.
            const timing = { alignMs: 0, renderMs: 0, writeMs: 0 };
            try {
                emit({ event: "phase", id, phase: "extract", pct: 0 });
                const refReq = refRequest(pair, fs48);
                const tgtReq = targetRequest(pair, fs48);
                // Decode the target alongside the reference rather than after it.
                audio.prefetch(...tgtReq);
                const refAudio = await audio.decodeMono(...refReq);
                let tgtAudio = await audio.decodeMono(...tgtReq);

                // While this pair is aligned, decode what comes next: its own
                // render channels first (needed sooner), then the next pair.
                plan = await planRender(job, pair);
                // `from` skips render channels already used: asking again for
                // one would decode it a second time for nobody.
                const ahead = (from = 0) => {
                    for (let i = from; i < plan.requests.length; i++) audio.prefetch(...plan.requests[i]);
                    if (next) {
                        audio.prefetch(...refRequest(next, fs48));
                        audio.prefetch(...targetRequest(next, fs48));
                    }
                };
                ahead();

                emit({ event: "phase", id, phase: "align", pct: 25 });
                let t = Date.now();
                const r = alignPair({
                    ref: refAudio.samples,
                    tgt: tgtAudio.samples,
                    sampleRate: fs48,
                    params: job.params,
                    tgtOffsetSamples: Math.round(handleSec * fs48)
                });
                // Nothing reads the analysis-rate target after alignment (the
                // render decodes its own copy, or uses r.aligned), so let the
                // collector have it before the render allocates its buffers.
                tgtAudio = null;
                timing.alignMs = Date.now() - t;

                if (r.status === "failed") {
                    for (const req of plan.requests) audio.dropPrefetch(...req);
                    failed++;
                    const payload = { event: "result", id, status: "failed", reason: r.reason, timing };
                    results.push(payload);
                    emit(payload);
                    continue;
                }

                emit({ event: "phase", id, phase: "write", pct: 75 });
                t = Date.now();
                const render = await renderOutput({ pair, plan, correction: r.correction, fallback: r.aligned, ahead });
                timing.renderMs = Date.now() - t;
                t = Date.now();
                const bytes = encodeWav({ sampleRate: render.sampleRate, data: render.data }, render.format);
                await ensureDir(dirNameOf(outputPath));
                await fs().writeFile(outputPath, bytes.buffer);
                timing.writeMs = Date.now() - t;

                ok++;
                const payload = Object.assign({
                    event: "result",
                    id,
                    status: r.status,
                    outputPath,
                    outputChannels: render.data.length,
                    outputSampleRate: render.sampleRate,
                    outputFormat: render.format,
                    timing
                }, r.report);
                results.push(payload);
                emit(payload);
            } catch (err) {
                if (plan) for (const req of plan.requests) audio.dropPrefetch(...req);
                if (err && err.cancelled) { cancelled = true; break; }
                failed++;
                const payload = { event: "result", id, status: "failed", reason: String((err && err.message) || err), timing };
                results.push(payload);
                emit(payload);
            }
        }
    } finally {
        // Hand everything decoded back to the collector — the shared reference
        // region and anything decoded ahead that will now never be used.
        // Premiere shares this heap, and nothing after the job needs it.
        audio.clearPrefetch();
        audio.clearDecodeCache();
    }

    emit({ event: "done", ok, failed, cancelled });
    return { results, ok, failed, cancelled };
}

module.exports = { runJob, planRender, pickFormat, ensureDir, dirNameOf, __setFs };
