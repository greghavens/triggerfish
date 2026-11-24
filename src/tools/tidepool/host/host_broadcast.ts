/**
 * A2UI socket broadcast helpers.
 *
 * Provides low-level primitives for sending JSON payloads to individual
 * WebSocket clients and broadcasting to the full client set. Also
 * handles sending initial state (component tree, chat history, canvas
 * renders, chat status, MCP status) to newly connected sockets.
 *
 * @module
 */

import type { ChatSession } from "../../../gateway/chat.ts";
import type { A2UIHostState } from "./host_types.ts";
import { createLogger } from "../../../core/logger/mod.ts";

const log = createLogger("tidepool-broadcast");

/** Safely send a string payload to a single socket, swallowing send errors. */
export function trySendSocketPayload(ws: WebSocket, json: string): void {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    }
  } catch {
    // Client may have disconnected
  }
}

/** Send a JSON-serialized message to all open clients, pruning dead sockets. */
export function broadcastJsonToClients(
  clients: Set<WebSocket>,
  json: string,
): number {
  let sent = 0;
  for (const ws of clients) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
        sent++;
      }
    } catch {
      clients.delete(ws);
    }
  }
  return sent;
}

/** Send current component tree, chat history, canvas renders, chat-connected event, and MCP status to a newly opened socket. */
export async function sendInitialClientState(
  socket: WebSocket,
  state: A2UIHostState,
  chatSession: ChatSession | undefined,
): Promise<void> {
  sendChatConnectedStatus(socket, chatSession);
  sendBumpersStatus(socket, chatSession);
  sendMcpStatusIfAvailable(socket, state);
  sendCanvasRenderHistory(socket, state);
  await sendChatHistory(socket, chatSession);
}

/** Send the chat-connected event to a socket if a chatSession is available. */
function sendChatConnectedStatus(
  socket: WebSocket,
  chatSession: ChatSession | undefined,
): void {
  if (chatSession) {
    trySendSocketPayload(
      socket,
      JSON.stringify({
        type: "connected",
        provider: chatSession.providerName,
        model: chatSession.modelName,
        workspace: chatSession.workspacePath,
        taint: chatSession.sessionTaint,
      }),
    );
  }
}

/** Send current bumpers state to a socket if a chatSession is available. */
function sendBumpersStatus(
  socket: WebSocket,
  chatSession: ChatSession | undefined,
): void {
  if (chatSession) {
    trySendSocketPayload(
      socket,
      JSON.stringify({
        type: "bumpers_status",
        enabled: chatSession.bumpersEnabled,
      }),
    );
  }
}

/** Send cached MCP status to a socket if MCP status has been received. */
function sendMcpStatusIfAvailable(
  socket: WebSocket,
  state: A2UIHostState,
): void {
  if (state.lastMcpConnected >= 0 && state.lastMcpConfigured > 0) {
    trySendSocketPayload(
      socket,
      JSON.stringify({
        type: "mcp_status",
        connected: state.lastMcpConnected,
        configured: state.lastMcpConfigured,
      }),
    );
  }
}

/** Send persisted chat history to a newly connected socket. */
async function sendChatHistory(
  socket: WebSocket,
  chatSession: ChatSession | undefined,
): Promise<void> {
  if (!chatSession) return;
  try {
    const entries = await chatSession.loadChatHistory();
    if (entries.length === 0) return;
    trySendSocketPayload(
      socket,
      JSON.stringify({ type: "chat_history", messages: entries }),
    );
  } catch (err: unknown) {
    log.warn("Tidepool chat history send failed on reconnect", {
      operation: "sendChatHistory",
      err,
    });
  }
}

/** Send canvas render history to a newly connected socket. */
function sendCanvasRenderHistory(
  socket: WebSocket,
  state: A2UIHostState,
): void {
  if (state.canvasRenders.length === 0) return;
  for (const render of state.canvasRenders) {
    trySendSocketPayload(socket, JSON.stringify(render.message));
  }
}
