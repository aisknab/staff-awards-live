import { rateLimited } from './errors.js';

export class RateLimiter {
  constructor() {
    this.buckets = new Map();
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref?.();
  }

  check(namespace, key, limit, windowMs) {
    const now = Date.now();
    const bucketKey = `${namespace}:${key}`;
    let bucket = this.buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      throw rateLimited(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)));
    }
  }

  reset(namespace, key) {
    this.buckets.delete(`${namespace}:${key}`);
  }

  cleanup() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
  }

  close() {
    clearInterval(this.cleanupTimer);
    this.buckets.clear();
  }
}
