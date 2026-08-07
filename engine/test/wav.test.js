import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, decodeWav } from '../src/wav.js';
import { mulberry32 } from './fixtures.js';

function randomAudio(channels, frames, seed) {
  const rand = mulberry32(seed);
  const data = [];
  for (let c = 0; c < channels; c++) {
    data.push(new Float64Array(frames).map(() => rand() * 1.8 - 0.9));
  }
  return { sampleRate: 48000, data };
}

for (const [format, tol] of [
  ['pcm16', 1 / 32768],
  ['pcm24', 1 / 8388608],
  ['f32', 1e-7],
]) {
  test(`wav round-trip ${format} mono`, () => {
    const audio = randomAudio(1, 4801, 1);
    const decoded = decodeWav(encodeWav(audio, format));
    assert.equal(decoded.sampleRate, 48000);
    assert.equal(decoded.channels, 1);
    assert.equal(decoded.data[0].length, 4801);
    for (let i = 0; i < 4801; i++) {
      assert.ok(Math.abs(decoded.data[0][i] - audio.data[0][i]) <= tol, `sample ${i}`);
    }
  });
}

test('wav round-trip pcm24 stereo', () => {
  const audio = randomAudio(2, 1000, 2);
  const decoded = decodeWav(encodeWav(audio, 'pcm24'));
  assert.equal(decoded.channels, 2);
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < 1000; i++) {
      assert.ok(Math.abs(decoded.data[c][i] - audio.data[c][i]) <= 1 / 8388608);
    }
  }
});

test('wav reader skips unknown metadata chunks (BWF-style)', () => {
  const audio = randomAudio(1, 100, 3);
  const plain = encodeWav(audio, 'pcm16');
  // splice a fake 'bext' chunk between fmt and data
  const bextBody = Buffer.alloc(601); // odd body exercises word-alignment padding
  const bext = Buffer.concat([Buffer.from('bext'), Buffer.alloc(4), bextBody, Buffer.alloc(1)]);
  bext.writeUInt32LE(601, 4);
  const out = Buffer.concat([plain.subarray(0, 36), bext, plain.subarray(36)]);
  out.writeUInt32LE(out.length - 8, 4);
  const decoded = decodeWav(out);
  assert.equal(decoded.data[0].length, 100);
  for (let i = 0; i < 100; i++) {
    assert.ok(Math.abs(decoded.data[0][i] - audio.data[0][i]) <= 1 / 32768);
  }
});

test('wav reader rejects non-wav data', () => {
  assert.throws(() => decodeWav(Buffer.from('this is not a wav file, sorry')));
});
