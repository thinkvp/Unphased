// Per-band coherence weighting and low-SNR robustness.

import test from 'node:test';
import assert from 'node:assert/strict';
import { alignPair } from '../src/align.js';
import { estimateBandWeights, WEIGHT_BINS } from '../src/coherence.js';
import { estimateStaticOffset, adaptiveGateDb } from '../src/coarse.js';
import { speechLike, fftDelay, addBandNoise, addNoise, scale } from './fixtures.js';

test('estimateBandWeights suppresses bands the two signals do not share', () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 20, seed: 91 });
  const D = 0.01 * sampleRate;
  // heavy interference confined to 6-20 kHz, well above the speech band
  const tgt = addBandNoise(fftDelay(ref, D), -6, [6000, 20000], sampleRate, 911);
  const { weights, meanCoherence } = estimateBandWeights(ref, tgt, D, { sampleRate });
  assert.ok(weights, 'expected weights');
  assert.equal(weights.length, WEIGHT_BINS);
  assert.ok(meanCoherence > 0 && meanCoherence <= 1);

  const binOf = (hz) => Math.round((hz / (sampleRate / 2)) * (WEIGHT_BINS - 1));
  const speechBand = weights[binOf(1500)];
  const noiseBand = weights[binOf(12000)];
  assert.ok(
    speechBand > noiseBand * 1.5,
    `shared speech band (${speechBand.toFixed(3)}) should outweigh the noisy band (${noiseBand.toFixed(3)})`
  );
  assert.ok(weights.every((w) => w >= 0 && w <= 1), 'weights must stay in [0,1]');
});

test('band weighting improves delay accuracy under band-limited interference', { timeout: 180000 }, () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 25, seed: 92 });
  const delayMs = 13.3;
  const D = (delayMs / 1000) * sampleRate;
  const tgt = addBandNoise(fftDelay(ref, D), -8, [5000, 22000], sampleRate, 922);

  const plain = estimateStaticOffset(ref, tgt, { sampleRate, maxShiftMs: 100 });
  const { weights } = estimateBandWeights(ref, tgt, plain.offsetSamples, { sampleRate });
  const weighted = estimateStaticOffset(ref, tgt, { sampleRate, maxShiftMs: 100, bandWeights: weights });

  const errPlain = Math.abs((plain.offsetSamples - D) / sampleRate) * 1000;
  const errWeighted = Math.abs((weighted.offsetSamples - D) / sampleRate) * 1000;
  assert.ok(weighted.ok);
  assert.ok(
    errWeighted <= errPlain + 1e-9,
    `weighting made it worse: ${errPlain.toFixed(4)} ms -> ${errWeighted.toFixed(4)} ms`
  );
  assert.ok(errWeighted < 0.1, `weighted error ${errWeighted.toFixed(4)} ms`);
});

test('full pipeline still aligns cleanly with band weighting on', { timeout: 180000 }, () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 25, seed: 93 });
  const delayMs = 9.8;
  const tgt = addBandNoise(fftDelay(ref, (delayMs / 1000) * sampleRate), -10, [6000, 22000], sampleRate, 933);
  const on = alignPair({ ref, tgt, sampleRate, params: { mode: 'dynamic', maxShiftMs: 100 } });
  assert.equal(on.status, 'ok');
  assert.ok(Math.abs(on.report.staticDelayMs - delayMs) < 0.1, `delay ${on.report.staticDelayMs}`);
  assert.ok(on.report.meanCoherence > 0, 'coherence should be reported');
});

test('band weighting can be disabled and the pipeline still works', { timeout: 120000 }, () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 15, seed: 94 });
  const tgt = fftDelay(ref, 0.006 * sampleRate);
  const off = alignPair({ ref, tgt, sampleRate, params: { mode: 'static', maxShiftMs: 100, bandWeighting: 'off' } });
  assert.equal(off.status, 'ok');
  assert.equal(off.report.meanCoherence, null);
  assert.ok(off.report.nullDepthDb >= 20);
});

test('adaptiveGateDb tracks the material instead of a fixed dBFS threshold', () => {
  const { signal: loud } = speechLike({ seconds: 10, seed: 95 });
  const quiet = scale(loud, -36); // conservatively recorded lav
  const gLoud = adaptiveGateDb(loud);
  const gQuiet = adaptiveGateDb(quiet);
  assert.ok(gQuiet < gLoud, `quiet material must gate lower: ${gQuiet} vs ${gLoud}`);
  assert.ok(gQuiet >= -85, 'gate must not fall below the absolute floor');
});

test('a quietly recorded pair still aligns (fixed -50 dBFS gate would fail it)', { timeout: 180000 }, () => {
  const { signal: refLoud, sampleRate } = speechLike({ seconds: 25, seed: 96 });
  const delayMs = 16.5;
  // both sides 36 dB down: every window sits below the old fixed gate
  const ref = scale(refLoud, -36);
  const tgt = scale(fftDelay(refLoud, (delayMs / 1000) * sampleRate), -36);
  const r = alignPair({ ref, tgt, sampleRate, params: { mode: 'dynamic', maxShiftMs: 100 } });
  assert.equal(r.status, 'ok', `quiet pair failed: ${r.reason}`);
  assert.ok(Math.abs(r.report.staticDelayMs - delayMs) < 0.1, `delay ${r.report.staticDelayMs}`);

  // and the old behaviour really would have rejected it
  const withFixedGate = estimateStaticOffset(ref, tgt, { sampleRate, maxShiftMs: 100, rmsGateDb: -50 });
  assert.equal(withFixedGate.ok, false, 'expected the fixed gate to reject this quiet pair');
});

test('low-SNR broadband pair degrades gracefully rather than fabricating a match', { timeout: 180000 }, () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 25, seed: 97 });
  const delayMs = 7.2;
  const tgt = addNoise(fftDelay(ref, (delayMs / 1000) * sampleRate), 5, 977);
  const r = alignPair({ ref, tgt, sampleRate, params: { mode: 'dynamic', maxShiftMs: 100 } });
  assert.notEqual(r.status, 'failed');
  assert.ok(Math.abs(r.report.staticDelayMs - delayMs) < 0.5, `delay ${r.report.staticDelayMs} at 5 dB SNR`);
});
