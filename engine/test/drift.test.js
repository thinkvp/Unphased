import test from 'node:test';
import assert from 'node:assert/strict';
import { alignPair } from '../src/align.js';
import { solvePath, expandPath } from '../src/pathSolver.js';
import { speechLike, varyingDelay } from './fixtures.js';

function curveErrorMs(delayCurve, truthFn, voiced, sampleRate) {
  // RMS error between recovered per-sample delay and ground truth over voiced samples
  let e = 0;
  let n = 0;
  for (let i = 0; i < delayCurve.length; i++) {
    if (!voiced[i]) continue;
    const d = (delayCurve[i] - truthFn(i)) / sampleRate * 1000;
    e += d * d;
    n++;
  }
  return Math.sqrt(e / Math.max(1, n));
}

test('dynamic align: linear drift recovered < 0.5 ms RMS', { timeout: 120000 }, () => {
  const { signal: ref, voiced, sampleRate } = speechLike({ seconds: 30, seed: 31 });
  // 5 ms initial delay drifting +3 ms over 30 s
  const truth = (n) => (0.005 + 0.003 * (n / sampleRate / 30)) * sampleRate;
  const tgt = varyingDelay(ref, truth);
  const r = alignPair({ ref, tgt, sampleRate, params: { mode: 'dynamic', maxShiftMs: 100 } });
  assert.equal(r.status, 'ok');
  assert.ok(typeof r.delayCurve !== 'number', 'expected a per-sample delay curve');
  const err = curveErrorMs(r.delayCurve, truth, voiced, sampleRate);
  assert.ok(err < 0.5, `drift curve RMS error ${err} ms`);
  const span = r.report.driftRangeMs[1] - r.report.driftRangeMs[0];
  assert.ok(span > 1.5 && span < 4.5, `drift span ${span} ms`);
  assert.ok(r.report.nullDepthDb >= 15, `null depth ${r.report.nullDepthDb} dB`);
});

test('dynamic align: sinusoidal drift (actor sway) recovered < 0.5 ms RMS', { timeout: 120000 }, () => {
  const { signal: ref, voiced, sampleRate } = speechLike({ seconds: 30, seed: 32 });
  // 8 ms mean delay, 2 ms swing at 0.1 Hz
  const truth = (n) =>
    (0.008 + 0.002 * Math.sin((2 * Math.PI * 0.1 * n) / sampleRate)) * sampleRate;
  const tgt = varyingDelay(ref, truth);
  const r = alignPair({ ref, tgt, sampleRate, params: { mode: 'dynamic', maxShiftMs: 100 } });
  assert.equal(r.status, 'ok');
  const err = curveErrorMs(r.delayCurve, truth, voiced, sampleRate);
  assert.ok(err < 0.5, `drift curve RMS error ${err} ms`);
  assert.ok(r.report.nullDepthDb >= 15, `null depth ${r.report.nullDepthDb} dB`);
});

test('dynamic align on a static-delay signal stays static', { timeout: 120000 }, () => {
  const { signal: ref, voiced, sampleRate } = speechLike({ seconds: 20, seed: 33 });
  const D = 0.0123 * sampleRate;
  const tgt = varyingDelay(ref, () => D);
  const r = alignPair({ ref, tgt, sampleRate, params: { mode: 'dynamic', maxShiftMs: 100 } });
  assert.equal(r.status, 'ok');
  const err = curveErrorMs(r.delayCurve, () => D, voiced, sampleRate);
  assert.ok(err < 0.2, `curve deviation ${err} ms`);
  const span = r.report.driftRangeMs[1] - r.report.driftRangeMs[0];
  assert.ok(span < 1, `spurious drift span ${span} ms`);
});

test('pathSolver coasts through gated silence on hand-built lattice', () => {
  // 21 lag states (L=10), 9 rows; true path ramps 0 -> 4 with a gated gap
  const L = 10;
  const nLags = 2 * L + 1;
  const truePath = [0, 1, 1, 2, null, null, 3, 4, 4]; // nulls = gated rows
  const rows = truePath.map((lag, t) => {
    if (lag === null) {
      return { t0: t * 100, center: t * 100 + 50, corr: null, peakRatio: 0, rms: 0, gated: true };
    }
    const corr = new Float64Array(nLags).fill(0.1);
    corr[lag + L] = 1;
    return { t0: t * 100, center: t * 100 + 50, corr, peakRatio: 5, rms: 1, gated: false };
  });
  const lattice = { rows, L, windowSize: 100, hop: 100 };
  const { lags, gatedMask } = solvePath(lattice, { slopeLimit: 2 });
  for (let t = 0; t < truePath.length; t++) {
    if (truePath[t] === null) {
      assert.equal(gatedMask[t], 1);
      // coasting: must stay between neighbors
      assert.ok(lags[t] >= 1 && lags[t] <= 4, `gated row ${t} lag ${lags[t]}`);
    } else {
      assert.ok(Math.abs(lags[t] - truePath[t]) <= 0.5, `row ${t}: ${lags[t]} vs ${truePath[t]}`);
    }
  }
  const curve = expandPath(lattice, lags, 900);
  assert.equal(curve.length, 900);
  // curve must be monotone-ish overall: starts near 0, ends near 4
  assert.ok(Math.abs(curve[60] - 0) < 1, `start ${curve[60]}`);
  assert.ok(Math.abs(curve[860] - 4) < 1, `end ${curve[860]}`);
});
