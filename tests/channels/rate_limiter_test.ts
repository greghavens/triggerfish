/**
 * Tests for per-user sliding-window rate limiter.
 *
 * Verifies that createUserRateLimiter correctly tracks per-sender
 * message frequency and throttles excessive requests.
 */
import { assertEquals } from "@std/assert";
import { createUserRateLimiter } from "../../src/channels/rate_limiter.ts";

// ─── Basic allow/deny ──────────────────────────────────────────────────────

Deno.test("rate limiter: first request for new sender is always allowed", () => {
  const limiter = createUserRateLimiter({ maxRequests: 5 });
  assertEquals(limiter.isAllowed("user-1"), true);
});

Deno.test("rate limiter: requests within limit are all allowed", () => {
  const limiter = createUserRateLimiter({ maxRequests: 3 });
  assertEquals(limiter.isAllowed("user-1"), true);
  assertEquals(limiter.isAllowed("user-1"), true);
  assertEquals(limiter.isAllowed("user-1"), true);
});

Deno.test("rate limiter: request over the limit is rejected", () => {
  const limiter = createUserRateLimiter({ maxRequests: 2 });
  assertEquals(limiter.isAllowed("user-1"), true);
  assertEquals(limiter.isAllowed("user-1"), true);
  assertEquals(limiter.isAllowed("user-1"), false);
});

// ─── Per-sender independence ───────────────────────────────────────────────

Deno.test("rate limiter: limits are independent per sender", () => {
  const limiter = createUserRateLimiter({ maxRequests: 1 });
  assertEquals(limiter.isAllowed("user-a"), true);
  assertEquals(limiter.isAllowed("user-b"), true);
  assertEquals(limiter.isAllowed("user-a"), false);
  assertEquals(limiter.isAllowed("user-b"), false);
});

// ─── Window expiry ─────────────────────────────────────────────────────────

Deno.test("rate limiter: window resets after windowMs elapsed", async () => {
  const limiter = createUserRateLimiter({
    maxRequests: 1,
    windowMs: 50,
  });
  assertEquals(limiter.isAllowed("user-1"), true);
  assertEquals(limiter.isAllowed("user-1"), false);

  // Wait for window to expire
  await new Promise((r) => setTimeout(r, 60));

  assertEquals(limiter.isAllowed("user-1"), true);
});

// ─── Prune ─────────────────────────────────────────────────────────────────

Deno.test("rate limiter: prune removes senders with no recent requests", async () => {
  const limiter = createUserRateLimiter({
    maxRequests: 5,
    windowMs: 50,
  });
  limiter.isAllowed("user-x");
  limiter.isAllowed("user-y");

  await new Promise((r) => setTimeout(r, 60));

  limiter.prune();
  // After pruning, both users should be allowed again (entries removed)
  assertEquals(limiter.isAllowed("user-x"), true);
  assertEquals(limiter.isAllowed("user-y"), true);
});

Deno.test("rate limiter: prune handles empty state gracefully", () => {
  const limiter = createUserRateLimiter({ maxRequests: 5 });
  // Should not throw
  limiter.prune();
});
