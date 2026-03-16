/**
 * Inline tool definitions for agent meta-operations.
 *
 * Subagent spawning and agent listing are defined inline because
 * they are wired directly in the gateway executor.
 *
 * @module
 */

import type { ToolDefinition } from "../../../core/types/tool.ts";

function buildSubagentDef(): ToolDefinition {
  return {
    name: "subagent",
    description:
      "Spawn a sub-agent for an autonomous multi-step task. Returns the result when complete.",
    parameters: {
      task: {
        type: "string",
        description: "What the sub-agent should accomplish",
        required: true,
      },
      tools: {
        type: "string",
        description:
          "Comma-separated tool whitelist (default: read-only tools)",
        required: false,
      },
    },
  };
}

function buildAgentsListDef(): ToolDefinition {
  return {
    name: "agents_list",
    description: "List configured LLM providers/agents.",
    parameters: {},
  };
}

/** Agent meta-tools: subagent, agents_list. */
export function buildAgentInlineDefinitions(): readonly ToolDefinition[] {
  return [buildSubagentDef(), buildAgentsListDef()];
}

/** @deprecated Use buildAgentInlineDefinitions instead */
export const getAgentInlineDefinitions = buildAgentInlineDefinitions;
