/**
 * Tests for Fireworks AI model-metadata discovery.
 */

import { assertEquals } from "@std/assert";
import {
  discoverFireworksModelLimits,
  resetFireworksDiscoveryCache,
} from "./fireworks_discovery.ts";

async function withFetchStub(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    return await responder(url, init);
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("fireworks discovery - parses native v1 response context_length", async () => {
  resetFireworksDiscoveryCache();
  await withFetchStub(
    () =>
      new Response(
        JSON.stringify({ context_length: 131_072 }),
        { status: 200 },
      ),
    async () => {
      const limits = await discoverFireworksModelLimits(
        "fw-test",
        "accounts/fireworks/models/llama-v3p1-70b-instruct",
      );
      assertEquals(limits?.contextLength, 131_072);
    },
  );
});

Deno.test("fireworks discovery - accepts camelCase contextLength", async () => {
  resetFireworksDiscoveryCache();
  await withFetchStub(
    () => new Response(JSON.stringify({ contextLength: 65_536 }), { status: 200 }),
    async () => {
      const limits = await discoverFireworksModelLimits(
        "fw-test",
        "accounts/fireworks/models/kimi-k2",
      );
      assertEquals(limits?.contextLength, 65_536);
    },
  );
});

Deno.test("fireworks discovery - hits native /v1/ endpoint not /inference/v1/", async () => {
  resetFireworksDiscoveryCache();
  let lastUrl = "";
  await withFetchStub(
    (url) => {
      lastUrl = url;
      return new Response(JSON.stringify({ context_length: 32_000 }), {
        status: 200,
      });
    },
    async () => {
      await discoverFireworksModelLimits(
        "fw-test",
        "accounts/fireworks/models/test",
      );
      assertEquals(
        lastUrl.startsWith("https://api.fireworks.ai/v1/accounts/"),
        true,
      );
      assertEquals(lastUrl.includes("/inference/"), false);
    },
  );
});

Deno.test("fireworks discovery - returns null on 404", async () => {
  resetFireworksDiscoveryCache();
  await withFetchStub(
    () => new Response("Not Found", { status: 404 }),
    async () => {
      const limits = await discoverFireworksModelLimits(
        "fw-test",
        "missing/model",
      );
      assertEquals(limits, null);
    },
  );
});

Deno.test("fireworks discovery - returns null on network error", async () => {
  resetFireworksDiscoveryCache();
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.reject(new TypeError("network"))) as typeof fetch;
  try {
    const limits = await discoverFireworksModelLimits("fw-test", "any/model");
    assertEquals(limits, null);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("fireworks discovery - caches per-model", async () => {
  resetFireworksDiscoveryCache();
  let calls = 0;
  await withFetchStub(
    () => {
      calls++;
      return new Response(JSON.stringify({ context_length: 16_000 }), {
        status: 200,
      });
    },
    async () => {
      await discoverFireworksModelLimits("fw-test", "m/a");
      await discoverFireworksModelLimits("fw-test", "m/a");
      assertEquals(calls, 1);
    },
  );
});
