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
import type { ToolDefinition } from "../../core/types/tool.ts";
import type { ClassificationLevel } from "../../core/types/classification.ts";
import type { SkillLoader } from "./loader.ts";
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
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
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

    const matchesType = type === "BUNDLED"
      ? (s: { source: string }) => s.source === "bundled"
      : (s: { source: string }) =>
        s.source === "managed" || s.source === "workspace";

    const skill = skills.find(
      (s) => s.name === trimmedName && matchesType(s),
    );

    if (!skill) {
      const available = skills
        .filter(matchesType)
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

    // 2. Integrity check — hash content at activation time (TOCTOU-resistant)
    if (skill.source !== "bundled") {
      const currentHash = await computeSkillHash(content);
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
