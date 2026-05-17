/**
 * Tests for conversation compactor.
 *
 * Covers token counting (cl100k_base), budget-aware auto-compaction,
 * LLM-based summarization to a single message, budget updates, and
 * edge cases.
 *
 * @module
 */

import { assertEquals, assertGreater, assertLessOrEqual } from "@std/assert";
import {
  countTokens,
  createCompactor,
  estimateHistoryTokens,
  estimateTokens,
} from "../../src/agent/compactor/compactor.ts";
import type { HistoryEntry } from "../../src/agent/orchestrator/orchestrator_types.ts";

// ─── Token counting ──────────────────────────────────────────

Deno.test("countTokens returns 0 for empty string", () => {
  assertEquals(countTokens(""), 0);
});

Deno.test("countTokens returns accurate count for English text", () => {
  // "hello world" is 2 tokens in cl100k_base
  assertEquals(countTokens("hello world"), 2);
});

Deno.test("countTokens returns reasonable count for longer text", () => {
  const text = "The quick brown fox jumps over the lazy dog";
  const tokens = countTokens(text);
  assertGreater(tokens, 5);
  assertLessOrEqual(tokens, 15);
});

Deno.test("estimateTokens is an alias for countTokens", () => {
  const text = "Hello, how are you doing today?";
  assertEquals(estimateTokens(text), countTokens(text));
});

Deno.test("estimateHistoryTokens sums all entries", () => {
  const history: HistoryEntry[] = [
    { role: "user", content: "Hello world" },
    { role: "assistant", content: "Hi there, how can I help?" },
  ];
  const total = estimateHistoryTokens(history);
  assertGreater(total, 0);
  assertEquals(
    total,
    countTokens("Hello world") + countTokens("Hi there, how can I help?"),
  );
});

Deno.test("estimateHistoryTokens returns 0 for empty history", () => {
  assertEquals(estimateHistoryTokens([]), 0);
});

// ─── Auto-compaction (budget-aware) ─────────────────────────────

Deno.test("compact returns history unchanged when under budget", () => {
  const history: HistoryEntry[] = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there!" },
    { role: "user", content: "How are you?" },
    { role: "assistant", content: "I'm doing well." },
  ];
  const compactor = createCompactor({ contextBudget: 100_000 });
  const result = compactor.compact(history);
  assertEquals(result, history);
});

Deno.test("compact produces single summary message when over budget", () => {
  const history: HistoryEntry[] = [];
  for (let i = 0; i < 20; i++) {
    history.push({ role: "user", content: `Message ${i}: ${"x".repeat(100)}` });
    history.push({
      role: "assistant",
      content: `Response ${i}: ${"y".repeat(100)}`,
    });
  }

  const compactor = createCompactor({ contextBudget: 200 });
  const result = compactor.compact(history);

  // Should be compacted to exactly 1 summary message
  assertEquals(result.length, 1);
  assertEquals(result[0].role, "user");
  assertEquals(
    (result[0].content as string).startsWith("[Conversation context:"),
    true,
  );
});

Deno.test("compact summary includes message count", () => {
  const history: HistoryEntry[] = [];
  for (let i = 0; i < 10; i++) {
    history.push({
      role: "user",
      content: `Question ${i}: ${"x".repeat(100)}`,
    });
    history.push({
      role: "assistant",
      content: `Answer ${i}: ${"y".repeat(100)}`,
    });
  }

  const compactor = createCompactor({ contextBudget: 200 });
  const result = compactor.compact(history);
  const summary = result[0].content as string;

  assertEquals(summary.includes("20 messages"), true);
});

Deno.test("compact summary captures last user message", () => {
  const history: HistoryEntry[] = [
    { role: "user", content: "First question" + "x".repeat(200) },
    { role: "assistant", content: "First answer" + "y".repeat(200) },
    { role: "user", content: "What about TypeScript generics?" },
    {
      role: "assistant",
      content: "Generics let you parameterize types..." + "z".repeat(200),
    },
  ];

  const compactor = createCompactor({ contextBudget: 50 });
  const result = compactor.compact(history);

  const summary = result[0].content as string;
  assertEquals(summary.includes("TypeScript generics"), true);
});

Deno.test("compact summary captures last assistant response", () => {
  const history: HistoryEntry[] = [
    { role: "user", content: "x".repeat(200) },
    {
      role: "assistant",
      content: "The deployment completed successfully" + "y".repeat(200),
    },
    { role: "user", content: "Great, what's next?" + "z".repeat(200) },
  ];

  const compactor = createCompactor({ contextBudget: 50 });
  const result = compactor.compact(history);

  const summary = result[0].content as string;
  assertEquals(summary.includes("deployment completed"), true);
});

Deno.test("compact handles empty history", () => {
  const compactor = createCompactor({ contextBudget: 100 });
  const result = compactor.compact([]);
  assertEquals(result, []);
});

Deno.test("compact preserves tiny history even if over budget", () => {
  // Only 2 messages — too few to summarize meaningfully
  const history: HistoryEntry[] = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi!" },
  ];
  const compactor = createCompactor({ contextBudget: 1 });
  const result = compactor.compact(history);
  assertEquals(result, history);
});

Deno.test("compact handles single giant message", () => {
  // One huge tool result that fills the context
  const history: HistoryEntry[] = [
    { role: "user", content: "Read the file" },
    { role: "assistant", content: "Here's the content..." },
    {
      role: "user",
      content: "[TOOL_RESULT]\n" + "x".repeat(50000) + "\n[/TOOL_RESULT]",
    },
    { role: "assistant", content: "The file contains..." },
    { role: "user", content: "Now summarize it" },
  ];

  const compactor = createCompactor({ contextBudget: 1000 });
  const result = compactor.compact(history);

  // Should compact to 1 message even with the giant entry
  assertEquals(result.length, 1);
  assertEquals((result[0].content as string).includes("5 messages"), true);
});

// ─── LLM summarization (/compact) ──────────────────────────────

Deno.test("summarize produces single summary message via LLM", async () => {
  const history: HistoryEntry[] = [
    { role: "user", content: "What is TypeScript?" },
    {
      role: "assistant",
      content: "TypeScript is a typed superset of JavaScript.",
    },
    { role: "user", content: "How do I use interfaces?" },
    { role: "assistant", content: "Define them with the interface keyword." },
    { role: "user", content: "What about generics?" },
    { role: "assistant", content: "Use angle brackets for type parameters." },
  ];

  const mockProvider = {
    name: "mock",
    supportsStreaming: false,
    // deno-lint-ignore require-await
    complete: async () => ({
      content:
        "The user asked about TypeScript fundamentals. You explained interfaces and generics. The user's last question was about generics.",
      toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 30 },
    }),
  };

  const compactor = createCompactor();
  const result = await compactor.summarize(history, mockProvider);

  // Should be exactly 1 summary message
  assertEquals(result.length, 1);
  assertEquals(result[0].role, "user");
  assertEquals(
    (result[0].content as string).startsWith("[Conversation summary"),
    true,
  );
  assertEquals(
    (result[0].content as string).includes("TypeScript fundamentals"),
    true,
  );
});

Deno.test("summarize preserves tiny history unchanged", async () => {
  const history: HistoryEntry[] = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi!" },
  ];

  const mockProvider = {
    name: "mock",
    supportsStreaming: false,
    // deno-lint-ignore require-await
    complete: async () => ({
      content: "Should not be called",
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  };

  const compactor = createCompactor();
  const result = await compactor.summarize(history, mockProvider);
  assertEquals(result, history);
});

Deno.test("summarize truncates giant messages in digest", async () => {
  const history: HistoryEntry[] = [
    { role: "user", content: "Read this file" },
    { role: "assistant", content: "x".repeat(100000) }, // 100k chars
    { role: "user", content: "Now explain it" },
  ];

  let receivedPrompt = "";
  const mockProvider = {
    name: "mock",
    supportsStreaming: false,
    // deno-lint-ignore require-await
    complete: async (
      msgs: readonly { role: string; content: string | unknown }[],
    ) => {
      receivedPrompt = msgs[1].content as string;
      return {
        content: "Summary of conversation.",
        toolCalls: [],
        usage: { inputTokens: 100, outputTokens: 10 },
      };
    },
  };

  const compactor = createCompactor({ contextBudget: 10000 });
  await compactor.summarize(history, mockProvider);

  // The digest sent to the LLM should contain "[truncated]" not the full 100k
  assertEquals(receivedPrompt.includes("truncated"), true);
  // And be much smaller than the original
  assertGreater(100000, receivedPrompt.length);
});

// ─── getTokenEstimate ────────────────────────────────────────────

Deno.test("compactor.getTokenEstimate matches standalone function", () => {
  const history: HistoryEntry[] = [
    { role: "user", content: "Hello world, this is a test message." },
  ];
  const compactor = createCompactor();
  assertEquals(
    compactor.getTokenEstimate(history),
    estimateHistoryTokens(history),
  );
});

// ─── updateBudget ────────────────────────────────────────────────

Deno.test("updateBudget changes the compaction threshold", () => {
  const compactor = createCompactor({ contextBudget: 1_000_000 });

  const history: HistoryEntry[] = [];
  for (let i = 0; i < 20; i++) {
    history.push({ role: "user", content: `Message ${i}: ${"x".repeat(100)}` });
    history.push({
      role: "assistant",
      content: `Response ${i}: ${"y".repeat(100)}`,
    });
  }

  // With a huge budget, no compaction
  assertEquals(compactor.compact(history).length, history.length);

  // Lower the budget — now it should compact to 1 message
  compactor.updateBudget(100);
  const compacted = compactor.compact(history);
  assertEquals(compacted.length, 1);
});

// ─── Overhead token accounting ──────────────────────────────────

Deno.test("compact fires when overhead + history exceeds threshold", () => {
  // History is well under 70% of the budget on its own, but when the
  // system-prompt overhead is included the total exceeds the threshold.
  const history: HistoryEntry[] = [];
  // ~10 tokens per pair × 3 pairs = ~30 history tokens
  for (let i = 0; i < 3; i++) {
    history.push({ role: "user", content: `Hi ${i}` });
    history.push({ role: "assistant", content: `Hello ${i}` });
  }

  // Budget of 100. Auto-trigger = 70.
  // History alone ≈ 30 tokens (well under 70).
  // Pass 60 as overhead — total ≈ 90 > 70, compaction must fire.
  const compactor = createCompactor({ contextBudget: 100 });
  const result = compactor.compact(history, 60);

  assertEquals(result.length, 1);
  assertEquals(
    (result[0].content as string).startsWith("[Conversation context:"),
    true,
  );
});

Deno.test("compact does NOT fire when overhead + history is under threshold", () => {
  const history: HistoryEntry[] = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi!" },
    { role: "user", content: "How are you?" },
    { role: "assistant", content: "I'm fine." },
  ];

  // Huge budget — even with 50-token overhead, total is well under 70% of 10 000
  const compactor = createCompactor({ contextBudget: 10_000 });
  const result = compactor.compact(history, 50);
  assertEquals(result, history);
});

Deno.test("compact with zero overhead behaves identically to no argument", () => {
  const history: HistoryEntry[] = [];
  for (let i = 0; i < 20; i++) {
    history.push({ role: "user", content: `Message ${i}: ${"x".repeat(100)}` });
    history.push({
      role: "assistant",
      content: `Response ${i}: ${"y".repeat(100)}`,
    });
  }

  const compactor = createCompactor({ contextBudget: 200 });
  const withZero = compactor.compact(history, 0);
  const withNoArg = compactor.compact(history);
  assertEquals(withZero.length, withNoArg.length);
  assertEquals(withZero[0].content, withNoArg[0].content);
});

// ─── Keyword extraction ──────────────────────────────────────────

Deno.test("compact summary includes topic keywords", () => {
  const history: HistoryEntry[] = [];
  const topics = ["authentication", "database", "routing", "deployment"];
  for (const topic of topics) {
    history.push({
      role: "user",
      content: `Tell me about ${topic} patterns ${"x".repeat(100)}`,
    });
    history.push({
      role: "assistant",
      content: `Here's info about ${topic}... ${"y".repeat(100)}`,
    });
  }

  const compactor = createCompactor({ contextBudget: 100 });
  const result = compactor.compact(history);
  const summary = result[0].content as string;

  // Should contain at least some topic keywords
  const hasKeywords = topics.some((t) => summary.includes(t));
  assertEquals(hasKeywords, true);
});

// ─── Tool-call preservation in compaction ────────────────────────

Deno.test("compact summary lists tools that were called", () => {
  const history: HistoryEntry[] = [
    { role: "user", content: `Build the feature ${"x".repeat(200)}` },
    {
      role: "assistant",
      content: " ",
      tool_calls: [
        { id: "c1", function: { name: "read_file", arguments: "{}" } },
        { id: "c2", function: { name: "write_file", arguments: "{}" } },
      ],
    },
    { role: "tool", content: "file contents", tool_call_id: "c1" },
    { role: "tool", content: "written", tool_call_id: "c2" },
    {
      role: "assistant",
      content: " ",
      tool_calls: [
        { id: "c3", function: { name: "run_command", arguments: "{}" } },
      ],
    },
    { role: "tool", content: "ok", tool_call_id: "c3" },
    {
      role: "assistant",
      content: `done ${"y".repeat(200)}`,
    },
  ];

  const compactor = createCompactor({ contextBudget: 100 });
  const result = compactor.compact(history);
  const summary = result[0].content as string;

  assertEquals(summary.includes("read_file"), true);
  assertEquals(summary.includes("write_file"), true);
  assertEquals(summary.includes("run_command"), true);
});

Deno.test("summarize digest surfaces tool call names to the summarizer", async () => {
  let capturedDigest = "";
  const fakeProvider = {
    name: "fake",
    supportsStreaming: false,
    contextWindow: 100_000,
    complete: (messages: readonly { role: string; content: string }[]) => {
      const userMsg = messages.find((m) => m.role === "user");
      capturedDigest = userMsg?.content ?? "";
      return Promise.resolve({
        content: "summary",
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      });
    },
    stream: async function* () {},
  };

  const history: HistoryEntry[] = [
    { role: "user", content: "search for triggerfish docs" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "c1", function: { name: "web_search", arguments: "{}" } },
      ],
    },
    { role: "tool", content: "results...", tool_call_id: "c1" },
    { role: "assistant", content: "Here is what I found." },
  ];

  const compactor = createCompactor({ contextBudget: 100_000 });
  // deno-lint-ignore no-explicit-any
  await compactor.summarize(history, fakeProvider as any);

  assertEquals(capturedDigest.includes("web_search"), true);
  assertEquals(capturedDigest.includes("called tools:"), true);
  assertEquals(capturedDigest.includes("result for c1"), true);
});
