/**
 * Team member spawning and initial task delivery.
 *
 * Spawns isolated agent sessions for each team member and delivers
 * initial tasks via fire-and-forget to avoid blocking team creation.
 *
 * @module
 */

import type { SessionId } from "../../core/types/session.ts";
import type {
  TeamDefinition,
  TeamId,
  TeamMemberDefinition,
  TeamMemberInstance,
} from "./types.ts";
import type { TeamManagerDeps } from "./manager_types.ts";
import { buildTeamRosterPrompt } from "./roster.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("team-spawning");

/** Spawn all member sessions and build member instances. */
export async function spawnAllMembers(
  definition: TeamDefinition,
  deps: TeamManagerDeps,
  placeholderMembers: readonly TeamMemberInstance[],
  recoveryOwner?: {
    readonly teamId: TeamId;
    readonly creatorSessionId: SessionId;
  },
): Promise<TeamMemberInstance[]> {
  const members: TeamMemberInstance[] = [];
  const now = new Date();

  for (const memberDef of definition.members) {
    const rosterPrompt = buildTeamRosterPrompt({
      teamName: definition.name,
      task: definition.task,
      member: placeholderMembers.find((m) => m.role === memberDef.role)!,
      allMembers: placeholderMembers,
    });

    const spawned = await deps.spawnMemberSession({
      ...(recoveryOwner && { recoveryOwner }),
      role: memberDef.role,
      description: memberDef.description,
      teamRosterPrompt: rosterPrompt,
      model: memberDef.model,
      classificationCeiling: memberDef.classificationCeiling,
      tools: memberDef.tools,
    });

    members.push({
      role: memberDef.role,
      description: memberDef.description,
      isLead: memberDef.isLead,
      sessionId: spawned.sessionId,
      model: spawned.model,
      classificationCeiling: memberDef.classificationCeiling,
      status: "active",
      currentTaint: "PUBLIC",
      lastActivityAt: now,
    });
  }

  return members;
}

/** Build placeholder member instances before sessions are spawned. */
export function buildPlaceholderMembers(
  definition: TeamDefinition,
): TeamMemberInstance[] {
  const now = new Date();
  return definition.members.map((m) => ({
    role: m.role,
    description: m.description,
    isLead: m.isLead,
    sessionId: `pending-${m.role}` as SessionId,
    model: m.model ?? "default",
    classificationCeiling: m.classificationCeiling,
    status: "active" as const,
    currentTaint: "PUBLIC" as const,
    lastActivityAt: now,
  }));
}

/**
 * Send initial tasks to team members after creation (fire-and-forget).
 *
 * Non-lead members with explicit initialTask are fired in parallel.
 * The lead receives the team task. All deliveries are non-blocking —
 * failures are logged but do not propagate.
 */
export function deliverInitialTasks(
  definition: TeamDefinition,
  members: readonly TeamMemberInstance[],
  createdBy: SessionId,
  deps: TeamManagerDeps,
): void {
  for (const memberDef of definition.members) {
    if (memberDef.isLead) continue;
    if (!memberDef.initialTask) continue;

    const memberInstance = members.find((m) => m.role === memberDef.role);
    if (!memberInstance) continue;

    deps.sendMessage(createdBy, memberInstance.sessionId, memberDef.initialTask)
      .then((result) => {
        if (!result.ok) {
          log.warn("Initial task delivery failed for team member", {
            operation: "deliverInitialTasks",
            role: memberDef.role,
            sessionId: memberInstance.sessionId,
            err: result.error,
          });
        }
      })
      .catch((err) => {
        log.error("Initial task delivery threw for team member", {
          operation: "deliverInitialTasks",
          role: memberDef.role,
          sessionId: memberInstance.sessionId,
          err,
        });
      });
  }

  const leadDef = definition.members.find((m) => m.isLead);
  if (!leadDef) return;

  const leadInstance = members.find((m) => m.role === leadDef.role);
  if (!leadInstance) return;

  const leadTask = resolveInitialTask(leadDef, definition.task);
  if (!leadTask) return;

  deps.sendMessage(createdBy, leadInstance.sessionId, leadTask)
    .then((result) => {
      if (!result.ok) {
        log.warn("Initial task delivery failed for team lead", {
          operation: "deliverInitialTasks",
          role: leadDef.role,
          sessionId: leadInstance.sessionId,
          err: result.error,
        });
      }
    })
    .catch((err) => {
      log.error("Initial task delivery threw for team lead", {
        operation: "deliverInitialTasks",
        role: leadDef.role,
        sessionId: leadInstance.sessionId,
        err,
      });
    });
}

/** Resolve what initial task to send to a member. */
function resolveInitialTask(
  memberDef: TeamMemberDefinition,
  teamTask: string,
): string | null {
  if (memberDef.initialTask) return memberDef.initialTask;
  if (memberDef.isLead) return teamTask;
  return null;
}
