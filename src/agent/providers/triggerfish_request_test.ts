/**
 * Tests for Triggerfish Gateway error formatting.
 *
 * The gateway returns structured JSON for known error conditions
 * (daily/session budget exhaustion). The formatter must turn that into a
 * friendly one-line message rather than dumping raw JSON to the user.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

import { formatGatewayError } from "./triggerfish_request.ts";

Deno.test("formatGatewayError - daily_budget_exhausted includes friendly text, reset, and upgrade link", () => {
  const body = JSON.stringify({
    error: "daily_budget_exhausted",
    message: "Daily usage limit reached. Resets at midnight UTC.",
    resets_at: "2026-03-12T00:00:00.000Z",
    upgrade_url: "https://trigger.fish/p/pricing",
  });

  const out = formatGatewayError(429, body);

  assertStringIncludes(out, "Daily usage limit reached");
  assertStringIncludes(out, "2026-03-12 00:00 UTC");
  assertStringIncludes(out, "https://trigger.fish/p/pricing");
});

Deno.test("formatGatewayError - session_budget_exhausted includes upgrade link", () => {
  const body = JSON.stringify({
    error: "session_budget_exhausted",
    upgrade_url: "https://trigger.fish/p/pricing",
  });

  const out = formatGatewayError(429, body);

  assertStringIncludes(out, "Session budget exhausted");
  assertStringIncludes(out, "https://trigger.fish/p/pricing");
});

Deno.test("formatGatewayError - falls back to message field for other JSON errors", () => {
  const body = JSON.stringify({
    error: "model_unavailable",
    message: "The requested model is temporarily unavailable.",
  });

  const out = formatGatewayError(503, body);

  assertStringIncludes(out, "The requested model is temporarily unavailable.");
  assertStringIncludes(out, "(503)");
});

Deno.test("formatGatewayError - falls back to error code when no message", () => {
  const body = JSON.stringify({ error: "internal_error" });

  const out = formatGatewayError(500, body);

  assertStringIncludes(out, "internal_error");
  assertStringIncludes(out, "500");
});

Deno.test("formatGatewayError - falls back to raw text when body is not JSON", () => {
  const out = formatGatewayError(502, "Bad Gateway");

  assertStringIncludes(out, "Bad Gateway");
  assertStringIncludes(out, "502");
});

Deno.test("formatGatewayError - handles empty body", () => {
  const out = formatGatewayError(500, "");

  assertEquals(out, "Triggerfish Gateway error (500)");
});

Deno.test("formatGatewayError - preserves bare (status) for retry detection", () => {
  for (const status of [429, 502, 503]) {
    const out = formatGatewayError(status, "Bad Gateway");
    assertStringIncludes(
      out,
      `(${status})`,
      `expected bare (${status}) so retry.ts isRetryableError still triggers`,
    );
  }
});

Deno.test("formatGatewayError - handles invalid resets_at gracefully", () => {
  const body = JSON.stringify({
    error: "daily_budget_exhausted",
    resets_at: "not-a-date",
    upgrade_url: "https://trigger.fish/p/pricing",
  });

  const out = formatGatewayError(429, body);

  assertStringIncludes(out, "Daily usage limit reached");
  assertStringIncludes(out, "not-a-date");
});
