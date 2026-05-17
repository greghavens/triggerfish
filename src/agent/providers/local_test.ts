/**
 * Tests for local provider reasoning control.
 *
 * Verifies that reasoning_effort and temperature are correctly gated on model
 * capability and tool presence, matching Ollama's /v1/chat/completions API.
 */

import { assertEquals, assertNotEquals } from "@std/assert";

// Test the request body builder by extracting it via a mock fetch.
// We capture the outgoing request body to verify reasoning parameters.

const TOOL = {
  type: "function",
  function: { name: "read_file", description: "Read a file", parameters: {} },
};

const MESSAGES = [{ role: "user", content: "hello" }];

/** Intercept fetch and return a captured request body. */
async function captureRequestBody(
  endpoint: string,
  fn: () => Promise<void>,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {};
  const original = globalThis.fetch;
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes(endpoint)) {
      captured = JSON.parse(init?.body as string ?? "{}");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return original(input, init);
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return captured;
}

Deno.test("local provider - joint-mode reasoning model with tools: keeps reasoning enabled", async () => {
  // deepseek-r1, gpt-oss, nemotron-3, etc. emit reasoning and tool calls in the
  // same response. Joint mode keeps reasoning_effort high and uses the
  // reasoning-mode temperature so the model thinks before selecting tools.
  const { createLocalProvider } = await import("./local.ts");
  const provider = createLocalProvider({
    model: "deepseek-r1",
    endpoint: "http://localhost:11434",
  });

  const body = await captureRequestBody("localhost:11434", async () => {
    await provider.complete(MESSAGES, [TOOL], {});
  });

  assertEquals(body.reasoning_effort, "high");
  assertEquals(body.temperature, 1.0);
});

Deno.test("local provider - gpt-oss joint mode with tools: reasoning_effort=high", async () => {
  const { createLocalProvider } = await import("./local.ts");
  const provider = createLocalProvider({
    model: "openai/gpt-oss-120b",
    endpoint: "http://localhost:1234",
  });

  const body = await captureRequestBody("localhost:1234", async () => {
    await provider.complete(MESSAGES, [TOOL], {});
  });

  assertEquals(body.reasoning_effort, "high");
  assertEquals(body.temperature, 1.0);
});

Deno.test("local provider - nemotron-3 joint mode with tools: reasoning_effort=high", async () => {
  const { createLocalProvider } = await import("./local.ts");
  const provider = createLocalProvider({
    model: "nvidia/nemotron-3-super",
    endpoint: "http://localhost:1234",
  });

  const body = await captureRequestBody("localhost:1234", async () => {
    await provider.complete(MESSAGES, [TOOL], {});
  });

  assertEquals(body.reasoning_effort, "high");
  assertEquals(body.temperature, 1.0);
});

Deno.test("local provider - reasoning model no tools: no reasoning_effort, temperature=1.0", async () => {
  const { createLocalProvider } = await import("./local.ts");
  const provider = createLocalProvider({
    model: "deepseek-r1",
    endpoint: "http://localhost:11434",
  });

  const body = await captureRequestBody("localhost:11434", async () => {
    await provider.complete(MESSAGES, [], {});
  });

  assertEquals(body.reasoning_effort, undefined);
  assertEquals(body.temperature, 1.0);
});

Deno.test("local provider - non-reasoning model with tools: no reasoning params", async () => {
  const { createLocalProvider } = await import("./local.ts");
  const provider = createLocalProvider({
    model: "llama3.3",
    endpoint: "http://localhost:11434",
  });

  const body = await captureRequestBody("localhost:11434", async () => {
    await provider.complete(MESSAGES, [TOOL], {});
  });

  assertEquals(body.reasoning_effort, undefined);
  assertEquals(body.temperature, undefined);
  assertEquals(body.tools !== undefined, true);
});

Deno.test("local provider - non-reasoning model no tools: no reasoning params", async () => {
  const { createLocalProvider } = await import("./local.ts");
  const provider = createLocalProvider({
    model: "mistral",
    endpoint: "http://localhost:11434",
  });

  const body = await captureRequestBody("localhost:11434", async () => {
    await provider.complete(MESSAGES, [], {});
  });

  assertEquals(body.reasoning_effort, undefined);
  assertEquals(body.temperature, undefined);
});

Deno.test("local provider - reasoning model strips reasoning_content from history", async () => {
  const { createLocalProvider } = await import("./local.ts");
  const provider = createLocalProvider({
    model: "kimi-k2",
    endpoint: "http://localhost:11434",
  });

  const messagesWithReasoning = [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: "world",
      reasoning_content: "secret thoughts",
    } as Record<string, unknown>,
  ];

  const body = await captureRequestBody("localhost:11434", async () => {
    await provider.complete(
      messagesWithReasoning as Parameters<typeof provider.complete>[0],
      [],
      {},
    );
  });

  const msgs = body.messages as Record<string, unknown>[];
  const assistant = msgs.find((m) => m.role === "assistant");
  assertEquals(assistant?.reasoning_content, undefined);
  assertNotEquals(assistant?.content, undefined);
});
