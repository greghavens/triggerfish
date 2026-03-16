/**
 * Workflow tool handler implementations — resolve and execute workflows.
 * CRUD operations (save, list, get, delete, history, control) are in
 * tool_handlers_crud.ts and re-exported here.
 * @module
 */

import type { WorkflowDefinition } from "./types.ts";
import type { WorkflowToolContext } from "./tools.ts";
import { executeWorkflow } from "./engine.ts";
import { parseWorkflowYaml } from "./parser.ts";
import { createLogger } from "../core/logger/logger.ts";

// Re-export CRUD handlers so existing imports from this file still work
export {
  dispatchWorkflowControlAction,
  executeWorkflowControl,
  executeWorkflowDelete,
  executeWorkflowGet,
  executeWorkflowHistory,
  executeWorkflowList,
  executeWorkflowSave,
} from "./tool_handlers_crud.ts";

const log = createLogger("workflow-tools");

/** Resolve a workflow definition from inline YAML or a stored name. */
export async function resolveWorkflowDefinition(
  ctx: WorkflowToolContext,
  input: Record<string, unknown>,
): Promise<WorkflowDefinition | string> {
  const name = input.name as string | undefined;
  const yaml = input.yaml as string | undefined;

  if (yaml) {
    const parsed = parseWorkflowYaml(yaml);
    if (!parsed.ok) {
      return JSON.stringify({
        error: `Workflow validation failed: ${parsed.error}`,
      });
    }
    return parsed.value;
  }

  if (name) {
    return await resolveStoredWorkflow(ctx, name);
  }

  return JSON.stringify({
    error: "workflow_run requires either 'name' or 'yaml' parameter",
  });
}

/** Parse a JSON string input, returning undefined on missing or invalid JSON. */
export function parseJsonInput(
  raw: string | undefined,
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    log.warn("Workflow input JSON parse failed", {
      operation: "parseJsonInput",
      err,
    });
    return undefined;
  }
}

/** Build a sub-workflow resolver from context or fall back to store lookup. */
export function buildSubWorkflowResolver(
  ctx: WorkflowToolContext,
): (name: string) => Promise<WorkflowDefinition | null> {
  if (ctx.resolveSubWorkflow) return ctx.resolveSubWorkflow;

  return async (name: string): Promise<WorkflowDefinition | null> => {
    const taint = ctx.getSessionTaint();
    const stored = await ctx.store.loadWorkflowDefinition(name, taint);
    if (!stored) return null;
    const parsed = parseWorkflowYaml(stored.yaml);
    if (!parsed.ok) return null;
    return parsed.value;
  };
}

/** Execute a workflow by name or inline YAML. */
export async function executeWorkflowRun(
  ctx: WorkflowToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const definition = await resolveWorkflowDefinition(ctx, input);
  if (typeof definition === "string") return definition;

  const workflowInput = parseJsonInput(input.input as string | undefined);
  const resolveSubWorkflow = buildSubWorkflowResolver(ctx);

  const runId = crypto.randomUUID();
  const registration = ctx.registry?.registerRun({
    runId,
    workflowName: definition.document.name,
    taint: ctx.getSessionTaint(),
  });

  const result = await executeWorkflow({
    definition,
    input: workflowInput,
    toolExecutor: ctx.toolExecutor,
    getSessionTaint: ctx.getSessionTaint,
    resolveSubWorkflow,
    allowShellExecution: ctx.allowShellExecution,
    signal: registration?.signal,
    checkPause: registration?.checkPause,
    onTaskProgress: ctx.registry
      ? (taskIndex, taskName) =>
        ctx.registry!.reportTaskProgress(runId, {
          taskIndex,
          taskName,
          taint: ctx.getSessionTaint(),
        })
      : undefined,
  });

  if (ctx.registry) {
    ctx.registry.completeRun(runId, {
      status: result.ok ? result.value.status : "failed",
      error: result.ok ? result.value.error : result.error,
    });
  }

  if (!result.ok) {
    return JSON.stringify({ error: result.error });
  }

  await ctx.store.saveWorkflowRun(result.value);
  return JSON.stringify(result.value);
}

/** Resolve a stored workflow definition by name and taint level. */
async function resolveStoredWorkflow(
  ctx: WorkflowToolContext,
  name: string,
): Promise<WorkflowDefinition | string> {
  const taint = ctx.getSessionTaint();
  const stored = await ctx.store.loadWorkflowDefinition(name, taint);
  if (!stored) {
    return JSON.stringify({
      error: `Workflow not found or not accessible: ${name}`,
    });
  }
  const parsed = parseWorkflowYaml(stored.yaml);
  if (!parsed.ok) {
    return JSON.stringify({
      error: `Stored workflow has invalid YAML: ${parsed.error}`,
    });
  }
  return parsed.value;
}
