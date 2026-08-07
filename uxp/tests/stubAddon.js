// A stand-in for unphased.uxpaddon that decodes WAV files from disk instead of
// calling FFmpeg. It exists so the whole UXP pipeline — audio.js padding,
// runner.js staging, the shared DSP, WAV writing — can be exercised offline,
// on the same testmedia fixtures the CEP panel is verified against.
//
// It deliberately refuses to resample: if a test asks for a rate the fixture
// isn't already at, that's a test-design bug, not something to paper over with
// a naive resampler whose error would land in the alignment numbers.
"use strict";
const nodeFs = require("node:fs");
const { decodeWav } = require("../js/engine/wav.js");

const cache = new Map();
function load(path) {
    if (!cache.has(path)) cache.set(path, decodeWav(nodeFs.readFileSync(path)));
    return cache.get(path);
}

function probe(path) {
    try {
        const w = load(path);
        return {
            ok: true,
            error: "",
            durationSec: w.data[0].length / w.sampleRate,
            streams: [{
                index: 0,
                channels: w.channels,
                sampleRate: w.sampleRate,
                bits: 24,
                sampleFmt: "s32",
                codec: "pcm_s24le"
            }]
        };
    } catch (e) {
        return { ok: false, error: String(e.message || e), durationSec: 0, streams: [] };
    }
}

function decode(path, streamIndex, channel, startSec, durationSec, sampleRate) {
    const w = load(path);
    if (streamIndex) throw new Error(`stub addon: only stream 0 exists in ${path}`);
    if (sampleRate && sampleRate !== w.sampleRate) {
        throw new Error(`stub addon: refusing to resample ${w.sampleRate} -> ${sampleRate}`);
    }
    const rate = w.sampleRate;
    const from = Math.round(startSec * rate);
    const want = Math.round(durationSec * rate);
    const avail = Math.max(0, Math.min(want, w.data[0].length - from));
    const out = new Float32Array(avail);
    if (channel === -1 || channel === null || channel === undefined) {
        for (let i = 0; i < avail; i++) {
            let sum = 0;
            for (let c = 0; c < w.channels; c++) sum += w.data[c][from + i];
            out[i] = sum / w.channels;
        }
    } else {
        const src = w.data[channel];
        if (!src) throw new Error(`stub addon: no channel ${channel} in ${path}`);
        for (let i = 0; i < avail; i++) out[i] = src[from + i];
    }
    return { sampleRate: rate, samples: out.buffer };
}

module.exports = { probe, decode, __clearCache: () => cache.clear() };
