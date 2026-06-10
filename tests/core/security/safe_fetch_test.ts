/**
 * Tests for the SSRF-checked fetch helpers in core/security/safe_fetch.ts:
 * validateOutboundUrl and createSsrfCheckedFetch.
 */
import { assertEquals, assertRejects } from "@std/assert";
import {
  createSsrfCheckedFetch,
  validateOutboundUrl,
} from "../../../src/core/security/mod.ts";

const allowChecker = (_hostname: string) =>
  Promise.resolve({ ok: true as const, value: "8.8.8.8" });

const blockChecker = (hostname: string) =>
  Promise.resolve({
    ok: false as const,
    error: `SSRF blocked: ${hostname} resolves to private IP`,
  });

// ─── validateOutboundUrl ─────────────────────────────────────────────────────

Deno.test("validateOutboundUrl: rejects an invalid URL", async () => {
  const result = await validateOutboundUrl("not a url", allowChecker);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.includes("Invalid URL"), true);
});

Deno.test("validateOutboundUrl: rejects non-http protocols", async () => {
  const result = await validateOutboundUrl(
    "ftp://example.com/file",
    allowChecker,
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("Unsupported protocol"), true);
  }
});

Deno.test("validateOutboundUrl: blocks when the SSRF checker fails", async () => {
  const result = await validateOutboundUrl(
    "https://internal.example.com/x",
    blockChecker,
  );
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.includes("SSRF blocked"), true);
});

Deno.test("validateOutboundUrl: passes a public URL through", async () => {
  const result = await validateOutboundUrl(
    "https://example.com/page",
    allowChecker,
  );
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, "https://example.com/page");
});

// ─── createSsrfCheckedFetch ──────────────────────────────────────────────────

Deno.test("createSsrfCheckedFetch: throws when the SSRF check blocks the URL", async () => {
  const checkedFetch = createSsrfCheckedFetch(blockChecker);
  await assertRejects(
    () => checkedFetch("https://internal.example.com/api"),
    Error,
    "Outbound fetch blocked",
  );
});

Deno.test("createSsrfCheckedFetch: rejects Request-object inputs", async () => {
  const checkedFetch = createSsrfCheckedFetch(allowChecker);
  await assertRejects(
    () => checkedFetch(new Request("https://example.com/")),
    Error,
    "requires a URL input",
  );
});

Deno.test("createSsrfCheckedFetch: returns the response when the check passes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response("ok body", { status: 200 }),
    )) as unknown as typeof fetch;
  try {
    const checkedFetch = createSsrfCheckedFetch(allowChecker);
    const response = await checkedFetch("https://example.com/api");
    assertEquals(response.status, 200);
    assertEquals(await response.text(), "ok body");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
