/**
 * Per-user sliding-window rate limiter for non-owner message throttling.
 *
 * Distinct from the LLM provider rate limiter in `src/agent/rate_limiter/`
 * which tracks TPM/RPM for API quotas. This module tracks per-sender
 * message frequency to prevent individual group members from flooding
 * the agent.
 *
 * @module
 */

/** Configuration for per-user rate limiting. */
export interface UserRateLimiterConfig {
  /** Maximum messages allowed per user within the window. */
  readonly maxRequests: number;
  /** Sliding window duration in milliseconds. Default: 60000. */
  readonly windowMs?: number;
}

/** Per-user sliding-window rate limiter. */
export interface UserRateLimiter {
  /** Returns true if the sender is within the rate limit. */
  isAllowed(senderId: string): boolean;
  /** Purge expired entries from the internal window map. */
  prune(): void;
}

/**
 * Create a per-user sliding-window rate limiter.
 *
 * Each sender has an independent window of timestamps. When a sender
 * exceeds maxRequests within windowMs, subsequent calls return false
 * until enough timestamps expire.
 */
export function createUserRateLimiter(
  config: UserRateLimiterConfig,
): UserRateLimiter {
  const windowMs = config.windowMs ?? 60_000;
  const windows = new Map<string, number[]>();

  return {
    isAllowed(senderId: string): boolean {
      const now = Date.now();
      const cutoff = now - windowMs;
      const timestamps = (windows.get(senderId) ?? []).filter(
        (t) => t > cutoff,
      );
      if (timestamps.length >= config.maxRequests) {
        windows.set(senderId, timestamps);
        return false;
      }
      timestamps.push(now);
      windows.set(senderId, timestamps);
      return true;
    },
    prune(): void {
      const now = Date.now();
      const cutoff = now - windowMs;
      for (const [id, timestamps] of windows) {
        const valid = timestamps.filter((t) => t > cutoff);
        if (valid.length === 0) windows.delete(id);
        else windows.set(id, valid);
      }
    },
  };
}
