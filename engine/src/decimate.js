// Integer-factor decimation for the coarse search.
//
// The static-offset search is by far the most expensive stage, and its cost is
// driven by FFT size, which scales with sample rate. It is also the stage that
// needs the LEAST precision: its answer is rounded to an integer and handed to
// buildLattice, which re-searches +/-maxDriftMs around it at full rate. So the
// search runs on a decimated copy and a narrow full-rate pass recovers the
// precision afterwards.
//
// The filter is a Kaiser-windowed sinc with an ODD tap count, so it is exactly
// linear phase with an integer group delay that the centred convolution below
// cancels outright. Even if it did not, both signals are filtered identically
// and any common-mode delay would cancel in the cross-correlation — but a
// correlation stage is the wrong place to be relying on errors cancelling.

import { besselI0 } from './varyDelay.js';

// 48 kHz / 4 = 12 kHz, keeping everything below 5.4 kHz. Speech correlates
// almost entirely below that, and the lattice still sees the full 48 kHz band.
export const COARSE_DECIMATION = 4;

const kernelCache = new Map();

/**
 * Lowpass FIR for decimating by `factor`, cutting off just under the new
 * Nyquist. `tapsPerPhase` trades transition width against cost: 16 taps per
 * phase puts the stopband ~80 dB down with beta 8.6.
 */
export function decimationKernel(factor, { tapsPerPhase = 16, beta = 8.6, cutoff = 0.9 } = {}) {
  const key = `${factor}|${tapsPerPhase}|${beta}|${cutoff}`;
  let h = kernelCache.get(key);
  if (h) return h;

  const taps = tapsPerPhase * factor + 1; // odd => exact symmetry, zero fractional delay
  const half = (taps - 1) / 2;
  const fc = cutoff / factor; // normalized to the INPUT Nyquist
  const i0b = besselI0(beta);
  h = new Float64Array(taps);
  let sum = 0;
  for (let t = 0; t < taps; t++) {
    const x = t - half;
    const xn = x / half;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * fc * x) / (Math.PI * fc * x);
    const win = besselI0(beta * Math.sqrt(Math.max(0, 1 - xn * xn))) / i0b;
    const v = fc * sinc * win;
    h[t] = v;
    sum += v;
  }
  // normalize for exact DC gain, so decimation cannot shift the RMS the
  // adaptive silence gate is calibrated against
  if (sum !== 0) for (let t = 0; t < taps; t++) h[t] /= sum;
  kernelCache.set(key, h);
  return h;
}

/**
 * Lowpass and downsample by an integer factor. Only the retained output
 * positions are convolved, so the cost is len/factor * taps rather than
 * len * taps.
 *
 * @param {Float64Array} signal
 * @param {number} factor integer >= 1; 1 returns the input untouched
 * @returns {Float64Array} length ceil(signal.length / factor)
 */
export function decimate(signal, factor = COARSE_DECIMATION, opts = {}) {
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(`decimation factor must be a positive integer, got ${factor}`);
  }
  if (factor === 1) return signal;
  const h = decimationKernel(factor, opts);
  const taps = h.length;
  const half = (taps - 1) / 2;
  const len = signal.length;
  const outLen = Math.ceil(len / factor);
  const out = new Float64Array(outLen);
  for (let k = 0; k < outLen; k++) {
    const centre = k * factor;
    const base = centre - half;
    let acc = 0;
    if (base >= 0 && base + taps <= len) {
      for (let t = 0; t < taps; t++) acc += signal[base + t] * h[t];
    } else {
      // zero-pad past the edges; the first and last `half/factor` output
      // samples are attenuated, which the RMS gate treats as any quiet block
      for (let t = 0; t < taps; t++) {
        const idx = base + t;
        if (idx >= 0 && idx < len) acc += signal[idx] * h[t];
      }
    }
    out[k] = acc;
  }
  return out;
}
