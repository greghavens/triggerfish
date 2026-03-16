/**
 * Tool definitions for `simulate_tool_call` — dry-run security simulation.
 *
 * Lets the LLM preview taint escalation and policy violations before
 * committing to a tool call. No tool execution occurs; only the
 * security pipeline is evaluated.
 *
 * @module
 */

import type { ToolDefinition } from "../../core/types/tool.ts";

/** Build the simulate_tool_call tool definition. */
function buildSimulateToolCallDef(): ToolDefinition {
  return {
    name: "simulate_tool_call",
    description:
      "Dry-run a tool call through the security pipeline without executing it. " +
      "Returns the current session taint, what taint would result, whether " +
      "escalation would occur, and whether the call would be blocked by policy.",
    parameters: {
      tool_name: {
        type: "string",
        description:
          "Name of the tool to simulate (e.g. 'read_file', 'github_list_repos').",
        required: true,
      },
      tool_args: {
        type: "object",
        description: "Exact arguments that would be passed to the tool.",
        required: true,
      },
    },
  };
}

/** Get tool definitions for the simulate tool group. */
export function buildSimulateToolDefinitions(): readonly ToolDefinition[] {
  return [buildSimulateToolCallDef()];
}

/** System prompt section for tool simulation guidance. */
export const SIMULATE_SYSTEM_PROMPT = `## Tool Simulation

Stay in your current session taint unless the user requests data outside of it.
Before calling a tool that may access classified resources, use simulate_tool_call
to check whether it would escalate your session taint. If simulation shows
escalation, inform the user and ask whether to proceed.`;

/** @deprecated Use buildSimulateToolDefinitions instead */
export const getSimulateToolDefinitions = buildSimulateToolDefinitions;
