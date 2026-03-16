/**
 * Service availability gating for tool profiles.
 *
 * Filters tool groups based on which external services are configured
 * and have credentials available. Also provides human-readable setup
 * instructions for unconfigured services.
 *
 * @module
 */

import type { ToolGroupName } from "./tool_groups.ts";
import type { ToolProfile } from "./tool_profile_defs.ts";
import type { ToolDefinition } from "../../../core/types/tool.ts";
import { resolveToolsForProfile } from "./tool_profile_defs.ts";

/** Which external services are configured and have credentials available. */
export interface ServiceAvailability {
  /** Google Workspace (keychain google:tokens). */
  readonly google: boolean;
  /** GitHub (keychain github-pat). */
  readonly github: boolean;
  /** CalDAV (config caldav.enabled). */
  readonly caldav: boolean;
  /** Notion (keychain notion-api-key). */
  readonly notion: boolean;
  /** Obsidian (config plugins.obsidian.enabled). */
  readonly obsidian: boolean;
  /** Signal channel (config channels.signal). */
  readonly signal: boolean;
  /** Telegram channel (config channels.telegram.botToken). */
  readonly telegram: boolean;
  /** Discord channel (config channels.discord). */
  readonly discord: boolean;
  /** WhatsApp channel (config channels.whatsapp). */
  readonly whatsapp: boolean;
}

/** Map from ServiceAvailability keys to the tool group names they gate. */
const SERVICE_TO_GROUP: Readonly<
  Partial<Record<keyof ServiceAvailability, ToolGroupName>>
> = {
  google: "google",
  github: "github",
  caldav: "caldav",
  notion: "notion",
  obsidian: "obsidian",
  signal: "signal",
};

/**
 * Remove tool groups for unconfigured services from a profile.
 *
 * Only groups listed in SERVICE_TO_GROUP are filtered — core groups
 * (sessions, memory, web, etc.) are never removed.
 */
export function filterProfileByAvailability(
  profile: ToolProfile,
  availability: ServiceAvailability,
): ToolProfile {
  const unavailableGroups = new Set<ToolGroupName>();
  for (
    const [service, group] of Object.entries(SERVICE_TO_GROUP) as [
      keyof ServiceAvailability,
      ToolGroupName,
    ][]
  ) {
    if (!availability[service]) {
      unavailableGroups.add(group);
    }
  }
  return profile.filter((g) => !unavailableGroups.has(g));
}

/** Human-readable setup instructions per service. */
const SERVICE_SETUP_HINTS: Readonly<
  Record<keyof ServiceAvailability, string>
> = {
  google: "Google Workspace — run `triggerfish connect google`",
  github: "GitHub — run `triggerfish connect github`",
  caldav: "CalDAV — set `caldav.enabled: true` in triggerfish.yaml",
  notion: "Notion — run `triggerfish connect notion`",
  obsidian:
    "Obsidian — set `plugins.obsidian.enabled: true` in triggerfish.yaml",
  signal: "Signal — configure `channels.signal` in triggerfish.yaml",
  telegram: "Telegram — configure `channels.telegram` in triggerfish.yaml",
  discord: "Discord — configure `channels.discord` in triggerfish.yaml",
  whatsapp: "WhatsApp — configure `channels.whatsapp` in triggerfish.yaml",
};

/**
 * Build a system prompt section listing unconfigured services.
 *
 * Returns an empty string if all services are configured.
 */
export function buildUnconfiguredServicesPrompt(
  availability: ServiceAvailability,
): string {
  const lines: string[] = [];
  for (
    const [service, hint] of Object.entries(SERVICE_SETUP_HINTS) as [
      keyof ServiceAvailability,
      string,
    ][]
  ) {
    if (!availability[service]) {
      lines.push(`  • ${hint}`);
    }
  }
  if (lines.length === 0) return "";
  return [
    "## Unconfigured Services",
    "",
    "The following integrations are available but not yet configured:",
    ...lines,
    "",
    "Tell the user about these when relevant to their request.",
  ].join("\n");
}

// ─── Backward-compatible buildToolDefinitions ───────────────────────────────

/**
 * Build all tool definitions (full set including tidepool).
 *
 * @deprecated Use `resolveToolsForProfile("cli")` or another profile instead.
 * Kept for backward compatibility — returns the "tidepool" profile (all tools).
 */
export function buildToolDefinitions(): readonly ToolDefinition[] {
  return resolveToolsForProfile("tidepool");
}

/** @deprecated Use buildToolDefinitions instead */
export const getToolDefinitions = buildToolDefinitions;
