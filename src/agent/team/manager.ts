/**
 * Team manager — lifecycle management for agent teams.
 *
 * Composes validation, serialization, spawning, and lifecycle monitoring
 * into the TeamManager interface used by team tool executors.
 *
 * @module
 */

import type { Result } from "../../core/types/classification.ts";
import type { SessionId } from "../../core/types/session.ts";
import { createLogger } from "../../core/logger/logger.ts";
import type { TeamDefinition, TeamId, TeamInstance } from "./types.ts";
import {
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  DEFAULT_MAX_LIFETIME_SECONDS,
  TEAM_STORAGE_PREFIX,
} from "./types.ts";
import { enforceTeamDefinition } from "./validation.ts";
import {
  deserializeTeamInstance,
  serializeTeamInstance,
} from "./serialization.ts";
import {
  buildPlaceholderMembers,
  deliverInitialTasks,
  spawnAllMembers,
} from "./spawning.ts";
import {
  buildStorageKey,
  computeAggregateTaint,
  terminateTeamMembers,
  findLeadMember,
  findMemberByRole,
  refreshMemberTaints,
} from "./helpers.ts";
import { createLifecycleMonitor } from "./lifecycle.ts";

// Re-export types so existing importers of manager.ts still work.
export type {
  SpawnedMember,
  SpawnMemberOptions,
  TeamManager,
  TeamManagerDeps,
} from "./manager_types.ts";

import type { TeamManager, TeamManagerDeps } from "./manager_types.ts";

const log = createLogger("team-manager");

/**
 * Create a TeamManager instance.
 *
 * Composes existing primitives (session spawning, messaging,
 * taint tracking) and adds team-specific lifecycle coordination.
 */
export function createTeamManager(deps: TeamManagerDeps): TeamManager {
  const manager: TeamManager = {
    async createTeam(
      definition: TeamDefinition,
      createdBy: SessionId,
    ): Promise<Result<TeamInstance, string>> {
      const validation = enforceTeamDefinition(definition);
      if (!validation.ok) return validation;

      log.info("Team creation started", {
        operation: "createTeam",
        teamName: definition.name,
        memberCount: definition.members.length,
        createdBy,
      });

      const placeholders = buildPlaceholderMembers(definition);

      try {
        const members = await spawnAllMembers(definition, deps, placeholders);
        const teamId = crypto.randomUUID() as TeamId;

        const team: TeamInstance = {
          id: teamId,
          name: definition.name,
          task: definition.task,
          members,
          status: "running",
          aggregateTaint: computeAggregateTaint(members),
          createdAt: new Date(),
          createdBy,
          idleTimeoutSeconds: definition.idleTimeoutSeconds ??
            DEFAULT_IDLE_TIMEOUT_SECONDS,
          maxLifetimeSeconds: definition.maxLifetimeSeconds ??
            DEFAULT_MAX_LIFETIME_SECONDS,
          classificationCeiling: definition.classificationCeiling,
        };

        await deps.storage.set(
          buildStorageKey(teamId),
          serializeTeamInstance(team),
        );
        deliverInitialTasks(definition, members, createdBy, deps);

        log.info("Team created", {
          operation: "createTeam",
          teamId,
          teamName: definition.name,
          memberRoles: members.map((m) => m.role),
        });

        manager.startLifecycleMonitor(teamId);

        return { ok: true, value: team };
      } catch (err: unknown) {
        log.error("Team member spawning failed", {
          operation: "createTeam",
          teamName: definition.name,
          err,
        });
        return {
          ok: false,
          error: `Team member spawning failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    },

    async fetchTeamStatus(
      teamId: TeamId,
    ): Promise<Result<TeamInstance, string>> {
      const raw = await deps.storage.get(buildStorageKey(teamId));
      if (!raw) {
        return { ok: false, error: `Team not found: ${teamId}` };
      }

      const team = deserializeTeamInstance(raw);

      if (team.status !== "running" && team.status !== "paused") {
        return { ok: true, value: team };
      }

      const updatedMembers = await refreshMemberTaints(team.members, deps);
      const aggregateTaint = computeAggregateTaint(updatedMembers);
      const updated: TeamInstance = {
        ...team,
        members: updatedMembers,
        aggregateTaint,
      };
      await deps.storage.set(
        buildStorageKey(teamId),
        serializeTeamInstance(updated),
      );

      return { ok: true, value: updated };
    },

    async disbandTeam(
      teamId: TeamId,
      callerSessionId: SessionId,
      reason?: string,
    ): Promise<Result<TeamInstance, string>> {
      const raw = await deps.storage.get(buildStorageKey(teamId));
      if (!raw) {
        return { ok: false, error: `Team not found: ${teamId}` };
      }

      const team = deserializeTeamInstance(raw);

      if (team.status !== "running" && team.status !== "paused") {
        return {
          ok: false,
          error: `Team cannot be disbanded in status: ${team.status}`,
        };
      }

      const isCreator = callerSessionId === team.createdBy;
      const lead = findLeadMember(team);
      const isLead = lead !== undefined && callerSessionId === lead.sessionId;

      if (!isCreator && !isLead) {
        log.warn("Unauthorized disband attempt", {
          operation: "disbandTeam",
          teamId,
          callerSessionId,
          createdBy: team.createdBy,
        });
        return {
          ok: false,
          error:
            "Team disband denied: only the lead or creating session can disband",
        };
      }

      const disbanded = await terminateTeamMembers(
        { teamId, reason, operationName: "disbandTeam" },
        deps,
        monitor,
      );
      return { ok: true, value: disbanded };
    },

    async forceDisbandTeam(
      teamId: TeamId,
      reason?: string,
    ): Promise<Result<TeamInstance, string>> {
      const raw = await deps.storage.get(buildStorageKey(teamId));
      if (!raw) {
        return { ok: false, error: `Team not found: ${teamId}` };
      }

      const team = deserializeTeamInstance(raw);

      if (team.status !== "running" && team.status !== "paused") {
        return {
          ok: false,
          error: `Team cannot be disbanded in status: ${team.status}`,
        };
      }

      const disbanded = await terminateTeamMembers(
        { teamId, reason, operationName: "forceDisbandTeam" },
        deps,
        monitor,
      );
      return { ok: true, value: disbanded };
    },

    async deliverTeamMessage(
      teamId: TeamId,
      callerSessionId: SessionId,
      role: string,
      message: string,
    ): Promise<Result<{ readonly delivered: true }, string>> {
      const raw = await deps.storage.get(buildStorageKey(teamId));
      if (!raw) {
        return { ok: false, error: `Team not found: ${teamId}` };
      }

      const team = deserializeTeamInstance(raw);

      if (team.status !== "running") {
        return {
          ok: false,
          error: `Team message delivery denied: team status is ${team.status}`,
        };
      }

      const target = role ? findMemberByRole(team, role) : findLeadMember(team);
      if (!target) {
        return { ok: false, error: `Team member not found: ${role || "lead"}` };
      }

      if (target.status !== "active" && target.status !== "idle") {
        return {
          ok: false,
          error:
            `Team member "${target.role}" is not active (status: ${target.status})`,
        };
      }

      return deps.sendMessage(callerSessionId, target.sessionId, message);
    },

    async listTeams(
      callerSessionId: SessionId,
    ): Promise<readonly TeamInstance[]> {
      const keys = await deps.storage.list(TEAM_STORAGE_PREFIX);
      const teams: TeamInstance[] = [];

      for (const key of keys) {
        const raw = await deps.storage.get(key);
        if (!raw) continue;

        try {
          const team = deserializeTeamInstance(raw);
          if (team.createdBy === callerSessionId) {
            teams.push(team);
          }
        } catch (err: unknown) {
          log.warn("Team deserialization failed", {
            operation: "listTeams",
            callerSessionId,
            key,
            err,
          });
        }
      }

      return teams;
    },

    startLifecycleMonitor(teamId: TeamId): void {
      monitor.start(teamId);
    },

    stopLifecycleMonitor(teamId: TeamId): void {
      monitor.stop(teamId);
    },

    stopAllMonitors(): void {
      monitor.stopAll();
    },
  };

  const monitor = createLifecycleMonitor(
    deps,
    manager.forceDisbandTeam.bind(manager),
  );

  return manager;
}
