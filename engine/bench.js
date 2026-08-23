#!/usr/bin/env node
// Stage-by-stage benchmark for the alignment engine.
//   node bench.js              30 s and 300 s pairs
//   node bench.js 30           just the 30 s pair
//   node bench.js automix 60   auto-mix stages, 3 and 8 mics
//
// Two jobs, both of which have to be done together: report where the time goes,
// and report what the engine actually decided. A speedup that quietly moves
// staticDelayMs is not a speedup, so every run prints both and later phases are
// compared against a recorded baseline.

import { speechLike, varyingDelay, addNoise, scale, speakerRoom } from './test/fixtures.js';
import { estimateStaticOffset } from './src/coarse.js';
import { estimateBandWeights } from './src/coherence.js';
import { detectPolarity } from './src/polarity.js';
import { buildLattice } from './src/lattice.js';
import { solvePath, expandPath, AGILITY } from './src/pathSolver.js';
import { measurePhase, applyPhase } from './src/phaseAlign.js';
import { applyDelayCurve } from './src/varyDelay.js';
import { decimate, COARSE_DECIMATION } from './src/decimate.js';
import {
  attributeSpeakers, autoMixGains, simplifyGainCurve, ATTRIB_DECIMATION,
} from './src/autoMix.js';
import {
  alignPair, DEFAULT_PARAMS, AUTO_SHIFT_MAX,
  COARSE_MAX_BLOCKS, CONFIRM_WINDOW_MS, CONFIRM_BLOCK_SAMPLES,
} from './src/align.js';

const SAMPLE_RATE = 48000;
// Modelled on cli.js gen-fixtures' lav1 — 18 ms drifting to 21 ms, -6 dB, noise
// at 30 dB SNR — but deliberately NOT polarity-inverted.
//
// An inverted target makes nullDepthDb bimodal: the flip can be resolved either
// by detectPolarity or absorbed by applyPhase as a 180-degree rotation, the two
// routes null to depths ~3 dB apart, and which one wins turns on tiny changes
// anywhere upstream. That makes the number useless as a regression signal —
// it swings on changes that are provably neutral. Polarity handling is covered
// properly by engine/test/align.e2e.test.js and the gen-fixtures ground truth.
const DELAY_START_MS = 18;
const DELAY_END_MS = 21;

function buildPair(seconds) {
  const { signal: ref } = speechLike({ seconds, sampleRate: SAMPLE_RATE, seed: 71 });
  const span = (DELAY_END_MS - DELAY_START_MS) / 1000;
  const start = DELAY_START_MS / 1000;
  let tgt = varyingDelay(ref, (n) => (start + span * (n / SAMPLE_RATE / seconds)) * SAMPLE_RATE);
  tgt = addNoise(scale(tgt, -6), 30, 711);
  return { ref, tgt };
}

const rows = [];
function time(label, fn) {
  const t0 = process.hrtime.bigint();
  const r = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  rows.push({ label, ms });
  return r;
}

function printTable(total) {
  const w = Math.max(...rows.map((r) => r.label.length));
  for (const r of rows.sort((a, b) => b.ms - a.ms)) {
    const share = total > 0 ? ((r.ms / total) * 100).toFixed(1) : '0.0';
    console.log(`  ${r.label.padEnd(w)}  ${r.ms.toFixed(1).padStart(9)} ms  ${share.padStart(5)}%`);
  }
  rows.length = 0;
}

/**
 * Walk the stages alignPair walks, timing each. Deliberately duplicates the
 * orchestration in align.js rather than instrumenting it: the shipped path must
 * stay free of timing code, and a divergence between the two shows up as a
 * mismatch against the whole-pair alignPair timing printed alongside.
 */
function benchStages({ ref, tgt }) {
  const p = DEFAULT_PARAMS;
  const opts = {
    sampleRate: SAMPLE_RATE,
    confidenceGate: p.confidenceGate,
    agreementToleranceMs: Math.max(2, p.maxDriftMs),
  };

  const refD = time('decimate ref', () => decimate(ref, COARSE_DECIMATION));
  const tgtD = time('decimate tgt', () => decimate(tgt, COARSE_DECIMATION));
  const coarse = time(`wide search @${AUTO_SHIFT_MAX}ms (decimated)`, () =>
    estimateStaticOffset(refD, tgtD, {
      ...opts,
      sampleRate: SAMPLE_RATE / COARSE_DECIMATION,
      maxShiftMs: AUTO_SHIFT_MAX,
      maxBlocks: COARSE_MAX_BLOCKS,
    }));
  if (!coarse.ok) throw new Error(`coarse failed: ${coarse.reason}`);
  const d0 = coarse.offsetSamples * COARSE_DECIMATION;

  const bw = time('estimateBandWeights', () =>
    estimateBandWeights(ref, tgt, d0, { sampleRate: SAMPLE_RATE }));
  const blockSec = CONFIRM_BLOCK_SAMPLES / SAMPLE_RATE;
  const refined = time(`confirm @${CONFIRM_WINDOW_MS}ms (full rate)`, () =>
    estimateStaticOffset(ref, tgt, {
      ...opts,
      maxShiftMs: CONFIRM_WINDOW_MS,
      blockSec,
      hopSec: blockSec,
      centerSamples: d0,
      maxBlocks: COARSE_MAX_BLOCKS,
      bandWeights: bw.weights,
    }));
  time('detectPolarity', () => detectPolarity(ref, tgt, d0, { sampleRate: SAMPLE_RATE }));

  // alignPair only copies the target when it has to invert it; this fixture is
  // in phase, so the downstream stages see the target as-is.
  const tgtWork = tgt;

  const d0Int = Math.round(refined.ok ? refined.offsetSamples : d0);
  const lattice = time('buildLattice', () =>
    buildLattice(ref, tgtWork, d0Int, { sampleRate: SAMPLE_RATE, maxDriftMs: p.maxDriftMs, bandWeights: bw.weights }));
  const { lags } = time('solvePath (Viterbi)', () =>
    solvePath(lattice, { slopeLimit: AGILITY[p.driftAgility].slopeLimit }));
  const residual = time('expandPath', () => expandPath(lattice, lags, ref.length));

  // Time the per-sample curve, not a constant. applyDelayCurve has a fast path
  // for a scalar delay that dynamic mode never takes, and benching that path
  // hides the cost of the one that ships.
  const curve = new Float64Array(ref.length);
  for (let i = 0; i < ref.length; i++) curve[i] = d0Int + residual[i];

  const aligned = time('applyDelayCurve (per-sample)', () =>
    applyDelayCurve(tgtWork, curve, ref.length, 0));
  const measured = time('measurePhase', () =>
    measurePhase(ref, aligned, { sampleRate: SAMPLE_RATE, blockSeconds: p.phaseBlockSeconds }));
  if (measured.applied) time('applyPhase', () => applyPhase(aligned, measured));

  return { rowCount: lattice.rows.length, nLags: 2 * lattice.L + 1 };
}

function run(seconds) {
  console.log(`\n=== ${seconds} s pair @ ${SAMPLE_RATE} Hz ===`);
  const pair = buildPair(seconds);

  const shapes = benchStages(pair);
  const stageTotal = rows.reduce((s, r) => s + r.ms, 0);
  console.log(`\nstages (lattice ${shapes.rowCount} rows x ${shapes.nLags} lags):`);
  printTable(stageTotal);
  console.log(`  ${'TOTAL (stages)'.padEnd(34)}  ${stageTotal.toFixed(1).padStart(9)} ms`);

  const t0 = process.hrtime.bigint();
  const r = alignPair({ ref: pair.ref, tgt: pair.tgt, sampleRate: SAMPLE_RATE });
  const wholeMs = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  ${'alignPair (real path)'.padEnd(34)}  ${wholeMs.toFixed(1).padStart(9)} ms`);

  if (r.status === 'failed') {
    console.log(`\nRESULT  status=failed reason=${r.reason}`);
    return;
  }
  const rep = r.report;
  const [lo, hi] = rep.driftRangeMs;
  console.log(
    `\nRESULT  status=${r.status}` +
    `  staticDelayMs=${rep.staticDelayMs.toFixed(4)}` +
    `  driftRangeMs=[${lo.toFixed(4)}, ${hi.toFixed(4)}]` +
    `  polarityInverted=${rep.polarityInverted}` +
    `  phaseApplied=${rep.phaseApplied}` +
    `  confidence=${rep.confidence.toFixed(4)}` +
    `  searchWindowMs=${rep.searchWindowMs}` +
    `  nullDepthDb=${rep.nullDepthDb.toFixed(3)}`
  );
  // The fixture's true delay sweeps DELAY_START_MS -> DELAY_END_MS, so the
  // static estimate should land inside that span and the drift range should
  // cover the rest of it.
  const total = rep.staticDelayMs + (lo + hi) / 2;
  console.log(`        expected ~${DELAY_START_MS}-${DELAY_END_MS} ms, measured mean ${total.toFixed(4)} ms`);
}

/**
 * Auto-mix cost is driven by mic COUNT as much as by clip length. Candidate
 * pruning bounds the per-frame correlation pass, but it does NOT touch the sync
 * and baseline tiers, which still run once per unordered pair — so the total
 * stays O(K^2) and K=8 costs several times K=3 rather than roughly the same.
 * That is the number to watch: making the pairing cheaper for large casts means
 * attacking sync/baseline, not the frame loop.
 */
function runAutoMix(seconds, mics) {
  console.log(`
=== automix: ${mics} mics, ${seconds} s @ ${SAMPLE_RATE} Hz ===`);
  const fa = SAMPLE_RATE / ATTRIB_DECIMATION;
  const room = speakerRoom({
    seconds, sampleRate: SAMPLE_RATE, speakers: mics, seed: 71, noiseSnrDb: 30,
  });

  rows.length = 0;
  const small = time('decimate 48k->8k (all mics)', () =>
    room.mics.map((m) => decimate(m, ATTRIB_DECIMATION)));
  const attr = time('attribute (sync+baseline+frames)', () =>
    attributeSpeakers(small, { sampleRate: fa }));
  const gains = time('gains + ballistics', () => autoMixGains(attr, {}));
  const keys = time('simplify curve (all mics)', () =>
    gains.gainDb.map((g) => simplifyGainCurve(g, attr.frameCenters, { sampleRate: fa })));

  const total = rows.reduce((s, r) => s + r.ms, 0);
  printTable(total);
  console.log(`  ${'TOTAL'.padEnd(34)}  ${total.toFixed(1).padStart(9)} ms`);

  const usable = attr.pairs.filter((p) => p.usable).length;
  const spread = attr.pairs.map((p) => p.spreadMs.toFixed(1)).join('/');
  console.log(
    `
RESULT  frames=${attr.nFrames}` +
    `  pairs=${usable}/${attr.pairs.length} usable` +
    `  spreadMs=${spread}` +
    `  activeFraction=${gains.report.activeFraction.toFixed(3)}` +
    `  keys=${keys.map((k) => k.kept).join('/')}`
  );
}

const argv = process.argv.slice(2);
if (argv[0] === 'automix') {
  const secs = Number(argv[1]) > 0 ? Number(argv[1]) : 60;
  for (const mics of [3, 8]) runAutoMix(secs, mics);
} else {
  const args = argv.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  for (const seconds of args.length ? args : [30, 300]) run(seconds);
}
