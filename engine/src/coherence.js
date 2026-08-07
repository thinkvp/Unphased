// Per-band coherence weighting.
//
// Plain GCC-PHAT whitens every bin to unit magnitude, which gives a bin full
// of independent noise exactly as much say in the delay estimate as a bin
// carrying shared speech. When two mics differ badly in their noise content
// (HF hiss on a wireless lav, LF handling rumble, air conditioning) that
// wastes most of the spectrum on bins that carry no timing information.
//
// Magnitude-squared coherence measures how much of each band the two signals
// genuinely share, averaged over many frames. Used as a weight, it steers the
// correlation towards the bands that actually agree.

import { fft2Real } from './fft.js';
import { rmsOf, db, adaptiveGateDb } from './coarse.js';

export const WEIGHT_BINS = 512; // canonical grid, independent of any FFT size

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * Estimate magnitude-squared coherence per band between ref and tgt, with tgt
 * shifted by `lagSamples` so the two are roughly time-aligned first (coherence
 * of misaligned signals is meaningless).
 *
 * @returns {{ weights: Float64Array, meanCoherence: number, frames: number }}
 *   weights are on a canonical WEIGHT_BINS grid spanning DC..Nyquist, in [0,1].
 */
export function estimateBandWeights(ref, tgt, lagSamples, opts = {}) {
  const {
    fftSize = 2048,
    hop = 1024,
    rmsGateDb = null,
    exponent = 1,
    floor = 0.05,
    smoothBins = 3,
  } = opts;
  const half = fftSize / 2;
  const win = hann(fftSize);
  const gateDb = rmsGateDb === null ? adaptiveGateDb(ref) : rmsGateDb;
  const D = Math.round(lagSamples);

  const crossRe = new Float64Array(half + 1);
  const crossIm = new Float64Array(half + 1);
  const powRef = new Float64Array(half + 1);
  const powTgt = new Float64Array(half + 1);
  const xRe = new Float64Array(fftSize);
  const xIm = new Float64Array(fftSize);
  const yRe = new Float64Array(fftSize);
  const yIm = new Float64Array(fftSize);

  const len = Math.min(ref.length, tgt.length - D);
  let frames = 0;
  for (let t0 = Math.max(0, -D); t0 + fftSize <= len; t0 += hop) {
    if (db(rmsOf(ref, t0, t0 + fftSize)) < gateDb) continue;
    for (let i = 0; i < fftSize; i++) {
      xRe[i] = ref[t0 + i] * win[i];
      yRe[i] = tgt[t0 + D + i] * win[i];
    }
    fft2Real(xRe, xIm, yRe, yIm);
    for (let k = 0; k <= half; k++) {
      crossRe[k] += xRe[k] * yRe[k] + xIm[k] * yIm[k];
      crossIm[k] += xRe[k] * yIm[k] - xIm[k] * yRe[k];
      powRef[k] += xRe[k] * xRe[k] + xIm[k] * xIm[k];
      powTgt[k] += yRe[k] * yRe[k] + yIm[k] * yIm[k];
    }
    frames++;
  }

  if (frames < 8) {
    return { weights: null, meanCoherence: 0, frames };
  }

  const coh = new Float64Array(half + 1);
  let sum = 0;
  for (let k = 0; k <= half; k++) {
    const mag2 = crossRe[k] * crossRe[k] + crossIm[k] * crossIm[k];
    const denom = powRef[k] * powTgt[k];
    let c = denom > 0 ? mag2 / denom : 0;
    if (c > 1) c = 1;
    coh[k] = c;
    sum += c;
  }
  const meanCoherence = sum / (half + 1);

  // smooth across bins, then map to a weight with a floor so no band is
  // silenced outright (a fully-zeroed band can bias the correlation peak)
  const smoothed = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) {
    let acc = 0;
    let cnt = 0;
    for (let j = -smoothBins; j <= smoothBins; j++) {
      const kk = k + j;
      if (kk < 0 || kk > half) continue;
      acc += coh[kk];
      cnt++;
    }
    smoothed[k] = acc / cnt;
  }

  // resample onto the canonical grid
  const weights = new Float64Array(WEIGHT_BINS);
  for (let i = 0; i < WEIGHT_BINS; i++) {
    const pos = (i / (WEIGHT_BINS - 1)) * half;
    const j = Math.floor(pos);
    const f = pos - j;
    const a = smoothed[j];
    const b = smoothed[Math.min(half, j + 1)];
    const c = a + (b - a) * f;
    weights[i] = floor + (1 - floor) * Math.pow(c, exponent);
  }
  return { weights, meanCoherence, frames };
}
