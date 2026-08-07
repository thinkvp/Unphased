// Pair-level parallelism for the CLI. alignPair is a pure function of its
// inputs and pairs never touch each other's files, so the only thing stopping
// the job from using every core was the serial loop it used to run in.
//
// Node-only; not part of the shared engine (see runPair.js).

import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { runPair } from './runPair.js';

// A 5-minute 48 kHz mono pair holds reference, target, aligned and rendered
// audio as Float64Array — around 100 MB per live pair, before ffmpeg's own
// footprint. Cores are rarely the binding constraint; memory is.
const MB_PER_PAIR_SECOND = 48000 * 8 * 5 / 1e6;
const MEMORY_BUDGET_MB = 1500;
const HARD_CAP = 4;

/**
 * How many pairs to have in flight. Deliberately conservative: the win from
 * 2 workers to 4 is small next to the win from 1 to 2, and an out-of-memory
 * kill loses the whole job.
 */
export function planConcurrency(pairs, { override = null, cap = HARD_CAP } = {}) {
  if (override) return Math.max(1, Math.min(override, pairs.length || 1));
  const longestSec = pairs.reduce((s, p) => Math.max(s, p.target.durationSec + 2 * p.handleSec), 0);
  const perPairMb = Math.max(1, longestSec * MB_PER_PAIR_SECOND);
  const byMemory = Math.floor(MEMORY_BUDGET_MB / perPairMb);
  const byCores = Math.max(1, cpus().length - 1);
  return Math.max(1, Math.min(cap, byCores, byMemory, pairs.length || 1));
}

/**
 * Run `tasks` through `limit` workers, reporting phases and results as they
 * land. Results arrive in completion order, not job order — every event
 * carries its pair id, which is what the panel keys off.
 *
 * Falls back to running in-process when limit is 1, so a single-pair job never
 * pays for spawning a thread and the serial path stays exercised.
 */
export async function runPairs({ job, ffmpegPath, tasks, limit, onPhase, onResult }) {
  if (limit <= 1) {
    for (const { pair, refWavPath } of tasks) {
      const r = await runPair({
        ffmpegPath, job, pair, refWavPath,
        onPhase: (phase, pct) => onPhase(pair.id, phase, pct),
      });
      onResult(pair.id, r);
    }
    return;
  }

  const queue = tasks.slice();
  const url = new URL('../worker.js', import.meta.url);
  const workers = [];
  await new Promise((resolve, reject) => {
    let active = 0;
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve();
    };

    const retired = new WeakSet();
    const pump = (worker) => {
      const next = queue.shift();
      if (!next) {
        // no work left for this worker; let it go. Mark it first: terminate()
        // exits with a nonzero code, which the exit handler must not read as
        // a crash.
        retired.add(worker);
        worker.terminate();
        if (--active === 0) finish(null);
        return;
      }
      worker.postMessage({ pair: next.pair, refWavPath: next.refWavPath });
    };

    for (let i = 0; i < limit; i++) {
      const worker = new Worker(url, { workerData: { job, ffmpegPath } });
      workers.push(worker);
      active++;
      worker.on('message', (msg) => {
        if (msg.type === 'phase') {
          onPhase(msg.id, msg.phase, msg.pct);
          return;
        }
        onResult(msg.id, { ok: msg.ok, payload: msg.payload, tgtWavPath: msg.tgtWavPath });
        pump(worker);
      });
      // A worker that dies takes only its current pair with it; the pair was
      // already reported failed by runPair unless the thread itself died, so
      // treat an unexpected exit as fatal rather than silently losing pairs.
      worker.on('error', (err) => finish(err));
      worker.on('exit', (code) => {
        if (!retired.has(worker) && code !== 0 && !settled) {
          finish(new Error(`worker exited with code ${code}`));
        }
      });
      pump(worker);
    }
  }).finally(() => {
    for (const w of workers) w.terminate();
  });
}
