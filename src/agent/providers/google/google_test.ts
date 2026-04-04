/**
 * Tests for Google Gemini provider reasoning control.
 *
 * Verifies that thinkingConfig.thinkingBudget is set to 0 when tools are
 * present for Gemini 2.5 models, and omitted otherwise.
 *
 * Because GoogleGenerativeAI is imported at module level, we test the
 * thinkingConfig construction logic directly using the same conditional
 * that google.ts uses, driven by modelSupportsGeminiThinking().
 */

import { assertEquals } from "@std/assert";
import { modelSupportsGeminiThinking } from "../../models.ts";

/** Replicate the thinkingConfig build logic from prepareGeminiChat. */
function buildGenerationConfig(
  modelName: string,
  hasTools: boolean,
  maxOutputTokens: number,
): Record<string, unknown> {
  const disableThinking = modelSupportsGeminiThinking(modelName) && hasTools;
  return {
    maxOutputTokens,
    ...(disableThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
  };
}

Deno.test("google - gemini-2.5 with tools: thinkingBudget=0 in generationConfig", () => {
  const config = buildGenerationConfig("gemini-2.5-pro", true, 4096);
  assertEquals(
    (config.thinkingConfig as Record<string, unknown>)?.thinkingBudget,
    0,
  );
});

Deno.test("google - gemini-2.5-flash with tools: thinkingBudget=0", () => {
  const config = buildGenerationConfig("gemini-2.5-flash", true, 4096);
  assertEquals(
    (config.thinkingConfig as Record<string, unknown>)?.thinkingBudget,
    0,
  );
});

Deno.test("google - gemini-2.5 no tools: no thinkingConfig", () => {
  const config = buildGenerationConfig("gemini-2.5-pro", false, 4096);
  assertEquals(config.thinkingConfig, undefined);
});

Deno.test("google - gemini-2.0-flash with tools: no thinkingConfig (not a thinking model)", () => {
  const config = buildGenerationConfig("gemini-2.0-flash", true, 4096);
  assertEquals(config.thinkingConfig, undefined);
});

Deno.test("google - gemini-1.5-pro with tools: no thinkingConfig", () => {
  const config = buildGenerationConfig("gemini-1.5-pro", true, 4096);
  assertEquals(config.thinkingConfig, undefined);
});

Deno.test("google - maxOutputTokens always present", () => {
  const withTools = buildGenerationConfig("gemini-2.5-pro", true, 8192);
  const withoutTools = buildGenerationConfig("gemini-2.5-pro", false, 8192);
  assertEquals(withTools.maxOutputTokens, 8192);
  assertEquals(withoutTools.maxOutputTokens, 8192);
});
