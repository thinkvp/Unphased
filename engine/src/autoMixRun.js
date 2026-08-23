// Auto-mix orchestration: decode, attribute, then emit curves and/or renders.
//
// Node-only (it spawns ffmpeg and touches the filesystem), so like decode.js,
// wavFile.js and runPair.js it is deliberately absent from
// uxp/scripts/build-engine.js's MODULES list. The DSP it drives — autoMix.js —
// is pure and IS shared, so a UXP panel would reimplement only this file.
//
// No worker pool. pool.js parallelises independent pairs; auto-mix's expensive
// stage is one global computation over every mic at once and does not decompose
// that way. gccPhat's scratch cache is not reentrant either (see autoMix.js), so
// the correlations must run one at a time regardless.

import { join, dirname } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { extractSegment, probeAudio } from './decode.js';
import { readWav, writeWav } from './wavFile.js';
import { decimate } from './decimate.js';
import { attributeSpeakers, autoMixGains, simplifyGainCurve, applyGainCurve } from './autoMix.js';
import { pickFormat } from './runPair.js';

/**
 * Decode one mic's analysis signal: mono at the job's analysis rate, then
 * decimated to the attribution rate.
 *
 * The full-rate array is the memory high-water mark (a 5-minute take is ~115 MB
 * as Float64) and it is dropped before the next mic is touched, so peak stays
 * at one full-rate copy plus K decimated ones rather than K of each.
 */
async function decodeAnalysis({ ffmpegPath, job, mic, tempDir }) {
  const path = join(tempDir, `automix-${mic.id}-analysis.wav`);
  await extractSegment({
    ffmpegPath,
    mediaPath: mic.source.mediaPath,
    startSec: mic.source.startSec - job.handleSec,
    durationSec: mic.source.durationSec + 2 * job.handleSec,
    outPath: path,
    sampleRate: job.sampleRate,
    audioStream: mic.source.audioStream,
    channel: mic.source.channel,
  });
  const wav = readWav(path);
  const small = decimate(wav.data[0], job.params.decimation);
  rmSync(path, { force: true });
  return small;
}

/** Render one mic with its gain curve baked in, at the source's own rate. */
async function renderMic({ ffmpegPath, job, mic, gainDb, frameCenters, attribRate, tempDir }) {
  let probe;
  try {
    probe = await probeAudio({ ffmpegPath, mediaPath: mic.source.mediaPath });
  } catch {
    probe = { streams: [] };
  }
  const stream = (probe.streams || [])[mic.source.audioStream ?? 0];
  const preserve = job.preserveSourceFormat !== false;
  const srcRate = preserve && stream && stream.sampleRate ? stream.sampleRate : job.sampleRate;
  const srcChannels = stream ? stream.channels : 1;
  const wantAll = (mic.source.channel === null || mic.source.channel === undefined) && srcChannels > 1;

  const path = join(tempDir, `automix-${mic.id}-render.wav`);
  await extractSegment({
    ffmpegPath,
    mediaPath: mic.source.mediaPath,
    startSec: mic.source.startSec - job.handleSec,
    durationSec: mic.source.durationSec + 2 * job.handleSec,
    outPath: path,
    sampleRate: srcRate,
    audioStream: mic.source.audioStream,
    channel: wantAll ? 'all' : mic.source.channel,
  });
  const audio = readWav(path);
  const outLen = Math.round(mic.source.durationSec * audio.sampleRate);
  const inOffset = Math.round(job.handleSec * audio.sampleRate);

  // In place: a gain depends on no neighbouring sample, so unlike align's delay
  // applier this needs no second buffer, which halves the render peak.
  const data = audio.data.map((ch) => applyGainCurve(ch, gainDb, frameCenters, outLen, {
    analysisRate: attribRate,
    renderRate: audio.sampleRate,
    inOffset,
    out: ch,
  }));
  rmSync(path, { force: true });
  return { data, sampleRate: audio.sampleRate, format: pickFormat(stream, job.outputFormat) };
}

/**
 * Run a normalized auto-mix job.
 *
 * @param {object} args { ffmpegPath, job, onPhase, onMic, onSummary }
 * @returns {Promise<{ ok: number, failed: number }>}
 */
export async function runAutoMix({ ffmpegPath, job, onPhase = () => {}, onMic = () => {}, onSummary = () => {} }) {
  const tempDir = job.tempDir;
  mkdirSync(tempDir, { recursive: true });
  const attribRate = job.sampleRate / job.params.decimation;

  const decimated = [];
  for (let i = 0; i < job.mics.length; i++) {
    const mic = job.mics[i];
    onPhase(mic.id, 'extract', Math.round((i / job.mics.length) * 30));
    decimated.push(await decodeAnalysis({ ffmpegPath, job, mic, tempDir }));
  }

  onPhase(null, 'attribute', 40);
  const attr = attributeSpeakers(decimated, { ...job.params, sampleRate: attribRate });
  const gains = autoMixGains(attr, job.params);
  // Nothing downstream needs the decimated audio, and it is the largest thing
  // still resident; only the curves have to survive into the render.
  decimated.length = 0;

  onSummary({
    frames: attr.nFrames,
    frameRateHz: attr.sampleRate / attr.hop,
    activeFraction: gains.report.activeFraction,
    pairs: attr.pairs.map((p) => ({
      i: p.i,
      j: p.j,
      micA: job.mics[p.i].id,
      micB: job.mics[p.j].id,
      syncMs: round3(p.syncMs),
      baselineDriftPpm: round3(p.baseline.b * 1e6),
      spreadMs: round3(p.spreadMs),
      usable: p.usable,
      confidentFrames: round3(p.confidentFrames),
      reason: p.reason,
    })),
    levelMatch: gains.report.levelMatch,
    targetLufs: gains.report.targetLufs,
    micStats: job.mics.map((m, i) => ({
      id: m.id,
      winnerFraction: round3(gains.report.micStats[i].winnerFraction),
      openFraction: round3(gains.report.micStats[i].openFraction),
      meanDuckDb: round3(gains.report.micStats[i].meanDuckDb),
      matchGainDb: round3(gains.report.micStats[i].matchGainDb),
      matchClamp: gains.report.micStats[i].matchClamp,
      speechLufs: round3(gains.report.micStats[i].speechLufs),
      outLufs: round3(gains.report.micStats[i].outLufs),
    })),
  });

  if (job.debugDumpPath) {
    writeFileSync(job.debugDumpPath, JSON.stringify({
      frameCenters: Array.from(attr.frameCenters),
      sampleRate: attr.sampleRate,
      winner: Array.from(gains.winner),
      activity: Array.from(gains.activity),
      lead: attr.lead.map((a) => Array.from(a)),
      nLevelDb: attr.nLevelDb.map((a) => Array.from(a)),
      gainDb: gains.gainDb.map((a) => Array.from(a)),
    }));
  }

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < job.mics.length; i++) {
    const mic = job.mics[i];
    const payload = { status: 'ok' };
    try {
      // Level match is a constant, deliberately kept out of the duck curve so
      // the duck stays measurable on its own; both outputs want them summed.
      const match = gains.matchGainDb ? gains.matchGainDb[i] : 0;
      const curve = new Float64Array(gains.gainDb[i].length);
      for (let q = 0; q < curve.length; q++) curve[q] = gains.gainDb[i][q] + match;
      payload.matchGainDb = round3(match);

      if (job.output === 'curve' || job.output === 'both') {
        const s = simplifyGainCurve(curve, attr.frameCenters, {
          ...job.params, sampleRate: attribRate,
        });
        // Times are relative to the mic's own source.startSec, not to the
        // handled analysis window the curve was measured in — and then trimmed
        // to the clip, since a host cannot key before a clip starts.
        const shifted = s.keys.map((k) => ({
          timeSec: k.timeSec - job.handleSec,
          gainDb: k.gainDb,
        }));
        const keys = clipKeys(shifted, mic.source.durationSec);
        payload.keys = keys.map((k) => ({
          timeSec: round6(k.timeSec),
          gainDb: round3(k.gainDb),
        }));
        payload.maxErrorDb = round3(s.maxErrorDb);
        payload.kept = keys.length;
        payload.dropped = s.kept + s.dropped - keys.length;
      }
      if (job.output === 'render' || job.output === 'both') {
        onPhase(mic.id, 'render', 60 + Math.round((i / job.mics.length) * 35));
        const r = await renderMic({
          ffmpegPath, job, mic, gainDb: curve,
          frameCenters: attr.frameCenters, attribRate, tempDir,
        });
        mkdirSync(dirname(mic.outputPath), { recursive: true });
        writeWav(mic.outputPath, { sampleRate: r.sampleRate, data: r.data }, r.format);
        payload.outputPath = mic.outputPath;
        payload.outputChannels = r.data.length;
        payload.outputSampleRate = r.sampleRate;
        payload.outputFormat = r.format;
      }
      payload.winnerFraction = round3(gains.report.micStats[i].winnerFraction);
      payload.meanDuckDb = round3(gains.report.micStats[i].meanDuckDb);
      payload.outLufs = round3(gains.report.micStats[i].outLufs);
      payload.matchClamp = gains.report.micStats[i].matchClamp;
      ok++;
    } catch (err) {
      payload.status = 'failed';
      payload.reason = String(err.message || err);
      failed++;
    }
    onMic(mic.id, payload);
  }

  return { ok, failed };
}

/**
 * Trim a keyframe list to the clip's own interval.
 *
 * The curve is measured over the handled analysis window, which starts before
 * the clip does — and a host cannot put a volume keyframe before a clip begins.
 * Keys outside are dropped and replaced by interpolated ones exactly on the
 * boundary, so the curve the host draws still matches the curve that was
 * measured. A key is also forced at t=0 so nothing is left to extrapolation.
 */
function clipKeys(keys, durationSec) {
  const out = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k.timeSec < 0) {
      const next = keys[i + 1];
      if (next && next.timeSec >= 0 && next.timeSec > k.timeSec) {
        const t = (0 - k.timeSec) / (next.timeSec - k.timeSec);
        out.push({ timeSec: 0, gainDb: k.gainDb + (next.gainDb - k.gainDb) * t });
      }
      continue;
    }
    if (k.timeSec > durationSec) {
      const prev = keys[i - 1];
      if (prev && prev.timeSec < durationSec && k.timeSec > prev.timeSec) {
        const t = (durationSec - prev.timeSec) / (k.timeSec - prev.timeSec);
        out.push({ timeSec: durationSec, gainDb: prev.gainDb + (k.gainDb - prev.gainDb) * t });
      }
      break;
    }
    out.push(k);
  }
  if (!out.length) {
    return keys.length ? [{ timeSec: 0, gainDb: keys[keys.length - 1].gainDb }] : [];
  }
  if (out[0].timeSec > 0) out.unshift({ timeSec: 0, gainDb: out[0].gainDb });
  return out;
}

function round3(v) {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v;
}

function round6(v) {
  return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v;
}
