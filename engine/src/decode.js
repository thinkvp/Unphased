// ffmpeg wrapper: decode an exact segment of any media file to 48 kHz
// float32 mono WAV. -ss is placed AFTER -i deliberately: input seeking is
// fast but lands on container keyframe/priming boundaries, which would poison
// alignment ground truth for compressed sources. Accurate output-seek decode
// costs more CPU and is worth it.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

export const DEFAULT_FFMPEG = 'C:\\ffmpeg\\bin\\ffmpeg.exe';

export function resolveFfmpeg(configured) {
  const candidates = [configured, process.env.UNPHASED_FFMPEG, DEFAULT_FFMPEG, 'ffmpeg'].filter(Boolean);
  for (const c of candidates) {
    if (c === 'ffmpeg' || existsSync(c)) return c;
  }
  throw new Error('ffmpeg not found; set ffmpegPath in the job or UNPHASED_FFMPEG');
}

/**
 * @param {object} args { ffmpegPath, mediaPath, startSec, durationSec, outPath,
 *                        sampleRate=48000, audioStream=0 }
 * @returns {Promise<void>}
 */
/**
 * Count the audio streams in a media file, and the channels within each.
 * Multi-mic cameras expose one mono stream per input; consumer cameras use a
 * single interleaved stereo stream. Both need distinguishing.
 * @returns {Promise<{streams: Array<{index:number, channels:number}>}>}
 */
export function probeAudio({ ffmpegPath, mediaPath }) {
  const probePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));
  const args = [
    '-v', 'error', '-select_streams', 'a',
    '-show_entries', 'stream=index,channels,sample_rate,bits_per_raw_sample,sample_fmt,codec_name',
    '-of', 'json', mediaPath,
  ];
  return new Promise((resolve) => {
    execFile(probePath, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve({ streams: [], error: String(err.message || err) });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve({
          streams: (parsed.streams || []).map((s, i) => ({
            index: i,
            channels: s.channels ?? 1,
            sampleRate: s.sample_rate ? parseInt(s.sample_rate, 10) : null,
            bits: s.bits_per_raw_sample ? parseInt(s.bits_per_raw_sample, 10) : null,
            sampleFmt: s.sample_fmt || null,
            codec: s.codec_name || null,
          })),
        });
      } catch (e) {
        resolve({ streams: [], error: String(e.message || e) });
      }
    });
  });
}

export function extractSegment({
  ffmpegPath,
  mediaPath,
  startSec,
  durationSec,
  outPath,
  sampleRate = 48000,
  audioStream = 0,
  channel = null,
}) {
  const args = ['-hide_banner', '-nostdin', '-y', '-i', mediaPath];
  // Negative start (clip at timeline head with handles reaching before the
  // media) is handled by decoding from 0 and padding at the front.
  const pad = startSec < 0 ? -startSec : 0;
  args.push('-ss', String(Math.max(0, startSec)));
  args.push('-t', String(durationSec - pad));
  args.push('-map', `0:a:${audioStream}`);
  // Pick a single channel out of an interleaved stream when asked; otherwise
  // downmix. Downmixing a stereo source that carries two DIFFERENT mics would
  // blend them and make alignment meaningless, so callers should be explicit.
  // `channel === 'all'` keeps every channel — used for rendering, where a
  // stereo target must stay stereo.
  const keepAll = channel === 'all';
  const filters = [];
  if (!keepAll && channel !== null && channel !== undefined) {
    filters.push(`pan=mono|c0=c${channel}`);
  }
  if (pad > 0) filters.push(`adelay=${Math.round(pad * 1000)}:all=1`);
  filters.push(`apad=whole_dur=${durationSec}`);
  args.push('-af', filters.join(','));
  if (!keepAll) args.push('-ac', '1');
  if (sampleRate) args.push('-ar', String(sampleRate));
  args.push('-c:a', 'pcm_f32le', outPath);
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`ffmpeg failed for ${mediaPath}: ${String(stderr).slice(-800)}`));
      } else {
        resolve();
      }
    });
  });
}
