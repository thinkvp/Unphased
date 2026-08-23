// Unit tests for the panel's pairing logic (UMD module, loaded via CJS interop).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildPairs, defaultSourceMap } = require('../../uxp/js/pairing.js');

function clip(over) {
  return {
    name: 'clip',
    nodeId: 'n' + Math.floor(over.startSeconds * 1000),
    mediaPath: 'C:\\media\\file.wav',
    startSeconds: 0,
    endSeconds: 10,
    inPointSeconds: 0,
    outPointSeconds: 10,
    disabled: false,
    speedFactor: 1,
    ...over,
  };
}

function seq(tracks) {
  return { audioTracks: tracks.map((clips, i) => ({ index: i, name: 'A' + (i + 1), clips })) };
}

test('pairing: full overlap pairs clip with source-mapped intervals', () => {
  const info = seq([
    [clip({ name: 'boom', startSeconds: 5, endSeconds: 35, inPointSeconds: 2, mediaPath: 'C:\\m\\boom.wav' })],
    [clip({ name: 'lav', startSeconds: 10, endSeconds: 30, inPointSeconds: 1, mediaPath: 'C:\\m\\lav.wav' })],
  ]);
  const { pairs, warnings } = buildPairs(info, 0, [1]);
  assert.equal(pairs.length, 1);
  assert.equal(warnings.length, 0);
  const p = pairs[0];
  // overlap is [10, 30) — the whole lav clip
  assert.equal(p.placeStartSeconds, 10);
  assert.equal(p.alignDurationSec, 20);
  // boom source: inPoint 2 + (10 - 5) = 7
  assert.equal(p.ref.startSec, 7);
  assert.equal(p.ref.durationSec, 20);
  // lav source: inPoint 1 + (10 - 10) = 1
  assert.equal(p.target.startSec, 1);
  assert.equal(p.partial, false);
});

test('pairing: partial overlap aligns the covered part and leaves the original audible', () => {
  const info = seq([
    [clip({ name: 'boom', startSeconds: 0, endSeconds: 12 })],
    [clip({ name: 'lav', startSeconds: 8, endSeconds: 28 })],
  ]);
  const { pairs, warnings } = buildPairs(info, 0, [1]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].alignDurationSec, 4);
  assert.equal(pairs[0].coversWholeClip, false);
  // muting a clip that is only 20% replaced would leave a silent hole
  assert.equal(pairs[0].muteOriginal, false);
  assert.ok(warnings.some((w) => /left audible so no gap/.test(w.reason)));
});

test('pairing: a target spanning several reference clips yields one pair per segment', () => {
  const info = seq([
    [
      clip({ name: 'boomA', startSeconds: 0, endSeconds: 10, inPointSeconds: 3, mediaPath: 'C:\\m\\a.wav' }),
      clip({ name: 'boomB', startSeconds: 10, endSeconds: 20, inPointSeconds: 0, mediaPath: 'C:\\m\\b.wav' }),
      clip({ name: 'boomC', startSeconds: 20, endSeconds: 30, inPointSeconds: 7, mediaPath: 'C:\\m\\c.wav' }),
    ],
    [clip({ name: 'lav', startSeconds: 0, endSeconds: 30, inPointSeconds: 0, mediaPath: 'C:\\m\\lav.wav' })],
  ]);
  const { pairs } = buildPairs(info, 0, [1]);
  assert.equal(pairs.length, 3, 'expected a pair per overlapping reference clip');
  assert.deepEqual(pairs.map((p) => p.placeStartSeconds), [0, 10, 20]);
  assert.deepEqual(pairs.map((p) => p.alignDurationSec), [10, 10, 10]);
  assert.deepEqual(pairs.map((p) => p.ref.mediaPath.split('\\').pop()), ['a.wav', 'b.wav', 'c.wav']);
  // each segment reads the correct source time from its own reference clip
  assert.deepEqual(pairs.map((p) => p.ref.startSec), [3, 0, 7]);
  // and the target source time advances across segments
  assert.deepEqual(pairs.map((p) => p.target.startSec), [0, 10, 20]);
  // fully covered -> the original is muted exactly once
  assert.equal(pairs.filter((p) => p.muteOriginal).length, 1);
  assert.ok(pairs.every((p) => p.coversWholeClip));
  // distinct output files
  assert.equal(new Set(pairs.map((p) => p.outputFileName)).size, 3);
});

test('pairing: reference gap leaves the original audible and skips the short piece', () => {
  const info = seq([
    [
      clip({ name: 'boomA', startSeconds: 0, endSeconds: 10, mediaPath: 'C:\\m\\a.wav' }),
      // 1 s sliver, below the 2 s minimum
      clip({ name: 'boomB', startSeconds: 14, endSeconds: 15, mediaPath: 'C:\\m\\b.wav' }),
      clip({ name: 'boomC', startSeconds: 20, endSeconds: 30, mediaPath: 'C:\\m\\c.wav' }),
    ],
    [clip({ name: 'lav', startSeconds: 0, endSeconds: 30, mediaPath: 'C:\\m\\lav.wav' })],
  ]);
  const { pairs, warnings } = buildPairs(info, 0, [1], { minOverlapSec: 2 });
  assert.equal(pairs.length, 2, 'the 1 s sliver must be skipped');
  assert.ok(warnings.some((w) => /shorter than 2 s were skipped/.test(w.reason)));
  assert.ok(pairs.every((p) => p.muteOriginal === false), 'partial coverage must not mute');
});

test('pairing: below-minimum overlap is skipped with warning', () => {
  const info = seq([
    [clip({ name: 'boom', startSeconds: 0, endSeconds: 9 })],
    [clip({ name: 'lav', startSeconds: 8, endSeconds: 20 })],
  ]);
  const { pairs, warnings } = buildPairs(info, 0, [1], { minOverlapSec: 2 });
  assert.equal(pairs.length, 0);
  assert.ok(warnings.some((w) => /insufficient overlap/.test(w.reason)));
});

test('pairing: speed-changed and offline clips are excluded', () => {
  const info = seq([
    [clip({ name: 'boom', mediaPath: 'C:\\m\\boom.wav' })],
    [
      clip({ name: 'fast', mediaPath: 'C:\\m\\lav.wav', speedFactor: 1.5 }),
      clip({ name: 'offline', mediaPath: null }),
      clip({ name: 'good', mediaPath: 'C:\\m\\lav.wav' }),
    ],
  ]);
  const { pairs, warnings } = buildPairs(info, 0, [1]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].label, 'good');
  assert.ok(warnings.some((w) => w.clip === 'fast' && /speed/.test(w.reason)));
  assert.ok(warnings.some((w) => w.clip === 'offline' && /offline/.test(w.reason)));
});

test('pairing: uses every overlapping reference clip, not just the longest', () => {
  const info = seq([
    [
      clip({ name: 'boomA', startSeconds: 0, endSeconds: 6, inPointSeconds: 0, mediaPath: 'C:\\m\\a.wav' }),
      clip({ name: 'boomB', startSeconds: 6, endSeconds: 30, inPointSeconds: 0, mediaPath: 'C:\\m\\b.wav' }),
    ],
    [clip({ name: 'lav', startSeconds: 2, endSeconds: 20, inPointSeconds: 0, mediaPath: 'C:\\m\\lav.wav' })],
  ]);
  const { pairs } = buildPairs(info, 0, [1]);
  assert.equal(pairs.length, 2, 'both the 4 s and 14 s overlaps should be aligned');
  // segment 1: [2, 6) against boomA; segment 2: [6, 20) against boomB
  assert.deepEqual(pairs.map((p) => p.placeStartSeconds), [2, 6]);
  assert.deepEqual(pairs.map((p) => p.alignDurationSec), [4, 14]);
  assert.deepEqual(pairs.map((p) => p.ref.mediaPath.split('\\').pop()), ['a.wav', 'b.wav']);
  // boomA source time at timeline 2 s is inPoint 0 + (2 - 0) = 2
  assert.equal(pairs[0].ref.startSec, 2);
  // target source time at timeline 2 s is inPoint 0 + (2 - 2) = 0
  assert.equal(pairs[0].target.startSec, 0);
  // the clip is fully covered, so the original is muted once
  assert.equal(pairs.filter((p) => p.muteOriginal).length, 1);
  assert.ok(pairs.every((p) => /\[\d\/2\]/.test(p.label)), 'labels should show segment numbering');
});

test('pairing: refuses self-alignment when both sides decode identical audio', () => {
  // the real-world trap: one camera file spread across two tracks, no source
  // map, so both sides would extract stream 0 and null perfectly against itself
  const same = 'C:\\m\\camera.mxf';
  const info = seq([
    [clip({ name: 'camA', mediaPath: same, startSeconds: 0, endSeconds: 30, inPointSeconds: 5 })],
    [clip({ name: 'camB', mediaPath: same, startSeconds: 0, endSeconds: 30, inPointSeconds: 5 })],
  ]);
  const { pairs, warnings } = buildPairs(info, 0, [1]);
  assert.equal(pairs.length, 0);
  assert.ok(warnings.some((w) => /same file, same time, same channel/.test(w.reason)));
});

test('pairing: distinct streams of one file are a legitimate pair', () => {
  const same = 'C:\\m\\camera.mxf';
  const info = seq([
    [clip({ name: 'camA', mediaPath: same, startSeconds: 0, endSeconds: 30, inPointSeconds: 5 })],
    [clip({ name: 'camB', mediaPath: same, startSeconds: 0, endSeconds: 30, inPointSeconds: 5 })],
  ]);
  const sourceMap = { 0: { audioStream: 0, channel: null }, 1: { audioStream: 1, channel: null } };
  const { pairs } = buildPairs(info, 0, [1], { sourceMap });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].ref.audioStream, 0);
  assert.equal(pairs[0].target.audioStream, 1);
});

test('defaultSourceMap: one mono stream per track, in track order', () => {
  const same = 'C:\\m\\camera.mxf';
  const info = seq([
    [clip({ mediaPath: same })],
    [clip({ mediaPath: same })],
    [clip({ mediaPath: same })],
    [clip({ mediaPath: 'C:\\m\\lav.wav' })],
  ]);
  const probe = {
    [same]: { streams: [{ index: 0, channels: 1 }, { index: 1, channels: 1 }, { index: 2, channels: 1 }] },
    'C:\\m\\lav.wav': { streams: [{ index: 0, channels: 1 }] },
  };
  const map = defaultSourceMap(info, probe);
  assert.deepEqual(map[0], { audioStream: 0, channel: null });
  assert.deepEqual(map[1], { audioStream: 1, channel: null });
  assert.deepEqual(map[2], { audioStream: 2, channel: null });
  assert.deepEqual(map[3], { audioStream: 0, channel: null });
});

test('defaultSourceMap: interleaved stereo splits by channel', () => {
  const same = 'C:\\m\\cam.mp4';
  const info = seq([[clip({ mediaPath: same })], [clip({ mediaPath: same })]]);
  const map = defaultSourceMap(info, { [same]: { streams: [{ index: 0, channels: 2 }] } });
  assert.deepEqual(map[0], { audioStream: 0, channel: 0 });
  assert.deepEqual(map[1], { audioStream: 0, channel: 1 });
});

test('defaultSourceMap: a stereo file on one track keeps both channels', () => {
  // Pinning it to channel 0 would also render the clip mono, since the render
  // path only preserves channels when no single channel was chosen.
  const info = seq([
    [clip({ mediaPath: 'C:\\m\\stereo.wav' })],
    [clip({ mediaPath: 'C:\\m\\lav.wav' })],
  ]);
  const probe = {
    'C:\\m\\stereo.wav': { streams: [{ index: 0, channels: 2 }] },
    'C:\\m\\lav.wav': { streams: [{ index: 0, channels: 1 }] },
  };
  const map = defaultSourceMap(info, probe);
  assert.deepEqual(map[0], { audioStream: 0, channel: null });
  assert.deepEqual(map[1], { audioStream: 0, channel: null });
});

test('defaultSourceMap: a real multi-stream file makes the camera case pairable', () => {
  const same = 'C:\\m\\camera.mxf';
  const info = seq([
    [clip({ name: 'A1', mediaPath: same, startSeconds: 0, endSeconds: 30 })],
    [clip({ name: 'A2', mediaPath: same, startSeconds: 0, endSeconds: 30 })],
  ]);
  const probe = { [same]: { streams: [{ index: 0, channels: 1 }, { index: 1, channels: 1 }] } };
  const { pairs, warnings } = buildPairs(info, 0, [1], { sourceMap: defaultSourceMap(info, probe) });
  assert.equal(pairs.length, 1, warnings.map((w) => w.reason).join('; '));
  assert.notEqual(pairs[0].ref.audioStream, pairs[0].target.audioStream);
});

test('selectedOnly: only selected target clips are paired', () => {
  const info = seq([
    [clip({ name: 'boom', startSeconds: 0, endSeconds: 60, mediaPath: 'C:\\m\\boom.wav' })],
    [
      clip({ name: 'a', startSeconds: 0, endSeconds: 20, mediaPath: 'C:\\m\\lav.wav', selected: true }),
      clip({ name: 'b', startSeconds: 20, endSeconds: 40, mediaPath: 'C:\\m\\lav.wav', selected: false }),
    ],
  ]);
  const { pairs } = buildPairs(info, 0, [1], { selectedOnly: true });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].label, 'a');
});

test('selectedOnly: the reference track is not filtered by selection', () => {
  // The reference is the yardstick — it must supply material wherever a target
  // overlaps it, selected or not.
  const info = seq([
    [clip({ name: 'boom', startSeconds: 0, endSeconds: 60, mediaPath: 'C:\\m\\boom.wav', selected: false })],
    [clip({ name: 'lav', startSeconds: 0, endSeconds: 20, mediaPath: 'C:\\m\\lav.wav', selected: true })],
  ]);
  const { pairs } = buildPairs(info, 0, [1], { selectedOnly: true });
  assert.equal(pairs.length, 1);
});

test('selectedOnly: an unselected clip is out of scope, not a warning', () => {
  // Offline media on an unselected clip must not produce noise about a clip
  // the user never asked to align.
  const info = seq([
    [clip({ name: 'boom', startSeconds: 0, endSeconds: 60, mediaPath: 'C:\\m\\boom.wav' })],
    [
      clip({ name: 'good', startSeconds: 0, endSeconds: 20, mediaPath: 'C:\\m\\lav.wav', selected: true }),
      clip({ name: 'offline', startSeconds: 20, endSeconds: 40, mediaPath: null, selected: false }),
    ],
  ]);
  const { pairs, warnings } = buildPairs(info, 0, [1], { selectedOnly: true });
  assert.equal(pairs.length, 1);
  assert.equal(warnings.length, 0);
});

test('selectedOnly: nothing selected explains itself', () => {
  const info = seq([
    [clip({ name: 'boom', startSeconds: 0, endSeconds: 60, mediaPath: 'C:\\m\\boom.wav' })],
    [clip({ name: 'lav', startSeconds: 0, endSeconds: 20, mediaPath: 'C:\\m\\lav.wav', selected: false })],
  ]);
  const { pairs, warnings } = buildPairs(info, 0, [1], { selectedOnly: true });
  assert.equal(pairs.length, 0);
  assert.match(warnings[0].reason, /no clips are selected/);
});

test('selection is ignored when the scope is the whole sequence', () => {
  const info = seq([
    [clip({ name: 'boom', startSeconds: 0, endSeconds: 60, mediaPath: 'C:\\m\\boom.wav' })],
    [
      clip({ name: 'a', startSeconds: 0, endSeconds: 20, mediaPath: 'C:\\m\\lav.wav', selected: true }),
      clip({ name: 'b', startSeconds: 20, endSeconds: 40, mediaPath: 'C:\\m\\lav.wav', selected: false }),
    ],
  ]);
  const { pairs } = buildPairs(info, 0, [1]);
  assert.equal(pairs.length, 2);
});

test('pairing: reference track cannot be its own target', () => {
  const info = seq([
    [clip({ name: 'boom', mediaPath: 'C:\\m\\boom.wav' })],
    [clip({ name: 'lav', mediaPath: 'C:\\m\\lav.wav' })],
  ]);
  const { pairs } = buildPairs(info, 0, [0, 1]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].tgtTrackIndex, 1);
});
