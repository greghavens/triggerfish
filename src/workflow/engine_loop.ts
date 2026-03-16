/**
 * Workflow engine loop helpers — signal checks, ceiling enforcement, task dispatch.
 *
 * Extracted from engine.ts to keep file sizes manageable.
 * @module
 */

import { canFlowTo } from "../core/types/classification.ts";
import { createLogger } from "../core/logger/logger.ts";
import type { WorkflowContext } from "./context.ts";
import {
  applySetTask,
  emitWorkflowEvent,
  evaluateSwitchTask,
  executeCallTask,
  executeForTask,
  executeWaitTask,
  invokeRunTask,
  raiseWorkflowError,
} from "./task_runners.ts";
import type { SubWorkflowExecutor } from "./task_runners.ts";
import type { WorkflowEvent, WorkflowTaskEntry } from "./types.ts";
import type {
  EngineResult,
  ExecuteWorkflowOptions,
  TaskResult,
} from "./engine.ts";

const log = createLogger("workflow-engine");

/** Detect whether the abort signal has fired. Returns an error string or null. */
export function detectAbortSignal(signal?: AbortSignal): string | null {
  if (signal?.aborted) {
    return "Workflow cancelled by user";
  }
  return null;
}

/** @deprecated Use {@link detectAbortSignal} instead. */
export const checkSignalAborted = detectAbortSignal;

/** Detect a WorkflowCancelledError by name. */
export function isWorkflowCancelled(e: unknown): e is Error {
  return e instanceof Error && e.name === "WorkflowCancelledError";
}

/** Verify the session taint does not exceed the workflow classification ceiling. */
export function enforceClassificationCeiling(
  options: ExecuteWorkflowOptions,
): EngineResult<void> {
  const ceiling = options.definition.classificationCeiling;
  if (!ceiling || !options.getSessionTaint) {
    return { ok: true, value: undefined };
  }

  const taint = options.getSessionTaint();
  if (!canFlowTo(taint, ceiling)) {
    log.warn(
      "Workflow ceiling breached: session taint exceeds classification ceiling",
      {
        operation: "enforceClassificationCeiling",
        workflow: options.definition.document.name,
        sessionTaint: taint,
        ceiling,
      },
    );
    return {
      ok: false,
      error:
        `Workflow classification ceiling breached: session taint ${taint} exceeds ceiling ${ceiling}`,
    };
  }

  log.debug("Workflow ceiling enforcement passed", {
    operation: "enforceClassificationCeiling",
    workflow: options.definition.document.name,
    sessionTaint: taint,
    ceiling,
  });
  return { ok: true, value: undefined };
}

/** @deprecated Use {@link enforceClassificationCeiling} instead. */
export const checkCeiling = enforceClassificationCeiling;

/** Dispatch a single task entry to the appropriate task runner. */
export function dispatchTask(
  entry: WorkflowTaskEntry,
  context: WorkflowContext,
  events: WorkflowEvent[],
  options: ExecuteWorkflowOptions,
  subWorkflowExecutor: SubWorkflowExecutor,
): Promise<EngineResult<TaskResult>> {
  const task = entry.task;

  switch (task.type) {
    case "call":
      return executeCallTask(entry.name, task, context, options);
    case "set":
      return applySetTask(task, context);
    case "switch":
      return evaluateSwitchTask(task, context);
    case "for":
      return executeForTask(
        task,
        context,
        events,
        options,
        (e, c, ev, o) => dispatchTask(e, c, ev, o, subWorkflowExecutor),
      );
    case "raise":
      return raiseWorkflowError(task);
    case "emit":
      return emitWorkflowEvent(task, context, events);
    case "wait":
      return executeWaitTask(task, context);
    case "run":
      return invokeRunTask(
        entry.name,
        task,
        context,
        options,
        subWorkflowExecutor,
      );
  }
}
