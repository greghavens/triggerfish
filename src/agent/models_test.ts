import { assertEquals } from "@std/assert";
import {
  modelSupportsGeminiThinking,
  modelSupportsThinking,
  resolveModelInfo,
} from "./models.ts";

Deno.test("modelSupportsThinking - kimi-k2 is true", () => {
  assertEquals(modelSupportsThinking("kimi-k2"), true);
  assertEquals(modelSupportsThinking("moonshotai/kimi-k2"), true);
  assertEquals(modelSupportsThinking("accounts/fireworks/models/kimi-k2-instruct"), true);
});

Deno.test("modelSupportsThinking - deepseek-r1 is true", () => {
  assertEquals(modelSupportsThinking("deepseek-r1"), true);
  assertEquals(modelSupportsThinking("deepseek-r1-distill-qwen-32b"), true);
});

Deno.test("modelSupportsThinking - deepseek-v3 is false", () => {
  assertEquals(modelSupportsThinking("deepseek-v3"), false);
  assertEquals(modelSupportsThinking("deepseek-v3-0324"), false);
});

Deno.test("modelSupportsThinking - qwq is true", () => {
  assertEquals(modelSupportsThinking("qwq-32b"), true);
  assertEquals(modelSupportsThinking("qwq-72b-preview"), true);
});

Deno.test("modelSupportsThinking - glm-z1 is true", () => {
  assertEquals(modelSupportsThinking("glm-z1-flash"), true);
  assertEquals(modelSupportsThinking("glm-z1-air"), true);
  assertEquals(modelSupportsThinking("glm-z1-plus"), true);
});

Deno.test("modelSupportsThinking - non-reasoning models are false", () => {
  assertEquals(modelSupportsThinking("gpt-4o"), false);
  assertEquals(modelSupportsThinking("claude-sonnet-4-6"), false);
  assertEquals(modelSupportsThinking("llama-3.3-70b"), false);
  assertEquals(modelSupportsThinking("glm-4.5"), false);
  assertEquals(modelSupportsThinking("qwen-2.5-72b"), false);
  assertEquals(modelSupportsThinking("unknown-model"), false);
});

Deno.test("resolveModelInfo - nemotron-3-super has large output limit for code", () => {
  const info = resolveModelInfo("nvidia/nemotron-3-super");
  assertEquals(info.contextWindow, 128_000);
  assertEquals(info.outputLimit, 32_768);
});

Deno.test("resolveModelInfo - gpt-oss has thinking and large output", () => {
  const oss120 = resolveModelInfo("openai/gpt-oss-120b");
  assertEquals(oss120.contextWindow, 131_072);
  assertEquals(oss120.outputLimit, 32_768);
  assertEquals(oss120.supportsThinking, true);
  const oss20 = resolveModelInfo("gpt-oss-20b");
  assertEquals(oss20.outputLimit, 32_768);
  assertEquals(oss20.supportsThinking, true);
});

Deno.test("resolveModelInfo - qwen3-coder has 256K context", () => {
  const info = resolveModelInfo("qwen/qwen3-coder-next");
  assertEquals(info.contextWindow, 262_144);
  assertEquals(info.outputLimit, 32_768);
});

Deno.test("resolveModelInfo - glm-4.7 supports thinking", () => {
  const info = resolveModelInfo("zai-org/glm-4.7-flash");
  assertEquals(info.contextWindow, 128_000);
  assertEquals(info.outputLimit, 32_768);
  assertEquals(info.supportsThinking, true);
});

Deno.test("resolveModelInfo - ministral reasoning supports thinking", () => {
  const info = resolveModelInfo("mistralai/ministral-3-14b-reasoning");
  assertEquals(info.outputLimit, 32_768);
  assertEquals(info.supportsThinking, true);
});

Deno.test("resolveModelInfo - minimax-m2 has 256K context and 32K output", () => {
  const info = resolveModelInfo("minimax-m2.1-reap-50");
  assertEquals(info.contextWindow, 262_144);
  assertEquals(info.outputLimit, 32_768);
});

Deno.test("resolveModelInfo - unknown models default to 16K output for code gen", () => {
  const info = resolveModelInfo("completely-unknown-model-xyz");
  assertEquals(info.outputLimit, 16_384);
});

Deno.test("modelSupportsGeminiThinking - gemini-2.5 is true", () => {
  assertEquals(modelSupportsGeminiThinking("gemini-2.5-pro"), true);
  assertEquals(modelSupportsGeminiThinking("gemini-2.5-flash"), true);
});

Deno.test("modelSupportsGeminiThinking - other models are false", () => {
  assertEquals(modelSupportsGeminiThinking("gemini-2.0-flash"), false);
  assertEquals(modelSupportsGeminiThinking("gemini-1.5-pro"), false);
  assertEquals(modelSupportsGeminiThinking("kimi-k2"), false);
  assertEquals(modelSupportsGeminiThinking("gpt-4o"), false);
});

Deno.test("resolveModelInfo - qwq has correct limits", () => {
  const info = resolveModelInfo("qwq-32b");
  assertEquals(info.contextWindow, 128_000);
  assertEquals(info.outputLimit, 32_768);
  assertEquals(info.supportsThinking, true);
});

Deno.test("resolveModelInfo - glm-z1 has correct limits", () => {
  const info = resolveModelInfo("glm-z1-flash");
  assertEquals(info.contextWindow, 128_000);
  assertEquals(info.outputLimit, 16_384);
  assertEquals(info.supportsThinking, true);
});

Deno.test("resolveModelInfo - gemini-2.5 has correct limits", () => {
  const info = resolveModelInfo("gemini-2.5-pro");
  assertEquals(info.contextWindow, 1_048_576);
  assertEquals(info.supportsGeminiThinking, true);
});
