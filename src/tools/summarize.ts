/**
 * Summarize tool — focused text summarization with length/style presets.
 *
 * Wraps LLM completion with structured summarization prompts.
 * Lengths: brief (1-2 sentences), standard (1 paragraph), detailed (3-5 paragraphs).
 * Styles: neutral, executive (conclusion-first), technical (preserves terminology).
 *
 * @module
 */

import type { ToolDefinition } from "../core/types/tool.ts";
import type { LlmProviderRegistry } from "../core/types/llm.ts";

/** Valid summary length options. */
type SummarizeLength = "brief" | "standard" | "detailed";

/** Valid summary style options. */
type SummarizeStyle = "neutral" | "executive" | "technical";

/** Length instruction templates. */
const LENGTH_INSTRUCTIONS: Readonly<Record<SummarizeLength, string>> = {
  brief: "Summarize in 1-2 sentences.",
  standard: "Summarize in one concise paragraph.",
  detailed: "Summarize in 3-5 paragraphs covering all key points.",
};

/** Style instruction templates. */
const STYLE_INSTRUCTIONS: Readonly<Record<SummarizeStyle, string>> = {
  neutral: "Use a neutral, informative tone.",
  executive:
    "Write for a busy executive — lead with the conclusion, focus on impact and decisions.",
  technical: "Preserve technical detail and terminology.",
};

/**
 * Build the summarization prompt from text, length, and style.
 *
 * Exported for testing — allows tests to verify prompt construction.
 */
export function buildSummarizePrompt(
  text: string,
  length: SummarizeLength,
  style: SummarizeStyle,
): string {
  const lengthInstr = LENGTH_INSTRUCTIONS[length] ??
    LENGTH_INSTRUCTIONS.standard;
  const styleInstr = STYLE_INSTRUCTIONS[style] ?? STYLE_INSTRUCTIONS.neutral;
  return `${lengthInstr} ${styleInstr}\n\nText to summarize:\n${text}`;
}

/** Tool definitions for the summarize tool. */
export function buildSummarizeToolDefinitions(): readonly ToolDefinition[] {
  return [
    {
      name: "summarize",
      description: "Summarize text content with configurable length and style.",
      parameters: {
        text: {
          type: "string",
          description: "The text to summarize",
          required: true,
        },
        length: {
          type: "string",
          description:
            "brief (1-2 sentences), standard (1 paragraph), detailed (3-5 paragraphs). Default: standard",
          required: false,
        },
        style: {
          type: "string",
          description:
            "neutral, executive (conclusion-first), technical (preserves terminology). Default: neutral",
          required: false,
        },
      },
    },
  ];
}

/** Platform-level system prompt section for the summarize tool. */
export const SUMMARIZE_SYSTEM_PROMPT = `## Summarize Tool

The summarize tool produces focused summaries of text content.
Lengths: brief (1-2 sentences), standard (1 paragraph), detailed (3-5 paragraphs).
Styles: neutral, executive (conclusion-first), technical (preserves terminology).
Default is standard length, neutral style.`;

/**
 * Create a tool executor for the summarize tool.
 *
 * Returns null for unrecognized tool names (chain pattern).
 */
export function createSummarizeToolExecutor(
  registry: LlmProviderRegistry,
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    if (name !== "summarize") return null;

    const text = input.text;
    if (typeof text !== "string" || text.length === 0) {
      return "Error: summarize requires a non-empty 'text' argument.";
    }

    const VALID_LENGTHS: readonly string[] = ["brief", "standard", "detailed"];
    const VALID_STYLES: readonly string[] = [
      "neutral",
      "executive",
      "technical",
    ];

    const length: SummarizeLength = (
      typeof input.length === "string" && VALID_LENGTHS.includes(input.length)
        ? input.length
        : "standard"
    ) as SummarizeLength;

    const style: SummarizeStyle = (
      typeof input.style === "string" && VALID_STYLES.includes(input.style)
        ? input.style
        : "neutral"
    ) as SummarizeStyle;

    const prompt = buildSummarizePrompt(text, length, style);

    const provider = registry.getDefault();
    if (!provider) {
      return "Error: No LLM provider available.";
    }

    try {
      const result = await provider.complete(
        [{ role: "user", content: prompt }],
        [],
        {},
      );
      return result.content;
    } catch (err) {
      return `Error in summarize: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  };
}

/** @deprecated Use buildSummarizeToolDefinitions instead */
export const getSummarizeToolDefinitions = buildSummarizeToolDefinitions;
