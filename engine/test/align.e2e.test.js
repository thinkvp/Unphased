import test from 'node:test';
import assert from 'node:assert/strict';
import { alignPair, nullDepthDb, windowedNullDepthDb } from '../src/align.js';
import { speechLike, fftDelay, addNoise, scale, mulberry32 } from './fixtures.js';

test('static align: clean fractional delay -> deep null', () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 20, seed: 21 });
  const delayMs = 23.7;
  const D = (delayMs / 1000) * sampleRate;
  const tgt = fftDelay(ref, D);
  const r = alignPair({ ref, tgt, sampleRate, params: { mode: 'static', maxShiftMs: 100 } });
  assert.equal(r.status, 'ok');
  assert.ok(Math.abs(r.report.staticDelayMs - delayMs) < 0.1, `delay ${r.report.staticDelayMs}`);
  assert.equal(r.report.polarityInverted, false);
  assert.ok(r.report.nullDepthDb >= 20, `null depth ${r.report.nullDepthDb} dB`);
});

test('static align: polarity flip + level offset + noise', () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 20, seed: 22 });
  const delayMs = -8.3; // target LEADS reference
  const D = (delayMs / 1000) * sampleRate;
  let tgt = fftDelay(ref, D);
  tgt = scale(tgt, -6);
  for (let i = 0; i < tgt.length; i++) tgt[i] = -tgt[i];
  tgt = addNoise(tgt, 25, 202);
  const r = alignPair({ ref, tgt, sampleRate, params: { mode: 'static', maxShiftMs: 100 } });
  assert.equal(r.status, 'ok');
  assert.ok(Math.abs(r.report.staticDelayMs - delayMs) < 0.1, `delay ${r.report.staticDelayMs}`);
  assert.equal(r.report.polarityInverted, true);
});

test('static align: polarity detection correct at 15 dB SNR', () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 20, seed: 23 });
  const D = 0.012 * sampleRate;
  let tgt = fftDelay(ref, D);
  for (let i = 0; i < tgt.length; i++) tgt[i] = -tgt[i];
  tgt = addNoise(tgt, 15, 203);
  const r = alignPair({ ref, tgt, sampleRate, params: { mode: 'static', maxShiftMs: 100 } });
  assert.equal(r.report.polarityInverted, true);
});

test('uncorrelated pair reports failed, does not fabricate output', () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 10, seed: 24 });
  const { signal: other } = speechLike({ seconds: 10, seed: 1024 });
  const r = alignPair({ ref, tgt: other, sampleRate, params: { mode: 'static' } });
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'no-correlation');
  assert.equal(r.aligned, undefined);
});

test('nullDepthDb: identical signals null perfectly, unrelated do not', () => {
  const { signal: a } = speechLike({ seconds: 5, seed: 25 });
  const { signal: b } = speechLike({ seconds: 5, seed: 26 });
  assert.ok(nullDepthDb(a, a) > 100);
  assert.ok(nullDepthDb(a, b) < 3);
});

test('nullDepthDb reports a polarity-inverted signal as a bad null', () => {
  const { signal: a } = speechLike({ seconds: 5, seed: 27 });
  const inverted = a.map((v) => -v);
  // an unclamped optimal gain would score this as a perfect null
  assert.ok(nullDepthDb(a, inverted) < 1, `inverted scored ${nullDepthDb(a, inverted)} dB`);
});

test('polarity correction is what earns the null on an inverted pair', () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 20, seed: 28 });
  let tgt = fftDelay(ref, 0.009 * sampleRate);
  for (let i = 0; i < tgt.length; i++) tgt[i] = -tgt[i];
  const on = alignPair({ ref, tgt, sampleRate, params: { mode: 'static', maxShiftMs: 100, phase: 'off', polarity: 'auto' } });
  const off = alignPair({ ref, tgt, sampleRate, params: { mode: 'static', maxShiftMs: 100, phase: 'off', polarity: 'off' } });
  assert.equal(on.report.polarityInverted, true);
  assert.ok(on.report.nullDepthDb >= 20, `corrected null ${on.report.nullDepthDb} dB`);
  assert.ok(off.report.nullDepthDb < 1, `uncorrected null ${off.report.nullDepthDb} dB`);
});

// A level ratio that wanders, as a lav against a camera mic does when people
// move: the timing is perfect, but no single gain fits the whole clip.
function wanderingGain(signal, sampleRate) {
  return signal.map((v, i) => v * (0.9 + 0.7 * Math.sin((2 * Math.PI * i) / (sampleRate * 30))));
}

test('windowedNullDepthDb: a wandering level does not hide a perfect alignment', () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 30, seed: 31 });
  const tgt = wanderingGain(ref, sampleRate);
  const whole = nullDepthDb(ref, tgt);
  const windowed = windowedNullDepthDb(ref, tgt, { sampleRate });
  assert.ok(whole < 8, `whole-clip null ${whole} dB should be dragged down by the level swing`);
  assert.ok(windowed > 15, `windowed null ${windowed} dB should see the alignment`);
});

test('windowedNullDepthDb still fails audio that is out of time or inverted', () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 30, seed: 32 });
  const late = fftDelay(ref, 0.004 * sampleRate); // 4 ms off
  assert.ok(windowedNullDepthDb(ref, late, { sampleRate }) < 3, 'a 4 ms error must not null');
  const inverted = ref.map((v) => -v);
  assert.ok(windowedNullDepthDb(ref, inverted, { sampleRate }) < 1, 'per-window gain must stay non-negative');
  const { signal: other } = speechLike({ seconds: 30, seed: 33 });
  assert.ok(windowedNullDepthDb(ref, other, { sampleRate }) < 3, 'unrelated audio must not null');
});

test('windowedNullDepthDb skips pauses rather than scoring room tone', () => {
  const { signal: speech, sampleRate } = speechLike({ seconds: 10, seed: 34 });
  // speech, then a long pause of quiet uncorrelated noise on each mic, then speech
  const pause = 20 * sampleRate;
  const ref = new Float64Array(speech.length * 2 + pause);
  const tgt = new Float64Array(ref.length);
  const rngA = mulberry32(5), rngB = mulberry32(6);
  for (let i = 0; i < ref.length; i++) { ref[i] = (rngA() - 0.5) * 1e-4; tgt[i] = (rngB() - 0.5) * 1e-4; }
  for (let i = 0; i < speech.length; i++) {
    ref[i] += speech[i]; tgt[i] += 0.8 * speech[i];
    ref[speech.length + pause + i] += speech[i]; tgt[speech.length + pause + i] += 0.8 * speech[i];
  }
  const windowed = windowedNullDepthDb(ref, tgt, { sampleRate });
  assert.ok(windowed > 20, `pauses pulled the null down to ${windowed} dB`);
});

test('windowedNullDepthDb falls back to the whole clip when it is too short to window', () => {
  const { signal: a, sampleRate } = speechLike({ seconds: 3, seed: 35 });
  const b = scale(a, -3);
  assert.equal(windowedNullDepthDb(a, b, { sampleRate }), nullDepthDb(a, b));
});

test('alignPair reports the windowed null and keeps the whole-clip one', () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 30, seed: 36 });
  const tgt = wanderingGain(fftDelay(ref, 0.0123 * sampleRate), sampleRate);
  const r = alignPair({ ref, tgt, sampleRate, params: { mode: 'static', phase: 'off' } });
  assert.ok(r.report.nullDepthDb > 15, `reported null ${r.report.nullDepthDb} dB`);
  assert.ok(r.report.nullDepthWholeDb < r.report.nullDepthDb, 'whole-clip figure should be the lower one here');
});
