/**
 * Trigger management tool definition.
 *
 * Provides a `trigger_manage` tool for viewing, updating, and checking
 * trigger status without filesystem access. Trigger instructions stored
 * via this tool are kept in memory at PUBLIC classification, preventing
 * write-down from classified sessions into the trigger's PUBLIC context.
 *
 * @module
 */

import type { ToolDefinition } from "../../../core/types/tool.ts";

/** Build the trigger_manage tool definition. */
function buildTriggerManageDef(): ToolDefinition {
  return {
    name: "trigger_manage",
    description:
      "Manage trigger instructions and status. Actions: view, status, update.\n" +
      "- view: read current trigger instructions (from memory override or TRIGGER.md file)\n" +
      "- status: show trigger config (enabled, interval, ceiling) and last run result\n" +
      "- update: set new trigger instructions. Stored in memory at PUBLIC — blocked if session taint > PUBLIC (write-down). Use /clear first if tainted.",
    parameters: {
      action: {
        type: "string",
        description: "The operation: view, status, update",
        required: true,
      },
      instructions: {
        type: "string",
        description:
          "New trigger instructions (update only). Replaces the current instructions.",
        required: false,
      },
    },
  };
}

/** Build the trigger management tool definitions. */
export function buildTriggerManageToolDefinitions(): readonly ToolDefinition[] {
  return [buildTriggerManageDef()];
}

/** @deprecated Use buildTriggerManageToolDefinitions instead */
export const getTriggerManageToolDefinitions =
  buildTriggerManageToolDefinitions;

/** System prompt section explaining trigger_manage to the LLM. */
export const TRIGGER_MANAGE_SYSTEM_PROMPT = `## Trigger Management

Use \`trigger_manage\` to view or update trigger instructions without touching the filesystem.

- \`action: "view"\` — read the current trigger instructions (memory override or TRIGGER.md)
- \`action: "status"\` — show trigger config and last run result
- \`action: "update", instructions: "..."\` — set new trigger instructions

**IMPORTANT:** TRIGGER.md is write-protected. Never use write_file or edit_file on TRIGGER.md.
Use trigger_manage(action: "update") instead. Updates are stored in memory at PUBLIC classification.
If your session taint is above PUBLIC, you must /clear first — writing classified data into
trigger instructions is a write-down violation (triggers run at PUBLIC).`;
