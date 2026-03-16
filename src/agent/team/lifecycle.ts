/**
 * Team lifecycle monitoring — periodic checks on active teams.
 *
 * Runs periodic checks on active teams and takes corrective action:
 * nudging idle members, terminating unresponsive sessions, warning
 * about lifetime limits, and notifying the creator of failures.
 *
 * @module
 */

import type { Result } from "../../core/types/classification.ts";
import type { TeamId, TeamInstance, TeamMemberInstance } from "./types.ts";
import type { TeamManagerDeps } from "./manager_types.ts";
import { serializeTeamInstance } from "./serialization.ts";
import { deserializeTeamInstance } from "./serialization.ts";
import { buildStorageKey, computeAggregateTaint } from "./helpers.ts";
import {
  detectLeadFailure,
  detectMemberFailure,
  detectMemberIdleTimeout,
  detectTeamLifetimeTimeout,
  type MonitorState,
} from "./lifecycle_checks.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("team-lifecycle");

/** Check interval for lifecycle monitoring (30 seconds). */
const LIFECYCLE_CHECK_INTERVAL_MS = 30_000;

/** Lifecycle monitor for active teams. */
export interface LifecycleMonitor {
  /** Start monitoring a team. */
  start(teamId: TeamId): void;
  /** Stop monitoring a team. */
  stop(teamId: TeamId): void;
  /** Stop all active monitors. */
  stopAll(): void;
}

/**
 * Create a lifecycle monitor that periodically checks team health.
 *
 * @param deps - Team manager dependencies for storage, messaging, taint
 * @param forceDisbandTeam - Callback to force-disband a team on lifetime expiry (no auth check)
 */
export function createLifecycleMonitor(
  deps: TeamManagerDeps,
  forceDisbandTeam: (
    teamId: TeamId,
    reason?: string,
  ) => Promise<Result<TeamInstance, string>>,
): LifecycleMonitor {
  const monitors = new Map<string, MonitorState>();

  function stopMonitor(teamId: TeamId): void {
    const state = monitors.get(teamId as string);
    if (state) {
      clearInterval(state.intervalId);
      monitors.delete(teamId as string);
      log.info("Lifecycle monitor stopped", {
        operation: "stopLifecycleMonitor",
        teamId,
      });
    }
  }

  async function runLifecycleTick(
    teamId: TeamId,
    monitorState: MonitorState,
  ): Promise<void> {
    const raw = await deps.storage.get(buildStorageKey(teamId));
    if (!raw) {
      stopMonitor(teamId);
      return;
    }

    const team = deserializeTeamInstance(raw);
    if (team.status !== "running") {
      stopMonitor(teamId);
      return;
    }

    const shouldDisband = await detectTeamLifetimeTimeout(
      team,
      monitorState,
      deps,
    );
    if (shouldDisband) {
      stopMonitor(teamId);
      await forceDisbandTeam(teamId, "Lifetime limit reached");
      return;
    }

    const leadFailed = await detectLeadFailure(team, deps);
    if (leadFailed) {
      const pausedMembers = team.members.map((m) =>
        m.isLead ? { ...m, status: "failed" as const } : m
      );
      const paused: TeamInstance = {
        ...team,
        status: "paused",
        members: pausedMembers,
      };
      await deps.storage.set(
        buildStorageKey(teamId),
        serializeTeamInstance(paused),
      );
      stopMonitor(teamId);
      return;
    }

    let membersChanged = false;
    const updatedMembers: TeamMemberInstance[] = [];
    for (const member of team.members) {
      let updated = await detectMemberFailure(team, member, deps);
      updated = await detectMemberIdleTimeout(
        team,
        updated,
        monitorState.nudgedMembers,
        deps,
      );
      if (updated !== member) membersChanged = true;
      updatedMembers.push(updated);
    }

    if (membersChanged) {
      const updated: TeamInstance = {
        ...team,
        members: updatedMembers,
        aggregateTaint: computeAggregateTaint(updatedMembers),
      };
      await deps.storage.set(
        buildStorageKey(teamId),
        serializeTeamInstance(updated),
      );

      const allIdle = updatedMembers
        .filter((m) => m.status === "active" || m.status === "idle")
        .length === 0;
      if (allIdle && deps.notifyCreator) {
        await deps.notifyCreator(
          team.createdBy,
          `All members of team "${team.name}" are inactive. ` +
            `Use team_message to inject new instructions or team_disband to clean up.`,
        );
        stopMonitor(teamId);
      }
    }
  }

  return {
    start(teamId: TeamId): void {
      if (monitors.has(teamId as string)) return;

      const monitorState: MonitorState = {
        intervalId: setInterval(
          () => {
            runLifecycleTick(teamId, monitorState).catch((err) => {
              log.error("Lifecycle tick failed", {
                operation: "startLifecycleMonitor",
                teamId,
                err,
              });
            });
          },
          LIFECYCLE_CHECK_INTERVAL_MS,
        ),
        nudgedMembers: new Set(),
        lifetimeWarned: false,
      };

      monitors.set(teamId as string, monitorState);
      log.info("Lifecycle monitor started", {
        operation: "startLifecycleMonitor",
        teamId,
      });
    },

    stop(teamId: TeamId): void {
      stopMonitor(teamId);
    },

    stopAll(): void {
      for (const [id] of monitors) {
        stopMonitor(id as TeamId);
      }
    },
  };
}
