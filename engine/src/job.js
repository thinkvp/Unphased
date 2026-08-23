// job.json schema validation and normalization. The job is the seam between
// the panel and the engine — keep it strict so integration bugs surface here
// with readable messages instead of deep in the DSP.
//
// Pure: shared verbatim with the UXP plugin, which has no node:fs. Creating
// tempDir is the caller's job (cli.js does it; UXP never needs one, as it
// decodes straight to memory).

import { DEFAULT_PARAMS, AUTO_SHIFT_MAX } from './align.js';
import { AUTOMIX_DEFAULTS } from './autoMix.js';

function fail(msg) {
  throw new Error(`invalid job: ${msg}`);
}

function checkSegment(seg, label) {
  if (!seg || typeof seg !== 'object') fail(`${label} missing`);
  if (typeof seg.mediaPath !== 'string' || !seg.mediaPath) fail(`${label}.mediaPath missing`);
  if (typeof seg.startSec !== 'number' || !Number.isFinite(seg.startSec)) fail(`${label}.startSec must be a number`);
  if (typeof seg.durationSec !== 'number' || seg.durationSec <= 0) fail(`${label}.durationSec must be > 0`);
  return {
    mediaPath: seg.mediaPath,
    startSec: seg.startSec,
    durationSec: seg.durationSec,
    audioStream: seg.audioStream ?? 0,
    channel: seg.channel ?? null,
  };
}

/**
 * @returns normalized job:
 * { ffmpegPath, tempDir, sampleRate, outputFormat, params, pairs: [{
 *     id, ref, target, outputPath, handleSec }] }
 */
export function normalizeJob(raw) {
  if (!raw || typeof raw !== 'object') fail('not an object');
  if (!Array.isArray(raw.pairs) || raw.pairs.length === 0) fail('pairs must be a non-empty array');
  const params = { ...DEFAULT_PARAMS, ...(raw.params || {}) };
  if (!['static', 'dynamic'].includes(params.mode)) fail(`params.mode ${params.mode}`);
  if (params.maxShiftMs !== 'auto' &&
      (typeof params.maxShiftMs !== 'number' || !(params.maxShiftMs > 0))) {
    fail(`params.maxShiftMs must be 'auto' or a positive number`);
  }
  // Handles must cover the widest window the search may reach, or a widened
  // pass would correlate against zero padding instead of real audio.
  const shiftCeilingMs = params.maxShiftMs === 'auto' ? AUTO_SHIFT_MAX : params.maxShiftMs;
  if (raw.concurrency !== undefined && raw.concurrency !== null &&
      (!Number.isInteger(raw.concurrency) || raw.concurrency < 1)) {
    fail('concurrency must be a positive integer');
  }
  const tempDir = raw.tempDir || null;
  const seenIds = new Set();
  const pairs = raw.pairs.map((p, i) => {
    const id = String(p.id ?? i);
    if (seenIds.has(id)) fail(`duplicate pair id ${id}`);
    seenIds.add(id);
    if (typeof p.outputPath !== 'string' || !p.outputPath) fail(`pairs[${i}].outputPath missing`);
    const handleSec = p.handleSec ?? (shiftCeilingMs / 1000 + 0.25);
    return {
      id,
      ref: checkSegment(p.ref, `pairs[${i}].ref`),
      target: checkSegment(p.target, `pairs[${i}].target`),
      outputPath: p.outputPath,
      handleSec,
    };
  });
  return {
    ffmpegPath: raw.ffmpegPath,
    tempDir,
    sampleRate: raw.sampleRate ?? 48000, // analysis rate
    // 'auto' follows the source's bit depth; an explicit format overrides it
    outputFormat: raw.outputFormat ?? 'auto',
    // render at the source's own rate and channel count (stereo stays stereo)
    preserveSourceFormat: raw.preserveSourceFormat !== false,
    // pairs the CLI runs at once; null lets it choose from cores and clip
    // length. Ignored by the UXP path, which has no worker threads.
    concurrency: raw.concurrency ?? null,
    params,
    pairs,
  };
}

/**
 * Auto-mix job schema. Deliberately a different shape from an align job: `mics`
 * rather than `pairs`, because auto-mix has no reference and no target, and a
 * job file must be unambiguously one kind or the other at a glance.
 *
 * @returns normalized job:
 * { ffmpegPath, tempDir, sampleRate, output, outputFormat, preserveSourceFormat,
 *   debugDumpPath, params, mics: [{ id, source, outputPath }] }
 */
export function normalizeAutoMixJob(raw) {
  if (!raw || typeof raw !== 'object') fail('not an object');
  if (!Array.isArray(raw.mics) || raw.mics.length < 2) {
    fail('mics must be an array of at least 2 microphones');
  }
  const output = raw.output ?? 'curve';
  if (!['curve', 'render', 'both'].includes(output)) fail(`output ${output}`);
  const needsPath = output !== 'curve';

  const params = { ...AUTOMIX_DEFAULTS, ...(raw.params || {}) };
  if (!['lead', 'p95', 'off'].includes(params.levelNormalise)) fail(`params.levelNormalise ${params.levelNormalise}`);
  if (!(params.maxDuckDb > 0)) fail('params.maxDuckDb must be > 0');
  if (!(params.keyframeToleranceDb > 0)) fail('params.keyframeToleranceDb must be > 0');
  if (!['reliability', 'equal'].includes(params.pairWeighting)) fail(`params.pairWeighting ${params.pairWeighting}`);
  if (!['target', 'match', 'off'].includes(params.levelMatch)) fail(`params.levelMatch ${params.levelMatch}`);
  // Bounded rather than merely finite: -6 LUFS is not a speech target, it is a
  // typo, and the clamps downstream would absorb it into a silently missed
  // correction instead of an error anyone can see.
  if (params.levelMatch === 'target'
    && !(Number.isFinite(params.targetLufs) && params.targetLufs >= -40 && params.targetLufs <= -8)) {
    fail(`params.targetLufs ${params.targetLufs} (want -40..-8 LUFS)`);
  }
  if (!(params.gapFullDb > 0)) fail('params.gapFullDb must be > 0');

  const shiftCeilingMs = params.syncSearchMs === 'auto' ? AUTO_SHIFT_MAX : params.syncSearchMs;
  const handleSec = raw.handleSec ?? (shiftCeilingMs / 1000 + 0.25);

  const seenIds = new Set();
  let duration = null;
  const mics = raw.mics.map((m, i) => {
    if (!m || typeof m !== 'object') fail(`mics[${i}] missing`);
    const id = String(m.id ?? i);
    if (seenIds.has(id)) fail(`duplicate mic id ${id}`);
    seenIds.add(id);
    const source = checkSegment(m.source, `mics[${i}].source`);
    // Every mic shares one frame grid, so a length mismatch is a caller bug and
    // not something to paper over by trimming. startSec may differ freely —
    // that is exactly what the sync tier is for.
    if (duration === null) duration = source.durationSec;
    else if (Math.abs(source.durationSec - duration) > 1e-6) {
      fail(`mics[${i}].source.durationSec ${source.durationSec} != ${duration}; all mics must span the same interval`);
    }
    if (needsPath && (typeof m.outputPath !== 'string' || !m.outputPath)) {
      fail(`mics[${i}].outputPath missing (required when output is '${output}')`);
    }
    return { id, source, outputPath: m.outputPath || null };
  });

  return {
    ffmpegPath: raw.ffmpegPath,
    tempDir: raw.tempDir || null,
    sampleRate: raw.sampleRate ?? 48000, // analysis rate before decimation
    output,
    outputFormat: raw.outputFormat ?? 'auto',
    preserveSourceFormat: raw.preserveSourceFormat !== false,
    debugDumpPath: raw.debugDumpPath || null,
    handleSec,
    params,
    mics,
  };
}
