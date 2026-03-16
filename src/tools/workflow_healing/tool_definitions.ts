/**
 * Workflow healing tool definitions — LLM-callable tools for version management.
 * @module
 */

import type { ToolDefinition } from "../../core/types/tool.ts";

/** Return all workflow healing tool definitions. */
export function buildWorkflowHealingToolDefinitions(): readonly ToolDefinition[] {
  return [
    buildVersionListDef(),
    buildVersionApproveDef(),
    buildVersionRejectDef(),
    buildHealingStatusDef(),
  ];
}

function buildVersionListDef(): ToolDefinition {
  return {
    name: "workflow_version_list",
    description:
      "List all versions (proposed, approved, rejected) for a workflow. Shows the version history and approval status.",
    parameters: {
      workflow_name: {
        type: "string",
        description: "Name of the workflow to list versions for",
        required: true,
      },
    },
  };
}

function buildVersionApproveDef(): ToolDefinition {
  return {
    name: "workflow_version_approve",
    description:
      "Approve a proposed workflow version. The approved version becomes the canonical definition.",
    parameters: {
      version_id: {
        type: "string",
        description: "The version ID to approve",
        required: true,
      },
    },
  };
}

function buildVersionRejectDef(): ToolDefinition {
  return {
    name: "workflow_version_reject",
    description:
      "Reject a proposed workflow version. Rejected proposals are preserved for future lead context.",
    parameters: {
      version_id: {
        type: "string",
        description: "The version ID to reject",
        required: true,
      },
      reason: {
        type: "string",
        description: "Reason for rejecting the version",
        required: true,
      },
    },
  };
}

function buildHealingStatusDef(): ToolDefinition {
  return {
    name: "workflow_healing_status",
    description:
      "Get the current healing status for a running workflow, including healing phase, pending approvals, and active deviations.",
    parameters: {
      run_id: {
        type: "string",
        description: "The run ID to check healing status for",
        required: true,
      },
    },
  };
}

/** @deprecated Use buildWorkflowHealingToolDefinitions instead */
export const getWorkflowHealingToolDefinitions =
  buildWorkflowHealingToolDefinitions;
