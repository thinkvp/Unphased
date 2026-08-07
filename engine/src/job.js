// job.json schema validation and normalization. The job is the seam between
// the panel and the engine — keep it strict so integration bugs surface here
// with readable messages instead of deep in the DSP.
//
// Pure: shared verbatim with the UXP plugin, which has no node:fs. Creating
// tempDir is the caller's job (cli.js does it; UXP never needs one, as it
// decodes straight to memory).

import { DEFAULT_PARAMS, AUTO_SHIFT_MAX } from './align.js';

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
