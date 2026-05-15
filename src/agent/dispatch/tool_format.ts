/**
 * Tool definition format conversion and tool call parsing.
 *
 * Converts internal ToolDefinition to OpenAI native format for LLM providers,
 * and parses tool calls from both OpenAI and Anthropic response formats.
 *
 * @module
 */

import { createLogger } from "../../core/logger/mod.ts";
import type {
  ParsedToolCall,
  ToolDefinition,
} from "../orchestrator/orchestrator_types.ts";

// ─── Tool format conversion ──────────────────────────────────────────────────

/** Convert a single tool parameter definition to OpenAI property format. */
function convertParameterToProperty(
  v: ToolDefinition["parameters"][string],
): Record<string, unknown> {
  const prop: Record<string, unknown> = {
    type: v.type,
    description: v.description,
  };
  if (v.items) prop.items = v.items;
  if (v.enum) prop.enum = v.enum;
  return prop;
}

/** Extract required parameter names from a tool definition. */
function extractRequiredParameterNames(
  parameters: ToolDefinition["parameters"],
): string[] {
  return Object.entries(parameters)
    .filter(([_, v]) => v.required !== false)
    .map(([k]) => k);
}

/** Convert a single tool definition to OpenAI native format. */
function convertSingleToolToNativeFormat(t: ToolDefinition) {
  return {
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object" as const,
        properties: Object.fromEntries(
          Object.entries(t.parameters).map(
            ([k, v]) => [k, convertParameterToProperty(v)],
          ),
        ),
        required: extractRequiredParameterNames(t.parameters),
      },
    },
  };
}

/** Convert tool definitions to OpenAI native tool format for LLM providers. */
export function convertToolsToNativeFormat(tools: readonly ToolDefinition[]) {
  return tools.map(convertSingleToolToNativeFormat);
}

// ─── Tool call parsing ───────────────────────────────────────────────────────

/** Try parsing an OpenAI-format tool call. */
function parseOpenAiToolCall(
  t: Record<string, unknown>,
  orchLog: ReturnType<typeof createLogger>,
): ParsedToolCall | null {
  if (typeof (t as { function?: unknown }).function !== "object") return null;
  const fn = (t as { function: { name: string; arguments: string } }).function;
  const id = typeof t.id === "string" ? t.id : undefined;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(fn.arguments);
  } catch (parseErr: unknown) {
    orchLog.warn("Tool call arguments malformed", {
      tool: fn.name,
      error: parseErr instanceof Error ? parseErr.message : String(parseErr),
    });
  }
  return { name: fn.name, args, ...(id ? { id } : {}) };
}

/** Try parsing an Anthropic-format tool call. */
function parseAnthropicToolCall(
  t: Record<string, unknown>,
): ParsedToolCall | null {
  if (t.type !== "tool_use" || typeof t.name !== "string") return null;
  const input = (t.input ?? {}) as Record<string, unknown>;
  const id = typeof t.id === "string" ? t.id : undefined;
  return { name: t.name as string, args: input, ...(id ? { id } : {}) };
}

/** Parse native tool calls from LLM provider response. */
export function parseNativeToolCalls(
  rawCalls: readonly unknown[],
  orchLog: ReturnType<typeof createLogger>,
): ParsedToolCall[] {
  return rawCalls
    .map((tc: unknown): ParsedToolCall | null => {
      const t = tc as Record<string, unknown>;
      if (t === null || typeof t !== "object") return null;
      return parseOpenAiToolCall(t, orchLog) ?? parseAnthropicToolCall(t);
    })
    .filter((tc): tc is ParsedToolCall => tc !== null);
}
