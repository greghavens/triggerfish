/**
 * Phase 17: Cron, Triggers & Webhooks — full test suite.
 */
import { assert, assertEquals, assertExists } from "@std/assert";
import {
  createCronManager,
  createPersistentCronManager,
  matchesNow,
  parseCronExpression,
} from "../../src/scheduler/cron/cron.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import { createTrigger } from "../../src/scheduler/triggers/trigger.ts";
import {
  computeHmac,
  createWebhookHandler,
  verifyHmacAsync,
} from "../../src/scheduler/webhooks/webhooks.ts";
import { createSchedulerService } from "../../src/scheduler/service.ts";
import type {
  OrchestratorCreateOptions,
  OrchestratorFactory,
  SchedulerServiceConfig,
} from "../../src/scheduler/service_types.ts";

// ── Cron Parser ──────────────────────────────────────────────────────

Deno.test("parseCronExpression: parses '*/5 * * * *' (every 5 minutes)", () => {
  const expr = parseCronExpression("*/5 * * * *");
  assertEquals(expr.ok, true);
});

Deno.test("parseCronExpression: rejects invalid expression", () => {
  const expr = parseCronExpression("not a cron");
  assertEquals(expr.ok, false);
});

// ── CronManager ──────────────────────────────────────────────────────

Deno.test("CronManager: creates job with classification ceiling", () => {
  const mgr = createCronManager();
  const job = mgr.create({
    expression: "0 9 * * *",
    task: "morning briefing",
    classificationCeiling: "INTERNAL",
  });
  assertEquals(job.ok, true);
  if (job.ok) {
    assertExists(job.value.id);
    assertEquals(job.value.classificationCeiling, "INTERNAL");
  }
});

Deno.test("CronManager: list returns all jobs", () => {
  const mgr = createCronManager();
  mgr.create({
    expression: "0 9 * * *",
    task: "a",
    classificationCeiling: "PUBLIC",
  });
  mgr.create({
    expression: "0 17 * * *",
    task: "b",
    classificationCeiling: "PUBLIC",
  });
  const jobs = mgr.list();
  assertEquals(jobs.length, 2);
});

Deno.test("CronManager: recordExecution stores history", () => {
  const mgr = createCronManager();
  const result = mgr.create({
    expression: "0 9 * * *",
    task: "test",
    classificationCeiling: "PUBLIC",
  });
  assert(result.ok);
  if (!result.ok) return;

  const jobId = result.value.id;
  mgr.recordExecution({
    jobId,
    executedAt: new Date(),
    durationMs: 123,
    success: true,
  });
  mgr.recordExecution({
    jobId,
    executedAt: new Date(),
    durationMs: 456,
    success: false,
    error: "test error",
  });

  const hist = mgr.history(jobId);
  assertEquals(hist.length, 2);
  assertEquals(hist[0].success, true);
  assertEquals(hist[1].success, false);
  assertEquals(hist[1].error, "test error");
});

// ── matchesNow ───────────────────────────────────────────────────────

Deno.test("matchesNow: matches specific time", () => {
  const result = parseCronExpression("30 14 * * *"); // 14:30 every day
  assert(result.ok);
  if (!result.ok) return;

  // Feb 9, 2026 14:30 is a Monday (day 1)
  const matching = new Date(2026, 1, 9, 14, 30, 0);
  assertEquals(matchesNow(result.value, matching), true);

  // Wrong minute
  const wrongMin = new Date(2026, 1, 9, 14, 31, 0);
  assertEquals(matchesNow(result.value, wrongMin), false);

  // Wrong hour
  const wrongHour = new Date(2026, 1, 9, 15, 30, 0);
  assertEquals(matchesNow(result.value, wrongHour), false);
});

Deno.test("matchesNow: matches step expression", () => {
  const result = parseCronExpression("*/15 * * * *"); // every 15 mins
  assert(result.ok);
  if (!result.ok) return;

  assertEquals(matchesNow(result.value, new Date(2026, 0, 1, 0, 0)), true); // :00
  assertEquals(matchesNow(result.value, new Date(2026, 0, 1, 0, 15)), true); // :15
  assertEquals(matchesNow(result.value, new Date(2026, 0, 1, 0, 30)), true); // :30
  assertEquals(matchesNow(result.value, new Date(2026, 0, 1, 0, 45)), true); // :45
  assertEquals(matchesNow(result.value, new Date(2026, 0, 1, 0, 7)), false); // :07
});

Deno.test("matchesNow: matches day-of-week", () => {
  const result = parseCronExpression("0 9 * * 1"); // Mon at 09:00
  assert(result.ok);
  if (!result.ok) return;

  // Feb 9, 2026 is Monday
  assertEquals(matchesNow(result.value, new Date(2026, 1, 9, 9, 0)), true);
  // Feb 10, 2026 is Tuesday
  assertEquals(matchesNow(result.value, new Date(2026, 1, 10, 9, 0)), false);
});

Deno.test("matchesNow: matches month field", () => {
  const result = parseCronExpression("0 0 1 6 *"); // Jun 1st at midnight
  assert(result.ok);
  if (!result.ok) return;

  // June 1, 2026 at midnight (Sunday = 0)
  assertEquals(matchesNow(result.value, new Date(2026, 5, 1, 0, 0)), true);
  // July 1, 2026 at midnight
  assertEquals(matchesNow(result.value, new Date(2026, 6, 1, 0, 0)), false);
});

// ── Trigger ──────────────────────────────────────────────────────────

Deno.test("Trigger: fires callback at interval", async () => {
  let fired = 0;
  const hb = createTrigger({
    intervalMs: 50,
    // deno-lint-ignore require-await
    callback: async () => {
      fired++;
    },
    classificationCeiling: "PUBLIC",
  });
  hb.start();
  await new Promise((r) => setTimeout(r, 180));
  hb.stop();
  assert(fired >= 2, `Expected at least 2 fires, got ${fired}`);
});

Deno.test("Trigger: respects quiet hours", async () => {
  let fired = 0;
  const hb = createTrigger({
    intervalMs: 50,
    // deno-lint-ignore require-await
    callback: async () => {
      fired++;
    },
    classificationCeiling: "PUBLIC",
    quietHours: { start: 0, end: 24 }, // All hours are quiet
  });
  hb.start();
  await new Promise((r) => setTimeout(r, 150));
  hb.stop();
  assertEquals(fired, 0);
});

// ── verifyHmacAsync ──────────────────────────────────────────────────

Deno.test("verifyHmacAsync: accepts valid signature", async () => {
  const secret = "webhook-secret-123";
  const body = '{"event":"push","data":{"ref":"main"}}';
  const sig = await computeHmac(body, secret);
  const valid = await verifyHmacAsync(body, sig, secret);
  assertEquals(valid, true);
});

Deno.test("verifyHmacAsync: rejects tampered payload", async () => {
  const secret = "webhook-secret-123";
  const body = '{"event":"push"}';
  const sig = await computeHmac(body, secret);
  const valid = await verifyHmacAsync(body + "tampered", sig, secret);
  assertEquals(valid, false);
});

Deno.test("verifyHmacAsync: rejects wrong secret", async () => {
  const body = '{"event":"push"}';
  const sig = await computeHmac(body, "correct-secret");
  const valid = await verifyHmacAsync(body, sig, "wrong-secret");
  assertEquals(valid, false);
});

Deno.test("verifyHmacAsync: rejects malformed signature", async () => {
  assertEquals(await verifyHmacAsync("body", "noseparator", "sec"), false);
  assertEquals(await verifyHmacAsync("body", "md5=abc", "sec"), false);
  assertEquals(await verifyHmacAsync("body", "", "sec"), false);
});

// ── computeHmac ──────────────────────────────────────────────────────

Deno.test("computeHmac: returns sha256= prefixed hex", async () => {
  const sig = await computeHmac("hello", "secret");
  assert(sig.startsWith("sha256="), "Should start with sha256=");
  const hex = sig.slice(7);
  assertEquals(hex.length, 64, "SHA-256 hex should be 64 chars");
  assert(/^[0-9a-f]+$/.test(hex), "Should be lowercase hex");
});

// ── WebhookHandler ───────────────────────────────────────────────────

Deno.test("WebhookHandler: routes events to handlers", async () => {
  const handler = createWebhookHandler();
  let received: unknown = null;
  // deno-lint-ignore require-await
  handler.on("push", async (event) => {
    received = event;
  });
  await handler.handleWebhookEvent({ event: "push", data: { ref: "main" } });
  assertExists(received);
});

Deno.test("WebhookHandler: ignores unregistered event types", async () => {
  const handler = createWebhookHandler();
  let called = false;
  // deno-lint-ignore require-await
  handler.on("push", async () => {
    called = true;
  });
  await handler.handleWebhookEvent({ event: "release", data: {} });
  assertEquals(called, false);
});

// ── SchedulerService ─────────────────────────────────────────────────

/** Create a mock OrchestratorFactory that records calls and options. */
function createMockFactory(): {
  factory: OrchestratorFactory;
  calls: string[];
  options: (OrchestratorCreateOptions | undefined)[];
} {
  const calls: string[] = [];
  const options: (OrchestratorCreateOptions | undefined)[] = [];
  const factory: OrchestratorFactory = {
    // deno-lint-ignore require-await
    async create(channelId: string, opts?: OrchestratorCreateOptions) {
      calls.push(channelId);
      options.push(opts);
      return {
        orchestrator: {
          // deno-lint-ignore require-await
          executeAgentTurn: async () => ({
            ok: true as const,
            value: {
              response: "done",
              tokenUsage: { inputTokens: 100, outputTokens: 50 },
            },
          }),
          // deno-lint-ignore no-explicit-any
        } as any,
        session: {
          id: "mock-session",
          taint: "PUBLIC",
          createdAt: new Date(),
          lastActivityAt: new Date(),
          messages: [],
          context: {},
          // deno-lint-ignore no-explicit-any
        } as any,
        toolExecutor: () => Promise.resolve("mock tool result"),
      };
    },
  };
  return { factory, calls, options };
}

function createTestConfig(
  factory: OrchestratorFactory,
  overrides?: Partial<SchedulerServiceConfig>,
): SchedulerServiceConfig {
  return {
    orchestratorFactory: factory,
    triggerMdPath: "/tmp/nonexistent-trigger.md",
    trigger: {
      enabled: false,
      intervalMinutes: 30,
      classificationCeiling: "INTERNAL",
    },
    webhooks: {
      enabled: true,
      maxAgeMs: 0, // Disable timestamp enforcement in unit tests
      sources: {
        github: { secret: "gh-secret", classification: "INTERNAL" },
      },
    },
    ...overrides,
  };
}

/** Config with timestamp enforcement enabled (5-minute window). */
function createTimestampConfig(
  factory: OrchestratorFactory,
): SchedulerServiceConfig {
  return {
    orchestratorFactory: factory,
    triggerMdPath: "/tmp/nonexistent-trigger.md",
    trigger: {
      enabled: false,
      intervalMinutes: 30,
      classificationCeiling: "INTERNAL",
    },
    webhooks: {
      enabled: true,
      maxAgeMs: 300_000,
      sources: {
        github: { secret: "gh-secret", classification: "INTERNAL" },
      },
    },
  };
}

Deno.test("SchedulerService: start and stop without error", () => {
  const { factory } = createMockFactory();
  const svc = createSchedulerService(createTestConfig(factory));
  svc.start();
  svc.stop();
});

Deno.test("SchedulerService: webhook rejects when disabled", async () => {
  const { factory } = createMockFactory();
  const svc = createSchedulerService(createTestConfig(factory, {
    webhooks: { enabled: false, sources: {} },
  }));

  const result = await svc.handleWebhookRequest("github", "{}", {
    signature: "sha256=abc",
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error, "Webhooks are disabled");
  }
});

Deno.test("SchedulerService: webhook rejects unknown source", async () => {
  const { factory } = createMockFactory();
  const svc = createSchedulerService(createTestConfig(factory));

  const result = await svc.handleWebhookRequest("unknown", "{}", {
    signature: "sha256=abc",
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assert(result.error.includes("Unknown webhook source"));
  }
});

Deno.test("SchedulerService: webhook rejects invalid signature", async () => {
  const { factory } = createMockFactory();
  const svc = createSchedulerService(createTestConfig(factory));

  const body = '{"event":"push","data":{}}';
  const result = await svc.handleWebhookRequest("github", body, {
    signature: "sha256=bad",
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error, "Invalid HMAC signature");
  }
});

Deno.test("SchedulerService: webhook processes valid request", async () => {
  const { factory, calls } = createMockFactory();
  const svc = createSchedulerService(createTestConfig(factory));

  const body = '{"event":"push","data":{"ref":"main"}}';
  const sig = await computeHmac(body, "gh-secret");
  const result = await svc.handleWebhookRequest("github", body, {
    signature: sig,
  });
  assertEquals(result.ok, true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0], "webhook-github");
});

Deno.test("SchedulerService: webhook dispatches to event handler", async () => {
  const { factory } = createMockFactory();
  const svc = createSchedulerService(createTestConfig(factory));

  let receivedEvent: unknown = null;
  // deno-lint-ignore require-await
  svc.webhookHandler.on("push", async (evt) => {
    receivedEvent = evt;
  });

  const body = '{"event":"push","data":{"ref":"main"}}';
  const sig = await computeHmac(body, "gh-secret");
  await svc.handleWebhookRequest("github", body, { signature: sig });

  assertExists(receivedEvent);
});

Deno.test("SchedulerService: cron manager is accessible", () => {
  const { factory } = createMockFactory();
  const svc = createSchedulerService(createTestConfig(factory));

  const result = svc.cronManager.create({
    expression: "0 9 * * *",
    task: "morning check",
    classificationCeiling: "PUBLIC",
  });
  assert(result.ok);
  assertEquals(svc.cronManager.list().length, 1);
});

Deno.test("SchedulerService: uses injected cronManager", () => {
  const { factory } = createMockFactory();
  const mgr = createCronManager();
  mgr.create({
    expression: "0 9 * * *",
    task: "pre-existing",
    classificationCeiling: "PUBLIC",
  });

  const svc = createSchedulerService({
    ...createTestConfig(factory),
    cronManager: mgr,
  });

  assertEquals(svc.cronManager.list().length, 1);
  assertEquals(svc.cronManager.list()[0].task, "pre-existing");
});

// ── Persistent CronManager ───────────────────────────────────────────

Deno.test("PersistentCronManager: creates and persists jobs", async () => {
  const storage = createMemoryStorage();

  const mgr = await createPersistentCronManager(storage);
  const result = mgr.create({
    expression: "0 9 * * *",
    task: "persistent task",
    classificationCeiling: "INTERNAL",
  });
  assert(result.ok);
  if (!result.ok) return;

  // Verify the job is in memory
  assertEquals(mgr.list().length, 1);
  assertEquals(mgr.list()[0].task, "persistent task");

  // Verify the job was written to storage
  const keys = await storage.list("cron:");
  assertEquals(keys.length, 1);
  assert(keys[0].startsWith("cron:"));
});

Deno.test("PersistentCronManager: loads jobs on creation", async () => {
  const storage = createMemoryStorage();

  // Create a job with one manager instance
  const mgr1 = await createPersistentCronManager(storage);
  const result = mgr1.create({
    expression: "*/5 * * * *",
    task: "reload test",
    classificationCeiling: "PUBLIC",
  });
  assert(result.ok);

  // Create a second manager from the same storage — should load the job
  const mgr2 = await createPersistentCronManager(storage);
  assertEquals(mgr2.list().length, 1);
  assertEquals(mgr2.list()[0].task, "reload test");
});

Deno.test("PersistentCronManager: delete removes from storage", async () => {
  const storage = createMemoryStorage();

  const mgr = await createPersistentCronManager(storage);
  const result = mgr.create({
    expression: "0 12 * * *",
    task: "to delete",
    classificationCeiling: "PUBLIC",
  });
  assert(result.ok);
  if (!result.ok) return;

  mgr.delete(result.value.id);
  assertEquals(mgr.list().length, 0);

  // Verify removed from storage
  const keys = await storage.list("cron:");
  assertEquals(keys.length, 0);
});

Deno.test("PersistentCronManager: records execution history to storage", async () => {
  const storage = createMemoryStorage();

  const mgr = await createPersistentCronManager(storage);
  const result = mgr.create({
    expression: "0 8 * * *",
    task: "history test",
    classificationCeiling: "PUBLIC",
  });
  assert(result.ok);
  if (!result.ok) return;

  const jobId = result.value.id;
  mgr.recordExecution({
    jobId,
    executedAt: new Date(2026, 1, 9, 8, 0),
    durationMs: 500,
    success: true,
  });

  // Verify in memory
  assertEquals(mgr.history(jobId).length, 1);

  // Verify in storage — reload a new manager
  const mgr2 = await createPersistentCronManager(storage);
  const hist = mgr2.history(jobId);
  assertEquals(hist.length, 1);
  assertEquals(hist[0].success, true);
  assertEquals(hist[0].durationMs, 500);
});

// ── Notification delivery wiring ─────────────────────────────────────

import { createNotificationService } from "../../src/gateway/notifications/notifications.ts";
import type { UserId } from "../../src/core/types/session.ts";

Deno.test("SchedulerService: webhook output delivered via notificationService", async () => {
  const storage = createMemoryStorage();
  const notificationService = createNotificationService(storage);
  const ownerId = "test-owner" as UserId;

  const { factory, calls } = createMockFactory();
  const svc = createSchedulerService({
    ...createTestConfig(factory),
    notificationService,
    ownerId,
  });

  const body = '{"event":"push","data":{"ref":"main"}}';
  const sig = await computeHmac(body, "gh-secret");
  const result = await svc.handleWebhookRequest("github", body, {
    signature: sig,
  });
  assertEquals(result.ok, true);
  assertEquals(calls.length, 1);

  // Notification should be queued
  const pending = await notificationService.getPending(ownerId);
  assertEquals(pending.length, 1);
  assert(pending[0].message.includes("[webhook:github]"));
  assert(pending[0].message.includes("done"));
  assertEquals(pending[0].classification, "PUBLIC"); // mock session taint
});

Deno.test("SchedulerService: delivery failure does not crash scheduler", async () => {
  const storage = createMemoryStorage();
  const notificationService = createNotificationService(storage);
  // Register a failing channel — delivery should fail gracefully
  notificationService.registerChannel({
    name: "broken",
    // deno-lint-ignore require-await
    send: async () => {
      throw new Error("delivery boom");
    },
  });
  const ownerId = "test-owner" as UserId;

  const { factory } = createMockFactory();
  const svc = createSchedulerService({
    ...createTestConfig(factory),
    notificationService,
    ownerId,
  });

  const body = '{"event":"push","data":{"ref":"main"}}';
  const sig = await computeHmac(body, "gh-secret");
  // Should not throw
  const result = await svc.handleWebhookRequest("github", body, {
    signature: sig,
  });
  assertEquals(result.ok, true);

  // Notification should still be stored despite channel failure
  const pending = await notificationService.getPending(ownerId);
  assertEquals(pending.length, 1);
});

Deno.test("SchedulerService: no error when notificationService is absent", async () => {
  const { factory, calls } = createMockFactory();
  const svc = createSchedulerService(createTestConfig(factory));

  const body = '{"event":"push","data":{"ref":"main"}}';
  const sig = await computeHmac(body, "gh-secret");
  // Should not throw even without notificationService
  const result = await svc.handleWebhookRequest("github", body, {
    signature: sig,
  });
  assertEquals(result.ok, true);
  assertEquals(calls.length, 1);
});

// ── CLI cron command parsing ─────────────────────────────────────────

import { parseCommand } from "../../src/cli/main.ts";

Deno.test("CLI: parses 'cron list' command", () => {
  const cmd = parseCommand(["cron", "list"]);
  assertEquals(cmd.command, "cron");
  assertEquals(cmd.subcommand, "list");
});

Deno.test("CLI: parses 'cron add' with expression and task", () => {
  const cmd = parseCommand(["cron", "add", "0 9 * * *", "morning", "briefing"]);
  assertEquals(cmd.command, "cron");
  assertEquals(cmd.subcommand, "add");
  assertEquals(cmd.flags["expression"], "0 9 * * *");
  assertEquals(cmd.flags["task"], "morning briefing");
});

Deno.test("CLI: parses 'cron delete' with job ID", () => {
  const cmd = parseCommand(["cron", "delete", "abc-123"]);
  assertEquals(cmd.command, "cron");
  assertEquals(cmd.subcommand, "delete");
  assertEquals(cmd.flags["job_id"], "abc-123");
});

Deno.test("CLI: parses 'cron history' with job ID", () => {
  const cmd = parseCommand(["cron", "history", "abc-123"]);
  assertEquals(cmd.command, "cron");
  assertEquals(cmd.subcommand, "history");
  assertEquals(cmd.flags["job_id"], "abc-123");
});

// ── OrchestratorFactory trigger options ──────────────────────────────

Deno.test("OrchestratorFactory: create() accepts isTrigger option", async () => {
  const { factory, options } = createMockFactory();
  await factory.create("trigger", { isTrigger: true, ceiling: "CONFIDENTIAL" });
  assertEquals(options.length, 1);
  assertEquals(options[0]?.isTrigger, true);
  assertEquals(options[0]?.ceiling, "CONFIDENTIAL");
});

Deno.test("OrchestratorFactory: create() works without options (cron/subagent)", async () => {
  const { factory, options } = createMockFactory();
  await factory.create("cron");
  assertEquals(options.length, 1);
  assertEquals(options[0], undefined);
});

// ── Token usage logging ──────────────────────────────────────────────

/**
 * Create a factory whose orchestrator returns a specific tokenUsage.
 * Used to verify the scheduler correctly handles and logs token data.
 */
function createTokenAwareMockFactory(
  tokenUsage: { inputTokens: number; outputTokens: number },
): {
  factory: OrchestratorFactory;
  calls: string[];
} {
  const calls: string[] = [];
  const factory: OrchestratorFactory = {
    // deno-lint-ignore require-await
    async create(channelId: string) {
      calls.push(channelId);
      return {
        orchestrator: {
          // deno-lint-ignore require-await
          executeAgentTurn: async () => ({
            ok: true as const,
            value: { response: "token test response", tokenUsage },
          }),
          // deno-lint-ignore no-explicit-any
        } as any,
        session: {
          id: "mock-session",
          taint: "PUBLIC",
          createdAt: new Date(),
          lastActivityAt: new Date(),
          messages: [],
          context: {},
          // deno-lint-ignore no-explicit-any
        } as any,
        toolExecutor: () => Promise.resolve("mock tool result"),
      };
    },
  };
  return { factory, calls };
}

Deno.test("SchedulerService: token usage from executeAgentTurn is logged without error (webhook)", async () => {
  const { factory } = createTokenAwareMockFactory({
    inputTokens: 1234,
    outputTokens: 567,
  });
  const svc = createSchedulerService(createTestConfig(factory));

  const body = '{"event":"push","data":{"ref":"main"}}';
  const sig = await computeHmac(body, "gh-secret");
  // Should succeed — the token logging code path runs without throwing
  const result = await svc.handleWebhookRequest("github", body, {
    signature: sig,
  });
  assertEquals(result.ok, true);
});

Deno.test("SchedulerService: runTrigger() fires trigger callback immediately", async () => {
  const triggerPath = "/tmp/test-trigger-runTrigger.md";
  await Deno.writeTextFile(triggerPath, "# Test Trigger\nCheck for updates.");
  try {
    const { factory, calls, options } = createMockFactory();
    const svc = createSchedulerService(
      createTestConfig(factory, { triggerMdPath: triggerPath }),
    );

    await svc.runTrigger();

    // The trigger callback should have created exactly one orchestrator session
    assertEquals(calls.length, 1);
    assertEquals(calls[0], "trigger");
    assertEquals(options[0]?.isTrigger, true);
  } finally {
    await Deno.remove(triggerPath).catch(() => {});
  }
});

// ── Replay prevention ────────────────────────────────────────────────

Deno.test("SchedulerService: webhook rejects replayed request (same signature)", async () => {
  const { factory } = createMockFactory();
  const svc = createSchedulerService(createTestConfig(factory));

  const body = '{"event":"push","data":{"ref":"replay-test"}}';
  const sig = await computeHmac(body, "gh-secret");

  const first = await svc.handleWebhookRequest("github", body, {
    signature: sig,
  });
  assertEquals(first.ok, true);

  const replay = await svc.handleWebhookRequest("github", body, {
    signature: sig,
  });
  assertEquals(replay.ok, false);
  if (!replay.ok) {
    assert(replay.error.includes("Replay"));
  }
});

// ── Timestamp validation ─────────────────────────────────────────────

Deno.test("SchedulerService: webhook rejects missing timestamp when maxAgeMs configured", async () => {
  const { factory } = createMockFactory();
  const svc = createSchedulerService(createTimestampConfig(factory));
  const body = '{"event":"push","data":{}}';
  const sig = await computeHmac(body, "gh-secret");
  // No timestamp in context → rejected
  const result = await svc.handleWebhookRequest("github", body, {
    signature: sig,
  });
  assertEquals(result.ok, false);
  if (!result.ok) assert(result.error.includes("timestamp"));
});

Deno.test("SchedulerService: webhook rejects expired timestamp", async () => {
  const { factory } = createMockFactory();
  const svc = createSchedulerService(createTimestampConfig(factory));
  const body = '{"event":"push","data":{}}';
  const sig = await computeHmac(body, "gh-secret");
  const expired = String(Date.now() - 600_000); // 10 minutes ago (5-min window)
  const result = await svc.handleWebhookRequest("github", body, {
    signature: sig,
    timestamp: expired,
  });
  assertEquals(result.ok, false);
  if (!result.ok) assert(result.error.includes("timestamp"));
});

Deno.test("SchedulerService: webhook accepts valid recent timestamp", async () => {
  const { factory } = createMockFactory();
  const svc = createSchedulerService(createTimestampConfig(factory));
  const body = '{"event":"push","data":{}}';
  const sig = await computeHmac(body, "gh-secret");
  const result = await svc.handleWebhookRequest("github", body, {
    signature: sig,
    timestamp: String(Date.now()),
  });
  assertEquals(result.ok, true);
});

// ── Rate limiting ────────────────────────────────────────────────────

Deno.test("SchedulerService: webhook rate limiter blocks requests beyond burst limit", async () => {
  const { factory } = createMockFactory();
  const svc = createSchedulerService({
    ...createTestConfig(factory),
    webhooks: {
      enabled: true,
      maxAgeMs: 0,
      rateLimit: { perMinute: 60, burst: 2 }, // burst=2 for fast test
      sources: { github: { secret: "gh-secret", classification: "INTERNAL" } },
    },
  });

  // First 2 requests succeed (within burst)
  for (let i = 0; i < 2; i++) {
    const body = `{"event":"push","data":{"ref":"${i}"}}`;
    const sig = await computeHmac(body, "gh-secret");
    const result = await svc.handleWebhookRequest("github", body, {
      signature: sig,
    });
    assertEquals(result.ok, true, `Request ${i} should succeed`);
  }

  // 3rd request exceeds burst
  const body3 = '{"event":"push","data":{"ref":"overflow"}}';
  const sig3 = await computeHmac(body3, "gh-secret");
  const limited = await svc.handleWebhookRequest("github", body3, {
    signature: sig3,
  });
  assertEquals(limited.ok, false);
  if (!limited.ok) {
    assert(limited.error.includes("Rate limit"));
  }
});

Deno.test("SchedulerService: trigger callback passes isTrigger=true and ceiling to factory", async () => {
  const triggerPath = "/tmp/test-trigger-isTrigger.md";
  await Deno.writeTextFile(triggerPath, "# Test Trigger\nCheck for updates.");
  try {
    const { factory, options } = createMockFactory();
    const config: SchedulerServiceConfig = {
      orchestratorFactory: factory,
      triggerMdPath: triggerPath,
      trigger: {
        enabled: true,
        intervalMinutes: 1,
        classificationCeiling: "CONFIDENTIAL",
      },
      webhooks: { enabled: false, sources: {} },
    };

    const svc = createSchedulerService(config);
    // Use runTrigger() to fire the trigger callback synchronously
    // (start() only sets up an interval timer without an immediate fire)
    await svc.runTrigger();

    // Verify the factory was called with trigger options
    const triggerCall = options.find((o) => o?.isTrigger === true);
    assert(
      triggerCall !== undefined,
      "Expected trigger to call factory with isTrigger=true",
    );
    assertEquals(triggerCall?.ceiling, "CONFIDENTIAL");
  } finally {
    await Deno.remove(triggerPath).catch(() => {});
  }
});
