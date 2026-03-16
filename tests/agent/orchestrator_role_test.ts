/**
 * Tests for orchestrator-level role enforcement and tool classification.
 *
 * Verifies that resolveActiveToolList applies the filterTools callback,
 * that enforceNonOwnerToolCeiling works correctly with built-in
 * tool classifications, and that memory_save/memory_delete do not
 * trigger taint escalation (they operate at session taint level).
 */
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { resolveActiveToolList } from "../../src/agent/loop/loop_types.ts";
import {
  enforceNonOwnerToolCeiling,
  enforceTriggerToolCeiling,
  escalateToolPrefixTaint,
} from "../../src/agent/dispatch/access_control.ts";
import {
  mapToolPrefixClassifications,
} from "../../src/agent/orchestrator/orchestrator_types.ts";
import type { OrchestratorState } from "../../src/agent/orchestrator/orchestrator.ts";
import type { ToolDefinition } from "../../src/core/types/tool.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";
import { createToolFloorRegistry } from "../../src/core/security/tool_floors.ts";
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
    filterTools: (t, isOwner) =>
      isOwner ? t : t.filter((x) => x.name !== "run_command"),
    isOwnerSession: () => true,
  });
  const result = resolveActiveToolList(state);
  assertEquals(result.length, 2);
});

Deno.test("resolveActiveToolList: non-owner session excludes owner-only tools", () => {
  const tools = [stubTool("run_command"), stubTool("web_search")];
  const state = buildMockState({
    baseTools: tools,
    filterTools: (t, isOwner) =>
      isOwner ? t : t.filter((x) => x.name !== "run_command"),
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
  assertEquals(
    result.length,
    2,
    "Should default to owner=true when isOwnerSession not set",
  );
});

Deno.test("resolveActiveToolList: filterTools applies to extra tools too", () => {
  const state = buildMockState({
    baseTools: [stubTool("web_search")],
    getExtraTools: () => [stubTool("run_command")],
    filterTools: (t, isOwner) =>
      isOwner ? t : t.filter((x) => x.name !== "run_command"),
    isOwnerSession: () => false,
  });
  const result = resolveActiveToolList(state);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "web_search");
});

// ─── mapToolPrefixClassifications with built-in tools ──────────────────────

Deno.test("mapToolPrefixClassifications: includes built-in tool classifications", () => {
  const map = mapToolPrefixClassifications({}).all;
  // Should have built-in entries for memory read tools, browser, web, etc.
  assert(map.has("memory_search"), "Should have memory_search entry");
  assert(map.has("browser_"), "Should have browser_ prefix entry");
  assert(map.has("web_"), "Should have web_ prefix entry");
  // memory_save and memory_delete are intentionally absent
  assert(
    !map.has("memory_save"),
    "memory_save must not be in classification map",
  );
  assert(
    !map.has("memory_delete"),
    "memory_delete must not be in classification map",
  );
});

Deno.test("mapToolPrefixClassifications: memory_search classified PUBLIC", () => {
  const map = mapToolPrefixClassifications({}).all;
  assertEquals(map.get("memory_search"), "PUBLIC");
});

Deno.test("mapToolPrefixClassifications: memory_save absent (operates at session taint)", () => {
  const map = mapToolPrefixClassifications({}).all;
  assertEquals(
    map.has("memory_save"),
    false,
    "memory_save must not be in classification map",
  );
});

Deno.test("mapToolPrefixClassifications: memory_delete absent (operates at session taint)", () => {
  const map = mapToolPrefixClassifications({}).all;
  assertEquals(
    map.has("memory_delete"),
    false,
    "memory_delete must not be in classification map",
  );
});

Deno.test("mapToolPrefixClassifications: browser_ classified PUBLIC", () => {
  const map = mapToolPrefixClassifications({}).all;
  assertEquals(map.get("browser_"), "PUBLIC");
});

Deno.test("mapToolPrefixClassifications: web_ classified PUBLIC", () => {
  const map = mapToolPrefixClassifications({}).all;
  assertEquals(map.get("web_"), "PUBLIC");
});

Deno.test("mapToolPrefixClassifications: write_file classified PUBLIC", () => {
  const map = mapToolPrefixClassifications({}).all;
  assertEquals(map.get("write_file"), "PUBLIC");
});

Deno.test("mapToolPrefixClassifications: read_file classified PUBLIC", () => {
  const map = mapToolPrefixClassifications({}).all;
  assertEquals(map.get("read_file"), "PUBLIC");
});

Deno.test("mapToolPrefixClassifications: integration overrides take precedence", () => {
  const map = mapToolPrefixClassifications({
    google: { classification: "CONFIDENTIAL" },
  }).all;
  assertEquals(
    map.get("gmail_"),
    "CONFIDENTIAL",
    "Google override should take precedence",
  );
  // Built-in tools should still be present
  assert(map.has("web_"), "Built-in web_ should still be present");
});

// ─── enforceNonOwnerToolCeiling with built-in classifications ──────────────

Deno.test("enforceNonOwnerToolCeiling: non-owner with PUBLIC ceiling can use memory_search", () => {
  const map = mapToolPrefixClassifications({}).all;
  const err = enforceNonOwnerToolCeiling(
    "memory_search",
    "PUBLIC" as ClassificationLevel,
    map,
  );
  assertEquals(
    err,
    null,
    "memory_search (PUBLIC) should be allowed for PUBLIC ceiling",
  );
});

Deno.test("enforceNonOwnerToolCeiling: non-owner with PUBLIC ceiling can use run_command", () => {
  const map = mapToolPrefixClassifications({}).all;
  const err = enforceNonOwnerToolCeiling(
    "run_command",
    "PUBLIC" as ClassificationLevel,
    map,
  );
  assertEquals(
    err,
    null,
    "run_command (PUBLIC) should be allowed for PUBLIC ceiling",
  );
});

Deno.test("enforceNonOwnerToolCeiling: non-owner with PUBLIC ceiling can use web_search", () => {
  const map = mapToolPrefixClassifications({}).all;
  const err = enforceNonOwnerToolCeiling(
    "web_search",
    "PUBLIC" as ClassificationLevel,
    map,
  );
  assertEquals(
    err,
    null,
    "web_search (PUBLIC) should be allowed for PUBLIC ceiling",
  );
});

Deno.test("enforceNonOwnerToolCeiling: non-owner with PUBLIC ceiling blocks memory_save (unmatched)", () => {
  const map = mapToolPrefixClassifications({}).all;
  const err = enforceNonOwnerToolCeiling(
    "memory_save",
    "PUBLIC" as ClassificationLevel,
    map,
  );
  assert(
    err !== null,
    "memory_save (unmatched) should be blocked for non-owners",
  );
  assert(
    err!.includes("not available"),
    "Unmatched tool should report 'not available'",
  );
});

Deno.test("enforceNonOwnerToolCeiling: non-owner with null ceiling blocks all tools", () => {
  const map = mapToolPrefixClassifications({}).all;
  const err = enforceNonOwnerToolCeiling(
    "web_search",
    null,
    map,
  );
  assert(err !== null, "null ceiling should block all tool calls");
  assert(
    err!.includes("not available"),
    "Error should state tools not available",
  );
});

// ─── memory_save / memory_delete do NOT escalate taint ─────────────────────

Deno.test("escalateToolPrefixTaint: memory_save does not escalate at PUBLIC", () => {
  const map = mapToolPrefixClassifications({}).all;
  let escalated = false;
  escalateToolPrefixTaint(
    "memory_save",
    map,
    (_level: ClassificationLevel, _reason: string) => {
      escalated = true;
    },
  );
  assertEquals(
    escalated,
    false,
    "memory_save must not trigger taint escalation",
  );
});

Deno.test("escalateToolPrefixTaint: memory_save does not escalate at INTERNAL", () => {
  const map = mapToolPrefixClassifications({}).all;
  let escalated = false;
  escalateToolPrefixTaint(
    "memory_save",
    map,
    (_level: ClassificationLevel, _reason: string) => {
      escalated = true;
    },
  );
  assertEquals(
    escalated,
    false,
    "memory_save must not trigger taint escalation",
  );
});

Deno.test("escalateToolPrefixTaint: memory_save does not escalate at CONFIDENTIAL", () => {
  const map = mapToolPrefixClassifications({}).all;
  let escalated = false;
  escalateToolPrefixTaint(
    "memory_save",
    map,
    (_level: ClassificationLevel, _reason: string) => {
      escalated = true;
    },
  );
  assertEquals(
    escalated,
    false,
    "memory_save must not trigger taint escalation",
  );
});

Deno.test("escalateToolPrefixTaint: memory_save does not escalate at RESTRICTED", () => {
  const map = mapToolPrefixClassifications({}).all;
  let escalated = false;
  escalateToolPrefixTaint(
    "memory_save",
    map,
    (_level: ClassificationLevel, _reason: string) => {
      escalated = true;
    },
  );
  assertEquals(
    escalated,
    false,
    "memory_save must not trigger taint escalation",
  );
});

Deno.test("escalateToolPrefixTaint: memory_delete does not escalate", () => {
  const map = mapToolPrefixClassifications({}).all;
  let escalated = false;
  escalateToolPrefixTaint(
    "memory_delete",
    map,
    (_level: ClassificationLevel, _reason: string) => {
      escalated = true;
    },
  );
  assertEquals(
    escalated,
    false,
    "memory_delete must not trigger taint escalation",
  );
});

Deno.test("escalateToolPrefixTaint: memory read tools do not escalate", () => {
  const map = mapToolPrefixClassifications({}).all;
  for (const tool of ["memory_get", "memory_search", "memory_list"]) {
    let escalatedLevel: ClassificationLevel | null = null;
    escalateToolPrefixTaint(
      tool,
      map,
      (level: ClassificationLevel, _reason: string) => {
        escalatedLevel = level;
      },
    );
    assertEquals(
      escalatedLevel,
      "PUBLIC",
      `${tool} should escalate to PUBLIC (its classification)`,
    );
  }
});

Deno.test("escalateToolPrefixTaint: write_file escalates to PUBLIC (no-op)", () => {
  const map = mapToolPrefixClassifications({}).all;
  let escalatedLevel: ClassificationLevel | null = null;
  escalateToolPrefixTaint(
    "write_file",
    map,
    (level: ClassificationLevel, _reason: string) => {
      escalatedLevel = level;
    },
  );
  assertEquals(
    escalatedLevel,
    "PUBLIC",
    "write_file should escalate to PUBLIC — taint comes from resource",
  );
});

// ─── Floor registry fallback ────────────────────────────────────────────────
// ssh_ and claude_ are NOT in the prefix map. Their classification comes
// from HARDCODED_TOOL_FLOORS via the ToolFloorRegistry fallback.

Deno.test("mapToolPrefixClassifications: ssh_ NOT in prefix map (uses floor registry)", () => {
  const map = mapToolPrefixClassifications({}).all;
  assertEquals(map.has("ssh_"), false, "ssh_ should not be in prefix map");
});

Deno.test("mapToolPrefixClassifications: claude_ NOT in prefix map (uses floor registry)", () => {
  const map = mapToolPrefixClassifications({}).all;
  assertEquals(
    map.has("claude_"),
    false,
    "claude_ should not be in prefix map",
  );
});

Deno.test("escalateToolPrefixTaint: ssh_execute escalates via floor registry fallback", () => {
  const map = mapToolPrefixClassifications({}).all;
  const registry = createToolFloorRegistry();
  let escalatedLevel: ClassificationLevel | null = null;
  escalateToolPrefixTaint(
    "ssh_execute",
    map,
    (level: ClassificationLevel, _reason: string) => {
      escalatedLevel = level;
    },
    registry,
  );
  assertEquals(
    escalatedLevel,
    "INTERNAL",
    "ssh_execute should escalate to INTERNAL via floor registry",
  );
});

Deno.test("escalateToolPrefixTaint: claude_session escalates via floor registry fallback", () => {
  const map = mapToolPrefixClassifications({}).all;
  const registry = createToolFloorRegistry();
  let escalatedLevel: ClassificationLevel | null = null;
  escalateToolPrefixTaint(
    "claude_session",
    map,
    (level: ClassificationLevel, _reason: string) => {
      escalatedLevel = level;
    },
    registry,
  );
  assertEquals(
    escalatedLevel,
    "INTERNAL",
    "claude_session should escalate to INTERNAL via floor registry",
  );
});

Deno.test("escalateToolPrefixTaint: no escalation when neither prefix nor floor match", () => {
  const map = mapToolPrefixClassifications({}).all;
  const registry = createToolFloorRegistry();
  let escalated = false;
  escalateToolPrefixTaint(
    "unknown_tool_xyz",
    map,
    (_level: ClassificationLevel, _reason: string) => {
      escalated = true;
    },
    registry,
  );
  assertEquals(escalated, false, "Unknown tool should not trigger escalation");
});

Deno.test("enforceNonOwnerToolCeiling: blocks ssh_execute via floor registry fallback", () => {
  const map = mapToolPrefixClassifications({}).all;
  const registry = createToolFloorRegistry();
  const err = enforceNonOwnerToolCeiling(
    "ssh_execute",
    "PUBLIC" as ClassificationLevel,
    map,
    registry,
  );
  assertNotEquals(
    err,
    null,
    "ssh_execute should be blocked for PUBLIC ceiling",
  );
  assert(
    err!.includes("INTERNAL"),
    "Error should mention INTERNAL classification",
  );
});

Deno.test("enforceNonOwnerToolCeiling: allows ssh_execute at INTERNAL ceiling via floor fallback", () => {
  const map = mapToolPrefixClassifications({}).all;
  const registry = createToolFloorRegistry();
  const err = enforceNonOwnerToolCeiling(
    "ssh_execute",
    "INTERNAL" as ClassificationLevel,
    map,
    registry,
  );
  assertEquals(err, null, "ssh_execute should be allowed at INTERNAL ceiling");
});

Deno.test("enforceTriggerToolCeiling: blocks ssh_execute at PUBLIC ceiling via floor fallback", () => {
  const map = mapToolPrefixClassifications({}).all;
  const registry = createToolFloorRegistry();
  const err = enforceTriggerToolCeiling(
    "ssh_execute",
    "PUBLIC" as ClassificationLevel,
    map,
    registry,
  );
  assertNotEquals(
    err,
    null,
    "ssh_execute should be blocked for PUBLIC trigger ceiling",
  );
});

Deno.test("enforceTriggerToolCeiling: allows ssh_execute at INTERNAL ceiling via floor fallback", () => {
  const map = mapToolPrefixClassifications({}).all;
  const registry = createToolFloorRegistry();
  const err = enforceTriggerToolCeiling(
    "ssh_execute",
    "INTERNAL" as ClassificationLevel,
    map,
    registry,
  );
  assertEquals(
    err,
    null,
    "ssh_execute should be allowed at INTERNAL trigger ceiling",
  );
});
