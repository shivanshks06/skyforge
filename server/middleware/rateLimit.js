const buckets = new Map();

function requestKey(req, prefix, keyResolver) {
  const identity = keyResolver ? keyResolver(req) : req.ip || req.socket?.remoteAddress || "unknown";
  return `${prefix}:${String(identity || "unknown")}`;
}

function sweepExpired(now) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function rateLimit({ windowMs, max, prefix = "general", message = "Too many requests. Please try again later.", keyResolver }) {
  const safeWindowMs = Math.max(1_000, Number(windowMs) || 60_000);
  const safeMax = Math.max(1, Number(max) || 60);
  return (req, res, next) => {
    const now = Date.now();
    const key = requestKey(req, prefix, keyResolver);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + safeWindowMs };
      buckets.set(key, bucket);
    }

    if (bucket.count >= safeMax) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ message, retryAfter });
    }

    bucket.count += 1;
    if (buckets.size > 10_000) {
      sweepExpired(now);
      while (buckets.size > 10_000) buckets.delete(buckets.keys().next().value);
    }
    res.set("X-RateLimit-Limit", String(safeMax));
    res.set("X-RateLimit-Remaining", String(Math.max(0, safeMax - bucket.count)));
    res.set("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
    return next();
  };
}

export function resetRateLimits() {
  buckets.clear();
}
