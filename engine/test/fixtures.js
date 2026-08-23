// Synthetic fixture generators: deterministic speech-like signals and
// controlled degradations (delay, drift, polarity, noise, level) with ground
// truth. The fractional-delay methods here are intentionally INDEPENDENT of
// the engine's polyphase interpolator so tests don't validate the applier
// with itself.

import { fftInPlace, nextPow2 } from '../src/fft.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function biquadFilter(x, { b0, b1, b2, a1, a2 }) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i];
    y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

function rbj(type, fc, fs, Q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * fc) / fs;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass') {
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
  } else if (type === 'highpass') {
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
  } else {
    throw new Error(type);
  }
  a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/**
 * Speech-like signal: band-limited noise (300-3400 Hz) gated into bursts with
 * pauses, raised-cosine attack/release.
 * @returns {{ signal: Float64Array, voiced: Uint8Array, sampleRate }}
 */
export function speechLike({ seconds = 20, sampleRate = 48000, seed = 1 } = {}) {
  const n = Math.round(seconds * sampleRate);
  const rand = mulberry32(seed);
  let x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = rand() * 2 - 1;
  x = biquadFilter(x, rbj('highpass', 300, sampleRate));
  x = biquadFilter(x, rbj('highpass', 300, sampleRate));
  x = biquadFilter(x, rbj('lowpass', 3400, sampleRate));
  x = biquadFilter(x, rbj('lowpass', 3400, sampleRate));

  const env = new Float64Array(n);
  const voiced = new Uint8Array(n);
  const ramp = Math.round(0.02 * sampleRate);
  let i = 0;
  // lead-in pause so fixtures never start mid-burst
  i += Math.round((0.1 + rand() * 0.2) * sampleRate);
  while (i < n) {
    const burstLen = Math.round((0.2 + rand() * 1.0) * sampleRate);
    const amp = 0.3 + rand() * 0.7;
    const end = Math.min(n, i + burstLen);
    for (let j = i; j < end; j++) {
      let g = amp;
      const into = j - i;
      const left = end - 1 - j;
      if (into < ramp) g *= 0.5 - 0.5 * Math.cos((Math.PI * into) / ramp);
      if (left < ramp) g *= 0.5 - 0.5 * Math.cos((Math.PI * left) / ramp);
      env[j] = g;
      voiced[j] = g > 0.1 ? 1 : 0;
    }
    i = end + Math.round((0.15 + rand() * 0.55) * sampleRate);
  }
  const signal = new Float64Array(n);
  let peak = 0;
  for (let j = 0; j < n; j++) {
    signal[j] = x[j] * env[j];
    const a = Math.abs(signal[j]);
    if (a > peak) peak = a;
  }
  if (peak > 0) for (let j = 0; j < n; j++) signal[j] = (signal[j] / peak) * 0.7;
  return { signal, voiced, sampleRate };
}

/**
 * Delay a signal by a constant (possibly fractional) number of samples using
 * the FFT shift theorem: out[n] = in[n - delaySamples]. Output has the same
 * length; content shifts later for positive delay.
 */
export function fftDelay(signal, delaySamples) {
  const n = signal.length;
  const pad = 4096 + Math.ceil(Math.abs(delaySamples));
  const m = nextPow2(n + pad);
  const re = new Float64Array(m);
  const im = new Float64Array(m);
  re.set(signal);
  fftInPlace(re, im);
  for (let k = 0; k <= m / 2; k++) {
    const ang = (-2 * Math.PI * k * delaySamples) / m;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const r = re[k] * c - im[k] * s;
    const i2 = re[k] * s + im[k] * c;
    re[k] = r; im[k] = i2;
    if (k > 0 && k < m / 2) {
      re[m - k] = r;
      im[m - k] = -i2;
    }
  }
  im[0] = 0;
  im[m / 2] = 0;
  fftInPlace(re, im, true);
  return re.slice(0, n);
}

function lanczos(x, a) {
  if (x === 0) return 1;
  if (x <= -a || x >= a) return 0;
  const px = Math.PI * x;
  return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
}

/**
 * Time-varying delay by direct Lanczos-a interpolation (independent of the
 * engine's polyphase applier): out[n] = in(n - delayFn(n)).
 * delayFn returns samples of delay at output index n.
 */
export function varyingDelay(signal, delayFn, { a = 32 } = {}) {
  const n = signal.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = i - delayFn(i);
    const lo = Math.max(0, Math.ceil(p - a));
    const hi = Math.min(n - 1, Math.floor(p + a));
    let acc = 0;
    for (let j = lo; j <= hi; j++) acc += signal[j] * lanczos(p - j, a);
    out[i] = acc;
  }
  return out;
}

export function addNoise(signal, snrDb, seed = 99) {
  const rand = mulberry32(seed);
  let e = 0;
  for (let i = 0; i < signal.length; i++) e += signal[i] * signal[i];
  const sigRms = Math.sqrt(e / signal.length);
  const noiseRms = sigRms / Math.pow(10, snrDb / 20);
  const out = new Float64Array(signal.length);
  // approximate gaussian via sum of uniforms
  for (let i = 0; i < signal.length; i++) {
    const g = (rand() + rand() + rand() + rand() - 2) * Math.sqrt(3);
    out[i] = signal[i] + g * noiseRms;
  }
  return out;
}

/**
 * Add noise confined to a frequency band — models the interference that
 * differs between two mics (wireless HF hiss, LF handling rumble, HVAC)
 * rather than the broadband noise `addNoise` produces.
 * @param {[number, number]} band [lowHz, highHz]
 */
export function addBandNoise(signal, snrDb, band, sampleRate = 48000, seed = 77) {
  const rand = mulberry32(seed);
  let noise = new Float64Array(signal.length);
  for (let i = 0; i < signal.length; i++) noise[i] = rand() * 2 - 1;
  const [lo, hi] = band;
  if (lo > 20) {
    noise = biquadFilter(noise, rbj('highpass', lo, sampleRate));
    noise = biquadFilter(noise, rbj('highpass', lo, sampleRate));
  }
  if (hi < sampleRate / 2 - 100) {
    noise = biquadFilter(noise, rbj('lowpass', hi, sampleRate));
    noise = biquadFilter(noise, rbj('lowpass', hi, sampleRate));
  }
  let es = 0;
  let en = 0;
  for (let i = 0; i < signal.length; i++) {
    es += signal[i] * signal[i];
    en += noise[i] * noise[i];
  }
  const sigRms = Math.sqrt(es / signal.length);
  const noiseRms = Math.sqrt(en / signal.length) || 1e-30;
  const target = sigRms / Math.pow(10, snrDb / 20);
  const g = target / noiseRms;
  const out = new Float64Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = signal[i] + noise[i] * g;
  return out;
}

export function scale(signal, gainDb) {
  const g = Math.pow(10, gainDb / 20);
  const out = new Float64Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = signal[i] * g;
  return out;
}

export function invert(signal) {
  return scale(signal, 0).map((v) => -v);
}

/**
 * First-order allpass cascade: unit magnitude, strongly frequency-dependent
 * phase — simulates mic-chain phase smear for phaseAlign tests.
 * Each coefficient a in (-1, 1): H(z) = (a + z^-1) / (1 + a z^-1).
 */
/**
 * A phase relationship that changes over the take: allpass chain A at the
 * start, chain B at the end, crossfaded across the middle. Models talent
 * turning relative to a mic, where the phase difference is not one fixed
 * curve for the whole clip.
 */
export function timeVaryingAllpass(signal, coeffsA, coeffsB) {
  const a = allpassChain(signal, coeffsA);
  const b = allpassChain(signal, coeffsB);
  const n = signal.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // hold A for the first quarter, B for the last quarter, raised-cosine between
    const t = Math.min(1, Math.max(0, (i / n - 0.25) / 0.5));
    const w = 0.5 - 0.5 * Math.cos(Math.PI * t);
    out[i] = a[i] * (1 - w) + b[i] * w;
  }
  return out;
}

const SPEED_OF_SOUND = 343; // m/s

/**
 * Bleed level for a source `d` metres from a mic, relative to that source on
 * its own lav at 20 cm. Inverse-square down to a floor, because a real room's
 * reverberant field stops the fall-off: without the floor, inverse-square puts
 * a speaker 2 m away 20 dB down and the attribution problem becomes trivial in
 * a way no production sound recordist would recognise.
 */
function bleedDbFor(distanceM, floorDb) {
  const d = Math.max(0.01, distanceM);
  const inverseSquare = -20 * Math.log10(d / 0.2);
  return Math.max(inverseSquare, -Math.abs(floorDb));
}

/**
 * Assign a per-utterance gain to a speech signal, so one speaker can deliver
 * some lines hot and others 18 dB down. Runs are found from `voiced`, and each
 * successive run takes the next gain in `gains` (cycling).
 *
 * A run whose gain is below -60 dB is marked unvoiced: that is how a
 * participant who never actually speaks is expressed, and the ground truth has
 * to agree that they are silent.
 */
function gainUtterances(signal, voiced, gains) {
  const n = signal.length;
  const out = new Float64Array(n);
  const vOut = new Uint8Array(n);
  let i = 0;
  let run = 0;
  while (i < n) {
    if (!voiced[i]) { out[i] = signal[i]; i++; continue; }
    let end = i;
    while (end < n && voiced[end]) end++;
    const gainDb = gains[run % gains.length];
    const g = Math.pow(10, gainDb / 20);
    const audible = gainDb > -60;
    for (let j = i; j < end; j++) {
      out[j] = signal[j] * g;
      vOut[j] = audible ? 1 : 0;
    }
    run++;
    i = end;
  }
  return { signal: out, voiced: vOut, runs: run };
}

/**
 * Turn-taking schedule: who holds the floor, and when.
 *
 * Without this, K independent speechLike signals talk over each other roughly
 * all the time — a 3-speaker room comes out ~65% simultaneous, which leaves
 * almost no single-speaker frames to measure attribution against and looks
 * nothing like a conversation. Turns are handed round so the same speaker
 * never takes two in a row, and `overlapFraction` of them start before the
 * previous one has finished, which is where genuine overlap comes from.
 *
 * @returns {Array<{ speaker, start, end }>} in samples
 */
function turnSchedule({ n, sampleRate, speakers, turnSecRange, gapSecRange,
                        overlapFraction, overlapSecRange, rand }) {
  const pick = ([lo, hi]) => lo + rand() * (hi - lo);
  const turns = [];
  let cursor = Math.round(pick([0.1, 0.4]) * sampleRate);
  let last = -1;
  while (cursor < n) {
    // never the same speaker twice running
    let s = Math.floor(rand() * speakers);
    if (s === last && speakers > 1) s = (s + 1 + Math.floor(rand() * (speakers - 1))) % speakers;
    const len = Math.round(pick(turnSecRange) * sampleRate);
    const start = cursor;
    const end = Math.min(n, start + len);
    turns.push({ speaker: s, start, end });
    last = s;
    if (rand() < overlapFraction) {
      cursor = Math.max(start + 1, end - Math.round(pick(overlapSecRange) * sampleRate));
    } else {
      cursor = end + Math.round(pick(gapSecRange) * sampleRate);
    }
  }
  return turns;
}

/** Raised-cosine turn mask for one speaker, so gating never clicks. */
function turnMask(n, turns, speaker, rampSamples) {
  const mask = new Float64Array(n);
  for (const t of turns) {
    if (t.speaker !== speaker) continue;
    const len = t.end - t.start;
    const ramp = Math.min(rampSamples, Math.floor(len / 2));
    for (let i = t.start; i < t.end; i++) {
      let g = 1;
      const into = i - t.start;
      const left = t.end - 1 - i;
      if (ramp > 0 && into < ramp) g = 0.5 - 0.5 * Math.cos((Math.PI * into) / ramp);
      if (ramp > 0 && left < ramp) g = Math.min(g, 0.5 - 0.5 * Math.cos((Math.PI * left) / ramp));
      if (g > mask[i]) mask[i] = g;
    }
  }
  return mask;
}

/**
 * A room of people, each wearing their own lav, each mic hearing everyone.
 *
 * This is the fixture the auto-mix attribution is measured against, and every
 * quantity it applies is returned as ground truth. Built only from the
 * primitives above — in particular the delays are FFT/Lanczos based, so a test
 * never validates the engine's own interpolator with itself.
 *
 * Mic m is worn by speaker m. Mic 0 is given no clock offset, which makes it
 * the evaluation timebase; `trueSpeaker` is at the EMISSION timebase, so a
 * comparison against it must allow a guard band around transitions (attribution
 * cannot be right within one analysis window of an onset in any case).
 *
 * @param {object} opts
 *   speakers    number of participants (mics === speakers)
 *   gains       gains[s] = dB per successive utterance for speaker s
 *   distances   distances[m][s] in metres; defaults to 0.2 own / 1.5 others
 *   bleedFloorDb  reverberant floor, positive dB
 *   trimDb      per-mic preamp trim, applied after bleed and noise
 *   noiseSnrDb  per-mic broadband noise
 *   offsetSec   per-mic clock offset (mic 0 is forced to 0)
 *   driftPpm    per-mic clock drift; non-zero costs a Lanczos resample per mic
 * @returns {{ mics, sampleRate, voiced, trueSpeaker, emit, micOffsetSamples,
 *             micDriftPpm, distances, bleedDb, trimDb, talkDb }}
 */
export function speakerRoom({
  seconds = 30,
  sampleRate = 8000,
  speakers = 3,
  gains = null,
  distances = null,
  bleedFloorDb = 16,
  bleedLowpassHz = 2500,
  trimDb = null,
  noiseSnrDb = 30,
  offsetSec = null,
  driftPpm = null,
  turnSecRange = [1.5, 4.0],
  gapSecRange = [0.1, 0.5],
  overlapFraction = 0.12,
  overlapSecRange = [0.3, 0.8],
  seed = 1,
} = {}) {
  const K = speakers;
  const n = Math.round(seconds * sampleRate);
  const talkDb = gains || Array.from({ length: K }, () => [0]);
  const dist = distances || Array.from({ length: K }, (_, m) =>
    Array.from({ length: K }, (_, s) => (m === s ? 0.2 : 1.5)));
  const trim = trimDb || new Array(K).fill(0);
  const offs = offsetSec ? offsetSec.slice() : new Array(K).fill(0);
  offs[0] = 0; // mic 0 defines the timebase
  const ppm = driftPpm || new Array(K).fill(0);

  const turns = turnSchedule({
    n, sampleRate, speakers: K, turnSecRange, gapSecRange,
    overlapFraction, overlapSecRange, rand: mulberry32(seed * 31 + 17),
  });
  const ramp = Math.round(0.02 * sampleRate);

  // Per-speaker emission: speech, per-utterance level, then gated to that
  // speaker's turns so the room takes turns instead of everyone talking at once.
  const emit = [];
  const voiced = [];
  for (let s = 0; s < K; s++) {
    const base = speechLike({ seconds, sampleRate, seed: seed + s * 101 });
    const g = gainUtterances(base.signal, base.voiced, talkDb[s]);
    const mask = turnMask(n, turns, s, ramp);
    const sig = new Float64Array(n);
    const v = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      sig[i] = g.signal[i] * mask[i];
      v[i] = g.voiced[i] && mask[i] > 0.5 ? 1 : 0;
    }
    emit.push(sig);
    voiced.push(v);
  }

  // trueSpeaker at the emission timebase: -1 nobody, -2 more than one.
  const trueSpeaker = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    let who = -1;
    for (let s = 0; s < K; s++) {
      if (!voiced[s][i]) continue;
      who = who === -1 ? s : -2;
      if (who === -2) break;
    }
    trueSpeaker[i] = who;
  }

  // Each mic sums every speaker, delayed by its acoustic path and attenuated
  // by distance.
  const bleedDb = [];
  const mics = [];
  for (let m = 0; m < K; m++) {
    const acc = new Float64Array(n);
    const row = [];
    for (let s = 0; s < K; s++) {
      const d = dist[m][s];
      const bDb = bleedDbFor(d, bleedFloorDb);
      row.push(bDb);
      let delayed = fftDelay(emit[s], (d / SPEED_OF_SOUND) * sampleRate);
      // Bleed is DULL. Sound that has crossed a room and a shirt arrives
      // low-passed and smeared, and modelling it as a clean gain-and-delay
      // copy made the fixture spectrally identical to the direct signal —
      // which quietly meant no test could exercise the spectral-tilt cue at
      // all. The speaker's own mic (s === m) is left dry.
      if (s !== m && bleedLowpassHz && bleedLowpassHz < sampleRate / 2 - 100) {
        delayed = biquadFilter(delayed, rbj('lowpass', bleedLowpassHz, sampleRate));
        delayed = biquadFilter(delayed, rbj('lowpass', bleedLowpassHz, sampleRate));
      }
      const g = Math.pow(10, bDb / 20);
      for (let i = 0; i < n; i++) acc[i] += delayed[i] * g;
    }
    bleedDb.push(row);

    let mic = addNoise(acc, noiseSnrDb, seed * 7 + m * 37 + 1);
    // The preamp acts on direct, bleed and noise alike — applying trim last is
    // what makes it a trim rather than a per-source level.
    if (trim[m] !== 0) mic = scale(mic, trim[m]);

    // Clock: a static offset, plus drift when asked for.
    const offSamples = offs[m] * sampleRate;
    if (ppm[m] !== 0) {
      const b = ppm[m] * 1e-6;
      mic = varyingDelay(mic, (i) => offSamples + b * i);
    } else if (offSamples !== 0) {
      mic = fftDelay(mic, offSamples);
    }
    mics.push(mic);
  }

  return {
    mics,
    sampleRate,
    voiced,
    trueSpeaker,
    turns,
    emit,
    micOffsetSamples: offs.map((v) => v * sampleRate),
    micDriftPpm: ppm.slice(),
    distances: dist,
    bleedDb,
    trimDb: trim.slice(),
    talkDb,
  };
}

export function allpassChain(signal, coeffs = [0.5, -0.3, 0.7]) {
  let x = signal;
  for (const a of coeffs) {
    const y = new Float64Array(x.length);
    let x1 = 0;
    let y1 = 0;
    for (let i = 0; i < x.length; i++) {
      y[i] = a * x[i] + x1 - a * y1;
      x1 = x[i];
      y1 = y[i];
    }
    x = y;
  }
  return x;
}
