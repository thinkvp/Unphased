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
  phase: (id, phase, pct = null) => emit({ event: 'phase', id, phase, pct }),
  result: (id, payload) => emit({ event: 'result', id, ...payload }),
  error: (id, message) => emit({ event: 'error', id, message }),
  done: (ok, failed) => emit({ event: 'done', ok, failed }),
};
