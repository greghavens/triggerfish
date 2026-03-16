/**
 * Team spawner — creates specialist teams based on intervention category.
 *
 * Uses the existing TeamManager infrastructure from agent/team/.
 * Team composition varies by intervention category.
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";
import type { InterventionCategory } from "../../core/types/healing.ts";
import type { SessionId } from "../../core/types/session.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("healing-team-spawner");

/** Options for spawning a healing team. */
export interface SpawnTeamOptions {
  /** The intervention category that determines team composition. */
  readonly category: InterventionCategory;
  /** The lead agent's session ID. */
  readonly leadSessionId: SessionId;
  /** Current taint level (team members inherit this). */
  readonly currentTaint: ClassificationLevel;
  /** The workflow name for context. */
  readonly workflowName: string;
  /** The failed task name for context. */
  readonly failedTaskName: string;
  /** Function to create a team via TeamManager. */
  readonly createTeam: (definition: TeamComposition) => Promise<TeamHandle>;
}

/** Team composition definition. */
export interface TeamComposition {
  readonly name: string;
  readonly roles: readonly TeamRole[];
  readonly createdBy: SessionId;
  readonly taint: ClassificationLevel;
}

/** A role within a healing team. */
export interface TeamRole {
  readonly name: string;
  readonly description: string;
}

/** Handle for managing a spawned team. */
export interface TeamHandle {
  readonly teamId: string;
  readonly disband: () => Promise<void>;
}

/** Resolve team composition based on intervention category. */
export function resolveTeamComposition(
  options: SpawnTeamOptions,
): TeamComposition {
  const roles = resolveRolesForCategory(options.category);
  return {
    name: `healing-${options.workflowName}-${options.failedTaskName}`,
    roles,
    createdBy: options.leadSessionId,
    taint: options.currentTaint,
  };
}

/** Spawn a specialist healing team for an intervention. */
export async function spawnHealingTeam(
  options: SpawnTeamOptions,
): Promise<TeamHandle> {
  const composition = resolveTeamComposition(options);

  log.info("Spawning healing team", {
    operation: "spawnHealingTeam",
    category: options.category,
    workflowName: options.workflowName,
    failedTask: options.failedTaskName,
    roleCount: composition.roles.length,
    taint: options.currentTaint,
  });

  const handle = await options.createTeam(composition);

  log.info("Healing team spawned", {
    operation: "spawnHealingTeam",
    teamId: handle.teamId,
    workflowName: options.workflowName,
  });

  return handle;
}

/** Map intervention categories to team role compositions. */
function resolveRolesForCategory(
  category: InterventionCategory,
): readonly TeamRole[] {
  switch (category) {
    case "transient_retry":
      return [
        {
          name: "retry-coordinator",
          description: "Manages retry timing and backoff strategy",
        },
      ];
    case "runtime_workaround":
      return [
        {
          name: "diagnostician",
          description: "Analyzes the failure root cause",
        },
        {
          name: "workaround-author",
          description: "Designs an alternative approach for this run",
        },
      ];
    case "structural_fix":
      return [
        {
          name: "diagnostician",
          description: "Analyzes the root cause of the structural issue",
        },
        {
          name: "definition-fixer",
          description: "Authors the corrected workflow definition",
        },
      ];
    case "plugin_gap":
      return [
        {
          name: "diagnostician",
          description: "Identifies the plugin/integration issue",
        },
        {
          name: "plugin-author",
          description: "Creates or updates the required plugin",
        },
      ];
    case "unresolvable":
      return [
        {
          name: "diagnostician",
          description: "Produces structured diagnosis for escalation",
        },
      ];
  }
}
