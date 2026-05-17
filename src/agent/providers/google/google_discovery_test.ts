/**
 * Tests for Google Gemini model-metadata discovery.
 */

import { assertEquals } from "@std/assert";
import {
  discoverGoogleModelLimits,
  resetGoogleDiscoveryCache,
} from "./google_discovery.ts";

async function withFetchStub(
  responder: (url: string) => Response | Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    return await responder(url);
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("google discovery - parses inputTokenLimit and outputTokenLimit", async () => {
  resetGoogleDiscoveryCache();
  await withFetchStub(
    () =>
      new Response(
        JSON.stringify({
          inputTokenLimit: 1_048_576,
          outputTokenLimit: 65_536,
        }),
        { status: 200 },
      ),
    async () => {
      const limits = await discoverGoogleModelLimits(
        "test-key",
        "gemini-2.5-pro",
      );
      assertEquals(limits?.inputTokenLimit, 1_048_576);
      assertEquals(limits?.outputTokenLimit, 65_536);
    },
  );
});

Deno.test("google discovery - omits outputTokenLimit when absent", async () => {
  resetGoogleDiscoveryCache();
  await withFetchStub(
    () =>
      new Response(JSON.stringify({ inputTokenLimit: 32_000 }), { status: 200 }),
    async () => {
      const limits = await discoverGoogleModelLimits(
        "test-key",
        "gemini-test",
      );
      assertEquals(limits?.inputTokenLimit, 32_000);
      assertEquals(limits?.outputTokenLimit, undefined);
    },
  );
});

Deno.test("google discovery - prepends models/ prefix when missing", async () => {
  resetGoogleDiscoveryCache();
  let calledUrl = "";
  await withFetchStub(
    (url) => {
      calledUrl = url;
      return new Response(JSON.stringify({ inputTokenLimit: 10_000 }), {
        status: 200,
      });
    },
    async () => {
      await discoverGoogleModelLimits("test-key", "gemini-2.5-pro");
      assertEquals(calledUrl.includes("/v1beta/models/gemini-2.5-pro"), true);
    },
  );
});

Deno.test("google discovery - keeps existing models/ prefix", async () => {
  resetGoogleDiscoveryCache();
  let calledUrl = "";
  await withFetchStub(
    (url) => {
      calledUrl = url;
      return new Response(JSON.stringify({ inputTokenLimit: 10_000 }), {
        status: 200,
      });
    },
    async () => {
      await discoverGoogleModelLimits("test-key", "models/gemini-1.5-pro");
      assertEquals(
        calledUrl.includes("/v1beta/models/gemini-1.5-pro"),
        true,
      );
      assertEquals(
        calledUrl.includes("/v1beta/models/models/"),
        false,
      );
    },
  );
});

Deno.test("google discovery - returns null on 404", async () => {
  resetGoogleDiscoveryCache();
  await withFetchStub(
    () => new Response("Not Found", { status: 404 }),
    async () => {
      const limits = await discoverGoogleModelLimits("test-key", "missing");
      assertEquals(limits, null);
    },
  );
});

Deno.test("google discovery - returns null on network error", async () => {
  resetGoogleDiscoveryCache();
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.reject(new TypeError("network"))) as typeof fetch;
  try {
    const limits = await discoverGoogleModelLimits("test-key", "x");
    assertEquals(limits, null);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("google discovery - caches per model", async () => {
  resetGoogleDiscoveryCache();
  let calls = 0;
  await withFetchStub(
    () => {
      calls++;
      return new Response(JSON.stringify({ inputTokenLimit: 1_000_000 }), {
        status: 200,
      });
    },
    async () => {
      await discoverGoogleModelLimits("test-key", "gemini-x");
      await discoverGoogleModelLimits("test-key", "gemini-x");
      assertEquals(calls, 1);
    },
  );
});
