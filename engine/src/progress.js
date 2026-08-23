// NDJSON progress/result protocol on stdout. One JSON object per line, for
// whatever drives engine/cli.js — the events carry per-pair progress and the
// result table. Nothing else may be written to stdout.
//
// The in-panel runner (uxp/js/runner.js) emits these same objects as callbacks
// rather than lines, so both paths report identically.

export function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

export const events = {
  start: (pairs) => emit({ event: 'start', pairs }),
  // Auto-mix works on mics, not pairs, and says so — a consumer must be able to
  // tell which kind of job it is reading from the first line.
  startAutoMix: (mics) => emit({ event: 'start', mode: 'automix', mics }),
  // The one-shot diagnostic block: per-pair geometry and per-mic behaviour.
  // spreadMs is the first number to look at on real material.
  summary: (payload) => emit({ event: 'automix', ...payload }),
  phase: (id, phase, pct = null) => emit({ event: 'phase', id, phase, pct }),
  result: (id, payload) => emit({ event: 'result', id, ...payload }),
  error: (id, message) => emit({ event: 'error', id, message }),
  done: (ok, failed) => emit({ event: 'done', ok, failed }),
};
