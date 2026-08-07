// Multi-pair jobs: the worker pool and the shared reference extraction.
//
// The single-pair e2e tests all take the serial fallback (planConcurrency caps
// at pairs.length), so nothing there exercises the pool, the cross-thread event
// plumbing, or the region dedupe. Requires ffmpeg (skipped otherwise).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeWav, readWav } from '../src/wavFile.js';
import { nullDepthDb } from '../src/align.js';
import { regionKey } from '../src/runPair.js';
import { planConcurrency } from '../src/pool.js';
import { speechLike, fftDelay, scale } from './fixtures.js';

const FFMPEG = process.env.UNPHASED_FFMPEG || 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const skip = !existsSync(FFMPEG) ? 'ffmpeg not found' : false;

test('regionKey: identical reference descriptors collide, distinct ones do not', () => {
  const base = { mediaPath: 'boom.wav', startSec: 1.5, durationSec: 30, audioStream: 0, channel: null };
  assert.equal(regionKey(base, 48000), regionKey({ ...base }, 48000));
  // the defaulted fields must participate, or a channel-split pair would reuse
  // the wrong decode
  assert.notEqual(regionKey(base, 48000), regionKey({ ...base, channel: 1 }, 48000));
  assert.notEqual(regionKey(base, 48000), regionKey({ ...base, audioStream: 1 }, 48000));
  assert.notEqual(regionKey(base, 48000), regionKey({ ...base, startSec: 1.6 }, 48000));
  assert.notEqual(regionKey(base, 48000), regionKey(base, 96000));
});

test('planConcurrency: bounded by pair count, and by memory on long clips', () => {
  const pair = (durationSec) => ({ target: { durationSec }, handleSec: 2.25 });
  assert.equal(planConcurrency([pair(30)], {}), 1, 'one pair never spawns a pool');
  assert.equal(planConcurrency([pair(30), pair(30)], { override: 7 }), 2, 'override still clamps to pair count');
  // a 30-minute pair is ~350 MB of Float64 per slot; the budget must bite
  // before the core count does
  const long = Array.from({ length: 8 }, () => pair(1800));
  assert.ok(planConcurrency(long, {}) < 4, `long clips should throttle, got ${planConcurrency(long, {})}`);
});

test('multi-pair job: pool aligns every pair and shares one reference decode', {
  skip,
  timeout: 300000,
}, () => {
  const dir = join(tmpdir(), 'unphased-pool-test');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    const sampleRate = 48000;
    const seconds = 12;
    const { signal: boom } = speechLike({ seconds, seed: 81 });
    const { signal: unrelated } = speechLike({ seconds, seed: 8100 });
    writeWav(join(dir, 'boom.wav'), { sampleRate, data: [boom] }, 'pcm24');
    writeWav(join(dir, 'other.wav'), { sampleRate, data: [unrelated] }, 'pcm24');

    const delaysMs = [8.5, 14.2, 21.7];
    delaysMs.forEach((ms, i) => {
      const lav = scale(fftDelay(boom, (ms / 1000) * sampleRate), -3);
      writeWav(join(dir, `lav${i}.wav`), { sampleRate, data: [lav] }, 'pcm24');
    });

    // Three lavs against ONE boom region, plus a fourth pair whose reference is
    // a different region (so the dedupe must produce exactly two decodes), plus
    // a failing pair so the CLI keeps the scratch files for inspection.
    const refA = { mediaPath: join(dir, 'boom.wav'), startSec: 0, durationSec: seconds };
    const refB = { mediaPath: join(dir, 'boom.wav'), startSec: 1, durationSec: seconds - 2 };
    const pairs = delaysMs.map((ms, i) => ({
      id: `lav${i}`,
      ref: { ...refA },
      target: { mediaPath: join(dir, `lav${i}.wav`), startSec: 0, durationSec: seconds },
      outputPath: join(dir, 'out', `lav${i}.wav`),
    }));
    pairs.push({
      id: 'otherRegion',
      ref: { ...refB },
      target: { mediaPath: join(dir, 'lav0.wav'), startSec: 1, durationSec: seconds - 2 },
      outputPath: join(dir, 'out', 'otherRegion.wav'),
    });
    pairs.push({
      id: 'bad',
      ref: { ...refA },
      target: { mediaPath: join(dir, 'other.wav'), startSec: 0, durationSec: seconds },
      outputPath: join(dir, 'out', 'bad.wav'),
    });

    const tempDir = join(dir, 'tmp');
    writeFileSync(join(dir, 'job.json'), JSON.stringify({
      ffmpegPath: FFMPEG,
      tempDir,
      concurrency: 3,
      params: { mode: 'static' },
      pairs,
    }));

    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [CLI, 'run', join(dir, 'job.json')], { encoding: 'utf8' });
    } catch (e) {
      stdout = e.stdout; // exit 2 is expected: one pair fails on purpose
    }
    const evts = stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

    const start = evts.find((e) => e.event === 'start');
    assert.equal(start.pairs, 5);
    const done = evts.find((e) => e.event === 'done');
    assert.equal(done.ok, 4, `expected 4 ok, got ${done.ok}`);
    assert.equal(done.failed, 1, `expected 1 failed, got ${done.failed}`);

    // Every pair reports exactly once, whatever order the pool finished in.
    const results = evts.filter((e) => e.event === 'result');
    assert.equal(results.length, 5);
    assert.equal(new Set(results.map((r) => r.id)).size, 5, 'no duplicate or lost results');

    for (const [i, ms] of delaysMs.entries()) {
      const r = results.find((e) => e.id === `lav${i}`);
      assert.equal(r.status, 'ok', `lav${i}: ${r.reason}`);
      assert.ok(Math.abs(r.staticDelayMs - ms) < 0.5, `lav${i} delay ${r.staticDelayMs} != ${ms}`);
      const out = readWav(r.outputPath);
      const depth = nullDepthDb(boom.subarray(0, out.data[0].length), out.data[0]);
      assert.ok(depth > 20, `lav${i} null depth ${depth} dB`);
    }
    assert.equal(results.find((e) => e.id === 'bad').status, 'failed');

    // Five pairs, two distinct reference regions, so exactly two decodes. The
    // failing pair keeps cleanup from running, which is what makes this
    // observable at all.
    const refWavs = readdirSync(tempDir).filter((f) => /^ref-\d+\.wav$/.test(f));
    assert.equal(refWavs.length, 2, `expected 2 shared reference decodes, got ${refWavs.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
