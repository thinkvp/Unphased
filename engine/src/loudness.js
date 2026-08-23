// ITU-R BS.1770 loudness: K-weighting and gated integration.
//
// Pure and dependency-free, so it is safe for the UXP bundle. Kept out of
// autoMix.js because it is a self-contained thing with published reference
// values — a 997 Hz full-scale sine measures -3.01 LUFS and nothing about the
// auto-mixer changes that, so it can be tested against the standard rather than
// against the rest of the pipeline.
//
// COEFFICIENTS ARE DESIGNED, NOT TABULATED. BS.1770 prints its biquads at
// 48 kHz only, and the attribution stage runs on a signal decimated to 8 kHz
// (autoMix.js). Hard-coding the 48 kHz numbers and using them at 8 kHz would
// put the shelf corner at 10 kHz-equivalent and measure something that is not
// loudness at all. So both sections are re-derived from the analog prototype
// parameters the published coefficients were themselves derived from — the
// approach libebur128 and pyloudnorm take for the same reason.

// Analog prototype for the two sections, back-solved from the BS.1770-4 48 kHz
// coefficients. Reproducing those coefficients at fs = 48000 to ~1e-12 is what
// the conformance test asserts; do not round these.
//
// The shelf is a Zolzer design (bilinear via K = tan, with the shelf midpoint
// gain as its own exponent of Vh), not the RBJ cookbook high-shelf. They are
// different topologies with different responses, and only this one lands on the
// published numbers — an RBJ shelf at the same f0/G/Q misses them in the third
// decimal and reads a 997 Hz sine 0.26 LU low.
const SHELF_F0 = 1681.9744509555319;
const SHELF_G_DB = 3.999843853973347;
const SHELF_Q = 0.7071752369554196;
const SHELF_VB_EXP = 0.4996667741545416;
const HP_F0 = 38.13547087602444;
const HP_Q = 0.5003270373238773;

// BS.1770's channel-weighted sum is offset by this to put a reference sine on
// the scale everyone quotes.
const LKFS_OFFSET = -0.691;

/** Below 2x this the shelf design degenerates and K-weighting is meaningless.
 *  Exported so a caller can decide to skip loudness rather than be thrown at. */
export const KWEIGHT_MIN_HZ = SHELF_F0;

// Below this a block is silence, not quiet speech, and averaging it in would
// drag an integrated measurement down without bound (BS.1770-4 §5.1).
export const ABSOLUTE_GATE_LUFS = -70;
// ...and relative to the ungated mean, this far down is not the programme
// either (§5.2). Together they are what stops pauses deciding the answer.
export const RELATIVE_GATE_LU = 10;

/**
 * The two K-weighting biquads at an arbitrary sample rate.
 *
 * Both are standard RBJ designs (high shelf, then high-pass), normalised by a0
 * so the caller has nothing left to divide by. Returned in the direct-form-I
 * order the filter loop wants.
 *
 * @param {number} fs
 * @returns {{ shelf: number[], hp: number[] }} each [b0, b1, b2, a1, a2]
 */
export function kWeightCoeffs(fs) {
  if (!(fs > 0)) throw new Error('kWeightCoeffs: sampleRate required');
  // Nyquist would put the shelf corner past the band and the design degenerates.
  // 8 kHz — the rate auto-mix actually uses — leaves the corner at 0.42 of
  // Nyquist, which is comfortable; this only catches an absurd caller.
  if (fs <= 2 * KWEIGHT_MIN_HZ) {
    throw new Error(`kWeightCoeffs: sampleRate ${fs} is too low for K-weighting`);
  }

  const K = Math.tan((Math.PI * SHELF_F0) / fs);
  const Vh = Math.pow(10, SHELF_G_DB / 20);
  const Vb = Math.pow(Vh, SHELF_VB_EXP);
  const sa0 = 1 + K / SHELF_Q + K * K;
  const shelf = [
    (Vh + (Vb * K) / SHELF_Q + K * K) / sa0,
    (2 * (K * K - Vh)) / sa0,
    (Vh - (Vb * K) / SHELF_Q + K * K) / sa0,
    (2 * (K * K - 1)) / sa0,
    (1 - K / SHELF_Q + K * K) / sa0,
  ];

  // The RLB high-pass numerator is [1, -2, 1] exactly — a pure double zero at
  // DC, which is what BS.1770 tabulates. Deriving it as (1+cos w0)/2 like an
  // ordinary Butterworth adds a flat 0.04 dB that would show up as a constant
  // bias against every published test vector.
  const hK = Math.tan((Math.PI * HP_F0) / fs);
  const ha0 = 1 + hK / HP_Q + hK * hK;
  const hp = [
    1,
    -2,
    1,
    (2 * (hK * hK - 1)) / ha0,
    (1 - hK / HP_Q + hK * hK) / ha0,
  ];

  return { shelf, hp };
}

/**
 * K-weight one signal.
 *
 * Writes into a caller-owned buffer on purpose: the caller runs this once per
 * mic and only keeps per-frame energies, so a fresh full-length array per mic
 * would be the largest allocation in the pipeline for no reason.
 *
 * @param {Float64Array} x
 * @param {number} fs
 * @param {Float64Array} out may alias `x`; must be at least `n` long
 * @param {number} [n] samples to filter, default x.length
 * @returns {Float64Array} `out`
 */
export function kWeight(x, fs, out, n = x.length) {
  if (out.length < n) throw new Error(`kWeight: out length ${out.length} < ${n}`);
  const { shelf, hp } = kWeightCoeffs(fs);
  // Both sections in one pass. Two passes would need a full intermediate array,
  // which is exactly what the shared `out` buffer exists to avoid.
  let s1 = 0, s2 = 0, sy1 = 0, sy2 = 0;
  let h1 = 0, h2 = 0, hy1 = 0, hy2 = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    const s = shelf[0] * v + shelf[1] * s1 + shelf[2] * s2 - shelf[3] * sy1 - shelf[4] * sy2;
    s2 = s1; s1 = v;
    sy2 = sy1; sy1 = s;
    const y = hp[0] * s + hp[1] * h1 + hp[2] * h2 - hp[3] * hy1 - hp[4] * hy2;
    h2 = h1; h1 = s;
    hy2 = hy1; hy1 = y;
    out[i] = y;
  }
  return out;
}

/**
 * Loudness of a K-weighted mean square, in LUFS.
 *
 * Single channel with weight 1 — every mic here is one person's mono track, and
 * BS.1770's channel weights exist for surround layouts we never see.
 */
export function loudnessLufs(meanSquare) {
  return meanSquare > 0 ? LKFS_OFFSET + 10 * Math.log10(meanSquare) : -Infinity;
}

/**
 * Gated integrated loudness over a CHOSEN set of frames.
 *
 * The choice is the point. BS.1770's own gating asks "which blocks are the
 * programme", answered by level alone — which is the wrong question for a lav
 * track, because the loudest thing on a quiet person's mic can be somebody
 * else's voice bleeding into it. Feeding it only the frames where attribution
 * says this mic's own wearer was the source measures that person's dialogue
 * instead of whatever happened to be loud, and that is the number a target has
 * to be set against.
 *
 * The standard's two gates are then applied WITHIN that set, which is what
 * keeps inter-word gaps inside a speaking run from dragging the answer down.
 *
 * @param {Float64Array} frameMs K-weighted mean square per frame
 * @param {number[]|Int32Array} frames indices into frameMs to integrate over
 * @returns {number} LUFS, or -Infinity when there is nothing to measure
 */
export function gatedLufs(frameMs, frames) {
  let sum = 0;
  let n = 0;
  for (let k = 0; k < frames.length; k++) {
    const ms = frameMs[frames[k]];
    if (loudnessLufs(ms) < ABSOLUTE_GATE_LUFS) continue;
    sum += ms;
    n++;
  }
  if (!n) return -Infinity;

  const ungated = sum / n;
  const relative = loudnessLufs(ungated) - RELATIVE_GATE_LU;
  let sum2 = 0;
  let n2 = 0;
  for (let k = 0; k < frames.length; k++) {
    const ms = frameMs[frames[k]];
    const l = loudnessLufs(ms);
    if (l < ABSOLUTE_GATE_LUFS || l < relative) continue;
    sum2 += ms;
    n2++;
  }
  // The relative gate can empty the set on a signal with no dynamics at all
  // (a steady tone sits exactly at the mean). Falling back to the ungated mean
  // is the same answer in that case, and avoids reporting silence.
  return loudnessLufs(n2 ? sum2 / n2 : ungated);
}
