import test from 'node:test';
import assert from 'node:assert/strict';
import { alignPair, AUTO_SHIFT_MAX } from '../src/align.js';
import { normalizeJob } from '../src/job.js';
import { speechLike, fftDelay, addNoise } from './fixtures.js';

function jobWith(params) {
  return normalizeJob({
    params,
    pairs: [{
      id: 'p0',
      ref: { mediaPath: 'r.wav', startSec: 0, durationSec: 10 },
      target: { mediaPath: 't.wav', startSec: 0, durationSec: 10 },
      outputPath: 'out.wav',
    }],
  });
}

test('auto shift: handles cover the widest window the search can reach', () => {
  // A widened pass must correlate against real audio, not the zero padding
  // that lies beyond the extracted handles.
  const job = jobWith({});
  assert.equal(job.params.maxShiftMs, 'auto');
  assert.ok(job.pairs[0].handleSec >= AUTO_SHIFT_MAX / 1000,
    `handleSec ${job.pairs[0].handleSec} must cover ${AUTO_SHIFT_MAX} ms`);
});

test('auto shift: a pinned window sizes its own handles', () => {
  assert.equal(jobWith({ maxShiftMs: 100 }).pairs[0].handleSec, 0.35);
});

test('auto shift: a nonsense window is rejected at the job seam', () => {
  assert.throws(() => jobWith({ maxShiftMs: 0 }), /maxShiftMs/);
  assert.throws(() => jobWith({ maxShiftMs: 'wide' }), /maxShiftMs/);
});

// The search window used to be a user setting, then a ladder of ever-wider
// rungs climbed only when the winning peak sat near the window edge. It is now
// a single decimated pass over the whole range, so 'auto' always reports
// AUTO_SHIFT_MAX — the offset it finds, not the window it needed, is what says
// how far out of sync the pair was.

test('auto shift: a small offset is resolved to sub-sample precision', () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 20, seed: 41 });
  const delayMs = 30;
  const tgt = fftDelay(ref, (delayMs / 1000) * sampleRate);
  const r = alignPair({ ref, tgt, sampleRate, params: { mode: 'static' } });
  assert.equal(r.status, 'ok');
  assert.ok(Math.abs(r.report.staticDelayMs - delayMs) < 0.1, `delay ${r.report.staticDelayMs}`);
  assert.equal(r.report.searchWindowMs, AUTO_SHIFT_MAX);
});

test('auto shift: an offset far outside the old first rung is still found', () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 25, seed: 42 });
  const delayMs = 700;
  const tgt = fftDelay(ref, (delayMs / 1000) * sampleRate);
  const r = alignPair({ ref, tgt, sampleRate, params: { mode: 'static' } });
  assert.equal(r.status, 'ok');
  assert.ok(Math.abs(r.report.staticDelayMs - delayMs) < 1, `delay ${r.report.staticDelayMs}`);
});

test('auto shift: pinning the window too narrow is what auto avoids', () => {
  // The failure this replaces: a hand-set window that excludes the true peak
  // does not error, it returns a confident wrong answer or no correlation.
  const { signal: ref, sampleRate } = speechLike({ seconds: 25, seed: 42 });
  const delayMs = 700;
  const tgt = fftDelay(ref, (delayMs / 1000) * sampleRate);
  const pinned = alignPair({ ref, tgt, sampleRate, params: { mode: 'static', maxShiftMs: 250 } });
  const wrong = pinned.status === 'failed' ||
    Math.abs(pinned.report.staticDelayMs - delayMs) > 1;
  assert.ok(wrong, 'a 250 ms window should not resolve a 700 ms offset');
  assert.equal(pinned.report.searchWindowMs, 250);
});

test('auto shift: an explicit window is still honoured exactly', () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 20, seed: 43 });
  const tgt = fftDelay(ref, 0.02 * sampleRate);
  const r = alignPair({ ref, tgt, sampleRate, params: { mode: 'static', maxShiftMs: 100 } });
  assert.equal(r.status, 'ok');
  assert.equal(r.report.searchWindowMs, 100);
});

test('auto shift: uncorrelated audio still fails rather than widening forever', () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 12, seed: 44 });
  const { signal: other } = speechLike({ seconds: 12, seed: 9944 });
  const r = alignPair({ ref, tgt: addNoise(other, 20, 5), sampleRate, params: { mode: 'static' } });
  assert.equal(r.status, 'failed');
  assert.equal(r.report.searchWindowMs, AUTO_SHIFT_MAX);
});
