/**
 * Phase 4: Session Manager
 * Tests MUST FAIL until session manager is implemented.
 * Tests CRUD, taint propagation, reset, StorageProvider integration.
 */
import { assertEquals, assertExists, assertNotEquals } from "@std/assert";
import { createSessionManager } from "../../src/core/session/manager.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import type {
  ChannelId,
  SessionId,
  UserId,
} from "../../src/core/types/session.ts";

function makeManager() {
  const storage = createMemoryStorage();
  return createSessionManager(storage);
}

Deno.test("SessionManager: create returns session with PUBLIC taint", async () => {
  const mgr = await makeManager();
  const session = await mgr.create({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  assertEquals(session.taint, "PUBLIC");
  assertExists(session.id);
});

Deno.test("SessionManager: get retrieves created session", async () => {
  const mgr = await makeManager();
  const created = await mgr.create({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  const fetched = await mgr.get(created.id);
  assertExists(fetched);
  assertEquals(fetched!.id, created.id);
});

Deno.test("SessionManager: get returns null for nonexistent ID", async () => {
  const mgr = await makeManager();
  const result = await mgr.get("nonexistent" as SessionId);
  assertEquals(result, null);
});

Deno.test("SessionManager: list returns all sessions", async () => {
  const mgr = await makeManager();
  await mgr.create({ userId: "u1" as UserId, channelId: "c" as ChannelId });
  await mgr.create({ userId: "u2" as UserId, channelId: "c" as ChannelId });
  const all = await mgr.list();
  assertEquals(all.length, 2);
});

Deno.test("SessionManager: delete removes session", async () => {
  const mgr = await makeManager();
  const session = await mgr.create({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  await mgr.delete(session.id);
  assertEquals(await mgr.get(session.id), null);
});

Deno.test("SessionManager: taint update escalates only", async () => {
  const mgr = await makeManager();
  const session = await mgr.create({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  const updated = await mgr.updateTaint(
    session.id,
    "CONFIDENTIAL",
    "accessed CRM",
  );
  assertEquals(updated.taint, "CONFIDENTIAL");
  // Try to downgrade — should remain CONFIDENTIAL
  const noDowngrade = await mgr.updateTaint(session.id, "PUBLIC", "attempt");
  assertEquals(noDowngrade.taint, "CONFIDENTIAL");
});

Deno.test("SessionManager: reset clears taint and history", async () => {
  const mgr = await makeManager();
  const session = await mgr.create({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  await mgr.updateTaint(session.id, "RESTRICTED", "secret doc");
  const reset = await mgr.reset(session.id);
  assertEquals(reset.taint, "PUBLIC");
  assertEquals(reset.history.length, 0);
  assertEquals(reset.userId, session.userId);
  assertNotEquals(reset.id, session.id);
});

// --- deserialise validation (CORE-STATE-4) ---

/** Create a session, mutate its persisted record, and return the manager. */
async function persistMutatedSession(
  mutate: (data: Record<string, unknown>) => void,
) {
  const storage = createMemoryStorage();
  const mgr = createSessionManager(storage);
  const created = await mgr.create({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  const key = `sessions:${created.id}`;
  const data = JSON.parse((await storage.get(key))!);
  mutate(data);
  await storage.set(key, JSON.stringify(data));
  return { mgr, id: created.id };
}

Deno.test("SessionManager: missing bumpersEnabled deserialises with bumpers ON", async () => {
  const { mgr, id } = await persistMutatedSession((data) => {
    delete data.bumpersEnabled;
  });
  const fetched = await mgr.get(id);
  assertEquals(fetched!.bumpersEnabled, true);
});

Deno.test("SessionManager: invalid persisted taint coerces to RESTRICTED", async () => {
  const { mgr, id } = await persistMutatedSession((data) => {
    data.taint = "CONFIDENTAL"; // tampered/typo level
  });
  const fetched = await mgr.get(id);
  assertEquals(fetched!.taint, "RESTRICTED");
});

Deno.test("SessionManager: missing persisted taint coerces to RESTRICTED", async () => {
  const { mgr, id } = await persistMutatedSession((data) => {
    delete data.taint;
  });
  const fetched = await mgr.get(id);
  assertEquals(fetched!.taint, "RESTRICTED");
});

Deno.test("SessionManager: valid persisted taint round-trips unchanged", async () => {
  const { mgr, id } = await persistMutatedSession((data) => {
    data.taint = "CONFIDENTIAL";
  });
  const fetched = await mgr.get(id);
  assertEquals(fetched!.taint, "CONFIDENTIAL");
  assertEquals(fetched!.bumpersEnabled, true);
});
