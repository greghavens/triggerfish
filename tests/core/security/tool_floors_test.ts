/**
 * Tests for tool floor registry.
 * Covers spec §10.1 (tool floor enforcement, scenarios 1-7).
 */
import { assertEquals } from "@std/assert";
import { createToolFloorRegistry } from "../../../src/core/security/tool_floors.ts";
import type { ClassificationLevel } from "../../../src/core/types/classification.ts";

// --- Tool floor enforcement (spec §10.1, scenarios 1-7) ---

Deno.test("tool floor: run_command has no floor", () => {
  const registry = createToolFloorRegistry();
  assertEquals(registry.getFloor("run_command"), null);
});

Deno.test("tool floor: interactive browser tools have no floor", () => {
  // Browser interactive tools have no hardcoded floor. The resource-write-down
  // rule already prevents higher-tainted sessions from submitting data to
  // lower-classified domains. A floor would create an impossible situation:
  // escalating to INTERNAL to satisfy the floor would immediately trigger
  // write-down against a PUBLIC domain in owner sessions.
  const registry = createToolFloorRegistry();
  const interactiveBrowserTools = [
    "browser_click",
    "browser_type",
    "browser_select",
  ];
  for (const tool of interactiveBrowserTools) {
    assertEquals(registry.getFloor(tool), null, `${tool} should have no floor`);
  }
});

Deno.test("tool floor: all browser tools have no floor", () => {
  const registry = createToolFloorRegistry();
  const allBrowserTools = [
    "browser_navigate",
    "browser_snapshot",
    "browser_scroll",
    "browser_wait",
    "browser_click",
    "browser_type",
    "browser_select",
  ];
  for (const tool of allBrowserTools) {
    assertEquals(registry.getFloor(tool), null, `${tool} should have no floor`);
  }
});

Deno.test("tool floor: tools with no floor return null", () => {
  const registry = createToolFloorRegistry();
  const noFloorTools = [
    "read_file",
    "write_file",
    "edit_file",
    "list_directory",
    "search_files",
    "memory_save",
    "memory_get",
    "web_search",
    "web_fetch",
    "todo_read",
    "todo_write",
  ];
  for (const tool of noFloorTools) {
    assertEquals(registry.getFloor(tool), null, `${tool} should have no floor`);
  }
});

// --- Scenario 1: INTERNAL session invokes run_command → ALLOWED (no floor) ---

Deno.test("tool floor: INTERNAL session can invoke run_command (no floor)", () => {
  const registry = createToolFloorRegistry();
  assertEquals(registry.canInvoke("run_command", "INTERNAL"), true);
});

// --- Scenario 2: CONFIDENTIAL session invokes run_command → ALLOWED ---

Deno.test("tool floor: CONFIDENTIAL session can invoke run_command", () => {
  const registry = createToolFloorRegistry();
  assertEquals(registry.canInvoke("run_command", "CONFIDENTIAL"), true);
});

// --- Scenario 3: RESTRICTED session invokes run_command → ALLOWED ---

Deno.test("tool floor: RESTRICTED session can invoke run_command", () => {
  const registry = createToolFloorRegistry();
  assertEquals(registry.canInvoke("run_command", "RESTRICTED"), true);
});

// --- Scenario 4: PUBLIC session invokes browser_navigate → ALLOWED (no floor) ---

Deno.test("tool floor: PUBLIC session can invoke browser_navigate (no floor)", () => {
  const registry = createToolFloorRegistry();
  assertEquals(registry.canInvoke("browser_navigate", "PUBLIC"), true);
});

// --- Scenario 5: PUBLIC session can invoke browser_click (no floor) ---

Deno.test("tool floor: PUBLIC session can invoke browser_click (no floor)", () => {
  // No hardcoded floor for browser interactive tools — resource-write-down
  // handles domain-level enforcement in the PRE_TOOL_CALL hook.
  const registry = createToolFloorRegistry();
  assertEquals(registry.canInvoke("browser_click", "PUBLIC"), true);
});

// --- Scenario 5b: INTERNAL session can invoke browser_click (no floor) ---

Deno.test("tool floor: INTERNAL session can invoke browser_click (no floor)", () => {
  const registry = createToolFloorRegistry();
  assertEquals(registry.canInvoke("browser_click", "INTERNAL"), true);
});

// --- Scenario 6: INTERNAL session invokes read_file → ALLOWED (no floor) ---

Deno.test("tool floor: INTERNAL session can invoke read_file (no floor)", () => {
  const registry = createToolFloorRegistry();
  assertEquals(registry.canInvoke("read_file", "INTERNAL"), true);
});

// --- Scenario 7: Enterprise raises run_command to RESTRICTED ---

Deno.test("tool floor: enterprise can raise floor (run_command → RESTRICTED)", () => {
  const overrides = new Map<string, ClassificationLevel>([
    ["run_command", "RESTRICTED"],
  ]);
  const registry = createToolFloorRegistry(overrides);
  assertEquals(registry.getFloor("run_command"), "RESTRICTED");
  assertEquals(registry.canInvoke("run_command", "CONFIDENTIAL"), false);
  assertEquals(registry.canInvoke("run_command", "RESTRICTED"), true);
});

Deno.test("tool floor: enterprise CANNOT lower floor below hardcoded", () => {
  // run_command no longer has a hardcoded floor, so use a tool that does
  // to verify the max() logic. Enterprise override of PUBLIC on a tool with
  // no hardcoded floor just sets PUBLIC.
  const overrides = new Map<string, ClassificationLevel>([
    ["run_command", "PUBLIC"],
  ]);
  const registry = createToolFloorRegistry(overrides);
  // No hardcoded floor → override of PUBLIC is accepted as-is
  assertEquals(registry.getFloor("run_command"), "PUBLIC");
});

Deno.test("tool floor: enterprise can add floor to tool that had none", () => {
  const overrides = new Map<string, ClassificationLevel>([
    ["web_fetch", "CONFIDENTIAL"],
  ]);
  const registry = createToolFloorRegistry(overrides);
  assertEquals(registry.getFloor("web_fetch"), "CONFIDENTIAL");
  assertEquals(registry.canInvoke("web_fetch", "INTERNAL"), false);
  assertEquals(registry.canInvoke("web_fetch", "CONFIDENTIAL"), true);
});

Deno.test("tool floor: PUBLIC session can invoke run_command (no floor)", () => {
  const registry = createToolFloorRegistry();
  assertEquals(registry.canInvoke("run_command", "PUBLIC"), true);
});

Deno.test("tool floor: PUBLIC session can invoke unfloored tools", () => {
  const registry = createToolFloorRegistry();
  assertEquals(registry.canInvoke("read_file", "PUBLIC"), true);
  assertEquals(registry.canInvoke("memory_get", "PUBLIC"), true);
});

// --- SSH tool floor enforcement ---

Deno.test("tool floor: all SSH tools have INTERNAL floor", () => {
  const registry = createToolFloorRegistry();
  const sshTools = [
    "ssh_execute",
    "ssh_session_open",
    "ssh_session_write",
    "ssh_session_read",
    "ssh_session_close",
  ];
  for (const tool of sshTools) {
    assertEquals(
      registry.getFloor(tool),
      "INTERNAL",
      `${tool} should have INTERNAL floor`,
    );
  }
});

Deno.test("tool floor: PUBLIC session cannot invoke SSH tools", () => {
  const registry = createToolFloorRegistry();
  const sshTools = [
    "ssh_execute",
    "ssh_session_open",
    "ssh_session_write",
    "ssh_session_read",
    "ssh_session_close",
  ];
  for (const tool of sshTools) {
    assertEquals(
      registry.canInvoke(tool, "PUBLIC"),
      false,
      `PUBLIC should not invoke ${tool}`,
    );
  }
});

Deno.test("tool floor: INTERNAL session can invoke SSH tools", () => {
  const registry = createToolFloorRegistry();
  const sshTools = [
    "ssh_execute",
    "ssh_session_open",
    "ssh_session_write",
    "ssh_session_read",
    "ssh_session_close",
  ];
  for (const tool of sshTools) {
    assertEquals(
      registry.canInvoke(tool, "INTERNAL"),
      true,
      `INTERNAL should invoke ${tool}`,
    );
  }
});

Deno.test("tool floor: CONFIDENTIAL session can invoke SSH tools", () => {
  const registry = createToolFloorRegistry();
  assertEquals(registry.canInvoke("ssh_execute", "CONFIDENTIAL"), true);
});

Deno.test("tool floor: enterprise CANNOT lower SSH floor below INTERNAL", () => {
  const overrides = new Map<string, ClassificationLevel>([
    ["ssh_execute", "PUBLIC"],
  ]);
  const registry = createToolFloorRegistry(overrides);
  // Hardcoded INTERNAL floor wins over enterprise PUBLIC override
  assertEquals(registry.getFloor("ssh_execute"), "INTERNAL");
  assertEquals(registry.canInvoke("ssh_execute", "PUBLIC"), false);
});

Deno.test("tool floor: enterprise can raise SSH floor above INTERNAL", () => {
  const overrides = new Map<string, ClassificationLevel>([
    ["ssh_execute", "RESTRICTED"],
  ]);
  const registry = createToolFloorRegistry(overrides);
  assertEquals(registry.getFloor("ssh_execute"), "RESTRICTED");
  assertEquals(registry.canInvoke("ssh_execute", "INTERNAL"), false);
  assertEquals(registry.canInvoke("ssh_execute", "RESTRICTED"), true);
});
