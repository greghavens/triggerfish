/**
 * Tests for per-user session management.
 *
 * Validates that UserSessionManager correctly creates, caches, and
 * classifies sessions for non-owner channel users.
 *
 * @module
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  createUserSessionManager,
  parseUserOverrides,
} from "../../src/channels/user_sessions.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";

Deno.test("UserSessionManager — creates session with correct userId and channelId", () => {
  const mgr = createUserSessionManager({
    channelDefault: "PUBLIC" as ClassificationLevel,
    userOverrides: new Map(),
  });

  const session = mgr.getOrCreate("telegram", "12345");
  assertEquals(session.userId, "12345");
  assertEquals(session.channelId, "telegram-user");
});

Deno.test("UserSessionManager — returns cached session on second call", () => {
  const mgr = createUserSessionManager({
    channelDefault: "PUBLIC" as ClassificationLevel,
    userOverrides: new Map(),
  });

  const first = mgr.getOrCreate("telegram", "12345");
  const second = mgr.getOrCreate("telegram", "12345");
  assertEquals(first.id, second.id);
});

Deno.test("UserSessionManager — applies user classification overrides from config", () => {
  const overrides = new Map<string, ClassificationLevel>([
    ["67890", "CONFIDENTIAL" as ClassificationLevel],
  ]);
  const mgr = createUserSessionManager({
    channelDefault: "PUBLIC" as ClassificationLevel,
    userOverrides: overrides,
  });

  assertEquals(mgr.getClassification("67890"), "CONFIDENTIAL");
});

Deno.test("UserSessionManager — falls back to channel default for unknown users", () => {
  const mgr = createUserSessionManager({
    channelDefault: "INTERNAL" as ClassificationLevel,
    userOverrides: new Map(),
  });

  assertEquals(mgr.getClassification("99999"), "INTERNAL");
});

Deno.test("UserSessionManager — different users get different session IDs", () => {
  const mgr = createUserSessionManager({
    channelDefault: "PUBLIC" as ClassificationLevel,
    userOverrides: new Map(),
  });

  const alice = mgr.getOrCreate("telegram", "alice");
  const bob = mgr.getOrCreate("telegram", "bob");
  assertNotEquals(alice.id, bob.id);
});

Deno.test("UserSessionManager — sessions start at PUBLIC taint", () => {
  const mgr = createUserSessionManager({
    channelDefault: "INTERNAL" as ClassificationLevel,
    userOverrides: new Map(),
  });

  const session = mgr.getOrCreate("discord", "user1");
  assertEquals(session.taint, "PUBLIC");
});

Deno.test("UserSessionManager — getSession returns undefined for unknown user", () => {
  const mgr = createUserSessionManager({
    channelDefault: "PUBLIC" as ClassificationLevel,
    userOverrides: new Map(),
  });

  assertEquals(mgr.getSession("telegram", "unknown"), undefined);
});

Deno.test("UserSessionManager — updateSession persists updated state", () => {
  const mgr = createUserSessionManager({
    channelDefault: "PUBLIC" as ClassificationLevel,
    userOverrides: new Map(),
  });

  const session = mgr.getOrCreate("telegram", "12345");
  assertEquals(session.taint, "PUBLIC");

  // Simulate taint escalation by replacing the session
  const updated = { ...session, taint: "INTERNAL" as ClassificationLevel };
  mgr.updateSession("telegram", "12345", updated);

  const retrieved = mgr.getOrCreate("telegram", "12345");
  assertEquals(retrieved.taint, "INTERNAL");
});

Deno.test("UserSessionManager — same user different channels get different sessions", () => {
  const mgr = createUserSessionManager({
    channelDefault: "PUBLIC" as ClassificationLevel,
    userOverrides: new Map(),
  });

  const tgSession = mgr.getOrCreate("telegram", "12345");
  const dcSession = mgr.getOrCreate("discord", "12345");
  assertNotEquals(tgSession.id, dcSession.id);
});

Deno.test("UserSessionManager — hasExplicitClassification true for overridden user", () => {
  const overrides = new Map<string, ClassificationLevel>([
    ["67890", "CONFIDENTIAL" as ClassificationLevel],
  ]);
  const mgr = createUserSessionManager({
    channelDefault: "PUBLIC" as ClassificationLevel,
    userOverrides: overrides,
  });

  assertEquals(mgr.hasExplicitClassification("67890"), true);
});

Deno.test("UserSessionManager — hasExplicitClassification false for unknown user", () => {
  const mgr = createUserSessionManager({
    channelDefault: "PUBLIC" as ClassificationLevel,
    userOverrides: new Map(),
  });

  assertEquals(mgr.hasExplicitClassification("99999"), false);
});

Deno.test("parseUserOverrides — parses string-keyed config", () => {
  const result = parseUserOverrides({
    "67890": "CONFIDENTIAL",
    "11111": "INTERNAL",
  });

  assertEquals(result.get("67890"), "CONFIDENTIAL");
  assertEquals(result.get("11111"), "INTERNAL");
  assertEquals(result.size, 2);
});

Deno.test("parseUserOverrides — returns empty map for undefined", () => {
  const result = parseUserOverrides(undefined);
  assertEquals(result.size, 0);
});

Deno.test("parseUserOverrides — normalizes numeric keys to strings", () => {
  // In YAML, numeric keys are parsed as numbers but Object.entries
  // always yields string keys. Verify the normalisation works.
  const raw = { "12345": "INTERNAL" } as Record<string, string>;
  const result = parseUserOverrides(raw);
  assertEquals(result.get("12345"), "INTERNAL");
});

Deno.test("parseUserOverrides — unparseable level fails closed to PUBLIC", () => {
  const result = parseUserOverrides({ "123": "CONFIDENTAL" });
  assertEquals(result.get("123"), "PUBLIC");
});

Deno.test("parseUserOverrides — valid levels parse unchanged alongside invalid ones", () => {
  const result = parseUserOverrides({
    "1": "RESTRICTED",
    "2": "not-a-level",
  });
  assertEquals(result.get("1"), "RESTRICTED");
  assertEquals(result.get("2"), "PUBLIC");
});
