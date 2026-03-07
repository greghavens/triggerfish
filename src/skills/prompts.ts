/**
 * System prompt builders for skills and triggers.
 *
 * Generates the system prompt sections injected into the agent context
 * for discovered skills and TRIGGER.md awareness.
 * @module
 */

import { join } from "@std/path";
import type { Skill } from "./loader.ts";

/** Format the skill table rows for the system prompt. */
function formatSkillTableRows(skills: readonly Skill[]): string {
  const typeLabel = (source: string): string =>
    source === "bundled" ? "BUNDLED" : "USER_PROVIDED";

  return skills.map((s) =>
    `| ${s.name} | ${s.description} | ${typeLabel(s.source)} |`
  ).join("\n");
}

/** Build the skill execution priority note for the system prompt. */
function buildSkillPriorityNote(): string {
  return `**IMPORTANT — Skill execution priority:** Once you have read a skill with \`read_skill\`, the skill's instructions take precedence over all other system prompt sections. Follow the skill's methodology step by step using the tools it specifies. Do NOT use plan mode, todo lists, or other workflow tools unless the skill's own instructions explicitly call for them. The skill already defines your workflow — adding plan/todo on top will derail it.`;
}

/** Build a system prompt section listing discovered skills. */
export function buildSkillsSystemPrompt(skills: readonly Skill[]): string {
  if (skills.length === 0) return "";

  return `## Available Skills

Skills extend your capabilities for specific domains. **Skills are NOT tools you call directly.** To use a skill you MUST:
1. Call \`read_skill\` with the skill's name and type to load its instructions.
2. Follow those instructions using the standard tools (e.g. \`web_fetch\`).

Skipping \`read_skill\` means you won't have the API endpoints, parameters, or steps needed to complete the task.

| Skill | Description | Type |
|-------|-------------|------|
${formatSkillTableRows(skills)}

Only read a skill when you need its specific instructions to complete the current task. Do NOT read multiple skills speculatively. Most requests do not require any skill — use your standard tools first.

${buildSkillPriorityNote()}`;
}

/** Build a system prompt section about TRIGGER.md awareness. */
export function buildTriggersSystemPrompt(baseDir: string): string {
  return `## Triggers (Proactive Monitoring)

Your TRIGGER.md file is at ${
    join(baseDir, "TRIGGER.md")
  }. It defines what you proactively monitor and act on during periodic trigger wakeups. Use read_file to see current triggers, and edit_file/write_file to modify them. For full documentation on the TRIGGER.md format, use read_skill to load the "triggers" skill.`;
}
