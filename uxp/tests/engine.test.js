// The generated CommonJS engine must behave exactly like the ESM source it was
// transpiled from — same exports, same numbers. A mistranslated module would
// otherwise only show up as wrong alignment inside Premiere.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const SRC = path.resolve(__dirname, "..", "..", "engine", "src");
const esm = (file) => import(pathToFileURL(path.join(SRC, file)).href);

// Keep in step with MODULES in uxp/scripts/build-engine.js — this list is a
// second, hand-maintained copy, and a module missing here is a module whose
// export parity nothing checks.
const MODULES = [
    "align.js", "autoMix.js", "coarse.js", "coherence.js", "decimate.js",
    "fft.js", "gccPhat.js", "job.js", "lattice.js", "pathSolver.js",
    "phaseAlign.js", "polarity.js", "varyDelay.js", "wav.js"
];

test("every generated module exports exactly what the ESM source does", async () => {
    for (const file of MODULES) {
        const cjs = require(`../js/engine/${file}`);
        const src = await esm(file);
        const want = Object.keys(src).filter((k) => k !== "default").sort();
        assert.deepEqual(Object.keys(cjs).sort(), want, `exports of ${file}`);
    }
});

test("wav codec round-trips through the generated module", () => {
    const { encodeWav, decodeWav } = require("../js/engine/wav.js");
    const frames = 4801;
    const left = new Float64Array(frames).map((_, i) => Math.sin(i / 7) * 0.8);
    const right = new Float64Array(frames).map((_, i) => Math.cos(i / 11) * 0.6);
    const decoded = decodeWav(encodeWav({ sampleRate: 96000, data: [left, right] }, "pcm24"));
    assert.equal(decoded.sampleRate, 96000);
    assert.equal(decoded.channels, 2);
    assert.equal(decoded.data[0].length, frames);
    for (let i = 0; i < frames; i++) {
        assert.ok(Math.abs(decoded.data[0][i] - left[i]) <= 1 / 8388608, `L${i}`);
        assert.ok(Math.abs(decoded.data[1][i] - right[i]) <= 1 / 8388608, `R${i}`);
    }
});

test("alignPair recovers a known static delay and nulls deeply", async () => {
    const { alignPair } = require("../js/engine/align.js");
    const { speechLike, fftDelay } = await esm("../test/fixtures.js");

    const sampleRate = 48000;
    const { signal: ref } = speechLike({ seconds: 6, seed: 17 });
    const delaySamples = 0.0091 * sampleRate; // 9.1 ms
    const handle = Math.round(0.25 * sampleRate);

    // The target is the reference delayed, framed with handles the way the
    // runner extracts it (handleSec either side of the overlap).
    const delayed = fftDelay(ref, delaySamples);
    const tgt = new Float64Array(ref.length + 2 * handle);
    tgt.set(delayed, handle);

    const r = alignPair({ ref, tgt, sampleRate, params: { mode: "static", phase: "off" }, tgtOffsetSamples: handle });
    assert.equal(r.status, "ok");
    assert.ok(Math.abs(r.report.staticDelayMs - 9.1) < 0.2,
        `staticDelayMs ${r.report.staticDelayMs} != ~9.1`);
    assert.ok(r.report.nullDepthDb > 20, `nullDepthDb ${r.report.nullDepthDb} too shallow`);
});

test("normalizeJob stays pure — no tempDir is created for us", () => {
    const { normalizeJob } = require("../js/engine/job.js");
    const job = normalizeJob({
        pairs: [{
            id: "p0",
            outputPath: "C:/nope/out.wav",
            ref: { mediaPath: "a.wav", startSec: 0, durationSec: 10 },
            target: { mediaPath: "b.wav", startSec: 0, durationSec: 10 }
        }]
    });
    assert.equal(job.tempDir, null);
    assert.equal(job.pairs.length, 1);
    assert.equal(job.params.mode, "dynamic");
});
