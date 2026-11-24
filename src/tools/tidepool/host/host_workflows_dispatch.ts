/**
 * Dispatch helpers for Tidepool workflow actions — control, start, schedule, broadcast.
 * @module
 */

import { createLogger } from "../../../core/logger/logger.ts";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import { trySendSocketPayload } from "./host_broadcast.ts";
import type {
  MinimalCronManager,
  MinimalRunRegistry,
  MinimalWorkflowStore,
  MinimalWorkflowVersionStore,
  RegistryEventShape,
  RichWorkflowEvent,
  WorkflowExecutorFn,
} from "./host_workflows_types.ts";

const log = createLogger("tidepool-workflows");

/** Dispatch a control action (stop/pause/unpause) to the registry. */
export function dispatchControlAction(
  registry: MinimalRunRegistry,
  runId: string,
  action: string,
): Record<string, unknown> {
  const dispatch: Record<string, () => boolean> = {
    stop: () => registry.stopRun(runId),
    pause: () => registry.pauseRun(runId),
    unpause: () => registry.unpauseRun(runId),
  };
  const handler = dispatch[action];
  if (!handler) {
    log.warn("Unknown workflow control action requested", {
      operation: "dispatchControlAction",
      runId,
      action,
    });
    return {
      topic: "workflows",
      type: "control_result",
      runId,
      action,
      ok: false,
      error: `Unknown control action: ${action}`,
    };
  }
  const ok = handler();
  log.debug("Workflow control action dispatched", {
    operation: "dispatchControlAction",
    runId,
    action,
    ok,
  });
  return {
    topic: "workflows",
    type: "control_result",
    runId,
    action,
    ok,
  };
}

/** Start a workflow run via the executor. */
export async function dispatchStartRun(
  store: MinimalWorkflowStore,
  workflowExecutor: WorkflowExecutorFn | undefined,
  name: string,
  sessionTaint: ClassificationLevel,
): Promise<Record<string, unknown>> {
  if (!workflowExecutor) {
    log.warn("Workflow start rejected: executor not available", {
      operation: "dispatchStartRun",
      workflow: name,
    });
    return {
      topic: "workflows",
      type: "start_result",
      name,
      ok: false,
      error: "Workflow executor not available",
    };
  }
  const wf = await store.loadWorkflowDefinition(
    name,
    sessionTaint,
  );
  if (!wf) {
    log.warn(
      "Workflow start rejected: definition not found or classification gated",
      {
        operation: "dispatchStartRun",
        workflow: name,
        sessionTaint,
      },
    );
    return {
      topic: "workflows",
      type: "start_result",
      name,
      ok: false,
      error: `Workflow not found or classification too high: ${name}`,
    };
  }
  log.info("Starting workflow run via Tidepool", {
    operation: "startRun",
    workflow: name,
  });
  workflowExecutor("workflow_run", { name }).catch((err: unknown) => {
    log.warn("Workflow run failed", {
      operation: "startRun",
      workflow: name,
      err,
    });
  });
  return { topic: "workflows", type: "start_result", name, ok: true };
}

/** Schedule a workflow as a cron job. */
export function dispatchScheduleRun(
  cronManager: MinimalCronManager | undefined,
  name: string,
  expression: string,
  classification: ClassificationLevel,
): Record<string, unknown> {
  if (!cronManager) {
    log.warn("Workflow schedule rejected: cron manager not available", {
      operation: "dispatchScheduleRun",
      workflow: name,
      expression,
    });
    return {
      topic: "workflows",
      type: "schedule_result",
      name,
      ok: false,
      error: "Cron manager not available",
    };
  }
  const task =
    `Run the saved workflow named "${name}" using the workflow_run tool.`;
  const result = cronManager.create({
    expression,
    task,
    classificationCeiling: classification,
  });
  if (!result.ok) {
    log.warn("Workflow schedule creation failed", {
      operation: "scheduleRun",
      workflow: name,
      expression,
      error: result.error,
    });
    return {
      topic: "workflows",
      type: "schedule_result",
      name,
      ok: false,
      error: result.error,
    };
  }
  log.info("Workflow scheduled via Tidepool", {
    operation: "scheduleRun",
    workflow: name,
    expression,
    jobId: result.value.id,
  });
  return {
    topic: "workflows",
    type: "schedule_result",
    name,
    ok: true,
    jobId: result.value.id,
    expression,
  };
}

/** Broadcast a registry event to all subscribed WebSocket clients. */
export function broadcastRegistryEvent(
  subscribers: Set<WebSocket>,
  event: RegistryEventShape,
): void {
  const payload = JSON.stringify({
    topic: "workflows",
    type: "run_event",
    event,
  });

  for (const socket of subscribers) {
    trySendSocketPayload(socket, payload);
  }
}

/** Strip classified input/output fields from a rich event before sending to browser. */
function sanitizeRichEvent(
  event: RichWorkflowEvent,
): Record<string, unknown> {
  const base = { ...event } as Record<string, unknown>;
  delete base["input"];
  delete base["output"];
  delete base["taskDef"];
  return base;
}

/** Broadcast a rich step event to all subscribed WebSocket clients. */
export function broadcastRichEvent(
  subscribers: Set<WebSocket>,
  event: RichWorkflowEvent,
): void {
  const sanitized = sanitizeRichEvent(event);
  const payload = JSON.stringify({
    topic: "workflows",
    type: "step_event",
    event: sanitized,
  });

  for (const socket of subscribers) {
    trySendSocketPayload(socket, payload);
  }
}

/** Approve a workflow version via the version store. */
export async function approveWorkflowVersion(
  versionStore: MinimalWorkflowVersionStore | undefined,
  versionId: string,
  reviewedBy: string,
): Promise<Record<string, unknown>> {
  if (!versionStore) {
    log.warn(
      "Workflow version approval rejected: version store not configured",
      {
        operation: "approveWorkflowVersion",
        versionId,
      },
    );
    return {
      topic: "workflows",
      type: "version_result",
      versionId,
      action: "approve",
      ok: false,
      error: "Version store not available",
    };
  }
  const ok = await versionStore.approveWorkflowVersion(versionId, reviewedBy);
  log.info("Workflow version approval processed", {
    operation: "approveVersion",
    versionId,
    reviewedBy,
    ok,
  });
  return {
    topic: "workflows",
    type: "version_result",
    versionId,
    action: "approve",
    ok,
  };
}

/** Reject a workflow version via the version store. */
export async function rejectWorkflowVersion(
  versionStore: MinimalWorkflowVersionStore | undefined,
  versionId: string,
  reviewedBy: string,
  reason: string,
): Promise<Record<string, unknown>> {
  if (!versionStore) {
    log.warn(
      "Workflow version rejection rejected: version store not configured",
      {
        operation: "rejectWorkflowVersion",
        versionId,
      },
    );
    return {
      topic: "workflows",
      type: "version_result",
      versionId,
      action: "reject",
      ok: false,
      error: "Version store not available",
    };
  }
  const ok = await versionStore.rejectWorkflowVersion(
    versionId,
    reviewedBy,
    reason,
  );
  log.info("Workflow version rejection processed", {
    operation: "rejectVersion",
    versionId,
    reviewedBy,
    reason,
    ok,
  });
  return {
    topic: "workflows",
    type: "version_result",
    versionId,
    action: "reject",
    ok,
  };
}
