// End-to-end for the UXP run path: job -> audio.decodeMono -> alignPair ->
// per-channel render -> WAV on disk. The native addon is stubbed with WAV
// fixtures (tests/stubAddon.js) and UXP's promise fs with node:fs/promises, so
// this runs anywhere `node --test` does.
//
// The mono case uses testmedia/, whose ground truth (testmedia/ground-truth.json)
// is what the CEP panel is verified against — so a regression here means the
// UXP path stopped agreeing with the CEP one.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const nodeFs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const audio = require("../js/audio.js");
const runner = require("../js/runner.js");
const stub = require("./stubAddon.js");
const { normalizeJob } = require("../js/engine/job.js");
const { encodeWav, decodeWav } = require("../js/engine/wav.js");

const MEDIA = path.resolve(__dirname, "..", "..", "testmedia");
const hasFixtures = nodeFs.existsSync(path.join(MEDIA, "boom.wav"));

audio.__setAddon(stub);
runner.__setFs({
    mkdir: (dir) => fsp.mkdir(dir),
    // UXP hands writeFile an ArrayBuffer; node wants a view over it.
    writeFile: (file, buf) => fsp.writeFile(file, Buffer.from(buf))
});

function tmpDir(tag) {
    const dir = path.join(os.tmpdir(), `unphased-uxp-${tag}-${process.pid}`);
    nodeFs.mkdirSync(dir, { recursive: true });
    return dir;
}

test("decodeMono pads a window that starts before the media", { skip: !hasFixtures }, async () => {
    const rate = 48000;
    const pad = 0.5;
    const dur = 2;
    const r = await audio.decodeMono(path.join(MEDIA, "boom.wav"), {
        startSec: -pad, durationSec: dur, sampleRate: rate, channel: null
    });
    assert.equal(r.sampleRate, rate);
    assert.equal(r.samples.length, Math.round(dur * rate));
    // Everything before the media starts must be exact silence...
    for (let i = 0; i < Math.round(pad * rate); i++) assert.equal(r.samples[i], 0, `pad sample ${i}`);
    // ...and real audio must follow it.
    let energy = 0;
    for (let i = Math.round(pad * rate); i < r.samples.length; i++) energy += r.samples[i] * r.samples[i];
    assert.ok(energy > 0, "no audio after the pad");
});

test("decodeMono pads a window that runs past the end of the media", { skip: !hasFixtures }, async () => {
    const rate = 48000;
    const r = await audio.decodeMono(path.join(MEDIA, "boom.wav"), {
        startSec: 29, durationSec: 3, sampleRate: rate, channel: null // fixtures are 30 s
    });
    assert.equal(r.samples.length, Math.round(3 * rate));
    for (let i = Math.round(1.2 * rate); i < r.samples.length; i++) {
        assert.equal(r.samples[i], 0, `tail sample ${i} should be padded silence`);
    }
});

test("runJob aligns a real fixture pair and agrees with the ground truth", { skip: !hasFixtures }, async () => {
    const out = tmpDir("mono");
    const outputPath = path.join(out, "lav1-aligned.wav").replace(/\\/g, "/");
    const job = normalizeJob({
        pairs: [{
            id: "p0",
            outputPath,
            ref: { mediaPath: path.join(MEDIA, "boom.wav"), startSec: 0, durationSec: 10 },
            target: { mediaPath: path.join(MEDIA, "lav1.wav"), startSec: 0, durationSec: 10 }
        }]
    });

    const events = [];
    const summary = await runner.runJob(job, (e) => events.push(e.event));
    assert.deepEqual(events, ["start", "phase", "phase", "phase", "result", "done"]);
    assert.equal(summary.ok, 1);
    assert.equal(summary.failed, 0);

    const r = summary.results[0];
    assert.equal(r.status, "ok", r.reason);
    // ground-truth.json: lav1 is boom delayed 18 ms drifting to 21 ms over 30 s,
    // polarity flipped. The first 10 s therefore sit at ~18-19 ms.
    assert.ok(r.staticDelayMs > 17 && r.staticDelayMs < 20,
        `staticDelayMs ${r.staticDelayMs} outside the 18-19 ms ground truth`);
    assert.equal(r.polarityInverted, true);
    assert.ok(r.nullDepthDb > 10, `nullDepthDb ${r.nullDepthDb} too shallow`);

    const written = decodeWav(nodeFs.readFileSync(outputPath));
    assert.equal(written.channels, 1);
    assert.equal(written.sampleRate, 48000);
    assert.equal(written.data[0].length, 10 * 48000);
    nodeFs.rmSync(out, { recursive: true, force: true });
});

test("a stereo target stays stereo, both channels corrected", { skip: !hasFixtures }, async () => {
    const dir = tmpDir("stereo");
    const rate = 48000;
    const boom = decodeWav(nodeFs.readFileSync(path.join(MEDIA, "boom.wav")));
    const lav = decodeWav(nodeFs.readFileSync(path.join(MEDIA, "lav2.wav")));

    // Same signal on both channels, second one attenuated: a genuine stereo
    // source whose channels must both come back corrected and in step.
    const left = lav.data[0];
    const right = Float64Array.from(left, (v) => v * 0.5);
    const stereoPath = path.join(dir, "lav2-stereo.wav").replace(/\\/g, "/");
    nodeFs.writeFileSync(stereoPath, encodeWav({ sampleRate: rate, data: [left, right] }, "pcm24"));
    stub.__clearCache();

    const outputPath = path.join(dir, "stereo-aligned.wav").replace(/\\/g, "/");
    const job = normalizeJob({
        pairs: [{
            id: "st",
            outputPath,
            ref: { mediaPath: path.join(MEDIA, "boom.wav"), startSec: 0, durationSec: 8 },
            target: { mediaPath: stereoPath, startSec: 0, durationSec: 8 }
        }]
    });
    const summary = await runner.runJob(job, () => {});
    const r = summary.results[0];
    assert.equal(r.status, "ok", r.reason);
    assert.equal(r.outputChannels, 2, "stereo source rendered as mono");

    const written = decodeWav(nodeFs.readFileSync(outputPath));
    assert.equal(written.channels, 2);
    assert.equal(written.data[0].length, 8 * rate);
    // The right channel is the left at half amplitude; the correction must have
    // been applied identically, so that ratio has to survive the render.
    let dot = 0, energy = 0;
    for (let i = 0; i < written.data[0].length; i++) {
        dot += written.data[0][i] * written.data[1][i];
        energy += written.data[0][i] * written.data[0][i];
    }
    assert.ok(Math.abs(dot / energy - 0.5) < 0.01, `channel ratio ${dot / energy} != 0.5`);

    assert.ok(boom.data[0].length > 0);
    nodeFs.rmSync(dir, { recursive: true, force: true });
});

test("a pair that cannot correlate is reported failed, not written", { skip: !hasFixtures }, async () => {
    const dir = tmpDir("noise");
    const rate = 48000;
    const noise = new Float64Array(6 * rate);
    let seed = 12345;
    for (let i = 0; i < noise.length; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        noise[i] = (seed / 0x7fffffff) * 2 - 1;
    }
    const noisePath = path.join(dir, "noise.wav").replace(/\\/g, "/");
    nodeFs.writeFileSync(noisePath, encodeWav({ sampleRate: rate, data: [noise] }, "pcm24"));
    stub.__clearCache();

    const outputPath = path.join(dir, "should-not-exist.wav").replace(/\\/g, "/");
    const job = normalizeJob({
        pairs: [{
            id: "n0",
            outputPath,
            ref: { mediaPath: path.join(MEDIA, "boom.wav"), startSec: 0, durationSec: 6 },
            target: { mediaPath: noisePath, startSec: 0, durationSec: 6 }
        }]
    });
    const summary = await runner.runJob(job, () => {});
    assert.equal(summary.failed, 1);
    assert.equal(summary.results[0].status, "failed");
    assert.ok(!nodeFs.existsSync(outputPath), "a failed pair must not leave a file behind");
    nodeFs.rmSync(dir, { recursive: true, force: true });
});

test("pickFormat follows the source bit depth unless overridden", () => {
    assert.equal(runner.pickFormat({ sampleFmt: "s16", bits: 16 }, "auto"), "pcm16");
    assert.equal(runner.pickFormat({ sampleFmt: "s32", bits: 24 }, "auto"), "pcm24");
    assert.equal(runner.pickFormat({ sampleFmt: "fltp" }, "auto"), "f32");
    assert.equal(runner.pickFormat(null, "auto"), "pcm24");
    assert.equal(runner.pickFormat({ sampleFmt: "s16", bits: 16 }, "f32"), "f32");
});

test("dirNameOf handles both slash styles", () => {
    assert.equal(runner.dirNameOf("C:/a/b/c.wav"), "C:/a/b");
    assert.equal(runner.dirNameOf("C:\\a\\b\\c.wav"), "C:/a/b");
});
