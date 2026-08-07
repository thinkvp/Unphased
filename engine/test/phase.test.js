import test from 'node:test';
import assert from 'node:assert/strict';
import { alignPair, nullDepthDb } from '../src/align.js';
import { phaseAlign } from '../src/phaseAlign.js';
import { speechLike, fftDelay, allpassChain, timeVaryingAllpass } from './fixtures.js';

test('phaseAlign recovers null depth lost to allpass phase smear', { timeout: 120000 }, () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 20, seed: 51 });
  const D = 0.0117 * sampleRate;
  const tgt = allpassChain(fftDelay(ref, D));

  const off = alignPair({ ref, tgt, sampleRate, params: { mode: 'static', maxShiftMs: 100, phase: 'off' } });
  const auto = alignPair({ ref, tgt, sampleRate, params: { mode: 'static', maxShiftMs: 100, phase: 'auto' } });
  assert.equal(off.status, 'ok');
  assert.equal(auto.status, 'ok');
  assert.equal(off.report.phaseApplied, false);
  assert.equal(auto.report.phaseApplied, true);
  const gain = auto.report.nullDepthDb - off.report.nullDepthDb;
  assert.ok(gain >= 6, `phase correction gained only ${gain} dB (off=${off.report.nullDepthDb}, auto=${auto.report.nullDepthDb})`);
  assert.ok(auto.report.nullDepthDb >= 18, `null depth with phase ${auto.report.nullDepthDb} dB`);
});

test('phaseAlign does not degrade an already phase-clean pair', { timeout: 120000 }, () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 20, seed: 52 });
  const tgt = fftDelay(ref, 0.005 * sampleRate);
  const r = alignPair({ ref, tgt, sampleRate, params: { mode: 'static', maxShiftMs: 100, phase: 'auto' } });
  assert.equal(r.status, 'ok');
  assert.ok(r.report.nullDepthDb >= 20, `null depth ${r.report.nullDepthDb} dB`);
});

test('phaseAlign declines on uncorrelated input instead of mangling it', () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 6, seed: 53 });
  const { signal: other } = speechLike({ seconds: 6, seed: 530 });
  const r = phaseAlign(ref, other, { sampleRate });
  assert.equal(r.applied, false);
  assert.ok(r.coherentFraction < 0.1);
});

test('time-varying phase beats a single static curve when the relationship drifts', { timeout: 180000 }, () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 60, seed: 55 });
  const delayed = fftDelay(ref, 0.0094 * sampleRate);
  // phase character changes across the take
  const tgt = timeVaryingAllpass(delayed, [0.6, -0.35], [-0.55, 0.4, 0.25]);

  const base = { mode: 'static', maxShiftMs: 100 };
  const off = alignPair({ ref, tgt, sampleRate, params: { ...base, phase: 'off' } });
  const staticPhase = alignPair({ ref, tgt, sampleRate, params: { ...base, phase: 'auto', phaseBlockSeconds: 0 } });
  const varying = alignPair({ ref, tgt, sampleRate, params: { ...base, phase: 'auto', phaseBlockSeconds: 10 } });

  assert.equal(staticPhase.report.phaseApplied, true);
  assert.equal(varying.report.phaseApplied, true);
  assert.ok(
    staticPhase.report.nullDepthDb > off.report.nullDepthDb,
    `static phase should still help: ${off.report.nullDepthDb} -> ${staticPhase.report.nullDepthDb}`
  );
  const gain = varying.report.nullDepthDb - staticPhase.report.nullDepthDb;
  assert.ok(
    gain >= 2,
    `time-varying phase gained only ${gain.toFixed(2)} dB over static ` +
    `(off=${off.report.nullDepthDb.toFixed(1)}, static=${staticPhase.report.nullDepthDb.toFixed(1)}, ` +
    `varying=${varying.report.nullDepthDb.toFixed(1)})`
  );
});

test('time-varying phase does not hurt a genuinely static relationship', { timeout: 180000 }, () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 60, seed: 56 });
  const tgt = allpassChain(fftDelay(ref, 0.007 * sampleRate));
  const base = { mode: 'static', maxShiftMs: 100, phase: 'auto' };
  const staticPhase = alignPair({ ref, tgt, sampleRate, params: { ...base, phaseBlockSeconds: 0 } });
  const varying = alignPair({ ref, tgt, sampleRate, params: { ...base, phaseBlockSeconds: 10 } });
  assert.ok(
    varying.report.nullDepthDb >= staticPhase.report.nullDepthDb - 1.5,
    `blocked measurement regressed a static case: ${staticPhase.report.nullDepthDb} -> ${varying.report.nullDepthDb}`
  );
});

test('phaseAlign round-trip transparency: identical signals stay identical', () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 6, seed: 54 });
  const r = phaseAlign(ref, ref, { sampleRate });
  assert.equal(r.applied, true);
  // rotation should be ~identity; output must null deeply against input
  assert.ok(nullDepthDb(ref, r.out) >= 40, `transparency ${nullDepthDb(ref, r.out)} dB`);
});
