/**
 * Tool call dispatch pipeline.
 *
 * Orchestrates plan mode tool blocking, security context evaluation,
 * taint escalation, policy hook enforcement, and batched execution
 * of tool calls during agent iterations.
 *
 * @module
 */

import type { Result } from "../../core/types/classification.ts";
import type { SessionState } from "../../core/types/session.ts";
import type {
  OrchestratorConfig,
  ParsedToolCall,
} from "../orchestrator/orchestrator_types.ts";
import type { OrchestratorState } from "../orchestrator/orchestrator.ts";
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

/** Dispatch a single tool call (plan mode + security). */
async function dispatchSingleToolCall(
  call: ParsedToolCall,
  orchestratorState: OrchestratorState,
  config: OrchestratorConfig,
  session: SessionState,
  sessionKey: string,
): Promise<{ resultText: string; blocked: boolean }> {
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
    return {
      resultText: readMoreFromCache(
        orchestratorState.responseCache,
        cacheId,
        offset,
      ),
      blocked: false,
    };
  }

  if (orchestratorState.planManager) {
    const planResult = await invokePlanModeToolCall(
      orchestratorState.planManager,
      sessionKey,
      call,
    );
    if (planResult.resultText !== undefined) {
      return { resultText: planResult.resultText, blocked: planResult.blocked };
    }
  }

  return dispatchSecurityEnforcedToolCall(
    call,
    config,
    session,
    orchestratorState.toolExecutor!,
  );
}

/** Result of formatting a single tool call execution. */
interface FormattedToolCallResult {
  readonly text: string;
  readonly bumpersBlocked: boolean;
}

/** Execute a single tool call with event emission and format the result. */
async function executeAndFormatToolCall(
  call: ParsedToolCall,
  orchestratorState: OrchestratorState,
  session: SessionState,
  sessionKey: string,
): Promise<FormattedToolCallResult> {
  orchestratorState.emit({
    type: "tool_call",
    name: call.name,
    args: call.args,
  });
  const { resultText, blocked } = await dispatchSingleToolCall(
    call,
    orchestratorState,
    orchestratorState.config,
    session,
    sessionKey,
  );
  const cappedText = (blocked || call.name === "read_more")
    ? resultText
    : capToolResponse(
      call.name,
      resultText,
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

  await recordToolCallLineageAndPersist(
    call,
    resultText,
    blocked,
    orchestratorState.config,
    session,
    sessionKey,
  );

  return {
    text: `[TOOL_RESULT name="${call.name}"]\n${cappedText}\n[/TOOL_RESULT]`,
    bumpersBlocked,
  };
}

/** Result of processing a batch of tool calls. */
export interface ToolCallBatchResult {
  readonly resultParts: readonly string[];
  readonly bumpersBlocked: boolean;
}

/** Process all tool calls for one iteration and return result parts. */
export async function orchestrateToolCallBatch(
  parsedCalls: readonly ParsedToolCall[],
  orchestratorState: OrchestratorState,
  session: SessionState,
  sessionKey: string,
  signal: AbortSignal | undefined,
): Promise<Result<ToolCallBatchResult, string>> {
  const resultParts: string[] = [];
  let bumpersBlocked = false;
  for (const call of parsedCalls) {
    if (signal?.aborted) {
      return { ok: false, error: "Operation cancelled by user" };
    }
    const result = await executeAndFormatToolCall(
      call,
      orchestratorState,
      session,
      sessionKey,
    );
    resultParts.push(result.text);
    if (result.bumpersBlocked) bumpersBlocked = true;
  }
  return { ok: true, value: { resultParts, bumpersBlocked } };
}

/** @deprecated Use orchestrateToolCallBatch instead */
export const processToolCallBatch = orchestrateToolCallBatch;
