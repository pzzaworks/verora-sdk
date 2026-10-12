/**
 * In-memory per-key token bucket. Memory is bounded: once `maxKeys` clients are tracked, the least
 * recently seen one is evicted (a Map iterates in insertion order and every hit re-inserts its key).
 */
export interface RateLimiterOptions {
  /** Requests a client may make in a burst */
  burst: number;
  /** Sustained requests per minute once the burst is spent */
  perMinute: number;
  maxKeys?: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly refillPerMs: number;
  private readonly maxKeys: number;

  constructor(private readonly options: RateLimiterOptions) {
    this.refillPerMs = options.perMinute / 60_000;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  /** Takes one token for `key`; returns 0 when allowed, otherwise the seconds until the next token */
  take(key: string, now = Date.now()): number {
    const previous = this.buckets.get(key);
    const tokens = previous
      ? Math.min(this.options.burst, previous.tokens + (now - previous.updatedAt) * this.refillPerMs)
      : this.options.burst;

    this.buckets.delete(key);
    if (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next();
      if (!oldest.done) this.buckets.delete(oldest.value);
    }

    if (tokens < 1) {
      this.buckets.set(key, { tokens, updatedAt: now });
      return Math.ceil((1 - tokens) / this.refillPerMs / 1000);
    }
    this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    return 0;
  }
}
