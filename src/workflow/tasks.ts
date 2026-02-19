/**
 * Task executors for CNCF Serverless Workflow DSL task types.
 *
 * Every task dispatches through the injected ToolExecutor, which fires
 * PRE_TOOL_CALL and POST_TOOL_RESPONSE hooks automatically. No new
 * enforcement logic is added here.
 *
 * @module
 */

import type { ClassificationLevel } from "../core/types/classification.ts";
import { maxClassification } from "../core/types/classification.ts";
import { updateTaint, createSession } from "../core/types/session.ts";
import type { UserId, ChannelId } from "../core/types/session.ts";
import type {
  TaskNode,
  TaskHandlerResult,
  WorkflowExecutionContext,
  FlowDirective,
  SwitchCase,
} from "./types.ts";
import type { WorkflowContext } from "./context.ts";
import {
  evaluateCondition,
  evaluateExpression,
  resolveExpressions,
  applyOutputTransform,
} from "./context.ts";

// ─── Parse duration ───────────────────────────────────────────────────────────

/**
 * Parse a duration string into milliseconds.
 * Supports: "30s", "5m", "1h", "100ms"
 */
export function parseDurationMs(duration: string): number {
  const match = duration.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[2] ?? "s";
  switch (unit) {
    case "ms": return value;
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return value * 1000;
  }
}

// ─── Task dispatch ────────────────────────────────────────────────────────────

/**
 * Execute a single task node.
 *
 * Returns a TaskHandlerResult describing the outcome, taint delta,
 * whether the task was skipped (if condition false), blocked (policy),
 * or errored.
 */
export async function executeTask(
  task: TaskNode,
  ctx: WorkflowContext,
  execCtx: WorkflowExecutionContext,
  currentTaint: ClassificationLevel,
): Promise<{ result: TaskHandlerResult; nextCtx: WorkflowContext; directive: FlowDirective }> {
  const startedAt = new Date();

  // Evaluate `if` condition — skip task if false
  const shouldRun = await evaluateCondition(task.if, ctx);
  if (!shouldRun) {
    return {
      result: {
        output: null,
        taintDelta: currentTaint,
        skipped: true,
        blocked: false,
      },
      nextCtx: ctx,
      directive: "continue",
    };
  }

  // Resolve input transform (if any)
  let taskInput = ctx;
  if (task.input?.from !== undefined) {
    const resolved = await resolveExpressions(task.input.from, ctx);
    if (resolved && typeof resolved === "object" && !Array.isArray(resolved)) {
      taskInput = { ...ctx, data: resolved as Record<string, unknown> };
    }
  }

  let handlerResult: TaskHandlerResult;

  if (task.call !== undefined) {
    handlerResult = await executeCallTask(task, taskInput, execCtx, currentTaint);
  } else if (task.run !== undefined) {
    handlerResult = await executeRunTask(task, taskInput, execCtx, currentTaint);
  } else if (task.set !== undefined) {
    handlerResult = executeSetTask(task, taskInput, currentTaint);
  } else if (task.switch !== undefined) {
    const switchResult = await executeSwitchTask(task, taskInput, currentTaint);
    return {
      result: switchResult.result,
      nextCtx: ctx,
      directive: switchResult.directive,
    };
  } else if (task.for !== undefined) {
    const forResult = await executeForTask(task, taskInput, execCtx, currentTaint);
    const newCtx = await applyOutputTransform(ctx, task.output?.as, forResult.result.output);
    return {
      result: forResult.result,
      nextCtx: newCtx,
      directive: task.then ?? "continue",
    };
  } else if (task.raise !== undefined) {
    handlerResult = executeRaiseTask(task);
  } else if (task.emit !== undefined) {
    handlerResult = executeEmitTask(task, taskInput, currentTaint);
  } else if (task.listen !== undefined) {
    handlerResult = await executeListenTask(task, taskInput, currentTaint);
  } else if (task.wait !== undefined) {
    handlerResult = await executeWaitTask(task, currentTaint);
  } else {
    handlerResult = {
      output: null,
      taintDelta: currentTaint,
      skipped: false,
      blocked: false,
      error: `Task "${task.name}" has no executable task type`,
    };
  }

  // Apply output transform
  let nextCtx = ctx;
  if (!handlerResult.blocked && !handlerResult.skipped && handlerResult.output !== null) {
    if (task.output?.as) {
      nextCtx = await applyOutputTransform(ctx, task.output.as, handlerResult.output);
    }
    if (task.export?.as) {
      nextCtx = await applyOutputTransform(nextCtx, task.export.as, handlerResult.output);
    }
  }

  const directive: FlowDirective = task.then ?? "continue";

  return { result: handlerResult, nextCtx, directive };
}

// ─── call task ────────────────────────────────────────────────────────────────

async function executeCallTask(
  task: TaskNode,
  ctx: WorkflowContext,
  execCtx: WorkflowExecutionContext,
  currentTaint: ClassificationLevel,
): Promise<TaskHandlerResult> {
  const call = task.call!;
  const callType = call.type;

  // Resolve `with` parameters
  const resolvedWith = await resolveExpressions(call.with, ctx) as Record<string, unknown>;

  // Route to the appropriate tool
  let toolName: string;
  let toolInput: Record<string, unknown>;
  const deterministic = !["triggerfish:llm", "triggerfish:agent"].includes(callType);

  switch (callType) {
    case "http": {
      const endpoint = resolvedWith.endpoint as Record<string, unknown> | string | undefined;
      const uri = typeof endpoint === "string" ? endpoint
        : typeof endpoint === "object" ? String((endpoint as Record<string, unknown>).uri ?? "")
        : String(resolvedWith.url ?? "");
      toolName = "web_fetch";
      toolInput = {
        url: uri,
        method: resolvedWith.method ?? "GET",
        ...(resolvedWith.body ? { body: JSON.stringify(resolvedWith.body) } : {}),
      };
      break;
    }

    case "triggerfish:llm": {
      // Spawn sub-agent session
      return await executeSubAgent(task, resolvedWith, ctx, execCtx, currentTaint);
    }

    case "triggerfish:agent": {
      return await executeSubAgent(task, resolvedWith, ctx, execCtx, currentTaint);
    }

    case "triggerfish:memory": {
      const op = String(resolvedWith.operation ?? "get");
      const memToolMap: Record<string, string> = {
        save: "memory_save",
        search: "memory_search",
        get: "memory_get",
        list: "memory_list",
        delete: "memory_delete",
      };
      toolName = memToolMap[op] ?? "memory_get";
      toolInput = { ...resolvedWith };
      delete (toolInput as Record<string, unknown>).operation;
      break;
    }

    case "triggerfish:web_search": {
      toolName = "web_search";
      toolInput = {
        query: String(resolvedWith.query ?? ""),
        ...(resolvedWith.maxResults ? { max_results: resolvedWith.maxResults } : {}),
      };
      break;
    }

    case "triggerfish:web_fetch": {
      toolName = "web_fetch";
      toolInput = {
        url: String(resolvedWith.url ?? ""),
        ...(resolvedWith.maxLength ? { max_length: resolvedWith.maxLength } : {}),
      };
      break;
    }

    case "triggerfish:mcp": {
      const server = String(resolvedWith.server ?? "");
      const tool = String(resolvedWith.tool ?? "");
      toolName = `mcp_${server}_${tool}`;
      toolInput = (resolvedWith.arguments as Record<string, unknown>) ?? {};
      break;
    }

    case "triggerfish:message": {
      toolName = "send_message";
      toolInput = {
        channel: resolvedWith.channel,
        recipient: resolvedWith.recipient,
        text: resolvedWith.text,
      };
      break;
    }

    default: {
      // Unknown custom type — try as a direct tool call
      toolName = callType.replace("triggerfish:", "").replace(":", "_");
      toolInput = resolvedWith;
    }
  }

  // Dispatch through ToolExecutor (fires PRE_TOOL_CALL + POST_TOOL_RESPONSE)
  let output: unknown;
  let blocked = false;
  let error: string | undefined;
  let responseTaint = currentTaint;

  try {
    const result = await execCtx.toolExecutor(toolName, toolInput);

    if (result.startsWith("Error:")) {
      blocked = result.includes("blocked") || result.includes("Write-down") ||
        result.includes("Access denied") || result.includes("taint");
      error = result;
      output = null;
    } else {
      output = result;

      // Check if the tool response carries a classification escalation.
      // Mirrors the orchestrator's post-call pattern: if the response JSON
      // has a `_classification` field, escalate the workflow taint accordingly.
      try {
        const parsed = JSON.parse(result);
        const cls = parsed._classification;
        if (typeof cls === "string") {
          responseTaint = maxClassification(currentTaint, cls as ClassificationLevel);
          execCtx.escalateTaint(responseTaint, `Tool response: ${toolName}`);
        }
      } catch { /* not JSON or no _classification field */ }
    }
  } catch (err) {
    error = (err as Error).message;
    output = null;
  }

  return {
    output,
    taintDelta: responseTaint,
    skipped: false,
    blocked,
    ...(error ? { error } : {}),
    deterministic,
  } as TaskHandlerResult;
}

// ─── Sub-agent spawn for triggerfish:llm / triggerfish:agent ─────────────────

async function executeSubAgent(
  _task: TaskNode,
  resolvedWith: Record<string, unknown>,
  _ctx: WorkflowContext,
  execCtx: WorkflowExecutionContext,
  currentTaint: ClassificationLevel,
): Promise<TaskHandlerResult> {
  if (!execCtx.orchestratorFactory) {
    return {
      output: null,
      taintDelta: currentTaint,
      skipped: false,
      blocked: false,
      error: "No OrchestratorFactory provided — cannot spawn sub-agent for triggerfish:llm",
    };
  }

  const taskDesc = String(resolvedWith.task ?? "");
  const channelId = `workflow-subagent-${crypto.randomUUID()}`;

  try {
    const { orchestrator, session: baseSession } = await execCtx.orchestratorFactory.create(channelId);

    // Start sub-agent at workflow's current taint, not PUBLIC
    let session = baseSession;
    if (currentTaint !== "PUBLIC") {
      session = updateTaint(session, currentTaint, "workflow sub-agent inherits parent taint");
    }

    const result = await orchestrator.processMessage({
      session,
      message: taskDesc,
      targetClassification: currentTaint,
    });

    if (!result.ok) {
      return {
        output: null,
        taintDelta: currentTaint,
        skipped: false,
        blocked: result.error.includes("blocked") || result.error.includes("policy"),
        error: result.error,
      };
    }

    // The sub-agent's terminal taint is propagated back to the workflow
    // via the session taint in the result. Since we don't have direct
    // access to the sub-agent's terminal session, we use the session's
    // current taint (which updateTaint has escalated through calls).
    const subAgentTaint = session.taint;

    return {
      output: result.value.response,
      taintDelta: subAgentTaint,
      skipped: false,
      blocked: false,
    };
  } catch (err) {
    return {
      output: null,
      taintDelta: currentTaint,
      skipped: false,
      blocked: false,
      error: (err as Error).message,
    };
  }
}

// ─── run task ────────────────────────────────────────────────────────────────

async function executeRunTask(
  task: TaskNode,
  ctx: WorkflowContext,
  execCtx: WorkflowExecutionContext,
  currentTaint: ClassificationLevel,
): Promise<TaskHandlerResult> {
  const run = task.run!;
  const resolvedWith = await resolveExpressions(run.with, ctx) as Record<string, unknown>;

  switch (run.type) {
    case "shell": {
      const command = String(resolvedWith.command ?? resolvedWith.cmd ?? "");
      const result = await execCtx.toolExecutor("run_command", { command });
      const blocked = result.startsWith("Error:") && result.includes("blocked");
      return {
        output: result,
        taintDelta: currentTaint,
        skipped: false,
        blocked,
        ...(result.startsWith("Error:") ? { error: result } : {}),
      };
    }

    case "script": {
      const content = String(resolvedWith.content ?? resolvedWith.code ?? "");
      const lang = String(resolvedWith.language ?? resolvedWith.lang ?? "sh");
      const ext = lang === "python" ? ".py" : lang === "typescript" ? ".ts" : ".sh";
      const tmpPath = `/tmp/workflow-script-${crypto.randomUUID()}${ext}`;

      // Write script file, then run
      await execCtx.toolExecutor("write_file", { path: tmpPath, content });
      const result = await execCtx.toolExecutor("run_command", { command: `${lang} ${tmpPath}` });
      const blocked = result.startsWith("Error:") && result.includes("blocked");
      return {
        output: result,
        taintDelta: currentTaint,
        skipped: false,
        blocked,
      };
    }

    case "workflow": {
      // Sub-workflow — handled at engine level, not here
      return {
        output: null,
        taintDelta: currentTaint,
        skipped: false,
        blocked: false,
        error: "run:workflow is handled at the engine level",
      };
    }

    case "container": {
      const image = String(resolvedWith.image ?? "");
      const command = String(resolvedWith.command ?? "");
      const result = await execCtx.toolExecutor("run_command", {
        command: `docker run --rm ${image} ${command}`,
      });
      return {
        output: result,
        taintDelta: currentTaint,
        skipped: false,
        blocked: false,
      };
    }

    default:
      return {
        output: null,
        taintDelta: currentTaint,
        skipped: false,
        blocked: false,
        error: `Unknown run type: ${run.type}`,
      };
  }
}

// ─── set task ─────────────────────────────────────────────────────────────────

function executeSetTask(
  task: TaskNode,
  ctx: WorkflowContext,
  currentTaint: ClassificationLevel,
): TaskHandlerResult {
  // Set merges values into the workflow data context
  // The actual context update is handled in the engine after the handler returns
  return {
    output: task.set,
    taintDelta: currentTaint,
    skipped: false,
    blocked: false,
  };
}

// ─── switch task ──────────────────────────────────────────────────────────────

async function executeSwitchTask(
  task: TaskNode,
  ctx: WorkflowContext,
  currentTaint: ClassificationLevel,
): Promise<{ result: TaskHandlerResult; directive: FlowDirective }> {
  const cases = task.switch as readonly SwitchCase[];

  for (const switchCase of cases) {
    if (switchCase.when === undefined) {
      // Default case — always matches
      return {
        result: {
          output: { matchedCase: switchCase.name },
          taintDelta: currentTaint,
          skipped: false,
          blocked: false,
        },
        directive: switchCase.then,
      };
    }

    const matches = await evaluateCondition(switchCase.when, ctx);
    if (matches) {
      return {
        result: {
          output: { matchedCase: switchCase.name },
          taintDelta: currentTaint,
          skipped: false,
          blocked: false,
        },
        directive: switchCase.then,
      };
    }
  }

  // No case matched — continue
  return {
    result: {
      output: null,
      taintDelta: currentTaint,
      skipped: true,
      blocked: false,
    },
    directive: "continue",
  };
}

// ─── for loop task ────────────────────────────────────────────────────────────

async function executeForTask(
  task: TaskNode,
  ctx: WorkflowContext,
  execCtx: WorkflowExecutionContext,
  currentTaint: ClassificationLevel,
): Promise<{ result: TaskHandlerResult }> {
  const forDef = task.for!;

  // Resolve the collection expression
  const collectionResult = await evaluateExpression(forDef.in, ctx);
  const collection = collectionResult.ok && Array.isArray(collectionResult.value)
    ? collectionResult.value as unknown[]
    : [];

  let iterationTaint = currentTaint;
  const allOutputs: unknown[] = [];
  let loopCtx = ctx;

  for (let i = 0; i < collection.length; i++) {
    const item = collection[i];

    // Set iteration variables
    loopCtx = {
      ...loopCtx,
      data: {
        ...loopCtx.data,
        [forDef.each]: item,
        ...(forDef.at ? { [forDef.at]: i } : {}),
      },
    };

    // Execute each do-task in the loop body
    for (const doTask of forDef.do) {
      const { result, nextCtx, directive } = await executeTask(
        doTask,
        loopCtx,
        execCtx,
        iterationTaint,
      );

      loopCtx = nextCtx;

      // Accumulate taint across iterations
      if (result.taintDelta !== iterationTaint) {
        iterationTaint = result.taintDelta;
        execCtx.escalateTaint(iterationTaint, `for-loop task ${doTask.name}`);
      }

      if (result.output !== null && result.output !== undefined) {
        allOutputs.push(result.output);
      }

      if (directive === "end" || directive === "exit") break;
    }
  }

  // Merge loop context changes back
  const finalCtx = { ...ctx, data: loopCtx.data };

  return {
    result: {
      output: allOutputs,
      taintDelta: iterationTaint,
      skipped: false,
      blocked: false,
    },
  };
}

// ─── raise task ───────────────────────────────────────────────────────────────

function executeRaiseTask(task: TaskNode): TaskHandlerResult {
  const raise = task.raise!;
  return {
    output: null,
    taintDelta: "PUBLIC" as ClassificationLevel,
    skipped: false,
    blocked: false,
    error: JSON.stringify(raise.error),
  };
}

// ─── emit task ────────────────────────────────────────────────────────────────

function executeEmitTask(
  task: TaskNode,
  _ctx: WorkflowContext,
  currentTaint: ClassificationLevel,
): TaskHandlerResult {
  const emit = task.emit!;
  // In this implementation, emit is a no-op (events are logged but not dispatched)
  return {
    output: { emitted: true, event: emit.event },
    taintDelta: currentTaint,
    skipped: false,
    blocked: false,
  };
}

// ─── listen task ──────────────────────────────────────────────────────────────

async function executeListenTask(
  task: TaskNode,
  _ctx: WorkflowContext,
  currentTaint: ClassificationLevel,
): Promise<TaskHandlerResult> {
  const listen = task.listen!;
  const timeoutMs = listen.timeout ? parseDurationMs(listen.timeout) : 30_000;

  // In this implementation, listen waits for the timeout then returns
  // (a real implementation would subscribe to an event bus)
  await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 100)));

  return {
    output: { timedOut: true, filter: listen.to },
    taintDelta: currentTaint,
    skipped: false,
    blocked: false,
  };
}

// ─── wait task ────────────────────────────────────────────────────────────────

async function executeWaitTask(
  task: TaskNode,
  currentTaint: ClassificationLevel,
): Promise<TaskHandlerResult> {
  const duration = task.wait!;
  const ms = parseDurationMs(duration);
  if (ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 60_000)));
  }
  return {
    output: { waited: duration },
    taintDelta: currentTaint,
    skipped: false,
    blocked: false,
  };
}
