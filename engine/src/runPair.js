// Everything one pair needs, from extracted target to written output.
//
// Node-only (it spawns ffmpeg and touches the filesystem), so like decode.js
// and wavFile.js it is deliberately absent from uxp/scripts/build-engine.js's
// MODULES list — the UXP panel has its own orchestration in js/runner.js.
//
// Split out of cli.js so the serial path and the worker path run byte-for-byte
// the same pipeline; a pool that quietly diverges from the single-threaded
// fallback is worse than no pool.

import { join, dirname } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { extractSegment, probeAudio } from './decode.js';
import { readWav, writeWav } from './wavFile.js';
import { alignPair, renderChannel } from './align.js';

/**
 * Identity of a decoded source region. Pairs sharing a key decode to identical
 * samples, so the extraction can be shared between them — which is the common
 * case, since every lav in a take is matched against the same boom region.
 */
export function regionKey(region, sampleRate) {
  return [
    region.mediaPath, region.startSec, region.durationSec,
    region.audioStream ?? 0, region.channel ?? 'mix', sampleRate,
  ].join('|');
}

/** Map an ffprobe sample_fmt / bit depth onto a WAV output format. */
export function pickFormat(stream, requested) {
  if (requested && requested !== 'auto') return requested;
  if (!stream) return 'pcm24';
  const fmt = String(stream.sampleFmt || '');
  if (fmt.startsWith('flt') || fmt.startsWith('dbl')) return 'f32';
  const bits = stream.bits || (fmt.startsWith('s16') ? 16 : fmt.startsWith('s32') ? 32 : null);
  if (bits === 16) return 'pcm16';
  if (bits === 32) return 'f32';
  return 'pcm24';
}

/**
 * Re-extract the target at its native rate with all channels kept, then apply
 * the measured correction to each channel. Falls back to the 48k mono analysis
 * render if the source can't be re-read.
 */
async function renderOutput({ ffmpegPath, job, pair, correction, fallback }) {
  const { id, target, handleSec } = pair;
  const requested = job.outputFormat;
  const preserve = job.preserveSourceFormat !== false;
  if (!preserve) {
    return { data: [fallback], sampleRate: job.sampleRate, format: pickFormat(null, requested) };
  }

  let probe;
  try {
    probe = await probeAudio({ ffmpegPath, mediaPath: target.mediaPath });
  } catch {
    probe = { streams: [] };
  }
  const stream = (probe.streams || [])[target.audioStream ?? 0];
  const srcRate = stream && stream.sampleRate ? stream.sampleRate : job.sampleRate;
  const srcChannels = stream ? stream.channels : 1;

  // A specific channel was selected for analysis: that channel IS the clip's
  // audio, so render it alone. Otherwise render every channel of the stream.
  const wantAll = (target.channel === null || target.channel === undefined) && srcChannels > 1;
  if (!wantAll && srcRate === job.sampleRate) {
    return { data: [fallback], sampleRate: job.sampleRate, format: pickFormat(stream, requested) };
  }

  const renderPath = join(job.tempDir, `${id}-render.wav`);
  await extractSegment({
    ffmpegPath,
    mediaPath: target.mediaPath,
    startSec: target.startSec - handleSec,
    durationSec: target.durationSec + 2 * handleSec,
    outPath: renderPath,
    sampleRate: srcRate,
    audioStream: target.audioStream,
    channel: wantAll ? 'all' : target.channel,
  });
  const audio = readWav(renderPath);
  const outLen = Math.round(target.durationSec * audio.sampleRate);
  const data = audio.data.map((ch) => renderChannel(ch, correction, outLen, audio.sampleRate));
  rmSync(renderPath, { force: true });
  return { data, sampleRate: audio.sampleRate, format: pickFormat(stream, requested) };
}

/**
 * Align and write one pair. Never throws: a failure is a result like any other,
 * because one bad pair must not take the rest of the job with it.
 *
 * @param {object} args { ffmpegPath, job, pair, refWavPath, onPhase }
 *   refWavPath is the already-extracted reference region, shared between every
 *   pair that resolves to the same regionKey.
 * @returns {Promise<{ ok: boolean, payload: object, tgtWavPath: string }>}
 */
export async function runPair({ ffmpegPath, job, pair, refWavPath, onPhase = () => {} }) {
  const { id, ref, target, outputPath, handleSec } = pair;
  const fs48 = job.sampleRate;
  const tgtWavPath = join(job.tempDir, `${id}-tgt.wav`);
  try {
    onPhase('extract', 0);
    await extractSegment({
      ffmpegPath,
      mediaPath: target.mediaPath,
      startSec: target.startSec - handleSec,
      durationSec: target.durationSec + 2 * handleSec,
      outPath: tgtWavPath,
      sampleRate: fs48,
      audioStream: target.audioStream,
      channel: target.channel,
    });

    onPhase('align', 25);
    const refAudio = readWav(refWavPath);
    const tgtAudio = readWav(tgtWavPath);
    const r = alignPair({
      ref: refAudio.data[0],
      tgt: tgtAudio.data[0],
      sampleRate: fs48,
      params: job.params,
      tgtOffsetSamples: Math.round(handleSec * fs48),
    });

    if (r.status === 'failed') {
      return { ok: false, payload: { status: 'failed', reason: r.reason }, tgtWavPath };
    }

    onPhase('write', 75);
    mkdirSync(dirname(outputPath), { recursive: true });

    // Render at the source's own rate and channel count so a stereo clip stays
    // stereo and a 96k clip stays 96k. The correction was measured on a 48k
    // mono analysis signal; renderChannel rescales it.
    const render = await renderOutput({
      ffmpegPath, job, pair, correction: r.correction, fallback: r.aligned,
    });
    writeWav(outputPath, { sampleRate: render.sampleRate, data: render.data }, render.format);
    return {
      ok: true,
      tgtWavPath,
      payload: {
        status: r.status,
        outputPath,
        outputChannels: render.data.length,
        outputSampleRate: render.sampleRate,
        outputFormat: render.format,
        ...r.report,
      },
    };
  } catch (err) {
    return { ok: false, payload: { status: 'failed', reason: String(err.message || err) }, tgtWavPath };
  }
}

/** Extract one shared reference region. Separate so callers can dedupe first. */
export async function extractRef({ ffmpegPath, ref, outPath, sampleRate }) {
  await extractSegment({
    ffmpegPath,
    mediaPath: ref.mediaPath,
    startSec: ref.startSec,
    durationSec: ref.durationSec,
    outPath,
    sampleRate,
    audioStream: ref.audioStream,
    channel: ref.channel,
  });
  return outPath;
}
