// End-to-end job protocol test: media on disk -> job.json -> spawn CLI ->
// NDJSON events -> aligned WAV that nulls against the reference segment.
// Requires ffmpeg (skipped otherwise).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeWav, readWav } from '../src/wavFile.js';
import { nullDepthDb } from '../src/align.js';
import { speechLike, fftDelay, scale } from './fixtures.js';

const FFMPEG = process.env.UNPHASED_FFMPEG || 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

function runCli(args) {
  const out = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return out
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('job run: WAV sources extract, align, and null against reference', {
  skip: !existsSync(FFMPEG) ? 'ffmpeg not found' : false,
  timeout: 180000,
}, () => {
  const dir = join(tmpdir(), 'unphased-job-test');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    const sampleRate = 48000;
    const { signal: boom } = speechLike({ seconds: 30, seed: 61 });
    const delayMs = 14.2;
    const lav = scale(fftDelay(boom, (delayMs / 1000) * sampleRate), -3);
    writeWav(join(dir, 'boom.wav'), { sampleRate, data: [boom] }, 'pcm24');
    writeWav(join(dir, 'lav.wav'), { sampleRate, data: [lav] }, 'pcm24');

    const job = {
      ffmpegPath: FFMPEG,
      tempDir: join(dir, 'tmp'),
      params: { mode: 'static', maxShiftMs: 100 },
      pairs: [
        {
          id: 'pair1',
          ref: { mediaPath: join(dir, 'boom.wav'), startSec: 3, durationSec: 20 },
          target: { mediaPath: join(dir, 'lav.wav'), startSec: 3, durationSec: 20 },
          outputPath: join(dir, 'out', 'lav-aligned.wav'),
        },
      ],
    };
    writeFileSync(join(dir, 'job.json'), JSON.stringify(job));
    const eventsOut = runCli(['run', join(dir, 'job.json')]);

    const result = eventsOut.find((e) => e.event === 'result' && e.id === 'pair1');
    assert.ok(result, 'missing result event');
    assert.equal(result.status, 'ok');
    assert.ok(Math.abs(result.staticDelayMs - delayMs) < 0.1, `delay ${result.staticDelayMs}`);
    const done = eventsOut.find((e) => e.event === 'done');
    assert.deepEqual({ ok: done.ok, failed: done.failed }, { ok: 1, failed: 0 });

    // aligned output must null against the same reference segment
    const aligned = readWav(join(dir, 'out', 'lav-aligned.wav')).data[0];
    assert.equal(aligned.length, 20 * sampleRate, 'output must span exactly the requested interval');
    const refSeg = boom.subarray(3 * sampleRate, 23 * sampleRate);
    const depth = nullDepthDb(Float64Array.from(refSeg), Float64Array.from(aligned));
    assert.ok(depth >= 20, `null depth ${depth} dB`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('job run: compressed (AAC) target still aligns via accurate seek', {
  skip: !existsSync(FFMPEG) ? 'ffmpeg not found' : false,
  timeout: 180000,
}, () => {
  const dir = join(tmpdir(), 'unphased-job-aac-test');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    const sampleRate = 48000;
    const { signal: boom } = speechLike({ seconds: 20, seed: 62 });
    const delayMs = 9.6;
    const lav = fftDelay(boom, (delayMs / 1000) * sampleRate);
    writeWav(join(dir, 'boom.wav'), { sampleRate, data: [boom] }, 'pcm24');
    writeWav(join(dir, 'lav.wav'), { sampleRate, data: [lav] }, 'pcm24');
    execFileSync(FFMPEG, ['-y', '-i', join(dir, 'lav.wav'), '-c:a', 'aac', '-b:a', '192k', join(dir, 'lav.m4a')], { stdio: 'pipe' });

    const job = {
      ffmpegPath: FFMPEG,
      tempDir: join(dir, 'tmp'),
      params: { mode: 'static', maxShiftMs: 100 },
      pairs: [
        {
          id: 'aac',
          ref: { mediaPath: join(dir, 'boom.wav'), startSec: 2, durationSec: 15 },
          target: { mediaPath: join(dir, 'lav.m4a'), startSec: 2, durationSec: 15 },
          outputPath: join(dir, 'out', 'lav-aligned.wav'),
        },
      ],
    };
    writeFileSync(join(dir, 'job.json'), JSON.stringify(job));
    const eventsOut = runCli(['run', join(dir, 'job.json')]);
    const result = eventsOut.find((e) => e.event === 'result' && e.id === 'aac');
    assert.equal(result.status, 'ok');
    // AAC may introduce a small codec offset; the engine measures the total
    assert.ok(Math.abs(result.staticDelayMs - delayMs) < 5, `delay ${result.staticDelayMs}`);
    assert.ok(result.nullDepthDb >= 8, `null depth ${result.nullDepthDb} dB (lossy)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('job run: failed pair reports reason and does not write output', {
  skip: !existsSync(FFMPEG) ? 'ffmpeg not found' : false,
  timeout: 180000,
}, () => {
  const dir = join(tmpdir(), 'unphased-job-fail-test');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    const sampleRate = 48000;
    const { signal: boom } = speechLike({ seconds: 12, seed: 63 });
    const { signal: unrelated } = speechLike({ seconds: 12, seed: 6300 });
    writeWav(join(dir, 'boom.wav'), { sampleRate, data: [boom] }, 'pcm24');
    writeWav(join(dir, 'other.wav'), { sampleRate, data: [unrelated] }, 'pcm24');
    const job = {
      ffmpegPath: FFMPEG,
      tempDir: join(dir, 'tmp'),
      params: { mode: 'static', maxShiftMs: 100 },
      pairs: [
        {
          id: 'bad',
          ref: { mediaPath: join(dir, 'boom.wav'), startSec: 0, durationSec: 12 },
          target: { mediaPath: join(dir, 'other.wav'), startSec: 0, durationSec: 12 },
          outputPath: join(dir, 'out', 'nope.wav'),
        },
      ],
    };
    writeFileSync(join(dir, 'job.json'), JSON.stringify(job));
    let exitCode = 0;
    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [CLI, 'run', join(dir, 'job.json')], { encoding: 'utf8' });
    } catch (e) {
      exitCode = e.status;
      stdout = e.stdout;
    }
    assert.equal(exitCode, 2, 'CLI exits 2 when pairs fail');
    const eventsOut = stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    const result = eventsOut.find((e) => e.event === 'result' && e.id === 'bad');
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'no-correlation');
    assert.equal(existsSync(join(dir, 'out', 'nope.wav')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
