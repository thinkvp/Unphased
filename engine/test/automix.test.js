import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pairSyncOffset, measurePairLags, fitPairBaseline,
  attributeSpeakers, autoMixGains, simplifyGainCurve, applyGainCurve,
} from '../src/autoMix.js';
import { decimate } from '../src/decimate.js';
import { weightedMedian } from '../src/coarse.js';
import { speechLike, fftDelay, mulberry32, speakerRoom } from './fixtures.js';

const FA = 8000; // attribution rate: 48 kHz decimated by 6

/**
 * A raw lag series shaped like a real two-person exchange: an affine clock
 * term plus a bimodal acoustic swing that flips sign with whoever is talking.
 * `talkFraction` is A's share of the speaking time — the asymmetry that biases
 * a median and leaves a mid-range alone.
 */
function bimodalLags({
  seconds = 300, hop = 2048, offset = 1234.5, driftPpm = 20,
  swing = 28, talkFraction = 0.7, jitter = 1.5, gatedFraction = 0.15, seed = 5,
} = {}) {
  const rand = mulberry32(seed);
  const n = Math.floor((seconds * FA) / hop);
  const centers = new Float64Array(n);
  const lags = new Float64Array(n);
  const weights = new Float64Array(n);
  const b = driftPpm * 1e-6;
  for (let i = 0; i < n; i++) {
    const t = i * hop + hop / 2;
    centers[i] = t;
    const base = offset + b * t;
    if (rand() < gatedFraction) {
      lags[i] = base;
      weights[i] = 0; // silent frame: no lag to fit
      continue;
    }
    const sign = rand() < talkFraction ? 1 : -1;
    lags[i] = base + sign * swing + (rand() * 2 - 1) * jitter;
    weights[i] = 0.4 + rand() * 0.6;
  }
  return { centers, lags, weights, offset, b, swing };
}

test('fitPairBaseline recovers the clock offset and drift from a lopsided exchange', () => {
  const f = bimodalLags({ talkFraction: 0.7 });
  const fit = fitPairBaseline(f.centers, f.lags, f.weights, { sampleRate: FA });

  const offsetErrMs = (Math.abs(fit.a - f.offset) / FA) * 1000;
  assert.ok(offsetErrMs < 1.0, `offset error ${offsetErrMs.toFixed(3)} ms (a=${fit.a.toFixed(1)}, want ${f.offset})`);

  const slopeErr = Math.abs(fit.b - f.b) / f.b;
  assert.ok(slopeErr < 0.2, `slope error ${(slopeErr * 100).toFixed(1)}% (b=${fit.b.toExponential(3)}, want ${f.b.toExponential(3)})`);

  assert.ok(fit.usable, `pair should be usable, spread ${((fit.spreadSamples / FA) * 1000).toFixed(2)} ms`);
  assert.ok(fit.blocks >= 3, `blocks ${fit.blocks}`);
});

test('mid-range beats the median on a lopsided exchange, which is why it is used', () => {
  const f = bimodalLags({ talkFraction: 0.7 });
  const fit = fitPairBaseline(f.centers, f.lags, f.weights, { sampleRate: FA });

  // The median lands on whichever mode holds more speaking time.
  const pts = [];
  for (let i = 0; i < f.centers.length; i++) {
    if (f.weights[i] > 0) pts.push({ v: f.lags[i] - (f.offset + f.b * f.centers[i]), w: f.weights[i] });
  }
  const medianErrMs = (Math.abs(weightedMedian(pts)) / FA) * 1000;
  const midRangeErrMs = (Math.abs(fit.a - f.offset) / FA) * 1000;

  assert.ok(medianErrMs > 2.0, `median should be badly biased here, got ${medianErrMs.toFixed(2)} ms`);
  assert.ok(midRangeErrMs < medianErrMs / 3,
    `mid-range ${midRangeErrMs.toFixed(2)} ms vs median ${medianErrMs.toFixed(2)} ms`);
});

test('fitPairBaseline stays accurate as the speaking split gets more lopsided', () => {
  // 0.95 is an interviewer who barely talks. A fixed-quantile mid-range fails
  // here by collapsing onto the majority mode; trimmed extremes do not.
  for (const talkFraction of [0.5, 0.7, 0.85, 0.95]) {
    const f = bimodalLags({ talkFraction, seed: 11 });
    const fit = fitPairBaseline(f.centers, f.lags, f.weights, { sampleRate: FA });
    const errMs = (Math.abs(fit.a - f.offset) / FA) * 1000;
    assert.ok(errMs < 1.0, `talkFraction ${talkFraction}: offset error ${errMs.toFixed(3)} ms`);
  }
});

test('a pair with no acoustic swing is reported unusable rather than fitted confidently', () => {
  // Two effectively co-located mics: the residual is jitter, and its sign
  // carries no decision. swing 0 with sub-deadband jitter.
  const f = bimodalLags({ swing: 0, jitter: 0.5 });
  const fit = fitPairBaseline(f.centers, f.lags, f.weights, { sampleRate: FA });
  const spreadMs = (fit.spreadSamples / FA) * 1000;
  assert.ok(!fit.usable, `should be unusable, spread ${spreadMs.toFixed(3)} ms`);
  // ...and the offset is still recovered, because that part is well posed.
  const errMs = (Math.abs(fit.a - f.offset) / FA) * 1000;
  assert.ok(errMs < 1.0, `offset error ${errMs.toFixed(3)} ms`);
});

test('fitPairBaseline falls back to a constant when there are too few blocks for a slope', () => {
  const f = bimodalLags({ seconds: 25 }); // ~1 block of 20 s
  const fit = fitPairBaseline(f.centers, f.lags, f.weights, { sampleRate: FA });
  assert.equal(fit.b, 0, `slope should be 0 with ${fit.blocks} block(s), got ${fit.b}`);
  const errMs = (Math.abs(fit.a - f.offset) / FA) * 1000;
  assert.ok(errMs < 1.5, `offset error ${errMs.toFixed(3)} ms`);
});

test('fitPairBaseline returns an unusable result rather than NaN when every frame is gated', () => {
  const f = bimodalLags();
  f.weights.fill(0);
  const fit = fitPairBaseline(f.centers, f.lags, f.weights, { sampleRate: FA });
  assert.equal(fit.points, 0);
  assert.equal(fit.usable, false);
  assert.ok(Number.isFinite(fit.a) && Number.isFinite(fit.b), `a=${fit.a} b=${fit.b}`);
});

// --- the fixture itself -----------------------------------------------------
// Everything downstream is measured against speakerRoom's ground truth, so its
// own properties are worth pinning: a fixture where nobody takes turns, or
// where the trims did not land, would make the attribution tests meaningless
// while still going green.

test('speakerRoom produces a turn-taking conversation, not three people shouting at once', () => {
  const r = speakerRoom({ seconds: 30, sampleRate: FA, speakers: 3, seed: 7 });
  const n = r.trueSpeaker.length;
  let single = 0;
  let overlap = 0;
  const perSpeaker = new Array(3).fill(0);
  for (let i = 0; i < n; i++) {
    const w = r.trueSpeaker[i];
    if (w >= 0) { single++; perSpeaker[w]++; } else if (w === -2) overlap++;
  }
  assert.ok(single / n > 0.4, `only ${(single / n).toFixed(3)} single-speaker frames`);
  assert.ok(overlap / n < 0.1, `${(overlap / n).toFixed(3)} overlap without asking for it`);
  for (let s = 0; s < 3; s++) {
    assert.ok(perSpeaker[s] / single > 0.15,
      `speaker ${s} holds only ${(perSpeaker[s] / single).toFixed(3)} of the floor`);
  }
});

test('speakerRoom overlap is a knob, so the overlap case can actually be tested', () => {
  const r = speakerRoom({
    seconds: 30, sampleRate: FA, speakers: 3, seed: 4,
    overlapFraction: 0.9, overlapSecRange: [1.0, 2.0],
  });
  let overlap = 0;
  for (let i = 0; i < r.trueSpeaker.length; i++) if (r.trueSpeaker[i] === -2) overlap++;
  assert.ok(overlap / r.trueSpeaker.length > 0.15,
    `only ${(overlap / r.trueSpeaker.length).toFixed(3)} overlap with the knob at 0.9`);
});

test('speakerRoom applies trims and bleed as ground truth says it does', () => {
  const trimDb = [0, 14, -10];
  const r = speakerRoom({ seconds: 20, sampleRate: FA, speakers: 3, seed: 9, trimDb, noiseSnrDb: 60 });
  const rms = (x) => {
    let e = 0;
    for (let i = 0; i < x.length; i++) e += x[i] * x[i];
    return 20 * Math.log10(Math.sqrt(e / x.length) + 1e-30);
  };
  // Mic 1 is trimmed +14 and mic 2 is trimmed -10 relative to mic 0. The mics
  // do not carry identical content, so compare the trim SPAN rather than exact
  // levels: a level-only auto-mix is what this is meant to defeat.
  const span = rms(r.mics[1]) - rms(r.mics[2]);
  assert.ok(span > 12, `trim span only ${span.toFixed(1)} dB, expected well over 12`);
  // Own mic is 0 dB by construction; everyone else sits at the reverberant floor.
  assert.ok(Math.abs(r.bleedDb[0][0]) < 1e-12, `own mic should be 0 dB, got ${r.bleedDb[0][0]}`);
  assert.ok(r.bleedDb[0][1] <= -14, `bleed ${r.bleedDb[0][1].toFixed(1)} dB is too loud to be bleed`);
});

test('pairSyncOffset is symmetric in its arguments', { timeout: 120000 }, () => {
  const { signal: a } = speechLike({ seconds: 20, sampleRate: FA, seed: 3001 });
  const delay = 137;
  const b = fftDelay(a, delay);

  const ab = pairSyncOffset(a, b, { sampleRate: FA });
  const ba = pairSyncOffset(b, a, { sampleRate: FA });

  assert.ok(ab.ok && ba.ok, `sync failed: ${ab.reason} / ${ba.reason}`);
  assert.ok(Math.abs(ab.offsetSamples - delay) < 2,
    `a->b offset ${ab.offsetSamples.toFixed(2)}, want ${delay}`);
  assert.ok(Math.abs(ab.offsetSamples + ba.offsetSamples) < 2,
    `not antisymmetric: ${ab.offsetSamples.toFixed(2)} vs ${ba.offsetSamples.toFixed(2)}`);
});

// --- attribution ------------------------------------------------------------

/**
 * Frames whose whole span, plus a one-frame guard either side, sits inside a
 * single speaker's turn.
 *
 * The guard is not slack. `trueSpeaker` is at the EMISSION timebase while each
 * mic adds its own propagation and clock delay, so the two are misregistered by
 * a few ms — and attribution genuinely cannot be right within one analysis
 * window of an onset in any case. Excluding transitions makes that honest
 * rather than hiding it in a loosened threshold.
 */
function evaluableFrames(attr, trueSpeaker) {
  const runId = new Int32Array(trueSpeaker.length);
  let id = 0;
  for (let i = 1; i < trueSpeaker.length; i++) {
    if (trueSpeaker[i] !== trueSpeaker[i - 1]) id++;
    runId[i] = id;
  }
  const out = [];
  const F = attr.frameSize;
  for (let f = 0; f < attr.nFrames; f++) {
    const t0 = f * attr.hop;
    const lo = t0 - F;
    const hi = t0 + 2 * F - 1;
    if (lo < 0 || hi >= trueSpeaker.length) continue;
    if (runId[lo] !== runId[hi]) continue;
    const s = trueSpeaker[t0];
    if (s < 0) continue;
    out.push({ f, s });
  }
  return out;
}

function attributionAccuracy(attr, gains, room) {
  const ev = evaluableFrames(attr, room.trueSpeaker);
  let hit = 0;
  for (const { f, s } of ev) if (gains.winner[f] === s) hit++;
  return { accuracy: ev.length ? hit / ev.length : 0, frames: ev.length };
}

function standardRoom(over = {}) {
  return speakerRoom({
    seconds: 40, sampleRate: FA, speakers: 3, seed: 33,
    trimDb: [0, 14, -10], noiseSnrDb: 26, ...over,
  });
}

test('attribution names the right speaker on a three-lav conversation', { timeout: 300000 }, () => {
  const room = standardRoom();
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });
  const r = attributionAccuracy(attr, autoMixGains(attr, {}), room);
  assert.ok(r.frames > 500, `only ${r.frames} evaluable frames`);
  assert.ok(r.accuracy >= 0.9, `accuracy ${r.accuracy.toFixed(3)} over ${r.frames} frames`);
});

test('every pair finds usable geometry and a sane clock model', { timeout: 300000 }, () => {
  const room = standardRoom({ offsetSec: [0, 0.35, -0.12] });
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });
  assert.equal(attr.pairs.length, 3);
  for (const p of attr.pairs) {
    assert.ok(p.usable, `pair ${p.i}-${p.j} unusable: ${p.reason}`);
    // Real geometry: people 1.5 m apart swing the TDOA by several ms.
    assert.ok(p.spreadMs > 2, `pair ${p.i}-${p.j} spread only ${p.spreadMs.toFixed(2)} ms`);
    assert.ok(p.confidentFrames > 0.4,
      `pair ${p.i}-${p.j} confident on only ${p.confidentFrames.toFixed(2)} of frames`);
  }
});

test('the lead cue alone separates the speaker from everyone else', { timeout: 300000 }, () => {
  const room = standardRoom();
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });
  const ev = evaluableFrames(attr, room.trueSpeaker);

  for (let s = 0; s < 3; s++) {
    const frames = ev.filter((e) => e.s === s).map((e) => e.f);
    assert.ok(frames.length > 100, `speaker ${s} has only ${frames.length} frames`);
    const mean = (m) => frames.reduce((a, f) => a + attr.lead[m][f], 0) / frames.length;
    const own = mean(s);
    for (let m = 0; m < 3; m++) {
      if (m === s) continue;
      assert.ok(own > 0.8, `speaker ${s}: own lead only ${own.toFixed(2)}`);
      assert.ok(mean(m) < 0, `speaker ${s}: mic ${m} leads at ${mean(m).toFixed(2)} while not speaking`);
    }
  }
});

test('grouping by acoustic signature removes the dependence on level normalisation', { timeout: 300000 }, () => {
  // This test used to assert that WITHOUT normalisation the level cue collapses
  // and only timing rescues it. That was true of per-mic scoring, and it is the
  // weakness clustering exists to remove: a trim shifts every frame's
  // fingerprint by the same amount, so it cannot move a frame from one
  // speaker's group to another's. Normalisation stops mattering.
  const room = standardRoom();

  const score = (over) => {
    const attr = attributeSpeakers(room.mics, { sampleRate: FA, ...over });
    return attributionAccuracy(attr, autoMixGains(attr, over), room).accuracy;
  };

  // Grouping: unbothered either way.
  const grouped = score({ levelNormalise: 'off' });
  assert.ok(grouped > 0.9,
    `grouping should not need normalisation, got ${grouped.toFixed(3)}`);

  // Per-frame scoring: this is where it still matters, and where timing has to
  // carry it — the behaviour clustering was built to stop depending on.
  const scoredNoLevel = score({ levelNormalise: 'off', attribution: 'score', leadGainDb: 0 });
  const scoredWithLead = score({ levelNormalise: 'off', attribution: 'score' });
  assert.ok(scoredNoLevel < 0.75,
    `per-frame scoring should struggle without normalisation, got ${scoredNoLevel.toFixed(3)}`);
  assert.ok(scoredWithLead - scoredNoLevel > 0.2,
    `timing should rescue the scoring path: ${scoredWithLead.toFixed(3)} vs ${scoredNoLevel.toFixed(3)}`);
  assert.ok(grouped >= scoredNoLevel,
    `grouping should be at least as good as scoring here: ${grouped.toFixed(3)} vs ${scoredNoLevel.toFixed(3)}`);
});

test('clustering stands down rather than overruling a confident score', { timeout: 300000 }, () => {
  // Tight groups are not the same as correct ones: with mics nearly
  // equidistant the fingerprints separate cleanly and still map to the wrong
  // people. Requiring agreement with the per-frame scores keeps the upside and
  // makes that failure impossible.
  const dist = [
    [0.45, 0.55, 0.55],
    [0.55, 0.45, 0.55],
    [0.55, 0.55, 0.45],
  ];
  const room = standardRoom({ seconds: 40, seed: 151, distances: dist, bleedLowpassHz: 1800 });
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });
  assert.ok(!attr.cluster.usable,
    `clustering should have stood down here (quality ${attr.cluster.quality.toFixed(2)}, ` +
    `agreement ${attr.cluster.agreement.toFixed(2)})`);
  const acc = attributionAccuracy(attr, autoMixGains(attr, {}), room).accuracy;
  assert.ok(acc > 0.9, `standing down should cost nothing, got ${acc.toFixed(3)}`);
});

test('attribution is symmetric: permuting the mics does not change who wins', { timeout: 300000 }, () => {
  const room = standardRoom({ seconds: 30, seed: 44 });
  const perm = [2, 0, 1]; // permuted[k] is original mic perm[k]

  const a = attributeSpeakers(room.mics, { sampleRate: FA });
  const b = attributeSpeakers(perm.map((p) => room.mics[p]), { sampleRate: FA });
  const ga = autoMixGains(a, {});
  const gb = autoMixGains(b, {});

  assert.equal(a.nFrames, b.nFrames);
  let bothActive = 0;
  let agree = 0;
  let verdictFlips = 0;
  const deltas = [];
  for (let f = 0; f < a.nFrames; f++) {
    const wb = gb.winner[f] < 0 ? gb.winner[f] : perm[gb.winner[f]];
    if ((ga.winner[f] < 0) !== (wb < 0)) verdictFlips++;
    else if (ga.winner[f] >= 0) {
      bothActive++;
      if (ga.winner[f] === wb) agree++;
    }
    for (let k = 0; k < 3; k++) deltas.push(Math.abs(ga.gainDb[perm[k]][f] - gb.gainDb[k][f]));
  }
  deltas.sort((x, y) => x - y);
  const pct = (p) => deltas[Math.floor(p * (deltas.length - 1))];
  const meanDelta = deltas.reduce((s, v) => s + v, 0) / deltas.length;

  // Not asserted to the bit: gccPhat Hann-windows its ref argument and not its
  // slice, so gcc(i,j) is not exactly -gcc(j,i). Canonical i<j ordering makes a
  // pair mean the same thing either way, but permuting the input still changes
  // which member is the ref. A 1e-9 assertion here would be a lie.
  const frac = agree / bothActive;
  assert.ok(frac >= 0.99,
    `winners agree on only ${(frac * 100).toFixed(2)}% of ${bothActive} both-active frames`);
  // Gains are asserted as a distribution, not a maximum. Winner-relative
  // scoring is discontinuous at a tie by construction — when two mics are
  // within noise of each other a hair's-breadth difference swaps a 12 dB duck,
  // and the release tail then smears that over a few frames. Those frames were
  // a coin flip either way. A real asymmetry bug would move the median off
  // zero immediately, which this still catches.
  // Not exactly zero any more: the target now carries state across frames, so
  // a hair's-breadth difference early on persists instead of being recomputed
  // away. Still eight orders of magnitude below anything audible.
  // The gap smoother carries state across frames, so a hair's-breadth early
  // difference persists rather than being recomputed away. Still far below
  // anything audible.
  assert.ok(pct(0.5) < 0.05, `median gain delta ${pct(0.5).toExponential(2)} dB should be ~zero`);
  assert.ok(meanDelta < 0.5, `mean gain delta ${meanDelta.toFixed(4)} dB`);
  assert.ok(pct(0.9) < 0.5, `p90 gain delta ${pct(0.9).toFixed(3)} dB`);
  // Frames sitting exactly on inactiveThreshold can land either side. That is
  // inherent to any hard threshold; it only matters if it is common.
  assert.ok(verdictFlips / a.nFrames < 0.02,
    `active/inactive verdict flipped on ${(100 * verdictFlips / a.nFrames).toFixed(2)}% of frames`);
});

// --- gains and ballistics ---------------------------------------------------

test('nothing is ducked during a pause in the take', { timeout: 300000 }, () => {
  const room = standardRoom();
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });
  const g = autoMixGains(attr, {});

  // Silent runs of at least a second; judge only the settled tail, since the
  // release deliberately takes time to let go.
  const F = attr.frameSize;
  // A real pause, and only its very end: the duck is deliberately held for
  // holdMs and then released over releaseMs, so a mic is still a few dB down
  // partway through a short gap. That is wanted — it stops room tone being
  // modulated open every time someone draws breath. What must not happen is a
  // mic being left ducked once the pause is genuinely over.
  const minRun = Math.round(1.0 * FA);
  const tail = Math.round(0.15 * FA);
  let checked = 0;
  let worst = 0;
  let i = 0;
  while (i < room.trueSpeaker.length) {
    if (room.trueSpeaker[i] !== -1) { i++; continue; }
    let end = i;
    while (end < room.trueSpeaker.length && room.trueSpeaker[end] === -1) end++;
    if (end - i >= minRun) {
      for (let f = 0; f < attr.nFrames; f++) {
        const t0 = f * attr.hop;
        if (t0 < end - tail || t0 + F > end) continue;
        checked++;
        for (let m = 0; m < 3; m++) worst = Math.max(worst, Math.abs(g.gainDb[m][f]));
      }
    }
    i = end;
  }
  assert.ok(checked > 5, `only ${checked} settled silent frames to check`);
  // Threshold follows releaseMs: recovery is a 1 s time constant now, chosen on
  // real material because it markedly calms the gain within a turn. A mic a few
  // dB down partway through a short gap is the deliberate cost of that.
  assert.ok(worst < 7.0, `still ducked by ${worst.toFixed(2)} dB at the end of a pause`);
});

test('pure room tone is left alone, which a level-only activity test would not do', () => {
  // adaptiveGateDb is relative to each mic's OWN level, so room tone sits above
  // every mic's gate — a level-only activity test would happily duck silence.
  // Nothing here is localisable, so coherence collapses and the gains stay put.
  // This is the test that fails if `activity` stops being a product.
  const n = 10 * FA;
  const mics = [0, 1, 2].map((m) => {
    const rand = mulberry32(900 + m);
    const gain = Math.pow(10, (m === 1 ? 14 : m === 2 ? -10 : 0) / 20);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = (rand() * 2 - 1) * 0.02 * gain;
    return x;
  });
  const attr = attributeSpeakers(mics, { sampleRate: FA });
  const g = autoMixGains(attr, {});
  let worst = 0;
  for (let f = 0; f < attr.nFrames; f++) {
    for (let m = 0; m < 3; m++) worst = Math.min(worst, g.gainDb[m][f]);
  }
  assert.ok(worst > -1, `room tone ducked by ${worst.toFixed(2)} dB`);
});

test('during genuine overlap both talkers stay open and the silent mic does not', { timeout: 300000 }, () => {
  const room = standardRoom({
    seconds: 45, seed: 61, overlapFraction: 0.9, overlapSecRange: [1.0, 2.0],
  });
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });
  const g = autoMixGains(attr, {});
  const maxDuckDb = 12;

  let checked = 0;
  let bothOpen = 0;
  let thirdDucked = 0;
  for (let f = 0; f < attr.nFrames; f++) {
    const t0 = f * attr.hop;
    if (room.trueSpeaker[t0] !== -2) continue;
    const talking = [];
    for (let s = 0; s < 3; s++) if (room.voiced[s][t0]) talking.push(s);
    if (talking.length !== 2) continue;
    const quiet = [0, 1, 2].find((m) => !talking.includes(m));
    checked++;
    if (g.gainDb[talking[0]][f] > -maxDuckDb / 2 && g.gainDb[talking[1]][f] > -maxDuckDb / 2) bothOpen++;
    if (g.gainDb[quiet][f] < g.gainDb[talking[0]][f] && g.gainDb[quiet][f] < g.gainDb[talking[1]][f]) thirdDucked++;
  }
  assert.ok(checked > 100, `only ${checked} two-speaker overlap frames`);
  // Overlap is detected implicitly: the correlation peak becomes a mixture,
  // peakRatio collapses, the lead cue loses weight, and the rule degrades to
  // level — which is the rule that happens to be correct during overlap.
  assert.ok(bothOpen / checked > 0.8,
    `both talkers open on only ${(bothOpen / checked).toFixed(3)} of overlap frames`);
  assert.ok(thirdDucked / checked > 0.6,
    `silent mic ducked below both talkers on only ${(thirdDucked / checked).toFixed(3)}`);
});

test('a slower release produces a calmer gain curve', { timeout: 300000 }, () => {
  const room = standardRoom();
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });
  const tv = (g) => {
    let t = 0;
    for (let m = 0; m < 3; m++) {
      for (let f = 1; f < attr.nFrames; f++) t += Math.abs(g.gainDb[m][f] - g.gainDb[m][f - 1]);
    }
    return t;
  };
  const calm = tv(autoMixGains(attr, { releaseMs: 800 }));
  const twitchy = tv(autoMixGains(attr, { releaseMs: 50 }));
  assert.ok(calm < twitchy,
    `releaseMs 800 total variation ${calm.toFixed(1)} dB vs releaseMs 50 ${twitchy.toFixed(1)} dB`);
});

test('look-ahead can only ever open the gain earlier, never duck more', { timeout: 300000 }, () => {
  const room = standardRoom({ seconds: 30 });
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });
  const withLook = autoMixGains(attr, {});
  const causal = autoMixGains(attr, { lookaheadMs: 1e-9 });
  let worst = 0;
  let opened = 0;
  for (let m = 0; m < 3; m++) {
    for (let f = 0; f < attr.nFrames; f++) {
      const d = withLook.gainDb[m][f] - causal.gainDb[m][f];
      if (d < worst) worst = d;
      if (d > 1e-9) opened++;
    }
  }
  assert.ok(worst > -1e-9, `look-ahead ducked ${(-worst).toFixed(4)} dB more than the causal curve`);
  assert.ok(opened > 0, 'look-ahead never opened the gain earlier — it is doing nothing');
});

test('a participant who never speaks is ducked below everyone else, and released in silence', { timeout: 300000 }, () => {
  // This case is only PARTLY solved, and the test says so rather than pretending
  // otherwise. With mic 2's owner silent, pair (i, 2) only ever sees the modes
  // {+delta, 0} — never -delta — so the mid-range baseline lands at delta/2 and
  // mic 2 looks like it leads during everyone else's turns. Its lead cue nets to
  // roughly zero, the level cue is normalised against its own bleed, and the
  // duck comes out ~3 dB instead of the ~12 dB it deserves. The direction is
  // right and it is consistently the most ducked mic; the depth is not there
  // yet. See the KNOWN LIMITATION note on fitPairBaseline.
  const room = standardRoom({ seconds: 45, seed: 71, gains: [[0], [0], [-200]] });
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });
  const g = autoMixGains(attr, {});

  let talkFrames = 0;
  let below2 = 0;
  const sum = [0, 0, 0];
  let silentFrames = 0;
  let released = 0;
  for (let f = 0; f < attr.nFrames; f++) {
    const t0 = f * attr.hop;
    const who = room.trueSpeaker[t0];
    if (who === 0 || who === 1) {
      talkFrames++;
      for (let m = 0; m < 3; m++) sum[m] += g.gainDb[m][f];
      if (g.gainDb[2][f] < -2) below2++;
    } else if (who === -1 && g.activity[f] < 0.05) {
      silentFrames++;
      if (g.gainDb[2][f] > -4) released++;
    }
  }
  assert.ok(talkFrames > 200, `only ${talkFrames} frames with someone else talking`);

  const mean = sum.map((s) => s / talkFrames);
  // Margin is small (~1 dB) because mics 0 and 1 are themselves ducked whenever
  // the other one is talking — the comparison is against a moving target, not
  // against an open mic.
  assert.ok(mean[2] < mean[0] && mean[2] < mean[1],
    `silent mic should be the most ducked: means ${mean.map((v) => v.toFixed(2)).join(', ')} dB`);
  assert.ok(mean[2] < -3,
    `silent mic only averaged ${mean[2].toFixed(2)} dB while others talked`);
  // Note what is NOT asserted: that mic 2 is the quietest at any given instant.
  // It is not — it sits at a shallow, near-constant duck while mics 0 and 1
  // swing between 0 and -12 dB, so whichever of those two is not talking is
  // ducked harder. Mic 2 only wins on the average. That is the shape of the
  // limitation, and it is what a proper global clock-offset fit would change.
  assert.ok(below2 / talkFrames > 0.5,
    `silent mic below -2 dB on only ${(below2 / talkFrames).toFixed(3)} of frames`);

  if (silentFrames > 20) {
    // Recovery is deliberately unhurried now, so "released" is measured as
    // heading back to unity rather than already there.
    assert.ok(released / silentFrames > 0.5,
      `not recovering in silence: ${(released / silentFrames).toFixed(3)}`);
  }
});

test('decimating to the attribution rate leaves the level the silence gate is calibrated against', () => {
  const { signal } = speechLike({ seconds: 20, sampleRate: 48000, seed: 606 });
  const small = decimate(signal, 6);
  const rms = (x) => {
    let e = 0;
    for (let i = 0; i < x.length; i++) e += x[i] * x[i];
    return 20 * Math.log10(Math.sqrt(e / x.length) + 1e-30);
  };
  const delta = Math.abs(rms(small) - rms(signal));
  assert.ok(delta < 0.5, `decimation moved the RMS by ${delta.toFixed(3)} dB`);
});

test('measurePairLags tracks a drifting offset that fitPairBaseline then recovers', { timeout: 180000 }, () => {
  const { signal: a } = speechLike({ seconds: 60, sampleRate: FA, seed: 3002 });
  const offset = 96;
  const b = fftDelay(a, offset);

  const sync = pairSyncOffset(a, b, { sampleRate: FA });
  assert.ok(sync.ok, `sync failed: ${sync.reason}`);

  const raw = measurePairLags(a, b, sync.offsetSamples, { sampleRate: FA });
  assert.ok(raw.centers.length > 20, `only ${raw.centers.length} frames`);
  const confident = raw.weights.reduce((n, w) => n + (w > 0 ? 1 : 0), 0);
  assert.ok(confident > raw.centers.length * 0.5,
    `only ${confident}/${raw.centers.length} confident frames`);

  const fit = fitPairBaseline(raw.centers, raw.lags, raw.weights, { sampleRate: FA });
  const errMs = (Math.abs(fit.a - offset) / FA) * 1000;
  assert.ok(errMs < 1.0, `offset error ${errMs.toFixed(3)} ms (a=${fit.a.toFixed(2)}, want ${offset})`);
});

// --- output: curve mode and render mode -------------------------------------

test('simplifyGainCurve honours its error bound and still throws most points away', { timeout: 300000 }, () => {
  const room = standardRoom();
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });
  const g = autoMixGains(attr, {});
  const tol = 0.25;

  for (let m = 0; m < 3; m++) {
    const s = simplifyGainCurve(g.gainDb[m], attr.frameCenters, { sampleRate: FA, keyframeToleranceDb: tol });
    assert.ok(s.maxErrorDb <= tol + 1e-9,
      `mic ${m}: reconstruction off by ${s.maxErrorDb.toFixed(4)} dB, tolerance ${tol}`);
    // What matters on a timeline is keyframes per second, not a fraction of
    // whatever analysis rate we happen to run at. Raw is 62.5/s; anything under
    // ~8/s is editable, and this lands around 5.
    const perSec = s.kept / (attr.nFrames / (FA / attr.hop));
    assert.ok(perSec < 8, `mic ${m}: ${perSec.toFixed(1)} keyframes/s (kept ${s.kept} of ${attr.nFrames})`);
    assert.equal(s.kept + s.dropped, attr.nFrames);

    // Independently reconstruct by linear interpolation — the way a host
    // interpolates volume keyframes — and check every frame, not just the ones
    // Douglas-Peucker happened to examine.
    let worst = 0;
    let k = 0;
    for (let f = 0; f < attr.nFrames; f++) {
      const t = attr.frameCenters[f] / FA;
      while (k + 2 < s.keys.length && s.keys[k + 1].timeSec < t) k++;
      const a = s.keys[k];
      const b = s.keys[Math.min(k + 1, s.keys.length - 1)];
      const span = b.timeSec - a.timeSec;
      const frac = span > 0 ? clampUnit((t - a.timeSec) / span) : 0;
      const pred = a.gainDb + (b.gainDb - a.gainDb) * frac;
      worst = Math.max(worst, Math.abs(pred - g.gainDb[m][f]));
    }
    assert.ok(worst <= tol + 1e-9, `mic ${m}: independent reconstruction off by ${worst.toFixed(4)} dB`);
  }
});

test('a tighter keyframe tolerance keeps more points', { timeout: 300000 }, () => {
  const room = standardRoom({ seconds: 30 });
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });
  const g = autoMixGains(attr, {});
  const loose = simplifyGainCurve(g.gainDb[0], attr.frameCenters, { sampleRate: FA, keyframeToleranceDb: 1.0 });
  const tight = simplifyGainCurve(g.gainDb[0], attr.frameCenters, { sampleRate: FA, keyframeToleranceDb: 0.05 });
  assert.ok(tight.kept > loose.kept, `tight kept ${tight.kept}, loose kept ${loose.kept}`);
  assert.ok(loose.maxErrorDb <= 1.0 + 1e-9, `loose error ${loose.maxErrorDb.toFixed(4)} dB`);
});

test('applyGainCurve with a zero curve returns the input untouched', () => {
  const n = 4096;
  const channel = new Float64Array(n);
  for (let i = 0; i < n; i++) channel[i] = Math.sin(i * 0.01) * 0.6;
  const frames = 32;
  const gainDb = new Float64Array(frames); // all zero
  const centers = new Float64Array(frames);
  for (let f = 0; f < frames; f++) centers[f] = f * 128 + 256;

  const out = applyGainCurve(channel, gainDb, centers, n, { analysisRate: FA, renderRate: FA });
  let worst = 0;
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(out[i] - channel[i]));
  assert.ok(worst < 1e-12, `zero curve moved the signal by ${worst.toExponential(3)}`);
});

test('applyGainCurve gives the same envelope whatever the render rate', () => {
  const frames = 40;
  const hop = 128;
  const gainDb = new Float64Array(frames);
  for (let f = 0; f < frames; f++) gainDb[f] = -6 + 6 * Math.sin(f * 0.3);
  const centers = new Float64Array(frames);
  for (let f = 0; f < frames; f++) centers[f] = f * hop + 256;

  // A DC channel makes the output literally the gain envelope.
  const len = frames * hop;
  const dc1 = new Float64Array(len).fill(1);
  const dc2 = new Float64Array(len * 2).fill(1);
  const a = applyGainCurve(dc1, gainDb, centers, len, { analysisRate: FA, renderRate: FA });
  const b = applyGainCurve(dc2, gainDb, centers, len * 2, { analysisRate: FA, renderRate: FA * 2 });

  let worst = 0;
  for (let i = 0; i < len; i++) worst = Math.max(worst, Math.abs(a[i] - b[i * 2]));
  assert.ok(worst < 1e-6, `envelopes diverge by ${worst.toExponential(3)} across a 2x rate change`);
});

test('applyGainCurve is safe in place and honours inOffset', () => {
  const n = 2048;
  const handles = 256;
  const base = new Float64Array(n);
  for (let i = 0; i < n; i++) base[i] = Math.sin(i * 0.02);
  const frames = 16;
  const gainDb = new Float64Array(frames).fill(-6);
  const centers = new Float64Array(frames);
  for (let f = 0; f < frames; f++) centers[f] = f * 128 + 256;
  const outLen = n - handles;

  const copy = Float64Array.from(base);
  const fresh = applyGainCurve(base, gainDb, centers, outLen, {
    analysisRate: FA, renderRate: FA, inOffset: handles,
  });
  const inPlace = applyGainCurve(copy, gainDb, centers, outLen, {
    analysisRate: FA, renderRate: FA, inOffset: handles, out: copy,
  });

  const g = Math.pow(10, -6 / 20);
  let worst = 0;
  for (let i = 0; i < outLen; i++) {
    worst = Math.max(worst, Math.abs(fresh[i] - base[handles + i] * g));
    worst = Math.max(worst, Math.abs(inPlace[i] - fresh[i]));
  }
  assert.ok(worst < 1e-12, `in-place / offset handling off by ${worst.toExponential(3)}`);
});

function clampUnit(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// --- Premiere Level conversion ----------------------------------------------

test('volume: a duck is a plain multiply, independent of the unity offset', async () => {
  // uxp/js/volume.js is a UMD CommonJS module; its exports arrive as `default`.
  const { duckLevel, dbToLevel, levelToDb, UNITY_LEVEL } = (await import('../../uxp/js/volume.js')).default;

  // The property that matters: ducking by N dB scales the level by 10^(N/20),
  // whatever the clip's starting level is. If this ever stops holding, the
  // keyframe writer's correctness starts depending on Adobe's unity reference
  // — the one number we cannot verify without Premiere.
  for (const start of [UNITY_LEVEL, 1.0, 0.5, 0.05]) {
    for (const duck of [0, -3, -6, -12]) {
      const got = duckLevel(start, duck);
      const want = start * Math.pow(10, duck / 20);
      assert.ok(Math.abs(got - want) < 1e-12,
        `duckLevel(${start}, ${duck}) = ${got}, want ${want}`);
      // and the dB difference is exactly the duck, whatever the offset
      if (got > 0) {
        const deltaDb = levelToDb(got) - levelToDb(start);
        assert.ok(Math.abs(deltaDb - duck) < 1e-9,
          `duck of ${duck} dB measured as ${deltaDb.toFixed(6)} dB`);
      }
    }
  }

  assert.ok(Math.abs(levelToDb(UNITY_LEVEL)) < 1e-9, 'UNITY_LEVEL must read as 0 dB');
  assert.ok(Math.abs(levelToDb(1.0) - 15) < 1e-9, 'level 1.0 must read as +15 dB');
  assert.ok(Math.abs(dbToLevel(0) - UNITY_LEVEL) < 1e-12);
  assert.equal(levelToDb(0), -Infinity);
});

test('volume: levels stay inside the parameter range and survive nonsense input', async () => {
  const { duckLevel, dbToLevel, levelKeyframes, UNITY_LEVEL } = (await import('../../uxp/js/volume.js')).default;
  assert.equal(dbToLevel(100), 1, 'must clamp at the top of the range');
  assert.equal(dbToLevel(-1e6), 0, 'must clamp at silence');
  assert.equal(duckLevel(1.0, 6), 1, 'boosting past the range clamps');
  // A missing or broken current level falls back to unity rather than to zero,
  // because silencing a clip is the worst possible way to fail.
  assert.equal(duckLevel(undefined, 0), UNITY_LEVEL);
  assert.equal(duckLevel(NaN, 0), UNITY_LEVEL);

  const keys = levelKeyframes([{ timeSec: 0, gainDb: 0 }, { timeSec: 1.5, gainDb: -6 }], UNITY_LEVEL);
  assert.equal(keys.length, 2);
  assert.equal(keys[0].timeSec, 0);
  assert.equal(keys[1].timeSec, 1.5, 'times must pass through untouched');
  assert.ok(Math.abs(keys[1].level - UNITY_LEVEL * Math.pow(10, -6 / 20)) < 1e-12);
});

test('a mic that is not the speaker actually reaches a real duck, and holds it', { timeout: 300000 }, () => {
  // The regression this exists for: the envelope follower had attack and
  // release the wrong way round, so every inter-syllable gap snapped the gain
  // wide open and the slow recovery never got back down. Every summary number
  // looked healthy — 13.5 dB of evidence separation, activity 0.56 — and the
  // delivered duck was 0.1 dB. Asserting on mean gain alone did not catch it;
  // asserting that the duck is REACHED and SUSTAINED does.
  const room = standardRoom({ seconds: 45, seed: 82 });
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });
  const g = autoMixGains(attr, {});

  // Look only at settled time inside a turn: the first 400 ms is the duck
  // developing, which is deliberate and not what is being measured.
  const settle = Math.round(0.4 * FA);
  let checked = 0;
  let deep = 0;
  const depths = [];
  for (const turn of room.turns) {
    const overlapped = room.turns.some((u) => u !== turn && u.start < turn.end && u.end > turn.start);
    if (overlapped || turn.end - turn.start < 1.5 * FA) continue;
    for (let f = 0; f < attr.nFrames; f++) {
      const t0 = f * attr.hop;
      if (t0 < turn.start + settle || t0 > turn.end) continue;
      for (let m = 0; m < 3; m++) {
        if (m === turn.speaker) continue;
        checked++;
        depths.push(g.gainDb[m][f]);
        if (g.gainDb[m][f] < -3) deep++;
      }
    }
  }
  assert.ok(checked > 200, `only ${checked} settled non-speaker frames`);
  const mean = depths.reduce((a, b) => a + b, 0) / depths.length;
  assert.ok(mean < -3,
    `non-speaking mics only averaged ${mean.toFixed(2)} dB inside a turn`);
  assert.ok(deep / checked > 0.6,
    `only ${(deep / checked).toFixed(3)} of non-speaker frames got past -3 dB`);
});

test('maxDuckDb is a target, so asking for a deeper duck actually gets one', { timeout: 300000 }, () => {
  // The regression: maxDuckDb used to be a ceiling on the evidence gap, and
  // real material only separates by 5-15 dB — so raising it from 12 to 33 dB
  // changed nothing whatsoever and the control looked broken. Depth must track
  // the number asked for, not the evidence that happens to be available.
  const room = standardRoom({ seconds: 40, seed: 91 });
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });

  const depthAt = (maxDuckDb) => {
    const g = autoMixGains(attr, { maxDuckDb });
    let sum = 0;
    let n = 0;
    for (let f = 0; f < attr.nFrames; f++) {
      if (g.winner[f] < 0) continue;
      for (let m = 0; m < 3; m++) {
        if (m === g.winner[f]) continue;
        sum += g.gainDb[m][f];
        n++;
      }
    }
    return n ? sum / n : 0;
  };

  const shallow = depthAt(6);
  const normal = depthAt(12);
  const deep = depthAt(30);

  assert.ok(normal < shallow - 2,
    `12 dB should duck deeper than 6 dB: ${normal.toFixed(2)} vs ${shallow.toFixed(2)}`);
  assert.ok(deep < normal - 5,
    `30 dB should duck much deeper than 12 dB: ${deep.toFixed(2)} vs ${normal.toFixed(2)}`);
  // ...and roughly in proportion, rather than saturating early.
  assert.ok(deep < -12, `30 dB target only averaged ${deep.toFixed(2)} dB on non-speakers`);
});

test('the second normalisation pass beats a plain p95 when one mic is set hotter', { timeout: 300000 }, () => {
  // p95 over a mic's active frames assumes its loudest 5% is its own owner. On
  // a hot preamp that is wrong: bleed is loud in absolute terms and pollutes
  // the reference. Timing does not care about trim, so the frames where a mic
  // clearly led are a trim-independent sample of its own speech.
  const room = standardRoom({ seconds: 45, seed: 104, trimDb: [0, 16, -12] });

  const score = (levelNormalise) => {
    const attr = attributeSpeakers(room.mics, { sampleRate: FA, levelNormalise });
    return attributionAccuracy(attr, autoMixGains(attr, {}), room).accuracy;
  };
  const twoPass = score('lead');
  const onePass = score('p95');

  assert.ok(twoPass >= onePass,
    `two-pass should not be worse: ${twoPass.toFixed(3)} vs ${onePass.toFixed(3)}`);
  assert.ok(twoPass > 0.9, `two-pass accuracy ${twoPass.toFixed(3)}`);
});

test('an unusable pair does not drag down the pairs that work', { timeout: 300000 }, () => {
  // A fourth "mic" carrying unrelated noise correlates with nothing, so every
  // pair involving it is garbage. Unweighted, it diluted the good pairs by
  // exactly as much as they contributed — which is what halved the timing
  // signal on real material.
  const room = standardRoom({ seconds: 40, seed: 113 });
  const rand = mulberry32(4242);
  const n = room.mics[0].length;
  const junk = new Float64Array(n);
  for (let i = 0; i < n; i++) junk[i] = (rand() * 2 - 1) * 0.05;
  const mics = room.mics.concat([junk]);

  const leadStrength = (pairWeighting) => {
    const attr = attributeSpeakers(mics, { sampleRate: FA, pairWeighting });
    let sum = 0;
    let n2 = 0;
    for (let m = 0; m < 3; m++) {
      for (let f = 0; f < attr.nFrames; f++) { sum += Math.abs(attr.lead[m][f]); n2++; }
    }
    return sum / n2;
  };
  const weighted = leadStrength('reliability');
  const equal = leadStrength('equal');

  assert.ok(weighted > equal,
    `reliability weighting should preserve more timing signal: ${weighted.toFixed(4)} vs ${equal.toFixed(4)}`);
});

test('level matching pulls mismatched recorders toward a common speaking level', { timeout: 300000 }, () => {
  // Attribution normalises levels internally so it can compare mics; that
  // number used to be thrown away after scoring, so a mic set 16 dB hot stayed
  // 16 dB hot in the OUTPUT whenever its owner talked. Ducking decides who;
  // this decides how loud.
  const room = standardRoom({ seconds: 40, seed: 121, trimDb: [0, 16, -12] });
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });
  // Pinned to 'match' rather than left on the default: the default is 'target'
  // now, and this test is about the relative mode.
  const g = autoMixGains(attr, { levelMatch: 'match' });
  const off = autoMixGains(attr, { levelMatch: 'off' });

  for (let m = 0; m < 3; m++) assert.equal(off.matchGainDb[m], 0, 'levelMatch off must not move anything');

  // Each mic's own speaking level, plus its correction, should land closer
  // together than the raw references did.
  const before = Array.from(attr.refDb);
  const after = before.map((v, m) => v + g.matchGainDb[m]);
  const spread = (a) => Math.max(...a) - Math.min(...a);
  assert.ok(spread(after) < spread(before) - 4,
    `matching barely helped: ${spread(before).toFixed(1)} dB -> ${spread(after).toFixed(1)} dB`);

  // ...and it must never push a mic up into clipping: the loudest frame plus
  // the correction plus a crest allowance has to stay under full scale.
  for (let m = 0; m < 3; m++) {
    if (g.matchGainDb[m] <= 0) continue;
    let peak = -Infinity;
    for (let f = 0; f < attr.nFrames; f++) peak = Math.max(peak, attr.levelDb[m][f]);
    assert.ok(peak + g.matchGainDb[m] + 12 <= 0,
      `mic ${m} pushed to ${(peak + g.matchGainDb[m] + 12).toFixed(1)} dBFS with crest allowance`);
  }

  // The duck curve itself must be unchanged — the match is a separate constant.
  for (let m = 0; m < 3; m++) {
    for (let f = 0; f < attr.nFrames; f += 97) {
      assert.ok(Math.abs(g.gainDb[m][f] - off.gainDb[m][f]) < 1e-12,
        'level matching must not alter the duck curve');
    }
  }
});

test('an absolute target lands every mic on the loudness that was asked for', { timeout: 300000 }, () => {
  // What 'match' cannot do: three recorders set 26 dB apart converge on the
  // median, wherever that happens to be. A delivery spec is a number, and only
  // an absolute target reaches it.
  const room = standardRoom({ seconds: 40, seed: 121, trimDb: [0, 16, -12] });
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });

  for (const targetLufs of [-16, -20]) {
    const g = autoMixGains(attr, { levelMatch: 'target', targetLufs });
    assert.equal(g.report.levelMatch, 'target');
    assert.equal(g.report.targetLufs, targetLufs);
    for (let m = 0; m < 3; m++) {
      const s = g.report.micStats[m];
      assert.ok(Number.isFinite(s.speechLufs), `mic ${m} has no loudness measurement`);
      // Only assert the landing where nothing was clamped — a clamped mic is
      // supposed to miss, and says so.
      if (s.matchClamp) continue;
      assert.ok(Math.abs(s.outLufs - targetLufs) < 0.05,
        `mic ${m} landed at ${s.outLufs.toFixed(2)} for a target of ${targetLufs}`);
    }
  }

  // The duck curve is untouched: the match is still a separate constant.
  const g = autoMixGains(attr, { levelMatch: 'target' });
  const off = autoMixGains(attr, { levelMatch: 'off' });
  for (let m = 0; m < 3; m++) {
    assert.equal(off.matchGainDb[m], 0);
    for (let f = 0; f < attr.nFrames; f += 97) {
      assert.ok(Math.abs(g.gainDb[m][f] - off.gainDb[m][f]) < 1e-12,
        'a level target must not alter the duck curve');
    }
  }
});

test('the loudness a target aims at is that person, not that track', { timeout: 300000 }, () => {
  // The trap this avoids. Mic 2 is trimmed 12 dB down, so most of what it
  // records is everyone ELSE bleeding in — and the integrated loudness of the
  // track as a whole is dominated by that bleed. Aiming at it would turn the
  // quietest participant DOWN, which is backwards. speechLufs is gated to the
  // frames attribution says that mic's own wearer was speaking.
  const room = standardRoom({ seconds: 40, seed: 77, trimDb: [0, 6, -12] });
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });

  // The quiet mic's own speech must measure quieter than the hot mic's own
  // speech by roughly the trim difference — that is the thing being corrected.
  const gap = attr.speechLufs[1] - attr.speechLufs[2];
  assert.ok(gap > 12, `own-speech loudness only separated the mics by ${gap.toFixed(1)} LU`);

  const g = autoMixGains(attr, { levelMatch: 'target', targetLufs: -20 });
  // ...and the correction has to move the quiet mic UP and the hot mic DOWN.
  assert.ok(g.matchGainDb[2] > 4, `quiet mic moved ${g.matchGainDb[2].toFixed(1)} dB`);
  assert.ok(g.matchGainDb[1] < g.matchGainDb[2],
    'the hotter mic should be corrected downward relative to the quiet one');
});

test('a target that cannot be reached is reported, not silently missed', { timeout: 300000 }, () => {
  // Two ways to fall short, and both have to surface: a correction bigger than
  // maxMatchDb, and one that would push a track towards clipping. A panel that
  // prints the target it was given while delivering something else is worse
  // than one that never offered the target.
  const room = standardRoom({ seconds: 40, seed: 121, trimDb: [0, 16, -12] });
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });

  // -30 LUFS is far below where these mics sit, so the hot one runs out of range.
  const low = autoMixGains(attr, { levelMatch: 'target', targetLufs: -30 });
  const clamped = low.report.micStats.filter((s) => s.matchClamp);
  assert.ok(clamped.length, 'a 30 dB correction should have hit the range limit');
  for (const s of clamped) {
    assert.ok(Math.abs(s.matchGainDb) <= 18 + 1e-9, `clamp let ${s.matchGainDb} through`);
    assert.ok(Math.abs(s.outLufs - (-30)) > 0.5, 'a clamped mic should not have landed on target');
  }

  // ...and upward, the headroom bound has to hold whatever the target says.
  const high = autoMixGains(attr, { levelMatch: 'target', targetLufs: -10 });
  for (let m = 0; m < 3; m++) {
    if (high.matchGainDb[m] <= 0) continue;
    let peak = -Infinity;
    for (let f = 0; f < attr.nFrames; f++) peak = Math.max(peak, attr.levelDb[m][f]);
    assert.ok(peak + high.matchGainDb[m] + 12 <= 0,
      `mic ${m} pushed to ${(peak + high.matchGainDb[m] + 12).toFixed(1)} dBFS with crest allowance`);
    assert.equal(high.report.micStats[m].matchClamp, 'headroom',
      `mic ${m} was held back by headroom without saying so`);
  }
});

test('a mic nobody was identified on is left alone, not amplified', { timeout: 300000 }, () => {
  // Real failure, found by the end-to-end test. Mic 2's owner is silent, so
  // everything above its gate is other people bleeding in. refDb and speechLufs
  // both fall back to measuring THAT, and a target then reads it as a very
  // quiet participant and asks for +25 dB of gain — on a track that contains no
  // speech of its own. Amplifying bleed is the worst thing an auto-mixer can do
  // with a level control, and it is worth failing to correct a track to avoid.
  const room = standardRoom({ seconds: 45, seed: 71, gains: [[0], [0], [-200]] });
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });
  assert.equal(attr.ownFromLead[2], 0, 'the fixture no longer produces an unidentified mic');

  for (const levelMatch of ['target', 'match']) {
    const g = autoMixGains(attr, { levelMatch });
    assert.equal(g.matchGainDb[2], 0, `${levelMatch} moved a mic it never identified`);
    assert.equal(g.report.micStats[2].matchClamp, 'unmeasured',
      `${levelMatch} left no explanation for skipping mic 2`);
    assert.equal(g.report.micStats[2].speechLufs, null,
      'a loudness that is somebody else must not be reported as this mic speaking');
    // ...and the mics that WERE identified are still corrected.
    assert.ok(Math.abs(g.matchGainDb[0]) + Math.abs(g.matchGainDb[1]) > 0,
      `${levelMatch} gave up on the whole take because of one bad mic`);
  }
});

test('a target falls back to matching rather than to nothing', { timeout: 300000 }, () => {
  // No K-weighting is possible below ~3.4 kHz of analysis rate, so there is no
  // loudness to aim at. Making the tracks agree with each other is most of the
  // value and needs only refDb — dropping the whole feature would not be.
  const room = standardRoom({ seconds: 30, seed: 55, trimDb: [0, 14, -10] });
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });
  const stripped = { ...attr, speechLufs: new Float64Array(attr.micCount).fill(-Infinity) };

  const g = autoMixGains(stripped, { levelMatch: 'target' });
  assert.equal(g.report.levelMatch, 'match');
  assert.equal(g.report.targetLufs, null);
  const match = autoMixGains(stripped, { levelMatch: 'match' });
  for (let m = 0; m < 3; m++) {
    assert.ok(Math.abs(g.matchGainDb[m] - match.matchGainDb[m]) < 1e-12,
      'the fallback must be exactly the match path');
  }
  // ...and it must still have done something useful.
  const spread = (a) => Math.max(...a) - Math.min(...a);
  const before = Array.from(attr.refDb);
  assert.ok(spread(before.map((v, m) => v + g.matchGainDb[m])) < spread(before) - 4,
    'the fallback barely moved anything');
});

test('a long take that drifts past the search window is still tracked', { timeout: 600000 }, () => {
  // Real failure: a 43-minute take came back with every pair's spread pinned at
  // the +/-30 ms search width and zero usable timing. At 20 ppm that take
  // accumulates ~52 ms of drift — wider than the window — so the true lag walks
  // out of it partway through and everything after is noise. The sweep now
  // follows an estimated clock instead of sitting on one static offset.
  const room = speakerRoom({
    seconds: 240, sampleRate: FA, speakers: 3, seed: 131,
    // 200 ppm over 240 s is ~48 ms — the same "drifts clean out of the window"
    // shape as 20 ppm over 43 minutes, at a length the suite can afford.
    driftPpm: [0, 200, -150],
  });
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });

  for (const p of attr.pairs) {
    assert.ok(p.usable, `pair ${p.i}-${p.j} unusable: ${p.reason}`);
    // The tell for the old failure: spread saturating the search window.
    assert.ok(p.spreadMs < 40,
      `pair ${p.i}-${p.j} spread ${p.spreadMs.toFixed(1)} ms — the window is being saturated again`);
  }
  const g = autoMixGains(attr, {});
  assert.ok(g.report.activeFraction > 0.2,
    `only ${(g.report.activeFraction * 100).toFixed(0)}% of a drifting take was usable`);
});

test('level matching stands down when attribution found nothing', () => {
  // Three uncorrelated noise sources: nothing to attribute, so refDb is an
  // uncorroborated guess and moving tracks on it would be worse than nothing.
  const n = 12 * FA;
  const mics = [0, 1, 2].map((m) => {
    const rand = mulberry32(700 + m);
    const gain = Math.pow(10, (m * 8) / 20);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = (rand() * 2 - 1) * 0.02 * gain;
    return x;
  });
  const attr = attributeSpeakers(mics, { sampleRate: FA });
  const g = autoMixGains(attr, {});
  assert.ok(g.report.activeFraction < 0.05, `expected a dead run, got ${g.report.activeFraction}`);
  for (let m = 0; m < 3; m++) {
    assert.equal(g.matchGainDb[m], 0,
      `mic ${m} was level-matched ${g.matchGainDb[m].toFixed(1)} dB on a failed run`);
  }
});

test('the floor is held, not re-voted every frame', () => {
  // Driven by a synthetic near-tie rather than the speakerRoom fixture: that
  // fixture's geometry is clean enough that attribution is already near-perfect
  // and the winner never flickers, so it cannot exercise this at all. Real
  // material is full of near-ties, and that is exactly where it bit — mic 0 and
  // mic 1 swapping several times a second, and because the envelope opens in
  // 15 ms and closes over 400 ms, BOTH ended up pinned at 0 dB with nothing
  // dipping.
  const K = 3;
  const nFrames = 4000;
  const hop = 128;
  const rand = mulberry32(2718);
  const mk = () => Array.from({ length: K }, () => new Float64Array(nFrames));

  const nLevelDb = mk();
  const lead = mk();
  const levelDb = mk();
  for (let f = 0; f < nFrames; f++) {
    // Mics 0 and 1 sit within a decibel of each other; mic 2 is clearly out.
    nLevelDb[0][f] = -2 + (rand() * 2 - 1) * 0.5;
    nLevelDb[1][f] = -2 + (rand() * 2 - 1) * 0.5;
    nLevelDb[2][f] = -14;
    for (let m = 0; m < K; m++) levelDb[m][f] = -20;
  }
  const attribution = {
    sampleRate: FA, hop, nFrames, micCount: K,
    frameCenters: Float64Array.from({ length: nFrames }, (_, f) => f * hop),
    levelDb, nLevelDb, lead,
    refDb: new Float64Array(K),
    coherence: new Float64Array(nFrames).fill(1),
    levelActivity: new Float64Array(nFrames).fill(1),
    gateDb: new Float64Array(K).fill(-60),
    pairs: [],
  };

  const measure = (winnerHysteresisDb) => {
    const g = autoMixGains(attribution, { winnerHysteresisDb, levelMatch: 'off' });
    let switches = 0;
    let prev = -1;
    let sum = 0;
    let n = 0;
    for (let f = 0; f < nFrames; f++) {
      const w = g.winner[f];
      if (w >= 0 && prev >= 0 && w !== prev) switches++;
      if (w >= 0) prev = w;
      // Measure only the near-tied pair, and only its quieter member. Averaging
      // over every non-winner would be swamped by mic 2, which is fully ducked
      // either way — and the point of hysteresis is not a bigger gap, it is that
      // ONE of the tied pair stays down instead of both being re-opened.
      sum += Math.min(g.gainDb[0][f], g.gainDb[1][f]);
      n++;
    }
    return { switches, depth: n ? sum / n : 0 };
  };

  const withH = measure(3);
  const none = measure(0);

  assert.ok(none.switches > 200, `the fixture should flicker without hysteresis, got ${none.switches}`);
  assert.ok(withH.switches < none.switches * 0.1,
    `hysteresis should steady the floor: ${withH.switches} switches vs ${none.switches}`);
  // NOT asserted: that hysteresis ducks deeper. It does not, and claiming so
  // would be false — the duck depth follows the EVIDENCE GAP, and on a near-tie
  // that gap is a fraction of a decibel whoever wins. Hysteresis buys stability,
  // not separation. If two mics are genuinely this close, nothing downstream of
  // the attribution can make one of them dip; that has to be fixed in the cues.
});

test('spectral tilt separates a dry mic from a dull copy of the same voice', { timeout: 300000 }, () => {
  // The cue that does not care how far apart the mics are. Level ties when the
  // trims are wrong and timing ties when people stand close together, but a dry
  // direct signal never looks like a reverberant one.
  //
  // Deliberately hostile geometry: everyone almost equidistant, so BOTH other
  // cues are near-useless and tilt is carrying the decision on its own.
  const dist = [
    [0.45, 0.55, 0.55],
    [0.55, 0.45, 0.55],
    [0.55, 0.55, 0.45],
  ];
  const room = standardRoom({ seconds: 40, seed: 151, distances: dist, bleedLowpassHz: 1800 });
  const attr = attributeSpeakers(room.mics, { sampleRate: FA });

  // Tilt must be near its own reference when a mic's owner talks, and below it
  // when someone else does — that is the whole claim.
  const ev = evaluableFrames(attr, room.trueSpeaker);
  for (let s = 0; s < 3; s++) {
    const frames = ev.filter((e) => e.s === s).map((e) => e.f);
    if (frames.length < 50) continue;
    const mean = (m) => frames.reduce((a, f) => a + attr.nTiltDb[m][f], 0) / frames.length;
    for (let m = 0; m < 3; m++) {
      if (m === s) continue;
      assert.ok(mean(m) < mean(s) - 0.5,
        `speaker ${s}: mic ${m} tilt ${mean(m).toFixed(2)} not below own ${mean(s).toFixed(2)} dB`);
    }
  }

  // NOT asserted: that tilt raises accuracy here. It does not — even with the
  // mics near-equidistant, this fixture's level cue alone still scores 1.000,
  // so there is no headroom for a third cue to demonstrate. That is a limit of
  // the fixture, not evidence about tilt: synthetic bleed is one low-pass and a
  // gain, where a real room adds reverberation, comb filtering and a mic that
  // is physically under someone's shirt. What CAN be asserted honestly is that
  // tilt is discriminative (above) and that adding it costs nothing (below).
  const withTilt = attributionAccuracy(attr, autoMixGains(attr, {}), room).accuracy;
  const without = attributionAccuracy(attr, autoMixGains(attr, { tiltWeight: 0 }), room).accuracy;
  assert.ok(withTilt >= without - 1e-9,
    `tilt must not make things worse: ${withTilt.toFixed(3)} vs ${without.toFixed(3)}`);
  assert.ok(withTilt > 0.9, `accuracy ${withTilt.toFixed(3)}`);
});

test('a persistent challenger takes the floor even without the hysteresis margin', () => {
  // Hysteresis with no time limit is how you end up ducking the person who is
  // actually talking: if the new speaker is only 1-2 dB ahead — ordinary once
  // the cues are noisy — they never clear the margin, the floor never passes,
  // and the depth smoothing holds their mic down for the whole turn.
  const K = 2;
  const nFrames = 2000;
  const hop = 128;
  const switchAt = 500;
  const mk = () => Array.from({ length: K }, () => new Float64Array(nFrames));
  const nLevelDb = mk();
  const lead = mk();
  const levelDb = mk();
  for (let f = 0; f < nFrames; f++) {
    // Mic 0 holds the floor, then mic 1 takes over by a margin SMALLER than
    // winnerHysteresisDb and holds it steadily.
    const oneAhead = f >= switchAt;
    nLevelDb[0][f] = oneAhead ? -1.5 : 0;
    nLevelDb[1][f] = oneAhead ? 0 : -1.5;
    for (let m = 0; m < K; m++) levelDb[m][f] = -20;
  }
  const attribution = {
    sampleRate: FA, hop, nFrames, micCount: K,
    frameCenters: Float64Array.from({ length: nFrames }, (_, f) => f * hop),
    levelDb, nLevelDb, lead,
    refDb: new Float64Array(K),
    coherence: new Float64Array(nFrames).fill(1),
    levelActivity: new Float64Array(nFrames).fill(1),
    gateDb: new Float64Array(K).fill(-60),
    pairs: [],
  };

  const g = autoMixGains(attribution, { levelMatch: 'off' });
  // Well after the handover, mic 1 must hold the floor — a 1.5 dB lead is under
  // the 3 dB margin, so only the persistence rule can deliver this.
  const late = nFrames - 100;
  assert.equal(g.winner[late], 1,
    `mic 1 led steadily from frame ${switchAt} but mic ${g.winner[late]} still holds the floor`);
  // ...and it should not have taken forever: yield is 300 ms at 62.5 fps.
  let handover = -1;
  for (let f = switchAt; f < nFrames; f++) if (g.winner[f] === 1) { handover = f; break; }
  assert.ok(handover > 0 && handover - switchAt < 60,
    `handover took ${handover - switchAt} frames`);
});
