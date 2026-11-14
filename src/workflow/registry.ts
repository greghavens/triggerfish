/**
 * Workflow run registry — tracks active workflow executions.
 *
 * Provides pause, unpause, and stop signals that the engine checks
 * between task boundaries. The UI and LLM tool share this single
 * control path — no duplicate stop/pause logic.
 *
 * @module
 */

import type { WorkflowStatus } from "./types.ts";
import { createLogger } from "../core/logger/logger.ts";
import type { RichWorkflowEvent } from "./healing/types.ts";
import { WorkflowCancelledError } from "./registry_types.ts";
import type {
  RegistryEvent,
  RegistryListener,
  RunControl,
  WorkflowRunRegistry,
} from "./registry_types.ts";
import {
  emitRegistryEvent,
  emitRichEvent,
  mapRichEventToStepState,
  snapshotRun,
  updateStepHistory,
} from "./registry_steps.ts";

export { WorkflowCancelledError } from "./registry_types.ts";
export type {
  ActiveRunSnapshot,
  CompleteRunOptions,
  RegisterRunOptions,
  RegistryEvent,
  RegistryListener,
  RunControl,
  RunRegistration,
  StepState,
  TaskProgressOptions,
  WorkflowRunRegistry,
} from "./registry_types.ts";

const log = createLogger("workflow-registry");

/** Create a new workflow run registry. */
export function createWorkflowRunRegistry(): WorkflowRunRegistry {
  const runs = new Map<string, RunControl>();
  const listeners = new Set<RegistryListener>();
  const richListeners = new Set<(event: RichWorkflowEvent) => void>();

  const emit = (event: RegistryEvent) => emitRegistryEvent(listeners, event);

  return {
    registerRun(options) {
      const abortController = new AbortController();
      const ctrl: RunControl = {
        runId: options.runId,
        workflowName: options.workflowName,
        abortController,
        startedAt: new Date().toISOString(),
        status: "running",
        currentTaskIndex: 0,
        currentTaskName: "",
        taint: options.taint,
        paused: false,
        pauseResolve: null,
        stepHistory: [],
      };

      runs.set(options.runId, ctrl);

      log.info("Workflow run registered", {
        operation: "registerRun",
        runId: options.runId,
        workflowName: options.workflowName,
      });

      emit({
        type: "run_started",
        runId: options.runId,
        workflowName: options.workflowName,
        status: "running",
        taint: options.taint,
      });

      const checkPause = (): Promise<void> => {
        if (abortController.signal.aborted) {
          return Promise.reject(new WorkflowCancelledError(options.runId));
        }
        if (!ctrl.paused) return Promise.resolve();
        return new Promise<void>((resolve) => {
          ctrl.pauseResolve = resolve;
        });
      };

      return { signal: abortController.signal, checkPause };
    },

    stopRun(runId) {
      const ctrl = runs.get(runId);
      if (!ctrl) {
        log.warn("Workflow stop requested for unknown run", {
          operation: "stopRun",
          runId,
        });
        return false;
      }

      ctrl.abortController.abort();
      ctrl.status = "cancelled";

      if (ctrl.paused && ctrl.pauseResolve) {
        ctrl.paused = false;
        ctrl.pauseResolve();
        ctrl.pauseResolve = null;
      }

      log.info("Workflow run stop signalled", {
        operation: "stopRun",
        runId,
        workflowName: ctrl.workflowName,
      });

      emit({
        type: "run_stopped",
        runId,
        workflowName: ctrl.workflowName,
        status: "cancelled",
        taint: ctrl.taint,
      });

      return true;
    },

    pauseRun(runId) {
      const ctrl = runs.get(runId);
      if (!ctrl || ctrl.paused || ctrl.status !== "running") {
        log.warn("Workflow pause rejected: run not active or already paused", {
          operation: "pauseRun",
          runId,
          found: !!ctrl,
          paused: ctrl?.paused,
          status: ctrl?.status,
        });
        return false;
      }

      ctrl.paused = true;

      log.info("Workflow run pause signalled", {
        operation: "pauseRun",
        runId,
        workflowName: ctrl.workflowName,
      });

      emit({
        type: "run_paused",
        runId,
        workflowName: ctrl.workflowName,
        status: "paused" as WorkflowStatus,
        currentTaskIndex: ctrl.currentTaskIndex,
        currentTaskName: ctrl.currentTaskName,
        taint: ctrl.taint,
      });

      return true;
    },

    unpauseRun(runId) {
      const ctrl = runs.get(runId);
      if (!ctrl || !ctrl.paused) {
        log.warn("Workflow unpause rejected: run not found or not paused", {
          operation: "unpauseRun",
          runId,
          found: !!ctrl,
          paused: ctrl?.paused,
        });
        return false;
      }

      ctrl.paused = false;
      if (ctrl.pauseResolve) {
        ctrl.pauseResolve();
        ctrl.pauseResolve = null;
      }
      ctrl.status = "running";

      log.info("Workflow run unpaused", {
        operation: "unpauseRun",
        runId,
        workflowName: ctrl.workflowName,
      });

      emit({
        type: "run_unpaused",
        runId,
        workflowName: ctrl.workflowName,
        status: "running",
        taint: ctrl.taint,
      });

      return true;
    },

    completeRun(runId, options) {
      const ctrl = runs.get(runId);
      if (!ctrl) return;

      runs.delete(runId);

      log.info("Workflow run completed", {
        operation: "completeRun",
        runId,
        workflowName: ctrl.workflowName,
        status: options.status,
        error: options.error,
      });

      emit({
        type: "run_completed",
        runId,
        workflowName: ctrl.workflowName,
        status: options.status,
        error: options.error,
        taint: ctrl.taint,
      });
    },

    reportTaskProgress(runId, options) {
      const ctrl = runs.get(runId);
      if (!ctrl) return;

      ctrl.currentTaskIndex = options.taskIndex;
      ctrl.currentTaskName = options.taskName;
      if (options.taint) ctrl.taint = options.taint;

      emit({
        type: "task_progress",
        runId,
        workflowName: ctrl.workflowName,
        status: ctrl.paused ? "paused" as WorkflowStatus : ctrl.status,
        currentTaskIndex: options.taskIndex,
        currentTaskName: options.taskName,
        taint: ctrl.taint,
      });
    },

    listActiveRuns() {
      return Array.from(runs.values()).map(snapshotRun);
    },

    getActiveRun(runId) {
      const ctrl = runs.get(runId);
      if (!ctrl) return null;
      return snapshotRun(ctrl);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getRunStepHistory(runId) {
      const ctrl = runs.get(runId);
      if (!ctrl) return [];
      return [...ctrl.stepHistory];
    },

    reportStepEvent(runId, event) {
      const ctrl = runs.get(runId);
      if (!ctrl) return;

      const stepState = mapRichEventToStepState(ctrl, event);
      if (stepState) {
        updateStepHistory(ctrl, stepState);
      }

      emitRichEvent(richListeners, runId, event);
    },

    subscribeRichEvents(listener) {
      richListeners.add(listener);
      return () => {
        richListeners.delete(listener);
      };
    },
  };
}
