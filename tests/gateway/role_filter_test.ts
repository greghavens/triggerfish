/**
 * Tests for role-based tool filtering.
 *
 * Verifies that filterToolsForRole correctly strips owner-only tools
 * from the LLM-visible tool list for non-owner sessions, while
 * preserving safe tools that non-owners may invoke.
 */
import { assertEquals } from "@std/assert";
import type { ToolDefinition } from "../../src/core/types/tool.ts";
import {
  filterToolsForRole,
  OWNER_ONLY_TOOLS,
} from "../../src/gateway/tools/defs/role_filter.ts";

/** Build a minimal ToolDefinition stub for testing. */
function stubTool(name: string): ToolDefinition {
  return { name, description: `stub: ${name}`, parameters: {} };
}

// ─── Owner receives full tool list ─────────────────────────────────────────

Deno.test("filterToolsForRole: owner receives full tool list (no filtering)", () => {
  const tools: ToolDefinition[] = [
    stubTool("run_command"),
    stubTool("write_file"),
    stubTool("web_search"),
    stubTool("memory_search"),
    stubTool("browser_navigate"),
  ];
  const result = filterToolsForRole(tools, true);
  assertEquals(result.length, 5, "Owner should see all 5 tools");
  assertEquals(
    result.map((t) => t.name),
    ["run_command", "write_file", "web_search", "memory_search", "browser_navigate"],
  );
});

// ─── Non-owner never sees dangerous tools ──────────────────────────────────

Deno.test("filterToolsForRole: non-owner never receives run_command", () => {
  const tools = [stubTool("run_command"), stubTool("web_search")];
  const result = filterToolsForRole(tools, false);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "web_search");
});

Deno.test("filterToolsForRole: non-owner never receives write_file", () => {
  const tools = [stubTool("write_file"), stubTool("todo_read")];
  const result = filterToolsForRole(tools, false);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "todo_read");
});

Deno.test("filterToolsForRole: non-owner never receives edit_file", () => {
  const tools = [stubTool("edit_file"), stubTool("web_fetch")];
  const result = filterToolsForRole(tools, false);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "web_fetch");
});

Deno.test("filterToolsForRole: non-owner never receives browser_navigate", () => {
  const tools = [stubTool("browser_navigate"), stubTool("memory_search")];
  const result = filterToolsForRole(tools, false);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "memory_search");
});

Deno.test("filterToolsForRole: non-owner never receives memory_save or memory_delete", () => {
  const tools = [
    stubTool("memory_save"),
    stubTool("memory_delete"),
    stubTool("memory_search"),
  ];
  const result = filterToolsForRole(tools, false);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "memory_search");
});

Deno.test("filterToolsForRole: non-owner never receives secret_save", () => {
  const tools = [stubTool("secret_save"), stubTool("todo_write")];
  const result = filterToolsForRole(tools, false);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "todo_write");
});

Deno.test("filterToolsForRole: non-owner never receives cron_create", () => {
  const tools = [stubTool("cron_create"), stubTool("web_search")];
  const result = filterToolsForRole(tools, false);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "web_search");
});

Deno.test("filterToolsForRole: non-owner never receives trigger_add_to_context", () => {
  const tools = [stubTool("trigger_add_to_context"), stubTool("healthcheck")];
  const result = filterToolsForRole(tools, false);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "healthcheck");
});

Deno.test("filterToolsForRole: non-owner never receives subagent", () => {
  const tools = [stubTool("subagent"), stubTool("summarize")];
  const result = filterToolsForRole(tools, false);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "summarize");
});

Deno.test("filterToolsForRole: non-owner never receives claude_start", () => {
  const tools = [stubTool("claude_start"), stubTool("explore")];
  const result = filterToolsForRole(tools, false);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "explore");
});

Deno.test("filterToolsForRole: non-owner never receives sessions_send", () => {
  const tools = [stubTool("sessions_send"), stubTool("sessions_spawn"), stubTool("memory_get")];
  const result = filterToolsForRole(tools, false);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "memory_get");
});

// ─── Non-owner retains safe tools ──────────────────────────────────────────

Deno.test("filterToolsForRole: non-owner retains read_file and list_directory", () => {
  const tools = [
    stubTool("read_file"),
    stubTool("list_directory"),
    stubTool("search_files"),
    stubTool("write_file"),
  ];
  const result = filterToolsForRole(tools, false);
  assertEquals(result.length, 3);
  assertEquals(
    result.map((t) => t.name),
    ["read_file", "list_directory", "search_files"],
  );
});

Deno.test("filterToolsForRole: non-owner retains web_search and web_fetch", () => {
  const tools = [stubTool("web_search"), stubTool("web_fetch")];
  const result = filterToolsForRole(tools, false);
  assertEquals(result.length, 2);
});

Deno.test("filterToolsForRole: non-owner retains memory_search and memory_get", () => {
  const tools = [
    stubTool("memory_search"),
    stubTool("memory_get"),
    stubTool("memory_list"),
  ];
  const result = filterToolsForRole(tools, false);
  assertEquals(result.length, 3);
});

Deno.test("filterToolsForRole: non-owner retains todo_read and todo_write", () => {
  const tools = [stubTool("todo_read"), stubTool("todo_write")];
  const result = filterToolsForRole(tools, false);
  assertEquals(result.length, 2);
});

Deno.test("filterToolsForRole: non-owner retains healthcheck and summarize", () => {
  const tools = [stubTool("healthcheck"), stubTool("summarize")];
  const result = filterToolsForRole(tools, false);
  assertEquals(result.length, 2);
});

// ─── Edge cases ────────────────────────────────────────────────────────────

Deno.test("filterToolsForRole: empty tool list returns empty for both owner and non-owner", () => {
  assertEquals(filterToolsForRole([], true).length, 0);
  assertEquals(filterToolsForRole([], false).length, 0);
});

Deno.test("filterToolsForRole: all owner-only tools are in the OWNER_ONLY_TOOLS set", () => {
  // Verify that all critical owner-only tool names are actually in the set
  const criticalOwnerTools = [
    "write_file", "edit_file", "run_command",
    "browser_navigate", "browser_click", "browser_type",
    "memory_save", "memory_delete",
    "secret_save", "secret_delete",
    "cron_create", "cron_delete",
    "subagent", "agents_list",
    "claude_start", "claude_send",
    "sessions_send", "sessions_spawn",
    "plan_enter", "plan_exit",
    "tidepool_render_component", "tidepool_render_html",
  ];
  for (const name of criticalOwnerTools) {
    assertEquals(
      OWNER_ONLY_TOOLS.has(name),
      true,
      `Expected ${name} to be in OWNER_ONLY_TOOLS`,
    );
  }
});

Deno.test("filterToolsForRole: non-owner with full tool list keeps only safe subset", () => {
  const all = [
    stubTool("read_file"),
    stubTool("write_file"),
    stubTool("run_command"),
    stubTool("web_search"),
    stubTool("web_fetch"),
    stubTool("memory_search"),
    stubTool("memory_save"),
    stubTool("browser_navigate"),
    stubTool("todo_read"),
    stubTool("healthcheck"),
    stubTool("summarize"),
    stubTool("explore"),
    stubTool("image_analyze"),
  ];
  const result = filterToolsForRole(all, false);
  const names = result.map((t) => t.name);
  assertEquals(names.includes("write_file"), false);
  assertEquals(names.includes("run_command"), false);
  assertEquals(names.includes("memory_save"), false);
  assertEquals(names.includes("browser_navigate"), false);
  assertEquals(names.includes("read_file"), true);
  assertEquals(names.includes("web_search"), true);
  assertEquals(names.includes("memory_search"), true);
  assertEquals(names.includes("todo_read"), true);
  assertEquals(names.includes("healthcheck"), true);
  assertEquals(names.includes("explore"), true);
  assertEquals(names.includes("image_analyze"), true);
});
