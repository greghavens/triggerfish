/**
 * A2UI chat message dispatch.
 *
 * Parses incoming WebSocket chat messages from Tidepool browser clients
 * and routes them to the appropriate ChatSession method (cancel, clear,
 * secret prompt response, or agent turn execution).
 *
 * @module
 */

import type { ChatClientMessage, ChatSession } from "../../../gateway/chat.ts";
import type { createSentinelSocketMode } from "../../../gateway/sentinel_socket_mode.ts";
import { createSideQuestionSocket } from "../../../gateway/side_question.ts";
import type { MessageContent } from "../../../core/image/content.ts";
import { trySendSocketPayload } from "./host_broadcast.ts";
import { createLogger } from "../../../core/logger/logger.ts";

const log = createLogger("tidepool-chat");

/** Mutable holder so event-listener closures can read/write the current AbortController. */
export interface AbortControllerRef {
  current: AbortController | null;
  side?: ReturnType<typeof createSideQuestionSocket>;
}

/** Context needed to dispatch a client chat message. */
export interface ChatDispatchContext {
  readonly socket: WebSocket;
  readonly chatSession: ChatSession;
  readonly ref: AbortControllerRef;
  readonly sentinelMode?: Pick<
    ReturnType<typeof createSentinelSocketMode>,
    "active" | "handle" | "reset"
  >;
}

/** Parse and dispatch a client chat message (cancel, clear, secret_prompt_response, message). */
export function dispatchClientChatMessage(
  rawData: string | ArrayBuffer,
  ctx: ChatDispatchContext,
): void {
  const text = typeof rawData === "string"
    ? rawData
    : new TextDecoder().decode(rawData as ArrayBuffer);
  const msg = JSON.parse(text) as ChatClientMessage;
  const side = ctx.ref.side ??= createSideQuestionSocket(
    undefined,
    () => undefined,
  );
  if (
    side.handle(
      msg.type === "message" ? msg.content : undefined,
      msg.type === "side_cancel",
      (event) => trySendSocketPayload(ctx.socket, JSON.stringify(event)),
    )
  ) return;

  if (msg.type === "cancel") {
    dispatchCancelMessage(ctx.socket, ctx.ref);
    return;
  }
  if (msg.type === "clear") {
    ctx.ref.current?.abort();
    side.reset();
    ctx.sentinelMode?.reset();
    ctx.chatSession.clear();
    return;
  }
  if (ctx.sentinelMode?.active && msg.type !== "message") {
    if (msg.type === "bumpers" || msg.type === "compact") {
      trySendSocketPayload(
        ctx.socket,
        JSON.stringify({
          type: "error",
          message: "Exit Sentinel mode to use normal chat controls.",
        }),
      );
    }
    return;
  }
  if (msg.type === "secret_prompt_response") {
    log.debug("Dispatching secret prompt response", {
      operation: "dispatchClientChatMessage",
      nonce: msg.nonce,
    });
    ctx.chatSession.handleSecretPromptResponse(msg.nonce, msg.value);
    return;
  }
  if (msg.type === "credential_prompt_response") {
    log.debug("Dispatching credential prompt response", {
      operation: "dispatchClientChatMessage",
      nonce: msg.nonce,
    });
    ctx.chatSession.handleCredentialPromptResponse(
      msg.nonce,
      msg.username,
      msg.password,
    );
    return;
  }
  if (msg.type === "confirm_prompt_response") {
    log.debug("Dispatching confirm prompt response", {
      operation: "dispatchClientChatMessage",
      nonce: msg.nonce,
      approved: msg.approved,
    });
    ctx.chatSession.handleConfirmPromptResponse(msg.nonce, msg.approved);
    return;
  }
  if (msg.type === "trigger_prompt_response") {
    log.debug("Dispatching trigger prompt response", {
      operation: "dispatchClientChatMessage",
      source: msg.source,
      accepted: msg.accepted,
    });
    const send = (evt: unknown) => {
      trySendSocketPayload(ctx.socket, JSON.stringify(evt));
    };
    ctx.chatSession.handleTriggerPromptResponse(msg.source, msg.accepted, send);
    return;
  }
  if (msg.type === "bumpers") {
    const enabled = ctx.chatSession.toggleBumpers();
    trySendSocketPayload(
      ctx.socket,
      JSON.stringify({ type: "bumpers_status", enabled }),
    );
    return;
  }
  if (msg.type === "compact") {
    const send = (evt: unknown) => {
      trySendSocketPayload(ctx.socket, JSON.stringify(evt));
    };
    ctx.chatSession.compact(send).catch((err: unknown) => {
      log.warn("Compact failed in tidepool chat dispatch", {
        operation: "dispatchCompact",
        err,
      });
    });
    return;
  }
  if (msg.type === "message" && isNonEmptyContent(msg.content)) {
    void executeAgentTurnFromSocket(msg.content, ctx);
  }
}

/** Check whether message content is non-empty (string or non-empty array). */
function isNonEmptyContent(content: MessageContent): boolean {
  return (
    typeof content === "string" ||
    (Array.isArray(content) && content.length > 0)
  );
}

/** Handle a cancel message by aborting the current agent turn. */
function dispatchCancelMessage(
  socket: WebSocket,
  ref: AbortControllerRef,
): void {
  if (ref.current) {
    ref.current.abort();
    trySendSocketPayload(socket, JSON.stringify({ type: "cancelled" }));
  }
}

/** Start an agent turn, routing events back through the socket. */
async function executeAgentTurnFromSocket(
  content: MessageContent,
  ctx: ChatDispatchContext,
): Promise<void> {
  if (ctx.ref.current) return;
  const controller = new AbortController();
  ctx.ref.current = controller;
  const { signal } = controller;

  const send = (evt: unknown) => {
    trySendSocketPayload(ctx.socket, JSON.stringify(evt));
  };

  try {
    const handled = await ctx.sentinelMode?.handle(content, send, signal);
    if (!handled && !signal.aborted) {
      await ctx.chatSession.executeAgentTurn(content, send, signal);
    }
  } catch (err) {
    log.warn("Tidepool chat turn failed", { err });
    if (!signal.aborted) send({ type: "error", message: "Chat turn failed" });
  } finally {
    if (ctx.ref.current === controller) ctx.ref.current = null;
    send({ type: "turn_end" });
  }
}
