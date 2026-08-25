/**
 * Minimal structured logger — single-line JSON to stdout.
 *
 * Every record carries a timestamp, level, message, and caller-specified
 * fields. A per-request context (requestId, traceId, ip) is attached via
 * `log.with({...})` so all lines for one request/trace correlate — the basis
 * for request-scoped audit + tracing without a heavy SDK. In production this
 * streams to DigitalOcean Managed Logging / a collector; the format stays
 * JSON so downstream parsing is unchanged.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[process.env.LOG_LEVEL || 'info'] || 20;

function scope(ctx = {}) {
  const fn = (level, msg, fields) => {
    if ((LEVELS[level] || 20) < THRESHOLD) return;
    const rec = { ts: new Date().toISOString(), level, msg, ...ctx, ...(fields || {}) };
    process.stdout.write(JSON.stringify(rec) + '\n');
  };
  for (const l of Object.keys(LEVELS)) fn[l] = (msg, fields) => fn(l, msg, fields);
  fn.with = (extra) => scope({ ...ctx, ...extra });
  return fn;
}

module.exports = { scope, log: scope() };
