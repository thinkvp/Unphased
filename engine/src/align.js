// Per-pair alignment pipeline: coarse static offset -> (dynamic refinement,
// M2) -> polarity -> render -> (spectral phase, M3) -> null-depth metric.

import { estimateStaticOffset, rmsOf } from './coarse.js';
import { detectPolarity } from './polarity.js';
import { applyDelayCurve } from './varyDelay.js';
import { buildLattice } from './lattice.js';
import { solvePath, expandPath, AGILITY } from './pathSolver.js';
import { measurePhase, applyPhase } from './phaseAlign.js';
import { estimateBandWeights } from './coherence.js';
import { decimate, COARSE_DECIMATION } from './decimate.js';

// The widest offset 'auto' will look for. The search used to climb a ladder of
// ever-wider windows because a wide full-rate search was expensive; run on a
// decimated copy it is cheap enough to always cover the whole range at once,
// which is both faster and more robust than hoping a narrow rung suffices.
export const AUTO_SHIFT_MAX = 2000;
// Blocks correlated per coarse pass, spread evenly across the clip.
export const COARSE_MAX_BLOCKS = 24;
// The decimated search only has to land inside the confirm window; the confirm
// pass is what produces the precision. Never narrower than the drift the
// lattice expects, or genuinely drifting blocks would fall outside it.
export const CONFIRM_WINDOW_MS = 15;
// A short confirm block keeps its FFT small: 2*8192 + 2*720 fits in 32768,
// against the 131072 a 1 s block would need.
export const CONFIRM_BLOCK_SAMPLES = 8192;

export const DEFAULT_PARAMS = {
  // 'auto' searches +/-AUTO_SHIFT_MAX; a number pins the window to that width
  maxShiftMs: 'auto',
  mode: 'dynamic', // 'static' | 'dynamic'
  maxDriftMs: 15,
  driftAgility: 'medium', // 'low' | 'medium' | 'high'
  polarity: 'auto', // 'auto' | 'off'
  phase: 'auto', // 'auto' | 'off'
  phaseBlockSeconds: 20, // 0 = one static curve for the whole clip
  bandWeighting: 'auto', // 'auto' | 'off' — coherence-weighted correlation
  confidenceGate: 1.5,
};

/**
 * Residual energy of (ref - g*aligned) relative to ref, with the optimal
 * scalar gain g, in dB. Higher is better; >= 20 dB means a deep null.
 *
 * g is clamped to be non-negative on purpose: an unclamped optimal gain goes
 * negative for a polarity-inverted signal and reports a deep null for audio
 * that would cancel the reference when summed — the exact fault this metric
 * exists to catch.
 */
export function nullDepthDb(ref, aligned) {
  const n = Math.min(ref.length, aligned.length);
  let dot = 0, ea = 0, er = 0;
  for (let i = 0; i < n; i++) {
    dot += ref[i] * aligned[i];
    ea += aligned[i] * aligned[i];
    er += ref[i] * ref[i];
  }
  if (ea === 0 || er === 0) return 0;
  const g = Math.max(0, dot / ea);
  let res = 0;
  for (let i = 0; i < n; i++) {
    const d = ref[i] - g * aligned[i];
    res += d * d;
  }
  if (res === 0) return Infinity;
  return 10 * Math.log10(er / res);
}

/**
 * Null depth as a listener would judge it: nullDepthDb over short windows, each
 * with its own gain, and the median of the windows that carry sound.
 *
 * One gain for a whole clip is the wrong yardstick for a long take. The level
 * ratio between a lav and a camera mic moves as people turn, lean and walk, so
 * no single gain cancels well throughout, and a 43-minute interview measured
 * that way read 1-2 dB while every 2-second stretch of it nulled 3-7 dB, with
 * the timing exact to 0.1 ms. Per-window gain removes that, and nothing else:
 * a window that is out of time or inverted still cannot cancel, because the
 * gain stays clamped non-negative. The median keeps a few odd stretches (a
 * cough on one mic, a door) from deciding the number.
 *
 * Quiet windows are skipped: room tone on two mics is uncorrelated noise and
 * would pull the median towards 0 dB on material with long pauses. "Quiet" is
 * relative to the clip's own loud windows, so a recording made low still
 * counts. A clip shorter than two windows falls back to the whole-clip figure.
 */
export function windowedNullDepthDb(ref, aligned, { sampleRate, windowSec = 2, quietDb = 30 } = {}) {
  const n = Math.min(ref.length, aligned.length);
  const w = Math.max(1, Math.round(windowSec * sampleRate));
  const count = Math.floor(n / w);
  if (count < 2) return nullDepthDb(ref, aligned);
  const energy = new Float64Array(count);
  const depth = new Float64Array(count);
  for (let k = 0; k < count; k++) {
    let dot = 0, ea = 0, er = 0;
    const a0 = k * w;
    for (let i = a0; i < a0 + w; i++) {
      dot += ref[i] * aligned[i];
      ea += aligned[i] * aligned[i];
      er += ref[i] * ref[i];
    }
    energy[k] = er;
    if (ea === 0 || er === 0) { depth[k] = 0; continue; }
    const g = Math.max(0, dot / ea);
    // |r - g a|^2 = er - 2 g dot + g^2 ea, without a second pass
    const res = Math.max(er - 2 * g * dot + g * g * ea, er * 1e-12);
    depth[k] = 10 * Math.log10(er / res);
  }
  // Loud reference: the 90th-percentile window, so one clap cannot set it.
  const sorted = Float64Array.from(energy).sort();
  const loud = sorted[Math.floor(0.9 * (count - 1))];
  if (!(loud > 0)) return nullDepthDb(ref, aligned);
  const floor = loud * Math.pow(10, -quietDb / 10);
  const kept = [];
  for (let k = 0; k < count; k++) if (energy[k] >= floor) kept.push(depth[k]);
  if (!kept.length) return nullDepthDb(ref, aligned);
  kept.sort((x, y) => x - y);
  const m = kept.length >> 1;
  return kept.length % 2 ? kept[m] : (kept[m - 1] + kept[m]) / 2;
}

/**
 * Apply a correction produced by alignPair to one channel of audio, at a
 * possibly different sample rate. The delay curve is in analysis-rate samples,
 * so both its values and its time axis are scaled by rateScale.
 *
 * @param {Float64Array} channel full extracted channel, including handles
 * @param {object} correction from alignPair
 * @param {number} outLen output length in render-rate samples
 * @param {number} renderRate sample rate of `channel`
 */
export function renderChannel(channel, correction, outLen, renderRate) {
  const { delayCurve, polarityInverted, phase, analysisRate, tgtOffsetSamples } = correction;
  const scale = renderRate / analysisRate;

  let curve;
  if (typeof delayCurve === 'number') {
    curve = delayCurve * scale;
  } else {
    // resample the per-sample curve onto the render timebase
    curve = new Float64Array(outLen);
    const srcLen = delayCurve.length;
    for (let i = 0; i < outLen; i++) {
      const p = i / scale;
      const j = Math.floor(p);
      const f = p - j;
      const a = delayCurve[j < srcLen ? j : srcLen - 1];
      const b = delayCurve[j + 1 < srcLen ? j + 1 : srcLen - 1];
      curve[i] = (a + (b - a) * f) * scale;
    }
  }

  let out = applyDelayCurve(channel, curve, outLen, Math.round(tgtOffsetSamples * scale));
  if (polarityInverted) {
    for (let i = 0; i < out.length; i++) out[i] = -out[i];
  }
  if (phase && phase.applied) out = applyPhase(out, phase, scale);
  return out;
}

/**
 * Locate the static offset over the whole search window, on decimated signals.
 *
 * Asking the user for a window is a trap: guess too narrow and the estimator
 * returns a confident answer pinned to the edge of the window, which looks
 * exactly like a correct one. Searching the full range every time removes the
 * guess, and decimating pays for it — this stage's answer is rounded and handed
 * to buildLattice, which re-searches it at full rate, so its own precision is
 * nearly irrelevant. Only mode 'static' consumes it directly, which is what the
 * confirm pass in alignPair exists to serve.
 *
 * @returns {{ result: object, windowMs: number }} the estimate, in FULL-RATE
 *   samples, plus the window that was searched
 */
function searchStaticOffset(ref, tgt, opts) {
  const { maxShiftMs, sampleRate, ...rest } = opts;
  const windowMs = maxShiftMs === 'auto' ? AUTO_SHIFT_MAX : maxShiftMs;
  const base = {
    ...rest,
    sampleRate: sampleRate / COARSE_DECIMATION,
    maxShiftMs: windowMs,
  };
  const refD = decimate(ref, COARSE_DECIMATION);
  const tgtD = decimate(tgt, COARSE_DECIMATION);

  let result = estimateStaticOffset(refD, tgtD, { ...base, maxBlocks: COARSE_MAX_BLOCKS });
  if (!result.ok && result.reason !== 'too-short') {
    // The sparse grid can land entirely on silence, or on the one stretch where
    // the two mics genuinely disagree. Densifying costs what the old fixed
    // stride always cost, so it is only paid on material that needs it.
    result = estimateStaticOffset(refD, tgtD, { ...base, maxBlocks: null });
  }
  if (result.ok) result.offsetSamples *= COARSE_DECIMATION;
  return { result, windowMs };
}

/**
 * Re-measure a known-roughly offset at full rate in a narrow window, which is
 * where the sub-sample precision actually comes from. Also the pass that gets
 * to use the coherence band weights, so the weighted estimate costs one pass
 * rather than a second full-width sweep.
 */
function confirmStaticOffset(ref, tgt, centerSamples, opts) {
  const { sampleRate, windowMs, ...rest } = opts;
  const blockSec = CONFIRM_BLOCK_SAMPLES / sampleRate;
  return estimateStaticOffset(ref, tgt, {
    ...rest,
    sampleRate,
    // a pinned window is a ceiling on how far we may look, not just a hint
    maxShiftMs: Math.min(CONFIRM_WINDOW_MS, windowMs),
    blockSec,
    hopSec: blockSec,
    centerSamples,
    maxBlocks: COARSE_MAX_BLOCKS,
  });
}

/**
 * @param {object} args { ref, tgt: Float64Array, sampleRate, params, tgtOffsetSamples }
 *   ref[0] corresponds to the start of the span to align. When the target was
 *   extracted with handles, tgtOffsetSamples says how many samples of tgt
 *   precede that instant: tgt[tgtOffsetSamples] is coincident with ref[0].
 *   Estimation runs on the coincident spans; rendering reads from the full
 *   padded target so negative delays never fall off the buffer edge.
 * @returns {{ status, reason?, aligned?, delayCurve?, report }}
 */
export function alignPair({ ref, tgt, sampleRate, params = {}, tgtOffsetSamples = 0 }) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const outLen = ref.length;
  const tgtV = tgtOffsetSamples > 0 ? tgt.subarray(tgtOffsetSamples) : tgt;

  const searchOpts = {
    sampleRate,
    confidenceGate: p.confidenceGate,
    agreementToleranceMs: Math.max(2, p.maxDriftMs),
  };
  const { result: coarse, windowMs: searchWindowMs } = searchStaticOffset(ref, tgtV, {
    ...searchOpts,
    maxShiftMs: p.maxShiftMs,
  });
  if (!coarse.ok) {
    return { status: 'failed', reason: coarse.reason, report: { blocks: coarse.blocks.length, searchWindowMs } };
  }
  let d0 = coarse.offsetSamples;

  // With a rough alignment in hand, measure which bands the two mics actually
  // share. Bands full of independent noise (wireless hiss, handling rumble)
  // stop voting in the confirm pass below.
  let bandWeights = null;
  let meanCoherence = null;
  if (p.bandWeighting === 'auto') {
    const bw = estimateBandWeights(ref, tgtV, d0, { sampleRate });
    if (bw.weights) {
      bandWeights = bw.weights;
      meanCoherence = bw.meanCoherence;
    }
  }

  // The wide search ran decimated, so d0 is only good to a few samples. This is
  // where the precision comes from — and in mode 'static' d0 is the whole
  // answer, so it runs whether or not band weighting is on.
  const confirmed = confirmStaticOffset(ref, tgtV, d0, {
    ...searchOpts,
    windowMs: searchWindowMs,
    bandWeights,
  });
  if (confirmed.ok) {
    d0 = confirmed.offsetSamples;
    coarse.confidence = Math.max(coarse.confidence, confirmed.confidence);
  }

  // Resolve polarity first and fold it into the signal, so drift tracking,
  // rendering and phase alignment all operate on a correctly-signed target.
  let polarityInverted = false;
  if (p.polarity === 'auto') {
    polarityInverted = detectPolarity(ref, tgtV, d0, { sampleRate }).inverted;
  }
  let tgtWork = tgt;
  if (polarityInverted) {
    tgtWork = new Float64Array(tgt.length);
    for (let i = 0; i < tgt.length; i++) tgtWork[i] = -tgt[i];
  }
  const tgtWorkV = tgtOffsetSamples > 0 ? tgtWork.subarray(tgtOffsetSamples) : tgtWork;

  let delayCurve = d0; // constant unless dynamic mode refines it
  let driftRangeMs = [0, 0];
  if (p.mode === 'dynamic') {
    const d0Int = Math.round(d0);
    const lattice = buildLattice(ref, tgtWorkV, d0Int, {
      sampleRate,
      maxDriftMs: p.maxDriftMs,
      confidenceGate: p.confidenceGate,
      bandWeights,
    });
    const { slopeLimit } = AGILITY[p.driftAgility] || AGILITY.medium;
    const { lags, gatedMask } = solvePath(lattice, { slopeLimit });
    let anyConfident = false;
    for (let i = 0; i < gatedMask.length; i++) {
      if (gatedMask[i] === 0) { anyConfident = true; break; }
    }
    if (anyConfident) {
      const residual = expandPath(lattice, lags, outLen);
      const curve = new Float64Array(outLen);
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < outLen; i++) {
        curve[i] = d0Int + residual[i];
        if (residual[i] < min) min = residual[i];
        if (residual[i] > max) max = residual[i];
      }
      delayCurve = curve;
      driftRangeMs = [(min / sampleRate) * 1000, (max / sampleRate) * 1000];
    }
  }

  let aligned = applyDelayCurve(tgtWork, delayCurve, outLen, tgtOffsetSamples);

  let phaseApplied = false;
  let phaseMeasured = null;
  if (p.phase === 'auto') {
    phaseMeasured = measurePhase(ref, aligned, {
      sampleRate,
      blockSeconds: p.phaseBlockSeconds,
    });
    if (phaseMeasured.applied) {
      aligned = applyPhase(aligned, phaseMeasured);
      phaseApplied = true;
    }
  }

  const report = {
    staticDelayMs: (d0 / sampleRate) * 1000,
    driftRangeMs,
    polarityInverted,
    phaseApplied,
    confidence: coarse.confidence,
    searchWindowMs,
    meanCoherence,
    // The headline figure: median over 2-second windows (see
    // windowedNullDepthDb). The single-gain whole-clip figure is kept for
    // comparison; on a long take with moving talkers it reads far lower.
    nullDepthDb: windowedNullDepthDb(ref, aligned, { sampleRate }),
    nullDepthWholeDb: nullDepthDb(ref, aligned),
    refRmsDb: 20 * Math.log10(rmsOf(ref) + 1e-30),
  };
  return {
    status: report.confidence < 0.5 ? 'lowConfidence' : 'ok',
    aligned,
    // Everything a renderer needs to reproduce this correction on other
    // channels, or at a different sample rate, without re-analysing.
    correction: {
      delayCurve,
      polarityInverted,
      phase: phaseMeasured,
      analysisRate: sampleRate,
      tgtOffsetSamples,
    },
    delayCurve,
    report,
  };
}
