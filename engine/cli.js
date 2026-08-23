#!/usr/bin/env node
// Unphased engine CLI.
//   node cli.js run <job.json>        align pairs per the job protocol (NDJSON on stdout)
//   node cli.js gen-fixtures <dir>    generate test media with known ground truth

import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeJob, normalizeAutoMixJob } from './src/job.js';
import { runAutoMix } from './src/autoMixRun.js';
import { resolveFfmpeg, probeAudio } from './src/decode.js';
import { writeWav } from './src/wavFile.js';
import { extractRef, regionKey } from './src/runPair.js';
import { planConcurrency, runPairs } from './src/pool.js';
import { events } from './src/progress.js';

async function runJob(jobPath) {
  // strip a UTF-8 BOM: hand-authored job files (PowerShell Out-File, Notepad)
  // routinely carry one and JSON.parse rejects it
  const raw = readFileSync(jobPath, 'utf8').replace(/^﻿/, '');
  const job = normalizeJob(JSON.parse(raw));
  // normalizeJob is pure (shared with UXP); the scratch dir is ours to create.
  job.tempDir = job.tempDir || join(tmpdir(), 'Unphased', `job-${process.pid}`);
  mkdirSync(job.tempDir, { recursive: true });
  const ffmpegPath = resolveFfmpeg(job.ffmpegPath);
  const fs48 = job.sampleRate;
  events.start(job.pairs.length);
  let ok = 0;
  let failed = 0;
  const scratch = new Set();

  // Every lav in a take is matched against the same boom region, so the
  // reference descriptors collide exactly. Decoding once per distinct region
  // instead of once per pair removes N-1 identical ffmpeg runs, and gives the
  // workers a file they can all read rather than a cache they would have to
  // share across threads.
  const refPathFor = new Map();
  for (const pair of job.pairs) {
    const key = regionKey(pair.ref, fs48);
    if (!refPathFor.has(key)) refPathFor.set(key, join(job.tempDir, `ref-${refPathFor.size}.wav`));
  }
  try {
    for (const [key, outPath] of refPathFor) {
      const pair = job.pairs.find((p) => regionKey(p.ref, fs48) === key);
      await extractRef({ ffmpegPath, ref: pair.ref, outPath, sampleRate: fs48 });
      scratch.add(outPath);
    }
  } catch (err) {
    events.error(null, `reference extraction failed: ${String(err.message || err)}`);
    events.done(0, job.pairs.length);
    return 2;
  }

  const tasks = job.pairs.map((pair) => ({
    pair,
    refWavPath: refPathFor.get(regionKey(pair.ref, fs48)),
  }));
  const limit = planConcurrency(job.pairs, { override: job.concurrency });

  await runPairs({
    job,
    ffmpegPath,
    tasks,
    limit,
    onPhase: (id, phase, pct) => events.phase(id, phase, pct),
    onResult: (id, r) => {
      if (r.tgtWavPath) scratch.add(r.tgtWavPath);
      if (r.ok) ok++; else failed++;
      events.result(id, r.payload);
    },
  });

  events.done(ok, failed);
  // Clean only the extracted scratch WAVs, never the temp dir itself — it
  // holds job.json, which callers re-run and inspect. Keep them when a pair
  // failed so the inputs can be examined.
  if (failed === 0) {
    for (const path of scratch) rmSync(path, { force: true });
  }
  return failed === 0 ? 0 : 2;
}

async function runAutoMixJob(jobPath) {
  const raw = readFileSync(jobPath, 'utf8').replace(/^﻿/, '');
  const job = normalizeAutoMixJob(JSON.parse(raw));
  job.tempDir = job.tempDir || join(tmpdir(), 'Unphased', `automix-${process.pid}`);
  mkdirSync(job.tempDir, { recursive: true });
  const ffmpegPath = resolveFfmpeg(job.ffmpegPath);

  events.startAutoMix(job.mics.length);
  let result;
  try {
    result = await runAutoMix({
      ffmpegPath,
      job,
      onPhase: (id, phase, pct) => events.phase(id, phase, pct),
      onMic: (id, payload) => events.result(id, payload),
      onSummary: (payload) => events.summary(payload),
    });
  } catch (err) {
    events.error(null, String(err.message || err));
    events.done(0, job.mics.length);
    return 2;
  }
  events.done(result.ok, result.failed);
  return result.failed === 0 ? 0 : 2;
}

async function genFixtures(dir) {
  const { speechLike, varyingDelay, fftDelay, addNoise, scale, allpassChain } = await import('./test/fixtures.js');
  mkdirSync(dir, { recursive: true });
  const sampleRate = 48000;
  const { signal: boom } = speechLike({ seconds: 30, seed: 71 });
  writeWav(join(dir, 'boom.wav'), { sampleRate, data: [boom] }, 'pcm24');

  // lav1: 18 ms delay drifting to 21 ms, polarity flipped, -6 dB, light noise
  const drift1 = (n) => (0.018 + 0.003 * (n / sampleRate / 30)) * sampleRate;
  let lav1 = varyingDelay(boom, drift1);
  lav1 = scale(lav1, -6);
  for (let i = 0; i < lav1.length; i++) lav1[i] = -lav1[i];
  lav1 = addNoise(lav1, 30, 711);
  writeWav(join(dir, 'lav1.wav'), { sampleRate, data: [lav1] }, 'pcm24');

  // lav2: static 7.3 ms delay with allpass phase smear
  const lav2 = allpassChain(fftDelay(boom, 0.0073 * sampleRate));
  writeWav(join(dir, 'lav2.wav'), { sampleRate, data: [lav2] }, 'pcm24');

  const truth = {
    sampleRate,
    seconds: 30,
    boom: 'boom.wav',
    lav1: { file: 'lav1.wav', delayMs: [18, 21], polarityInverted: true, gainDb: -6 },
    lav2: { file: 'lav2.wav', delayMs: 7.3, allpass: true },
  };
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'ground-truth.json'), JSON.stringify(truth, null, 2));
  console.log(`fixtures written to ${dir}`);
  return 0;
}

/** probe <paths.json> — report audio stream/channel layout for each media path */
async function probe(listPath) {
  const raw = readFileSync(listPath, 'utf8').replace(/^﻿/, '');
  const { ffmpegPath, paths } = JSON.parse(raw);
  const ff = resolveFfmpeg(ffmpegPath);
  const out = {};
  for (const p of paths) {
    out[p] = await probeAudio({ ffmpegPath: ff, mediaPath: p });
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return 0;
}

const [, , cmd, arg] = process.argv;
try {
  if (cmd === 'run' && arg) {
    process.exitCode = await runJob(arg);
  } else if (cmd === 'automix' && arg) {
    process.exitCode = await runAutoMixJob(arg);
  } else if (cmd === 'gen-fixtures' && arg) {
    process.exitCode = await genFixtures(arg);
  } else if (cmd === 'probe' && arg) {
    process.exitCode = await probe(arg);
  } else {
    console.error('usage: node cli.js run <job.json> | automix <job.json> | gen-fixtures <dir> | probe <paths.json>');
    process.exitCode = 1;
  }
} catch (err) {
  events.error(null, String(err.message || err));
  process.exitCode = 1;
}
