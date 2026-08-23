/**
 * Unphased — automixRunner.js
 * The UXP counterpart of `engine/src/autoMixRun.js`. Same DSP, same job schema,
 * same event names — but in-panel, because UXP has no child_process.
 *
 * CURVE MODE ONLY. That is not a limitation here, it is the point: a gain curve
 * becomes volume keyframes on the clips that are already on the timeline, so
 * there is nothing to render, nothing to import, no bin, no new tracks and
 * nothing to place. The whole reintegration half of the align path simply does
 * not exist for auto-mix. Rendering ducked WAVs is available from the CLI
 * (`node engine/cli.js automix`) and is what the later per-band bleed stage
 * will need, since a spectral mask cannot be keyframed.
 */
"use strict";

const audio = require("./audio");
const { encodeWav } = require("./engine/wav.js");
const { applyGainCurve } = require("./engine/autoMix.js");
const { attributeSpeakers, autoMixGains, simplifyGainCurve, AUTOMIX_DEFAULTS } = require("./engine/autoMix.js");
const { decimate } = require("./engine/decimate.js");

const ANALYSIS_RATE = 48000;

// UXP's fs is promise-based and must not be required at load time; the offline
// suite swaps in node:fs/promises. Same shape as runner.js.
let _fs = null;
function fs() { return _fs || (_fs = require("fs")); }
function __setFs(mod) { _fs = mod; }

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

/**
 * Bake a gain curve into one mic and write it as a WAV, at the source's own
 * rate and channel count. Mirrors renderOutput in runner.js — decoding ONE
 * CHANNEL AT A TIME, because holding a long multichannel file as Float64 in a
 * heap shared with Premiere is what that file exists to avoid.
 */
async function renderMic(mic, gainDb, frameCenters, attribRate, handleSec, outputFormat) {
    const probe = await audio.probeStreams(mic.source.mediaPath);
    const stream = (probe.streams || [])[mic.source.audioStream || 0];
    const srcRate = (stream && stream.sampleRate) ? stream.sampleRate : ANALYSIS_RATE;
    const srcChannels = stream ? stream.channels : 1;
    const wantAll = (mic.source.channel === null || mic.source.channel === undefined) && srcChannels > 1;
    const channels = wantAll
        ? Array.from({ length: srcChannels }, (_, c) => c)
        : [mic.source.channel === undefined ? null : mic.source.channel];

    const outLen = Math.round(mic.source.durationSec * srcRate);
    const data = [];
    for (const ch of channels) {
        const decoded = await audio.decodeMono(mic.source.mediaPath, {
            startSec: mic.source.startSec - handleSec,
            durationSec: mic.source.durationSec + 2 * handleSec,
            sampleRate: srcRate,
            streamIndex: mic.source.audioStream,
            channel: ch
        });
        // In place: a gain depends on no neighbouring sample, so unlike the
        // delay applier this needs no second buffer.
        data.push(applyGainCurve(decoded.samples, gainDb, frameCenters, outLen, {
            analysisRate: attribRate,
            renderRate: decoded.sampleRate,
            inOffset: Math.round(handleSec * decoded.sampleRate),
            out: decoded.samples
        }));
    }
    return { data, sampleRate: srcRate, format: pickFormat(stream, outputFormat) };
}

/**
 * Trim a keyframe list to the clip's own interval.
 *
 * Mirrors clipKeys in engine/src/autoMixRun.js — kept in step by hand, because
 * that file is Node-only (fs, ffmpeg) and cannot be shared. The curve is
 * measured over a handled window that starts before the clip does, and a host
 * cannot key before a clip begins.
 */
function clipKeys(keys, durationSec) {
    const out = [];
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k.timeSec < 0) {
            const next = keys[i + 1];
            if (next && next.timeSec >= 0 && next.timeSec > k.timeSec) {
                const t = (0 - k.timeSec) / (next.timeSec - k.timeSec);
                out.push({ timeSec: 0, gainDb: k.gainDb + (next.gainDb - k.gainDb) * t });
            }
            continue;
        }
        if (k.timeSec > durationSec) {
            const prev = keys[i - 1];
            if (prev && prev.timeSec < durationSec && k.timeSec > prev.timeSec) {
                const t = (durationSec - prev.timeSec) / (k.timeSec - prev.timeSec);
                out.push({ timeSec: durationSec, gainDb: prev.gainDb + (k.gainDb - prev.gainDb) * t });
            }
            break;
        }
        out.push(k);
    }
    if (!out.length) {
        return keys.length ? [{ timeSec: 0, gainDb: keys[keys.length - 1].gainDb }] : [];
    }
    if (out[0].timeSec > 0) out.unshift({ timeSec: 0, gainDb: out[0].gainDb });
    return out;
}

/**
 * Run an auto-mix over N participants and return a gain curve for each.
 *
 * @param {object} job { mics: [{ id, source, trackIndex, clipIndex }], params, handleSec }
 * @param {function} onEvent same event objects the CLI writes as NDJSON
 * @returns {Promise<{ ok, failed, cancelled, results, summary }>}
 */
async function runAutoMix(job, onEvent) {
    const emit = onEvent || function () {};
    const params = Object.assign({}, AUTOMIX_DEFAULTS, job.params || {});
    const handleSec = job.handleSec === undefined ? 2.25 : job.handleSec;
    const attribRate = ANALYSIS_RATE / params.decimation;

    emit({ event: "start", mode: "automix", mics: job.mics.length });

    // Decode one mic at a time and keep only the decimated copy. A five-minute
    // take is ~115 MB as Float64 at the analysis rate and ~19 MB decimated, and
    // this heap is shared with Premiere.
    const decimated = [];
    for (let i = 0; i < job.mics.length; i++) {
        const mic = job.mics[i];
        emit({ event: "phase", id: mic.id, phase: "extract", pct: Math.round((i / job.mics.length) * 30) });
        const full = await audio.decodeMono(mic.source.mediaPath, {
            startSec: mic.source.startSec - handleSec,
            durationSec: mic.source.durationSec + 2 * handleSec,
            sampleRate: ANALYSIS_RATE,
            streamIndex: mic.source.audioStream || 0,
            channel: mic.source.channel
        });
        // audio.decodeMono returns { sampleRate, samples } — a Float64Array of
        // exactly the requested window, zero-padded where the file runs out.
        decimated.push(decimate(full.samples, params.decimation));
    }

    emit({ event: "phase", id: null, phase: "attribute", pct: 45 });
    const attr = attributeSpeakers(decimated, Object.assign({}, params, { sampleRate: attribRate }));
    const gains = autoMixGains(attr, params);
    decimated.length = 0;

    // Why a curve came out flat is not answerable from the gains alone, so the
    // two ingredients are reported separately. A duck only happens when one
    // mic's evidence beats the rest; evidence is level plus lead, so a flat
    // result means either the leads all cancelled (no usable timing) or the
    // levels are indistinguishable (every mic hearing the same thing).
    let leadSum = 0;
    let gapSum = 0;
    let activeFrames = 0;
    const meanAbsLead = [];
    for (let m = 0; m < job.mics.length; m++) {
        let s = 0;
        for (let f = 0; f < attr.nFrames; f++) s += Math.abs(attr.lead[m][f]);
        meanAbsLead.push(attr.nFrames ? s / attr.nFrames : 0);
        leadSum += meanAbsLead[m];
    }
    for (let f = 0; f < attr.nFrames; f++) {
        if (gains.activity[f] < 0.5) continue;
        let best = -Infinity;
        let second = -Infinity;
        for (let m = 0; m < job.mics.length; m++) {
            const e = gains.evidence[m][f];
            if (e > best) { second = best; best = e; } else if (e > second) { second = e; }
        }
        if (second > -Infinity) { gapSum += best - second; activeFrames++; }
    }

    const summary = {
        frames: attr.nFrames,
        frameRateHz: attr.sampleRate / attr.hop,
        activeFraction: gains.report.activeFraction,
        meanLead: leadSum / Math.max(1, job.mics.length),
        meanEvidenceGapDb: activeFrames ? gapSum / activeFrames : 0,
        // The gain is activity * evidence, and activity is levelActivity *
        // coherence — so either factor collapsing zeroes the whole thing
        // however good the geometry is. Both are reported because they fail
        // for completely different reasons and have different fixes.
        meanCoherence: mean(attr.coherence),
        // Before reliability weighting. If raw is healthy and weighted is not,
        // the mics correlated fine and we discounted the pairs ourselves — a
        // completely different problem from the correlation failing.
        meanRawCoherence: mean(attr.rawCoherence),
        cluster: attr.cluster ? {
            usable: attr.cluster.usable,
            clusters: attr.cluster.clusters,
            quality: attr.cluster.quality,
            agreement: attr.cluster.agreement
        } : null,
        meanLevelActivity: mean(attr.levelActivity),
        levelMatch: gains.report.levelMatch,
        targetLufs: gains.report.targetLufs,
        micLead: job.mics.map((m, i) => ({
            id: m.id,
            meanAbsLead: meanAbsLead[i],
            refDb: attr.refDb[i],
            speechLufs: gains.report.micStats[i].speechLufs,
            gateDb: attr.gateDb[i]
        })),
        pairs: attr.pairs.map((p) => ({
            micA: job.mics[p.i].id,
            micB: job.mics[p.j].id,
            syncMs: p.syncMs,
            spreadMs: p.spreadMs,
            usable: p.usable,
            reason: p.reason
        }))
    };
    emit(Object.assign({ event: "automix" }, summary));

    const results = [];
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < job.mics.length; i++) {
        const mic = job.mics[i];
        emit({ event: "phase", id: mic.id, phase: "curve", pct: 70 + Math.round((i / job.mics.length) * 25) });
        try {
            const s = simplifyGainCurve(gains.gainDb[i], attr.frameCenters,
                Object.assign({}, params, { sampleRate: attribRate }));
            // The per-mic level match is a constant, kept out of the duck
            // curve and added here where a constant offset is what it is.
            const match = gains.matchGainDb ? gains.matchGainDb[i] : 0;
            const shifted = s.keys.map((k) => ({ timeSec: k.timeSec - handleSec, gainDb: k.gainDb + match }));
            const keys = clipKeys(shifted, mic.source.durationSec);
            let rendered = null;
            if (job.output === "render" || job.output === "both") {
                emit({ event: "phase", id: mic.id, phase: "render", pct: 80 });
                const matched = new Float64Array(gains.gainDb[i].length);
                for (let q = 0; q < matched.length; q++) matched[q] = gains.gainDb[i][q] + (gains.matchGainDb ? gains.matchGainDb[i] : 0);
                const r = await renderMic(mic, matched, attr.frameCenters,
                    attribRate, handleSec, job.outputFormat);
                const bytes = encodeWav({ sampleRate: r.sampleRate, data: r.data }, r.format);
                await fs().writeFile(mic.outputPath, bytes.buffer);
                rendered = {
                    outputPath: mic.outputPath,
                    outputChannels: r.data.length,
                    outputSampleRate: r.sampleRate,
                    outputFormat: r.format
                };
            }
            const payload = {
                id: mic.id,
                status: "ok",
                keys: keys,
                maxErrorDb: s.maxErrorDb,
                kept: keys.length,
                winnerFraction: gains.report.micStats[i].winnerFraction,
                meanDuckDb: gains.report.micStats[i].meanDuckDb,
                matchGainDb: gains.report.micStats[i].matchGainDb,
                outLufs: gains.report.micStats[i].outLufs,
                matchClamp: gains.report.micStats[i].matchClamp
            };
            if (rendered) Object.assign(payload, rendered);
            results.push(payload);
            emit(Object.assign({ event: "result" }, payload));
            ok++;
        } catch (err) {
            const payload = { id: mic.id, status: "failed", reason: String((err && err.message) || err) };
            results.push(payload);
            emit(Object.assign({ event: "result" }, payload));
            failed++;
        }
    }

    emit({ event: "done", ok: ok, failed: failed });
    return { ok: ok, failed: failed, results: results, summary: summary };
}

function mean(arr) {
    if (!arr || !arr.length) return 0;
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
}

module.exports = { runAutoMix, clipKeys, __setFs };
