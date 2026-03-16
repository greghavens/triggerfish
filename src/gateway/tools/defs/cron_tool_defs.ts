/**
 * Inline tool definition for cron scheduling operations.
 *
 * Consolidated 4 cron tools into 1 with action parameter dispatch.
 *
 * @module
 */

import type { ToolDefinition } from "../../../core/types/tool.ts";

function buildCronDef(): ToolDefinition {
  return {
    name: "cron",
    description:
      "Cron job management. Actions: create, list, delete, history.\n" +
      "- create: create a scheduled cron job. Params: expression (required), task (required), classification?\n" +
      "- list: list all registered cron jobs. No extra params.\n" +
      "- delete: delete a cron job. Params: job_id (required)\n" +
      "- history: show recent execution history. Params: job_id (required)",
    parameters: {
      action: {
        type: "string",
        description: "The operation: create, list, delete, history",
        required: true,
      },
      expression: {
        type: "string",
        description:
          "5-field cron expression, e.g. '0 9 * * *' for 9am daily (create)",
        required: false,
      },
      task: {
        type: "string",
        description: "The task/prompt to execute on each trigger (create)",
        required: false,
      },
      classification: {
        type: "string",
        description:
          "Classification ceiling: PUBLIC, INTERNAL, CONFIDENTIAL, or RESTRICTED (create)",
        required: false,
      },
      job_id: {
        type: "string",
        description: "The UUID of the cron job (delete, history)",
        required: false,
      },
    },
  };
}

/** Cron scheduling tool: single consolidated cron tool. */
export function buildCronInlineDefinitions(): readonly ToolDefinition[] {
  return [
    buildCronDef(),
  ];
}

/** @deprecated Use buildCronInlineDefinitions instead */
export const getCronInlineDefinitions = buildCronInlineDefinitions;
