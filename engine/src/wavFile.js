// Node-only file wrappers around the pure codec in wav.js.
//
// Kept separate so wav.js itself imports nothing: the UXP plugin shares the
// codec verbatim but reads and writes through UXP's own fs, not node:fs.

import { readFileSync, writeFileSync } from 'node:fs';
import { decodeWav, encodeWav } from './wav.js';

export function readWav(path) {
  return decodeWav(readFileSync(path));
}

export function writeWav(path, audio, format = 'pcm24') {
  writeFileSync(path, encodeWav(audio, format));
}
