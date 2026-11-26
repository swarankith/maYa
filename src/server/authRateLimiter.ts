import type { Request } from 'express';

export interface AuthRateLimiterConfig {
  windowMs: number;
  maxRequests: number;
  nowFn?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Resolves client IP safely without blindly trusting spoofable X-Forwarded-For headers.
 * Forwarded headers are only honored when TRUST_PROXY=true and Express populates req.ip.
 */
export function getSafeClientIp(req: Pick<Request, 'ip' | 'socket'>): string {
  const trustProxy = process.env.TRUST_PROXY === 'true';
  const raw = trustProxy
    ? (req.ip || req.socket?.remoteAddress || 'unknown')
    : (req.socket?.remoteAddress || req.ip || 'unknown');
  return raw.replace(/^::ffff:/, '');
}

/**
 * In-memory sliding-window rate limiter for authentication endpoints.
 * Note: Suitable for single-instance SQLite deployments; multi-instance deployments
 * require a shared store (e.g., Redis) for cross-instance rate-limit state.
 */
export class AuthRateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly nowFn: () => number;
  private readonly buckets = new Map<string, number[]>();

  constructor(config: AuthRateLimiterConfig) {
    this.windowMs = Math.max(1_000, config.windowMs);
    this.maxRequests = Math.max(1, config.maxRequests);
    this.nowFn = config.nowFn ?? (() => Date.now());
  }

  consume(key: string): RateLimitResult {
    const now = this.nowFn();
    const cutoff = now - this.windowMs;
    const existing = (this.buckets.get(key) ?? []).filter((ts) => ts > cutoff);

    if (existing.length >= this.maxRequests) {
      const oldest = existing[0] ?? now;
      const retryAfterMs = Math.max(1_000, oldest + this.windowMs - now);
      this.buckets.set(key, existing);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      };
    }

    existing.push(now);
    this.buckets.set(key, existing);
    return {
      allowed: true,
      remaining: Math.max(0, this.maxRequests - existing.length),
      retryAfterSeconds: 0,
    };
  }
}
