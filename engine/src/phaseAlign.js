// Spectral phase correction: after time alignment, measure the remaining
// frequency-dependent phase difference between reference and target (mic
// bodies, windshields, analog chains) and rotate the target's spectrum to
// match.
//
// Measurement is separated from application for two reasons: a multichannel
// target applies one measured correction to every channel, and the correction
// can be measured on a 48 kHz mono analysis signal but applied at the source
// rate.
//
// Phase is smoothed in the COMPLEX domain (averaging unit vectors), which
// sidesteps unwrapping entirely.
//
// C1: measurement is block-wise over time and interpolated between block
// centres, so phase relationships that drift as talent moves are tracked
// rather than averaged into one compromise curve.

import { fftInPlace, fft2Real, ifft2Real } from './fft.js';
import { rmsOf, db, adaptiveGateDb } from './coarse.js';

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * Measure the phase rotation to apply to `tgt` so it matches `ref`.
 * @returns {{ blocks: Array<{center:number, sRe:Float64Array, sIm:Float64Array}>,
 *             fftSize, hop, applied:boolean, coherentFraction:number }}
 *   Each block holds a unit-magnitude rotation per bin. `applied:false` means
 *   no usable correction was found and the caller should pass audio through.
 */
export function measurePhase(ref, tgt, opts = {}) {
  const {
    fftSize = 4096,
    hop = 1024,
    rmsGateDb = null, // null => derive from the reference's own level
    coherenceThreshold = 0.25,
    smoothBins = 5,
    blockSeconds = 0,       // 0 = single static curve (legacy behaviour)
    sampleRate = 48000,
    minFramesPerBlock = 8,
  } = opts;
  const n = Math.min(ref.length, tgt.length);
  const half = fftSize / 2;
  const win = hann(fftSize);
  const gateDb = rmsGateDb === null ? adaptiveGateDb(ref) : rmsGateDb;

  // Frame boundaries for each time block. blockSeconds === 0 collapses to one
  // block spanning everything.
  const blockLen = blockSeconds > 0 ? Math.round(blockSeconds * sampleRate) : n;
  const nBlocks = blockSeconds > 0 ? Math.max(1, Math.ceil(n / blockLen)) : 1;

  const acc = [];
  for (let b = 0; b < nBlocks; b++) {
    acc.push({
      crossRe: new Float64Array(half + 1),
      crossIm: new Float64Array(half + 1),
      powRef: new Float64Array(half + 1),
      powTgt: new Float64Array(half + 1),
      frames: 0,
      sumCenter: 0,
    });
  }

  const xRe = new Float64Array(fftSize);
  const xIm = new Float64Array(fftSize);
  const yRe = new Float64Array(fftSize);
  const yIm = new Float64Array(fftSize);
  let totalFrames = 0;

  for (let t0 = 0; t0 + fftSize <= n; t0 += hop) {
    if (db(rmsOf(ref, t0, t0 + fftSize)) < gateDb) continue;
    for (let i = 0; i < fftSize; i++) {
      xRe[i] = ref[t0 + i] * win[i];
      yRe[i] = tgt[t0 + i] * win[i];
    }
    fft2Real(xRe, xIm, yRe, yIm);
    const center = t0 + fftSize / 2;
    const b = Math.min(nBlocks - 1, Math.floor(center / blockLen));
    const a = acc[b];
    for (let k = 0; k <= half; k++) {
      a.crossRe[k] += xRe[k] * yRe[k] + xIm[k] * yIm[k]; // conj(X) * Y
      a.crossIm[k] += xRe[k] * yIm[k] - xIm[k] * yRe[k];
      a.powRef[k] += xRe[k] * xRe[k] + xIm[k] * xIm[k];
      a.powTgt[k] += yRe[k] * yRe[k] + yIm[k] * yIm[k];
    }
    a.frames++;
    a.sumCenter += center;
    totalFrames++;
  }

  if (totalFrames < 4) {
    return { blocks: [], fftSize, hop, applied: false, coherentFraction: 0 };
  }

  // Blocks too sparse to measure on their own are merged into their neighbour
  // so a quiet stretch doesn't produce a garbage curve.
  const usable = acc.filter((a) => a.frames >= minFramesPerBlock);
  const pool = usable.length ? usable : [acc.reduce((m, a) => (a.frames > m.frames ? a : m), acc[0])];

  const blocks = [];
  let coherentTotal = 0;
  for (const a of pool) {
    const uRe = new Float64Array(half + 1);
    const uIm = new Float64Array(half + 1);
    let coherent = 0;
    for (let k = 0; k <= half; k++) {
      const mag2 = a.crossRe[k] * a.crossRe[k] + a.crossIm[k] * a.crossIm[k];
      const denom = a.powRef[k] * a.powTgt[k];
      const coh = denom > 0 ? mag2 / denom : 0;
      if (coh >= coherenceThreshold && mag2 > 0) {
        const mag = Math.sqrt(mag2);
        // weight by coherence so marginal bins pull the smoothed phase less
        uRe[k] = (a.crossRe[k] / mag) * coh;
        uIm[k] = (a.crossIm[k] / mag) * coh;
        coherent++;
      }
    }
    if (coherent < 8) continue;
    coherentTotal += coherent / (half + 1);

    const sRe = new Float64Array(half + 1);
    const sIm = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) {
      let re = 0;
      let im = 0;
      for (let j = -smoothBins; j <= smoothBins; j++) {
        const kk = k + j;
        if (kk < 0 || kk > half) continue;
        re += uRe[kk];
        im += uIm[kk];
      }
      const mag = Math.sqrt(re * re + im * im);
      if (mag > 1e-12) {
        // rotation to apply to target = conj(measured phase of conj(X)*Y)
        sRe[k] = re / mag;
        sIm[k] = -im / mag;
      } else {
        sRe[k] = 1;
        sIm[k] = 0;
      }
    }
    sRe[0] = 1; sIm[0] = 0;          // keep DC real
    sRe[half] = 1; sIm[half] = 0;    // and Nyquist
    blocks.push({ center: a.sumCenter / a.frames, sRe, sIm });
  }

  if (!blocks.length) {
    return { blocks: [], fftSize, hop, applied: false, coherentFraction: 0 };
  }
  blocks.sort((p, q) => p.center - q.center);
  return {
    blocks,
    fftSize,
    hop,
    applied: true,
    coherentFraction: coherentTotal / blocks.length,
  };
}

/**
 * Interpolate between block rotations at a given position, in the complex
 * domain so the result stays unit-magnitude and unwrapping never arises.
 */
function rotationAt(blocks, pos, half, outRe, outIm) {
  if (blocks.length === 1) {
    outRe.set(blocks[0].sRe);
    outIm.set(blocks[0].sIm);
    return;
  }
  let i = 0;
  while (i < blocks.length - 2 && pos > blocks[i + 1].center) i++;
  const a = blocks[i];
  const b = blocks[i + 1];
  let w = (pos - a.center) / (b.center - a.center);
  if (!(w > 0)) w = 0;
  if (w > 1) w = 1;
  for (let k = 0; k <= half; k++) {
    const re = a.sRe[k] + (b.sRe[k] - a.sRe[k]) * w;
    const im = a.sIm[k] + (b.sIm[k] - a.sIm[k]) * w;
    // sqrt, not hypot: this runs for every bin of every frame, and hypot's
    // overflow-safe scaling costs several times a plain multiply-add for
    // magnitudes that are bounded by 1 here anyway
    const mag = Math.sqrt(re * re + im * im);
    if (mag > 1e-12) {
      outRe[k] = re / mag;
      outIm[k] = im / mag;
    } else {
      outRe[k] = 1;
      outIm[k] = 0;
    }
  }
}

/**
 * Apply a measured rotation to a signal via STFT overlap-add.
 * @param {Float64Array} signal
 * @param {object} measured result of measurePhase
 * @param {number} rateScale signal rate / measurement rate (curve positions
 *   are in measurement samples; > 1 when rendering at a higher rate)
 */
/** Window one analysis frame of `signal` starting at t0 into dst. */
function loadFrame(dst, signal, t0, win, fftSize) {
  for (let i = 0; i < fftSize; i++) dst[i] = signal[t0 + i] * win[i];
}

/**
 * Rotate a spectrum in place by the rotation measured at this frame's centre,
 * keeping the result conjugate-symmetric so it inverts back to a real signal.
 */
function rotateSpectrum(re, im, measured, t0, rateScale, half, fftSize, sRe, sIm) {
  rotationAt(measured.blocks, (t0 + fftSize / 2) / rateScale, half, sRe, sIm);
  for (let k = 0; k <= half; k++) {
    const r = re[k] * sRe[k] - im[k] * sIm[k];
    const i2 = re[k] * sIm[k] + im[k] * sRe[k];
    re[k] = r;
    im[k] = i2;
    if (k > 0 && k < half) {
      re[fftSize - k] = r;
      im[fftSize - k] = -i2;
    }
  }
}

function overlapAdd(out, norm, src, t0, win, win2, fftSize) {
  for (let i = 0; i < fftSize; i++) {
    out[t0 + i] += src[i] * win[i];
    norm[t0 + i] += win2[i];
  }
}

export function applyPhase(signal, measured, rateScale = 1) {
  if (!measured.applied || !measured.blocks.length) return signal;
  const fftSize = measured.fftSize;
  const hop = measured.hop;
  const half = fftSize / 2;
  const win = hann(fftSize);
  const win2 = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) win2[i] = win[i] * win[i];
  const n = signal.length;
  const out = new Float64Array(n);
  const norm = new Float64Array(n);
  const aRe = new Float64Array(fftSize);
  const aIm = new Float64Array(fftSize);
  const bRe = new Float64Array(fftSize);
  const bIm = new Float64Array(fftSize);
  const sRe = new Float64Array(half + 1);
  const sIm = new Float64Array(half + 1);

  // Frames are processed two at a time. Both are real going in, so one packed
  // transform produces both spectra; both rotated spectra are conjugate-
  // symmetric coming out, so one packed inverse produces both signals. That
  // halves the transform count, which is where this function spends most of
  // its time.
  const last = n - fftSize;
  let t0 = 0;
  for (; t0 + hop <= last; t0 += 2 * hop) {
    const t1 = t0 + hop;
    loadFrame(aRe, signal, t0, win, fftSize);
    loadFrame(bRe, signal, t1, win, fftSize);
    fft2Real(aRe, aIm, bRe, bIm);
    rotateSpectrum(aRe, aIm, measured, t0, rateScale, half, fftSize, sRe, sIm);
    rotateSpectrum(bRe, bIm, measured, t1, rateScale, half, fftSize, sRe, sIm);
    // leaves the first frame's samples in aRe and the second's in aIm
    ifft2Real(aRe, aIm, bRe, bIm);
    overlapAdd(out, norm, aRe, t0, win, win2, fftSize);
    overlapAdd(out, norm, aIm, t1, win, win2, fftSize);
  }
  // an odd frame count leaves one frame with no partner
  for (; t0 <= last; t0 += hop) {
    loadFrame(aRe, signal, t0, win, fftSize);
    aIm.fill(0);
    fftInPlace(aRe, aIm);
    rotateSpectrum(aRe, aIm, measured, t0, rateScale, half, fftSize, sRe, sIm);
    fftInPlace(aRe, aIm, true);
    overlapAdd(out, norm, aRe, t0, win, win2, fftSize);
  }

  for (let i = 0; i < n; i++) {
    out[i] = norm[i] > 1e-8 ? out[i] / norm[i] : signal[i];
  }
  return out;
}

/** Convenience wrapper: measure and apply in one step (used by tests). */
export function phaseAlign(ref, tgt, opts = {}) {
  const measured = measurePhase(ref, tgt, opts);
  return {
    out: measured.applied ? applyPhase(tgt, measured) : tgt,
    applied: measured.applied,
    coherentFraction: measured.coherentFraction,
    measured,
  };
}
