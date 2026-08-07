import test from 'node:test';
import assert from 'node:assert/strict';
import { alignPair, nullDepthDb } from '../src/align.js';
import { speechLike, fftDelay, addNoise, scale } from './fixtures.js';

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
