/**
 * Tests for Z.AI provider reasoning control.
 *
 * Verifies that thinking toggle and temperature are correctly gated on model
 * capability (GLM Z1 thinking models) and tool presence.
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
    _input: string | URL | Request,
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

Deno.test("zai - GLM Z1 with tools: joint mode keeps thinking enabled", async () => {
  // GLM Z1 (and 4.7 / 4.6) thinking variants emit reasoning and tool calls
  // in the same response. Joint mode keeps thinking enabled and uses the
  // reasoning-mode temperature.
  const { createZaiProvider } = await import("./zai.ts");
  const provider = createZaiProvider({ model: "glm-z1-flash", apiKey: "test-key" });

  const body = await captureRequestBody(async () => {
    await provider.complete(MESSAGES, [TOOL], {});
  });

  assertEquals((body.thinking as Record<string, unknown>)?.type, "enabled");
  assertEquals(body.temperature, 1.0);
  assertEquals(body.tools !== undefined, true);
});

Deno.test("zai - GLM 4.7 with tools: joint mode keeps thinking enabled", async () => {
  const { createZaiProvider } = await import("./zai.ts");
  const provider = createZaiProvider({ model: "glm-4.7", apiKey: "test-key" });

  const body = await captureRequestBody(async () => {
    await provider.complete(MESSAGES, [TOOL], {});
  });

  assertEquals((body.thinking as Record<string, unknown>)?.type, "enabled");
  assertEquals(body.temperature, 1.0);
});

Deno.test("zai - GLM Z1 no tools: thinking enabled", async () => {
  const { createZaiProvider } = await import("./zai.ts");
  const provider = createZaiProvider({ model: "glm-z1-air", apiKey: "test-key" });

  const body = await captureRequestBody(async () => {
    await provider.complete(MESSAGES, [], {});
  });

  assertEquals((body.thinking as Record<string, unknown>)?.type, "enabled");
  assertEquals(body.temperature, 1.0);
});

Deno.test("zai - non-thinking GLM model with tools: no thinking params", async () => {
  const { createZaiProvider } = await import("./zai.ts");
  const provider = createZaiProvider({ model: "glm-4.5", apiKey: "test-key" });

  const body = await captureRequestBody(async () => {
    await provider.complete(MESSAGES, [TOOL], {});
  });

  assertEquals(body.thinking, undefined);
  assertEquals(body.temperature, undefined);
  assertEquals(body.tools !== undefined, true);
});

Deno.test("zai - non-thinking GLM model no tools: no thinking params", async () => {
  const { createZaiProvider } = await import("./zai.ts");
  const provider = createZaiProvider({ model: "glm-5", apiKey: "test-key" });

  const body = await captureRequestBody(async () => {
    await provider.complete(MESSAGES, [], {});
  });

  assertEquals(body.thinking, undefined);
  assertEquals(body.temperature, undefined);
});
