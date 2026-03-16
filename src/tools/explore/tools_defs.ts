/**
 * Explore tool definition, depth type, and system prompt.
 *
 * Defines the `explore` tool schema and the system prompt section
 * for single-agent codebase exploration.
 *
 * @module
 */

import type { ToolDefinition } from "../../core/types/tool.ts";

/** Exploration depth levels. */
export type ExploreDepth = "shallow" | "standard" | "deep";

/** Build the explore tool definition. */
function buildExploreDef(): ToolDefinition {
  return {
    name: "explore",
    description:
      "Explore a directory or codebase to understand structure, patterns, and conventions. " +
      "Spawns an agent for thorough read-only exploration.",
    parameters: {
      path: {
        type: "string",
        description: "Directory or file to explore",
        required: true,
      },
      focus: {
        type: "string",
        description:
          "What to look for (e.g. 'auth patterns', 'test structure')",
        required: false,
      },
      depth: {
        type: "string",
        description: "How thorough: 'shallow', 'standard' (default), or 'deep'",
        required: false,
      },
    },
  };
}

/** Get the explore tool definition. */
export function buildExploreToolDefinitions(): readonly ToolDefinition[] {
  return [buildExploreDef()];
}

/** System prompt section for the explore tool. */
export const EXPLORE_SYSTEM_PROMPT = `## Explore Tool

Use \`explore\` before modifying unfamiliar code or at the start of non-trivial tasks.
Explores a directory using an agent with read-only tools for thorough understanding.

Use the focus parameter to direct exploration:
  explore({ path: "src/auth", focus: "how tokens are validated" })
  explore({ path: "src/core", depth: "deep" })

Reference the patterns and conventions you find when writing new code.`;

/** @deprecated Use buildExploreToolDefinitions instead */
export const getExploreToolDefinitions = buildExploreToolDefinitions;
