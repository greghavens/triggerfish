/**
 * Phase 3: Enforcement Hooks
 * Tests MUST FAIL until hooks.ts is implemented.
 * Tests determinism, timeout=BLOCK, logging, write-down blocking, default rules.
 */
import { assert, assertEquals, assertExists } from "@std/assert";
import {
  createDefaultRules,
  createHookRunner,
  type HookLogEntry,
} from "../../src/core/policy/hooks/hooks.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import { createSession, updateTaint } from "../../src/core/types/session.ts";
import type { ChannelId, UserId } from "../../src/core/types/session.ts";

function makeSession(taint = "PUBLIC" as const) {
  let s = createSession({ userId: "u" as UserId, channelId: "c" as ChannelId });
  if (taint !== "PUBLIC") s = updateTaint(s, taint, "test setup");
  return s;
}

// --- HookRunner basics ---

Deno.test("createHookRunner: returns runner with evaluateHook method", () => {
  const engine = createPolicyEngine();
  const runner = createHookRunner(engine);
  assertExists(runner.evaluateHook);
});

Deno.test("run: returns HookResult with allowed, action, ruleId, duration", async () => {
  const engine = createPolicyEngine();
  const runner = createHookRunner(engine);
  const session = makeSession();
  const result = await runner.evaluateHook("PRE_OUTPUT", {
    session,
    input: {},
  });
  assertExists(result.allowed);
  assertExists(result.action);
  assert(typeof result.duration === "number");
});

Deno.test("run: default ALLOW when no rules match", async () => {
  const engine = createPolicyEngine();
  const runner = createHookRunner(engine);
  const session = makeSession();
  const result = await runner.evaluateHook("PRE_OUTPUT", {
    session,
    input: {},
  });
  assertEquals(result.allowed, true);
  assertEquals(result.action, "ALLOW");
});

// --- Determinism ---

Deno.test("run: same input produces same output (deterministic)", async () => {
  const engine = createPolicyEngine();
  for (const rule of createDefaultRules()) engine.addRule(rule);
  const runner = createHookRunner(engine);
  const session = makeSession("CONFIDENTIAL");
  const input = { target_classification: "PUBLIC" };

  const r1 = await runner.evaluateHook("PRE_OUTPUT", { session, input });
  const r2 = await runner.evaluateHook("PRE_OUTPUT", { session, input });
  assertEquals(r1.allowed, r2.allowed);
  assertEquals(r1.action, r2.action);
  assertEquals(r1.ruleId, r2.ruleId);
});

// --- Default rules ---

Deno.test("default no-write-down rule: blocks CONFIDENTIAL -> PUBLIC", async () => {
  const engine = createPolicyEngine();
  for (const rule of createDefaultRules()) engine.addRule(rule);
  const runner = createHookRunner(engine);
  const session = makeSession("CONFIDENTIAL");
  const result = await runner.evaluateHook("PRE_OUTPUT", {
    session,
    input: { target_classification: "PUBLIC" },
  });
  assertEquals(result.allowed, false);
  assertEquals(result.action, "BLOCK");
});

Deno.test("default no-write-down rule: allows PUBLIC -> INTERNAL", async () => {
  const engine = createPolicyEngine();
  for (const rule of createDefaultRules()) engine.addRule(rule);
  const runner = createHookRunner(engine);
  const session = makeSession("PUBLIC");
  const result = await runner.evaluateHook("PRE_OUTPUT", {
    session,
    input: { target_classification: "INTERNAL" },
  });
  assertEquals(result.allowed, true);
});

Deno.test("default untrusted-input rule: blocks UNTRUSTED source", async () => {
  const engine = createPolicyEngine();
  for (const rule of createDefaultRules()) engine.addRule(rule);
  const runner = createHookRunner(engine);
  const session = makeSession();
  const result = await runner.evaluateHook("PRE_CONTEXT_INJECTION", {
    session,
    input: { source_type: "UNTRUSTED" },
  });
  assertEquals(result.allowed, false);
  assertEquals(result.action, "BLOCK");
});

// --- Resource read ceiling (default-deny) ---

function makeDefaultRuleRunner() {
  const engine = createPolicyEngine();
  for (const rule of createDefaultRules()) engine.addRule(rule);
  return createHookRunner(engine);
}

Deno.test("resource-read-ceiling rule: blocks non-owner read above explicit ceiling", async () => {
  const runner = makeDefaultRuleRunner();
  const result = await runner.evaluateHook("PRE_TOOL_CALL", {
    session: makeSession(),
    input: {
      resource_classification: "CONFIDENTIAL",
      operation_type: "read",
      is_owner: false,
      non_owner_ceiling: "INTERNAL",
    },
  });
  assertEquals(result.allowed, false);
  assertEquals(result.action, "BLOCK");
});

Deno.test("resource-read-ceiling rule: allows non-owner read within explicit ceiling", async () => {
  const runner = makeDefaultRuleRunner();
  const result = await runner.evaluateHook("PRE_TOOL_CALL", {
    session: makeSession(),
    input: {
      resource_classification: "INTERNAL",
      operation_type: "read",
      is_owner: false,
      non_owner_ceiling: "INTERNAL",
    },
  });
  assertEquals(result.allowed, true);
});

Deno.test("resource-read-ceiling rule: default-deny blocks non-owner read above PUBLIC when ceiling missing", async () => {
  const runner = makeDefaultRuleRunner();
  const result = await runner.evaluateHook("PRE_TOOL_CALL", {
    session: makeSession(),
    input: {
      resource_classification: "INTERNAL",
      operation_type: "read",
      is_owner: false,
    },
  });
  assertEquals(result.allowed, false);
  assertEquals(result.action, "BLOCK");
});

Deno.test("resource-read-ceiling rule: allows non-owner PUBLIC read when ceiling missing", async () => {
  const runner = makeDefaultRuleRunner();
  const result = await runner.evaluateHook("PRE_TOOL_CALL", {
    session: makeSession(),
    input: {
      resource_classification: "PUBLIC",
      operation_type: "read",
      is_owner: false,
    },
  });
  assertEquals(result.allowed, true);
});

Deno.test("resource-read-ceiling rule: unparseable ceiling fails closed to PUBLIC", async () => {
  const runner = makeDefaultRuleRunner();
  const result = await runner.evaluateHook("PRE_TOOL_CALL", {
    session: makeSession(),
    input: {
      resource_classification: "INTERNAL",
      operation_type: "read",
      is_owner: false,
      non_owner_ceiling: "CONFIDENTAL",
    },
  });
  assertEquals(result.allowed, false);
  assertEquals(result.action, "BLOCK");
});

Deno.test("resource-read-ceiling rule: owner reads are not ceiling-gated", async () => {
  const runner = makeDefaultRuleRunner();
  const result = await runner.evaluateHook("PRE_TOOL_CALL", {
    session: makeSession(),
    input: {
      resource_classification: "RESTRICTED",
      operation_type: "read",
      is_owner: true,
    },
  });
  assertEquals(result.allowed, true);
});

// --- Write-down fail-closed (missing/unparseable target_classification) ---

Deno.test("no-write-down rule: missing target_classification blocks tainted session", async () => {
  const runner = makeDefaultRuleRunner();
  const result = await runner.evaluateHook("PRE_OUTPUT", {
    session: makeSession("CONFIDENTIAL"),
    input: { content: "classified output" },
  });
  assertEquals(result.allowed, false);
  assertEquals(result.action, "BLOCK");
});

Deno.test("no-write-down rule: unparseable target (typo CONFIDENTAL) blocks tainted session", async () => {
  const runner = makeDefaultRuleRunner();
  const result = await runner.evaluateHook("PRE_OUTPUT", {
    session: makeSession("INTERNAL"),
    input: { target_classification: "CONFIDENTAL" },
  });
  assertEquals(result.allowed, false);
  assertEquals(result.action, "BLOCK");
});

Deno.test("no-write-down rule: missing target still allows PUBLIC-tainted output", async () => {
  const runner = makeDefaultRuleRunner();
  const result = await runner.evaluateHook("PRE_OUTPUT", {
    session: makeSession("PUBLIC"),
    input: { content: "public output" },
  });
  assertEquals(result.allowed, true);
});

Deno.test("no-write-down rule: valid equal-level target behaves unchanged", async () => {
  const runner = makeDefaultRuleRunner();
  const result = await runner.evaluateHook("PRE_OUTPUT", {
    session: makeSession("CONFIDENTIAL"),
    input: { target_classification: "CONFIDENTIAL" },
  });
  assertEquals(result.allowed, true);
});

// --- Resource write-down fail-closed (unparseable resource_classification) ---

Deno.test("resource-write-down rule: unparseable resource classification blocks tainted write", async () => {
  const runner = makeDefaultRuleRunner();
  const result = await runner.evaluateHook("PRE_TOOL_CALL", {
    session: makeSession("CONFIDENTIAL"),
    input: {
      resource_classification: "CONFIDENTAL",
      operation_type: "write",
      is_owner: true,
    },
  });
  assertEquals(result.allowed, false);
  assertEquals(result.action, "BLOCK");
});

Deno.test("resource-write-down rule: unparseable resource classification still allows PUBLIC-tainted write", async () => {
  const runner = makeDefaultRuleRunner();
  const result = await runner.evaluateHook("PRE_TOOL_CALL", {
    session: makeSession("PUBLIC"),
    input: {
      resource_classification: "CONFIDENTAL",
      operation_type: "write",
      is_owner: true,
    },
  });
  assertEquals(result.allowed, true);
});

// --- Logging ---

Deno.test("run: logs every execution when logger provided", async () => {
  const engine = createPolicyEngine();
  const entries: HookLogEntry[] = [];
  const logger = { log: (entry: HookLogEntry) => entries.push(entry) };
  const runner = createHookRunner(engine, { logger });
  const session = makeSession();
  await runner.evaluateHook("PRE_OUTPUT", { session, input: {} });
  assertEquals(entries.length, 1);
  assertExists(entries[0].timestamp);
  assertEquals(entries[0].hook, "PRE_OUTPUT");
  assertEquals(entries[0].sessionId, session.id);
  assertExists(entries[0].result);
});

// --- Timeout ---

Deno.test("run: timeout causes BLOCK rejection", async () => {
  const engine = createPolicyEngine();
  // Add a rule that would match but set very short timeout
  engine.addRule({
    id: "slow-rule",
    priority: 100,
    hook: "PRE_OUTPUT",
    conditions: [{ field: "x", operator: "equals", value: "1" }],
    action: "ALLOW",
  });
  const runner = createHookRunner(engine, { timeoutMs: 0 }); // instant timeout
  const session = makeSession();
  const result = await runner.evaluateHook("PRE_OUTPUT", {
    session,
    input: { x: "1" },
  });
  // With 0ms timeout, should BLOCK
  assertEquals(result.allowed, false);
  assertEquals(result.action, "BLOCK");
});
