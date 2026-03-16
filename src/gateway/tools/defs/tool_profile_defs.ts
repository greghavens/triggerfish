/**
 * Tool profiles and system prompt resolution.
 *
 * A profile is an ordered list of tool group names, assembled for
 * a specific runtime context (CLI, tidepool, trigger, cron, subagent).
 *
 * @module
 */

import { TODO_SYSTEM_PROMPT } from "../../../tools/mod.ts";
import { MEMORY_SYSTEM_PROMPT } from "../../../tools/memory/mod.ts";
import { SECRET_TOOLS_SYSTEM_PROMPT } from "../../../tools/secrets.ts";
import { WEB_TOOLS_SYSTEM_PROMPT } from "../../../tools/web/mod.ts";
import { PLAN_SYSTEM_PROMPT } from "../../../agent/plan/tools.ts";
import { TIDEPOOL_SYSTEM_PROMPT } from "../../../tools/tidepool/mod.ts";
import { SESSION_TOOLS_SYSTEM_PROMPT } from "../session/session_tools.ts";
import { IMAGE_TOOLS_SYSTEM_PROMPT } from "../../../tools/image/mod.ts";
import { EXPLORE_SYSTEM_PROMPT } from "../../../tools/explore/mod.ts";
import {
  LLM_TASK_SYSTEM_PROMPT,
  RELEASE_NOTES_SYSTEM_PROMPT,
  SUMMARIZE_SYSTEM_PROMPT,
} from "../../../tools/mod.ts";
import { TRIGGER_TOOLS_SYSTEM_PROMPT } from "../trigger/trigger_tools.ts";
import { TRIGGER_MANAGE_SYSTEM_PROMPT } from "../trigger/trigger_manage_defs.ts";
import { CLAUDE_SESSION_SYSTEM_PROMPT } from "../../../exec/claude.ts";
import { LOG_READER_SYSTEM_PROMPT } from "../../../tools/log_reader_tool.ts";
import { GITHUB_TOOLS_SYSTEM_PROMPT } from "../../../integrations/github/mod.ts";
import { OBSIDIAN_SYSTEM_PROMPT } from "../../../tools/obsidian/mod.ts";
import { HEALTHCHECK_SYSTEM_PROMPT } from "../../../tools/healthcheck.ts";
import { SIMULATE_SYSTEM_PROMPT } from "../../../tools/simulate/mod.ts";
import { TEAM_SYSTEM_PROMPT } from "../../../agent/team/mod.ts";
import { WORKFLOW_SYSTEM_PROMPT } from "../../../workflow/mod.ts";
import { SSH_SYSTEM_PROMPT } from "../../../tools/ssh/mod.ts";
import { TOOL_GROUPS, type ToolGroupName } from "./tool_groups.ts";
import type { ToolDefinition } from "../../../core/types/tool.ts";

// ─── Tool profiles ──────────────────────────────────────────────────────────

/** A tool profile is an ordered list of group names. */
export type ToolProfile = readonly ToolGroupName[];

/** Pre-built profiles for common contexts. */
export const TOOL_PROFILES: Readonly<Record<string, ToolProfile>> = {
  /** Tidepool web UI — full tool access including canvas. */
  tidepool: [
    "exec_file",
    "exec_command",
    "todo",
    "memory",
    "secrets",
    "web",
    "plan",
    "browser",
    "tidepool",
    "sessions",
    "signal",
    "image",
    "explore",
    "google",
    "github",
    "caldav",
    "notion",
    "obsidian",
    "llmTask",
    "summarize",
    "healthcheck",
    "trigger",
    "triggerManage",
    "claude",
    "skills",
    "releaseNotes",
    "logReader",
    "agents",
    "cron",
    "simulate",
    "team",
    "workflow",
    "ssh",
  ],
  /** CLI chat — everything except tidepool canvas tools. */
  cli: [
    "exec_file",
    "exec_command",
    "todo",
    "memory",
    "secrets",
    "web",
    "plan",
    "browser",
    "sessions",
    "signal",
    "image",
    "explore",
    "google",
    "github",
    "caldav",
    "notion",
    "obsidian",
    "llmTask",
    "summarize",
    "healthcheck",
    "trigger",
    "triggerManage",
    "claude",
    "skills",
    "releaseNotes",
    "logReader",
    "agents",
    "cron",
    "simulate",
    "team",
    "workflow",
    "ssh",
  ],
  /** Trigger sessions — sandboxed file tools only, no run_command. */
  triggerSession: [
    "exec_file",
    "todo",
    "memory",
    "web",
    "google",
    "github",
    "caldav",
    "notion",
    "llmTask",
    "summarize",
    "healthcheck",
    "trigger",
    "skills",
    "cron",
    "simulate",
    "workflow",
  ],
  /** Cron jobs — sandboxed file tools only, no run_command. */
  cronJob: [
    "exec_file",
    "todo",
    "memory",
    "web",
    "google",
    "github",
    "caldav",
    "notion",
    "llmTask",
    "summarize",
    "healthcheck",
    "skills",
    "cron",
    "simulate",
    "workflow",
  ],
  /** Subagents — sandboxed file tools only, no run_command. */
  subagent: [
    "exec_file",
    "todo",
    "memory",
    "web",
    "google",
    "github",
    "caldav",
    "notion",
    "llmTask",
    "summarize",
    "healthcheck",
    "skills",
  ],
};

/** Name of a pre-built tool profile. */
export type ToolProfileName = keyof typeof TOOL_PROFILES;

/**
 * Resolve a profile to its tool definitions.
 *
 * Accepts either a profile name (string key into TOOL_PROFILES) or
 * an ad-hoc list of group names for custom profiles.
 */
export function resolveToolsForProfile(
  profile: ToolProfileName | ToolProfile,
): readonly ToolDefinition[] {
  const groups: ToolProfile = typeof profile === "string"
    ? TOOL_PROFILES[profile] ?? []
    : profile;
  return groups.flatMap((g) => [...TOOL_GROUPS[g]()]);
}

// ─── System prompt sections per group ───────────────────────────────────────

/**
 * Map tool groups to their system prompt section (if any).
 *
 * Groups without a dedicated system prompt section (exec, browser, google,
 * agents, cron, caldav, skills) are omitted — the tool descriptions
 * in the JSON schema are sufficient.
 */
export const TOOL_GROUP_PROMPTS: Partial<
  Readonly<Record<ToolGroupName, string>>
> = {
  todo: TODO_SYSTEM_PROMPT,
  web: WEB_TOOLS_SYSTEM_PROMPT,
  memory: MEMORY_SYSTEM_PROMPT,
  plan: PLAN_SYSTEM_PROMPT,
  tidepool: TIDEPOOL_SYSTEM_PROMPT,
  sessions: SESSION_TOOLS_SYSTEM_PROMPT,
  image: IMAGE_TOOLS_SYSTEM_PROMPT,
  explore: EXPLORE_SYSTEM_PROMPT,
  llmTask: LLM_TASK_SYSTEM_PROMPT,
  summarize: SUMMARIZE_SYSTEM_PROMPT,
  claude: CLAUDE_SESSION_SYSTEM_PROMPT,
  secrets: SECRET_TOOLS_SYSTEM_PROMPT,
  trigger: TRIGGER_TOOLS_SYSTEM_PROMPT,
  triggerManage: TRIGGER_MANAGE_SYSTEM_PROMPT,
  releaseNotes: RELEASE_NOTES_SYSTEM_PROMPT,
  logReader: LOG_READER_SYSTEM_PROMPT,
  github: GITHUB_TOOLS_SYSTEM_PROMPT,
  obsidian: OBSIDIAN_SYSTEM_PROMPT,
  healthcheck: HEALTHCHECK_SYSTEM_PROMPT,
  simulate: SIMULATE_SYSTEM_PROMPT,
  team: TEAM_SYSTEM_PROMPT,
  workflow: WORKFLOW_SYSTEM_PROMPT,
  ssh: SSH_SYSTEM_PROMPT,
};

/**
 * Get system prompt sections for a profile.
 *
 * Returns only the prompts for groups included in the profile,
 * filtering out groups that have no dedicated prompt section.
 */
export function resolvePromptsForProfile(
  profile: ToolProfileName | ToolProfile,
): readonly string[] {
  const groups: ToolProfile = typeof profile === "string"
    ? TOOL_PROFILES[profile] ?? []
    : profile;
  return groups
    .map((g) => TOOL_GROUP_PROMPTS[g])
    .filter((p): p is string => p !== undefined && p.length > 0);
}
