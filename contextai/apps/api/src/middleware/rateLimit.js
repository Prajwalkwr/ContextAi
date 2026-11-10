export function rateLimit({ windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000, max = Number(process.env.RATE_LIMIT_MAX) || 120, keyOf } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    const key = keyOf?.(req) || req.headers['x-project-key'] || req.headers.authorization || req.ip;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
      if (buckets.size > 10000) for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
    }
    bucket.count++;
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - bucket.count));
    if (bucket.count > max) return res.status(429).json({ error: 'Rate limit exceeded' });
    next();
  };
}
