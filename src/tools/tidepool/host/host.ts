/**
 * Tide Pool host for A2UI (Agent-to-UI) protocol.
 *
 * This module re-exports all host-related types and provides the
 * `createA2UIHost` factory. The implementation is split across:
 * - `host_legacy.ts` — callback-based TidepoolHost
 * - `host_types.ts` — A2UIHost interface and state types
 * - `host_broadcast.ts` — socket broadcast helpers
 * - `host_chat.ts` — chat message dispatch
 * - `host_server.ts` — WebSocket upgrade and HTTP routing
 *
 * @module
 */

import type { ComponentTree } from "../components.ts";
import type {
  CanvasMessage,
  CanvasRenderComponentMessage,
} from "../canvas_protocol.ts";
import { buildTidepoolHtml } from "../ui.ts";
import type {
  A2UIHost,
  A2UIHostOptions,
  A2UIHostState,
  TopicHandler,
} from "./host_types.ts";
import { broadcastJsonToClients } from "./host_broadcast.ts";
import { routeHostRequest } from "./host_server.ts";
import { closeAllClientSockets } from "./host_server.ts";

// Re-export all public types so existing imports keep working
export type { TidepoolHost, TidepoolHostOptions } from "../host_legacy.ts";
export { createTidepoolHost } from "../host_legacy.ts";
export type { A2UIHost, A2UIHostOptions } from "./host_types.ts";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new A2UI WebSocket host.
 *
 * The host uses `Deno.serve()` to listen for WebSocket upgrade requests.
 * When a client connects it immediately receives the current component
 * tree (if one has been set). Subsequent `sendCanvas()` and `broadcast()`
 * calls push messages to every connected client. Disconnected clients are
 * cleaned up automatically.
 *
 * When a `chatSession` is provided via options, the host also handles
 * incoming chat messages from browser clients and serves the Tidepool
 * HTML chat + canvas interface on HTTP requests.
 */
export function createA2UIHost(options?: A2UIHostOptions): A2UIHost {
  const chatSession = options?.chatSession;

  const state: A2UIHostState = {
    clients: new Set<WebSocket>(),
    server: null,
    currentTree: null,
    resolvedPort: 0,
    cachedHtml: null,
    sessionKey: options?.sessionKey ?? null,
    onAuthenticatedConnect: options?.onAuthenticatedConnect,
    lastMcpConnected: -1,
    lastMcpConfigured: 0,
    socketCleanupCallbacks: [],
    canvasRenders: [],
  };

  return {
    async start(port: number): Promise<void> {
      state.cachedHtml = buildTidepoolHtml();
      const ready = Promise.withResolvers<void>();

      state.server = Deno.serve(
        {
          port,
          hostname: "127.0.0.1",
          onListen(addr) {
            state.resolvedPort = addr.port;
            ready.resolve();
          },
        },
        (request: Request): Response =>
          routeHostRequest(request, state, chatSession),
      );

      await ready.promise;
    },

    async stop(): Promise<void> {
      closeAllClientSockets(state.clients);

      if (state.server) {
        await state.server.shutdown();
        state.server = null;
      }
      state.resolvedPort = 0;
      state.currentTree = null;
      state.cachedHtml = null;
      state.canvasRenders = [];
    },

    sendCanvas(message: CanvasMessage): void {
      updateTreeFromCanvasMessage(state, message);
      broadcastJsonToClients(state.clients, JSON.stringify(message));
    },

    broadcast(tree: ComponentTree): void {
      const msg: CanvasRenderComponentMessage = {
        type: "canvas_render_component",
        id: crypto.randomUUID(),
        label: "Component Tree",
        tree,
      };
      updateTreeFromCanvasMessage(state, msg);
      broadcastJsonToClients(state.clients, JSON.stringify(msg));
    },

    broadcastMcpStatus(connected: number, configured: number): void {
      state.lastMcpConnected = connected;
      state.lastMcpConfigured = configured;
      broadcastJsonToClients(
        state.clients,
        JSON.stringify({ type: "mcp_status", connected, configured }),
      );
    },

    broadcastNotification(message: string): number {
      return broadcastJsonToClients(
        state.clients,
        JSON.stringify({ type: "notification", message }),
      );
    },

    broadcastChatEvent(
      event: import("../../../core/types/chat_event.ts").ChatEvent,
    ): void {
      broadcastJsonToClients(state.clients, JSON.stringify(event));
    },

    registerTopicHandler(topic: string, handler: TopicHandler): void {
      if (!state.topicHandlers) {
        state.topicHandlers = {};
      }
      state.topicHandlers[topic] = handler;
    },

    registerSocketCleanup(callback: (socket: WebSocket) => void): void {
      state.socketCleanupCallbacks.push(callback);
    },

    get connections(): number {
      return state.clients.size;
    },
  };
}

/** Maximum number of canvas renders kept for reconnect replay. */
const MAX_CANVAS_RENDERS = 50;

/** Update tracked component tree and render history based on canvas message type. */
function updateTreeFromCanvasMessage(
  state: A2UIHostState,
  message: CanvasMessage,
): void {
  if (
    message.type === "canvas_render_component" ||
    message.type === "canvas_render_html" ||
    message.type === "canvas_render_file"
  ) {
    if (message.type === "canvas_render_component") {
      state.currentTree = message.tree;
    }
    state.canvasRenders.push({
      id: message.id,
      label: message.label,
      message,
    });
    if (state.canvasRenders.length > MAX_CANVAS_RENDERS) {
      state.canvasRenders = state.canvasRenders.slice(-MAX_CANVAS_RENDERS);
    }
  } else if (message.type === "canvas_clear") {
    state.currentTree = null;
    state.canvasRenders = [];
  }
}
