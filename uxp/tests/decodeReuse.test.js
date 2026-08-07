// The shared reference decode: a take's lavs all point at the same boom
// region, and decoding it once per pair was pure waste. Counts calls into the
// addon rather than timing anything, so it fails loudly if the reuse silently
// stops working.
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

const MEDIA = path.resolve(__dirname, "..", "..", "testmedia");
const hasFixtures = nodeFs.existsSync(path.join(MEDIA, "boom.wav"));

// Wrap the stub so every decode is recorded. Same object shape, so audio.js
// cannot tell the difference.
const decodeLog = [];
audio.__setAddon({
    probe: (p) => stub.probe(p),
    decode: (p, streamIndex, channel, startSec, durationSec, sampleRate) => {
        decodeLog.push(`${path.basename(p)}@${startSec}+${durationSec}`);
        return stub.decode(p, streamIndex, channel, startSec, durationSec, sampleRate);
    }
});
runner.__setFs({
    mkdir: (dir) => fsp.mkdir(dir),
    writeFile: (file, buf) => fsp.writeFile(file, Buffer.from(buf))
});

test("a shared reference region is decoded once, not once per pair", { skip: !hasFixtures, timeout: 300000 }, async () => {
    const outDir = path.join(os.tmpdir(), `unphased-reuse-${process.pid}`);
    nodeFs.mkdirSync(outDir, { recursive: true });
    try {
        const ref = { mediaPath: path.join(MEDIA, "boom.wav"), startSec: 0, durationSec: 30 };
        const job = normalizeJob({
            sampleRate: 48000,
            preserveSourceFormat: false, // keep the render off the decode log
            params: { mode: "static", phase: "off" },
            pairs: ["lav1", "lav2"].map((name) => ({
                id: name,
                ref: Object.assign({}, ref),
                target: { mediaPath: path.join(MEDIA, `${name}.wav`), startSec: 0, durationSec: 30 },
                outputPath: path.join(outDir, `${name}.wav`)
            }))
        });

        decodeLog.length = 0;
        const r = await runner.runJob(job, () => {});
        assert.equal(r.failed, 0, "both pairs should align");
        assert.equal(r.ok, 2);

        const refDecodes = decodeLog.filter((d) => d.startsWith("boom.wav@"));
        assert.equal(refDecodes.length, 1,
            `reference decoded ${refDecodes.length} times: ${decodeLog.join(", ")}`);
        // ...while each target is still decoded on its own.
        assert.equal(decodeLog.filter((d) => d.startsWith("lav1.wav@")).length, 1);
        assert.equal(decodeLog.filter((d) => d.startsWith("lav2.wav@")).length, 1);
    } finally {
        nodeFs.rmSync(outDir, { recursive: true, force: true });
    }
});

test("a different reference region is not served from the previous one", { skip: !hasFixtures, timeout: 300000 }, async () => {
    const outDir = path.join(os.tmpdir(), `unphased-reuse2-${process.pid}`);
    nodeFs.mkdirSync(outDir, { recursive: true });
    try {
        const boom = path.join(MEDIA, "boom.wav");
        const job = normalizeJob({
            sampleRate: 48000,
            preserveSourceFormat: false,
            params: { mode: "static", phase: "off" },
            pairs: [
                {
                    id: "a",
                    ref: { mediaPath: boom, startSec: 0, durationSec: 20 },
                    target: { mediaPath: path.join(MEDIA, "lav1.wav"), startSec: 0, durationSec: 20 },
                    outputPath: path.join(outDir, "a.wav")
                },
                {
                    id: "b",
                    // same file, different span — must not reuse pair a's decode
                    ref: { mediaPath: boom, startSec: 5, durationSec: 20 },
                    target: { mediaPath: path.join(MEDIA, "lav1.wav"), startSec: 5, durationSec: 20 },
                    outputPath: path.join(outDir, "b.wav")
                }
            ]
        });

        decodeLog.length = 0;
        await runner.runJob(job, () => {});
        assert.equal(decodeLog.filter((d) => d.startsWith("boom.wav@")).length, 2,
            `distinct regions must decode separately: ${decodeLog.join(", ")}`);
    } finally {
        nodeFs.rmSync(outDir, { recursive: true, force: true });
    }
});
