/**
 * Tide Pool host for A2UI (Agent-to-UI) protocol.
 *
 * Provides two host implementations:
 * - TidepoolHost: callback-based host for HTML push/eval/reset/snapshot
 * - A2UIHost: WebSocket server that broadcasts component trees and canvas
 *   messages to clients, optionally handles chat via a ChatSession
 *
 * @module
 */

import type { ComponentTree } from "./components.ts";
import type { ChatSession, ChatClientMessage } from "../gateway/chat.ts";
import type { CanvasMessage, CanvasRenderComponentMessage } from "./canvas_protocol.ts";
import { buildTidepoolHtml } from "./ui.ts";

// ---------------------------------------------------------------------------
// Legacy callback-based TidepoolHost (retained for backward compatibility)
// ---------------------------------------------------------------------------

/** Options for creating a TidepoolHost. */
export interface TidepoolHostOptions {
  /** Called when HTML content is pushed to the tide pool. */
  readonly onPush: (html: string) => void;
  /** Called when the tide pool is reset. */
  readonly onReset?: () => void;
  /** Called when JS is evaluated in the tide pool. */
  readonly onEval?: (js: string) => void;
  /** Called when a snapshot is requested. */
  readonly onSnapshot?: () => string | undefined;
}

/** Tide Pool host instance managing content and state. */
export interface TidepoolHost {
  /** Push HTML content to the tide pool. */
  push(html: string): void;
  /** Evaluate JavaScript in the tide pool sandbox. */
  eval(js: string): void;
  /** Reset the tide pool, clearing all content. */
  reset(): void;
  /** Take a snapshot of the current tide pool state. */
  snapshot(): string | undefined;
}

/** Create a new Tide Pool host. */
export function createTidepoolHost(options: TidepoolHostOptions): TidepoolHost {
  return {
    push(html: string): void {
      options.onPush(html);
    },
    eval(js: string): void {
      if (options.onEval) {
        options.onEval(js);
      }
    },
    reset(): void {
      if (options.onReset) {
        options.onReset();
      }
    },
    snapshot(): string | undefined {
      if (options.onSnapshot) {
        return options.onSnapshot();
      }
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// A2UI WebSocket Host
// ---------------------------------------------------------------------------

/** Options for creating an A2UI host. */
export interface A2UIHostOptions {
  /** Chat session for handling browser chat messages. */
  readonly chatSession?: ChatSession;
}

/** A2UI WebSocket host that broadcasts component trees and canvas messages to connected clients. */
export interface A2UIHost {
  /** Start the WebSocket server on the given port. */
  start(port: number): Promise<void>;
  /** Stop the WebSocket server gracefully. */
  stop(): Promise<void>;
  /** Send a typed canvas message to all connected clients. */
  sendCanvas(message: CanvasMessage): void;
  /** Broadcast an updated component tree to all connected clients (wraps in canvas message). */
  broadcast(tree: ComponentTree): void;
  /**
   * Broadcast MCP server connection status to all connected Tidepool clients.
   * @param connected - Number of currently connected MCP servers
   * @param configured - Total number of configured (non-disabled) MCP servers
   */
  broadcastMcpStatus(connected: number, configured: number): void;
  /** The number of currently connected WebSocket clients. */
  readonly connections: number;
}

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
  const clients = new Set<WebSocket>();
  const chatSession = options?.chatSession;
  let server: Deno.HttpServer | null = null;
  let currentTree: ComponentTree | null = null;
  let _resolvedPort = 0;
  let cachedHtml: string | null = null;
  // Last known MCP status — sent to new clients on connect
  let lastMcpConnected = -1;
  let lastMcpConfigured = 0;

  /** Send a JSON-serialized message to all open clients. */
  function sendToAll(json: string): void {
    for (const ws of clients) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(json);
        }
      } catch {
        clients.delete(ws);
      }
    }
  }

  const host: A2UIHost = {
    async start(port: number): Promise<void> {
      // Cache the pre-built HTML
      cachedHtml = buildTidepoolHtml();

      const ready = Promise.withResolvers<void>();

      server = Deno.serve(
        {
          port,
          hostname: "127.0.0.1",
          onListen(addr) {
            _resolvedPort = addr.port;
            ready.resolve();
          },
        },
        (request: Request): Response => {
          if (request.headers.get("upgrade") === "websocket") {
            const { socket, response } = Deno.upgradeWebSocket(request);
            let abortController: AbortController | null = null;

            socket.addEventListener("open", () => {
              clients.add(socket);
              // Send current component tree if one exists
              if (currentTree) {
                socket.send(JSON.stringify(currentTree));
              }
              // Send connected event if chat session is available
              if (chatSession) {
                try {
                  socket.send(JSON.stringify({
                    type: "connected",
                    provider: chatSession.providerName,
                    model: chatSession.modelName,
                  }));
                } catch {
                  // Client may have disconnected
                }
              }
              // Send last known MCP status to this new client
              if (lastMcpConnected >= 0 && lastMcpConfigured > 0) {
                try {
                  socket.send(JSON.stringify({
                    type: "mcp_status",
                    connected: lastMcpConnected,
                    configured: lastMcpConfigured,
                  }));
                } catch {
                  // Client may have disconnected
                }
              }
            });

            socket.addEventListener("message", (event: MessageEvent) => {
              if (!chatSession) return;
              try {
                const data = typeof event.data === "string"
                  ? event.data
                  : new TextDecoder().decode(event.data as ArrayBuffer);
                const msg = JSON.parse(data) as ChatClientMessage;

                if (msg.type === "cancel") {
                  if (abortController) {
                    abortController.abort();
                    try {
                      if (socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({ type: "cancelled" }));
                      }
                    } catch {
                      // Client disconnected
                    }
                  }
                  return;
                }

                if (msg.type === "clear") {
                  chatSession.clear();
                  return;
                }

                // Route secret prompt responses to the waiting secret_save executor.
                if (msg.type === "secret_prompt_response") {
                  chatSession.handleSecretPromptResponse(msg.nonce, msg.value);
                  return;
                }

                if (msg.type === "message" && (typeof msg.content === "string" || (Array.isArray(msg.content) && msg.content.length > 0))) {
                  abortController = new AbortController();
                  const signal = abortController.signal;

                  const send = (evt: unknown) => {
                    try {
                      if (socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify(evt));
                      }
                    } catch {
                      // Client disconnected
                    }
                  };

                  chatSession.processMessage(msg.content, send, signal).finally(() => {
                    abortController = null;
                  });
                }
              } catch {
                // Ignore malformed messages
              }
            });

            socket.addEventListener("close", () => {
              clients.delete(socket);
              abortController?.abort("client_disconnected");
            });

            socket.addEventListener("error", () => {
              clients.delete(socket);
              abortController?.abort("client_disconnected");
            });

            return response;
          }

          // Serve Tidepool HTML (cached at start)
          if (cachedHtml) {
            return new Response(cachedHtml, {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          }

          return new Response("Tide Pool A2UI Host", { status: 200 });
        },
      );

      await ready.promise;
    },

    async stop(): Promise<void> {
      // Close all client sockets first
      for (const ws of clients) {
        try {
          ws.close();
        } catch {
          // Client may already be closed
        }
      }
      clients.clear();

      if (server) {
        await server.shutdown();
        server = null;
      }
      _resolvedPort = 0;
      currentTree = null;
      cachedHtml = null;
    },

    sendCanvas(message: CanvasMessage): void {
      // Track component tree from canvas render messages for late-connecting clients
      if (message.type === "canvas_render_component") {
        currentTree = (message as CanvasRenderComponentMessage).tree;
      } else if (message.type === "canvas_clear") {
        currentTree = null;
      }
      const json = JSON.stringify(message);
      sendToAll(json);
    },

    broadcast(tree: ComponentTree): void {
      // Backward-compatible: wrap bare tree in a canvas_render_component message
      currentTree = tree;
      const msg: CanvasRenderComponentMessage = {
        type: "canvas_render_component",
        id: crypto.randomUUID(),
        label: "Component Tree",
        tree,
      };
      const json = JSON.stringify(msg);
      sendToAll(json);
    },

    broadcastMcpStatus(connected: number, configured: number): void {
      lastMcpConnected = connected;
      lastMcpConfigured = configured;
      const json = JSON.stringify({ type: "mcp_status", connected, configured });
      sendToAll(json);
    },

    get connections(): number {
      return clients.size;
    },
  };

  return host;
}
