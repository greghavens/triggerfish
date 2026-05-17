/**
 * Tests for ZenMux provider reasoning control.
 *
 * Verifies that thinking/reasoning_history toggle and temperature are correctly
 * gated on model capability and tool presence.
 */

import { assertEquals } from "@std/assert";

const TOOL = {
  type: "function",
  function: { name: "read_file", description: "Read a file", parameters: {} },
};

const MESSAGES = [{ role: "user", content: "hello" }];

async function captureRequestBody(
  fn: () => Promise<void>,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {};
  const original = globalThis.fetch;
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    captured = JSON.parse(init?.body as string ?? "{}");
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return captured;
}

Deno.test("zenmux - joint-mode reasoning model with tools: thinking enabled", async () => {
  // Kimi K2, GLM Z1, deepseek-r1, qwq, gpt-oss etc. emit reasoning AND tool
  // calls in the same response. Joint mode keeps thinking enabled with
  // interleaved history so the model can reason before selecting tools.
  const { createZenMuxProvider } = await import("./zenmux.ts");
  const provider = createZenMuxProvider({
    model: "moonshotai/kimi-k2",
    apiKey: "test-key",
  });

  const body = await captureRequestBody(async () => {
    await provider.complete(MESSAGES, [TOOL], {});
  });

  assertEquals((body.thinking as Record<string, unknown>)?.type, "enabled");
  assertEquals(body.reasoning_history, "interleaved");
  assertEquals(body.temperature, 1.0);
});

Deno.test("zenmux - reasoning model no tools: thinking enabled", async () => {
  const { createZenMuxProvider } = await import("./zenmux.ts");
  const provider = createZenMuxProvider({
    model: "moonshotai/kimi-k2",
    apiKey: "test-key",
  });

  const body = await captureRequestBody(async () => {
    await provider.complete(MESSAGES, [], {});
  });

  assertEquals((body.thinking as Record<string, unknown>)?.type, "enabled");
  assertEquals(body.reasoning_history, "interleaved");
  assertEquals(body.temperature, 1.0);
});

Deno.test("zenmux - non-reasoning model with tools: no thinking params", async () => {
  const { createZenMuxProvider } = await import("./zenmux.ts");
  const provider = createZenMuxProvider({
    model: "openai/gpt-4o",
    apiKey: "test-key",
  });

  const body = await captureRequestBody(async () => {
    await provider.complete(MESSAGES, [TOOL], {});
  });

  assertEquals(body.thinking, undefined);
  assertEquals(body.reasoning_history, undefined);
  assertEquals(body.temperature, undefined);
  assertEquals(body.tools !== undefined, true);
});

Deno.test("zenmux - non-reasoning model no tools: no thinking params", async () => {
  const { createZenMuxProvider } = await import("./zenmux.ts");
  const provider = createZenMuxProvider({
    model: "openai/gpt-4o",
    apiKey: "test-key",
  });

  const body = await captureRequestBody(async () => {
    await provider.complete(MESSAGES, [], {});
  });

  assertEquals(body.thinking, undefined);
  assertEquals(body.temperature, undefined);
});

Deno.test("zenmux - deepseek-r1 joint-mode with tools: thinking enabled", async () => {
  const { createZenMuxProvider } = await import("./zenmux.ts");
  const provider = createZenMuxProvider({
    model: "deepseek/deepseek-r1",
    apiKey: "test-key",
  });

  const body = await captureRequestBody(async () => {
    await provider.complete(MESSAGES, [TOOL], {});
  });

  assertEquals((body.thinking as Record<string, unknown>)?.type, "enabled");
  assertEquals(body.reasoning_history, "interleaved");
  assertEquals(body.temperature, 1.0);
});
