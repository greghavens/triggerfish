/**
 * Team executor factory — wires TeamManager to real gateway infrastructure.
 *
 * Manages the full lifecycle of team member sessions: spawning via
 * OrchestratorFactory, registering with EnhancedSessionManager, delivering
 * messages by invoking the orchestrator's executeAgentTurn, and tracking
 * taint from live session state.
 *
 * @module
 */

import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { SessionId } from "../../../core/types/session.ts";
import type { StorageProvider } from "../../../core/storage/provider.ts";
import type { OrchestratorFactory } from "../../../scheduler/service_types.ts";
import type { EnhancedSessionManager } from "../../sessions.ts";
import {
  createTeamManager,
  type TeamManager,
} from "../../../agent/team/manager.ts";
import {
  createTeamToolExecutor,
  type TeamToolContext,
} from "../../../agent/team/tools.ts";
import type { SubsystemExecutor } from "../../tools/executor/executor_types.ts";
import { createLogger } from "../../../core/logger/logger.ts";
import {
  buildSendMessage,
  buildSpawnMemberSession,
  createSessionRegistry,
} from "./team_session_registry.ts";
import {
  buildOwnerTeamRecoveryCommand,
  type TeamRecoveryOptions,
} from "./team_recovery.ts";

const log = createLogger("team-wiring");

/** Build getSessionTaint from live registry (preferred) or sessionManager. */
function buildGetSessionTaint(
  registry: ReturnType<typeof createSessionRegistry>,
  sessionManager: EnhancedSessionManager,
): (sessionId: SessionId) => Promise<ClassificationLevel | null> {
  return async (sessionId: SessionId): Promise<ClassificationLevel | null> => {
    const live = registry.get(sessionId);
    if (live) return live.getTaint();

    const persisted = await sessionManager.get(sessionId);
    return persisted?.taint ?? null;
  };
}

/** Build terminateSession that cleans up both registry and sessionManager. */
function buildTerminateSession(
  registry: ReturnType<typeof createSessionRegistry>,
  sessionManager: EnhancedSessionManager,
): (sessionId: SessionId) => Promise<void> {
  return async (sessionId: SessionId): Promise<void> => {
    log.info("Terminating team member session", {
      operation: "terminateSession",
      sessionId,
    });
    registry.remove(sessionId);
    await sessionManager.delete(sessionId);
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Options for building the team executor. */
export interface TeamExecutorOptions {
  /** Storage for persisting team state. */
  readonly storage: StorageProvider;
  /** Factory for spawning isolated agent sessions. */
  readonly orchestratorFactory: OrchestratorFactory;
  /** Session manager for taint queries and termination. */
  readonly sessionManager: EnhancedSessionManager;
  /** Caller's session ID (injected, not from LLM). */
  readonly callerSessionId: SessionId;
  /** Live taint getter for the caller session. */
  readonly getCallerTaint: () => ClassificationLevel;
  readonly recovery?: TeamRecoveryOptions;
}

/**
 * Build a TeamManager wired to real gateway infrastructure.
 *
 * Creates a live session registry and composes OrchestratorFactory,
 * EnhancedSessionManager, and direct orchestrator invocation into
 * the TeamManagerDeps interface expected by createTeamManager.
 */
export function buildTeamManager(opts: {
  readonly storage: StorageProvider;
  readonly orchestratorFactory: OrchestratorFactory;
  readonly sessionManager: EnhancedSessionManager;
  readonly callerSessionId: SessionId;
  readonly recovery?: TeamRecoveryOptions;
}): TeamManager & {
  readonly runRecoveryCommand?: ReturnType<
    typeof buildOwnerTeamRecoveryCommand
  >;
} {
  const registry = createSessionRegistry();
  const sendMessage = buildSendMessage(
    registry,
    opts.sessionManager,
    opts.storage,
  );

  const manager = createTeamManager({
    storage: opts.storage,
    spawnMemberSession: buildSpawnMemberSession(
      opts.orchestratorFactory,
      registry,
      opts.recovery,
    ),
    sendMessage,
    getSessionTaint: buildGetSessionTaint(registry, opts.sessionManager),
    terminateSession: buildTerminateSession(registry, opts.sessionManager),
    notifyCreator: async (creatorSessionId: SessionId, message: string) => {
      log.info("Notifying team creator", {
        operation: "notifyCreator",
        creatorSessionId,
        preview: message.slice(0, 100),
      });
      await sendMessage(opts.callerSessionId, creatorSessionId, message);
    },
  });
  return Object.assign(
    manager,
    opts.recovery && {
      runRecoveryCommand: buildOwnerTeamRecoveryCommand({
        recovery: opts.recovery,
        factory: opts.orchestratorFactory,
        storage: opts.storage,
        registry,
        send: sendMessage,
      }),
    },
  );
}

/**
 * Build the team tool executor for the main session.
 *
 * Returns a SubsystemExecutor that handles team_create, team_status,
 * team_disband, and team_message tool calls.
 */
export function buildTeamExecutor(
  opts: TeamExecutorOptions,
): SubsystemExecutor & {
  readonly runRecoveryCommand?: ReturnType<
    typeof buildOwnerTeamRecoveryCommand
  >;
} {
  const teamManager = buildTeamManager({
    storage: opts.storage,
    orchestratorFactory: opts.orchestratorFactory,
    sessionManager: opts.sessionManager,
    callerSessionId: opts.callerSessionId,
    recovery: opts.recovery,
  });

  const ctx: TeamToolContext = {
    teamManager,
    callerSessionId: opts.callerSessionId,
    getCallerTaint: opts.getCallerTaint,
  };

  return Object.assign(createTeamToolExecutor(ctx), {
    runRecoveryCommand: teamManager.runRecoveryCommand,
  });
}
