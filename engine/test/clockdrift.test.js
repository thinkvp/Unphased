// Clock-drift validation against a real resampler: ffmpeg's asetrate trick
// simulates a recorder whose clock runs ~104 ppm fast, plus a 10 ms offset.
// Skipped when ffmpeg is not installed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeWav, readWav } from '../src/wavFile.js';
import { alignPair } from '../src/align.js';
import { speechLike } from './fixtures.js';

const FFMPEG = process.env.UNPHASED_FFMPEG || 'C:\\ffmpeg\\bin\\ffmpeg.exe';

test('dynamic align tracks real resampler clock drift (~104 ppm)', {
  skip: !existsSync(FFMPEG) ? 'ffmpeg not found' : false,
  timeout: 120000,
}, () => {
  const dir = join(tmpdir(), 'unphased-clockdrift-test');
  mkdirSync(dir, { recursive: true });
  try {
    const { signal: ref, voiced, sampleRate } = speechLike({ seconds: 20, seed: 41 });
    const refPath = join(dir, 'ref.wav');
    const tgtPath = join(dir, 'tgt.wav');
    writeWav(refPath, { sampleRate, data: [ref] }, 'f32');
    execFileSync(FFMPEG, [
      '-y', '-i', refPath,
      '-af', 'asetrate=48005,aresample=48000,adelay=10',
      '-c:a', 'pcm_f32le', tgtPath,
    ], { stdio: 'pipe' });
    const tgt = readWav(tgtPath).data[0];

    const r = alignPair({ ref, tgt: Float64Array.from(tgt), sampleRate, params: { mode: 'dynamic', maxShiftMs: 100 } });
    assert.equal(r.status, 'ok');
    assert.ok(typeof r.delayCurve !== 'number', 'expected dynamic curve');

    // analytic truth: d(n) = 10ms*fs - n * eps, eps = 5/48005
    const eps = 5 / 48005;
    const truth = (n) => 0.01 * sampleRate - n * eps;
    let e = 0;
    let cnt = 0;
    for (let n = 0; n < r.delayCurve.length; n++) {
      if (!voiced[n]) continue;
      const d = ((r.delayCurve[n] - truth(n)) / sampleRate) * 1000;
      e += d * d;
      cnt++;
    }
    const rmsErr = Math.sqrt(e / cnt);
    assert.ok(rmsErr < 0.5, `clock drift curve RMS error ${rmsErr} ms`);

    // the recovered drift span over 20 s should be ~2.08 ms
    const span = r.report.driftRangeMs[1] - r.report.driftRangeMs[0];
    assert.ok(span > 1.4 && span < 2.8, `drift span ${span} ms`);
    assert.ok(r.report.nullDepthDb >= 15, `null depth ${r.report.nullDepthDb} dB`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
