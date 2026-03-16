/**
 * Pure enforcement functions for skill capability declarations.
 *
 * Three enforcement axes:
 * 1. Tool filtering — restrict visible tools to requires_tools
 * 2. Network domain gating — restrict web_fetch to network_domains
 * 3. Classification ceiling — block activation above declared ceiling
 *
 * All functions are pure (no I/O, no side effects) for easy unit testing.
 *
 * @module
 */

import type { Skill } from "./loader.ts";
import type { ToolDefinition } from "../../core/types/tool.ts";
import type { ClassificationLevel } from "../../core/types/classification.ts";
import { canFlowTo } from "../../core/types/classification.ts";

/**
 * Filter tool definitions to those declared in the active skill's requiresTools.
 *
 * - Returns original list if activeSkill is null (no skill active).
 * - Returns original list if skill.requiresTools is null (not declared = unrestricted).
 * - Filters to declared set (always preserving read_skill) if requiresTools is non-null.
 * - When requiresTools is [] (declared empty), only read_skill is preserved.
 */
export function filterToolsForActiveSkill(
  tools: readonly ToolDefinition[],
  activeSkill: Skill | null,
): readonly ToolDefinition[] {
  if (!activeSkill) return tools;
  if (activeSkill.requiresTools === null) return tools;

  if (activeSkill.requiresTools.length === 0) {
    return tools.filter((t) => t.name === "read_skill");
  }

  const allowed = new Set(activeSkill.requiresTools);
  return tools.filter((t) => t.name === "read_skill" || allowed.has(t.name));
}

/**
 * Check whether a URL's hostname is allowed by the active skill's networkDomains.
 *
 * Returns null if allowed. Returns an error string if blocked.
 * - Returns null if activeSkill is null or networkDomains is null (unrestricted).
 * - Blocks ALL fetches if networkDomains is [] (declared empty = no network).
 * - Domain matching: exact hostname or subdomain suffix (*.declared.com).
 */
export function enforceSkillNetworkDomain(
  url: string,
  activeSkill: Skill | null,
): string | null {
  if (!activeSkill) return null;
  if (activeSkill.networkDomains === null) return null;

  if (activeSkill.networkDomains.length === 0) {
    return `Skill "${activeSkill.name}" has declared no network access (network_domains: []).`;
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return `Skill network domain check failed: invalid URL "${url}".`;
  }

  const allowed = activeSkill.networkDomains.some(
    (d) => hostname === d || hostname.endsWith(`.${d}`),
  );

  if (!allowed) {
    return (
      `Domain "${hostname}" is not in skill "${activeSkill.name}" declared ` +
      `network_domains (${activeSkill.networkDomains.join(", ")}).`
    );
  }

  return null;
}

/**
 * Check if session taint allows activating a skill with the given ceiling.
 *
 * Rule: canFlowTo(sessionTaint, skill.classificationCeiling) must be true.
 * A CONFIDENTIAL-tainted session cannot activate a PUBLIC-ceiling skill
 * (would risk write-down through the skill's instructions).
 *
 * Returns null if allowed. Returns an error string if blocked.
 */
export function enforceSkillClassificationCeiling(
  sessionTaint: ClassificationLevel,
  skill: Skill,
): string | null {
  if (!canFlowTo(sessionTaint, skill.classificationCeiling)) {
    return (
      `Skill "${skill.name}" has classification ceiling ` +
      `${skill.classificationCeiling} but session taint is ${sessionTaint}. ` +
      `Cannot activate skill below session taint (write-down risk).`
    );
  }
  return null;
}

/** @deprecated Use enforceSkillNetworkDomain instead */
export const checkSkillNetworkDomain = enforceSkillNetworkDomain;
/** @deprecated Use enforceSkillClassificationCeiling instead */
export const checkSkillClassificationCeiling =
  enforceSkillClassificationCeiling;
