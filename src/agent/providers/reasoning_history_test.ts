/**
 * Tests for turn-scoped reasoning replay.
 *
 * The load-bearing rule: reasoning produced during the current turn is
 * replayed to the provider (DeepSeek returns a 400 without it, GLM-4.7 loops
 * without it), and reasoning from earlier turns is dropped. These tests fail
 * if either half regresses.
 *
 * @module
 */

import { assertEquals } from "@std/assert";
import type { HistoryEntry } from "../../core/types/orchestrator.ts";
import {
  expirePreviousTurnReasoning,
  withReasoningContent,
} from "./reasoning_history.ts";
import { buildChatRequestBody } from "./triggerfish_request.ts";

Deno.test("withReasoningContent - emits reasoning_content when reasoning exists", () => {
  const out = withReasoningContent({ role: "assistant", content: "hi" }, "why");
  assertEquals(out.reasoning_content, "why");
  assertEquals(out.role, "assistant");
});

Deno.test("withReasoningContent - leaves the message untouched without reasoning", () => {
  const msg = { role: "user", content: "hi" };
  assertEquals(withReasoningContent(msg, undefined), msg);
  assertEquals(withReasoningContent(msg, ""), msg);
});

Deno.test("expirePreviousTurnReasoning - drops reasoning, preserves everything else", () => {
  const history: HistoryEntry[] = [
    { role: "user", content: "first" },
    {
      role: "assistant",
      content: " ",
      tool_calls: [{ id: "call_1" }],
      reasoning: "prior turn thinking",
    },
    { role: "tool", content: "result", tool_call_id: "call_1" },
  ];

  expirePreviousTurnReasoning(history);

  assertEquals(history[1].reasoning, undefined);
  assertEquals(history[1].tool_calls, [{ id: "call_1" }]);
  assertEquals(history[1].content, " ");
  assertEquals(history[2].tool_call_id, "call_1");
});

Deno.test("expirePreviousTurnReasoning - clears signed provider blocks too", () => {
  const history: HistoryEntry[] = [
    {
      role: "assistant",
      content: " ",
      tool_calls: [{ id: "call_1" }],
      reasoning: "display text",
      reasoningBlocks: [{ type: "thinking", thinking: "x", signature: "sig" }],
    },
  ];

  expirePreviousTurnReasoning(history);

  assertEquals(history[0].reasoning, undefined);
  assertEquals(history[0].reasoningBlocks, undefined);
  assertEquals(history[0].tool_calls, [{ id: "call_1" }]);
});

Deno.test("reasoning replay - current-turn reasoning reaches the wire", () => {
  const body = buildChatRequestBody({
    maxTokens: 100,
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: " ",
        tool_calls: [{ id: "call_1" }],
        reasoning: "I should call the tool",
      },
      { role: "tool", content: "done", tool_call_id: "call_1" },
    ] as never,
    tools: [{ name: "t" }],
    streaming: false,
  });

  const messages = body.messages as Record<string, unknown>[];
  assertEquals(messages[1].reasoning_content, "I should call the tool");
  // Non-assistant messages never carry reasoning.
  assertEquals(messages[0].reasoning_content, undefined);
  assertEquals(messages[2].reasoning_content, undefined);
});

Deno.test("reasoning replay - expired reasoning never reaches the wire", () => {
  const history: HistoryEntry[] = [
    {
      role: "assistant",
      content: " ",
      tool_calls: [{ id: "call_1" }],
      reasoning: "last turn's thinking",
    },
  ];
  expirePreviousTurnReasoning(history);

  const body = buildChatRequestBody({
    maxTokens: 100,
    messages: history as never,
    tools: [{ name: "t" }],
    streaming: false,
  });

  const messages = body.messages as Record<string, unknown>[];
  assertEquals(messages[0].reasoning_content, undefined);
});
