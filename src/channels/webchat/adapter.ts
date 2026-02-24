/**
 * WebChat channel adapter via WebSocket.
 *
 * Provides a WebSocket server that browser-based chat widgets connect to.
 * Each WebSocket connection gets a unique session ID. Messages are JSON
 * frames with { type, content, sessionId }.
 *
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelStatus,
  MessageHandler,
} from "../types.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("webchat");

/** Maximum bytes for a single HTTP header value on WS upgrade (RFC 6585). */
export const MAX_SINGLE_HEADER_BYTES = 512;
/** Maximum total bytes across all HTTP headers on WS upgrade. */
export const MAX_TOTAL_HEADER_BYTES = 8192;

/** Configuration for the WebChat channel adapter. */
export interface WebChatConfig {
  /** Port for the WebSocket server. Default: 8765 */
  readonly port?: number;
  /** Classification level for this channel. Default: PUBLIC */
  readonly classification?: ClassificationLevel;
  /** Allowed origins for CORS. Default: ["*"] (allow all) */
  readonly allowedOrigins?: readonly string[];
}

/** WebSocket message frame. */
interface WsFrame {
  readonly type: "message" | "ping" | "pong";
  readonly content?: string;
  readonly sessionId?: string;
}

/**
 * Validate WebSocket upgrade headers for size and origin.
 *
 * Returns HTTP 431 if any single header exceeds MAX_SINGLE_HEADER_BYTES or
 * total headers exceed MAX_TOTAL_HEADER_BYTES. Returns HTTP 403 if the Origin
 * header is not in the configured allowedOrigins list (when not wildcard).
 * Returns null if the request should proceed.
 */
export function validateWebChatUpgrade(
  req: Request,
  config: WebChatConfig,
): Response | null {
  let totalBytes = 0;
  for (const [name, value] of req.headers.entries()) {
    if (value.length > MAX_SINGLE_HEADER_BYTES) {
      return new Response("Request Header Fields Too Large", { status: 431 });
    }
    totalBytes += name.length + value.length;
  }
  if (totalBytes > MAX_TOTAL_HEADER_BYTES) {
    return new Response("Request Header Fields Too Large", { status: 431 });
  }

  const allowedOrigins = config.allowedOrigins ?? ["*"];
  if (!allowedOrigins.includes("*")) {
    const origin = req.headers.get("origin") ?? "";
    if (!allowedOrigins.includes(origin)) {
      return new Response("Forbidden: Origin not allowed", { status: 403 });
    }
  }

  return null;
}

/**
 * Wire up event handlers for a newly upgraded WebSocket connection.
 *
 * Registers open, message, and close handlers that track the connection
 * in the shared `connections` map and dispatch incoming messages to the
 * current message handler.
 */
function attachSocketEventHandlers(
  socket: WebSocket,
  sessionId: string,
  connections: Map<string, WebSocket>,
  handlerRef: { current: MessageHandler | null },
): void {
  socket.onopen = () => {
    log.debug("WebSocket client connected", { sessionId });
    connections.set(sessionId, socket);
    socket.send(JSON.stringify({ type: "session", sessionId }));
  };

  socket.onmessage = (event) => {
    if (!handlerRef.current) return;
    try {
      const frame = JSON.parse(event.data as string) as WsFrame;
      if (frame.type === "message" && frame.content) {
        handlerRef.current({
          content: frame.content,
          sessionId,
          senderId: sessionId,
          isOwner: false,
          sessionTaint: "PUBLIC" as ClassificationLevel,
          isGroup: false,
        });
      }
    } catch (err) {
      log.warn("WebChat: malformed message frame received", { sessionId, err });
    }
  };

  socket.onclose = () => {
    log.debug("WebSocket client disconnected", { sessionId });
    connections.delete(sessionId);
  };
}

/**
 * Handle an incoming HTTP request to the WebChat server.
 *
 * WebSocket upgrade requests are validated for header size and origin before
 * upgrade. All other requests receive a health-check response.
 */
function routeWebChatRequest(
  req: Request,
  connections: Map<string, WebSocket>,
  handlerRef: { current: MessageHandler | null },
  config: WebChatConfig,
): Response {
  if (req.headers.get("upgrade") === "websocket") {
    const rejection = validateWebChatUpgrade(req, config);
    if (rejection) {
      log.warn("WebSocket upgrade rejected", {
        status: rejection.status,
        origin: req.headers.get("origin") ?? "(none)",
      });
      return rejection;
    }

    log.ext("DEBUG", "WebSocket upgrade accepted", {
      origin: req.headers.get("origin") ?? "",
      userAgent: req.headers.get("user-agent") ?? "",
      forwardedFor: req.headers.get("x-forwarded-for") ?? "",
    });

    const { socket, response } = Deno.upgradeWebSocket(req);
    const sessionId = `webchat-${crypto.randomUUID()}`;
    attachSocketEventHandlers(socket, sessionId, connections, handlerRef);
    return response;
  }

  return new Response("WebChat OK", { status: 200 });
}

/**
 * Close every active WebSocket connection and clear the tracking map.
 */
function closeAllWebChatConnections(
  connections: Map<string, WebSocket>,
): void {
  for (const [, socket] of connections) {
    try {
      socket.close();
    } catch {
      // Already closed
    }
  }
  connections.clear();
}

/**
 * Serialize and send a message frame to the identified WebSocket client.
 */
function dispatchWebChatFrame(
  message: ChannelMessage,
  connections: Map<string, WebSocket>,
): void {
  if (!message.sessionId) return;

  const socket = connections.get(message.sessionId);
  if (!socket || socket.readyState !== WebSocket.OPEN) return;

  const frame: WsFrame = {
    type: "message",
    content: message.content,
    sessionId: message.sessionId,
  };

  socket.send(JSON.stringify(frame));
}

/**
 * Create a WebChat channel adapter.
 *
 * Starts a WebSocket server on the configured port. Browser chat widgets
 * connect and exchange JSON frames. Each connection is tracked by session ID.
 *
 * @param config - WebChat configuration.
 * @returns A ChannelAdapter wired to WebSocket-based chat.
 */
export function createWebChatChannel(
  config: WebChatConfig = {},
): ChannelAdapter {
  const port = config.port ?? 8765;
  const classification =
    (config.classification ?? "PUBLIC") as ClassificationLevel;
  let connected = false;
  const handlerRef: { current: MessageHandler | null } = { current: null };
  let server: Deno.HttpServer | null = null;
  const connections = new Map<string, WebSocket>();

  return {
    classification,
    isOwner: false,

    // deno-lint-ignore require-await
    async connect(): Promise<void> {
      server = Deno.serve(
        { port },
        (req) => routeWebChatRequest(req, connections, handlerRef, config),
      );
      connected = true;
      log.info("WebChat adapter connected", { port });
    },

    async disconnect(): Promise<void> {
      closeAllWebChatConnections(connections);
      if (server) {
        await server.shutdown();
        server = null;
      }
      connected = false;
      log.info("WebChat adapter disconnected");
    },

    // deno-lint-ignore require-await
    async send(message: ChannelMessage): Promise<void> {
      dispatchWebChatFrame(message, connections);
    },

    onMessage(msgHandler: MessageHandler): void {
      handlerRef.current = msgHandler;
    },

    status(): ChannelStatus {
      return {
        connected,
        channelType: "webchat",
      };
    },
  };
}
