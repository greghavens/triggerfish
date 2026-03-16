/**
 * Trigger prompt helpers for chat sessions.
 *
 * Formats trigger results, handles classification checks (write-down
 * reset, write-up escalation), and injects trigger output into the
 * chat session.
 *
 * @module
 */

import { createLogger } from "../core/logger/mod.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import { canFlowTo } from "../core/types/classification.ts";
import type { SessionState } from "../core/types/session.ts";
import type { Orchestrator } from "../agent/orchestrator/orchestrator.ts";
import type { TriggerResult } from "../scheduler/triggers/store.ts";
import type { ChatEventSender, ChatSessionConfig } from "./chat_types.ts";
import type { ChatSessionMutableState } from "./chat_turn_execution.ts";
import { orchestrateOwnerAgentTurn } from "./chat_turn_execution.ts";

const chatLog = createLogger("chat");

/** Format a trigger result for injection into conversation context. */
export function formatTriggerOutput(result: TriggerResult): string {
  const firedAt = result.firedAt
    ? new Date(result.firedAt).toLocaleString()
    : "unknown time";

  return (
    `[Trigger output loaded into context]\n` +
    `Source: ${result.source}\n` +
    `Classification: ${result.classification}\n` +
    `Fired at: ${firedAt}\n\n` +
    result.message
  );
}

/** Options for accepting a trigger result into the chat session. */
export interface AcceptTriggerOptions {
  readonly source: string;
  readonly config: ChatSessionConfig;
  readonly state: ChatSessionMutableState;
  readonly orchestrator: Orchestrator;
  readonly getSession: () => SessionState;
  readonly ownerTargetClassification: ClassificationLevel;
  readonly sendEvent: ChatEventSender;
}

/** Handle write-down case: reset session and broadcast taint change. */
function resetSessionForWriteDown(
  config: ChatSessionConfig,
  orchestrator: Orchestrator,
  getSession: () => SessionState,
  source: string,
  currentTaint: ClassificationLevel,
  triggerClassification: ClassificationLevel,
): void {
  chatLog.warn("Trigger prompt accepted with session reset (write-down)", {
    operation: "acceptTriggerResult",
    source,
    sessionTaint: currentTaint,
    triggerClassification,
  });
  orchestrator.clearHistory(getSession().id);
  if (config.resetSession) config.resetSession();
  if (config.broadcastChatEvent) {
    config.broadcastChatEvent({
      type: "taint_changed",
      level: "PUBLIC" as ClassificationLevel,
    });
  }
}

/** Fetch, classify, and inject a trigger result into the chat session. */
export async function acceptTriggerResult(
  opts: AcceptTriggerOptions,
): Promise<void> {
  const { source, config, state, orchestrator, getSession, sendEvent } = opts;
  if (!config.triggerStore) {
    sendEvent({ type: "error", message: "Trigger store not available" });
    return;
  }

  try {
    const result = await config.triggerStore.getLast(source);
    if (!result) {
      sendEvent({
        type: "error",
        message: `Trigger result not found for source: ${source}`,
      });
      return;
    }

    const currentTaint = config.getSessionTaint?.() ??
      "PUBLIC" as ClassificationLevel;

    if (!canFlowTo(currentTaint, result.classification)) {
      resetSessionForWriteDown(
        config,
        orchestrator,
        getSession,
        source,
        currentTaint,
        result.classification,
      );
    } else if (!canFlowTo(result.classification, currentTaint)) {
      chatLog.warn("Trigger prompt escalating session taint", {
        operation: "acceptTriggerResult",
        source,
        from: currentTaint,
        to: result.classification,
      });
      config.escalateTaint?.(
        result.classification,
        `trigger prompt: ${source}`,
      );
    }

    const formatted = formatTriggerOutput(result);
    await orchestrateOwnerAgentTurn(
      state,
      orchestrator,
      getSession,
      formatted,
      opts.ownerTargetClassification,
      sendEvent,
    );
  } catch (err: unknown) {
    chatLog.error("Trigger prompt accept failed", {
      operation: "acceptTriggerResult",
      source,
      err,
    });
    sendEvent({
      type: "error",
      message: `Trigger load failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}
