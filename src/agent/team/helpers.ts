/**
 * Team helper functions — taint computation, storage keys, member lookups, disband.
 *
 * Pure utility functions shared across team manager, lifecycle monitoring,
 * and serialization modules.
 *
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";
import { maxClassification } from "../../core/types/classification.ts";
import type { TeamId, TeamInstance, TeamMemberInstance } from "./types.ts";
import { TEAM_STORAGE_PREFIX } from "./types.ts";
import type { TeamManagerDeps } from "./manager_types.ts";
import {
  deserializeTeamInstance,
  serializeTeamInstance,
} from "./serialization.ts";
import type { LifecycleMonitor } from "./lifecycle.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("team-helpers");

/** Compute aggregate taint across all team members. */
export function computeAggregateTaint(
  members: readonly TeamMemberInstance[],
): ClassificationLevel {
  let aggregate: ClassificationLevel = "PUBLIC";
  for (const member of members) {
    aggregate = maxClassification(aggregate, member.currentTaint);
  }
  return aggregate;
}

/** Build the storage key for a team. */
export function buildStorageKey(teamId: TeamId): string {
  return `${TEAM_STORAGE_PREFIX}${teamId}`;
}

/** Find the lead member in a team. */
export function findLeadMember(
  team: TeamInstance,
): TeamMemberInstance | undefined {
  return team.members.find((m) => m.isLead);
}

/** Find a member by role. */
export function findMemberByRole(
  team: TeamInstance,
  role: string,
): TeamMemberInstance | undefined {
  return team.members.find((m) => m.role === role);
}

/** Refresh member taint levels from live sessions. */
export async function refreshMemberTaints(
  members: readonly TeamMemberInstance[],
  deps: TeamManagerDeps,
): Promise<TeamMemberInstance[]> {
  const updated: TeamMemberInstance[] = [];
  for (const member of members) {
    if (member.status === "completed" || member.status === "failed") {
      updated.push(member);
      continue;
    }
    const taint = await deps.getSessionTaint(member.sessionId);
    updated.push(taint !== null ? { ...member, currentTaint: taint } : member);
  }
  return updated;
}

/** Options for the shared disband operation. */
export interface ExecuteDisbandOptions {
  readonly teamId: TeamId;
  readonly reason?: string;
  readonly operationName: string;
}

/**
 * Execute the shared disband logic: terminate members, refresh taints,
 * persist the disbanded state, and stop the lifecycle monitor.
 *
 * Used by both `disbandTeam` (after auth check) and `forceDisbandTeam`.
 */
export async function terminateTeamMembers(
  opts: ExecuteDisbandOptions,
  deps: TeamManagerDeps,
  monitor: LifecycleMonitor,
): Promise<TeamInstance> {
  const raw = await deps.storage.get(buildStorageKey(opts.teamId));
  const team = deserializeTeamInstance(raw!);

  log.info("Team disbanding", {
    operation: opts.operationName,
    teamId: opts.teamId,
    teamName: team.name,
    reason: opts.reason,
  });

  for (const member of team.members) {
    if (member.status === "active" || member.status === "idle") {
      await deps.terminateSession(member.sessionId);
    }
  }

  const updatedMembers = await refreshMemberTaints(team.members, deps);
  const finalTaint = computeAggregateTaint(updatedMembers);

  const disbanded: TeamInstance = {
    ...team,
    members: updatedMembers.map((m) => ({
      ...m,
      status: m.status === "active" || m.status === "idle"
        ? "completed" as const
        : m.status,
    })),
    status: "disbanded",
    aggregateTaint: finalTaint,
  };

  await deps.storage.set(
    buildStorageKey(opts.teamId),
    serializeTeamInstance(disbanded),
  );
  monitor.stop(opts.teamId);

  log.info("Team disbanded", {
    operation: opts.operationName,
    teamId: opts.teamId,
    teamName: team.name,
    finalTaint,
  });

  return disbanded;
}

/** @deprecated Use terminateTeamMembers instead */
export const executeDisbandTeam = terminateTeamMembers;
