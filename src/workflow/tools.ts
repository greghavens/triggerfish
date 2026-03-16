/**
 * Workflow tool definitions and executor for LLM-callable tools.
 *
 * Follows the standard Triggerfish tool registration pattern:
 * - `buildWorkflowToolDefinitions()` returns tool definitions
 * - `createWorkflowToolExecutor()` returns a subsystem executor
 * - `WORKFLOW_SYSTEM_PROMPT` provides LLM guidance
 * @module
 */

import type { ToolDefinition } from "../core/types/tool.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import type { WorkflowStore } from "./store.ts";
import type { WorkflowToolExecutor } from "./engine.ts";
import type { WorkflowDefinition } from "./types.ts";
import {
  dispatchWorkflowControlAction,
  executeWorkflowDelete,
  executeWorkflowGet,
  executeWorkflowHistory,
  executeWorkflowList,
  executeWorkflowRun,
  executeWorkflowSave,
} from "./tool_handlers.ts";
import type { WorkflowRunRegistry } from "./registry.ts";
import { SELF_HEALING_SYSTEM_PROMPT } from "./healing/system_prompt.ts";
import { WORKFLOW_CREATION_PROMPT } from "./creation_prompt.ts";

/** System prompt section for workflow tools. */
export const WORKFLOW_SYSTEM_PROMPT = `## Workflow Engine

CNCF Serverless Workflow DSL 1.0 — create, store, and execute workflows.
${WORKFLOW_CREATION_PROMPT}

**Call types:** http, triggerfish:llm, triggerfish:memory, triggerfish:web_search, triggerfish:web_fetch, triggerfish:mcp, triggerfish:message, triggerfish:agent
**Task types:** call, run (shell/script/sub-workflow), set, switch, for, raise, emit, wait
**Expressions:** \`\${ .path.to.value }\` — dot-paths, comparisons, arithmetic
${SELF_HEALING_SYSTEM_PROMPT}
`;

/** Context needed by the workflow tool executor. */
export interface WorkflowToolContext {
  readonly store: WorkflowStore;
  readonly toolExecutor: WorkflowToolExecutor;
  readonly getSessionTaint: () => ClassificationLevel;
  readonly resolveSubWorkflow?: (
    name: string,
  ) => Promise<WorkflowDefinition | null>;
  /** Whether shell/script run tasks are allowed (default: true). */
  readonly allowShellExecution?: boolean;
  /** Registry for tracking and controlling active workflow runs. */
  readonly registry?: WorkflowRunRegistry;
}

/** Return all workflow tool definitions. */
export function buildWorkflowToolDefinitions(): readonly ToolDefinition[] {
  return [
    buildWorkflowRunDef(),
    buildWorkflowSaveDef(),
    buildWorkflowListDef(),
    buildWorkflowGetDef(),
    buildWorkflowDeleteDef(),
    buildWorkflowHistoryDef(),
    buildWorkflowControlDef(),
  ];
}

/** Create the workflow subsystem executor. */
export function createWorkflowToolExecutor(
  ctx: WorkflowToolContext,
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  const executors: Record<
    string,
    (input: Record<string, unknown>) => Promise<string>
  > = {
    workflow_run: (input) => executeWorkflowRun(ctx, input),
    workflow_save: (input) => executeWorkflowSave(ctx, input),
    workflow_list: (input) => executeWorkflowList(ctx, input),
    workflow_get: (input) => executeWorkflowGet(ctx, input),
    workflow_delete: (input) => executeWorkflowDelete(ctx, input),
    workflow_history: (input) => executeWorkflowHistory(ctx, input),
    workflow_control: (input) => dispatchWorkflowControlAction(ctx, input),
  };

  return (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    const handler = executors[name];
    if (!handler) return Promise.resolve(null);
    return handler(input);
  };
}

// --- Tool Definitions ---

function buildWorkflowRunDef(): ToolDefinition {
  return {
    name: "workflow_run",
    description:
      "Execute a workflow by name or from inline YAML. Returns the workflow output and execution status.",
    parameters: {
      name: {
        type: "string",
        description: "Name of a saved workflow to execute",
      },
      yaml: {
        type: "string",
        description:
          "Inline YAML workflow definition (used when not referencing a saved workflow)",
      },
      input: {
        type: "string",
        description: "JSON string of input data for the workflow",
      },
    },
  };
}

function buildWorkflowSaveDef(): ToolDefinition {
  return {
    name: "workflow_save",
    description:
      "Parse, validate, and store a workflow definition. The workflow is saved at the current session's classification level.",
    parameters: {
      name: {
        type: "string",
        description: "Name for the workflow",
        required: true,
      },
      yaml: {
        type: "string",
        description: "YAML workflow definition",
        required: true,
      },
      description: {
        type: "string",
        description: "Optional description of what the workflow does",
      },
    },
  };
}

function buildWorkflowListDef(): ToolDefinition {
  return {
    name: "workflow_list",
    description:
      "List all saved workflows accessible at the current classification level.",
    parameters: {},
  };
}

function buildWorkflowGetDef(): ToolDefinition {
  return {
    name: "workflow_get",
    description: "Retrieve a saved workflow definition by name.",
    parameters: {
      name: {
        type: "string",
        description: "Name of the workflow to retrieve",
        required: true,
      },
    },
  };
}

function buildWorkflowDeleteDef(): ToolDefinition {
  return {
    name: "workflow_delete",
    description: "Delete a saved workflow by name.",
    parameters: {
      name: {
        type: "string",
        description: "Name of the workflow to delete",
        required: true,
      },
    },
  };
}

function buildWorkflowHistoryDef(): ToolDefinition {
  return {
    name: "workflow_history",
    description:
      "View past workflow execution results. Optionally filter by workflow name.",
    parameters: {
      workflow_name: {
        type: "string",
        description: "Filter by workflow name",
      },
      limit: {
        type: "string",
        description: "Maximum number of results (default 10)",
      },
    },
  };
}

function buildWorkflowControlDef(): ToolDefinition {
  return {
    name: "workflow_control",
    description:
      "Control a running workflow: stop, pause, or unpause. Pause/unpause waits for the current task to finish before taking effect.",
    parameters: {
      run_id: {
        type: "string",
        description: "The run ID of the workflow to control",
        required: true,
      },
      action: {
        type: "string",
        description: 'Action to perform: "stop", "pause", or "unpause"',
        required: true,
      },
    },
  };
}

// --- Deprecated aliases ---

/** @deprecated Use buildWorkflowToolDefinitions instead */
export const getWorkflowToolDefinitions = buildWorkflowToolDefinitions;
