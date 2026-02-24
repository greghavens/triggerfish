/**
 * Tests for orchestrator-level role enforcement.
 *
 * Verifies that resolveActiveToolList applies the filterTools callback
 * and that enforceNonOwnerToolCeiling works correctly with built-in
 * tool classifications from mapToolPrefixClassifications.
 */
import { assertEquals, assert } from "@std/assert";
import { resolveActiveToolList } from "../../src/agent/loop/loop_types.ts";
import {
  enforceNonOwnerToolCeiling,
} from "../../src/agent/dispatch/access_control.ts";
import {
  mapToolPrefixClassifications,
} from "../../src/agent/orchestrator/orchestrator_types.ts";
import type { OrchestratorState } from "../../src/agent/orchestrator/orchestrator.ts";
import type { ToolDefinition } from "../../src/core/types/tool.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";
import { createLogger } from "../../src/core/logger/mod.ts";

/** Build a minimal ToolDefinition stub. */
function stubTool(name: string): ToolDefinition {
  return { name, description: `stub: ${name}`, parameters: {} };
}

/** Build a minimal OrchestratorState-like object for resolveActiveToolList. */
function buildMockState(opts: {
  baseTools: readonly ToolDefinition[];
  getExtraTools?: () => readonly ToolDefinition[];
  filterTools?: (
    tools: readonly ToolDefinition[],
    isOwner: boolean,
  ) => readonly ToolDefinition[];
  isOwnerSession?: () => boolean;
}): OrchestratorState {
  return {
    baseTools: opts.baseTools,
    getExtraTools: opts.getExtraTools,
    config: {
      hookRunner: {
        run: () => Promise.resolve({ action: "ALLOW" }),
        addRule: () => {},
      },
      providerRegistry: {
        get: () => undefined,
        getDefault: () => undefined,
        register: () => {},
        setDefault: () => {},
        list: () => [],
      },
      filterTools: opts.filterTools,
      isOwnerSession: opts.isOwnerSession,
    },
    history: new Map(),
    orchLog: createLogger("test-orchestrator"),
    debug: false,
  } as unknown as OrchestratorState;
}

// ─── resolveActiveToolList with filterTools ────────────────────────────────

Deno.test("resolveActiveToolList: owner session returns full list when filterTools set", () => {
  const tools = [stubTool("run_command"), stubTool("web_search")];
  const state = buildMockState({
    baseTools: tools,
    filterTools: (t, isOwner) => isOwner ? t : t.filter((x) => x.name !== "run_command"),
    isOwnerSession: () => true,
  });
  const result = resolveActiveToolList(state);
  assertEquals(result.length, 2);
});

Deno.test("resolveActiveToolList: non-owner session excludes owner-only tools", () => {
  const tools = [stubTool("run_command"), stubTool("web_search")];
  const state = buildMockState({
    baseTools: tools,
    filterTools: (t, isOwner) => isOwner ? t : t.filter((x) => x.name !== "run_command"),
    isOwnerSession: () => false,
  });
  const result = resolveActiveToolList(state);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "web_search");
});

Deno.test("resolveActiveToolList: no filterTools returns full list regardless of owner status", () => {
  const tools = [stubTool("run_command"), stubTool("web_search")];
  const state = buildMockState({ baseTools: tools });
  const result = resolveActiveToolList(state);
  assertEquals(result.length, 2);
});

Deno.test("resolveActiveToolList: isOwnerSession not provided defaults to owner (true)", () => {
  const tools = [stubTool("run_command"), stubTool("web_search")];
  const state = buildMockState({
    baseTools: tools,
    filterTools: (t, isOwner) => isOwner ? t : [],
  });
  const result = resolveActiveToolList(state);
  assertEquals(result.length, 2, "Should default to owner=true when isOwnerSession not set");
});

Deno.test("resolveActiveToolList: filterTools applies to extra tools too", () => {
  const state = buildMockState({
    baseTools: [stubTool("web_search")],
    getExtraTools: () => [stubTool("run_command")],
    filterTools: (t, isOwner) => isOwner ? t : t.filter((x) => x.name !== "run_command"),
    isOwnerSession: () => false,
  });
  const result = resolveActiveToolList(state);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "web_search");
});

// ─── mapToolPrefixClassifications with built-in tools ──────────────────────

Deno.test("mapToolPrefixClassifications: includes built-in tool classifications", () => {
  const map = mapToolPrefixClassifications({});
  // Should have built-in entries for memory, browser, web, etc.
  assert(map.has("memory_save"), "Should have memory_save entry");
  assert(map.has("memory_search"), "Should have memory_search entry");
  assert(map.has("browser_"), "Should have browser_ prefix entry");
  assert(map.has("web_"), "Should have web_ prefix entry");
});

Deno.test("mapToolPrefixClassifications: memory_search classified PUBLIC", () => {
  const map = mapToolPrefixClassifications({});
  assertEquals(map.get("memory_search"), "PUBLIC");
});

Deno.test("mapToolPrefixClassifications: memory_save classified RESTRICTED", () => {
  const map = mapToolPrefixClassifications({});
  assertEquals(map.get("memory_save"), "RESTRICTED");
});

Deno.test("mapToolPrefixClassifications: browser_ classified RESTRICTED", () => {
  const map = mapToolPrefixClassifications({});
  assertEquals(map.get("browser_"), "RESTRICTED");
});

Deno.test("mapToolPrefixClassifications: web_ classified PUBLIC", () => {
  const map = mapToolPrefixClassifications({});
  assertEquals(map.get("web_"), "PUBLIC");
});

Deno.test("mapToolPrefixClassifications: write_file classified RESTRICTED", () => {
  const map = mapToolPrefixClassifications({});
  assertEquals(map.get("write_file"), "RESTRICTED");
});

Deno.test("mapToolPrefixClassifications: read_file classified INTERNAL", () => {
  const map = mapToolPrefixClassifications({});
  assertEquals(map.get("read_file"), "INTERNAL");
});

Deno.test("mapToolPrefixClassifications: integration overrides take precedence", () => {
  const map = mapToolPrefixClassifications({
    google: { classification: "CONFIDENTIAL" },
  });
  assertEquals(map.get("gmail_"), "CONFIDENTIAL", "Google override should take precedence");
  // Built-in tools should still be present
  assert(map.has("web_"), "Built-in web_ should still be present");
});

// ─── enforceNonOwnerToolCeiling with built-in classifications ──────────────

Deno.test("enforceNonOwnerToolCeiling: non-owner with PUBLIC ceiling can use memory_search", () => {
  const map = mapToolPrefixClassifications({});
  const err = enforceNonOwnerToolCeiling(
    "memory_search",
    "PUBLIC" as ClassificationLevel,
    map,
  );
  assertEquals(err, null, "memory_search (PUBLIC) should be allowed for PUBLIC ceiling");
});

Deno.test("enforceNonOwnerToolCeiling: non-owner with PUBLIC ceiling blocks run_command", () => {
  const map = mapToolPrefixClassifications({});
  const err = enforceNonOwnerToolCeiling(
    "run_command",
    "PUBLIC" as ClassificationLevel,
    map,
  );
  assert(err !== null, "run_command (RESTRICTED) should be blocked for PUBLIC ceiling");
  assert(err!.includes("RESTRICTED"), "Error should mention RESTRICTED classification");
});

Deno.test("enforceNonOwnerToolCeiling: non-owner with PUBLIC ceiling can use web_search", () => {
  const map = mapToolPrefixClassifications({});
  const err = enforceNonOwnerToolCeiling(
    "web_search",
    "PUBLIC" as ClassificationLevel,
    map,
  );
  assertEquals(err, null, "web_search (PUBLIC) should be allowed for PUBLIC ceiling");
});

Deno.test("enforceNonOwnerToolCeiling: non-owner with PUBLIC ceiling blocks memory_save", () => {
  const map = mapToolPrefixClassifications({});
  const err = enforceNonOwnerToolCeiling(
    "memory_save",
    "PUBLIC" as ClassificationLevel,
    map,
  );
  assert(err !== null, "memory_save (RESTRICTED) should be blocked for PUBLIC ceiling");
});

Deno.test("enforceNonOwnerToolCeiling: non-owner with null ceiling blocks all tools", () => {
  const map = mapToolPrefixClassifications({});
  const err = enforceNonOwnerToolCeiling(
    "web_search",
    null,
    map,
  );
  assert(err !== null, "null ceiling should block all tool calls");
  assert(err!.includes("not available"), "Error should state tools not available");
});
