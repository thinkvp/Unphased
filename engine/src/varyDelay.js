// Time-varying fractional delay via Kaiser-windowed-sinc polyphase
// interpolation. out[n] = signal(n + d[n]) where d[n] may be fractional and
// vary per sample (slowly — the path solver guarantees a bounded slope).

export function besselI0(x) {
  let sum = 1;
  let term = 1;
  const y = (x / 2) * (x / 2);
  for (let k = 1; k < 64; k++) {
    term *= y / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/**
 * Polyphase table: row q holds `taps` coefficients for fractional phase
 * q/phases, stored at table[q * taps .. q * taps + taps). Interpolation
 * position p = i + f uses samples signal[i - taps/2 + 1 .. i + taps/2] with
 * kernel argument (t - p).
 *
 * One flat Float64Array rather than an array of rows: applyDelayCurve reads a
 * different phase every output sample, and an array-of-arrays makes that two
 * pointer chases and a bounds check per tap on the hottest loop in the engine.
 */
export function makeKaiserSincTable({ taps = 32, phases = 512, beta = 8.6, cutoff = 0.92 } = {}) {
  if (taps % 2 !== 0) throw new Error('taps must be even');
  const half = taps / 2;
  const i0b = besselI0(beta);
  const table = new Float64Array((phases + 1) * taps);
  for (let q = 0; q <= phases; q++) {
    const frac = q / phases;
    const row = q * taps;
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      const x = (t - half + 1) - frac; // kernel argument, in samples
      const xn = x / half;
      let v = 0;
      if (xn > -1 && xn < 1) {
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
        const win = besselI0(beta * Math.sqrt(1 - xn * xn)) / i0b;
        v = cutoff * sinc * win;
      }
      table[row + t] = v;
      sum += v;
    }
    // normalize for exact DC preservation
    if (sum !== 0) for (let t = 0; t < taps; t++) table[row + t] /= sum;
  }
  return { table, taps, phases, half };
}

let defaultTable = null;
export function getDefaultTable() {
  if (!defaultTable) defaultTable = makeKaiserSincTable();
  return defaultTable;
}

/**
 * @param {Float64Array} signal
 * @param {Float64Array|number} delay per-output-sample delay in samples, or a constant
 * @param {number} outLen
 * @param {number} inOffset position in `signal` corresponding to output sample 0
 * @returns {Float64Array}
 */
export function applyDelayCurve(signal, delay, outLen, inOffset = 0, tbl = getDefaultTable()) {
  const out = new Float64Array(outLen);
  if (typeof delay === 'number') resampleConst(out, signal, delay, outLen, inOffset, tbl);
  else resampleCurve(out, signal, delay, outLen, inOffset, tbl);
  return out;
}

// The two loops below are the same arithmetic and differ only in where the
// delay comes from. They are written out twice rather than sharing one loop
// with a `constant ? delay : delay[n]` ternary, because that ternary reads
// either a tagged double or a Float64Array element on every iteration and V8
// never settles on a representation for the loop-carried state: it tiers the
// function up to Maglev, deoptimizes at the loop back-edge with "not a Number
// or Oddball", and repeats forever, leaving 46M iterations running in the
// interpreter. Splitting the paths keeps each inner loop monomorphic and makes
// this ~25x faster on the dynamic path, which is the one that ships.

function resampleCurve(out, signal, curve, outLen, inOffset, tbl) {
  const { table, taps, phases, half } = tbl;
  const sigLen = signal.length;
  for (let n = 0; n < outLen; n++) {
    const p = inOffset + n + curve[n];
    const i = Math.floor(p);
    const frac = p - i;
    const qf = frac * phases;
    const q = Math.floor(qf);
    const qFrac = qf - q;
    const rowA = q * taps;
    const rowB = rowA + taps;
    let acc = 0;
    const base = i - half + 1;
    if (base >= 0 && base + taps <= sigLen) {
      for (let t = 0; t < taps; t++) {
        const a = table[rowA + t];
        acc += signal[base + t] * (a + (table[rowB + t] - a) * qFrac);
      }
    } else {
      for (let t = 0; t < taps; t++) {
        const idx = base + t;
        if (idx < 0 || idx >= sigLen) continue;
        const a = table[rowA + t];
        acc += signal[idx] * (a + (table[rowB + t] - a) * qFrac);
      }
    }
    out[n] = acc;
  }
}

function resampleConst(out, signal, delay, outLen, inOffset, tbl) {
  const { table, taps, phases, half } = tbl;
  const sigLen = signal.length;
  for (let n = 0; n < outLen; n++) {
    const p = inOffset + n + delay;
    const i = Math.floor(p);
    const frac = p - i;
    const qf = frac * phases;
    const q = Math.floor(qf);
    const qFrac = qf - q;
    const rowA = q * taps;
    const rowB = rowA + taps;
    let acc = 0;
    const base = i - half + 1;
    if (base >= 0 && base + taps <= sigLen) {
      for (let t = 0; t < taps; t++) {
        const a = table[rowA + t];
        acc += signal[base + t] * (a + (table[rowB + t] - a) * qFrac);
      }
    } else {
      for (let t = 0; t < taps; t++) {
        const idx = base + t;
        if (idx < 0 || idx >= sigLen) continue;
        const a = table[rowA + t];
        acc += signal[idx] * (a + (table[rowB + t] - a) * qFrac);
      }
    }
    out[n] = acc;
  }
}
