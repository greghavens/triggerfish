/**
 * Tests for local LLM server context-length discovery.
 */

import { assertEquals } from "@std/assert";
import {
  discoverLocalModelLimits,
  resetLocalDiscoveryCache,
} from "./local_discovery.ts";

/** Replace globalThis.fetch with a stub. */
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

Deno.test("local discovery - lmstudio reports loaded_context_length", async () => {
  resetLocalDiscoveryCache();
  await withFetchStub(
    (url) => {
      if (url.includes("/api/v0/models/")) {
        return new Response(
          JSON.stringify({
            max_context_length: 131_072,
            loaded_context_length: 65_536,
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    },
    async () => {
      const limits = await discoverLocalModelLimits(
        "http://localhost:1234",
        "qwen3-coder",
      );
      assertEquals(limits?.contextLength, 65_536);
    },
  );
});

Deno.test("local discovery - lmstudio falls back to max_context_length when loaded missing", async () => {
  resetLocalDiscoveryCache();
  await withFetchStub(
    (url) => {
      if (url.includes("/api/v0/models/")) {
        return new Response(
          JSON.stringify({ max_context_length: 32_768 }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    },
    async () => {
      const limits = await discoverLocalModelLimits(
        "http://localhost:1234",
        "model-x",
      );
      assertEquals(limits?.contextLength, 32_768);
    },
  );
});

Deno.test("local discovery - falls back to ollama /api/show when lmstudio 404s", async () => {
  resetLocalDiscoveryCache();
  await withFetchStub(
    (url) => {
      if (url.includes("/api/v0/models/")) {
        return new Response("not found", { status: 404 });
      }
      if (url.endsWith("/api/show")) {
        return new Response(
          JSON.stringify({
            model_info: {
              "general.architecture": "llama",
              "llama.context_length": 128_000,
            },
          }),
          { status: 200 },
        );
      }
      return new Response("unexpected", { status: 500 });
    },
    async () => {
      const limits = await discoverLocalModelLimits(
        "http://localhost:11434",
        "llama3.3",
      );
      assertEquals(limits?.contextLength, 128_000);
    },
  );
});

Deno.test("local discovery - ollama extracts context_length under any architecture prefix", async () => {
  resetLocalDiscoveryCache();
  await withFetchStub(
    (url) => {
      if (url.includes("/api/v0/models/")) {
        return new Response("not found", { status: 404 });
      }
      if (url.endsWith("/api/show")) {
        return new Response(
          JSON.stringify({
            model_info: {
              "general.architecture": "qwen2",
              "qwen2.context_length": 262_144,
            },
          }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 500 });
    },
    async () => {
      const limits = await discoverLocalModelLimits(
        "http://localhost:11434",
        "qwen2.5",
      );
      assertEquals(limits?.contextLength, 262_144);
    },
  );
});

Deno.test("local discovery - returns null when neither server responds", async () => {
  resetLocalDiscoveryCache();
  await withFetchStub(
    () => new Response("nope", { status: 500 }),
    async () => {
      const limits = await discoverLocalModelLimits(
        "http://localhost:9999",
        "unknown",
      );
      assertEquals(limits, null);
    },
  );
});

Deno.test("local discovery - returns null on network error and does not throw", async () => {
  resetLocalDiscoveryCache();
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.reject(new TypeError("connection refused"))) as typeof fetch;
  try {
    const limits = await discoverLocalModelLimits(
      "http://localhost:9999",
      "anything",
    );
    assertEquals(limits, null);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("local discovery - caches result per (endpoint, model) tuple", async () => {
  resetLocalDiscoveryCache();
  let lmCalls = 0;
  await withFetchStub(
    (url) => {
      if (url.includes("/api/v0/models/")) {
        lmCalls++;
        return new Response(
          JSON.stringify({ loaded_context_length: 8_192 }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    },
    async () => {
      const a = await discoverLocalModelLimits(
        "http://localhost:1234",
        "model-a",
      );
      const b = await discoverLocalModelLimits(
        "http://localhost:1234",
        "model-a",
      );
      assertEquals(a?.contextLength, 8_192);
      assertEquals(b?.contextLength, 8_192);
      assertEquals(lmCalls, 1);
    },
  );
});
