/**
 * Notification service tests — classification, delivery channels, flush.
 */

import { assertEquals } from "@std/assert";
import { createNotificationService } from "../../src/gateway/notifications/notifications.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import type { UserId } from "../../src/core/types/session.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";

const USER = "test-user" as UserId;

// ── Basic deliver + getPending ────────────────────────────────────────

Deno.test("deliver: queues notification when no channels registered", async () => {
  const storage = createMemoryStorage();
  const svc = createNotificationService(storage);

  await svc.deliver({ userId: USER, message: "hello", priority: "normal" });

  const pending = await svc.getPending(USER);
  assertEquals(pending.length, 1);
  assertEquals(pending[0].message, "hello");
  assertEquals(pending[0].priority, "normal");
});

Deno.test("acknowledge: removes notification from pending", async () => {
  const storage = createMemoryStorage();
  const svc = createNotificationService(storage);

  await svc.deliver({ userId: USER, message: "ack me", priority: "normal" });
  const pending = await svc.getPending(USER);
  assertEquals(pending.length, 1);

  await svc.acknowledge(pending[0].id);
  const after = await svc.getPending(USER);
  assertEquals(after.length, 0);
});

// ── Classification field ──────────────────────────────────────────────

Deno.test("deliver: stores classification field", async () => {
  const storage = createMemoryStorage();
  const svc = createNotificationService(storage);

  await svc.deliver({
    userId: USER,
    message: "classified",
    priority: "normal",
    classification: "INTERNAL" as ClassificationLevel,
  });

  const pending = await svc.getPending(USER);
  assertEquals(pending.length, 1);
  assertEquals(pending[0].classification, "INTERNAL");
});

Deno.test("classification persists through serialize/deserialize", async () => {
  const storage = createMemoryStorage();
  const svc = createNotificationService(storage);

  await svc.deliver({
    userId: USER,
    message: "secret",
    priority: "critical",
    classification: "CONFIDENTIAL" as ClassificationLevel,
  });

  // Create a new service instance from the same storage to force deserialization
  const svc2 = createNotificationService(storage);
  const pending = await svc2.getPending(USER);
  assertEquals(pending.length, 1);
  assertEquals(pending[0].classification, "CONFIDENTIAL");
  assertEquals(pending[0].priority, "critical");
  assertEquals(pending[0].message, "secret");
});

Deno.test("deliver: classification is optional", async () => {
  const storage = createMemoryStorage();
  const svc = createNotificationService(storage);

  await svc.deliver({
    userId: USER,
    message: "no classification",
    priority: "low",
  });

  const pending = await svc.getPending(USER);
  assertEquals(pending.length, 1);
  assertEquals(pending[0].classification, undefined);
});

// ── Delivery channels ─────────────────────────────────────────────────

Deno.test("deliver: sends to registered channel and auto-acknowledges", async () => {
  const storage = createMemoryStorage();
  const svc = createNotificationService(storage);
  const delivered: string[] = [];

  svc.registerChannel({
    name: "test",
    classification: "RESTRICTED",
    // deno-lint-ignore require-await
    send: async (msg) => {
      delivered.push(msg);
    },
  });

  await svc.deliver({ userId: USER, message: "push me", priority: "normal" });

  assertEquals(delivered.length, 1);
  assertEquals(delivered[0], "push me");

  // Should be auto-acknowledged (no longer pending)
  const pending = await svc.getPending(USER);
  assertEquals(pending.length, 0);
});

Deno.test("deliver: channel failure leaves notification pending", async () => {
  const storage = createMemoryStorage();
  const svc = createNotificationService(storage);

  svc.registerChannel({
    name: "broken",
    classification: "RESTRICTED",
    // deno-lint-ignore require-await
    send: async () => {
      throw new Error("send failed");
    },
  });

  await svc.deliver({
    userId: USER,
    message: "should stay queued",
    priority: "normal",
  });

  const pending = await svc.getPending(USER);
  assertEquals(pending.length, 1);
  assertEquals(pending[0].message, "should stay queued");
});

Deno.test("deliver: fans out to multiple channels", async () => {
  const storage = createMemoryStorage();
  const svc = createNotificationService(storage);
  const ch1: string[] = [];
  const ch2: string[] = [];

  svc.registerChannel({
    name: "ch1",
    classification: "RESTRICTED",
    // deno-lint-ignore require-await
    send: async (msg) => {
      ch1.push(msg);
    },
  });
  svc.registerChannel({
    name: "ch2",
    classification: "RESTRICTED",
    // deno-lint-ignore require-await
    send: async (msg) => {
      ch2.push(msg);
    },
  });

  await svc.deliver({ userId: USER, message: "broadcast", priority: "normal" });

  assertEquals(ch1.length, 1);
  assertEquals(ch2.length, 1);
  assertEquals((await svc.getPending(USER)).length, 0);
});

Deno.test("deliver: cli-websocket channel receives trigger notifications via fan-out", async () => {
  const storage = createMemoryStorage();
  const svc = createNotificationService(storage);
  const received: string[] = [];

  svc.registerChannel({
    name: "cli-websocket",
    classification: "RESTRICTED",
    // deno-lint-ignore require-await
    send: async (msg) => {
      received.push(msg);
    },
  });

  await svc.deliver({
    userId: USER,
    message: "trigger fired",
    priority: "normal",
  });

  assertEquals(received.length, 1);
  assertEquals(received[0], "trigger fired");
  // Auto-acknowledged after successful delivery
  assertEquals((await svc.getPending(USER)).length, 0);
});

// ── flushPending ──────────────────────────────────────────────────────

Deno.test("flushPending: delivers queued notifications when channel becomes available", async () => {
  const storage = createMemoryStorage();
  const svc = createNotificationService(storage);

  // Deliver with no channels — stays queued
  await svc.deliver({ userId: USER, message: "queued 1", priority: "normal" });
  await svc.deliver({ userId: USER, message: "queued 2", priority: "normal" });
  assertEquals((await svc.getPending(USER)).length, 2);

  // Register a channel and flush
  const delivered: string[] = [];
  svc.registerChannel({
    name: "late",
    classification: "RESTRICTED",
    // deno-lint-ignore require-await
    send: async (msg) => {
      delivered.push(msg);
    },
  });

  const remaining = await svc.flushPending(USER);
  assertEquals(remaining, 0);
  assertEquals(delivered.length, 2);
  assertEquals((await svc.getPending(USER)).length, 0);
});

Deno.test("flushPending: returns count of undelivered notifications", async () => {
  const storage = createMemoryStorage();
  const svc = createNotificationService(storage);

  await svc.deliver({ userId: USER, message: "stuck", priority: "normal" });

  // No channels registered — flush can't deliver
  const remaining = await svc.flushPending(USER);
  assertEquals(remaining, 1);
  assertEquals((await svc.getPending(USER)).length, 1);
});

// ── Fan-out write-down gate (GATEWAY-1) ───────────────────────────────

Deno.test("fanOut gate: CONFIDENTIAL notification suppressed for PUBLIC channel, stays pending", async () => {
  const storage = createMemoryStorage();
  const svc = createNotificationService(storage);
  const sent: string[] = [];

  svc.registerChannel({
    name: "public-telegram",
    classification: "PUBLIC",
    // deno-lint-ignore require-await
    send: async (msg) => {
      sent.push(msg);
    },
  });

  await svc.deliver({
    userId: USER,
    message: "confidential finding",
    priority: "normal",
    classification: "CONFIDENTIAL",
  });

  assertEquals(
    sent.length,
    0,
    "Write-down to a PUBLIC channel must be suppressed",
  );
  assertEquals(
    (await svc.getPending(USER)).length,
    1,
    "Suppressed notification stays queued",
  );
});

Deno.test("fanOut gate: CONFIDENTIAL notification delivered to owner-equivalent channel, suppressed for lower", async () => {
  const storage = createMemoryStorage();
  const svc = createNotificationService(storage);
  const publicSent: string[] = [];
  const ownerSent: string[] = [];

  svc.registerChannel({
    name: "public-telegram",
    classification: "PUBLIC",
    // deno-lint-ignore require-await
    send: async (msg) => {
      publicSent.push(msg);
    },
  });
  svc.registerChannel({
    name: "cli-websocket",
    classification: "RESTRICTED",
    // deno-lint-ignore require-await
    send: async (msg) => {
      ownerSent.push(msg);
    },
  });

  await svc.deliver({
    userId: USER,
    message: "confidential finding",
    priority: "normal",
    classification: "CONFIDENTIAL",
  });

  assertEquals(
    publicSent.length,
    0,
    "PUBLIC channel must not receive CONFIDENTIAL",
  );
  assertEquals(ownerSent.length, 1, "Owner-equivalent channel still delivers");
  assertEquals(
    (await svc.getPending(USER)).length,
    0,
    "Delivered notification is acknowledged",
  );
});

Deno.test("fanOut gate: missing notification classification fails closed to RESTRICTED", async () => {
  const storage = createMemoryStorage();
  const svc = createNotificationService(storage);
  const internalSent: string[] = [];
  const ownerSent: string[] = [];

  svc.registerChannel({
    name: "internal-channel",
    classification: "INTERNAL",
    // deno-lint-ignore require-await
    send: async (msg) => {
      internalSent.push(msg);
    },
  });
  svc.registerChannel({
    name: "tidepool",
    classification: "RESTRICTED",
    // deno-lint-ignore require-await
    send: async (msg) => {
      ownerSent.push(msg);
    },
  });

  // No classification (e.g. healing orchestrator) — unknown sensitivity.
  await svc.deliver({
    userId: USER,
    message: "healing event",
    priority: "normal",
  });

  assertEquals(
    internalSent.length,
    0,
    "Unclassified notification must not reach lower channels",
  );
  assertEquals(ownerSent.length, 1, "RESTRICTED owner channel still delivers");
});

Deno.test("fanOut gate: INTERNAL notification flows up to CONFIDENTIAL channel", async () => {
  const storage = createMemoryStorage();
  const svc = createNotificationService(storage);
  const sent: string[] = [];

  svc.registerChannel({
    name: "confidential-email",
    classification: "CONFIDENTIAL",
    // deno-lint-ignore require-await
    send: async (msg) => {
      sent.push(msg);
    },
  });

  await svc.deliver({
    userId: USER,
    message: "internal note",
    priority: "normal",
    classification: "INTERNAL",
  });

  assertEquals(
    sent.length,
    1,
    "Flow-up to a higher-classified channel is allowed",
  );
});

Deno.test("flushPending: write-down gate also applies to queued notifications", async () => {
  const storage = createMemoryStorage();
  const svc = createNotificationService(storage);

  await svc.deliver({
    userId: USER,
    message: "queued confidential",
    priority: "normal",
    classification: "CONFIDENTIAL",
  });
  assertEquals((await svc.getPending(USER)).length, 1);

  const sent: string[] = [];
  svc.registerChannel({
    name: "public-late",
    classification: "PUBLIC",
    // deno-lint-ignore require-await
    send: async (msg) => {
      sent.push(msg);
    },
  });

  const remaining = await svc.flushPending(USER);
  assertEquals(sent.length, 0, "Flush must not write down to a PUBLIC channel");
  assertEquals(remaining, 1, "Suppressed notification counts as undelivered");
});

Deno.test("deliver reports the first delivery outcome with the existing queue semantics", async () => {
  const service = createNotificationService(createMemoryStorage());
  const outcomes: string[] = [];
  const message = {
    userId: USER,
    message: "Synthetic incident update",
    priority: "normal" as const,
    classification: "INTERNAL" as const,
    onImmediateOutcome: (state: string) => {
      outcomes.push(state);
    },
  };
  await service.deliver(message);
  service.registerChannel({
    name: "internal",
    classification: "INTERNAL",
    send: () => Promise.resolve(),
  });
  await service.deliver(message);
  assertEquals(outcomes, ["queued", "delivered"]);
  assertEquals((await service.getPending(USER)).length, 1);
});

Deno.test("Sentinel reconnect retries only eligible receipts through Tidepool after a service restart", async () => {
  const storage = createMemoryStorage();
  const receipt = { caseId: "fixture", revision: 17 };
  const first = createNotificationService(storage);
  const message = {
    userId: USER,
    message: "Synthetic change",
    priority: "normal" as const,
    classification: "INTERNAL" as const,
  };
  await first.deliver({ ...message, sentinelReceipt: receipt });
  await first.deliver({ ...message, message: "Ordinary notification" });
  let allowed = false;
  const matched: unknown[] = [];
  const restarted = createNotificationService(storage, {
    canRetry: () => allowed,
    onRetryDelivered: (value) => {
      matched.push(value);
    },
  });
  assertEquals(
    Object.hasOwn((await restarted.getPending(USER))[0], "sentinelReceipt"),
    false,
  );
  let external = 0;
  restarted.registerChannel({
    name: "external",
    classification: "RESTRICTED",
    send: () => {
      external++;
      return Promise.resolve();
    },
  });
  const retry = { sentinelTidepoolOnly: true };
  await restarted.flushPending(USER, retry);
  assertEquals(matched.length, 0);
  const messages: string[] = [];
  restarted.registerChannel({
    name: "tidepool",
    classification: "RESTRICTED",
    send: (value) => {
      messages.push(value);
      return Promise.resolve();
    },
  });
  allowed = true;
  await Promise.all([
    restarted.flushPending(USER, retry),
    restarted.flushPending(USER, retry),
  ]);
  assertEquals(matched, [receipt]);
  assertEquals(messages, ["Synthetic change"]);
  assertEquals(external, 0);
  assertEquals(
    (await restarted.getPending(USER)).map(({ message }) => message),
    [
      "Ordinary notification",
    ],
  );
});
