import { assertEquals } from "@std/assert";
import { createXRateLimiter } from "../../../src/integrations/x/client/rate_limiter.ts";

let now = 1_700_000_000_000;
const nowFn = () => now;

function rateLimitHeaders(
  remaining: string,
  reset: string,
): Headers {
  return new Headers({
    "x-rate-limit-remaining": remaining,
    "x-rate-limit-reset": reset,
  });
}

Deno.test("XRateLimiter: unknown endpoint returns ok", () => {
  const limiter = createXRateLimiter(nowFn);
  const result = limiter.checkLimit("/2/tweets");
  assertEquals(result, { ok: true });
});

Deno.test("XRateLimiter: allows requests when remaining > 0", () => {
  const limiter = createXRateLimiter(nowFn);
  limiter.recordResponse(
    "/2/tweets",
    rateLimitHeaders("5", "1700001000"),
  );
  const result = limiter.checkLimit("/2/tweets");
  assertEquals(result.ok, true);
});

Deno.test("XRateLimiter: blocks requests when remaining is 0", () => {
  const limiter = createXRateLimiter(nowFn);
  limiter.recordResponse(
    "/2/tweets",
    rateLimitHeaders("0", "1700001000"),
  );
  const result = limiter.checkLimit("/2/tweets");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.endpoint, "/2/tweets");
    assertEquals(result.error.resetAt, 1_700_001_000);
  }
});

Deno.test("XRateLimiter: auto-clears expired window", () => {
  now = 1_700_000_000_000;
  const limiter = createXRateLimiter(nowFn);
  limiter.recordResponse(
    "/2/tweets",
    rateLimitHeaders("0", "1700001000"),
  );

  // Before reset — blocked
  assertEquals(limiter.checkLimit("/2/tweets").ok, false);

  // Advance clock past resetAt (1700001000 seconds)
  now = 1_700_001_001_000;
  assertEquals(limiter.checkLimit("/2/tweets").ok, true);

  // Reset clock for other tests
  now = 1_700_000_000_000;
});

Deno.test("XRateLimiter: ignores missing rate limit headers", () => {
  const limiter = createXRateLimiter(nowFn);
  limiter.recordResponse(
    "/2/tweets",
    new Headers({ "content-type": "application/json" }),
  );
  const result = limiter.checkLimit("/2/tweets");
  assertEquals(result, { ok: true });
});

Deno.test("XRateLimiter: ignores invalid NaN header values", () => {
  const limiter = createXRateLimiter(nowFn);
  limiter.recordResponse(
    "/2/tweets",
    rateLimitHeaders("abc", "xyz"),
  );
  const result = limiter.checkLimit("/2/tweets");
  assertEquals(result, { ok: true });
});

Deno.test("XRateLimiter: reset clears all state", () => {
  const limiter = createXRateLimiter(nowFn);
  limiter.recordResponse(
    "/2/tweets",
    rateLimitHeaders("0", "1700001000"),
  );
  assertEquals(limiter.checkLimit("/2/tweets").ok, false);

  limiter.reset();
  assertEquals(limiter.checkLimit("/2/tweets").ok, true);
});

Deno.test("XRateLimiter: tracks multiple endpoints independently", () => {
  const limiter = createXRateLimiter(nowFn);
  limiter.recordResponse(
    "/2/tweets",
    rateLimitHeaders("0", "1700001000"),
  );
  limiter.recordResponse(
    "/2/users",
    rateLimitHeaders("10", "1700001000"),
  );

  assertEquals(limiter.checkLimit("/2/tweets").ok, false);
  assertEquals(limiter.checkLimit("/2/users").ok, true);
});
