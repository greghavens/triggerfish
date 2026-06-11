/**
 * Tests for Gateway JSON-RPC 2.0 handler.
 */
import { assert, assertEquals } from "@std/assert";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { createEnhancedSessionManager } from "../../src/gateway/sessions.ts";
import { createNotificationService } from "../../src/gateway/notifications/notifications.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import { createSessionManager } from "../../src/core/session/manager.ts";
import type { ChannelId, UserId } from "../../src/core/types/session.ts";

/** Helper: send a JSON-RPC request over WebSocket and get the response. */
async function rpcCall(
  port: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const opened = new Promise<void>((resolve) => {
    ws.addEventListener("open", () => resolve());
  });
  await opened;

  const responsePromise = new Promise<Record<string, unknown>>((resolve) => {
    ws.addEventListener("message", (event) => {
      resolve(JSON.parse(event.data as string));
    });
  });

  ws.send(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  }));

  const result = await responsePromise;
  ws.close();
  return result;
}

Deno.test({
  name: "JSON-RPC: sessions.list returns sessions",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const storage = createMemoryStorage();
    const baseMgr = await createSessionManager(storage);
    const sessions = createEnhancedSessionManager(baseMgr);
    await sessions.create({
      userId: "u1" as UserId,
      channelId: "c1" as ChannelId,
    });

    const server = createGatewayServer({ port: 0, sessionManager: sessions });
    const addr = await server.start();

    try {
      const res = await rpcCall(addr.port, "sessions.list");
      assertEquals(res.jsonrpc, "2.0");
      assert(Array.isArray(res.result));
      assert((res.result as unknown[]).length >= 1);
    } finally {
      await server.stop();
    }
  },
});

Deno.test({
  name: "JSON-RPC: sessions.get retrieves a session",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const storage = createMemoryStorage();
    const baseMgr = await createSessionManager(storage);
    const sessions = createEnhancedSessionManager(baseMgr);
    const created = await sessions.create({
      userId: "u1" as UserId,
      channelId: "c1" as ChannelId,
    });

    const server = createGatewayServer({ port: 0, sessionManager: sessions });
    const addr = await server.start();

    try {
      const res = await rpcCall(addr.port, "sessions.get", { id: created.id });
      assertEquals(res.jsonrpc, "2.0");
      const result = res.result as Record<string, unknown>;
      assertEquals(result.id, created.id);
    } finally {
      await server.stop();
    }
  },
});

Deno.test({
  name: "JSON-RPC: sessions.create creates a new session",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const storage = createMemoryStorage();
    const baseMgr = await createSessionManager(storage);
    const sessions = createEnhancedSessionManager(baseMgr);

    const server = createGatewayServer({ port: 0, sessionManager: sessions });
    const addr = await server.start();

    try {
      const res = await rpcCall(addr.port, "sessions.create", {
        userId: "u2",
        channelId: "c2",
      });
      assertEquals(res.jsonrpc, "2.0");
      const result = res.result as Record<string, unknown>;
      assert(result.id);
      assertEquals(result.taint, "PUBLIC");
    } finally {
      await server.stop();
    }
  },
});

Deno.test({
  name: "JSON-RPC: sessions.send surface is removed (method not found)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const storage = createMemoryStorage();
    const baseMgr = await createSessionManager(storage);
    const sessions = createEnhancedSessionManager(baseMgr);
    const confidential = await sessions.create({
      userId: "u" as UserId,
      channelId: "c" as ChannelId,
    });
    const pub = await sessions.create({
      userId: "u" as UserId,
      channelId: "pub" as ChannelId,
    });

    const server = createGatewayServer({ port: 0, sessionManager: sessions });
    const addr = await server.start();

    try {
      // GATEWAY-3: the RPC surface trusted a caller-supplied
      // targetClassification, so it was removed outright.
      const res = await rpcCall(addr.port, "sessions.send", {
        fromId: confidential.id,
        toId: pub.id,
        content: "secret",
        targetClassification: "PUBLIC",
      });
      assertEquals(res.jsonrpc, "2.0");
      assert(res.error);
      assertEquals((res.error as Record<string, unknown>).code, -32601);
    } finally {
      await server.stop();
    }
  },
});

Deno.test({
  name: "JSON-RPC: notifications.list returns pending notifications",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const storage = createMemoryStorage();
    const notifications = createNotificationService(storage);
    await notifications.deliver({
      userId: "u1" as UserId,
      message: "test msg",
      priority: "normal",
    });

    const server = createGatewayServer({
      port: 0,
      notificationService: notifications,
    });
    const addr = await server.start();

    try {
      const res = await rpcCall(addr.port, "notifications.list", {
        userId: "u1",
      });
      assertEquals(res.jsonrpc, "2.0");
      assert(Array.isArray(res.result));
      assert((res.result as unknown[]).length >= 1);
    } finally {
      await server.stop();
    }
  },
});

Deno.test({
  name: "JSON-RPC: unknown method returns error -32601",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const server = createGatewayServer({ port: 0 });
    const addr = await server.start();

    try {
      const res = await rpcCall(addr.port, "nonexistent.method");
      assertEquals(res.jsonrpc, "2.0");
      assert(res.error);
      assertEquals((res.error as Record<string, unknown>).code, -32601);
    } finally {
      await server.stop();
    }
  },
});
