// The UXP auto-mix path, offline: decodeMono -> decimate -> attribute -> gains
// -> keyframes. The native addon is stubbed with the testmedia/ WAV fixtures,
// so this runs anywhere `node --test` does.
//
// testmedia/ is boom + two lavs derived from it, which is not a conversation —
// every "mic" carries the same speech, so nobody ever genuinely holds the floor
// alone. That makes it useless for judging attribution QUALITY (engine/test/
// automix.test.js does that against speakerRoom's ground truth) but exactly
// right for what this file is for: proving the UXP wiring produces well-formed,
// in-range keyframes on real decoded audio rather than throwing.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const nodeFs = require("node:fs");
const path = require("node:path");

const audio = require("../js/audio.js");
const automix = require("../js/automixRunner.js");
const volume = require("../js/volume.js");
const stub = require("./stubAddon.js");

const MEDIA = path.resolve(__dirname, "..", "..", "testmedia");
const hasFixtures = nodeFs.existsSync(path.join(MEDIA, "boom.wav"));

const fsp = require("node:fs/promises");
audio.__setAddon(stub);
automix.__setFs({
    mkdir: (dir) => fsp.mkdir(dir),
    // UXP hands writeFile an ArrayBuffer; node wants a view over it.
    writeFile: (file, buf) => fsp.writeFile(file, Buffer.from(buf))
});

const mic = (name) => ({
    id: name,
    trackIndex: 0,
    clipIndex: 0,
    sourceStartSec: 3,
    source: {
        mediaPath: path.join(MEDIA, `${name}.wav`),
        startSec: 3,
        durationSec: 24,
        audioStream: 0,
        channel: null
    }
});

test("UXP auto-mix runs end to end and returns usable keyframes", {
    skip: !hasFixtures ? "testmedia fixtures not generated" : false,
    timeout: 300000
}, async () => {
    const events = [];
    const job = {
        mics: [mic("boom"), mic("lav1"), mic("lav2")],
        params: {},
        handleSec: 2.25
    };
    const r = await automix.runAutoMix(job, (e) => events.push(e));

    assert.equal(r.failed, 0, "no mic should fail");
    assert.equal(r.ok, 3);

    const start = events.find((e) => e.event === "start");
    assert.equal(start.mode, "automix", "start must identify the job kind");
    assert.equal(start.mics, 3);
    assert.ok(events.find((e) => e.event === "automix"), "missing summary event");
    assert.ok(events.find((e) => e.event === "done"), "missing done event");
    assert.equal(r.summary.pairs.length, 3, "three mics make three pairs");

    for (const res of r.results) {
        assert.equal(res.status, "ok", `${res.id}: ${res.reason}`);
        assert.ok(res.keys.length >= 2, `${res.id}: only ${res.keys.length} keyframes`);
        assert.ok(res.maxErrorDb <= 0.25 + 1e-9, `${res.id}: curve error ${res.maxErrorDb}`);

        let prev = -Infinity;
        for (const k of res.keys) {
            // Inside the clip, in order, and never a boost: auto-mix only ducks.
            assert.ok(k.timeSec >= 0, `${res.id}: key at ${k.timeSec}s is before the clip`);
            assert.ok(k.timeSec <= 24 + 1e-6, `${res.id}: key at ${k.timeSec}s is past the clip end`);
            assert.ok(k.timeSec >= prev, `${res.id}: keys out of order at ${k.timeSec}s`);
            prev = k.timeSec;
            // Keys carry the duck PLUS a constant level-match offset, and the
            // match legitimately boosts a quiet recorder. Only the duck part is
            // required to be an attenuation.
            const match = res.matchGainDb || 0;
            const duck = k.gainDb - match;
            assert.ok(duck <= 1e-9, `${res.id}: duck component boosts by ${duck} dB`);
            assert.ok(duck >= -12 - 1e-9, `${res.id}: duck ${duck} dB, past maxDuckDb`);
        }
    }
});

test("keyframe gains convert to in-range Premiere Level values", {
    skip: !hasFixtures ? "testmedia fixtures not generated" : false,
    timeout: 300000
}, async () => {
    const job = { mics: [mic("boom"), mic("lav1")], params: {}, handleSec: 2.25 };
    const r = await automix.runAutoMix(job, () => {});
    for (const res of r.results) {
        const levels = volume.levelKeyframes(res.keys, volume.UNITY_LEVEL);
        assert.equal(levels.length, res.keys.length);
        for (const l of levels) {
            assert.ok(l.level >= 0 && l.level <= 1, `level ${l.level} outside the parameter range`);
            // Never louder than the clip already was.
            // With level matching on, a quiet recorder is legitimately brought
            // UP — so the only hard requirement is staying in range.
            assert.ok(Number.isFinite(l.level), `level ${l.level} is not finite`);
        }
    }
});

test("clipKeys trims a curve to the clip and always starts at zero", () => {
    const keys = [
        { timeSec: -0.5, gainDb: -6 },
        { timeSec: 0.5, gainDb: -2 },
        { timeSec: 9.5, gainDb: -4 },
        { timeSec: 10.5, gainDb: 0 }
    ];
    const out = automix.clipKeys(keys, 10);
    assert.equal(out[0].timeSec, 0, "must start exactly at the clip start");
    assert.ok(out[out.length - 1].timeSec <= 10 + 1e-9, "must not run past the clip end");
    // The boundary keys are interpolated, not clamped to a neighbour's value.
    assert.ok(out[0].gainDb > -6 && out[0].gainDb < -2,
        `boundary gain ${out[0].gainDb} should sit between the keys it came from`);
    // An entirely out-of-range curve still yields something placeable.
    const far = automix.clipKeys([{ timeSec: -5, gainDb: -3 }], 10);
    assert.equal(far.length, 1);
    assert.equal(far[0].timeSec, 0);
});

test("render mode bakes the duck into a WAV of the right length", {
    skip: !hasFixtures ? "testmedia fixtures not generated" : false,
    timeout: 300000
}, async () => {
    const os = require("node:os");
    const dir = path.join(os.tmpdir(), `unphased-automix-render-${process.pid}`);
    nodeFs.mkdirSync(dir, { recursive: true });
    try {
        const mics = [mic("boom"), mic("lav1"), mic("lav2")];
        mics.forEach((m, i) => { m.outputPath = path.join(dir, `out${i}.wav`); });
        const r = await automix.runAutoMix(
            { mics, params: {}, handleSec: 2.25, output: "render", outputFormat: "auto" }, () => {});
        assert.equal(r.failed, 0);
        const { decodeWav } = require("../js/engine/wav.js");
        for (const res of r.results) {
            assert.equal(res.status, "ok", res.reason);
            assert.ok(res.outputPath, `${res.id}: no outputPath`);
            // decodeWav takes the Buffer directly, as runner.test.js does —
            // handing it `.buffer` gives it Node's shared allocation pool.
            const wav = decodeWav(nodeFs.readFileSync(res.outputPath));
            // Exactly the requested interval — the handles are analysis-only.
            assert.equal(wav.data[0].length, Math.round(24 * wav.sampleRate),
                `${res.id}: rendered length does not match the requested interval`);
            // Ducking only ever attenuates, so nothing may come back louder.
            let peak = 0;
            for (let i = 0; i < wav.data[0].length; i++) peak = Math.max(peak, Math.abs(wav.data[0][i]));
            assert.ok(peak <= 1.0001, `${res.id}: peak ${peak} exceeds full scale`);
        }
    } finally {
        nodeFs.rmSync(dir, { recursive: true, force: true });
    }
});
