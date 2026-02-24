/**
 * Role-based tool filtering for non-owner sessions.
 *
 * Defines the set of owner-only tools and a filter function that strips
 * them from the LLM-visible tool list. This is defense-in-depth on top
 * of the executor-layer ceiling enforcement in access_control.ts — the
 * LLM never sees tools it cannot invoke.
 *
 * @module
 */

import type { ToolDefinition } from "../../../core/types/tool.ts";
import { createLogger } from "../../../core/logger/mod.ts";

const log = createLogger("role-filter");

/**
 * Tool names restricted to the owner. Non-owner sessions never receive
 * these definitions in their LLM context, providing defense-in-depth
 * on top of the executor-layer ceiling enforcement.
 *
 * Names must match the `name` field on each ToolDefinition exactly.
 */
export const OWNER_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // Filesystem writes and execution
  "write_file",
  "edit_file",
  "run_command",
  // Browser automation
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_select",
  "browser_scroll",
  "browser_wait",
  "browser_describe",
  "browser_close",
  // Memory mutations
  "memory_save",
  "memory_delete",
  // Secret management
  "secret_save",
  "secret_list",
  "secret_delete",
  // Scheduling
  "cron_create",
  "cron_delete",
  "cron_history",
  // Trigger management
  "trigger_add_to_context",
  "get_tool_classification",
  // Skill management
  "read_skill",
  // Subagent spawning
  "subagent",
  "agents_list",
  // Session management (cross-session ops)
  "sessions_send",
  "sessions_spawn",
  "session_status",
  "message",
  "signal_generate_pairing",
  // Claude sessions
  "claude_start",
  "claude_send",
  "claude_output",
  "claude_status",
  "claude_stop",
  // Plan mode
  "plan_enter",
  "plan_exit",
  "plan_status",
  "plan_approve",
  "plan_reject",
  "plan_step_complete",
  "plan_complete",
  "plan_modify",
  // Tidepool canvas
  "tidepool_render_component",
  "tidepool_render_html",
  "tidepool_render_file",
  "tidepool_update",
  "tidepool_clear",
  // Obsidian vault mutations
  "obsidian_write",
  "obsidian_daily",
]);

/**
 * Filter tool definitions by user role.
 *
 * Non-owner sessions receive a restricted subset that excludes all
 * privileged operations. The LLM never sees tools it cannot invoke.
 * This is invoked once per LLM call when building the tool list.
 */
export function filterToolsForRole(
  tools: readonly ToolDefinition[],
  isOwner: boolean,
): readonly ToolDefinition[] {
  if (isOwner) return tools;
  const filtered = tools.filter((t) => !OWNER_ONLY_TOOLS.has(t.name));
  const removedCount = tools.length - filtered.length;
  log.warn("Restricted tool list for non-owner session", {
    operation: "filterToolsForRole",
    totalTools: tools.length,
    removedCount,
    allowedCount: filtered.length,
  });
  return filtered;
}
