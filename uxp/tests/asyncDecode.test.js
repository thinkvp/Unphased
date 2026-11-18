// Background decoding (the addon's decodeAsync pool) and the memory budget that
// limits how much is decoded ahead. The addon is the WAV stub wrapped in a
// promise that resolves on a later tick, like the real pool, which posts each
// result back to the scripting thread when its worker finishes.
//
// What matters most: the background path must write exactly the bytes the
// synchronous path writes, never decode anything twice, and never hold more
// decoded-ahead audio than the budget allows.
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
const skip = !hasFixtures;

// UXP has localStorage; node's test process does not, so give audio.js one.
const store = {};
global.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
};

runner.__setFs({
    mkdir: (dir) => fsp.mkdir(dir),
    writeFile: (file, buf) => fsp.writeFile(file, Buffer.from(buf))
});

// ─── Stub addons ──────────────────────────────────────────────────────────────
const calls = { sync: 0, async: 0, inFlight: 0, maxInFlight: 0, maxPrefetchBytes: 0 };
function resetCalls() {
    calls.sync = 0; calls.async = 0; calls.inFlight = 0; calls.maxInFlight = 0; calls.maxPrefetchBytes = 0;
}

const syncAddon = {
    probe: (p) => stub.probe(p),
    decode: (...args) => { calls.sync++; return stub.decode(...args); }
};

const asyncAddon = {
    probe: (p) => stub.probe(p),
    decode: (...args) => { calls.sync++; return stub.decode(...args); },
    decodeAsync: (...args) => {
        calls.async++;
        calls.inFlight++;
        calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
        calls.maxPrefetchBytes = Math.max(calls.maxPrefetchBytes, audio.prefetchState().bytes);
        return new Promise((resolve, reject) => setTimeout(() => {
            calls.inFlight--;
            try { resolve(stub.decode(...args)); } catch (e) { reject(e); }
        }, 5));
    },
    decodeThreads: () => 3,
    cpuCount: () => 8
};

function tmpDir(tag) {
    const dir = path.join(os.tmpdir(), `unphased-async-${tag}-${process.pid}`);
    nodeFs.mkdirSync(dir, { recursive: true });
    return dir;
}

// Settle anything still decoding in the background (the stub takes 5 ms).
const settle = () => new Promise((r) => setTimeout(r, 50));

// A job like a real take: three lavs against one boom, one of them stereo, so
// it exercises the shared reference, decoding the next pair ahead, and
// per-channel render decodes.
function buildJob(dir, tag) {
    const lav = decodeWav(nodeFs.readFileSync(path.join(MEDIA, "lav2.wav")));
    const stereoPath = path.join(dir, "lav2-stereo.wav").replace(/\\/g, "/");
    if (!nodeFs.existsSync(stereoPath)) {
        const right = Float64Array.from(lav.data[0], (v) => v * 0.5);
        nodeFs.writeFileSync(stereoPath, encodeWav({ sampleRate: 48000, data: [lav.data[0], right] }, "pcm24"));
    }
    const ref = { mediaPath: path.join(MEDIA, "boom.wav"), startSec: 2, durationSec: 20 };
    const targets = [
        ["lav1", path.join(MEDIA, "lav1.wav")],
        ["lav2", path.join(MEDIA, "lav2.wav")],
        ["stereo", stereoPath]
    ];
    return normalizeJob({
        sampleRate: 48000,
        params: { mode: "dynamic" },
        pairs: targets.map(([id, mediaPath]) => ({
            id,
            ref: Object.assign({}, ref),
            target: { mediaPath, startSec: 2, durationSec: 20 },
            outputPath: path.join(dir, `${tag}-${id}.wav`).replace(/\\/g, "/")
        }))
    });
}

async function runWith(addon, dir, tag) {
    audio.__setAddon(addon);
    stub.__clearCache();
    resetCalls();
    audio.resetDecodeStats();
    const job = buildJob(dir, tag);
    const summary = await runner.runJob(job, () => {});
    await settle();
    return { summary, job, stats: audio.getDecodeStats() };
}

function assertSameOutputs(a, b) {
    assert.equal(a.summary.ok, b.summary.ok);
    for (let i = 0; i < a.job.pairs.length; i++) {
        const ra = a.summary.results[i];
        const rb = b.summary.results[i];
        assert.equal(ra.status, rb.status, `${ra.id}: status`);
        assert.equal(ra.staticDelayMs, rb.staticDelayMs, `${ra.id}: delay`);
        const fa = nodeFs.readFileSync(a.job.pairs[i].outputPath);
        const fb = nodeFs.readFileSync(b.job.pairs[i].outputPath);
        assert.ok(fa.equals(fb), `${ra.id}: rendered WAV differs between the two paths`);
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────
test("background decoding writes byte-identical files and decodes nothing twice", { skip, timeout: 300000 }, async () => {
    const dir = tmpDir("same");
    try {
        const sync = await runWith(syncAddon, dir, "sync");
        assert.equal(sync.summary.ok, 3, JSON.stringify(sync.summary.results));
        const syncDecodes = calls.sync;

        const bg = await runWith(asyncAddon, dir, "bg");
        assertSameOutputs(sync, bg);
        assert.equal(calls.sync, 0, "the synchronous decode must not run when the pool is available");
        assert.equal(calls.async, syncDecodes, "background path decoded a different number of regions");
        assert.ok(bg.stats.prefetched > 0, "nothing was decoded ahead");
        assert.ok(calls.maxInFlight >= 2, "decodes never overlapped");
        assert.deepEqual(audio.prefetchState().bytes, 0, "decoded-ahead audio left accounted for after the run");
        assert.equal(audio.prefetchState().pending, 0);
    } finally {
        delete store["unphased-decode-budget-mb"];
        nodeFs.rmSync(dir, { recursive: true, force: true });
    }
});

test("decoded-ahead audio never exceeds the memory budget", { skip, timeout: 300000 }, async () => {
    const dir = tmpDir("budget");
    try {
        const sync = await runWith(syncAddon, dir, "sync");
        // A 24.5 s target window at 48 kHz is ~9 MB counted at 8 bytes a sample:
        // a 10 MB budget fits one decode ahead at a time, never two.
        store["unphased-decode-budget-mb"] = "10";
        const bg = await runWith(asyncAddon, dir, "bg");
        assertSameOutputs(sync, bg);
        assert.ok(bg.stats.prefetched > 0, "a region inside the budget should still be decoded ahead");
        assert.ok(calls.maxPrefetchBytes <= 10 * 1024 * 1024,
            `held ${calls.maxPrefetchBytes} bytes ahead against a 10 MB budget`);
        assert.equal(audio.prefetchState().bytes, 0);
    } finally {
        delete store["unphased-decode-budget-mb"];
        nodeFs.rmSync(dir, { recursive: true, force: true });
    }
});

test("a budget of 0 decodes nothing ahead, and the output is unchanged", { skip, timeout: 300000 }, async () => {
    const dir = tmpDir("zero");
    try {
        const sync = await runWith(syncAddon, dir, "sync");
        store["unphased-decode-budget-mb"] = "0";
        const bg = await runWith(asyncAddon, dir, "bg");
        assertSameOutputs(sync, bg);
        assert.equal(bg.stats.prefetched, 0);
        assert.equal(calls.maxInFlight, 1, "with no budget, decodes run one at a time");
    } finally {
        delete store["unphased-decode-budget-mb"];
        nodeFs.rmSync(dir, { recursive: true, force: true });
    }
});

test("the \"sync\" switch keeps decoding off the background pool", { skip, timeout: 300000 }, async () => {
    const dir = tmpDir("switch");
    try {
        store["unphased-decode"] = "sync";
        const bg = await runWith(asyncAddon, dir, "bg");
        assert.equal(bg.summary.ok, 3);
        assert.equal(calls.async, 0);
        assert.ok(calls.sync > 0);
        assert.equal(audio.decodeConcurrency(), 1);
    } finally {
        delete store["unphased-decode"];
        nodeFs.rmSync(dir, { recursive: true, force: true });
    }
});

test("decodeConcurrency and cpuCount come from the addon", () => {
    audio.__setAddon(asyncAddon);
    assert.equal(audio.decodeConcurrency(), 3);
    assert.equal(audio.cpuCount(), 8);
    audio.__setAddon(syncAddon);
    assert.equal(audio.decodeConcurrency(), 1);
    assert.equal(audio.cpuCount(), null);
});

test("a decoded-ahead region is padded exactly like a direct decode", { skip }, async () => {
    const boom = path.join(MEDIA, "boom.wav");
    const cases = [
        { startSec: -0.5, durationSec: 3 },   // reaches before the media
        { startSec: 28.5, durationSec: 3 },   // runs past its end
        { startSec: 1.234567, durationSec: 2, channel: 0 }
    ];
    for (const c of cases) {
        audio.__setAddon(syncAddon);
        const direct = await audio.decodeMono(boom, c);
        audio.__setAddon(asyncAddon);
        assert.equal(audio.prefetch(boom, c), true);
        const ahead = await audio.decodeMono(boom, c);
        assert.equal(ahead.sampleRate, direct.sampleRate);
        assert.equal(ahead.samples.length, direct.samples.length);
        assert.ok(Buffer.from(ahead.samples.buffer).equals(Buffer.from(direct.samples.buffer)),
            `samples differ for ${JSON.stringify(c)}`);
        assert.equal(audio.prefetchState().bytes, 0);
    }
});

test("a decode error surfaces when the region is asked for, and its budget is returned", { skip }, async () => {
    audio.__setAddon(asyncAddon);
    const missing = path.join(MEDIA, "does-not-exist.wav");
    assert.equal(audio.prefetch(missing, { startSec: 0, durationSec: 2 }), true);
    await assert.rejects(audio.decodeMono(missing, { startSec: 0, durationSec: 2 }), /ENOENT|no such file/i);
    assert.equal(audio.prefetchState().bytes, 0);
    assert.equal(audio.prefetchState().pending, 0);
});

test("dropped and cleared prefetches give their budget back once they finish", { skip }, async () => {
    audio.__setAddon(asyncAddon);
    const boom = path.join(MEDIA, "boom.wav");
    audio.prefetch(boom, { startSec: 0, durationSec: 2 });
    audio.prefetch(boom, { startSec: 5, durationSec: 2 });
    assert.ok(audio.prefetchState().bytes > 0);
    audio.dropPrefetch(boom, { startSec: 0, durationSec: 2 });
    audio.clearPrefetch();
    assert.equal(audio.prefetchState().pending, 0);
    await settle();
    assert.equal(audio.prefetchState().bytes, 0);
});

test("a failed pair releases the render audio decoded ahead for it", { skip, timeout: 300000 }, async () => {
    const dir = tmpDir("fail");
    try {
        // Stereo noise: cannot correlate, and would have needed two render decodes.
        const rate = 48000;
        const noise = new Float64Array(8 * rate);
        let seed = 12345;
        for (let i = 0; i < noise.length; i++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            noise[i] = (seed / 0x7fffffff) * 2 - 1;
        }
        const noisePath = path.join(dir, "noise.wav").replace(/\\/g, "/");
        nodeFs.writeFileSync(noisePath, encodeWav({ sampleRate: rate, data: [noise, noise] }, "pcm24"));
        audio.__setAddon(asyncAddon);
        stub.__clearCache();
        resetCalls();
        const job = normalizeJob({
            pairs: [{
                id: "n0",
                outputPath: path.join(dir, "n0.wav").replace(/\\/g, "/"),
                ref: { mediaPath: path.join(MEDIA, "boom.wav"), startSec: 0, durationSec: 6 },
                target: { mediaPath: noisePath, startSec: 0, durationSec: 6 }
            }]
        });
        const summary = await runner.runJob(job, () => {});
        assert.equal(summary.failed, 1);
        await settle();
        assert.equal(audio.prefetchState().bytes, 0);
        assert.equal(audio.prefetchState().pending, 0);
    } finally {
        nodeFs.rmSync(dir, { recursive: true, force: true });
    }
});

