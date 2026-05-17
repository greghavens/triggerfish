/**
 * Tests for OpenRouter model-metadata discovery.
 */

import { assertEquals } from "@std/assert";
import {
  discoverOpenRouterModelLimits,
  resetOpenRouterDiscoveryCache,
} from "./openrouter_discovery.ts";

/** Replace globalThis.fetch with a stub that returns the given response. */
function withFetchStub(
  responder: (url: string) => Response,
  fn: () => Promise<void>,
): Promise<void> {
  return (async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      return Promise.resolve(responder(url));
    };
    try {
      await fn();
    } finally {
      globalThis.fetch = original;
    }
  })();
}

Deno.test("openrouter discovery - parses top_provider.context_length and max_completion_tokens", async () => {
  resetOpenRouterDiscoveryCache();
  await withFetchStub(
    () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "anthropic/claude-3.5-sonnet",
              context_length: 200_000,
              top_provider: {
                context_length: 200_000,
                max_completion_tokens: 8192,
              },
            },
          ],
        }),
        { status: 200 },
      ),
    async () => {
      const limits = await discoverOpenRouterModelLimits(
        "sk-test",
        "anthropic/claude-3.5-sonnet",
      );
      assertEquals(limits?.contextLength, 200_000);
      assertEquals(limits?.maxCompletionTokens, 8192);
    },
  );
});

Deno.test("openrouter discovery - falls back to top-level context_length when top_provider absent", async () => {
  resetOpenRouterDiscoveryCache();
  await withFetchStub(
    () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "foo/bar", context_length: 64_000 },
          ],
        }),
        { status: 200 },
      ),
    async () => {
      const limits = await discoverOpenRouterModelLimits("sk-test", "foo/bar");
      assertEquals(limits?.contextLength, 64_000);
      assertEquals(limits?.maxCompletionTokens, undefined);
    },
  );
});

Deno.test("openrouter discovery - returns null for unlisted model", async () => {
  resetOpenRouterDiscoveryCache();
  await withFetchStub(
    () =>
      new Response(
        JSON.stringify({
          data: [{ id: "real/model", context_length: 32_000 }],
        }),
        { status: 200 },
      ),
    async () => {
      const limits = await discoverOpenRouterModelLimits(
        "sk-test",
        "fake/model",
      );
      assertEquals(limits, null);
    },
  );
});

Deno.test("openrouter discovery - returns null and caches empty on HTTP error", async () => {
  resetOpenRouterDiscoveryCache();
  let fetchCalls = 0;
  await withFetchStub(
    () => {
      fetchCalls++;
      return new Response("Internal Server Error", { status: 500 });
    },
    async () => {
      const limits1 = await discoverOpenRouterModelLimits("sk-test", "x/y");
      const limits2 = await discoverOpenRouterModelLimits("sk-test", "a/b");
      assertEquals(limits1, null);
      assertEquals(limits2, null);
      assertEquals(fetchCalls, 1);
    },
  );
});

Deno.test("openrouter discovery - caches list across multiple lookups", async () => {
  resetOpenRouterDiscoveryCache();
  let fetchCalls = 0;
  await withFetchStub(
    () => {
      fetchCalls++;
      return new Response(
        JSON.stringify({
          data: [
            { id: "model-a", context_length: 10_000 },
            { id: "model-b", context_length: 20_000 },
          ],
        }),
        { status: 200 },
      );
    },
    async () => {
      const a = await discoverOpenRouterModelLimits("sk-test", "model-a");
      const b = await discoverOpenRouterModelLimits("sk-test", "model-b");
      assertEquals(a?.contextLength, 10_000);
      assertEquals(b?.contextLength, 20_000);
      assertEquals(fetchCalls, 1);
    },
  );
});

Deno.test("openrouter discovery - retries fetch after network error", async () => {
  resetOpenRouterDiscoveryCache();
  let attempt = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    attempt++;
    if (attempt === 1) return Promise.reject(new TypeError("network"));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: [{ id: "ok/model", context_length: 50_000 }],
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;
  try {
    const first = await discoverOpenRouterModelLimits("sk-test", "ok/model");
    assertEquals(first, null);
    const second = await discoverOpenRouterModelLimits("sk-test", "ok/model");
    assertEquals(second?.contextLength, 50_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
