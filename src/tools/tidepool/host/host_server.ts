/**
 * A2UI WebSocket upgrade and HTTP request routing.
 *
 * Handles inbound HTTP requests to the Tidepool server: upgrades
 * WebSocket connections (wiring open/message/close/error listeners),
 * and serves cached HTML for plain HTTP requests.
 *
 * @module
 */

import type { ChatSession } from "../../../gateway/chat.ts";
import type { A2UIHostState } from "./host_types.ts";
import { sendInitialClientState } from "./host_broadcast.ts";
import {
  type AbortControllerRef,
  type ChatDispatchContext,
  dispatchClientChatMessage,
} from "./host_chat.ts";
import { createLogger } from "../../../core/logger/mod.ts";
import { timingSafeEqual } from "../../../core/security/mod.ts";

const log = createLogger("tidepool-server");

/** Upgrade a WebSocket request: wire lifecycle listeners and return the upgrade response. */
export function upgradeWebSocketClient(
  request: Request,
  state: A2UIHostState,
  chatSession: ChatSession | undefined,
): Response {
  const { socket, response } = Deno.upgradeWebSocket(request);
  const ref: AbortControllerRef = { current: null };

  socket.addEventListener("open", () => {
    state.clients.add(socket);
    sendInitialClientState(socket, state, chatSession).catch(
      (err: unknown) => {
        log.warn("Tidepool initial state send failed", {
          operation: "upgradeWebSocketClient",
          err,
        });
      },
    );
  });

  wireMessageListener(socket, chatSession, ref, state);
  wireCleanupListeners(socket, state, ref);

  return response;
}

/**
 * Attach a message listener that routes by topic.
 *
 * Messages without a `topic` field (or with topic "chat") are dispatched
 * to the existing chat handler for backward compatibility. Messages with
 * other topics are forwarded to the topic handler registry on state.
 */
function wireMessageListener(
  socket: WebSocket,
  chatSession: ChatSession | undefined,
  ref: AbortControllerRef,
  state: A2UIHostState,
): void {
  socket.addEventListener("message", (event: MessageEvent) => {
    try {
      const text = typeof event.data === "string"
        ? event.data
        : new TextDecoder().decode(event.data as ArrayBuffer);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const topic = (parsed.topic as string) ?? "chat";

      if (topic === "chat" || !parsed.topic) {
        // Legacy chat protocol — dispatch directly
        if (!chatSession) return;
        const ctx: ChatDispatchContext = { socket, chatSession, ref };
        dispatchClientChatMessage(event.data, ctx);
        return;
      }

      // Topic-routed message — dispatch to registered handler
      const handler = state.topicHandlers?.[topic];
      if (handler) {
        handler(parsed, socket);
      }
    } catch (err) {
      log.debug("Tidepool WS message dispatch failed", { err });
    }
  });
}

/** Attach close and error listeners that remove the socket and abort in-flight turns. */
function wireCleanupListeners(
  socket: WebSocket,
  state: A2UIHostState,
  ref: AbortControllerRef,
): void {
  const cleanup = (): void => {
    state.clients.delete(socket);
    ref.current?.abort("client_disconnected");
    for (const cb of state.socketCleanupCallbacks) {
      cb(socket);
    }
  };

  socket.addEventListener("close", cleanup);
  socket.addEventListener("error", cleanup);
}

/**
 * Validate the session key from Bearer token or query parameter.
 *
 * Accepts auth via:
 * 1. `Authorization: Bearer <key>` header (preferred — used by Tauri, API clients)
 * 2. `?key=` query parameter (browser initial page load only — browsers cannot set headers on navigation)
 *
 * Returns 401 Response on failure, null on success.
 */
function rejectUnauthorized(
  request: Request,
  state: A2UIHostState,
): Response | null {
  if (!state.sessionKey) return null;
  const provided = extractSessionKey(request);
  if (provided !== null && timingSafeEqual(provided, state.sessionKey)) {
    return null;
  }
  log.warn("Tidepool request rejected: invalid session key", {
    operation: "rejectUnauthorized",
    providedKey: provided ?? "(none)",
    isWebSocket: request.headers.get("upgrade") === "websocket",
    url: request.url,
  });
  return new Response("Unauthorized", { status: 401 });
}

/** Extract session key from Bearer header or query parameter. */
function extractSessionKey(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  const url = new URL(request.url);
  return url.searchParams.get("key");
}

/** Route an inbound HTTP request to WebSocket upgrade or static HTML response. */
export function routeHostRequest(
  request: Request,
  state: A2UIHostState,
  chatSession: ChatSession | undefined,
): Response {
  if (request.headers.get("upgrade") === "websocket") {
    const rejection = rejectUnauthorized(request, state);
    if (rejection) {
      // Cannot return a plain HTTP response for a WS upgrade — browsers hang.
      // Accept the upgrade then immediately close with 4401 (custom auth error).
      const { socket, response } = Deno.upgradeWebSocket(request);
      socket.addEventListener("open", () => {
        socket.close(4401, "Unauthorized");
      });
      return response;
    }
    return upgradeWebSocketClient(request, state, chatSession);
  }

  const rejection = rejectUnauthorized(request, state);
  if (rejection) return rejection;
  if (state.cachedHtml) {
    // Inject the session key so the Svelte app can forward it on the
    // WebSocket connection without relying on location.search.
    let html = state.cachedHtml;
    if (state.sessionKey) {
      const keyMeta = `<meta name="tidepool-key" content=${
        JSON.stringify(state.sessionKey)
      }>`;
      html = html.replace(/<head>/i, `<head>${keyMeta}`);
    }
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response("Tide Pool A2UI Host", { status: 200 });
}

/** Close all client sockets and clear the set. */
export function closeAllClientSockets(clients: Set<WebSocket>): void {
  for (const ws of clients) {
    try {
      ws.close();
    } catch (err) {
      log.debug("Tidepool client socket close failed", { err });
    }
  }
  clients.clear();
}
