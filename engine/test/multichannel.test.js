// Stereo and sample-rate preservation: a stereo target must stay stereo, a
// 96k source must stay 96k, and both channels must receive the same timing
// and polarity correction. Requires ffmpeg.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeWav, readWav } from '../src/wavFile.js';
import { nullDepthDb, alignPair, renderChannel } from '../src/align.js';
import { speechLike, fftDelay, scale } from './fixtures.js';

const FFMPEG = process.env.UNPHASED_FFMPEG || 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const skip = !existsSync(FFMPEG) ? 'ffmpeg not found' : false;

function runCli(args) {
  const out = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return out.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

test('stereo target stays stereo, both channels aligned', { skip, timeout: 180000 }, () => {
  const dir = join(tmpdir(), 'unphased-stereo-test');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    const sampleRate = 48000;
    const { signal: boom } = speechLike({ seconds: 20, seed: 81 });
    const delayMs = 12.4;
    const D = (delayMs / 1000) * sampleRate;
    // stereo target: L is the delayed boom, R is the same but quieter, so a
    // channel swap or a dropped channel would be detectable
    const left = fftDelay(boom, D);
    const right = scale(left, -6);
    writeWav(join(dir, 'boom.wav'), { sampleRate, data: [boom] }, 'pcm24');
    writeWav(join(dir, 'lav.wav'), { sampleRate, data: [left, right] }, 'pcm24');

    const job = {
      ffmpegPath: FFMPEG,
      tempDir: join(dir, 'tmp'),
      params: { mode: 'static', maxShiftMs: 100 },
      pairs: [{
        id: 'st',
        ref: { mediaPath: join(dir, 'boom.wav'), startSec: 2, durationSec: 15 },
        // no channel selected -> whole stereo stream is the clip's audio
        target: { mediaPath: join(dir, 'lav.wav'), startSec: 2, durationSec: 15 },
        outputPath: join(dir, 'out', 'st.wav'),
      }],
    };
    writeFileSync(join(dir, 'job.json'), JSON.stringify(job));
    const evs = runCli(['run', join(dir, 'job.json')]);
    const res = evs.find((e) => e.event === 'result');
    assert.equal(res.status, 'ok');
    assert.equal(res.outputChannels, 2, 'stereo target must not be flattened to mono');

    const out = readWav(join(dir, 'out', 'st.wav'));
    assert.equal(out.channels, 2);
    assert.equal(out.data[0].length, 15 * sampleRate);

    const refSeg = Float64Array.from(boom.subarray(2 * sampleRate, 17 * sampleRate));
    // both channels align to the reference; R is 6 dB down but nullDepthDb
    // solves for gain, so both should null well
    assert.ok(nullDepthDb(refSeg, out.data[0]) >= 20, `L null ${nullDepthDb(refSeg, out.data[0])}`);
    assert.ok(nullDepthDb(refSeg, out.data[1]) >= 20, `R null ${nullDepthDb(refSeg, out.data[1])}`);

    // and the level difference between channels is preserved (~6 dB)
    let eL = 0, eR = 0;
    for (let i = 0; i < out.data[0].length; i++) {
      eL += out.data[0][i] * out.data[0][i];
      eR += out.data[1][i] * out.data[1][i];
    }
    const diffDb = 10 * Math.log10(eL / eR);
    assert.ok(Math.abs(diffDb - 6) < 1, `channel level difference ${diffDb} dB, expected ~6`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('96 kHz source renders at 96 kHz, not resampled to 48', { skip, timeout: 180000 }, () => {
  const dir = join(tmpdir(), 'unphased-96k-test');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    const { signal: boom } = speechLike({ seconds: 15, seed: 82 });
    writeWav(join(dir, 'boom48.wav'), { sampleRate: 48000, data: [boom] }, 'pcm24');
    const lav48 = fftDelay(boom, (11 / 1000) * 48000);
    writeWav(join(dir, 'lav48.wav'), { sampleRate: 48000, data: [lav48] }, 'pcm24');
    // resample the target to 96k so the source rate differs from analysis rate
    execFileSync(FFMPEG, ['-y', '-i', join(dir, 'lav48.wav'), '-ar', '96000', join(dir, 'lav96.wav')], { stdio: 'pipe' });

    const job = {
      ffmpegPath: FFMPEG,
      tempDir: join(dir, 'tmp'),
      params: { mode: 'static', maxShiftMs: 100 },
      pairs: [{
        id: 'hi',
        ref: { mediaPath: join(dir, 'boom48.wav'), startSec: 1, durationSec: 12 },
        target: { mediaPath: join(dir, 'lav96.wav'), startSec: 1, durationSec: 12 },
        outputPath: join(dir, 'out', 'hi.wav'),
      }],
    };
    writeFileSync(join(dir, 'job.json'), JSON.stringify(job));
    const evs = runCli(['run', join(dir, 'job.json')]);
    const res = evs.find((e) => e.event === 'result');
    assert.equal(res.status, 'ok');
    assert.equal(res.outputSampleRate, 96000, 'source rate must be preserved');

    const out = readWav(join(dir, 'out', 'hi.wav'));
    assert.equal(out.sampleRate, 96000);
    assert.equal(out.data[0].length, 12 * 96000, 'duration must still span the requested interval');

    // the 96k output, decimated back to 48k, must still null against the ref
    const dec = new Float64Array(12 * 48000);
    for (let i = 0; i < dec.length; i++) dec[i] = out.data[0][i * 2];
    const refSeg = Float64Array.from(boom.subarray(48000, 13 * 48000));
    assert.ok(nullDepthDb(refSeg, dec) >= 15, `null after decimation ${nullDepthDb(refSeg, dec)} dB`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderChannel reproduces the analysis render at the same rate', () => {
  const { signal: ref, sampleRate } = speechLike({ seconds: 12, seed: 83 });
  const tgt = fftDelay(ref, 0.008 * sampleRate);
  const r = alignPair({ ref, tgt, sampleRate, params: { mode: 'static', maxShiftMs: 100 } });
  assert.equal(r.status, 'ok');
  const re = renderChannel(tgt, r.correction, ref.length, sampleRate);
  // same input, same rate -> must match the pipeline's own output closely
  let maxDiff = 0;
  for (let i = 0; i < ref.length; i++) {
    const d = Math.abs(re[i] - r.aligned[i]);
    if (d > maxDiff) maxDiff = d;
  }
  assert.ok(maxDiff < 1e-9, `renderChannel diverged from alignPair by ${maxDiff}`);
});
