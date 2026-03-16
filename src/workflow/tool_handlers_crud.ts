/**
 * Workflow tool CRUD handlers — save, list, get, delete, and history
 * operations against the workflow store.
 * @module
 */

import type { WorkflowToolContext } from "./tools.ts";
import { parseWorkflowYaml } from "./parser.ts";
import { createLogger } from "../core/logger/logger.ts";

const log = createLogger("workflow-tools");

/** Parse, validate, and store a workflow definition. */
export async function executeWorkflowSave(
  ctx: WorkflowToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const name = input.name as string | undefined;
  const yaml = input.yaml as string | undefined;

  if (!name || !yaml) {
    return JSON.stringify({
      error: "Workflow save requires 'name' and 'yaml' parameters",
    });
  }

  const parsed = parseWorkflowYaml(yaml);
  if (!parsed.ok) {
    return JSON.stringify({
      error: `Workflow validation failed: ${parsed.error}`,
    });
  }

  const classification = ctx.getSessionTaint();
  log.info("Saving workflow definition", {
    operation: "executeWorkflowSave",
    workflow: name,
    classification,
  });
  const description = input.description as string | undefined;

  await ctx.store.saveWorkflowDefinition(
    name,
    yaml,
    classification,
    description,
  );

  return JSON.stringify({
    saved: name,
    classification,
    taskCount: parsed.value.do.length,
  });
}

/** List all saved workflows accessible at the current classification level. */
export async function executeWorkflowList(
  ctx: WorkflowToolContext,
  _input: Record<string, unknown>,
): Promise<string> {
  const taint = ctx.getSessionTaint();
  const workflows = await ctx.store.listWorkflowDefinitions(taint);

  const summary = workflows.map((w) => ({
    name: w.name,
    classification: w.classification,
    savedAt: w.savedAt,
    description: w.description,
  }));

  return JSON.stringify({ workflows: summary });
}

/** Retrieve a saved workflow definition by name. */
export async function executeWorkflowGet(
  ctx: WorkflowToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const name = input.name as string | undefined;
  if (!name) {
    return JSON.stringify({ error: "Workflow get requires 'name' parameter" });
  }

  const taint = ctx.getSessionTaint();
  const stored = await ctx.store.loadWorkflowDefinition(name, taint);
  if (!stored) {
    return JSON.stringify({
      error: `Workflow not found or not accessible: ${name}`,
    });
  }

  return JSON.stringify({
    name: stored.name,
    classification: stored.classification,
    savedAt: stored.savedAt,
    description: stored.description,
    yaml: stored.yaml,
  });
}

/** Delete a saved workflow by name. */
export async function executeWorkflowDelete(
  ctx: WorkflowToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const name = input.name as string | undefined;
  if (!name) {
    return JSON.stringify({
      error: "Workflow delete requires 'name' parameter",
    });
  }

  const taint = ctx.getSessionTaint();
  const stored = await ctx.store.loadWorkflowDefinition(name, taint);
  if (!stored) {
    return JSON.stringify({ error: `Workflow '${name}' not found` });
  }

  log.info("Deleting workflow definition", {
    operation: "executeWorkflowDelete",
    workflow: name,
    classification: stored.classification,
  });
  await ctx.store.deleteWorkflowDefinition(name);
  return JSON.stringify({ deleted: name });
}

/** View past workflow execution results, optionally filtered by name. */
export async function executeWorkflowHistory(
  ctx: WorkflowToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const workflowName = input.workflow_name as string | undefined;
  const limit = parseInt(String(input.limit ?? "10"), 10);
  const taint = ctx.getSessionTaint();

  const runs = await ctx.store.listWorkflowRuns(taint, {
    workflowName,
    limit: isNaN(limit) ? 10 : limit,
  });

  const summary = runs.map((r) => ({
    runId: r.runId,
    workflowName: r.workflowName,
    status: r.status,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    taskCount: r.taskCount,
    error: r.error,
  }));

  return JSON.stringify({ runs: summary });
}

/** Control a running workflow: stop, pause, or unpause. */
export function dispatchWorkflowControlAction(
  ctx: WorkflowToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const runId = input.run_id as string | undefined;
  const action = input.action as string | undefined;

  if (!runId || !action) {
    return Promise.resolve(JSON.stringify({
      error: "Workflow control requires 'run_id' and 'action' parameters",
    }));
  }

  if (!ctx.registry) {
    return Promise.resolve(JSON.stringify({
      error: "Workflow run registry not available",
    }));
  }

  return Promise.resolve(dispatchControlAction(ctx.registry, runId, action));
}

/** Dispatch a control action to the registry. */
function dispatchControlAction(
  registry: import("./registry.ts").WorkflowRunRegistry,
  runId: string,
  action: string,
): string {
  if (action === "stop") {
    const ok = registry.stopRun(runId);
    return JSON.stringify(
      ok ? { stopped: runId } : { error: `Workflow run not found: ${runId}` },
    );
  }
  if (action === "pause") {
    const ok = registry.pauseRun(runId);
    return JSON.stringify(
      ok ? { paused: runId } : { error: `Workflow run not pausable: ${runId}` },
    );
  }
  if (action === "unpause") {
    const ok = registry.unpauseRun(runId);
    return JSON.stringify(
      ok ? { unpaused: runId } : { error: `Workflow run not paused: ${runId}` },
    );
  }
  return JSON.stringify({
    error: `Unknown control action: ${action}. Use stop, pause, or unpause`,
  });
}

// --- Deprecated aliases ---

/** @deprecated Use dispatchWorkflowControlAction instead */
export const executeWorkflowControl = dispatchWorkflowControlAction;
