/**
 * Minimal fixed-window rate limiter, keyed by IP + route.
 *
 * In-memory on purpose: this guards a handful of admin endpoints on a
 * single instance. If the backend ever runs multiple instances, this needs
 * to move to shared storage — noted rather than pretended otherwise.
 */
const buckets = new Map();

// Drop expired buckets periodically so this can't grow without bound.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref();

function rateLimit({ windowMs, max, key = "default" }) {
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const bucketKey = `${key}:${ip}`;
    const now = Date.now();

    let bucket = buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(bucketKey, bucket);
    }

    bucket.count += 1;

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "Too many attempts. Try again shortly." });
    }

    next();
  };
}

module.exports = { rateLimit };
