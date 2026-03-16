/**
 * Team definition validation.
 *
 * Validates team name, task, member roles, lead count, and
 * classification ceiling consistency before team creation.
 *
 * @module
 */

import type { Result } from "../../core/types/classification.ts";
import { CLASSIFICATION_ORDER } from "../../core/types/classification.ts";
import type { TeamDefinition } from "./types.ts";

/** Validate a team definition before creation. */
export function enforceTeamDefinition(
  definition: TeamDefinition,
): Result<true, string> {
  if (!definition.name || definition.name.trim().length === 0) {
    return { ok: false, error: "Team name must not be empty" };
  }

  if (!definition.task || definition.task.trim().length === 0) {
    return { ok: false, error: "Team task must not be empty" };
  }

  if (!definition.members || definition.members.length === 0) {
    return { ok: false, error: "Team must have at least one member" };
  }

  const leads = definition.members.filter((m) => m.isLead);
  if (leads.length !== 1) {
    return {
      ok: false,
      error: `Team must have exactly one lead, found ${leads.length}`,
    };
  }

  const roles = new Set<string>();
  for (const member of definition.members) {
    if (!member.role || member.role.trim().length === 0) {
      return { ok: false, error: "Team member role must not be empty" };
    }
    if (roles.has(member.role)) {
      return { ok: false, error: `Duplicate team member role: ${member.role}` };
    }
    roles.add(member.role);
  }

  return validateMemberCeilings(definition);
}

/** Validate member classification ceilings against team ceiling. */
function validateMemberCeilings(
  definition: TeamDefinition,
): Result<true, string> {
  if (!definition.classificationCeiling) {
    return { ok: true, value: true };
  }

  const teamCeilingOrder =
    CLASSIFICATION_ORDER[definition.classificationCeiling];

  for (const member of definition.members) {
    if (member.classificationCeiling) {
      const memberCeilingOrder =
        CLASSIFICATION_ORDER[member.classificationCeiling];
      if (memberCeilingOrder > teamCeilingOrder) {
        return {
          ok: false,
          error:
            `Member "${member.role}" ceiling ${member.classificationCeiling} exceeds team ceiling ${definition.classificationCeiling}`,
        };
      }
    }
  }

  return { ok: true, value: true };
}

/** @deprecated Use enforceTeamDefinition instead */
export const validateTeamDefinition = enforceTeamDefinition;
