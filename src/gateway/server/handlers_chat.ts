/**
 * Chat WebSocket handler for the gateway.
 *
 * Manages /chat WebSocket connections — upgrading requests,
 * routing incoming messages to the ChatSession, and providing
 * cancel/clear/compact support per connection.
 *
 * @module
 */

import type { ChatClientMessage, ChatSession } from "../chat.ts";
import { createSentinelSocketMode } from "../sentinel_socket_mode.ts";
import { createSideQuestionSocket } from "../side_question.ts";
import {
  type ApprovalInboxSocketService,
  routeApprovalInboxSocketRequest,
} from "../approval_inbox_socket.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("gateway");

/** Maximum size of an incoming chat WebSocket message (256 KB). */
const MAX_CHAT_MESSAGE_BYTES = 256 * 1024;

interface ChatConnectionState {
  controller: AbortController | null;
  readonly sentinel: ReturnType<typeof createSentinelSocketMode>;
  readonly side: ReturnType<typeof createSideQuestionSocket>;
  readonly inbox?: ApprovalInboxSocketService;
  disconnected: boolean;
}

// ─── WebSocket send helpers ──────────────────────────────────────────────────

/** Send JSON data to a WebSocket if open, swallowing errors on disconnect. */
function sendSafeWebSocket(socket: WebSocket, data: unknown): void {
  try {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(data));
    }
  } catch (err) {
    log.debug("Chat WebSocket send failed: client disconnected", {
      error: err,
    });
  }
}

/** Create a ChatEventSender that routes events through a WebSocket. */
function createWebSocketSender(socket: WebSocket): (evt: unknown) => void {
  return (evt: unknown) => sendSafeWebSocket(socket, evt);
}

// ─── Chat socket event handlers ──────────────────────────────────────────────

/** Send connection metadata to a newly opened chat socket. */
function sendConnectionInfo(socket: WebSocket, chat: ChatSession): void {
  const taint = chat.sessionTaint;
  const workspace = chat.workspacePath;
  log.info("Sending connection info to chat client", {
    operation: "sendConnectionInfo",
    taint,
    workspace,
  });
  sendSafeWebSocket(socket, {
    type: "connected",
    provider: chat.providerName,
    model: chat.modelName,
    taint,
    workspace,
  });
}

/** Send MCP status to socket if available. */
function sendMcpStatus(socket: WebSocket, chat: ChatSession): void {
  if (chat.getMcpStatus) {
    const mcpStatus = chat.getMcpStatus();
    if (mcpStatus !== null) {
      sendSafeWebSocket(socket, { type: "mcp_status", ...mcpStatus });
    }
  }
}

/** Send persisted chat history to a newly connected socket. */
async function sendChatHistory(
  socket: WebSocket,
  chat: ChatSession,
): Promise<void> {
  try {
    const entries = await chat.loadChatHistory();
    if (entries.length > 0) {
      sendSafeWebSocket(socket, { type: "chat_history", entries });
      log.info("Sent persisted chat history to client", {
        operation: "sendChatHistory",
        entryCount: entries.length,
      });
    }
  } catch (err: unknown) {
    log.warn("Chat history load failed during socket open", {
      operation: "sendChatHistory",
      err,
    });
  }
}

/** Handle WebSocket open: register socket and send initial state. */
async function handleChatSocketOpen(
  socket: WebSocket,
  chat: ChatSession,
  chatSockets: Set<WebSocket>,
): Promise<void> {
  chatSockets.add(socket);
  sendConnectionInfo(socket, chat);
  sendMcpStatus(socket, chat);
  sendSafeWebSocket(socket, {
    type: "bumpers_status",
    enabled: chat.bumpersEnabled,
  });
  await sendChatHistory(socket, chat);
}

/** Handle cancel, clear, and secret_prompt_response message types. */
function handleControlMessage(
  msg: ChatClientMessage,
  chat: ChatSession,
  socket: WebSocket,
  abortRef: ChatConnectionState,
): boolean {
  if (msg.type === "cancel") {
    if (abortRef.controller) {
      abortRef.controller.abort();
      sendSafeWebSocket(socket, { type: "cancelled" });
    }
    return true;
  }
  if (msg.type === "clear") {
    abortRef.controller?.abort();
    abortRef.side.reset();
    abortRef.sentinel.reset();
    chat.clear();
    return true;
  }
  if (abortRef.sentinel.active && msg.type !== "message") {
    if (msg.type === "bumpers" || msg.type === "compact") {
      sendSafeWebSocket(socket, {
        type: "error",
        message: "Exit Sentinel mode to use normal chat controls.",
      });
    }
    return true;
  }
  if (msg.type === "secret_prompt_response") {
    log.debug("Routing secret prompt response", {
      operation: "handleControlMessage",
      nonce: msg.nonce,
    });
    chat.handleSecretPromptResponse(msg.nonce, msg.value);
    return true;
  }
  if (msg.type === "credential_prompt_response") {
    log.debug("Routing credential prompt response", {
      operation: "handleControlMessage",
      nonce: msg.nonce,
    });
    chat.handleCredentialPromptResponse(
      msg.nonce,
      msg.username,
      msg.password,
    );
    return true;
  }
  if (msg.type === "confirm_prompt_response") {
    log.debug("Routing confirm prompt response", {
      operation: "handleControlMessage",
      nonce: msg.nonce,
      approved: msg.approved,
    });
    chat.handleConfirmPromptResponse(msg.nonce, msg.approved);
    return true;
  }
  if (msg.type === "trigger_prompt_response") {
    log.debug("Routing trigger prompt response", {
      operation: "handleControlMessage",
      source: msg.source,
      accepted: msg.accepted,
    });
    chat.handleTriggerPromptResponse(
      msg.source,
      msg.accepted,
      createWebSocketSender(socket),
    );
    return true;
  }
  if (msg.type === "bumpers") {
    const enabled = chat.toggleBumpers();
    sendSafeWebSocket(socket, { type: "bumpers_status", enabled });
    return true;
  }
  return false;
}

/** Handle compact message type. */
function handleCompactMessage(chat: ChatSession, socket: WebSocket): void {
  chat.compact(createWebSocketSender(socket)).catch((err: unknown) => {
    log.debug("Compact failed after compact_error event sent", {
      error: err,
    });
  });
}

/** Handle a user chat message by starting an agent turn. */
function handleUserMessage(
  msg: ChatClientMessage,
  chat: ChatSession,
  socket: WebSocket,
  abortRef: ChatConnectionState,
): void {
  if (msg.type !== "message") return;
  const hasContent = typeof msg.content === "string" ||
    (Array.isArray(msg.content) && msg.content.length > 0);
  if (!hasContent) return;

  if (abortRef.controller) return;
  const controller = new AbortController();
  abortRef.controller = controller;
  const signal = controller.signal;
  const send = createWebSocketSender(socket);
  abortRef.sentinel.handle(msg.content, send, signal)
    .then(async (handled) => {
      if (!handled && !signal.aborted) {
        await chat.executeAgentTurn(msg.content, send, signal);
      }
    })
    .catch((error: unknown) => {
      log.warn("Chat turn failed", { error });
      if (!signal.aborted) send({ type: "error", message: "Chat turn failed" });
    })
    .finally(() => {
      if (abortRef.controller === controller) abortRef.controller = null;
      if (abortRef.disconnected) abortRef.sentinel.reset();
      send({ type: "turn_end" });
    });
}

/** Route a parsed chat client message to the appropriate handler. */
function routeChatSocketMessage(
  msg: ChatClientMessage,
  chat: ChatSession,
  socket: WebSocket,
  abortRef: ChatConnectionState,
): void {
  if (
    routeApprovalInboxSocketRequest(
      msg,
      abortRef.inbox,
      createWebSocketSender(socket),
    )
  ) return;
  if (
    abortRef.side.handle(
      msg.type === "message" ? msg.content : undefined,
      msg.type === "side_cancel",
      createWebSocketSender(socket),
    )
  ) return;
  if (handleControlMessage(msg, chat, socket, abortRef)) return;
  if (msg.type === "compact") {
    handleCompactMessage(chat, socket);
    return;
  }
  handleUserMessage(msg, chat, socket, abortRef);
}

/** Parse raw WebSocket event data into a string. */
function parseSocketEventData(event: MessageEvent): string {
  return typeof event.data === "string"
    ? event.data
    : new TextDecoder().decode(event.data as ArrayBuffer);
}

// ─── WebSocket lifecycle ─────────────────────────────────────────────────────

/** Handle incoming WebSocket messages, parsing and routing them. */
function handleChatSocketMessage(
  event: MessageEvent,
  chat: ChatSession,
  socket: WebSocket,
  abortRef: ChatConnectionState,
): void {
  try {
    const data = parseSocketEventData(event);
    if (data.length > MAX_CHAT_MESSAGE_BYTES) {
      log.warn("Chat WebSocket message rejected: exceeds size limit", {
        operation: "handleChatSocketMessage",
        byteLength: data.length,
        limitBytes: MAX_CHAT_MESSAGE_BYTES,
      });
      sendSafeWebSocket(socket, {
        type: "error",
        message: "Message too large: exceeds 256KB limit",
      });
      return;
    }
    const msg = JSON.parse(data) as ChatClientMessage;
    routeChatSocketMessage(msg, chat, socket, abortRef);
  } catch (err) {
    log.warn("Chat WebSocket message parse failed", {
      operation: "handleChatSocketMessage",
      error: err,
    });
    sendSafeWebSocket(socket, {
      type: "error",
      message: "Invalid message format",
    });
  }
}

/** Handle WebSocket close or error: cleanup socket and abort. */
function handleChatSocketDisconnect(
  socket: WebSocket,
  chatSockets: Set<WebSocket>,
  abortRef: ChatConnectionState,
): void {
  chatSockets.delete(socket);
  if (abortRef.disconnected) return;
  abortRef.disconnected = true;
  abortRef.side.reset();
  if (
    abortRef.controller && abortRef.inbox?.isWaiting(abortRef.controller.signal)
  ) return;
  abortRef.controller?.abort("client_disconnected");
  abortRef.sentinel.reset();
}

/** Wire up all event listeners on a chat WebSocket. */
function attachChatSocketListeners(
  socket: WebSocket,
  chat: ChatSession,
  chatSockets: Set<WebSocket>,
  allowSentinel: boolean,
): void {
  const sentinel = createSentinelSocketMode(
    allowSentinel ? chat.sentinelSnapshotPath : undefined,
    {
      createAgent: chat.createSentinelAgent,
      resolveCase: chat.resolveSentinelChatCase,
      clearContext: chat.clearForSentinelMode,
      webContainmentConfigured: chat.sentinelWebContainmentConfigured,
      readOutputLanguage: chat.readSentinelOutputLanguage,
    },
  );
  const abortRef: ChatConnectionState = {
    controller: null,
    disconnected: false,
    inbox: allowSentinel ? chat.approvalInbox : undefined,
    sentinel,
    side: createSideQuestionSocket(
      allowSentinel ? chat.sideQuestions : undefined,
      sentinel.sideQuestionSubject,
    ),
  };

  socket.addEventListener("open", () => {
    handleChatSocketOpen(socket, chat, chatSockets).catch((err: unknown) => {
      log.error("WebSocket open handler failed", {
        operation: "handleChatSocketOpen",
        err,
      });
    });
  });
  socket.addEventListener("message", (event: MessageEvent) => {
    handleChatSocketMessage(event, chat, socket, abortRef);
  });
  socket.addEventListener("close", () => {
    handleChatSocketDisconnect(socket, chatSockets, abortRef);
  });
  socket.addEventListener("error", () => {
    handleChatSocketDisconnect(socket, chatSockets, abortRef);
  });
}

/**
 * Handle a /chat WebSocket connection.
 *
 * Upgrades the request to a WebSocket, sends a `connected` event,
 * and routes incoming chat messages to the ChatSession. Each connection
 * gets its own AbortController for cancel support.
 */
export function upgradeChatWebSocket(
  request: Request,
  chat: ChatSession,
  chatSockets: Set<WebSocket>,
  allowSentinel: boolean,
): Response {
  const { socket, response } = Deno.upgradeWebSocket(request);
  attachChatSocketListeners(socket, chat, chatSockets, allowSentinel);
  return response;
}
