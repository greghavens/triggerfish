/**
 * Team lifecycle health checks — idle detection, lifetime timeout, member/lead health.
 *
 * Individual health check functions used by the lifecycle monitor
 * to evaluate team member idle state, lifetime limits, and session
 * liveness for both lead and non-lead members.
 *
 * @module
 */

import type { TeamInstance, TeamMemberInstance } from "./types.ts";
import { LIFETIME_GRACE_PERIOD_SECONDS } from "./types.ts";
import type { TeamManagerDeps } from "./manager_types.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("team-lifecycle");

/** State tracked per team for lifecycle monitoring. */
export interface MonitorState {
  readonly intervalId: number;
  nudgedMembers: Set<string>;
  lifetimeWarned: boolean;
}

/** Check if a member has been idle too long and handle accordingly. */
export async function detectMemberIdleTimeout(
  team: TeamInstance,
  member: TeamMemberInstance,
  nudgedMembers: Set<string>,
  deps: TeamManagerDeps,
): Promise<TeamMemberInstance> {
  if (member.status !== "active" && member.status !== "idle") return member;

  const idleMs = Date.now() - member.lastActivityAt.getTime();
  const idleThresholdMs = team.idleTimeoutSeconds * 1_000;

  if (idleMs < idleThresholdMs) {
    nudgedMembers.delete(member.role);
    return member;
  }

  if (!nudgedMembers.has(member.role)) {
    nudgedMembers.add(member.role);
    log.info("Nudging idle team member", {
      operation: "checkMemberIdle",
      teamId: team.id,
      role: member.role,
      idleSeconds: Math.floor(idleMs / 1_000),
    });
    const lead = team.members.find((m) => m.isLead);
    const nudgeTarget = member.isLead
      ? "the lead"
      : lead?.role ?? "another teammate";
    await deps.sendMessage(
      team.createdBy,
      member.sessionId,
      `You have been idle for ${Math.floor(idleMs / 1_000)} seconds. ` +
        `If your work is complete, send your results to ${nudgeTarget}.`,
    );
    return member;
  }

  if (idleMs >= idleThresholdMs * 2) {
    log.info("Terminating idle team member", {
      operation: "checkMemberIdle",
      teamId: team.id,
      role: member.role,
    });
    await deps.terminateSession(member.sessionId);
    const lead = team.members.find((m) => m.isLead);
    if (lead && lead.sessionId !== member.sessionId) {
      await deps.sendMessage(
        team.createdBy,
        lead.sessionId,
        `Team member "${member.role}" has been terminated due to inactivity.`,
      );
    }
    return { ...member, status: "completed" };
  }

  return member;
}

/** Check team lifetime and handle timeout. */
export async function detectTeamLifetimeTimeout(
  team: TeamInstance,
  monitorState: MonitorState,
  deps: TeamManagerDeps,
): Promise<boolean> {
  const elapsedMs = Date.now() - team.createdAt.getTime();
  const lifetimeMs = team.maxLifetimeSeconds * 1_000;
  const graceMs = LIFETIME_GRACE_PERIOD_SECONDS * 1_000;

  if (elapsedMs < lifetimeMs) return false;

  if (!monitorState.lifetimeWarned) {
    monitorState.lifetimeWarned = true;
    const lead = team.members.find((m) => m.isLead);
    if (lead && (lead.status === "active" || lead.status === "idle")) {
      log.info("Team lifetime limit reached, warning lead", {
        operation: "checkLifetimeTimeout",
        teamId: team.id,
      });
      await deps.sendMessage(
        team.createdBy,
        lead.sessionId,
        "Team lifetime limit reached. Wrapping up — you have " +
          `${LIFETIME_GRACE_PERIOD_SECONDS} seconds to produce a final output.`,
      );
    }
    return false;
  }

  if (elapsedMs >= lifetimeMs + graceMs) {
    log.info("Team lifetime grace period expired, auto-disbanding", {
      operation: "checkLifetimeTimeout",
      teamId: team.id,
    });
    return true;
  }

  return false;
}

/** Detect lead failure (session taint returns null = session gone). */
export async function detectLeadFailure(
  team: TeamInstance,
  deps: TeamManagerDeps,
): Promise<boolean> {
  const lead = team.members.find((m) => m.isLead);
  if (!lead || (lead.status !== "active" && lead.status !== "idle")) {
    return false;
  }

  const taint = await deps.getSessionTaint(lead.sessionId);
  if (taint !== null) return false;

  log.warn("Lead session failure detected", {
    operation: "checkLeadHealth",
    teamId: team.id,
    leadSessionId: lead.sessionId,
  });

  if (deps.notifyCreator) {
    await deps.notifyCreator(
      team.createdBy,
      `Team "${team.name}" lead has failed. Team is paused. ` +
        `Use team_disband to clean up or team_message to redirect work.`,
    );
  }

  return true;
}

/** Detect member failure and notify the lead. */
export async function detectMemberFailure(
  team: TeamInstance,
  member: TeamMemberInstance,
  deps: TeamManagerDeps,
): Promise<TeamMemberInstance> {
  if (member.status !== "active" && member.status !== "idle") return member;
  if (member.isLead) return member;

  const taint = await deps.getSessionTaint(member.sessionId);
  if (taint !== null) return member;

  log.warn("Team member session failure detected", {
    operation: "checkMemberHealth",
    teamId: team.id,
    role: member.role,
    sessionId: member.sessionId,
  });

  const lead = team.members.find((m) => m.isLead);
  if (lead && (lead.status === "active" || lead.status === "idle")) {
    await deps.sendMessage(
      team.createdBy,
      lead.sessionId,
      `Team member "${member.role}" has failed. ` +
        `Continue with remaining members or disband the team.`,
    );
  }

  return { ...member, status: "failed" };
}

/** @deprecated Use detectMemberIdleTimeout instead */
export const checkMemberIdle = detectMemberIdleTimeout;

/** @deprecated Use detectTeamLifetimeTimeout instead */
export const checkLifetimeTimeout = detectTeamLifetimeTimeout;

/** @deprecated Use detectLeadFailure instead */
export const checkLeadHealth = detectLeadFailure;

/** @deprecated Use detectMemberFailure instead */
export const checkMemberHealth = detectMemberFailure;
