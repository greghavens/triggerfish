/**
 * Tool prefix classification map builder.
 *
 * Builds the prefix-to-classification mapping used for integration
 * security enforcement: taint escalation, write-down checks, and
 * non-owner tool ceiling enforcement.
 *
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";

/** Config shape for building integration/plugin/channel classification map. */
export interface ClassificationMapConfig {
  /** Google Workspace classification. */
  readonly google?: { readonly classification?: string };
  /** GitHub integration classification. */
  readonly github?: { readonly classification?: string };
  /** X (Twitter) integration classification. */
  readonly x?: { readonly classification?: string };
  /** Plugins keyed by name — each with enabled + classification. */
  readonly plugins?: Readonly<
    Record<
      string,
      | { readonly enabled?: boolean; readonly classification?: string }
      | undefined
    >
  >;
}

/**
 * Hardcoded classification levels for built-in tools.
 *
 * Entries are ordered from most-specific to least-specific so that
 * the prefix-matching loop in enforceNonOwnerToolCeiling hits the
 * right entry first. More-specific names (e.g. "memory_save") must
 * appear before group prefixes (e.g. "memory_").
 *
 * PUBLIC    — safe for any non-owner with a PUBLIC ceiling
 * INTERNAL  — read-only local operations, trusted non-owners
 * RESTRICTED — owner-only operations, never reachable by non-owners
 */
const BUILTIN_TOOL_CLASSIFICATIONS: ReadonlyArray<
  readonly [string, ClassificationLevel]
> = [
  // Memory — read tools are PUBLIC; save/delete are intentionally absent.
  ["memory_search", "PUBLIC"],
  ["memory_get", "PUBLIC"],
  ["memory_list", "PUBLIC"],
  // Filesystem — writes/exec owner-only, reads INTERNAL
  ["write_file", "PUBLIC"],
  ["edit_file", "PUBLIC"],
  ["run_command", "PUBLIC"],
  ["read_file", "PUBLIC"],
  ["list_directory", "PUBLIC"],
  ["search_files", "PUBLIC"],
  ["glob_files", "PUBLIC"],
  ["browser_", "PUBLIC"],
  // secret_list is the only secret tool classified here (read-only listing).
  ["secret_list", "PUBLIC"],
  ["cron", "PUBLIC"],
  ["trigger_", "PUBLIC"],
  // Skills — read_skill is read-only
  ["read_skill", "PUBLIC"],
  // Subagent / agents — owner-only (claude_ omitted: HARDCODED_TOOL_FLOORS
  // defines INTERNAL floor for claude_session/claude_output; floor registry
  // handles escalation without a prefix map entry)
  ["subagent", "PUBLIC"],
  ["agents_", "PUBLIC"],
  ["sessions_", "PUBLIC"],
  ["signal_", "PUBLIC"],
  ["channels_", "PUBLIC"],
  // Plan mode — owner-only
  ["plan_", "PUBLIC"],
  ["tidepool_", "PUBLIC"],
  // Obsidian — reads PUBLIC, writes RESTRICTED
  ["obsidian_write", "RESTRICTED"],
  ["obsidian_daily", "RESTRICTED"],
  ["obsidian_read", "INTERNAL"],
  ["obsidian_search", "INTERNAL"],
  ["obsidian_list", "INTERNAL"],
  ["obsidian_links", "INTERNAL"],
  // Local system introspection — INTERNAL, aligned with HARDCODED_TOOL_FLOORS
  // (healthcheck reveals system internals; log_read exposes daemon logs)
  ["healthcheck", "INTERNAL"],
  ["log_read", "INTERNAL"],
  // Safe for non-owners
  ["web_", "PUBLIC"],
  ["todo_", "PUBLIC"],
  ["summarize", "PUBLIC"],
  ["image_", "PUBLIC"],
  ["explore", "PUBLIC"],
  ["llm_task", "PUBLIC"],
  ["simulate_tool_call", "PUBLIC"],
];

/** Return type of mapToolPrefixClassifications. */
export interface ToolClassificationMaps {
  /** All prefixes: integrations + built-in tools. Used for taint escalation and non-owner ceiling. */
  readonly all: Map<string, ClassificationLevel>;
  /** Integration prefixes only (Google, GitHub, plugins). Used for write-down checks. */
  readonly integrations: Map<string, ClassificationLevel>;
}

/**
 * Build tool prefix -> classification map for integrations, plugins, channels,
 * and built-in tools.
 *
 * Integration-specific overrides (Google, GitHub, plugins) are inserted first.
 * Built-in tool classifications are appended afterward so that explicit
 * integration config always takes precedence.
 *
 * Returns two maps:
 * - `all`: every prefix (integrations + built-ins). Used for taint escalation
 *   and non-owner ceiling enforcement.
 * - `integrations`: only integration prefixes (Google, GitHub, plugins, MCP).
 *   Used for write-down checks.
 */
export function mapToolPrefixClassifications(
  config: ClassificationMapConfig,
): ToolClassificationMaps {
  const all = new Map<string, ClassificationLevel>();
  const integrations = new Map<string, ClassificationLevel>();

  // Google Workspace — gmail_, calendar_, drive_, sheets_, tasks_
  const googleClassification =
    (config.google?.classification ?? "PUBLIC") as ClassificationLevel;
  for (
    const prefix of ["gmail_", "calendar_", "drive_", "sheets_", "tasks_"]
  ) {
    all.set(prefix, googleClassification);
    integrations.set(prefix, googleClassification);
  }

  // GitHub — all tools start with github_
  const githubClassification =
    (config.github?.classification ?? "PUBLIC") as ClassificationLevel;
  all.set("github_", githubClassification);
  integrations.set("github_", githubClassification);

  // X (Twitter) — x_posts, x_users, x_engage, x_lists, x_quota
  const xClassification =
    (config.x?.classification ?? "INTERNAL") as ClassificationLevel;
  all.set("x_", xClassification);
  integrations.set("x_", xClassification);

  // Plugins — each plugin's tools use {pluginName}_ prefix convention
  if (config.plugins) {
    for (const [name, pluginConfig] of Object.entries(config.plugins)) {
      const cfg = pluginConfig as
        | { enabled?: boolean; classification?: string }
        | undefined;
      if (cfg?.enabled) {
        const level = (cfg.classification ?? "INTERNAL") as ClassificationLevel;
        all.set(`${name}_`, level);
        integrations.set(`${name}_`, level);
      }
    }
  }

  // Built-in tool classifications (not user-configurable) — only in `all`
  for (const [prefix, level] of BUILTIN_TOOL_CLASSIFICATIONS) {
    if (!all.has(prefix)) all.set(prefix, level);
  }

  return { all, integrations };
}
