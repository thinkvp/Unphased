// Tests for the native decode core, driven through native/build/decode_smoke.exe
// (see native/tools/decode_smoke.cpp). The addon itself only runs inside
// Premiere, but the part that can silently poison an alignment is plain C++:
// sample-accurate window trimming and channel selection. Those are what this
// checks, on fixtures whose exact contents are known.
//
// Skips itself when the harness has not been built — the JS suite must stay
// runnable on a machine with no compiler.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const MEDIA = path.resolve(ROOT, "..", "testmedia");
const EXE = path.join(ROOT, "native", "build",
    process.platform === "win32" ? "decode_smoke.exe" : "decode_smoke");
const available = fs.existsSync(EXE) && fs.existsSync(path.join(MEDIA, "boom.wav"));
const opts = { skip: available ? false : "native/build/decode_smoke not built (see native/README.md)" };

const { decodeWav, encodeWav } = require("../js/engine/wav.js");

const tmp = path.join(os.tmpdir(), `unphased-decode-core-${process.pid}`);
if (available) fs.mkdirSync(tmp, { recursive: true });

function probe(file) {
    return JSON.parse(execFileSync(EXE, ["--probe", file], { encoding: "utf8" }));
}

function decode(file, { stream = 0, channel = -1, start, dur, rate = 48000 }) {
    const out = path.join(tmp, `d-${Math.abs(start * 1000)}-${channel}-${rate}.raw`);
    const meta = JSON.parse(execFileSync(EXE,
        [file, String(stream), String(channel), String(start), String(dur), String(rate), out],
        { encoding: "utf8" }));
    const buf = fs.readFileSync(out);
    return { ...meta, samples: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4) };
}

// Amplitude of a given frequency, via a Goertzel-style projection.
function toneLevel(x, freq, rate) {
    let s = 0, c = 0;
    for (let i = 0; i < x.length; i++) {
        s += x[i] * Math.sin(2 * Math.PI * freq * i / rate);
        c += x[i] * Math.cos(2 * Math.PI * freq * i / rate);
    }
    return Math.sqrt(s * s + c * c) / x.length;
}

test("probe reports the layout pairing.js expects", opts, () => {
    const r = probe(path.join(MEDIA, "boom.wav"));
    assert.equal(r.ok, true);
    assert.ok(Math.abs(r.durationSec - 30) < 0.01, `durationSec ${r.durationSec}`);
    assert.equal(r.streams.length, 1);
    const s = r.streams[0];
    assert.equal(s.index, 0);
    assert.equal(s.channels, 1);
    assert.equal(s.sampleRate, 48000);
    // The panel picks the output WAV depth from these two.
    assert.equal(s.bits, 24);
    assert.equal(s.codec, "pcm_s24le");
});

test("an uncompressed window is decoded bit-exactly at the requested sample", opts, () => {
    // The whole alignment rests on this: a decoder handed a start time will
    // otherwise return the frame that *contains* it, and that error goes
    // straight into the measured delay.
    const start = 5.0, dur = 2.0, rate = 48000;
    const got = decode(path.join(MEDIA, "boom.wav"), { start, dur, rate });
    assert.equal(got.sampleRate, rate);
    assert.equal(got.samples.length, Math.round(dur * rate));

    const src = decodeWav(fs.readFileSync(path.join(MEDIA, "boom.wav"))).data[0];
    const from = Math.round(start * rate);
    let maxErr = 0;
    for (let i = 0; i < got.samples.length; i++) {
        maxErr = Math.max(maxErr, Math.abs(got.samples[i] - src[from + i]));
    }
    assert.equal(maxErr, 0, `decode is not bit-exact (max error ${maxErr})`);

    // And prove it is not merely close: any neighbouring lag must fit far worse.
    for (const lag of [-2, -1, 1, 2]) {
        let err = 0;
        for (let i = 200; i < got.samples.length - 200; i++) {
            err = Math.max(err, Math.abs(got.samples[i] - src[from + i + lag]));
        }
        assert.ok(err > 1e-3, `lag ${lag} fits almost as well — the window may be arbitrary`);
    }
});

test("channel selection picks one channel, and -1 downmixes", opts, () => {
    // Two easily separated tones, one per channel.
    const rate = 48000, n = rate * 4;
    const L = new Float64Array(n).map((_, i) => 0.4 * Math.sin(2 * Math.PI * 440 * i / rate));
    const R = new Float64Array(n).map((_, i) => 0.4 * Math.sin(2 * Math.PI * 997 * i / rate));
    const file = path.join(tmp, "stereo.wav");
    fs.writeFileSync(file, encodeWav({ sampleRate: rate, data: [L, R] }, "pcm24"));

    const ch0 = decode(file, { channel: 0, start: 1.0, dur: 1.0, rate });
    const ch1 = decode(file, { channel: 1, start: 1.0, dur: 1.0, rate });
    const mix = decode(file, { channel: -1, start: 1.0, dur: 1.0, rate });

    assert.ok(toneLevel(ch0.samples, 440, rate) > 0.15, "channel 0 lost its own tone");
    assert.ok(toneLevel(ch0.samples, 997, rate) < 0.01, "channel 0 leaked the other channel");
    assert.ok(toneLevel(ch1.samples, 997, rate) > 0.15, "channel 1 lost its own tone");
    assert.ok(toneLevel(ch1.samples, 440, rate) < 0.01, "channel 1 leaked the other channel");
    // A downmix must contain both — this is exactly why the panel refuses to
    // downmix a file whose channels are two different mics.
    assert.ok(toneLevel(mix.samples, 440, rate) > 0.1 && toneLevel(mix.samples, 997, rate) > 0.1,
        "downmix dropped a channel");
});

test("sampleRate 0 keeps the source's own rate", opts, () => {
    const rate = 96000, n = rate * 2;
    const x = new Float64Array(n).map((_, i) => 0.3 * Math.sin(2 * Math.PI * 1000 * i / rate));
    const file = path.join(tmp, "hi.wav");
    fs.writeFileSync(file, encodeWav({ sampleRate: rate, data: [x] }, "pcm24"));

    const got = decode(file, { start: 0.5, dur: 1.0, rate: 0 });
    assert.equal(got.sampleRate, 96000, "a 96 kHz source must render at 96 kHz");
    assert.equal(got.samples.length, 96000);
});

test("a window past the end of the file returns what exists, not garbage", opts, () => {
    // js/audio.js pads the rest — the core must simply stop, as `apad` did.
    const got = decode(path.join(MEDIA, "boom.wav"), { start: 29.0, dur: 3.0, rate: 48000 });
    assert.ok(got.samples.length > 0.9 * 48000, "lost the last second of the file");
    assert.ok(got.samples.length <= 3 * 48000);
});

test.after(() => { if (available) fs.rmSync(tmp, { recursive: true, force: true }); });
