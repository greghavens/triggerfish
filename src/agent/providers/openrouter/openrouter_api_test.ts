/**
 * Tests for OpenRouter API reasoning control.
 *
 * Verifies that reasoning: {effort: "none"} and temperature are correctly gated
 * on model capability and tool presence.
 */

import { assertEquals } from "@std/assert";
import { prepareOpenRouterPayload } from "./openrouter_api.ts";

const TOOL = {
  type: "function",
  function: { name: "read_file", description: "Read a file", parameters: {} },
};

const MESSAGES = [{ role: "user" as const, content: "hello" }];

Deno.test("openrouter - reasoning model with tools: reasoning effort none", () => {
  const { body } = prepareOpenRouterPayload({
    model: "deepseek/deepseek-r1",
    maxTokens: 4096,
    messages: MESSAGES,
    tools: [TOOL],
  });

  const payload = JSON.parse(body) as Record<string, unknown>;
  assertEquals(
    (payload.reasoning as Record<string, unknown>)?.effort,
    "none",
  );
  assertEquals(payload.temperature, 0.6);
  assertEquals(payload.tools !== undefined, true);
});

Deno.test("openrouter - reasoning model no tools: no reasoning field, temperature 1.0", () => {
  const { body } = prepareOpenRouterPayload({
    model: "moonshotai/kimi-k2",
    maxTokens: 4096,
    messages: MESSAGES,
    tools: [],
  });

  const payload = JSON.parse(body) as Record<string, unknown>;
  assertEquals(payload.reasoning, undefined);
  assertEquals(payload.temperature, 1.0);
  assertEquals(payload.tools, undefined);
});

Deno.test("openrouter - non-reasoning model with tools: no reasoning params", () => {
  const { body } = prepareOpenRouterPayload({
    model: "openai/gpt-4o",
    maxTokens: 4096,
    messages: MESSAGES,
    tools: [TOOL],
  });

  const payload = JSON.parse(body) as Record<string, unknown>;
  assertEquals(payload.reasoning, undefined);
  assertEquals(payload.temperature, undefined);
  assertEquals(payload.tools !== undefined, true);
});

Deno.test("openrouter - non-reasoning model no tools: no reasoning params", () => {
  const { body } = prepareOpenRouterPayload({
    model: "anthropic/claude-sonnet-4-6",
    maxTokens: 4096,
    messages: MESSAGES,
    tools: [],
  });

  const payload = JSON.parse(body) as Record<string, unknown>;
  assertEquals(payload.reasoning, undefined);
  assertEquals(payload.temperature, undefined);
});

Deno.test("openrouter - qwq reasoning model with tools: reasoning disabled", () => {
  const { body } = prepareOpenRouterPayload({
    model: "qwen/qwq-32b",
    maxTokens: 4096,
    messages: MESSAGES,
    tools: [TOOL],
  });

  const payload = JSON.parse(body) as Record<string, unknown>;
  assertEquals(
    (payload.reasoning as Record<string, unknown>)?.effort,
    "none",
  );
  assertEquals(payload.temperature, 0.6);
});

Deno.test("openrouter - strips reasoning_content from message history", () => {
  const messagesWithReasoning = [
    { role: "user" as const, content: "hello" },
    {
      role: "assistant" as const,
      content: "world",
      reasoning_content: "secret thoughts",
    } as Parameters<typeof prepareOpenRouterPayload>[0]["messages"][0],
  ];

  const { body } = prepareOpenRouterPayload({
    model: "deepseek/deepseek-r1",
    maxTokens: 4096,
    messages: messagesWithReasoning,
    tools: [],
  });

  const payload = JSON.parse(body) as Record<string, unknown>;
  const msgs = payload.messages as Record<string, unknown>[];
  const assistant = msgs.find((m) => m.role === "assistant");
  assertEquals(assistant?.reasoning_content, undefined);
  assertEquals(assistant?.content, "world");
});
