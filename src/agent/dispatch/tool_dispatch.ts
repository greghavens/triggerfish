import type { WorkerBoundary } from "../../core/types/orchestrator.ts";
/**
 * Tool call dispatch pipeline.
 *
 * Orchestrates plan mode tool blocking, security context evaluation,
 * taint escalation, policy hook enforcement, and batched execution
 * of tool calls during agent iterations.
 *
 * @module
 */

import {
  maxClassification,
  type Result,
} from "../../core/types/classification.ts";
import type { SessionState } from "../../core/types/session.ts";
import type {
  RecoveryToolPersistence,
  ToolDispatchOutcome,
} from "../../core/types/orchestrator.ts";
import type {
  OrchestratorConfig,
  ParsedToolCall,
  ToolExecutor,
} from "../orchestrator/orchestrator_types.ts";
import type { OrchestratorState } from "../orchestrator/orchestrator.ts";
import { buildPlanToolDefinitions } from "../plan/tools.ts";
import { capToolResponse, readMoreFromCache } from "./response_cap.ts";
import {
  dispatchSecurityEnforcedToolCall,
  invokePlanModeToolCall,
} from "./security_pipeline.ts";
import {
  determineSourceType,
  recordToolCallLineageAndPersist,
} from "./tool_lineage.ts";
import { BUMPER_BLOCK_MESSAGE } from "../../core/session/bumpers.ts";
import { wrapToolExecutorWithEnforcement } from "./access_control.ts";

/**
 * Canned response emitted to the user when bumpers block a tool call.
 *
 * The turn is force-ended so the LLM never sees the block result and
 * cannot silently retry with a different tool. This message is injected
 * into history as an assistant message and emitted as the response event.
 */
export const BUMPERS_BLOCK_USER_RESPONSE =
  "That action was blocked by **bumpers** — it would access resources " +
  "above your current session classification level.\n\n" +
  "Run `/bumpers` to disable bumpers and allow taint escalation, " +
  "then try again.";

// Re-export for consumers that import from this file
export { determineSourceType, recordToolCallLineageAndPersist };

const planToolNames = new Set(
  buildPlanToolDefinitions().map(({ name }) => name),
);

/** Dispatch a single tool call (plan mode + security). */
async function dispatchSingleToolCall(
  call: ParsedToolCall,
  orchestratorState: OrchestratorState,
  config: OrchestratorConfig,
  session: SessionState,
  sessionKey: string,
  projectedAuditArgs?: Record<string, unknown>,
  signal?: AbortSignal,
  beforeAuthorizedDispatch?: (approvedRuleId?: string) => void,
): Promise<{ resultText: string; blocked: boolean }> {
  const execute = (executor: ToolExecutor) =>
    dispatchSecurityEnforcedToolCall(
      call,
      config,
      session,
      executor,
      projectedAuditArgs,
      signal,
      sessionKey,
      beforeAuthorizedDispatch,
    );
  if (call.name === "read_more") {
    const cacheId = typeof call.args.cache_id === "string"
      ? call.args.cache_id
      : undefined;
    const offset = typeof call.args.offset === "number"
      ? call.args.offset
      : undefined;
    if (!cacheId) {
      return { resultText: "Error: cache_id is required", blocked: false };
    }
    return execute(() =>
      Promise.resolve(
        readMoreFromCache(orchestratorState.responseCache, cacheId, offset),
      )
    );
  }

  const planManager = orchestratorState.planManager;
  if (planManager?.isToolBlocked(sessionKey, call.name, call.args)) {
    const denied = await invokePlanModeToolCall(planManager, sessionKey, call);
    return {
      resultText: denied.resultText ?? "Error: Tool blocked in plan mode.",
      blocked: true,
    };
  }
  if (planManager && planToolNames.has(call.name)) {
    return execute(async () => {
      const result = await invokePlanModeToolCall(
        planManager,
        sessionKey,
        call,
      );
      return result.resultText ?? "Error: Plan tool unavailable.";
    });
  }

  return execute(
    projectedAuditArgs && config.toolExecutor
      ? wrapToolExecutorWithEnforcement(config.toolExecutor, config, true)
      : orchestratorState.toolExecutor!,
  );
}

/** Result of formatting a single tool call execution. */
interface FormattedToolCallResult {
  readonly text: string;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly bumpersBlocked: boolean;
}

/**
 * Build a short, model-actionable error response for a tool call whose
 * arguments were not valid JSON. Returned in place of invoking the tool so
 * the model can correct the JSON on its next turn instead of silently
 * receiving the result of a call with empty args.
 */
function buildMalformedArgsResponse(call: ParsedToolCall): string {
  const rawPreview = call.rawArgs && call.rawArgs.length > 0
    ? call.rawArgs.length > 200
      ? call.rawArgs.slice(0, 200) + "…"
      : call.rawArgs
    : "(empty)";
  return `Error: tool call for "${call.name}" had malformed JSON arguments — ${call.argsParseError}. Received: ${rawPreview}. Retry the call with a valid JSON object as the arguments field.`;
}

/** Execute a single tool call with event emission and format the result. */
async function executeAndFormatToolCall(
  call: ParsedToolCall,
  orchestratorState: OrchestratorState,
  session: SessionState,
  sessionKey: string,
  persistence?: RecoveryToolPersistence,
  signal?: AbortSignal,
  trace?: (entry: ToolDispatchOutcome) => void,
): Promise<FormattedToolCallResult> {
  function traceOutcome(
    outcome: ToolDispatchOutcome["outcome"],
    payload?: () => ToolDispatchOutcome["approvedPayload"],
  ) {
    if (!trace) return;
    const config = orchestratorState.config;
    const registered = config.tools?.some(({ name }) => name === call.name) ||
      call.name === "read_more" ||
      (orchestratorState.planManager && planToolNames.has(call.name));
    try {
      let classification = config.getSessionTaint?.() ?? session.taint;
      if (registered) {
        const floor = config.toolFloorRegistry?.getFloor(call.name);
        if (floor) classification = maxClassification(classification, floor);
        for (
          const levels of [
            config.toolClassifications,
            config.integrationClassifications,
          ]
        ) {
          for (const [prefix, level] of levels ?? []) {
            if (call.name.startsWith(prefix)) {
              classification = maxClassification(classification, level);
            }
          }
        }
      }
      const approvedPayload = registered ? payload?.() : undefined;
      trace({
        ...(approvedPayload && { approvedPayload }),
        tool: registered ? call.name : "unregistered_tool",
        classification,
        outcome,
      });
    } catch {
      // Trace storage must not change or replay a completed tool call.
    }
  }
  const offered = persistence
    ? {
      name: call.name,
      ...(call.id !== undefined && { id: call.id }),
      args: structuredClone(call.args),
      ...(call.argsParseError && { malformed: true as const }),
    }
    : call;
  const safeArgs = persistence ? persistence.projectCall(offered) : call.args;
  orchestratorState.emit({
    type: "tool_call",
    name: call.name,
    args: safeArgs ?? {},
  });
  if (call.argsParseError) {
    traceOutcome("failed");
    const errorText = persistence
      ? "Error: Malformed tool arguments."
      : buildMalformedArgsResponse(call);
    orchestratorState.emit({
      type: "tool_result",
      name: call.name,
      result: errorText,
      blocked: false,
    });
    return {
      text: errorText,
      toolName: call.name,
      ...(call.id ? { toolCallId: call.id } : {}),
      bumpersBlocked: false,
    };
  }
  const { resultText, blocked } = await dispatchSingleToolCall(
    call,
    orchestratorState,
    orchestratorState.config,
    session,
    sessionKey,
    persistence ? safeArgs ?? {} : undefined,
    signal,
    persistence?.beforeAuthorizedDispatch &&
      ((ruleId) => persistence.beforeAuthorizedDispatch!(offered, ruleId)),
  ).catch((error: unknown) => {
    traceOutcome("failed");
    throw error;
  });
  const projected = persistence
    ? safeArgs &&
      persistence.projectResult(offered, { text: resultText, blocked })
    : resultText;
  traceOutcome(
    blocked || projected === undefined
      ? "blocked"
      : resultText.startsWith("Error:")
      ? "failed"
      : "returned",
    !blocked && projected !== undefined && !resultText.startsWith("Error:")
      ? () => persistence?.projectTracePayload?.(offered, projected)
      : undefined,
  );
  const visibleText = projected ?? "Tool result withheld by the output policy.";
  const cappedText = (blocked || call.name === "read_more")
    ? visibleText
    : capToolResponse(
      call.name,
      visibleText,
      orchestratorState.responseCache,
      orchestratorState.config.maxToolResponseChars,
    );
  const bumpersBlocked = blocked && resultText === BUMPER_BLOCK_MESSAGE;
  orchestratorState.emit({
    type: "tool_result",
    name: call.name,
    result: cappedText,
    blocked,
  });

  if (safeArgs && projected !== undefined) {
    await recordToolCallLineageAndPersist(
      persistence ? { ...call, args: safeArgs } : call,
      projected,
      blocked,
      orchestratorState.config,
      session,
      sessionKey,
    );
  }

  return {
    text: cappedText,
    toolName: call.name,
    ...(call.id ? { toolCallId: call.id } : {}),
    bumpersBlocked,
  };
}

/** A single tool result, ready to be appended to history. */
export interface ToolCallResult {
  /** The tool name (used for human-readable framing when no ID exists). */
  readonly toolName: string;
  /** OpenAI tool_call_id. Undefined when the provider didn't emit IDs. */
  readonly toolCallId?: string;
  /** Capped result content. */
  readonly content: string;
}

/** Result of processing a batch of tool calls. */
export interface ToolCallBatchResult {
  readonly results: readonly ToolCallResult[];
  readonly bumpersBlocked: boolean;
}

/** Process all tool calls for one iteration and return per-call results. */
export async function orchestrateToolCallBatch(
  parsedCalls: readonly ParsedToolCall[],
  orchestratorState: OrchestratorState,
  session: SessionState,
  sessionKey: string,
  signal: AbortSignal | undefined,
  persistence?: RecoveryToolPersistence,
  workerBoundary?: WorkerBoundary,
  trace?: (entry: ToolDispatchOutcome) => void,
): Promise<Result<ToolCallBatchResult, string>> {
  const results: ToolCallResult[] = [];
  let bumpersBlocked = false;
  for (const call of parsedCalls) {
    if (signal?.aborted) {
      return { ok: false, error: "Operation cancelled by user" };
    }
    if (workerBoundary) {
      try {
        if ((await workerBoundary("before_tool")).stop || signal?.aborted) {
          return { ok: false, error: "The worker was stopped" };
        }
      } catch {
        return { ok: false, error: "The worker was stopped" };
      }
    }
    const formatted = await executeAndFormatToolCall(
      call,
      orchestratorState,
      session,
      sessionKey,
      persistence,
      signal,
      trace,
    );
    results.push({
      toolName: formatted.toolName,
      ...(formatted.toolCallId ? { toolCallId: formatted.toolCallId } : {}),
      content: formatted.text,
    });
    if (formatted.bumpersBlocked) bumpersBlocked = true;
  }
  return { ok: true, value: { results, bumpersBlocked } };
}

/** @deprecated Use orchestrateToolCallBatch instead */
export const processToolCallBatch = orchestrateToolCallBatch;
