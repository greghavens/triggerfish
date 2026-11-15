/**
 * Step history helpers for the workflow run registry.
 * @module
 */

import type { WorkflowStatus } from "./types.ts";
import { createLogger } from "../core/logger/logger.ts";
import type { RichWorkflowEvent } from "./healing/types.ts";
import type {
  ActiveRunSnapshot,
  RegistryEvent,
  RegistryListener,
  RunControl,
  StepState,
} from "./registry_types.ts";

const log = createLogger("workflow-registry");

/** Emit a registry event to all listeners, catching errors. */
export function emitRegistryEvent(
  listeners: Set<RegistryListener>,
  event: RegistryEvent,
): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      log.warn("Registry listener threw during event dispatch", {
        operation: "emit",
        eventType: event.type,
        runId: event.runId,
        err,
      });
    }
  }
}

/** Create a snapshot of a run for external consumers. */
export function snapshotRun(ctrl: RunControl): ActiveRunSnapshot {
  return {
    runId: ctrl.runId,
    workflowName: ctrl.workflowName,
    status: ctrl.paused ? "paused" as WorkflowStatus : ctrl.status,
    currentTaskIndex: ctrl.currentTaskIndex,
    currentTaskName: ctrl.currentTaskName,
    startedAt: ctrl.startedAt,
    paused: ctrl.paused,
    taint: ctrl.taint,
  };
}

/** Dispatch a rich event to rich listeners, catching errors. */
export function emitRichEvent(
  richListeners: Set<(event: RichWorkflowEvent) => void>,
  runId: string,
  event: RichWorkflowEvent,
): void {
  for (const listener of richListeners) {
    try {
      listener(event);
    } catch (err) {
      log.warn("Rich event listener threw during dispatch", {
        operation: "reportStepEvent",
        eventType: event.type,
        runId,
        err,
      });
    }
  }
}

/** Map a RichWorkflowEvent to a StepState update. */
export function mapRichEventToStepState(
  ctrl: RunControl,
  event: RichWorkflowEvent,
): StepState | null {
  switch (event.type) {
    case "STEP_STARTED":
      return buildStepState(event, "running", {
        taintBefore: event.runningTaint,
      });
    case "STEP_COMPLETED":
      return buildStepState(event, "completed", {
        taintAfter: event.taintAfter,
        duration: event.duration,
      });
    case "STEP_FAILED":
      return buildStepState(event, "failed", {
        error: event.error,
        attemptNumber: event.attemptNumber,
      });
    case "STEP_SKIPPED":
      return buildStepState(event, "skipped");
    case "BRANCH_TAKEN":
      return mapBranchTakenEvent(ctrl, event);
    default:
      return null;
  }
}

/** Build a StepState from a step event with the given status and extras. */
function buildStepState(
  event: { readonly taskIndex: number; readonly taskName: string },
  status: StepState["status"],
  extras?: Partial<StepState>,
): StepState {
  return {
    taskIndex: event.taskIndex,
    taskName: event.taskName,
    status,
    ...extras,
  };
}

/** Find the switch step in history and annotate it with the branch taken. */
function mapBranchTakenEvent(
  ctrl: RunControl,
  event: RichWorkflowEvent & { readonly type: "BRANCH_TAKEN" },
): StepState | null {
  for (let i = ctrl.stepHistory.length - 1; i >= 0; i--) {
    if (ctrl.stepHistory[i].taskName === event.switchName) {
      return {
        ...ctrl.stepHistory[i],
        branchTaken: event.branch,
      };
    }
  }
  return null;
}

/** Upsert a step state into the run's step history. */
export function updateStepHistory(ctrl: RunControl, state: StepState): void {
  const idx = ctrl.stepHistory.findIndex(
    (s) => s.taskIndex === state.taskIndex,
  );
  if (idx >= 0) {
    ctrl.stepHistory[idx] = {
      ...ctrl.stepHistory[idx],
      ...state,
    };
  } else {
    ctrl.stepHistory.push(state);
  }
}
