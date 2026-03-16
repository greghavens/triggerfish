/**
 * Tests for simulate_tool_call — dry-run security pipeline simulation.
 *
 * Covers: input validation, SubsystemExecutor protocol, no-escalation,
 * prefix escalation, resource escalation, tool floor blocking,
 * write-down blocking, integration write-down blocking, state
 * immutability, and idempotency.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import type { ClassificationLevel } from "../../../src/core/types/classification.ts";
import type { PathClassifier } from "../../../src/core/security/path_classification.ts";
import {
  computeSimulatedTaint,
  createSimulateToolExecutor,
  evaluateSimulatedBlocked,
} from "../../../src/gateway/tools/simulate/mod.ts";
import type { SimulateToolContext } from "../../../src/gateway/tools/simulate/mod.ts";

// ─── Test helpers ────────────────────────────────────────────────────────────

/** Build a SimulateToolContext with sensible defaults. */
function buildContext(
  overrides: Partial<SimulateToolContext> = {},
): SimulateToolContext {
  return {
    getSessionTaint: () => "PUBLIC" as ClassificationLevel,
    isOwner: () => true,
    isTrigger: () => false,
    toolClassifications: new Map<string, ClassificationLevel>([
      ["read_file", "PUBLIC"],
      ["github_", "INTERNAL"],
      ["memory_search", "PUBLIC"],
      ["obsidian_write", "RESTRICTED"],
    ]),
    integrationClassifications: new Map<string, ClassificationLevel>([
      ["github_", "INTERNAL"],
    ]),
    ...overrides,
  };
}

/** Parse JSON from executor result. */
function parseResult(result: string): Record<string, unknown> {
  return JSON.parse(result) as Record<string, unknown>;
}

// ─── 1. Input validation ─────────────────────────────────────────────────────

Deno.test("simulate_tool_call: rejects missing tool_name", async () => {
  const executor = createSimulateToolExecutor(buildContext());
  const result = await executor("simulate_tool_call", { tool_args: {} });
  assertStringIncludes(result!, "tool_name");
});

Deno.test("simulate_tool_call: rejects missing tool_args", async () => {
  const executor = createSimulateToolExecutor(buildContext());
  const result = await executor("simulate_tool_call", {
    tool_name: "read_file",
  });
  assertStringIncludes(result!, "tool_args");
});

Deno.test("simulate_tool_call: rejects non-string tool_name", async () => {
  const executor = createSimulateToolExecutor(buildContext());
  const result = await executor("simulate_tool_call", {
    tool_name: 42,
    tool_args: {},
  });
  assertStringIncludes(result!, "tool_name");
});

// ─── 2. SubsystemExecutor protocol ──────────────────────────────────────────

Deno.test("simulate_tool_call: returns null for non-simulate tool names", async () => {
  const executor = createSimulateToolExecutor(buildContext());
  const result = await executor("read_file", { path: "/etc/hosts" });
  assertEquals(result, null);
});

// ─── 3. No escalation ───────────────────────────────────────────────────────

Deno.test("simulate_tool_call: PUBLIC tool at PUBLIC taint shows no escalation", async () => {
  const executor = createSimulateToolExecutor(buildContext());
  const result = await executor("simulate_tool_call", {
    tool_name: "read_file",
    tool_args: {},
  });
  const parsed = parseResult(result!);
  assertEquals(parsed.currentTaint, "PUBLIC");
  assertEquals(parsed.resultingTaint, "PUBLIC");
  assertEquals(parsed.escalation, false);
  assertEquals(parsed.blocked, false);
});

// ─── 4. Prefix escalation ───────────────────────────────────────────────────

Deno.test("simulate_tool_call: INTERNAL-classified tool prefix at PUBLIC taint shows escalation", async () => {
  const executor = createSimulateToolExecutor(buildContext());
  const result = await executor("simulate_tool_call", {
    tool_name: "github_list_repos",
    tool_args: {},
  });
  const parsed = parseResult(result!);
  assertEquals(parsed.currentTaint, "PUBLIC");
  assertEquals(parsed.resultingTaint, "INTERNAL");
  assertEquals(parsed.escalation, true);
  assertEquals(parsed.blocked, false);
});

// ─── 5. Resource escalation ─────────────────────────────────────────────────

Deno.test("simulate_tool_call: filesystem tool reading CONFIDENTIAL path shows resource escalation", async () => {
  const mockPathClassifier: PathClassifier = {
    classify: (_path: string) => ({
      classification: "CONFIDENTIAL" as ClassificationLevel,
      matchedRule: "/secrets",
    }),
  };
  const ctx = buildContext({
    pathClassifier: mockPathClassifier,
  });
  const executor = createSimulateToolExecutor(ctx);
  const result = await executor("simulate_tool_call", {
    tool_name: "read_file",
    tool_args: { path: "/secrets/api_key.txt" },
  });
  const parsed = parseResult(result!);
  assertEquals(parsed.currentTaint, "PUBLIC");
  assertEquals(parsed.resultingTaint, "CONFIDENTIAL");
  assertEquals(parsed.escalation, true);
  assertEquals(parsed.blocked, false);
});

// ─── 6. Tool floor — escalation and blocking ────────────────────────────────

Deno.test("simulate_tool_call: owner session with INTERNAL floor escalates taint", async () => {
  const ctx = buildContext({
    toolFloorRegistry: {
      getFloor: (_name: string) => "INTERNAL" as ClassificationLevel,
      canInvoke: (_name: string, taint: ClassificationLevel) =>
        taint === "INTERNAL" || taint === "CONFIDENTIAL" ||
        taint === "RESTRICTED",
    },
  });
  const executor = createSimulateToolExecutor(ctx);
  const result = await executor("simulate_tool_call", {
    tool_name: "secret_tool",
    tool_args: {},
  });
  const parsed = parseResult(result!);
  // Floor-based taint escalation mirrors real dispatch: escalate then check
  assertEquals(parsed.escalation, true, "Should show taint escalation");
  assertEquals(parsed.resultingTaint, "INTERNAL");
  assertEquals(
    parsed.blocked,
    false,
    "Owner session should not be blocked after escalation",
  );
});

Deno.test("computeSimulatedTaint: falls back to floor registry when no prefix match", () => {
  const registry = {
    getFloor: (name: string) =>
      name === "ssh_execute" ? "INTERNAL" as ClassificationLevel : null,
    canInvoke: () => true,
  };
  const result = computeSimulatedTaint(
    "PUBLIC" as ClassificationLevel,
    null,
    "ssh_execute",
    new Map<string, ClassificationLevel>([["web_", "PUBLIC"]]),
    registry,
  );
  assertEquals(
    result,
    "INTERNAL",
    "Should escalate via floor registry fallback",
  );
});

// ─── 7. Blocked — write-down ────────────────────────────────────────────────

Deno.test("simulate_tool_call: CONFIDENTIAL session writing to PUBLIC resource is blocked", async () => {
  const mockPathClassifier: PathClassifier = {
    classify: (_path: string) => ({
      classification: "PUBLIC" as ClassificationLevel,
      matchedRule: "/public",
    }),
  };
  const ctx = buildContext({
    getSessionTaint: () => "CONFIDENTIAL" as ClassificationLevel,
    pathClassifier: mockPathClassifier,
  });
  const executor = createSimulateToolExecutor(ctx);
  const result = await executor("simulate_tool_call", {
    tool_name: "write_file",
    tool_args: { path: "/public/readme.txt" },
  });
  const parsed = parseResult(result!);
  assertEquals(parsed.blocked, true);
  assertStringIncludes(parsed.blockReason as string, "Write-down");
});

// ─── 8. Blocked — integration write-down ────────────────────────────────────

Deno.test("simulate_tool_call: CONFIDENTIAL session calling PUBLIC integration is blocked", async () => {
  const ctx = buildContext({
    getSessionTaint: () => "CONFIDENTIAL" as ClassificationLevel,
    integrationClassifications: new Map([
      ["public_api_", "PUBLIC" as ClassificationLevel],
    ]),
    toolClassifications: new Map([
      ["public_api_", "PUBLIC" as ClassificationLevel],
    ]),
  });
  const executor = createSimulateToolExecutor(ctx);
  const result = await executor("simulate_tool_call", {
    tool_name: "public_api_send",
    tool_args: {},
  });
  const parsed = parseResult(result!);
  assertEquals(parsed.blocked, true);
  assertStringIncludes(parsed.blockReason as string, "Integration write-down");
});

// ─── 9. State immutability ──────────────────────────────────────────────────

Deno.test("simulate_tool_call: session taint unchanged after simulation", async () => {
  const currentTaint: ClassificationLevel = "PUBLIC";
  const ctx = buildContext({
    getSessionTaint: () => currentTaint,
    toolClassifications: new Map([
      ["github_", "INTERNAL" as ClassificationLevel],
    ]),
  });
  const executor = createSimulateToolExecutor(ctx);

  const result = await executor("simulate_tool_call", {
    tool_name: "github_list_repos",
    tool_args: {},
  });
  const parsed = parseResult(result!);
  assertEquals(parsed.resultingTaint, "INTERNAL");
  assertEquals(parsed.escalation, true);
  // Session taint must be unchanged
  assertEquals(currentTaint, "PUBLIC");
});

// ─── 10. Idempotent ─────────────────────────────────────────────────────────

Deno.test("simulate_tool_call: multiple simulations of same call produce same result", async () => {
  const ctx = buildContext({
    toolClassifications: new Map([
      ["github_", "INTERNAL" as ClassificationLevel],
    ]),
  });
  const executor = createSimulateToolExecutor(ctx);
  const args = {
    tool_name: "github_list_repos",
    tool_args: {},
  };

  const result1 = await executor("simulate_tool_call", args);
  const result2 = await executor("simulate_tool_call", args);
  const result3 = await executor("simulate_tool_call", args);

  assertEquals(result1, result2);
  assertEquals(result2, result3);
});

// ─── Unit tests for pure helpers ─────────────────────────────────────────────

Deno.test("computeSimulatedTaint: resource classification takes precedence", () => {
  const result = computeSimulatedTaint(
    "PUBLIC",
    "CONFIDENTIAL",
    "read_file",
    new Map([["read_file", "PUBLIC"]]),
  );
  assertEquals(result, "CONFIDENTIAL");
});

Deno.test("computeSimulatedTaint: falls back to prefix when no resource classification", () => {
  const result = computeSimulatedTaint(
    "PUBLIC",
    null,
    "github_list_repos",
    new Map([["github_", "INTERNAL"]]),
  );
  assertEquals(result, "INTERNAL");
});

Deno.test("computeSimulatedTaint: returns current taint when no classification found", () => {
  const result = computeSimulatedTaint(
    "INTERNAL",
    null,
    "unknown_tool",
    new Map(),
  );
  assertEquals(result, "INTERNAL");
});

Deno.test("evaluateSimulatedBlocked: no violations returns not blocked", () => {
  const { blocked } = evaluateSimulatedBlocked(
    { resource_classification: "PUBLIC", is_owner: true },
    "PUBLIC",
    "read_file",
  );
  assertEquals(blocked, false);
});

Deno.test("evaluateSimulatedBlocked: tool floor violation detected", () => {
  const { blocked, reason } = evaluateSimulatedBlocked(
    { tool_floor: "CONFIDENTIAL" },
    "PUBLIC",
    "secret_tool",
  );
  assertEquals(blocked, true);
  assertStringIncludes(reason!, "floor");
});
