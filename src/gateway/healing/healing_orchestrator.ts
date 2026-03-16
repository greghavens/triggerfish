/**
 * Healing orchestrator — top-level coordinator for self-healing workflow runs.
 *
 * Spawns the lead agent, creates the event bridge, listens for interventions,
 * spawns teams, manages pause/resume, and handles the approval flow.
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";
import type { SelfHealingConfig } from "../../core/types/healing.ts";
import type { SessionId } from "../../core/types/session.ts";
import type {
  RichWorkflowEvent,
  WorkflowVersion,
} from "../../workflow/healing/types.ts";
import type { WorkflowRunRegistry } from "../../workflow/registry_types.ts";
import type { WorkflowVersionStore } from "../../workflow/healing/version_store.ts";
import { createHealingEventBridge } from "./event_bridge.ts";
import {
  spawnHealingLead,
  type SpawnSessionOptions,
} from "./lead_lifecycle.ts";
import { triageIntervention } from "./intervention_triage.ts";
import { spawnHealingTeam, type TeamHandle } from "./team_spawner.ts";
import { createLogger } from "../../core/logger/logger.ts";
import type { NotificationService } from "../../core/types/notification.ts";

const log = createLogger("healing-orchestrator");

/** Options for orchestrating a self-healing workflow run. */
export interface HealingRunOptions {
  /** Self-healing configuration from the workflow definition. */
  readonly config: SelfHealingConfig;
  /** The workflow name. */
  readonly workflowName: string;
  /** The workflow definition YAML. */
  readonly workflowDefinition: string;
  /** The run ID from the workflow registry. */
  readonly runId: string;
  /** Run input data. */
  readonly runInput: Readonly<Record<string, unknown>>;
  /** Run history from the store. */
  readonly runHistory: readonly Readonly<Record<string, unknown>>[];
  /** Most recent successful run. */
  readonly lastSuccessfulRun?: Readonly<Record<string, unknown>>;
  /** Rejected proposals from prior runs. */
  readonly rejectedProposals: readonly WorkflowVersion[];
  /** Initial taint level. */
  readonly initialTaint: ClassificationLevel;
  /** Workflow run registry for pause/resume. */
  readonly registry: WorkflowRunRegistry;
  /** Version store for proposals. */
  readonly versionStore: WorkflowVersionStore;
  /** Session spawner. */
  readonly spawnSession: (options: SpawnSessionOptions) => Promise<SessionId>;
  /** Session terminator. */
  readonly terminateSession: (sessionId: SessionId) => Promise<void>;
  /** Team creation function. */
  readonly createTeam: (
    definition: import("./team_spawner.ts").TeamComposition,
  ) => Promise<TeamHandle>;
  /** Optional notification service. */
  readonly notificationService?: NotificationService;
  /** Owner user ID for notifications. */
  readonly ownerId?: import("../../core/types/session.ts").UserId;
}

/** Handle for managing a healing orchestration. */
export interface HealingOrchestrationHandle {
  /** The step event callback to pass to the engine. */
  readonly onStepEvent: (event: RichWorkflowEvent) => void;
  /** Tear down the healing infrastructure. */
  readonly teardown: () => Promise<void>;
}

/** Set up healing orchestration for a workflow run. */
export async function orchestrateHealingRun(
  options: HealingRunOptions,
): Promise<HealingOrchestrationHandle> {
  let interventionCount = 0;
  let activeTeam: TeamHandle | null = null;

  const lead = await spawnHealingLead({
    workflowDefinition: options.workflowDefinition,
    workflowName: options.workflowName,
    runInput: options.runInput,
    runHistory: options.runHistory,
    lastSuccessfulRun: options.lastSuccessfulRun,
    rejectedProposals: options.rejectedProposals,
    config: options.config,
    initialTaint: options.initialTaint,
    spawnSession: options.spawnSession,
    terminateSession: options.terminateSession,
  });

  const bridge = createHealingEventBridge({
    deliverToLead: async (events) => {
      for (const event of events) {
        await processLeadEvent(event);
      }
    },
  });

  async function processLeadEvent(event: RichWorkflowEvent): Promise<void> {
    if (event.type !== "STEP_FAILED") return;

    interventionCount++;

    const category = triageIntervention({
      errorMessage: event.error,
      retryCount: interventionCount - 1,
      config: options.config,
      historicalFailureCount: 0,
    });

    log.info("Intervention triaged", {
      operation: "processLeadEvent",
      workflowName: options.workflowName,
      taskName: event.taskName,
      category,
      interventionCount,
    });

    if (shouldNotifyOnIntervention(options)) {
      await notifyOwner(
        options,
        `Intervention on ${event.taskName}: ${category}`,
      );
    }

    if (category === "unresolvable") {
      log.warn("Escalating unresolvable intervention to owner", {
        operation: "processLeadEvent",
        workflowName: options.workflowName,
        taskName: event.taskName,
        interventionCount,
      });
      await notifyOwner(
        options,
        `Escalation: ${event.taskName} unresolvable after ${interventionCount} attempts`,
      );
      return;
    }

    const pausing = shouldPause(options.config, category);
    if (pausing) {
      log.info("Pausing workflow run for intervention", {
        operation: "processLeadEvent",
        workflowName: options.workflowName,
        runId: options.runId,
        category,
      });
      options.registry.pauseRun(options.runId);
    } else {
      log.debug("Continuing workflow run without pause", {
        operation: "processLeadEvent",
        workflowName: options.workflowName,
        runId: options.runId,
        category,
      });
    }

    activeTeam = await spawnHealingTeam({
      category,
      leadSessionId: lead.sessionId,
      currentTaint: options.initialTaint,
      workflowName: options.workflowName,
      failedTaskName: event.taskName,
      createTeam: options.createTeam,
    });
  }

  async function teardown(): Promise<void> {
    await bridge.teardown();
    if (activeTeam) {
      await activeTeam.disband();
      activeTeam = null;
    }
    await lead.teardown();

    log.info("Healing orchestration torn down", {
      operation: "teardown",
      workflowName: options.workflowName,
      runId: options.runId,
      totalInterventions: interventionCount,
    });
  }

  return {
    onStepEvent: (event) => bridge.enqueueEvent(event),
    teardown,
  };
}

function shouldPause(
  config: SelfHealingConfig,
  category: import("../../core/types/healing.ts").InterventionCategory,
): boolean {
  if (config.pause_on_intervention === "always") return true;
  if (config.pause_on_intervention === "never") return false;
  return category === "structural_fix" || category === "plugin_gap";
}

function shouldNotifyOnIntervention(options: HealingRunOptions): boolean {
  return options.config.notify_on.includes("intervention");
}

async function notifyOwner(
  options: HealingRunOptions,
  message: string,
): Promise<void> {
  if (!options.notificationService || !options.ownerId) return;
  try {
    await options.notificationService.deliver({
      userId: options.ownerId,
      message: `[Workflow healing: ${options.workflowName}] ${message}`,
      priority: "normal",
    });
  } catch (err) {
    log.error("Notification delivery failed during healing", {
      operation: "notifyOwner",
      workflowName: options.workflowName,
      err,
    });
  }
}
