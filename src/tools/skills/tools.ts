/**
 * Skill tools — LLM-callable operations for reading skills.
 *
 * Provides the `read_skill` tool which reads SKILL.md content from
 * bundled or user-provided skills. Enforces security checks at
 * activation time:
 * 1. Classification ceiling — session taint must not exceed skill ceiling
 * 2. Content integrity — SHA-256 hash verified for non-bundled skills
 * 3. Scanner — content scanned for injection patterns
 * 4. Context tracking — active skill set for tool/domain enforcement
 *
 * @module
 */

import { join } from "@std/path";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../core/types/tool.ts";
import type { ClassificationLevel } from "../../core/types/classification.ts";
import type { SkillLoader, SkillSource } from "./loader.ts";
import { enforceSkillName } from "./registry_types.ts";
import type { SkillContextTracker } from "./context.ts";
import type { SkillScanner } from "./scanner.ts";
import { enforceSkillClassificationCeiling } from "./enforcer.ts";
import { computeSkillHash, verifySkillIntegrity } from "./integrity.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("skill-tools");

/** Skill type argument accepted by read_skill. */
export type SkillType = "BUNDLED" | "USER_PROVIDED";

/** Context required by the skill tool executor. */
export interface SkillToolContext {
  /** Skill loader used to discover available skills. */
  readonly skillLoader: SkillLoader;
  /** If provided, the active skill is tracked for tool filtering and domain enforcement. */
  readonly skillContextTracker?: SkillContextTracker;
  /** If provided, classification ceiling is checked before activation. */
  readonly getSessionTaint?: () => ClassificationLevel;
  /** If provided, skill content is scanned at activation time. */
  readonly skillScanner?: SkillScanner;
}

function buildReadSkillDef(): ToolDefinition {
  return {
    name: "read_skill",
    description:
      "Read the full content of a skill (SKILL.md) by type and name. " +
      "Use this to learn what a skill does, how to activate it, and what " +
      "tools it requires. Reading a skill never escalates the session " +
      "security level — use this instead of read_file when you need to " +
      "inspect skill instructions. " +
      "type must be BUNDLED (skills shipped with Triggerfish) or " +
      "USER_PROVIDED (skills installed or authored by the user).",
    parameters: {
      type: {
        type: "string",
        description: "Skill source type: BUNDLED or USER_PROVIDED",
        required: true,
        enum: ["BUNDLED", "USER_PROVIDED"],
      },
      skill_name: {
        type: "string",
        description:
          "Name of the skill to read (e.g. 'weather', 'deep-research')",
        required: true,
      },
    },
  };
}

/** Tool definitions for skill reading operations. */
export function buildSkillToolDefinitions(): readonly ToolDefinition[] {
  return [buildReadSkillDef()];
}

/** The owner can discover currently eligible skills without activating one. */
export function buildSkillAdministrationToolDefinitions(): readonly ToolDefinition[] {
  return [{
    name: "list_skills",
    description:
      "List active skills from the current owner skill registry. The result includes skill names and sources, with no instruction content. A skill can be opened with read_skill.",
    parameters: {
      type: {
        type: "string",
        description: "Optional source filter",
        enum: ["BUNDLED", "USER_PROVIDED"],
      },
      after: {
        type: "string",
        description: "Skill name returned as next_after on the preceding page",
      },
      limit: {
        type: "integer",
        description: "Maximum number of skills to return, from 1 to 100",
      },
    },
  }];
}

function skillType(source: SkillSource): SkillType {
  return source === "bundled" ? "BUNDLED" : "USER_PROVIDED";
}

function validSkillSelector(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 &&
    enforceSkillName(value).ok;
}

async function executeListSkills(
  ctx: SkillToolContext,
  input: Record<string, unknown>,
  dispatch?: ToolExecutionContext,
): Promise<string> {
  const isCurrentOwner = dispatch?.isCurrentInteractiveOwner;
  if (!isCurrentOwner?.() || !ctx.getSessionTaint) {
    return "Error: Skill discovery requires the active owner session.";
  }
  const { type, after, limit = 25 } = input;
  if (
    Object.keys(input).some((key) =>
      !["type", "after", "limit"].includes(key)
    ) ||
    (type !== undefined && type !== "BUNDLED" && type !== "USER_PROVIDED") ||
    (after !== undefined && !validSkillSelector(after)) ||
    typeof limit !== "number" || !Number.isSafeInteger(limit) ||
    limit < 1 || limit > 100
  ) return "Error: Invalid skill listing filter or cursor.";

  const skills = await ctx.skillLoader.discover();
  if (!isCurrentOwner()) return "Error: The owner session is no longer active.";
  const taint = ctx.getSessionTaint();
  const candidates = skills.filter((skill) =>
    validSkillSelector(skill.name) &&
    (type === undefined || skillType(skill.source) === type) &&
    (after === undefined || skill.name > after) &&
    !enforceSkillClassificationCeiling(taint, skill)
  ).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const page = candidates.slice(0, limit);
  return JSON.stringify({
    skills: page.map((skill) => ({
      name: skill.name,
      type: skillType(skill.source),
      source: skill.source,
      classification_ceiling: skill.classificationCeiling,
      version:
        typeof skill.version === "string" && skill.version.length <= 80 &&
          /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)*$/.test(skill.version)
          ? skill.version
          : null,
    })),
    next_after: candidates.length > limit ? page.at(-1)?.name : null,
    _classification: taint,
  });
}

/**
 * Create a tool executor for skill reading operations.
 *
 * Returns null for unknown tool names (allowing chaining with other executors).
 *
 * When optional security context is provided (skillContextTracker, getSessionTaint,
 * skillScanner), enforces classification ceiling, content integrity, and
 * scanner checks before activation.
 *
 * @param ctx - Context containing the skill loader and optional security wiring
 */
export function createSkillToolExecutor(
  ctx: SkillToolContext,
): (
  name: string,
  input: Record<string, unknown>,
  context?: ToolExecutionContext,
) => Promise<string | null> {
  return async (
    name: string,
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string | null> => {
    if (name === "list_skills") {
      return await executeListSkills(ctx, input, context);
    }
    if (name !== "read_skill") return null;

    const type = input.type;
    const skillName = input.skill_name;

    if (
      typeof type !== "string" ||
      (type !== "BUNDLED" && type !== "USER_PROVIDED")
    ) {
      return "Error: read_skill requires 'type' to be BUNDLED or USER_PROVIDED.";
    }

    if (typeof skillName !== "string" || skillName.trim().length === 0) {
      return "Error: read_skill requires a non-empty 'skill_name' argument.";
    }

    const trimmedName = skillName.trim();
    const skills = await ctx.skillLoader.discover();

    const matchesType = (s: { source: SkillSource }) =>
      skillType(s.source) === type;

    const skill = skills.find(
      (s) => s.name === trimmedName && matchesType(s),
    );

    if (!skill) {
      const taint = ctx.getSessionTaint?.();
      const available = skills
        .filter((candidate) =>
          matchesType(candidate) &&
          (taint === undefined ||
            !enforceSkillClassificationCeiling(taint, candidate))
        )
        .map((s) => s.name)
        .sort()
        .join(", ");
      return JSON.stringify({
        found: false,
        skill_name: trimmedName,
        type,
        available: available || "(none)",
      });
    }

    // ─── Security enforcement at activation time ─────────────────────────────

    // 1. Classification ceiling check
    if (ctx.getSessionTaint) {
      const taint = ctx.getSessionTaint();
      const ceilingError = enforceSkillClassificationCeiling(taint, skill);
      if (ceilingError) {
        log.warn("Skill activation blocked by classification ceiling", {
          operation: "readSkillCeilingCheck",
          skillName: skill.name,
          sessionTaint: taint,
          skillCeiling: skill.classificationCeiling,
        });
        return `Error: ${ceilingError}`;
      }
    }

    // Read the SKILL.md content from disk
    const skillMdPath = join(skill.path, "SKILL.md");
    let content: string;
    try {
      content = await Deno.readTextFile(skillMdPath);
    } catch (err) {
      return `Error: Failed to read skill "${trimmedName}": ${
        err instanceof Error ? err.message : String(err)
      }`;
    }

    // 2. Verify the content still matches the entry selected at discovery.
    const currentHash = await computeSkillHash(content);
    if (skill.contentHash !== currentHash) {
      return "Error: The skill changed during activation. Retry discovery.";
    }
    if (skill.source !== "bundled") {
      const integrityOk = await verifySkillIntegrity(skill.path, currentHash);
      if (integrityOk === false) {
        log.warn("Skill content integrity check failed", {
          operation: "readSkillIntegrityCheck",
          skillName: skill.name,
          skillPath: skill.path,
        });
        return `Error: Skill "${skill.name}" content has been tampered. Reinstall from The Reef.`;
      }
    }

    // 3. Scanner check at activation time
    if (ctx.skillScanner) {
      const scanResult = await ctx.skillScanner.scan(content);
      if (!scanResult.ok) {
        log.warn("Skill activation blocked by scanner", {
          operation: "readSkillScannerCheck",
          skillName: skill.name,
          warnings: scanResult.warnings,
        });
        return `Error: Skill "${skill.name}" failed security scan: ${
          scanResult.warnings.join("; ")
        }`;
      }
    }

    // 4. Track the active skill for tool filtering and domain enforcement
    ctx.skillContextTracker?.setActive(skill);

    return JSON.stringify({
      found: true,
      skill_name: skill.name,
      type,
      source: skill.source,
      classification_ceiling: skill.classificationCeiling,
      requires_tools: skill.requiresTools,
      network_domains: skill.networkDomains,
      content,
    });
  };
}

/** @deprecated Use buildSkillToolDefinitions instead */
export const getSkillToolDefinitions = buildSkillToolDefinitions;
