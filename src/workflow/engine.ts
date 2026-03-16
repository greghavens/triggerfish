/**
 * Workflow execution engine — orchestrates task dispatch and flow control.
 *
 * Parses a WorkflowDefinition, walks the task list, dispatches each
 * task through an injected ToolExecutor, and tracks execution state.
 * Individual task executors live in task_runners.ts.
 * Loop helpers (signal checks, ceiling, dispatch) live in engine_loop.ts.
 * @module
 */

import type { ClassificationLevel } from "../core/types/classification.ts";
import { createLogger } from "../core/logger/logger.ts";
import { createWorkflowContext, type WorkflowContext } from "./context.ts";
import {
  applyInputTransform,
  applyOutputTransform,
  filterInternalKeys,
  findTaskIndex,
  resolveSwitchOrTaskFlow,
} from "./helpers.ts";
import type {
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowRunResult,
  WorkflowStatus,
} from "./types.ts";
import type { RuntimeDeviation } from "./healing/types.ts";
import type { ScopedPauseController } from "./healing/scoped_pause.ts";
import type { StepEventCallback } from "./engine_events.ts";
import {
  emitCompleteEvent,
  emitFailEvent,
  emitSkipEvent,
  emitStartEvent,
  emitTerminalEvent,
} from "./engine_events.ts";
import {
  detectAbortSignal,
  dispatchTask,
  enforceClassificationCeiling,
  isWorkflowCancelled,
} from "./engine_loop.ts";

export {
  checkCeiling,
  checkSignalAborted,
  detectAbortSignal,
  dispatchTask,
  enforceClassificationCeiling,
  isWorkflowCancelled,
} from "./engine_loop.ts";

const log = createLogger("workflow-engine");

/** Maximum sub-workflow recursion depth. */
const MAX_RECURSION_DEPTH = 5;

/** Tool executor function signature (matches existing ToolExecutor). */
export type WorkflowToolExecutor = (
  name: string,
  input: Record<string, unknown>,
) => Promise<string>;

/** Options for executing a workflow. */
export interface ExecuteWorkflowOptions {
  /** Parsed workflow definition. */
  readonly definition: WorkflowDefinition;
  /** Initial input data for the workflow context. */
  readonly input?: Readonly<Record<string, unknown>>;
  /** Tool executor for dispatching call/run tasks. */
  readonly toolExecutor: WorkflowToolExecutor;
  /** Current session taint level getter. */
  readonly getSessionTaint?: () => ClassificationLevel;
  /** Resolver for sub-workflows by name. */
  readonly resolveSubWorkflow?: (
    name: string,
  ) => Promise<WorkflowDefinition | null>;
  /** Current recursion depth (internal — do not set). */
  readonly depth?: number;
  /** Whether shell/script run tasks are allowed (default: true). */
  readonly allowShellExecution?: boolean;
  /** Abort signal for cancellation from registry. */
  readonly signal?: AbortSignal;
  /** Async pause checkpoint called between tasks. */
  readonly checkPause?: () => Promise<void>;
  /** Callback to report task progress to the registry. */
  readonly onTaskProgress?: (taskIndex: number, taskName: string) => void;
  /** Optional callback for rich step-level event emission (self-healing). */
  readonly onStepEvent?: StepEventCallback;
  /** Optional scoped pause controller (self-healing). */
  readonly scopedPause?: ScopedPauseController;
  /** Optional callback to record runtime deviations (self-healing). */
  readonly recordDeviation?: (deviation: RuntimeDeviation) => void;
}

/** Result type for engine operations. */
export type EngineResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/** Internal result from a single task execution. */
export interface TaskResult {
  readonly context: WorkflowContext;
}

/** Execute a workflow definition to completion. */
export async function executeWorkflow(
  options: ExecuteWorkflowOptions,
): Promise<EngineResult<WorkflowRunResult>> {
  const depth = options.depth ?? 0;
  if (depth >= MAX_RECURSION_DEPTH) {
    return {
      ok: false,
      error:
        `Workflow recursion depth exceeded maximum of ${MAX_RECURSION_DEPTH}`,
    };
  }

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const workflowName = options.definition.document.name;
  const events: WorkflowEvent[] = [];
  const deviations: RuntimeDeviation[] = [];
  let context = createWorkflowContext(
    options.input as Record<string, unknown> | undefined,
  );
  let status: WorkflowStatus = "running";
  let error: string | undefined;
  let failedTaskName: string | undefined;
  let failedTaskIndex: number | undefined;

  const tasks = options.definition.do;
  let taskIndex = 0;

  if (options.recordDeviation) {
    const originalRecord = options.recordDeviation;
    options = {
      ...options,
      recordDeviation: (d) => {
        deviations.push(d);
        originalRecord(d);
      },
    };
  }

  try {
    while (taskIndex < tasks.length && status === "running") {
      const entry = tasks[taskIndex];

      const cancelResult = detectAbortSignal(options.signal);
      if (cancelResult) {
        status = "cancelled";
        error = cancelResult;
        break;
      }

      if (options.checkPause) await options.checkPause();

      if (options.scopedPause?.isTaskBlocked(taskIndex)) {
        if (options.checkPause) await options.checkPause();
      }

      if (options.onTaskProgress) {
        options.onTaskProgress(taskIndex, entry.name);
      }

      const ceilingResult = enforceClassificationCeiling(options);
      if (!ceilingResult.ok) {
        status = "failed";
        error = ceilingResult.error;
        break;
      }

      if (entry.task.if && !context.evaluateCondition(entry.task.if)) {
        emitSkipEvent(
          options.onStepEvent,
          runId,
          workflowName,
          entry,
          taskIndex,
        );
        taskIndex++;
        continue;
      }

      const taintBefore = options.getSessionTaint?.() ?? "PUBLIC";
      emitStartEvent(
        options.onStepEvent,
        runId,
        workflowName,
        entry,
        taskIndex,
        context.data,
        taintBefore,
      );

      context = applyInputTransform(context, entry.task.input);

      const stepStart = Date.now();
      const result = await dispatchTask(
        entry,
        context,
        events,
        options,
        executeWorkflow,
      );
      const stepDuration = Date.now() - stepStart;

      if (!result.ok) {
        emitFailEvent(
          options.onStepEvent,
          runId,
          workflowName,
          entry,
          taskIndex,
          result.error,
          context.data,
        );
        status = "failed";
        error = result.error;
        failedTaskName = entry.name;
        failedTaskIndex = taskIndex;
        break;
      }

      context = result.value.context;
      context = applyOutputTransform(context, entry.task.output, entry.name);

      const taintAfter = options.getSessionTaint?.() ?? "PUBLIC";
      emitCompleteEvent(
        options.onStepEvent,
        runId,
        workflowName,
        entry,
        taskIndex,
        context.resolve(entry.name),
        stepDuration,
        taintAfter,
      );

      const flow = resolveSwitchOrTaskFlow(entry.task, context);
      if (flow === "end") break;
      if (flow !== "continue") {
        const jumpIndex = findTaskIndex(tasks, flow);
        if (jumpIndex === -1) {
          status = "failed";
          error = `Flow directive references unknown task: ${flow}`;
          break;
        }
        taskIndex = jumpIndex;
        continue;
      }

      taskIndex++;
    }

    if (status === "running") status = "completed";
  } catch (e: unknown) {
    if (isWorkflowCancelled(e)) {
      status = "cancelled";
      error = e.message;
    } else {
      status = "failed";
      error = e instanceof Error ? e.message : String(e);
      log.error("Workflow execution threw unexpected error", {
        operation: "executeWorkflow",
        workflow: workflowName,
        err: e,
      });
    }
  }

  emitTerminalEvent(
    options.onStepEvent,
    runId,
    workflowName,
    status,
    error,
    context,
    tasks.length,
    failedTaskName,
    failedTaskIndex,
  );

  const output = filterInternalKeys(context.data);

  return {
    ok: true,
    value: {
      runId,
      workflowName,
      status,
      output,
      events,
      error,
      startedAt,
      completedAt: new Date().toISOString(),
      taskCount: tasks.length,
      classification: options.getSessionTaint?.(),
      runtimeDeviations: deviations.length > 0 ? deviations : undefined,
    },
  };
}
