/**
 * Agent team module — persistent multi-agent collaboration.
 *
 * @module
 */

export type {
  TeamDefinition,
  TeamId,
  TeamInstance,
  TeamMemberDefinition,
  TeamMemberInstance,
  TeamMemberStatus,
  TeamStatus,
} from "./types.ts";

export {
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  DEFAULT_MAX_LIFETIME_SECONDS,
  DISBAND_GRACE_PERIOD_SECONDS,
  LIFETIME_GRACE_PERIOD_SECONDS,
  TEAM_STORAGE_PREFIX,
} from "./types.ts";

export type {
  SpawnedMember,
  SpawnMemberOptions,
  TeamManager,
  TeamManagerDeps,
} from "./manager.ts";

export { createTeamManager } from "./manager.ts";

export { buildTeamRosterPrompt } from "./roster.ts";
export type { RosterPromptOptions } from "./roster.ts";

export type { TeamToolContext } from "./tool_definitions.ts";

export {
  buildTeamToolDefinitions,
  getTeamToolDefinitions,
  TEAM_SYSTEM_PROMPT,
  TEAM_TOOL_NAMES,
} from "./tool_definitions.ts";

export { createTeamToolExecutor } from "./tool_executors.ts";

export type { LifecycleMonitor } from "./lifecycle.ts";
export { createLifecycleMonitor } from "./lifecycle.ts";

export {
  checkLeadHealth,
  checkLifetimeTimeout,
  checkMemberHealth,
  checkMemberIdle,
  detectLeadFailure,
  detectMemberFailure,
  detectMemberIdleTimeout,
  detectTeamLifetimeTimeout,
} from "./lifecycle_checks.ts";
export type { MonitorState } from "./lifecycle_checks.ts";

export {
  clampTimeout,
  parseMemberInput,
  parseMembersInput,
} from "./tool_input_parsing.ts";

export {
  buildStorageKey,
  computeAggregateTaint,
  findLeadMember,
  findMemberByRole,
  refreshMemberTaints,
} from "./helpers.ts";

export {
  deserializeTeamInstance,
  serializeTeamInstance,
} from "./serialization.ts";

export { enforceTeamDefinition, validateTeamDefinition } from "./validation.ts";

export {
  buildPlaceholderMembers,
  deliverInitialTasks,
  spawnAllMembers,
} from "./spawning.ts";
