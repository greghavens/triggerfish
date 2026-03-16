/**
 * Gateway WebSocket Control Plane.
 *
 * Provides a WebSocket server on a configurable port for managing
 * sessions, configuration, channels, and gateway state via JSON-RPC 2.0.
 * Also serves webhook HTTP endpoints when a SchedulerService is attached.
 *
 * Sub-modules:
 * - server_handlers.ts: JSON-RPC dispatch, chat WebSocket, and webhook HTTP handlers
 * - server_types.ts: Types, constants, and header validation
 *
 * @module
 */

import {
  dispatchJsonRpc,
  routeWebhookHttp,
  upgradeChatWebSocket,
} from "./handlers.ts";
import { createLogger } from "../../core/logger/logger.ts";
import {
  extractBearerToken,
  rejectWebSocketUpgrade,
} from "../../core/security/websocket_auth.ts";
import type { JsonRpcRequest } from "./handlers.ts";
import {
  enforceGatewayUpgradeHeaders,
  MAX_JSONRPC_MESSAGE_BYTES,
} from "./server_types.ts";
import type { GatewayServer, GatewayServerOptions } from "./server_types.ts";

// Re-export all types
export type {
  GatewayAddr,
  GatewayServer,
  GatewayServerOptions,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./server_types.ts";

const log = createLogger("gateway");

/** Handle a JSON-RPC message on a control plane WebSocket. */
async function dispatchControlPlaneMessage(
  socket: WebSocket,
  event: MessageEvent,
  options?: GatewayServerOptions,
): Promise<void> {
  const data = typeof event.data === "string"
    ? event.data
    : new TextDecoder().decode(event.data as ArrayBuffer);

  if (data.length > MAX_JSONRPC_MESSAGE_BYTES) {
    log.warn(
      "JSON-RPC WebSocket message rejected: exceeds size limit",
      {
        operation: "handleJsonRpcSocketMessage",
        byteLength: data.length,
        limitBytes: MAX_JSONRPC_MESSAGE_BYTES,
      },
    );
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "Message too large: exceeds 1MB limit",
      },
    }));
    return;
  }

  const rpcRequest = JSON.parse(data) as JsonRpcRequest;

  if (rpcRequest.jsonrpc !== "2.0" || !rpcRequest.method) {
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: rpcRequest.id ?? null,
      error: {
        code: -32600,
        message: "Invalid JSON-RPC request",
      },
    }));
    return;
  }

  const rpcResponse = await dispatchJsonRpc(
    rpcRequest,
    options?.sessionManager,
    options?.notificationService,
  );
  socket.send(JSON.stringify(rpcResponse));
}

/** Handle the debug/run-triggers HTTP endpoint. */
function handleDebugTriggerEndpoint(
  request: Request,
  options?: GatewayServerOptions,
): Response {
  if (!options?.token) {
    log.debug("Debug endpoint auth not configured, proceeding", {
      operation: "debug/run-triggers",
    });
  } else {
    const provided = extractBearerToken(request);
    if (provided !== options.token) {
      log.warn("Debug endpoint access rejected: invalid token", {
        operation: "debug/run-triggers",
        reason: "invalid_token",
      });
      return new Response("Unauthorized", { status: 401 });
    }
    log.info("Debug endpoint access authorized", {
      operation: "debug/run-triggers",
    });
  }
  if (!options?.schedulerService) {
    return new Response(
      JSON.stringify({ error: "Scheduler not configured" }),
      {
        status: 503,
        headers: { "content-type": "application/json" },
      },
    );
  }
  options.schedulerService.runTrigger().catch((err: unknown) => {
    log.warn(
      "Scheduled trigger execution failed via debug endpoint",
      { err },
    );
  });
  return new Response(
    JSON.stringify({ ok: true, message: "Trigger fired" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
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
  const chatSession = options?.chatSession;
  let server: Deno.HttpServer | null = null;
  let resolvedAddr: import("./server_types.ts").GatewayAddr | null = null;
  const chatSockets = new Set<WebSocket>();

  return {
    broadcastChatEvent(event: Record<string, unknown>): void {
      const json = JSON.stringify(event);
      for (const ws of chatSockets) {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(json);
        } catch (err) {
          log.warn(
            "Failed to send chat event to socket, removing stale connection",
            { err },
          );
          chatSockets.delete(ws);
        }
      }
    },

    broadcastNotification(message: string): void {
      const json = JSON.stringify({ type: "notification", message });
      for (const ws of chatSockets) {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(json);
        } catch (err) {
          log.warn(
            "Failed to send notification to socket, removing stale connection",
            { err },
          );
          chatSockets.delete(ws);
        }
      }
    },

    // deno-lint-ignore require-await
    async start(): Promise<import("./server_types.ts").GatewayAddr> {
      const addrPromise = Promise.withResolvers<
        import("./server_types.ts").GatewayAddr
      >();

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

          if (request.headers.get("upgrade") === "websocket") {
            const headerRejection = enforceGatewayUpgradeHeaders(request);
            if (headerRejection) return headerRejection;

            const rejection = rejectWebSocketUpgrade(request, {
              token: options?.token,
              allowedOrigins: options?.allowedOrigins,
            });
            if (rejection) {
              log.warn("WebSocket upgrade rejected", {
                status: rejection.status,
                reason: rejection.status === 401
                  ? "invalid_token"
                  : "origin_mismatch",
                origin: request.headers.get("origin") ?? "(none)",
              });
              return rejection;
            }

            if (url.pathname === "/chat" && chatSession) {
              log.ext("DEBUG", "Gateway /chat WS upgrade", {
                origin: request.headers.get("origin") ?? "",
                userAgent: request.headers.get("user-agent") ?? "",
              });
              return upgradeChatWebSocket(request, chatSession, chatSockets);
            }

            log.ext("DEBUG", "Gateway control plane WS upgrade", {
              origin: request.headers.get("origin") ?? "",
              userAgent: request.headers.get("user-agent") ?? "",
            });
            const { socket, response } = Deno.upgradeWebSocket(request);

            socket.addEventListener("message", async (event: MessageEvent) => {
              try {
                await dispatchControlPlaneMessage(socket, event, options);
              } catch (err) {
                log.warn(
                  "JSON-RPC dispatch or JSON parse failed on WebSocket message",
                  { err },
                );
                socket.send(JSON.stringify({
                  jsonrpc: "2.0",
                  id: null,
                  error: { code: -32700, message: "Parse error" },
                }));
              }
            });

            return response;
          }

          if (
            request.method === "POST" &&
            url.pathname.startsWith("/webhooks/") &&
            options?.schedulerService
          ) {
            return routeWebhookHttp(request, url, options.schedulerService);
          }

          if (
            request.method === "POST" &&
            url.pathname === "/debug/run-triggers"
          ) {
            return handleDebugTriggerEndpoint(request, options);
          }

          return new Response("", { status: 404 });
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
