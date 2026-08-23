import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kWeightCoeffs, kWeight, loudnessLufs, gatedLufs, KWEIGHT_MIN_HZ,
} from '../src/loudness.js';
import { decimate } from '../src/decimate.js';
import { speechLike, mulberry32 } from './fixtures.js';

/** Mean square of a K-weighted signal, skipping the filter's settling time. */
function measure(x, fs, skipSec = 1) {
  const y = kWeight(x, fs, new Float64Array(x.length));
  const from = Math.min(y.length - 1, Math.round(skipSec * fs));
  let sum = 0;
  for (let i = from; i < y.length; i++) sum += y[i] * y[i];
  return loudnessLufs(sum / (y.length - from));
}

function sine(hz, fs, seconds, amp = 1) {
  const n = Math.round(seconds * fs);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / fs);
  return x;
}

test('the 48 kHz design reproduces the coefficients BS.1770 tabulates', () => {
  // The standard prints its biquads at 48 kHz only. Everything else here is a
  // redesign from the analog prototype, and the only way to know the prototype
  // is right is that it lands back on the published numbers exactly.
  const { shelf, hp } = kWeightCoeffs(48000);
  const wantShelf = [
    1.53512485958697, -2.69169618940638, 1.19839281085285,
    -1.69065929318241, 0.73248077421585,
  ];
  const wantHp = [1, -2, 1, -1.99004745483398, 0.99007225036621];
  for (let i = 0; i < 5; i++) {
    assert.ok(Math.abs(shelf[i] - wantShelf[i]) < 1e-12,
      `shelf[${i}] ${shelf[i]} != ${wantShelf[i]}`);
    assert.ok(Math.abs(hp[i] - wantHp[i]) < 1e-12, `hp[${i}] ${hp[i]} != ${wantHp[i]}`);
  }
});

test('a full-scale 997 Hz sine measures -3.01 LUFS', () => {
  // BS.1770's reference point, restated for one channel at weight 1: a
  // full-scale sine has a mean square of 0.5, the K-weighting gain at 997 Hz is
  // +0.691 dB, and the -0.691 offset exists to cancel exactly that.
  const got = measure(sine(997, 48000, 5), 48000);
  assert.ok(Math.abs(got - (-3.01)) < 0.02, `got ${got.toFixed(3)} LUFS`);
});

test('the redesign holds at the rate attribution actually runs at', () => {
  // auto-mix measures on a signal decimated to 8 kHz. If the 48 kHz
  // coefficients were used there — the obvious shortcut — the shelf corner
  // would land at six times its frequency and this would be several LU out.
  for (const fs of [8000, 16000, 44100, 48000, 96000]) {
    const got = measure(sine(997, fs, 5), fs);
    assert.ok(Math.abs(got - (-3.01)) < 0.1, `${fs} Hz: ${got.toFixed(3)} LUFS`);
  }
  assert.throws(() => kWeightCoeffs(2 * KWEIGHT_MIN_HZ), /too low/);
});

test('K-weighting has the shape it is supposed to: LF cut, HF shelf', () => {
  const fs = 48000;
  const at = (hz) => measure(sine(hz, fs, 4), fs);
  const ref = at(997);
  // The RLB high-pass is well down at 40 Hz and gone at 20.
  assert.ok(at(40) - ref < -4, `40 Hz only ${(at(40) - ref).toFixed(1)} dB down`);
  assert.ok(at(20) - ref < -12, `20 Hz only ${(at(20) - ref).toFixed(1)} dB down`);
  // ...and the shelf is at its full +4 dB (relative to the LF passband, so
  // ~+3.3 dB relative to 997 Hz, which is already partway up it) by 4 kHz.
  const shelfTop = at(6000) - at(300);
  assert.ok(Math.abs(shelfTop - 4) < 0.3, `shelf reached ${shelfTop.toFixed(2)} dB, want ~4`);
});

test('loudness is a level measurement: scaling the signal moves it exactly', () => {
  // The one property everything downstream relies on — matchGainDb is computed
  // as (target - measured) and applied as a gain, which is only correct if the
  // measurement is linear in dB.
  const x = speechLike({ seconds: 6, sampleRate: 16000, seed: 9 }).signal;
  const base = measure(x, 16000);
  for (const db of [-18, -6, 6]) {
    const g = Math.pow(10, db / 20);
    const scaled = Float64Array.from(x, (v) => v * g);
    const got = measure(scaled, 16000);
    assert.ok(Math.abs((got - base) - db) < 0.01,
      `${db} dB of gain moved the measurement ${(got - base).toFixed(3)} LU`);
  }
});

test('decimating to the attribution rate reads about half a LU low, consistently', () => {
  // The honest cost of measuring on the decimated copy that attribution already
  // has: the anti-alias filter takes the top of the speech band with it, and
  // K-weighting lifts that band by 4 dB so it counts for more than it would in
  // plain RMS.
  //
  // The number that matters is not the size of the error but its CONSISTENCY.
  // A bias of the same sign and roughly the same size on every mic shifts the
  // whole delivery by a fraction of a LU and moves no mic relative to another;
  // a per-track error would defeat the point of matching them at all. So this
  // asserts the spread across very different material, not just the magnitude.
  const deltas = [];
  for (const seed of [3, 17, 42]) {
    const full = speechLike({ seconds: 8, sampleRate: 48000, seed }).signal;
    // ...and again with sibilance on top, which is the case that should suffer
    // most: energy the decimated copy cannot see, in the band K-weighting
    // boosts. If the bias survives this it survives real voices.
    const rand = mulberry32(seed + 900);
    const hiss = new Float64Array(full.length);
    let p = 0;
    let q = 0;
    for (let i = 0; i < hiss.length; i++) {
      const v = rand() * 2 - 1;
      const d = v - p;
      p = v;
      hiss[i] = d - q;
      q = d;
    }
    let peak = 0;
    for (const v of hiss) peak = Math.max(peak, Math.abs(v));
    const sibilant = Float64Array.from(full,
      (v, i) => v + (hiss[i] / peak) * 0.1 * Math.min(1, Math.abs(v) * 6));

    for (const x of [full, sibilant]) {
      deltas.push(measure(decimate(x, 6), 8000) - measure(x, 48000));
    }
  }
  for (const d of deltas) {
    assert.ok(d < 0 && d > -0.7, `decimation moved loudness ${d.toFixed(3)} LU`);
  }
  const spread = Math.max(...deltas) - Math.min(...deltas);
  assert.ok(spread < 0.35,
    `the bias varies by ${spread.toFixed(3)} LU between takes — that is an error, not an offset`);
});

test('gating keeps pauses and stray quiet frames from deciding the answer', () => {
  // Half speech at one level, half near-silence. Ungated, the mean square is
  // dragged down; BS.1770's relative gate is what stops that.
  const nFrames = 400;
  const frameMs = new Float64Array(nFrames);
  const loud = Math.pow(10, -20 / 10);
  for (let f = 0; f < nFrames; f++) frameMs[f] = f % 2 ? loud : loud * 1e-4;
  const all = [];
  for (let f = 0; f < nFrames; f++) all.push(f);

  const gated = gatedLufs(frameMs, all);
  const speechOnly = gatedLufs(frameMs, all.filter((f) => f % 2));
  assert.ok(Math.abs(gated - speechOnly) < 0.01,
    `gating left ${(gated - speechOnly).toFixed(2)} LU of silence in the answer`);

  // Absolute gate: nothing but silence has no loudness to report.
  const silence = new Float64Array(10).fill(1e-12);
  assert.equal(gatedLufs(silence, [0, 1, 2]), -Infinity);
  assert.equal(gatedLufs(frameMs, []), -Infinity);
});

test('a steady signal survives the relative gate rather than gating itself away', () => {
  // Every frame sits exactly at the mean, so a naive strict comparison against
  // (mean - 10 LU) is fine but an off-by-one in the fallback is not: the
  // measurement must not come back as silence.
  const frameMs = new Float64Array(50).fill(Math.pow(10, -23 / 10));
  const frames = [];
  for (let f = 0; f < 50; f++) frames.push(f);
  const got = gatedLufs(frameMs, frames);
  assert.ok(Math.abs(got - (-23.691)) < 0.01, `steady signal measured ${got}`);
});

test('gatedLufs measures only the frames it is given', () => {
  // The whole reason for taking a frame list rather than gating by level: on a
  // lav track the loudest thing can be somebody else's voice, and measuring it
  // would turn the quiet participant DOWN.
  const rand = mulberry32(5);
  const nFrames = 600;
  const frameMs = new Float64Array(nFrames);
  const own = [];
  for (let f = 0; f < nFrames; f++) {
    // A third of the take is this mic's owner at -30 LUFS; the rest is somebody
    // else bleeding in 12 dB louder.
    const mine = f % 3 === 0;
    const base = mine ? Math.pow(10, -30 / 10) : Math.pow(10, -18 / 10);
    frameMs[f] = base * (0.8 + 0.4 * rand());
    if (mine) own.push(f);
  }
  const mineOnly = gatedLufs(frameMs, own);
  const everything = gatedLufs(frameMs, Array.from(frameMs.keys()));
  assert.ok(Math.abs(mineOnly - (-30.691)) < 0.6,
    `own speech measured ${mineOnly.toFixed(2)}, want about -30.7`);
  assert.ok(everything - mineOnly > 9,
    `measuring the whole track should read far louder, got ${(everything - mineOnly).toFixed(1)} LU`);
});
