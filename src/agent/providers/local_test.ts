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
  globalThis.fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes(endpoint)) {
      captured = JSON.parse(init?.body as string ?? "{}");
      return Promise.resolve(new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
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

Deno.test("local provider - reasoning model no tools: reasoning_effort=high, temperature=1.0", async () => {
  const { createLocalProvider } = await import("./local.ts");
  const provider = createLocalProvider({
    model: "deepseek-r1",
    endpoint: "http://localhost:11434",
  });

  const body = await captureRequestBody("localhost:11434", async () => {
    await provider.complete(MESSAGES, [], {});
  });

  assertEquals(body.reasoning_effort, "high");
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

Deno.test("local provider - tool-call-only assistant message: content null at API boundary", async () => {
  // loop_iteration.ts stores tool-call-only assistant turns with content=" "
  // in memory. At the API boundary we emit canonical content:null so the
  // model isn't taught to echo placeholder whitespace.
  const { createLocalProvider } = await import("./local.ts");
  const provider = createLocalProvider({
    model: "llama3.3",
    endpoint: "http://localhost:11434",
  });

  const messagesWithToolCallOnly = [
    { role: "user", content: "do work" },
    {
      role: "assistant",
      content: " ",
      tool_calls: [
        { id: "c1", function: { name: "read_file", arguments: "{}" } },
      ],
    } as Record<string, unknown>,
    { role: "tool", content: "ok", tool_call_id: "c1" } as Record<
      string,
      unknown
    >,
  ];

  const body = await captureRequestBody("localhost:11434", async () => {
    await provider.complete(
      messagesWithToolCallOnly as Parameters<typeof provider.complete>[0],
      [TOOL],
      {},
    );
  });

  const msgs = body.messages as Record<string, unknown>[];
  const assistant = msgs.find((m) => m.role === "assistant");
  assertEquals(assistant?.content, null);
  assertEquals(Array.isArray(assistant?.tool_calls), true);
});

Deno.test("local provider - assistant with text + tool_calls: content preserved", async () => {
  const { createLocalProvider } = await import("./local.ts");
  const provider = createLocalProvider({
    model: "llama3.3",
    endpoint: "http://localhost:11434",
  });

  const messages = [
    { role: "user", content: "do work" },
    {
      role: "assistant",
      content: "Let me check the file.",
      tool_calls: [
        { id: "c1", function: { name: "read_file", arguments: "{}" } },
      ],
    } as Record<string, unknown>,
    { role: "tool", content: "ok", tool_call_id: "c1" } as Record<
      string,
      unknown
    >,
  ];

  const body = await captureRequestBody("localhost:11434", async () => {
    await provider.complete(
      messages as Parameters<typeof provider.complete>[0],
      [TOOL],
      {},
    );
  });

  const msgs = body.messages as Record<string, unknown>[];
  const assistant = msgs.find((m) => m.role === "assistant");
  assertEquals(assistant?.content, "Let me check the file.");
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
