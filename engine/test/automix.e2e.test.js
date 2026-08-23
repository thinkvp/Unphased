// End-to-end auto-mix: three mic WAVs on disk -> job.json -> spawn CLI ->
// NDJSON events -> gain curves, and rendered WAVs that are demonstrably ducked
// where they should be. Requires ffmpeg (skipped otherwise).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeWav, readWav } from '../src/wavFile.js';
import { normalizeAutoMixJob } from '../src/job.js';
import { kWeight, gatedLufs } from '../src/loudness.js';
import { speakerRoom } from './fixtures.js';

const FFMPEG = process.env.UNPHASED_FFMPEG || 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

function runCli(args) {
  const out = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return out.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

function rmsDb(x, from, to) {
  let e = 0;
  for (let i = from; i < to; i++) e += x[i] * x[i];
  return 20 * Math.log10(Math.sqrt(e / (to - from)) + 1e-30);
}

test('automix: three lav WAVs produce curves and ducked renders', {
  skip: !existsSync(FFMPEG) ? 'ffmpeg not found' : false,
  timeout: 300000,
}, () => {
  const dir = join(tmpdir(), 'unphased-automix-test');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    const sampleRate = 48000;
    const room = speakerRoom({
      seconds: 30, sampleRate, speakers: 3, seed: 77,
      trimDb: [0, 6, -6], noiseSnrDb: 30,
    });
    const ids = ['A', 'B', 'C'];
    ids.forEach((id, m) => {
      writeWav(join(dir, `${id}.wav`), { sampleRate, data: [room.mics[m]] }, 'pcm24');
    });

    const job = {
      ffmpegPath: FFMPEG,
      tempDir: join(dir, 'tmp'),
      output: 'both',
      // The fixture is 30 s; keep handles short so the analysis window fits.
      handleSec: 0.5,
      mics: ids.map((id) => ({
        id,
        source: { mediaPath: join(dir, `${id}.wav`), startSec: 1, durationSec: 26 },
        outputPath: join(dir, 'out', `${id}-automix.wav`),
      })),
    };
    writeFileSync(join(dir, 'job.json'), JSON.stringify(job));
    const events = runCli(['automix', join(dir, 'job.json')]);

    const start = events.find((e) => e.event === 'start');
    assert.equal(start.mode, 'automix', 'start event must identify the job kind');
    assert.equal(start.mics, 3);

    const summary = events.find((e) => e.event === 'automix');
    assert.ok(summary, 'missing automix summary event');
    assert.equal(summary.pairs.length, 3);
    for (const p of summary.pairs) {
      assert.ok(p.usable, `pair ${p.micA}-${p.micB} unusable: ${p.reason}`);
      assert.ok(p.spreadMs > 2, `pair ${p.micA}-${p.micB} spread ${p.spreadMs} ms`);
    }

    const done = events.find((e) => e.event === 'done');
    assert.equal(done.failed, 0, 'some mics failed');
    assert.equal(done.ok, 3);

    for (const id of ids) {
      const r = events.find((e) => e.event === 'result' && e.id === id);
      assert.ok(r, `missing result for ${id}`);
      assert.equal(r.status, 'ok');
      // Curve mode payload
      assert.ok(Array.isArray(r.keys) && r.keys.length > 2, `${id}: ${r.keys && r.keys.length} keyframes`);
      assert.ok(r.maxErrorDb <= 0.25 + 1e-9, `${id}: keyframe error ${r.maxErrorDb} dB`);
      assert.ok(r.keys[0].timeSec >= -1e-6, `${id}: first key at ${r.keys[0].timeSec}s, before the clip start`);
      // Render mode payload
      assert.equal(r.outputSampleRate, sampleRate);
      const out = readWav(r.outputPath);
      assert.equal(out.data[0].length, Math.round(26 * sampleRate),
        `${id}: rendered length does not match the requested interval`);
    }

    // The payoff: over a stretch where one speaker holds the floor alone, the
    // other two mics must come out quieter than they went in, and that speaker's
    // own mic must not.
    //
    // The window comes from the turn schedule, not from runs of trueSpeaker:
    // trueSpeaker drops to -1 in every pause between syllables, so a contiguous
    // run of one value is just a single burst. A turn is the unit that means
    // "this person has the floor".
    const clipStart = 1 * sampleRate;
    const clipEnd = clipStart + Math.round(26 * sampleRate);
    const settle = Math.round(0.6 * sampleRate);
    let best = null;
    for (const t of room.turns) {
      const overlapped = room.turns.some((u) => u !== t && u.start < t.end && u.end > t.start);
      if (overlapped) continue;
      const from = Math.max(t.start + settle, clipStart);
      const to = Math.min(t.end, clipEnd);
      if (to - from < 1.0 * sampleRate) continue;
      if (!best || to - from > best.to - best.from) best = { s: t.speaker, from, to };
    }
    assert.ok(best, 'no un-overlapped turn long enough to measure inside the rendered interval');
    const from = best.from;
    const to = best.to;

    // `before` is measured on the source at absolute time, `after` on the render
    // at clip-relative time — the same wall-clock stretch either way.
    // Subtract each mic's level-match offset: that is a constant correction for
    // a hot or quiet recorder, not a duck, and folding the two together would
    // make the talker's own mic look ducked when it was only level-matched.
    const deltas = ids.map((id, m) => {
      const r = events.find((e) => e.event === 'result' && e.id === id);
      const out = readWav(r.outputPath).data[0];
      const before = rmsDb(room.mics[m], from, to);
      const after = rmsDb(out, from - clipStart, to - clipStart);
      return (after - before) - (r.matchGainDb || 0);
    });

    // The loudness target has to survive the same round trip, measured on the
    // rendered file at 48 kHz rather than on the 8 kHz copy the engine decided
    // from. This is the assertion that ties the number in the panel to the
    // audio on disk: everything else about the target is checked against the
    // engine's own arithmetic.
    assert.equal(summary.levelMatch, 'target');
    assert.equal(summary.targetLufs, -16);
    const landed = [];
    for (let m = 0; m < 3; m++) {
      const r = events.find((e) => e.event === 'result' && e.id === ids[m]);
      if (r.matchClamp) continue; // supposed to miss, and says so
      const out = readWav(r.outputPath).data[0];
      // Only this speaker's own un-overlapped turns, where the duck is at 0 dB
      // — the same speech the engine measured, not the whole track.
      const own = [];
      for (const t of room.turns) {
        if (t.speaker !== m) continue;
        if (room.turns.some((u) => u !== t && u.start < t.end && u.end > t.start)) continue;
        const f = Math.max(t.start + settle, clipStart) - clipStart;
        const g = Math.min(t.end, clipEnd) - clipStart;
        if (g - f > 0.5 * sampleRate) own.push([f, g]);
      }
      assert.ok(own.length, `no clean turn for ${ids[m]} to measure loudness over`);
      // BS.1770 proper over those turns: 400 ms blocks at 75% overlap, then the
      // standard's own gating. Deliberately NOT the engine's frame grid or its
      // gate — a check that reproduces the implementation being checked proves
      // nothing. Without the gating this reads ~1.3 LU low, because a turn
      // includes the pauses between its own syllables.
      const k = kWeight(out, sampleRate, new Float64Array(out.length));
      const block = Math.round(0.4 * sampleRate);
      const step = block / 4;
      const blockMs = [];
      for (const [f, g] of own) {
        for (let t = f; t + block <= g; t += step) {
          let e = 0;
          for (let i = t; i < t + block; i++) e += k[i] * k[i];
          blockMs.push(e / block);
        }
      }
      assert.ok(blockMs.length > 8, `only ${blockMs.length} blocks for ${ids[m]}`);
      landed.push([ids[m], gatedLufs(Float64Array.from(blockMs), blockMs.map((_, i) => i))]);
    }
    // Loose on purpose, and the looseness is the finding: measured this way the
    // renders land within ~1.2 LU of the target, not within the 0.0 the engine's
    // own arithmetic reports. Two known contributions, both documented at their
    // source — the decimated measurement reads ~0.4 LU low (autoMix.js), and the
    // frames attribution calls "this person leading" are a slightly louder
    // sample of their speech than the whole turn is. This is a check that the
    // target landed on disk, not a meter.
    for (const [id, got] of landed) {
      assert.ok(Math.abs(got - (-16)) < 1.5,
        `${id} rendered at ${got.toFixed(2)} LUFS for a target of -16 `
        + `(all: ${landed.map(([i, v]) => `${i} ${v.toFixed(2)}`).join(', ')})`);
    }

    assert.ok(deltas[best.s] > -1.5,
      `the talker's own mic was ducked by ${(-deltas[best.s]).toFixed(2)} dB`);
    for (let m = 0; m < 3; m++) {
      if (m === best.s) continue;
      // Modest on purpose: this is RMS over a whole turn, and every mic is
      // released back to 0 dB in the pauses between syllables, which dilutes
      // the duck. The per-frame depth is much greater — automix.test.js
      // measures that. What matters here is that the separation survives the
      // whole round trip through ffmpeg, the WAV writer and the render path.
      assert.ok(deltas[m] < deltas[best.s] - 2,
        `mic ${ids[m]} only ${(deltas[best.s] - deltas[m]).toFixed(2)} dB below the talker's mic`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- schema (no ffmpeg needed) ----------------------------------------------

const goodMic = (id) => ({
  id,
  source: { mediaPath: `${id}.wav`, startSec: 0, durationSec: 10 },
  outputPath: `${id}-out.wav`,
});

test('normalizeAutoMixJob fills defaults and keeps mics, not pairs', () => {
  const job = normalizeAutoMixJob({ mics: [goodMic('A'), goodMic('B')] });
  assert.equal(job.output, 'curve');
  assert.equal(job.sampleRate, 48000);
  assert.equal(job.mics.length, 2);
  assert.equal(job.mics[0].id, 'A');
  assert.equal(job.params.maxDuckDb, 12);
  assert.equal(job.params.levelMatch, 'target');
  assert.equal(job.params.targetLufs, -16);
  assert.ok(job.handleSec > 2, `handleSec ${job.handleSec} must cover the sync search`);
  assert.equal(job.pairs, undefined, 'an auto-mix job must not carry align-shaped pairs');
});

test('normalizeAutoMixJob rejects jobs it cannot run', () => {
  const bad = (raw, why) => assert.throws(() => normalizeAutoMixJob(raw), /invalid job/, why);
  bad({ mics: [goodMic('A')] }, 'one mic is not a mix');
  bad({ mics: [] }, 'no mics');
  bad({ mics: [goodMic('A'), goodMic('A')] }, 'duplicate ids');
  bad({ mics: [goodMic('A'), goodMic('B')], output: 'nonsense' }, 'unknown output mode');
  bad({ mics: [goodMic('A'), goodMic('B')], params: { levelNormalise: 'sometimes' } }, 'bad levelNormalise');
  bad({ mics: [goodMic('A'), goodMic('B')], params: { maxDuckDb: 0 } }, 'zero duck depth');
  bad({ mics: [goodMic('A'), goodMic('B')], params: { levelMatch: 'loudest' } }, 'unknown levelMatch');
  // A target outside any plausible speech range is a typo, and the clamps
  // downstream would turn it into a silently missed correction instead.
  bad({ mics: [goodMic('A'), goodMic('B')], params: { targetLufs: -3 } }, 'target above the range');
  bad({ mics: [goodMic('A'), goodMic('B')], params: { targetLufs: -60 } }, 'target below the range');
  bad({ mics: [goodMic('A'), goodMic('B')], params: { targetLufs: null } }, 'target must be a number');
  // ...but it is only meaningful in target mode, so the other modes must not
  // trip over a value nobody set.
  normalizeAutoMixJob({
    mics: [goodMic('A'), goodMic('B')],
    params: { levelMatch: 'off', targetLufs: null },
  });

  const mismatched = [goodMic('A'), goodMic('B')];
  mismatched[1].source.durationSec = 11;
  bad({ mics: mismatched }, 'mics spanning different intervals share no frame grid');
});

test('outputPath is required only when something is actually rendered', () => {
  const noPath = [goodMic('A'), goodMic('B')].map((m) => ({ ...m, outputPath: undefined }));
  // curve mode writes no files, so it must not demand filenames it will never use
  const curve = normalizeAutoMixJob({ mics: noPath, output: 'curve' });
  assert.equal(curve.mics[0].outputPath, null);
  assert.throws(() => normalizeAutoMixJob({ mics: noPath, output: 'render' }), /outputPath/);
  assert.throws(() => normalizeAutoMixJob({ mics: noPath, output: 'both' }), /outputPath/);
});
