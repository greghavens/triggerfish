/**
 * Gateway server types and request validation.
 *
 * @module
 */

import type { SchedulerService } from "../../scheduler/service_types.ts";
import type { EnhancedSessionManager } from "../sessions.ts";
import type { NotificationService } from "../notifications/notifications.ts";
import type { ChatSession } from "../chat.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("gateway");

// Re-export handler types for backward compatibility
export type { JsonRpcRequest, JsonRpcResponse } from "./handlers.ts";

/** Maximum total bytes across all HTTP headers on WS upgrade. */
export const MAX_GATEWAY_HEADER_BYTES = 8192;

/** Maximum size of an incoming JSON-RPC WebSocket message (1 MB). */
export const MAX_JSONRPC_MESSAGE_BYTES = 1 * 1024 * 1024;

/**
 * Enforce WebSocket upgrade request header size limits.
 *
 * Returns HTTP 431 if total header bytes exceed the limit, null otherwise.
 */
export function enforceGatewayUpgradeHeaders(
  request: Request,
): Response | null {
  let total = 0;
  for (const [k, v] of request.headers.entries()) {
    total += k.length + v.length;
  }
  if (total > MAX_GATEWAY_HEADER_BYTES) {
    log.warn("WebSocket upgrade rejected: headers too large", {
      operation: "enforceGatewayUpgradeHeaders",
      totalHeaderBytes: total,
      limitBytes: MAX_GATEWAY_HEADER_BYTES,
    });
    return new Response("Request Header Fields Too Large", { status: 431 });
  }
  return null;
}

/** @deprecated Use enforceGatewayUpgradeHeaders instead */
export const validateGatewayUpgradeHeaders = enforceGatewayUpgradeHeaders;

/** Options for creating a gateway server. */
export interface GatewayServerOptions {
  /** Port to listen on. Use 0 for a random available port. */
  readonly port?: number;
  /** Authentication token for connections. When set, all WebSocket upgrades and the debug endpoint require a matching Bearer token. */
  readonly token?: string;
  /** Allowed WebSocket Origin headers. Use `["*"]` to permit any origin, `["null"]` for file:// origins. When omitted or empty, all origins are permitted. */
  readonly allowedOrigins?: readonly string[];
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
  /**
   * Broadcast a trigger/scheduler notification to all connected /chat WebSocket clients.
   */
  broadcastNotification(message: string): void;
}
