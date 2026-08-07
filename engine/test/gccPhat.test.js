import test from 'node:test';
import assert from 'node:assert/strict';
import { gccPhat, paddedSlice } from '../src/gccPhat.js';
import { estimateStaticOffset } from '../src/coarse.js';
import { speechLike, fftDelay, addNoise, scale, mulberry32 } from './fixtures.js';

test('gccPhat finds an exact integer lag', () => {
  const rand = mulberry32(5);
  const n = 48000;
  const ref = new Float64Array(n).map(() => rand() * 2 - 1);
  const D = 137;
  const tgt = new Float64Array(n);
  for (let i = D; i < n; i++) tgt[i] = ref[i - D]; // tgt lags ref by D
  const L = 1000;
  const t0 = 20000;
  const N = 4096;
  const refBlock = ref.subarray(t0, t0 + N);
  const slice = paddedSlice(tgt, t0 - L, N + 2 * L);
  const r = gccPhat(refBlock, slice, L);
  assert.equal(r.intLag, D);
  assert.ok(Math.abs(r.bestLag - D) < 0.5);
  assert.ok(r.peakRatio > 2, `peakRatio ${r.peakRatio}`);
});

test('gccPhat lag convention: negative lag when target leads', () => {
  const rand = mulberry32(6);
  const n = 48000;
  const tgt = new Float64Array(n).map(() => rand() * 2 - 1);
  const D = 250;
  const ref = new Float64Array(n);
  for (let i = D; i < n; i++) ref[i] = tgt[i - D]; // ref lags tgt => tgt leads
  const L = 1000;
  const r = gccPhat(ref.subarray(20000, 24096), paddedSlice(tgt, 19000, 4096 + 2000), 1000);
  assert.equal(r.intLag, -D);
});

test('estimateStaticOffset recovers fractional delay within 0.1 ms', () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 20, seed: 11 });
  const delayMs = 23.7;
  const D = (delayMs / 1000) * sampleRate; // 1137.6 samples
  const tgt = fftDelay(ref, D);
  const r = estimateStaticOffset(ref, tgt, { sampleRate, maxShiftMs: 100 });
  assert.ok(r.ok, `expected ok, got ${r.reason}`);
  const errMs = Math.abs((r.offsetSamples - D) / sampleRate) * 1000;
  assert.ok(errMs < 0.1, `offset error ${errMs} ms`);
});

test('estimateStaticOffset survives noise and level offset', () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 20, seed: 12 });
  const D = 0.0155 * sampleRate; // 15.5 ms
  const tgt = addNoise(scale(fftDelay(ref, D), -12), 15, 101);
  const r = estimateStaticOffset(ref, tgt, { sampleRate, maxShiftMs: 100 });
  assert.ok(r.ok);
  const errMs = Math.abs((r.offsetSamples - D) / sampleRate) * 1000;
  assert.ok(errMs < 0.1, `offset error ${errMs} ms`);
});

test('estimateStaticOffset fails cleanly on uncorrelated signals', () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 10, seed: 13 });
  const { signal: other } = speechLike({ seconds: 10, seed: 999 });
  const r = estimateStaticOffset(ref, other, { sampleRate, maxShiftMs: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-correlation');
});
