/**
 * Gateway WebSocket Control Plane.
 *
 * Provides a WebSocket server on a configurable port for managing
 * sessions, configuration, channels, and gateway state via JSON-RPC 2.0.
 * Also serves webhook HTTP endpoints when a SchedulerService is attached.
 *
 * @module
 */

import type { SchedulerService } from "../scheduler/service.ts";
import type { EnhancedSessionManager } from "./sessions.ts";
import type { NotificationService } from "./notifications.ts";
import type { ChatSession, ChatClientMessage } from "./chat.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import type { SessionId, UserId, ChannelId } from "../core/types/session.ts";

/** Options for creating a gateway server. */
export interface GatewayServerOptions {
  /** Port to listen on. Use 0 for a random available port. */
  readonly port?: number;
  /** Authentication token for connections. */
  readonly token?: string;
  /** Optional scheduler service for webhook endpoints. */
  readonly schedulerService?: SchedulerService;
  /** Optional session manager for JSON-RPC session methods. */
  readonly sessionManager?: EnhancedSessionManager;
  /** Optional notification service for JSON-RPC notification methods. */
  readonly notificationService?: NotificationService;
  /** Optional chat session for /chat WebSocket endpoint. */
  readonly chatSession?: ChatSession;
}

/** Address information returned after server start. */
export interface GatewayAddr {
  readonly port: number;
  readonly hostname: string;
}

/** Gateway server interface. */
export interface GatewayServer {
  /** Start the server. Returns the bound address. */
  start(): Promise<GatewayAddr>;
  /** Stop the server gracefully. */
  stop(): Promise<void>;
  /**
   * Broadcast a JSON event to all currently connected /chat WebSocket clients.
   * Used for push notifications such as MCP server status changes.
   */
  broadcastChatEvent(event: Record<string, unknown>): void;
}

/** JSON-RPC 2.0 request. */
interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response. */
interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
}

/**
 * Handle an inbound webhook HTTP request.
 *
 * Routes POST /webhooks/:sourceId to the scheduler service,
 * reading the HMAC signature from standard webhook headers.
 */
async function handleWebhookHttp(
  request: Request,
  url: URL,
  scheduler: SchedulerService,
): Promise<Response> {
  const sourceId = url.pathname.slice("/webhooks/".length);
  if (!sourceId) {
    return new Response(
      JSON.stringify({ error: "Missing source ID" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const signature = request.headers.get("x-hub-signature-256")
    ?? request.headers.get("x-signature")
    ?? "";
  const body = await request.text();

  const result = await scheduler.handleWebhookRequest(sourceId, body, signature);

  if (result.ok) {
    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  const status = result.error.includes("Invalid HMAC") ? 401
    : result.error.includes("Unknown webhook") ? 404
    : 400;

  return new Response(
    JSON.stringify({ error: result.error }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/**
 * Handle a JSON-RPC 2.0 request.
 *
 * Dispatches to the appropriate handler based on the method name.
 * Returns a JSON-RPC response.
 */
async function handleJsonRpc(
  request: JsonRpcRequest,
  sessions: EnhancedSessionManager | undefined,
  notifications: NotificationService | undefined,
): Promise<JsonRpcResponse> {
  const id = request.id;

  function success(result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
  }

  function error(code: number, message: string): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }

  try {
    const params = request.params ?? {};

    switch (request.method) {
      // --- Session methods ---
      case "sessions.list": {
        if (!sessions) return error(-32601, "Session manager not configured");
        const list = await sessions.sessionsList(params.filter as undefined);
        return success(list);
      }

      case "sessions.get": {
        if (!sessions) return error(-32601, "Session manager not configured");
        const sessionId = params.id as string;
        if (!sessionId) return error(-32602, "Missing required param: id");
        const session = await sessions.get(sessionId as SessionId);
        if (!session) return error(-32602, `Session not found: ${sessionId}`);
        return success(session);
      }

      case "sessions.create": {
        if (!sessions) return error(-32601, "Session manager not configured");
        const userId = params.userId as string;
        const channelId = params.channelId as string;
        if (!userId || !channelId) {
          return error(-32602, "Missing required params: userId, channelId");
        }
        const created = await sessions.create({
          userId: userId as UserId,
          channelId: channelId as ChannelId,
        });
        return success(created);
      }

      case "sessions.send": {
        if (!sessions) return error(-32601, "Session manager not configured");
        const fromId = params.fromId as string;
        const toId = params.toId as string;
        const content = params.content as string;
        const targetClassification = params.targetClassification as ClassificationLevel;
        if (!fromId || !toId || !content || !targetClassification) {
          return error(-32602, "Missing required params: fromId, toId, content, targetClassification");
        }
        const sendResult = await sessions.sessionsSend(
          fromId as SessionId,
          toId as SessionId,
          content,
          targetClassification,
        );
        if (sendResult.ok) {
          return success({ delivered: true });
        }
        return error(-32000, sendResult.error);
      }

      case "sessions.spawn": {
        if (!sessions) return error(-32601, "Session manager not configured");
        const parentId = params.parentId as string;
        const task = params.task as string;
        if (!parentId) return error(-32602, "Missing required param: parentId");
        const spawned = await sessions.sessionsSpawn(
          parentId as SessionId,
          task ?? "background",
        );
        return success(spawned);
      }

      // --- Notification methods ---
      case "notifications.list": {
        if (!notifications) return error(-32601, "Notification service not configured");
        const nUserId = params.userId as string;
        if (!nUserId) return error(-32602, "Missing required param: userId");
        const pending = await notifications.getPending(nUserId as UserId);
        return success(pending);
      }

      case "notifications.acknowledge": {
        if (!notifications) return error(-32601, "Notification service not configured");
        const notifId = params.notificationId as string;
        if (!notifId) return error(-32602, "Missing required param: notificationId");
        await notifications.acknowledge(notifId);
        return success({ acknowledged: true });
      }

      default:
        return error(-32601, `Method not found: ${request.method}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return error(-32603, msg);
  }
}

/**
 * Handle a /chat WebSocket connection.
 *
 * Upgrades the request to a WebSocket, sends a `connected` event,
 * and routes incoming chat messages to the ChatSession. Each connection
 * gets its own AbortController for cancel support.
 */
function handleChatWebSocket(
  request: Request,
  chat: ChatSession,
  chatSockets: Set<WebSocket>,
): Response {
  const { socket, response } = Deno.upgradeWebSocket(request);
  let abortController: AbortController | null = null;

  socket.addEventListener("open", () => {
    chatSockets.add(socket);
    try {
      socket.send(JSON.stringify({
        type: "connected",
        provider: chat.providerName,
        model: chat.modelName,
        taint: chat.sessionTaint,
      }));
    } catch {
      // Client may have disconnected immediately
    }
    // Send last known MCP status if available
    if (chat.getMcpStatus) {
      const mcpStatus = chat.getMcpStatus();
      if (mcpStatus !== null) {
        try {
          socket.send(JSON.stringify({ type: "mcp_status", ...mcpStatus }));
        } catch {
          // Client may have disconnected
        }
      }
    }
  });

  socket.addEventListener("message", (event: MessageEvent) => {
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
        chat.clear();
        return;
      }

      if (msg.type === "secret_prompt_response") {
        chat.handleSecretPromptResponse(msg.nonce, msg.value);
        return;
      }

      if (msg.type === "compact") {
        const send = (evt: unknown) => {
          try {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(evt));
            }
          } catch {
            // Client disconnected
          }
        };
        chat.compact(send).catch(() => {
          // Error already sent via compact_error event
        });
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

        chat.processMessage(msg.content, send, signal).finally(() => {
          abortController = null;
        });
      }
    } catch {
      try {
        socket.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
      } catch {
        // Client disconnected
      }
    }
  });

  socket.addEventListener("close", () => {
    chatSockets.delete(socket);
    abortController?.abort("client_disconnected");
  });

  socket.addEventListener("error", () => {
    chatSockets.delete(socket);
    abortController?.abort("client_disconnected");
  });

  return response;
}

/**
 * Create a Gateway WebSocket server.
 *
 * The server listens on the configured port (default 18789) and
 * accepts JSON-RPC 2.0 messages over WebSocket connections. When a
 * SchedulerService is provided, POST /webhooks/:sourceId routes
 * are served for inbound webhook events. When a ChatSession is
 * provided, /chat WebSocket connections are routed to it.
 */
export function createGatewayServer(
  options?: GatewayServerOptions,
): GatewayServer {
  const port = options?.port ?? 18789;
  const schedulerService = options?.schedulerService;
  const sessionManager = options?.sessionManager;
  const notificationService = options?.notificationService;
  const chatSession = options?.chatSession;
  let server: Deno.HttpServer | null = null;
  let resolvedAddr: GatewayAddr | null = null;
  // Track all open /chat WebSocket connections for broadcasting
  const chatSockets = new Set<WebSocket>();

  return {
    broadcastChatEvent(event: Record<string, unknown>): void {
      const json = JSON.stringify(event);
      for (const ws of chatSockets) {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(json);
          }
        } catch {
          chatSockets.delete(ws);
        }
      }
    },

    // deno-lint-ignore require-await
    async start(): Promise<GatewayAddr> {
      const addrPromise = Promise.withResolvers<GatewayAddr>();

      server = Deno.serve(
        {
          port,
          hostname: "127.0.0.1",
          onListen(addr) {
            resolvedAddr = { port: addr.port, hostname: addr.hostname };
            addrPromise.resolve(resolvedAddr);
          },
        },
        (request: Request): Response | Promise<Response> => {
          const url = new URL(request.url);

          // Handle WebSocket upgrade
          if (request.headers.get("upgrade") === "websocket") {
            // Route /chat to the chat session handler
            if (url.pathname === "/chat" && chatSession) {
              return handleChatWebSocket(request, chatSession, chatSockets);
            }

            // All other WebSocket connections: JSON-RPC control plane
            const { socket, response } = Deno.upgradeWebSocket(request);

            socket.addEventListener("message", async (event: MessageEvent) => {
              try {
                const data = typeof event.data === "string"
                  ? event.data
                  : new TextDecoder().decode(event.data as ArrayBuffer);
                const rpcRequest = JSON.parse(data) as JsonRpcRequest;

                if (rpcRequest.jsonrpc !== "2.0" || !rpcRequest.method) {
                  socket.send(JSON.stringify({
                    jsonrpc: "2.0",
                    id: rpcRequest.id ?? null,
                    error: { code: -32600, message: "Invalid JSON-RPC request" },
                  }));
                  return;
                }

                const rpcResponse = await handleJsonRpc(
                  rpcRequest,
                  sessionManager,
                  notificationService,
                );
                socket.send(JSON.stringify(rpcResponse));
              } catch {
                socket.send(JSON.stringify({
                  jsonrpc: "2.0",
                  id: null,
                  error: { code: -32700, message: "Parse error" },
                }));
              }
            });

            return response;
          }

          // Handle webhook endpoints: POST /webhooks/:sourceId
          if (
            request.method === "POST" &&
            url.pathname.startsWith("/webhooks/") &&
            schedulerService
          ) {
            return handleWebhookHttp(request, url, schedulerService);
          }

          // Default HTTP response
          return new Response("Triggerfish Gateway", { status: 200 });
        },
      );

      return addrPromise.promise;
    },

    async stop(): Promise<void> {
      if (server) {
        await server.shutdown();
        server = null;
        resolvedAddr = null;
      }
    },
  };
}
