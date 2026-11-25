/**
 * Team manager types — interfaces for dependencies, options, and the manager API.
 *
 * Separated from manager.ts to keep both files under the 300-line limit.
 *
 * @module
 */

import type {
  ClassificationLevel,
  Result,
} from "../../core/types/classification.ts";
import type { SessionId } from "../../core/types/session.ts";
import type { StorageProvider } from "../../core/storage/provider.ts";
import type {
  TeamDefinition,
  TeamId,
  TeamInstance,
  TeamMemberDefinition,
} from "./types.ts";

/** Dependencies injected into the TeamManager. */
export interface TeamManagerDeps {
  /** Storage for persisting team state. */
  readonly storage: StorageProvider;
  /** Spawns an isolated agent session for a team member. */
  readonly spawnMemberSession: (
    options: SpawnMemberOptions,
  ) => Promise<SpawnedMember>;
  /** Sends a message from one session to another with write-down enforcement. */
  readonly sendMessage: (
    fromId: SessionId,
    toId: SessionId,
    content: string,
  ) => Promise<Result<{ readonly delivered: true }, string>>;
  /** Retrieves current taint for a session. */
  readonly getSessionTaint: (
    sessionId: SessionId,
  ) => Promise<ClassificationLevel | null>;
  /** Terminates a session. */
  readonly terminateSession: (sessionId: SessionId) => Promise<void>;
  /**
   * Notify the creating session about a lifecycle event.
   * Optional — lifecycle monitoring is skipped when not provided.
   */
  readonly notifyCreator?: (
    creatorSessionId: SessionId,
    message: string,
  ) => Promise<void>;
}

/** Options for spawning a team member session. */
export interface SpawnMemberOptions {
  /** Server-generated team identity, never sourced from member input. */
  readonly recoveryOwner?: {
    readonly teamId: TeamId;
    readonly creatorSessionId: SessionId;
  };
  readonly role: string;
  readonly description: string;
  readonly teamRosterPrompt: string;
  readonly model?: string;
  readonly classificationCeiling?: ClassificationLevel;
  readonly tools?: TeamMemberDefinition["tools"];
}

/** Result of spawning a member session. */
export interface SpawnedMember {
  readonly sessionId: SessionId;
  readonly model: string;
}

/** The team manager interface. */
export interface TeamManager {
  /** Create a new team from a definition. */
  createTeam(
    definition: TeamDefinition,
    createdBy: SessionId,
  ): Promise<Result<TeamInstance, string>>;

  /** Get the current status of a team. */
  fetchTeamStatus(teamId: TeamId): Promise<Result<TeamInstance, string>>;

  /** Disband an active team. Only lead or creating session can disband. */
  disbandTeam(
    teamId: TeamId,
    callerSessionId: SessionId,
    reason?: string,
  ): Promise<Result<TeamInstance, string>>;

  /**
   * Force-disband a team without authorization checks.
   *
   * Internal-only — used by lifecycle monitoring for auto-disband
   * on lifetime expiry. Not exposed to tool executors.
   */
  forceDisbandTeam(
    teamId: TeamId,
    reason?: string,
  ): Promise<Result<TeamInstance, string>>;

  /** Send a message to a team member from outside the team. */
  deliverTeamMessage(
    teamId: TeamId,
    callerSessionId: SessionId,
    role: string,
    message: string,
  ): Promise<Result<{ readonly delivered: true }, string>>;

  /** List teams created by a session. */
  listTeams(callerSessionId: SessionId): Promise<readonly TeamInstance[]>;

  /** Start background lifecycle monitoring for a team. */
  startLifecycleMonitor(teamId: TeamId): void;

  /** Stop lifecycle monitoring for a team. */
  stopLifecycleMonitor(teamId: TeamId): void;

  /** Stop all lifecycle monitors (cleanup on shutdown). */
  stopAllMonitors(): void;
}
