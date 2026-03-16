/**
 * Live team member session registry and message delivery.
 *
 * Tracks orchestrator references and mutable session state for
 * team members so messages can be delivered via executeAgentTurn
 * and taint can be read from live in-memory state.
 *
 * @module
 */

import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { Result } from "../../../core/types/classification.ts";
import { canFlowTo } from "../../../core/types/classification.ts";
import type { SessionId, SessionState } from "../../../core/types/session.ts";
import type { StorageProvider } from "../../../core/storage/provider.ts";
import type { Orchestrator } from "../../../core/types/orchestrator.ts";
import type { OrchestratorFactory } from "../../../scheduler/service_types.ts";
import {
  TEAM_STORAGE_PREFIX,
  type TeamInstance,
} from "../../../agent/team/types.ts";
import type {
  SpawnedMember,
  SpawnMemberOptions,
} from "../../../agent/team/manager.ts";
import type { EnhancedSessionManager } from "../../sessions.ts";
import { createLogger } from "../../../core/logger/logger.ts";

const log = createLogger("team-wiring");

/** Live state for a single team member session. */
interface LiveMemberSession {
  readonly orchestrator: Orchestrator;
  session: SessionState;
}

/**
 * Registry of live team member sessions.
 *
 * Holds orchestrator references and mutable session state so that
 * messages can be delivered (via executeAgentTurn) and taint can
 * be read from the live in-memory state.
 */
export function createSessionRegistry() {
  const sessions = new Map<string, LiveMemberSession>();

  return {
    register(
      sessionId: SessionId,
      orchestrator: Orchestrator,
      session: SessionState,
    ): void {
      sessions.set(sessionId as string, { orchestrator, session });
    },

    get(sessionId: SessionId): LiveMemberSession | undefined {
      return sessions.get(sessionId as string);
    },

    remove(sessionId: SessionId): void {
      sessions.delete(sessionId as string);
    },

    clear(): void {
      sessions.clear();
    },
  };
}

/** Build spawnMemberSession that creates + registers sessions. */
export function buildSpawnMemberSession(
  factory: OrchestratorFactory,
  registry: ReturnType<typeof createSessionRegistry>,
): (options: SpawnMemberOptions) => Promise<SpawnedMember> {
  return async (options: SpawnMemberOptions): Promise<SpawnedMember> => {
    const channelId = `team-member-${options.role}-${crypto.randomUUID()}`;

    log.info("Spawning team member session", {
      operation: "spawnMemberSession",
      role: options.role,
      channelId,
    });

    const { orchestrator, session } = await factory.create(channelId, {
      ceiling: options.classificationCeiling,
      systemPromptSections: options.teamRosterPrompt
        ? [options.teamRosterPrompt]
        : undefined,
    });

    registry.register(session.id, orchestrator, session);

    log.info("Team member session spawned", {
      operation: "spawnMemberSession",
      role: options.role,
      sessionId: session.id,
    });

    return {
      sessionId: session.id,
      model: options.model ?? "default",
    };
  };
}

/** Max length for lastOutput stored per member. */
const MAX_LAST_OUTPUT_LENGTH = 500;

/** Regex to strip `<think>...</think>` tags from LLM output. */
const THINK_TAG_REGEX = /<think>[\s\S]*?<\/think>/g;

/** Strip thinking tags and leading whitespace from LLM output. */
function stripThinkingTags(output: string): string {
  return output.replace(THINK_TAG_REGEX, "").trimStart();
}

/**
 * Update a member's lastOutput and lastActivityAt in persisted team state.
 *
 * Scans all teams in storage to find the member by sessionId, then
 * patches the member record. This is best-effort — failures are logged.
 */
export async function persistMemberOutput(
  storage: StorageProvider,
  sessionId: SessionId,
  output: string,
): Promise<void> {
  const keys = await storage.list(`${TEAM_STORAGE_PREFIX}`);
  for (const key of keys) {
    const raw = await storage.get(key);
    if (!raw) continue;

    const team: TeamInstance = JSON.parse(raw);
    const idx = team.members.findIndex(
      (m) => (m.sessionId as string) === (sessionId as string),
    );
    if (idx === -1) continue;

    const cleaned = stripThinkingTags(output);
    const truncated = cleaned.length > MAX_LAST_OUTPUT_LENGTH
      ? cleaned.slice(0, MAX_LAST_OUTPUT_LENGTH) + "..."
      : cleaned;
    const updated = {
      ...team,
      members: team.members.map((m, i) =>
        i === idx
          ? { ...m, lastOutput: truncated, lastActivityAt: new Date() }
          : m
      ),
    };
    await storage.set(key, JSON.stringify(updated));
    return;
  }
}

/** Resolve the sender's current taint from the registry or session manager. */
export async function resolveSenderTaint(
  senderId: SessionId,
  registry: ReturnType<typeof createSessionRegistry>,
  sessionManager: EnhancedSessionManager,
): Promise<ClassificationLevel | null> {
  const liveSender = registry.get(senderId);
  if (liveSender) return liveSender.session.taint;

  const persisted = await sessionManager.get(senderId);
  return persisted?.taint ?? null;
}

/**
 * Build sendMessage that delivers via executeAgentTurn (fire-and-forget).
 *
 * For messages to team members (in the registry), queues delivery via
 * the orchestrator in the background and returns immediately. The member's
 * lastOutput is updated in storage after the turn completes.
 *
 * For messages to sessions outside the team (e.g. creator notifications),
 * falls back to sessions_send write-down check only.
 */
export function buildSendMessage(
  registry: ReturnType<typeof createSessionRegistry>,
  sessionManager: EnhancedSessionManager,
  storage: StorageProvider,
): (
  fromId: SessionId,
  toId: SessionId,
  content: string,
) => Promise<Result<{ readonly delivered: true }, string>> {
  return async (
    fromId: SessionId,
    toId: SessionId,
    content: string,
  ): Promise<Result<{ readonly delivered: true }, string>> => {
    const live = registry.get(toId);

    if (live) {
      const senderTaint = await resolveSenderTaint(
        fromId,
        registry,
        sessionManager,
      );
      if (senderTaint && !canFlowTo(senderTaint, live.session.taint)) {
        log.warn("Write-down blocked for team member delivery", {
          operation: "sendMessage",
          fromId,
          toId,
          senderTaint,
          targetTaint: live.session.taint,
        });
        return {
          ok: false,
          error:
            `Write-down blocked: ${senderTaint} cannot flow to ${live.session.taint}`,
        };
      }

      log.info("Queuing message delivery to team member", {
        operation: "sendMessage",
        fromId,
        toId,
        senderTaint,
        targetTaint: live.session.taint,
        contentLength: content.length,
      });

      live.orchestrator.executeAgentTurn({
        session: live.session,
        message: content,
        targetClassification: live.session.taint,
      })
        .then(async (result) => {
          if (!result.ok) {
            log.error("Team member message processing failed", {
              operation: "sendMessage",
              toId,
              err: result.error,
            });
            return;
          }
          await persistMemberOutput(storage, toId, result.value.response);
        })
        .catch((err) => {
          log.error("Team member message delivery threw", {
            operation: "sendMessage",
            toId,
            err,
          });
        });

      return { ok: true, value: { delivered: true } };
    }

    log.info("Routing message to external session via sessionManager", {
      operation: "sendMessage",
      fromId,
      toId,
    });
    const target = await sessionManager.get(toId);
    if (!target) {
      return { ok: false, error: `Target session not found: ${toId}` };
    }

    return sessionManager.sessionsSend(fromId, toId, content, target.taint);
  };
}
