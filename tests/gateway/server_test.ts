/**
 * Phase 14: Gateway WebSocket, Session Manager & Notifications
 * Tests MUST FAIL until gateway server, enhanced sessions, and notifications are implemented.
 */
import { assert, assertEquals, assertExists } from "@std/assert";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { createEnhancedSessionManager } from "../../src/gateway/sessions.ts";
import { createNotificationService } from "../../src/gateway/notifications/notifications.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import { createSessionManager } from "../../src/core/session/manager.ts";
import type {
  ChannelId,
  SessionId,
  UserId,
} from "../../src/core/types/session.ts";

// --- Gateway server ---

Deno.test("GatewayServer: starts on configurable port", async () => {
  const server = createGatewayServer({ port: 0 }); // port 0 = random available
  try {
    const addr = await server.start();
    assertExists(addr.port);
    assert(addr.port > 0);
  } finally {
    await server.stop();
  }
});

Deno.test("GatewayServer: POST /debug/run-triggers returns 503 when no scheduler", async () => {
  const server = createGatewayServer({ port: 0, token: "test-token" });
  try {
    const addr = await server.start();
    const response = await fetch(
      `http://127.0.0.1:${addr.port}/debug/run-triggers`,
      {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
      },
    );
    assertEquals(response.status, 503);
    const body = await response.json();
    assertEquals(body.error, "Scheduler not configured");
  } finally {
    await server.stop();
  }
});

Deno.test("GatewayServer: POST /debug/run-triggers fires trigger when scheduler present", async () => {
  // Minimal mock scheduler service
  let runTriggerCalled = false;
  const mockScheduler = {
    start() {},
    stop() {},
    cronManager: {
      list: () => [],
      create: () => ({ ok: true as const, value: {} as never }),
      delete: () => ({ ok: true as const, value: undefined }),
      history: () => [],
      recordExecution: () => {},
    },
    webhookHandler: { on: () => {}, handle: async () => {} },
    // deno-lint-ignore require-await
    async handleWebhookRequest() {
      return { ok: false as const, error: "unused" };
    },
    // deno-lint-ignore require-await
    async runTrigger() {
      runTriggerCalled = true;
    },
  };

  const server = createGatewayServer({
    port: 0,
    token: "test-token",
    // deno-lint-ignore no-explicit-any
    schedulerService: mockScheduler as any,
  });
  try {
    const addr = await server.start();
    const response = await fetch(
      `http://127.0.0.1:${addr.port}/debug/run-triggers`,
      {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
      },
    );
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.ok, true);
    // Give the fire-and-forget a moment to execute
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(runTriggerCalled, true);
  } finally {
    await server.stop();
  }
});

Deno.test("GatewayServer: POST /debug/run-triggers fails closed when no token configured", async () => {
  let runTriggerCalled = false;
  const mockScheduler = {
    start() {},
    stop() {},
    cronManager: {
      list: () => [],
      create: () => ({ ok: true as const, value: {} as never }),
      delete: () => ({ ok: true as const, value: undefined }),
      history: () => [],
      recordExecution: () => {},
    },
    webhookHandler: { on: () => {}, handle: async () => {} },
    // deno-lint-ignore require-await
    async handleWebhookRequest() {
      return { ok: false as const, error: "unused" };
    },
    // deno-lint-ignore require-await
    async runTrigger() {
      runTriggerCalled = true;
    },
  };

  // No token configured: the endpoint must reject, never fire the trigger.
  const server = createGatewayServer({
    port: 0,
    // deno-lint-ignore no-explicit-any
    schedulerService: mockScheduler as any,
  });
  try {
    const addr = await server.start();
    const response = await fetch(
      `http://127.0.0.1:${addr.port}/debug/run-triggers`,
      { method: "POST" },
    );
    assertEquals(response.status, 503);
    const body = await response.json();
    assert((body.error as string).includes("Debug endpoint disabled"));
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(runTriggerCalled, false);
  } finally {
    await server.stop();
  }
});

// --- Enhanced session manager ---

Deno.test("EnhancedSessionManager: sessions_list returns active sessions", async () => {
  const storage = createMemoryStorage();
  const baseMgr = await createSessionManager(storage);
  const mgr = createEnhancedSessionManager(baseMgr);
  await mgr.create({ userId: "u" as UserId, channelId: "c" as ChannelId });
  const list = await mgr.sessionsList();
  assert(list.length >= 1);
});

Deno.test("EnhancedSessionManager: sessions_spawn creates background session with PUBLIC taint", async () => {
  const storage = createMemoryStorage();
  const baseMgr = await createSessionManager(storage);
  const mgr = createEnhancedSessionManager(baseMgr);
  const parent = await mgr.create({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  const spawned = await mgr.sessionsSpawn(parent.id, "background task");
  assertEquals(spawned.taint, "PUBLIC");
});

Deno.test("EnhancedSessionManager: sessions_send blocks write-down", async () => {
  const storage = createMemoryStorage();
  const baseMgr = await createSessionManager(storage);
  const mgr = createEnhancedSessionManager(baseMgr);
  const confidential = await mgr.create({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  await mgr.updateTaint(confidential.id, "CONFIDENTIAL", "secret");
  const publicSession = await mgr.create({
    userId: "u" as UserId,
    channelId: "pub" as ChannelId,
  });
  // CONFIDENTIAL -> PUBLIC session should be blocked; the target's taint
  // is derived from the resolved session, never supplied by the caller.
  const result = await mgr.sessionsSend(
    confidential.id,
    publicSession.id,
    "secret data",
  );
  assertEquals(result.ok, false);
});

Deno.test("EnhancedSessionManager: sessions_send fails closed on missing target", async () => {
  const storage = createMemoryStorage();
  const baseMgr = await createSessionManager(storage);
  const mgr = createEnhancedSessionManager(baseMgr);
  const source = await mgr.create({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  const result = await mgr.sessionsSend(
    source.id,
    "nonexistent-session" as SessionId,
    "data",
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assert(result.error.includes("Target session not found"));
  }
});

// --- Notification service ---

Deno.test("NotificationService: queues notification for offline user", async () => {
  const storage = createMemoryStorage();
  const svc = createNotificationService(storage);
  await svc.deliver({
    userId: "u" as UserId,
    message: "test notification",
    priority: "normal",
  });
  const queued = await svc.getPending("u" as UserId);
  assert(queued.length >= 1);
});

Deno.test("NotificationService: persists across service instances", async () => {
  const storage = createMemoryStorage();
  const svc1 = createNotificationService(storage);
  await svc1.deliver({
    userId: "u" as UserId,
    message: "persistent notification",
    priority: "critical",
  });
  // Create a second service instance sharing the same storage
  const svc2 = createNotificationService(storage);
  const queued = await svc2.getPending("u" as UserId);
  assert(queued.length >= 1);
  assertEquals(queued[0].message, "persistent notification");
  assertEquals(queued[0].priority, "critical");
});

Deno.test("NotificationService: acknowledge removes notification", async () => {
  const storage = createMemoryStorage();
  const svc = createNotificationService(storage);
  await svc.deliver({
    userId: "u" as UserId,
    message: "ack me",
    priority: "normal",
  });
  const before = await svc.getPending("u" as UserId);
  assertEquals(before.length, 1);
  await svc.acknowledge(before[0].id);
  const after = await svc.getPending("u" as UserId);
  assertEquals(after.length, 0);
});

// --- Size limit enforcement ---

Deno.test("GatewayServer: JSON-RPC WebSocket rejects messages exceeding 1MB", async () => {
  const server = createGatewayServer({ port: 0 });
  const addr = await server.start();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}`);
    await new Promise<void>((resolve) =>
      ws.addEventListener("open", () => resolve())
    );

    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sessions.list",
        params: { data: "A".repeat(1_100_000) },
      }),
    );

    const responseText = await new Promise<string>((resolve) =>
      ws.addEventListener("message", (e) => resolve(e.data as string))
    );
    ws.close();
    const parsed = JSON.parse(responseText);
    assertEquals(parsed.error?.code, -32600);
    assert((parsed.error?.message as string).includes("too large"));
  } finally {
    await server.stop();
  }
});

Deno.test("GatewayServer: webhook rejects body exceeding 1MB", async () => {
  const mockScheduler = {
    start() {},
    stop() {},
    cronManager: {
      list: () => [],
      create: () => ({ ok: true as const, value: {} as never }),
      delete: () => ({ ok: true as const, value: undefined }),
      history: () => [],
      recordExecution: () => {},
    },
    webhookHandler: { on: () => {}, handle: async () => {} },
    // deno-lint-ignore require-await
    async handleWebhookRequest() {
      return { ok: false as const, error: "unused" };
    },
    async runTrigger() {},
  };

  const server = createGatewayServer({
    port: 0,
    // deno-lint-ignore no-explicit-any
    schedulerService: mockScheduler as any,
  });
  const addr = await server.start();
  try {
    const response = await fetch(
      `http://127.0.0.1:${addr.port}/webhooks/test-source`,
      { method: "POST", body: "X".repeat(1_100_000) },
    );
    assertEquals(response.status, 413);
    const body = await response.json();
    assert((body.error as string).includes("too large"));
  } finally {
    await server.stop();
  }
});

Deno.test("GatewayServer: chat WebSocket rejects messages exceeding 256KB", async () => {
  const mockChat = {
    providerName: "test",
    modelName: "test-model",
    get sessionTaint() {
      return "PUBLIC" as const;
    },
    getMcpStatus: () => null,
    clear() {},
    async compact() {},
    handleSecretPromptResponse(_nonce: string, _value: string | null) {},
    createTidepoolSecretPrompt: () => (_name: string) =>
      Promise.resolve(null as string | null),
    async executeAgentTurn() {},
    async registerChannel() {},
    async handleChannelMessage() {},
  };

  // deno-lint-ignore no-explicit-any
  const server = createGatewayServer({ port: 0, chatSession: mockChat as any });
  const addr = await server.start();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/chat`);
    // Wait for 'connected' event
    await new Promise<void>((resolve) =>
      ws.addEventListener("message", () => resolve())
    );

    ws.send(JSON.stringify({ type: "message", content: "A".repeat(300_000) }));

    // Drain messages until we find the error response (server sends
    // connected, mcp_status, and bumpers_status before our error).
    const parsed = await new Promise<{ type: string; message?: string }>(
      (resolve) => {
        ws.addEventListener("message", function handler(e) {
          const msg = JSON.parse(e.data as string);
          if (msg.type === "error") {
            ws.removeEventListener("message", handler);
            resolve(msg);
          }
        });
      },
    );
    ws.close();
    assertEquals(parsed.type, "error");
    assert((parsed.message as string).includes("too large"));
  } finally {
    await server.stop();
  }
});
