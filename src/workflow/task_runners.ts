/**
 * Individual task executor functions for the workflow engine.
 *
 * Each function handles one task type (call, set, switch, for, raise,
 * emit, wait, run). Extracted from engine.ts to keep file sizes manageable.
 * @module
 */

import type { WorkflowContext } from "./context.ts";
import { createLogger } from "../core/logger/logger.ts";
import { isDispatchError, resolveCallDispatch } from "./dispatch.ts";

const log = createLogger("workflow-task");
import {
  executeRunScript,
  executeRunShell,
  executeRunSubWorkflow,
} from "./run_executors.ts";
import type {
  CallTask,
  EmitTask,
  ForTask,
  RaiseTask,
  RunTask,
  SetTask,
  SwitchTask,
  WaitTask,
  WorkflowEvent,
  WorkflowRunResult,
  WorkflowTaskEntry,
} from "./types.ts";
import type {
  EngineResult,
  ExecuteWorkflowOptions,
  TaskResult,
} from "./engine.ts";

/** Callback signature for executing a sub-workflow without circular imports. */
export type SubWorkflowExecutor = (
  options: ExecuteWorkflowOptions,
) => Promise<EngineResult<WorkflowRunResult>>;

/** Execute a call task — dispatches to a tool via the tool executor. */
export async function executeCallTask(
  taskName: string,
  task: CallTask,
  context: WorkflowContext,
  options: ExecuteWorkflowOptions,
): Promise<EngineResult<TaskResult>> {
  const dispatch = resolveCallDispatch(task, context);
  if (isDispatchError(dispatch)) {
    return { ok: false, error: `Task '${taskName}': ${dispatch.error}` };
  }

  try {
    const resultStr = await options.toolExecutor(
      dispatch.toolName,
      dispatch.input,
    );
    const parsed = parseToolResult(resultStr);
    const newContext = context.set(taskName, parsed);
    return { ok: true, value: { context: newContext } };
  } catch (e: unknown) {
    log.error("Call task execution failed", {
      operation: "executeCallTask",
      task: taskName,
      err: e,
    });
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Task '${taskName}' call failed: ${msg}` };
  }
}

/** Execute a set task — merges key/value pairs into context. */
export function applySetTask(
  task: SetTask,
  context: WorkflowContext,
): Promise<EngineResult<TaskResult>> {
  const newContext = context.merge(task.set);
  return Promise.resolve({ ok: true, value: { context: newContext } });
}

/** Execute a switch task — evaluates cases and stores the matched result. */
export function evaluateSwitchTask(
  task: SwitchTask,
  context: WorkflowContext,
): Promise<EngineResult<TaskResult>> {
  for (const c of task.switch) {
    // A case without `when` is the default case
    if (!c.when || context.evaluateCondition(c.when)) {
      const newContext = context.set("__switchResult", {
        matched: c.name,
        then: c.then,
      });
      return Promise.resolve({ ok: true, value: { context: newContext } });
    }
  }

  // No case matched — continue normally
  return Promise.resolve({ ok: true, value: { context } });
}

/** Execute a for task — iterates over a collection and runs nested tasks. */
export async function executeForTask(
  task: ForTask,
  context: WorkflowContext,
  events: WorkflowEvent[],
  options: ExecuteWorkflowOptions,
  dispatchTask: (
    entry: WorkflowTaskEntry,
    ctx: WorkflowContext,
    evts: WorkflowEvent[],
    opts: ExecuteWorkflowOptions,
  ) => Promise<EngineResult<TaskResult>>,
): Promise<EngineResult<TaskResult>> {
  const collection = context.evaluate(task.for.in);
  if (!Array.isArray(collection)) {
    return {
      ok: false,
      error: `For loop: '${task.for.in}' did not resolve to an array`,
    };
  }

  let currentContext = context;

  for (let i = 0; i < collection.length; i++) {
    currentContext = currentContext.set(task.for.each, collection[i]);
    if (task.for.at) {
      currentContext = currentContext.set(task.for.at, i);
    }

    for (const entry of task.do) {
      if (entry.task.if && !currentContext.evaluateCondition(entry.task.if)) {
        continue;
      }

      const result = await dispatchTask(entry, currentContext, events, options);
      if (!result.ok) return result;
      currentContext = result.value.context;
    }
  }

  return { ok: true, value: { context: currentContext } };
}

/** Execute a raise task — returns a typed error from the workflow. */
export function raiseWorkflowError(
  task: RaiseTask,
): Promise<EngineResult<TaskResult>> {
  const e = task.raise.error;
  return Promise.resolve({
    ok: false,
    error: `Workflow raised error [${e.status} ${e.type}]: ${e.title}${
      e.detail ? ` — ${e.detail}` : ""
    }`,
  });
}

/** Execute an emit task — appends a workflow event. */
export function emitWorkflowEvent(
  task: EmitTask,
  context: WorkflowContext,
  events: WorkflowEvent[],
): Promise<EngineResult<TaskResult>> {
  events.push({
    type: task.emit.event.type,
    source: task.emit.event.source,
    data: task.emit.event.data,
    timestamp: new Date().toISOString(),
  });
  return Promise.resolve({ ok: true, value: { context } });
}

/** Execute a wait task — pauses for the specified duration. */
export async function executeWaitTask(
  task: WaitTask,
  context: WorkflowContext,
): Promise<EngineResult<TaskResult>> {
  const ms = parseDuration(task.wait);
  if (ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
  return { ok: true, value: { context } };
}

/** Execute a run task — dispatches to shell, script, or sub-workflow. */
export function invokeRunTask(
  taskName: string,
  task: RunTask,
  context: WorkflowContext,
  options: ExecuteWorkflowOptions,
  subWorkflowExecutor: SubWorkflowExecutor,
): Promise<EngineResult<TaskResult>> {
  if ("shell" in task.run) {
    if (options.allowShellExecution === false) {
      return Promise.resolve({
        ok: false,
        error:
          `Task '${taskName}': shell execution not permitted in this session`,
      });
    }
    return executeRunShell(taskName, task.run.shell, context, options);
  }
  if ("script" in task.run) {
    if (options.allowShellExecution === false) {
      return Promise.resolve({
        ok: false,
        error:
          `Task '${taskName}': script execution not permitted in this session`,
      });
    }
    return executeRunScript(taskName, task.run.script, context, options);
  }
  if ("workflow" in task.run) {
    return executeRunSubWorkflow(
      taskName,
      task.run.workflow,
      context,
      options,
      subWorkflowExecutor,
    );
  }
  return Promise.resolve({
    ok: false,
    error: `Task '${taskName}': run target not recognized`,
  });
}

/** Parse ISO 8601 duration to milliseconds. Supports PT<n>S, PT<n>M, PT<n>H. */
export function parseDuration(duration: string): number {
  const match = duration.match(
    /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/,
  );
  if (!match) return 0;

  const hours = parseInt(match[1] ?? "0", 10);
  const minutes = parseInt(match[2] ?? "0", 10);
  const seconds = parseFloat(match[3] ?? "0");

  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

/** Try to parse a tool result string as JSON, fall back to raw string. */
export function parseToolResult(result: string): unknown {
  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
}

// --- Deprecated aliases ---

/** @deprecated Use applySetTask instead */
export const executeSetTask = applySetTask;

/** @deprecated Use evaluateSwitchTask instead */
export const executeSwitchTask = evaluateSwitchTask;

/** @deprecated Use raiseWorkflowError instead */
export const executeRaiseTask = raiseWorkflowError;

/** @deprecated Use emitWorkflowEvent instead */
export const executeEmitTask = emitWorkflowEvent;

/** @deprecated Use invokeRunTask instead */
export const executeRunTask = invokeRunTask;
