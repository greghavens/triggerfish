/**
 * Scheduler service types and interfaces.
 *
 * Defines OrchestratorFactory, SchedulerServiceConfig, SchedulerService,
 * and related option interfaces. Separated from the service implementation
 * in `service.ts` for lighter type-only imports.
 *
 * @module
 */

import type {
  ClassificationLevel,
  Result,
} from "../core/types/classification.ts";
import type { StorageProvider } from "../core/storage/provider.ts";
import type { UserId } from "../core/types/session.ts";
import type {
  Orchestrator,
  ProcessMessageOptions,
} from "../core/types/orchestrator.ts";
import type { SessionState } from "../core/types/session.ts";
import type { ToolExecutor } from "../core/types/tool.ts";
import type { NotificationService } from "../core/types/notification.ts";
import type { CronManager } from "./cron/parser.ts";
import type { SchedulerCronAdmissions } from "./cron/admissions.ts";
import type { SchedulerTriggerAdmissions } from "./triggers/admissions.ts";
import type { SchedulerWebhookAdmissions } from "./webhooks/admissions.ts";
import type { WebhookHandler } from "./webhooks/webhooks.ts";
import type { TriggerStore } from "./triggers/store.ts";
import type {
  SchedulerGoalCompletionConfig,
  SchedulerGoalSource,
} from "./service_goal_completion.ts";
import type { ManagedGoalTraceAccess } from "../core/goal_completion.ts";

/** Server-derived identity for one cron, trigger or admitted webhook execution. */
export interface SchedulerExecutionIdentity {
  readonly id: string;
  readonly kind: "cron" | "trigger" | "webhook";
  readonly sourceId: string;
  /** Requested only for an already-admitted trigger occurrence after restart. */
  readonly resumeOnly?: true;
  readonly resumePaused?: true;
}

/** Options passed to OrchestratorFactory.create() to configure the session type. */
export interface OrchestratorCreateOptions {
  /** Trusted scheduled agent binding. The role remains read-only. */
  readonly eventRecipient?: {
    readonly tools: readonly string[];
    readonly profile?: import("../core/agent_profiles.ts").AgentProfileRevision;
    readonly isCurrent: () => boolean;
  };
  /** Trusted source for in-turn reports in an ordinary scheduled session. */
  readonly scheduledGoalSource?: SchedulerGoalSource;
  readonly scheduledGoalRecovery?: SchedulerExecutionIdentity;
  /** Exact execution ID supplied by trusted delegated/scheduled entry points. */
  readonly executionChecklistRunId?: string;
  /** Job identity supplied by the trusted cron execution entry point. */
  readonly cronJobId?: string;
  /** Source derived by the scheduled execution entry point. */
  readonly scheduledObservationSource?:
    import("../core/config_types.ts").ScheduledObservationSource;

  /** Identity supplied by the authenticated delegated dispatch entry point. */
  readonly delegatedObservationSource?:
    import("../core/config_types.ts").DelegatedObservationSource;

  /** Supplied only after owner admission for one specific team delivery. */
  readonly teamObservation?: {
    readonly source: import("../core/config_types.ts").TeamObservationSource;
    readonly authorizeScope: () => Promise<boolean>;
  };

  /** Current membership authority for an exact durable team delivery. */
  readonly teamGoalRecovery?: {
    readonly source: import("../core/config_types.ts").TeamObservationSource;
    readonly authorizeScope: () => Promise<boolean>;
  };
  /** Trusted factory caller classification for delegated goal contracts. */
  readonly delegatedKind?:
    import("../core/delegated_goal_config.ts").DelegatedAgentKind;
  /** Stable session supplied only by a trusted execution recovery adapter. */
  readonly recoverySessionId?: import("../core/types/session.ts").SessionId;
  /** Authoritative initial taint validated by a trusted recovery adapter. */
  readonly recoverySessionTaint?: ClassificationLevel;
  /**
   * When true, the orchestrator is configured as a trigger session.
   * Trigger sessions may call all built-in tools and integration tools
   * classified at or below the ceiling. They are never owner sessions.
   */
  readonly isTrigger?: boolean;
  /**
   * Classification ceiling for this session.
   * Tools and resource reads classified above this level are blocked.
   * Providing a ceiling marks the session as a non-owner machine session
   * (trigger, webhook, cron, team member) with the ceiling enforced as a
   * read gate, not just an output gate.
   */
  readonly ceiling?: ClassificationLevel;
  /**
   * Maximum agent loop iterations for this session.
   * Defaults to MAX_TOOL_ITERATIONS (25) when not set.
   * Use lower values for short-lived sessions (e.g. explore subagents: 5).
   */
  readonly maxIterations?: number;
  /**
   * Existing workspace to reuse instead of creating a fresh one.
   * Used by subagents spawned from the main session so they share
   * the parent's workspace and sandbox boundary.
   */
  readonly workspace?: import("../exec/workspace_types.ts").Workspace;
  /**
   * Additional system prompt sections injected into the orchestrator.
   * Used by team member sessions to include the team roster prompt.
   */
  readonly systemPromptSections?: readonly string[];
  /**
   * When true, the session ID is persisted so the session survives daemon
   * restarts. The ID is stored under `session-id:{channelId}` in storage.
   * Default: false (ephemeral session with random UUID).
   */
  readonly persistent?: boolean;
}

/**
 * Factory that creates an isolated orchestrator + session per execution.
 *
 * The factory captures shared infrastructure (provider registry, policy
 * engine, hook runner, tools) and creates a fresh workspace, session,
 * and orchestrator for each call.
 */
export interface OrchestratorFactory {
  /** Operator-only goal commands, dispatched by the authenticated owner channel. */
  readonly runDelegatedGoalCommand?: (
    command: string,
    ceiling: ClassificationLevel,
    traceAccess?: ManagedGoalTraceAccess,
  ) => Promise<string | undefined>;
  /** Create a new orchestrator, session, and tool executor for a scheduled task. */
  create(channelId: string, options?: OrchestratorCreateOptions): Promise<{
    readonly orchestrator: Orchestrator;
    readonly session: SessionState;
    readonly toolExecutor: ToolExecutor;
    /**
     * Live taint of the session. The `session` field is an immutable
     * snapshot from creation time — taint escalations during the turn
     * replace the factory's internal session object, so output gates
     * (notification classification, write-down checks) MUST read the
     * taint through this accessor, never from the stale snapshot.
     */
    readonly getSessionTaint: () => ClassificationLevel;
  }>;
}

/** Per-request context passed to handleWebhookRequest. */
export interface WebhookRequestContext {
  /** Signature header value (e.g. "sha256=abcdef..."). */
  readonly signature: string;
  /** Value of X-Timestamp header as Unix milliseconds string. Optional. */
  readonly timestamp?: string;
}

/** Per-source webhook configuration. */
export interface WebhookSourceConfig {
  readonly secret: string;
  readonly classification: ClassificationLevel;
  /** Explicit legacy opt-in. Defaults to timestamp-bound signatures only. */
  readonly allowBodySignature?: boolean;
  /** Per-source rate limit override. Falls back to global rateLimit if absent. */
  readonly rateLimit?: {
    readonly perMinute: number;
    readonly burst: number;
  };
}

/** Configuration for the scheduler service. */
export interface SchedulerServiceConfig {
  readonly agentEvents?:
    import("./service_agent_events.ts").AgentEventSchedulerConfig;
  /** Factory for creating orchestrators per execution. */
  readonly orchestratorFactory: OrchestratorFactory;
  /** Trusted runtime bindings to persisted evidence for shared goals. */
  readonly goalCompletion?: SchedulerGoalCompletionConfig;
  /** Private journal for metadata from trusted cron and trigger model dispatches. */
  readonly executionTracePath?: string;
  /** Trusted adapter for an exact scheduled occurrence. Successful returns permit delivery. */
  readonly recoverTurn?: (
    execution: SchedulerExecutionIdentity,
    orchestrator: Pick<Orchestrator, "executeAgentTurn">,
    options: ProcessMessageOptions,
  ) => ReturnType<Orchestrator["executeAgentTurn"]>;
  /** Narrow recovery admission to these trusted sources. Omission preserves legacy scope. */
  readonly recoveryEnabledForSource?: (
    source: Pick<SchedulerExecutionIdentity, "kind" | "sourceId">,
  ) => boolean;
  readonly recoveryState?: (
    id: string,
  ) => "ready" | "paused" | "pending" | "finished" | "busy" | undefined;
  readonly cronAdmissions?: SchedulerCronAdmissions;
  readonly triggerAdmissions?: SchedulerTriggerAdmissions;
  readonly webhookAdmissions?: SchedulerWebhookAdmissions;
  /** Path to TRIGGER.md (typically ~/.triggerfish/TRIGGER.md). */
  readonly triggerMdPath: string;
  /**
   * Optional lightweight check for memory-stored trigger instructions.
   *
   * Called before orchestrator creation to avoid spawning a session
   * when no instructions exist. Returns the content string or null.
   */
  readonly checkMemoryInstructions?: () => Promise<string | null>;
  /** Trigger configuration. */
  readonly trigger: {
    readonly enabled: boolean;
    readonly intervalMinutes: number;
    readonly quietHours?: {
      readonly start: number;
      readonly end: number;
    };
    readonly classificationCeiling: ClassificationLevel;
  };
  /** Webhook configuration. */
  readonly webhooks: {
    readonly enabled: boolean;
    readonly sources: Readonly<Record<string, WebhookSourceConfig>>;
    /**
     * Maximum age of a webhook request in ms. Requests with missing or older
     * timestamps are rejected. Set to 0 to disable. Default: 300_000 (5 min).
     */
    readonly maxAgeMs?: number;
    /** Global default rate limit applied per sourceId. Default: 60/min, burst 10. */
    readonly rateLimit?: {
      readonly perMinute: number;
      readonly burst: number;
    };
    /** Max signatures retained in the replay guard. Default: 10_000. */
    readonly replayGuardSize?: number;
    /**
     * Storage provider persisting the replay guard across daemon
     * restarts. Without it the guard is in-memory only, and a restart
     * within the freshness window reopens the replay hole.
     */
    readonly replayStorage?: StorageProvider;
  };
  /** Optional pre-created CronManager (e.g. persistent). */
  readonly cronManager?: CronManager;
  /** Optional notification service for delivering scheduler output. */
  readonly notificationService?: NotificationService;
  /** Owner user ID for notification delivery. */
  readonly ownerId?: UserId;
  /** Optional store for persisting the last result of each trigger source. */
  readonly triggerStore?: TriggerStore;
  /**
   * Callback invoked when a trigger produces actionable output (non-NO_ACTION).
   * Used to broadcast trigger_prompt events to connected chat clients.
   */
  readonly onTriggerOutput?: (
    source: string,
    classification: ClassificationLevel,
    preview: string,
    firedAt: string,
  ) => void;
}

/** Accepted public deliveries can include an opaque recovery execution ID. */
export type WebhookDeliveryResult = Result<void, string> & {
  readonly executionId?: string;
};

/** The scheduler service interface. */
export interface SchedulerService {
  /** Start the cron tick loop and trigger. */
  start(): void;
  /** Stop all scheduled activities. */
  stop(): void;
  /** The cron job manager for creating/listing/deleting jobs. */
  readonly cronManager: CronManager;
  /** The webhook event router for registering handlers. */
  readonly webhookHandler: WebhookHandler;
  /** Handle an inbound webhook HTTP request. */
  handleWebhookRequest(
    sourceId: string,
    body: string,
    context: WebhookRequestContext,
  ): Promise<WebhookDeliveryResult>;
  stageWebhookRecoveryBody?(executionId: string, body: string): boolean;
  resumeScheduledExecution?(executionId: string): Promise<boolean>;
  /** Resume a verified delivery from an authenticated operator surface. */
  resumeWebhookExecution(
    executionId: string,
    body: string,
    resumePaused?: boolean,
  ): Promise<Result<void, string>>;
  /**
   * Force an immediate trigger run, bypassing the interval timer.
   * Used for debugging via `triggerfish run-triggers`.
   */
  runTrigger(): Promise<void>;
}
