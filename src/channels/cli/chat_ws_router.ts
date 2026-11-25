/**
 * WebSocket message routing for the CLI chat REPL.
 *
 * Parses incoming daemon events and dispatches them to the screen
 * manager, event handler, or state callbacks as appropriate.
 * @module
 */

import { createLogger } from "../../core/logger/logger.ts";
import type { ChatEvent } from "../../core/types/chat_event.ts";
import type { ApprovalInboxSocketReply } from "../../gateway/approval_inbox_socket.ts";

import type { WsRouterDeps } from "./chat_ws_types.ts";
import type { RouterContext } from "./ws_route_status.ts";
import {
  routeBumpersStatusEvent,
  routeChatHistoryEvent,
  routeConnectedEvent,
  routeMcpStatusEvent,
  routeNotificationEvent,
  routeTaintChangedEvent,
} from "./ws_route_status.ts";
import {
  routeConfirmPromptEvent,
  routeCredentialPromptEvent,
  routeSecretPromptEvent,
  routeTriggerPromptEvent,
} from "./ws_route_prompts.ts";
import {
  forwardOrchestratorEvent,
  routeCancelledEvent,
  routeCompactCompleteEvent,
  routeCompactStartEvent,
  routeErrorEvent,
  routeResponseChunkEvent,
  routeResponseCompleteEvent,
} from "./ws_route_responses.ts";

export type {
  CredentialModeState,
  PasswordModeState,
  TriggerPromptModeState,
  WsRouterDeps,
  WsRouterState,
} from "./chat_ws_types.ts";
export { sendNextQueuedMessage } from "./chat_ws_types.ts";

export type { RouterContext } from "./ws_route_status.ts";

const log = createLogger("cli");

/** Decode a raw WebSocket message payload to a string. */
function decodeWsPayload(data: unknown): string {
  return typeof data === "string"
    ? data
    : new TextDecoder().decode(data as ArrayBuffer);
}

/**
 * Create a WebSocket "message" event handler that routes daemon events
 * to the appropriate screen/state callbacks.
 *
 * @returns An EventListener suitable for `ws.addEventListener("message", ...)`.
 */
export function createWsMessageRouter(
  deps: WsRouterDeps,
): (event: MessageEvent) => void {
  const { screen, isTty, eventHandler, state, resolveConnected } = deps;

  return (event: MessageEvent) => {
    try {
      const evt = JSON.parse(decodeWsPayload(event.data)) as
        | ChatEvent
        | ApprovalInboxSocketReply;
      const ctx: RouterContext = {
        screen,
        isTty,
        editor: deps.getEditor(),
        eventHandler,
        state,
        deps,
      };

      if (evt.type === "approval_inbox_result") {
        renderSideOutput(ctx, formatApprovalInboxReply(evt));
      } else {
        dispatchChatEvent(evt, ctx, resolveConnected);
      }
    } catch (err: unknown) {
      log.warn("Message parse failed", { error: err });
    }
  };
}

function formatApprovalInboxReply(event: ApprovalInboxSocketReply): string {
  if (!event.ok) return String(event.error).slice(0, 300);
  const result = event.result;
  const row = (
    { id, tool, status, decision, dispatchOutcome, handlerReturnedAt }: {
      id: string;
      tool: string;
      status: string;
      decision?: string;
      dispatchOutcome?: string;
      handlerReturnedAt?: number;
    },
  ) =>
    [
      id,
      tool,
      status,
      ...(decision && decision !== status ? [decision] : []),
      ...(dispatchOutcome ? [dispatchOutcome] : []),
      ...(status === "claimed" && handlerReturnedAt !== undefined
        ? ["handler returned, response pending"]
        : []),
    ]
      .map((field) => String(field).slice(0, 128).replaceAll(/\s+/g, " ")).join(
        "  ",
      );
  if (!("records" in result)) return row(result);
  if (!result.records.length) return "No approval requests.";
  const rows = result.records.slice(0, 20).map(row);
  if (
    typeof result.nextBefore === "number" &&
    Number.isSafeInteger(result.nextBefore) && result.nextBefore > 0
  ) {
    rows.push(`More requests: /approvals ${result.nextBefore}`);
  }
  return ["Approval inbox", ...rows].join("\n");
}

/** Dispatch a parsed chat event to the appropriate handler. */
function dispatchChatEvent(
  evt: ChatEvent,
  ctx: RouterContext,
  resolveConnected: () => void,
): void {
  switch (evt.type) {
    case "side_started":
      return renderSideOutput(ctx, "Side question running…");
    case "side_cancelled":
      return renderSideOutput(ctx, "Side question cancelled.");
    case "side_error":
      return renderSideOutput(ctx, evt.message);
    case "side_answer":
      return renderSideOutput(
        ctx,
        `Side question: ${evt.entry.question}\n${evt.entry.answer}`,
      );
    case "side_history":
      return renderSideOutput(
        ctx,
        evt.entries.length
          ? evt.entries.map(({ question, answer }) =>
            `Side question: ${question}\n${answer}`
          ).join("\n\n")
          : "No side questions in this session.",
      );
    case "connected":
      return routeConnectedEvent(evt, ctx, resolveConnected);
    case "taint_changed":
      return routeTaintChangedEvent(evt, ctx);
    case "mcp_status":
      return routeMcpStatusEvent(evt, ctx);
    case "notification":
      return routeNotificationEvent(evt, ctx);
    case "trigger_prompt":
      return routeTriggerPromptEvent(evt, ctx);
    case "secret_prompt":
      return routeSecretPromptEvent(evt, ctx);
    case "credential_prompt":
      return routeCredentialPromptEvent(
        evt as Extract<ChatEvent, { type: "credential_prompt" }>,
        ctx,
      );
    case "confirm_prompt":
      return routeConfirmPromptEvent(
        evt as Extract<ChatEvent, { type: "confirm_prompt" }>,
        ctx,
      );
    case "bumpers_status":
      return routeBumpersStatusEvent(
        evt as Extract<ChatEvent, { type: "bumpers_status" }>,
        ctx,
      );
    case "chat_history":
      return routeChatHistoryEvent(
        evt as Extract<ChatEvent, { type: "chat_history" }>,
        ctx,
      );
    case "cancelled":
      return routeCancelledEvent(ctx);
    case "error":
      return routeErrorEvent(evt, ctx);
    case "compact_start":
      return routeCompactStartEvent(ctx);
    case "compact_complete":
      return routeCompactCompleteEvent(evt, ctx);
    case "response_chunk":
      return routeResponseChunkEvent(evt, ctx);
    case "response":
      return routeResponseCompleteEvent(evt, ctx);
    default:
      return forwardOrchestratorEvent(evt, ctx);
  }
}

function renderSideOutput(ctx: RouterContext, value: string): void {
  const text = [...value].filter((char) => {
    const code = char.charCodeAt(0);
    return char === "\n" || char === "\t" ||
      (code >= 32 && (code < 127 || code > 159));
  }).join("");
  if (ctx.isTty) {
    ctx.screen.writeOutput(text);
    ctx.screen.redrawInput(ctx.editor);
  } else {
    console.log(text);
  }
}
