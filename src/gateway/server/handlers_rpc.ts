/**
 * JSON-RPC 2.0 request handlers for the gateway control plane.
 *
 * Dispatches session and notification methods to their respective
 * service implementations. All handlers are pure functions receiving
 * dependencies as parameters.
 *
 * @module
 */

import type { EnhancedSessionManager } from "../sessions.ts";
import type { NotificationService } from "../notifications/notifications.ts";
import type { ChannelId, SessionId, UserId } from "../../core/types/session.ts";

// ─── JSON-RPC types ──────────────────────────────────────────────────────────

/** JSON-RPC 2.0 request. */
export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response. */
export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
}

// ─── JSON-RPC helpers ─────────────────────────────────────────────────────────

/** Build a successful JSON-RPC 2.0 response. */
export function rpcSuccess(
  id: number | string,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

/** Build a JSON-RPC 2.0 error response. */
export function rpcError(
  id: number | string,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ─── Session RPC dispatch ─────────────────────────────────────────────────────

/** Dispatch sessions.list method. */
async function dispatchSessionsList(
  params: Record<string, unknown>,
  sessions: EnhancedSessionManager,
  id: number | string,
): Promise<JsonRpcResponse> {
  const list = await sessions.sessionsList(params.filter as undefined);
  return rpcSuccess(id, list);
}

/** Dispatch sessions.get method. */
async function dispatchSessionsGet(
  params: Record<string, unknown>,
  sessions: EnhancedSessionManager,
  id: number | string,
): Promise<JsonRpcResponse> {
  const sessionId = params.id as string;
  if (!sessionId) return rpcError(id, -32602, "Missing required param: id");
  const session = await sessions.get(sessionId as SessionId);
  if (!session) {
    return rpcError(id, -32602, `Session not found: ${sessionId}`);
  }
  return rpcSuccess(id, session);
}

/** Dispatch sessions.create method. */
async function dispatchSessionsCreate(
  params: Record<string, unknown>,
  sessions: EnhancedSessionManager,
  id: number | string,
): Promise<JsonRpcResponse> {
  const userId = params.userId as string;
  const channelId = params.channelId as string;
  if (!userId || !channelId) {
    return rpcError(id, -32602, "Missing required params: userId, channelId");
  }
  const created = await sessions.create({
    userId: userId as UserId,
    channelId: channelId as ChannelId,
  });
  return rpcSuccess(id, created);
}

/** Dispatch sessions.spawn method. */
async function dispatchSessionsSpawn(
  params: Record<string, unknown>,
  sessions: EnhancedSessionManager,
  id: number | string,
): Promise<JsonRpcResponse> {
  const parentId = params.parentId as string;
  const task = params.task as string;
  if (!parentId) {
    return rpcError(id, -32602, "Missing required param: parentId");
  }
  const spawned = await sessions.sessionsSpawn(
    parentId as SessionId,
    task ?? "background",
  );
  return rpcSuccess(id, spawned);
}

/** Dispatch a sessions.* JSON-RPC method. Returns null if method not recognized. */
// deno-lint-ignore require-await
async function dispatchSessionRpc(
  method: string,
  params: Record<string, unknown>,
  sessions: EnhancedSessionManager,
  id: number | string,
): Promise<JsonRpcResponse | null> {
  switch (method) {
    case "sessions.list":
      return dispatchSessionsList(params, sessions, id);
    case "sessions.get":
      return dispatchSessionsGet(params, sessions, id);
    case "sessions.create":
      return dispatchSessionsCreate(params, sessions, id);
    // "sessions.send" was removed (GATEWAY-3): the RPC surface trusted a
    // caller-supplied targetClassification and had no production consumer.
    // Inter-session sends go through the sessions_send agent tool, which
    // derives classification from the target session's taint.
    case "sessions.spawn":
      return dispatchSessionsSpawn(params, sessions, id);
    default:
      return null;
  }
}

// ─── Notification RPC dispatch ────────────────────────────────────────────────

/** Dispatch notifications.list method. */
async function dispatchNotificationsList(
  params: Record<string, unknown>,
  notifications: NotificationService,
  id: number | string,
): Promise<JsonRpcResponse> {
  const nUserId = params.userId as string;
  if (!nUserId) {
    return rpcError(id, -32602, "Missing required param: userId");
  }
  const pending = await notifications.getPending(nUserId as UserId);
  return rpcSuccess(id, pending);
}

/** Dispatch notifications.acknowledge method. */
async function dispatchNotificationsAcknowledge(
  params: Record<string, unknown>,
  notifications: NotificationService,
  id: number | string,
): Promise<JsonRpcResponse> {
  const notifId = params.notificationId as string;
  if (!notifId) {
    return rpcError(id, -32602, "Missing required param: notificationId");
  }
  await notifications.acknowledge(notifId);
  return rpcSuccess(id, { acknowledged: true });
}

/** Dispatch a notifications.* JSON-RPC method. Returns null if method not recognized. */
// deno-lint-ignore require-await
async function dispatchNotificationRpc(
  method: string,
  params: Record<string, unknown>,
  notifications: NotificationService,
  id: number | string,
): Promise<JsonRpcResponse | null> {
  switch (method) {
    case "notifications.list":
      return dispatchNotificationsList(params, notifications, id);
    case "notifications.acknowledge":
      return dispatchNotificationsAcknowledge(params, notifications, id);
    default:
      return null;
  }
}

// ─── Main JSON-RPC dispatcher ─────────────────────────────────────────────────

/** Try dispatching to a session RPC handler. */
// deno-lint-ignore require-await
async function trySessionDispatch(
  method: string,
  params: Record<string, unknown>,
  sessions: EnhancedSessionManager | undefined,
  id: number | string,
): Promise<JsonRpcResponse | null> {
  if (!method.startsWith("sessions.")) return null;
  if (!sessions) {
    return rpcError(id, -32601, "Session manager not configured");
  }
  return dispatchSessionRpc(method, params, sessions, id);
}

/** Try dispatching to a notification RPC handler. */
// deno-lint-ignore require-await
async function tryNotificationDispatch(
  method: string,
  params: Record<string, unknown>,
  notifications: NotificationService | undefined,
  id: number | string,
): Promise<JsonRpcResponse | null> {
  if (!method.startsWith("notifications.")) return null;
  if (!notifications) {
    return rpcError(id, -32601, "Notification service not configured");
  }
  return dispatchNotificationRpc(method, params, notifications, id);
}

/**
 * Dispatch a JSON-RPC 2.0 request to the appropriate session or notification handler.
 *
 * Returns a JSON-RPC response with either a result or an error.
 */
export async function dispatchJsonRpc(
  request: JsonRpcRequest,
  sessions: EnhancedSessionManager | undefined,
  notifications: NotificationService | undefined,
): Promise<JsonRpcResponse> {
  const { id, method } = request;
  const params = request.params ?? {};

  try {
    const sessionResult = await trySessionDispatch(
      method,
      params,
      sessions,
      id,
    );
    if (sessionResult) return sessionResult;

    const notifResult = await tryNotificationDispatch(
      method,
      params,
      notifications,
      id,
    );
    if (notifResult) return notifResult;

    return rpcError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return rpcError(id, -32603, msg);
  }
}
