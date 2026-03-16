/**
 * Gateway healing module — lead lifecycle, event bridge, triage, and team spawning.
 * @module
 */

export { createHealingEventBridge } from "./event_bridge.ts";
export type { EventBridgeOptions, HealingEventBridge } from "./event_bridge.ts";

export { triageIntervention } from "./intervention_triage.ts";
export type { TriageContext } from "./intervention_triage.ts";

export { spawnHealingLead } from "./lead_lifecycle.ts";
export type {
  HealingLeadHandle,
  SpawnLeadOptions,
  SpawnSessionOptions,
} from "./lead_lifecycle.ts";

export { resolveTeamComposition, spawnHealingTeam } from "./team_spawner.ts";
export type {
  SpawnTeamOptions,
  TeamComposition,
  TeamHandle,
  TeamRole,
} from "./team_spawner.ts";

export { orchestrateHealingRun } from "./healing_orchestrator.ts";
export type {
  HealingOrchestrationHandle,
  HealingRunOptions,
} from "./healing_orchestrator.ts";
