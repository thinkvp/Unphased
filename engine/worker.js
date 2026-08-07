// Worker-thread entry for the pair pool. One long-lived worker per slot: pairs
// are pushed in as slots free up, so the FFT twiddle tables and polyphase table
// each worker builds are amortised across every pair it handles.

import { parentPort, workerData } from 'node:worker_threads';
import { runPair } from './src/runPair.js';

const { job, ffmpegPath } = workerData;

parentPort.on('message', async (msg) => {
  const { pair, refWavPath } = msg;
  const r = await runPair({
    ffmpegPath,
    job,
    pair,
    refWavPath,
    onPhase: (phase, pct) => parentPort.postMessage({ type: 'phase', id: pair.id, phase, pct }),
  });
  parentPort.postMessage({ type: 'result', id: pair.id, ok: r.ok, payload: r.payload, tgtWavPath: r.tgtWavPath });
});
