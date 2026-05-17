/**
 * Tests for model context window registry.
 *
 * @module
 */

import { assertEquals } from "@std/assert";
import { getModelInfo } from "../../src/agent/models.ts";

// ─── Known models ──────────────────────────────────────────────

Deno.test("getModelInfo returns 200k for Claude models", () => {
  assertEquals(
    getModelInfo("claude-sonnet-4-5-20250929").contextWindow,
    200_000,
  );
  assertEquals(getModelInfo("claude-opus-4-6").contextWindow, 200_000);
  assertEquals(
    getModelInfo("claude-3-5-sonnet-20241022").contextWindow,
    200_000,
  );
  assertEquals(getModelInfo("claude-3-haiku-20240307").contextWindow, 200_000);
});

Deno.test("getModelInfo returns 128k for GPT-4o", () => {
  assertEquals(getModelInfo("gpt-4o").contextWindow, 128_000);
  assertEquals(getModelInfo("gpt-4o-mini").contextWindow, 128_000);
});

Deno.test("getModelInfo returns 8k for base GPT-4", () => {
  assertEquals(getModelInfo("gpt-4").contextWindow, 8_192);
});

Deno.test("getModelInfo returns 1M+ for Gemini models", () => {
  assertEquals(getModelInfo("gemini-2.0-flash").contextWindow, 1_048_576);
  assertEquals(getModelInfo("gemini-1.5-pro-latest").contextWindow, 2_097_152);
});

Deno.test("getModelInfo returns 128k for Llama 3.1+", () => {
  assertEquals(getModelInfo("llama-3.1-70b").contextWindow, 128_000);
  assertEquals(getModelInfo("llama-3.3-70b").contextWindow, 128_000);
});

Deno.test("getModelInfo returns 128k for DeepSeek v3/r1", () => {
  assertEquals(getModelInfo("deepseek-v3").contextWindow, 128_000);
  assertEquals(getModelInfo("deepseek-r1").contextWindow, 128_000);
});

// ─── Default fallback ──────────────────────────────────────────

Deno.test("getModelInfo returns 100k default for unknown model", () => {
  const info = getModelInfo("totally-unknown-model-xyz");
  assertEquals(info.contextWindow, 100_000);
  // 16K default — code generation tasks need room to finish HTML/JSON/script
  // output without truncating the trailing tool call.
  assertEquals(info.outputLimit, 16_384);
});

// ─── Case insensitivity ────────────────────────────────────────

Deno.test("getModelInfo is case insensitive", () => {
  assertEquals(
    getModelInfo("Claude-Sonnet-4-5-20250929").contextWindow,
    200_000,
  );
  assertEquals(getModelInfo("GPT-4O").contextWindow, 128_000);
  assertEquals(getModelInfo("GEMINI-2.0-FLASH").contextWindow, 1_048_576);
});

// ─── Output limits ─────────────────────────────────────────────

Deno.test("getModelInfo returns correct output limits", () => {
  assertEquals(getModelInfo("claude-opus-4-6").outputLimit, 128_000);
  assertEquals(getModelInfo("gpt-4o").outputLimit, 16_384);
  assertEquals(getModelInfo("gpt-4").outputLimit, 4_096);
});

// ─── OpenRouter-style prefixed model names ─────────────────────

Deno.test("getModelInfo handles OpenRouter-style model names", () => {
  // OpenRouter uses provider/model format — the regex should still match
  assertEquals(
    getModelInfo("anthropic/claude-sonnet-4-5").contextWindow,
    200_000,
  );
  assertEquals(getModelInfo("openai/gpt-4o").contextWindow, 128_000);
  assertEquals(
    getModelInfo("google/gemini-2.0-flash").contextWindow,
    1_048_576,
  );
});
