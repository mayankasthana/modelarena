/**
 * Anti-abuse rate limiting (public PoC).
 *
 * Hand-rolled, in-memory, sliding-window limiter keyed by client IP. Keeps the
 * "express only / zero deps" goal while still defending the shared DO token
 * and budget from casual abuse. Sized comfortably UNDER DigitalOcean's gateway
 * limits (120 req/min, 5M tokens/day) so clients can never exhaust DO's quota
 * through our endpoint.
 *
 * NOTE: in-memory = per-instance. Keep the PoC at instance_count 1 so it's
 * meaningful; scale-out needs a shared store (Redis) — see DESIGN.md.
 */

function createRateLimiter({ windowMs = 60000, max = 10 } = {}) {
  const buckets = new Map(); // ip -> { windowStart, count }

  // Cheap periodic cleanup so the map doesn't grow unbounded.
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) if (now - v.windowStart > windowMs) buckets.delete(k);
  }, windowMs);
  cleanup.unref?.();

  return async function rateLimit(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const cur = buckets.get(ip);
    if (!cur || now - cur.windowStart >= windowMs) {
      buckets.set(ip, { windowStart: now, count: 1 });
      return next();
    }
    cur.count++;
    if (cur.count <= max) return next();

    const retryAfterSec = Math.ceil((cur.windowStart + windowMs - now) / 1000);
    res.setHeader('Retry-After', String(retryAfterSec));
    res.status(429).json({
      error: 'Too many requests',
      message: `Rate limit exceeded. Try again in ${retryAfterSec}s.`,
      retryAfterSec,
    });
  };
}

module.exports = { createRateLimiter };
