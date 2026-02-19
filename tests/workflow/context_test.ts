/**
 * Workflow context and expression evaluator tests.
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { SessionId } from "../../src/core/types/session.ts";
import {
  createWorkflowContext,
  evaluateExpression,
  resolveTemplateString,
  scrubSecrets,
  evaluateCondition,
  resolveExpressions,
} from "../../src/workflow/context.ts";

function makeCtx(data: Record<string, unknown> = {}, input: Record<string, unknown> = {}) {
  const sessionId = "test-session-id" as SessionId;
  const ctx = createWorkflowContext({
    input: { ...input, ...data },
    sessionId,
    sessionTaint: "INTERNAL",
    agentId: "test-agent",
    workflowName: "test-workflow",
    workflowVersion: "1.0.0",
  });
  return { ...ctx, data: { ...ctx.data, ...data } };
}

// ─── Field access ──────────────────────────────────────────────────────────────

Deno.test("context — evaluate .field from current data", async () => {
  const ctx = makeCtx({ greeting: "hello" });
  const result = await evaluateExpression(".greeting", ctx);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, "hello");
});

Deno.test("context — evaluate . (current data root)", async () => {
  const ctx = makeCtx({ x: 1, y: 2 });
  const result = await evaluateExpression(".", ctx);
  assertEquals(result.ok, true);
  if (result.ok) {
    const val = result.value as Record<string, unknown>;
    assertEquals(val.x, 1);
    assertEquals(val.y, 2);
  }
});

// ─── $input access ────────────────────────────────────────────────────────────

Deno.test("context — evaluate $input.field", async () => {
  const ctx = createWorkflowContext({
    input: { location: "Paris", timezone: "CET" },
    sessionId: "s" as SessionId,
    sessionTaint: "PUBLIC",
    agentId: "agent1",
    workflowName: "wf",
    workflowVersion: "1.0.0",
  });
  const result = await evaluateExpression("$input.location", ctx);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, "Paris");
});

// ─── $context access ──────────────────────────────────────────────────────────

Deno.test("context — evaluate $context.date (ISO 8601 format)", async () => {
  const ctx = makeCtx();
  const result = await evaluateExpression("$context.date", ctx);
  assertEquals(result.ok, true);
  if (result.ok) {
    const dateStr = result.value as string;
    // Should be YYYY-MM-DD format
    assertEquals(/^\d{4}-\d{2}-\d{2}$/.test(dateStr), true);
  }
});

Deno.test("context — evaluate $context.session.taint", async () => {
  const ctx = makeCtx();
  const result = await evaluateExpression("$context.session.taint", ctx);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, "INTERNAL");
});

Deno.test("context — evaluate $context.session.id", async () => {
  const ctx = makeCtx();
  const result = await evaluateExpression("$context.session.id", ctx);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, "test-session-id");
});

// ─── Secrets ──────────────────────────────────────────────────────────────────

Deno.test("context — secret reference resolved and not exposed in returned value shape", async () => {
  const secretValue = "super-secret-api-key-12345";
  const sessionId = "s" as SessionId;
  const ctx = createWorkflowContext({
    input: {},
    sessionId,
    sessionTaint: "CONFIDENTIAL",
    agentId: "agent1",
    workflowName: "wf",
    workflowVersion: "1.0.0",
    secretResolver: {
      resolve: async (name) => name === "api_key" ? secretValue : null,
    },
  });

  const result = await evaluateExpression("$secrets.api_key", ctx);
  assertEquals(result.ok, true);
  // The value is returned internally but is scrubbed before persistence
  // We verify the scrub function handles it
  if (result.ok) {
    const resolvedValue = result.value as string;
    const scrubbed = scrubSecrets(resolvedValue, [secretValue]);
    assertEquals(scrubbed, "[REDACTED]");
  }
});

// ─── Template strings ─────────────────────────────────────────────────────────

Deno.test("context — resolve template string with multiple expressions", async () => {
  const ctx = makeCtx({ name: "Alice", city: "Berlin" });
  const result = await resolveTemplateString("Hello ${ .name } from ${ .city }!", ctx);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, "Hello Alice from Berlin!");
});

Deno.test("context — resolve template string with no expressions (passthrough)", async () => {
  const ctx = makeCtx();
  const result = await resolveTemplateString("plain string", ctx);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, "plain string");
});

// ─── jq pipe operations ───────────────────────────────────────────────────────

Deno.test("context — pipe select() filters array", async () => {
  const ctx = makeCtx({
    items: [
      { name: "a", score: 3 },
      { name: "b", score: 5 },
      { name: "c", score: 2 },
    ],
  });
  const result = await evaluateExpression(".items | select(.score >= 4)", ctx);
  assertEquals(result.ok, true);
  if (result.ok) {
    const arr = result.value as Array<{ name: string; score: number }>;
    assertEquals(arr.length, 1);
    assertEquals(arr[0].name, "b");
  }
});

Deno.test("context — pipe map() extracts field", async () => {
  const ctx = makeCtx({ items: [{ name: "x" }, { name: "y" }, { name: "z" }] });
  const result = await evaluateExpression(".items | map(.name)", ctx);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, ["x", "y", "z"]);
});

Deno.test("context — pipe join() concatenates array", async () => {
  const ctx = makeCtx({ words: ["hello", "world", "foo"] });
  const result = await evaluateExpression(".words | join(\", \")", ctx);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, "hello, world, foo");
});

Deno.test("context — pipe any() returns true when predicate matches", async () => {
  const ctx = makeCtx({
    items: [{ sig: 2 }, { sig: 4 }, { sig: 1 }],
  });
  const result = await evaluateExpression(".items | any(.sig >= 4)", ctx);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, true);
});

Deno.test("context — pipe any() returns false when no predicate matches", async () => {
  const ctx = makeCtx({
    items: [{ sig: 1 }, { sig: 2 }, { sig: 3 }],
  });
  const result = await evaluateExpression(".items | any(.sig >= 5)", ctx);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, false);
});

// ─── Condition evaluation ─────────────────────────────────────────────────────

Deno.test("context — evaluateCondition returns true for undefined", async () => {
  const ctx = makeCtx();
  const result = await evaluateCondition(undefined, ctx);
  assertEquals(result, true);
});

Deno.test("context — evaluateCondition returns false for 'false'", async () => {
  const ctx = makeCtx({ enabled: false });
  // Direct false value
  const ctx2 = makeCtx({ flag: "false" });
  const result = await evaluateCondition("${ .flag }", ctx2);
  // The string "false" evaluates to false
  assertEquals(result, false);
});

Deno.test("context — evaluateCondition returns true for truthy value", async () => {
  const ctx = makeCtx({ status: "active" });
  const result = await evaluateCondition("${ .status }", ctx);
  assertEquals(result, true);
});

// ─── resolveExpressions ───────────────────────────────────────────────────────

Deno.test("context — resolveExpressions resolves nested object", async () => {
  const ctx = makeCtx({ name: "test" });
  const template = { message: "Hello ${ .name }", count: 42, nested: { value: "${ .name }" } };
  const result = await resolveExpressions(template, ctx);
  const resolved = result as Record<string, unknown>;
  assertEquals(resolved.message, "Hello test");
  assertEquals(resolved.count, 42);
  const nested = resolved.nested as Record<string, unknown>;
  assertEquals(nested.value, "test");
});

Deno.test("context — scrubSecrets redacts secret values", () => {
  const secret = "my-secret-token";
  const data = { url: `https://api.example.com?token=${secret}`, other: "safe" };
  const scrubbed = scrubSecrets(data, [secret]) as Record<string, unknown>;
  assertStringIncludes(scrubbed.url as string, "[REDACTED]");
  assertEquals(scrubbed.other, "safe");
});

Deno.test("context — scrubSecrets is no-op with empty secret list", () => {
  const data = { url: "https://api.example.com", value: 42 };
  const scrubbed = scrubSecrets(data, []);
  assertEquals(scrubbed, data);
});
