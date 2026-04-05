/**
 * Type definitions for the Tidepool workflows host handler.
 *
 * Minimal interfaces that avoid cross-layer imports from the
 * workflow module while keeping the handler fully typed.
 *
 * @module
 */

import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { HealingPhase } from "../../../core/types/healing.ts";

/** Minimal workflow store interface to avoid cross-layer imports. */
export interface MinimalWorkflowStore {
  listWorkflowDefinitions(
    sessionTaint: ClassificationLevel,
  ): Promise<
    readonly {
      readonly name: string;
      readonly classification: ClassificationLevel;
      readonly savedAt: string;
      readonly description?: string;
    }[]
  >;
  loadWorkflowDefinition(
    name: string,
    sessionTaint: ClassificationLevel,
  ): Promise<
    {
      readonly name: string;
      readonly yaml: string;
      readonly classification: ClassificationLevel;
      readonly savedAt: string;
      readonly description?: string;
    } | null
  >;
  deleteWorkflowDefinition(name: string): Promise<void>;
  listWorkflowRuns(
    sessionTaint: ClassificationLevel,
    options?: {
      readonly workflowName?: string;
      readonly limit?: number;
    },
  ): Promise<
    readonly {
      readonly runId: string;
      readonly workflowName: string;
      readonly status: string;
      readonly startedAt: string;
      readonly completedAt: string;
      readonly taskCount: number;
      readonly error?: string;
    }[]
  >;
}

/** Minimal workflow executor callback — runs a workflow by tool name + input. */
export type WorkflowExecutorFn = (
  name: string,
  input: Record<string, unknown>,
) => Promise<string | null>;

/** Minimal cron manager interface to avoid cross-layer imports. */
export interface MinimalCronManager {
  create(options: {
    readonly expression: string;
    readonly task: string;
    readonly classificationCeiling: ClassificationLevel;
  }): { ok: true; value: { id: string } } | { ok: false; error: string };
}

/** Structural-only task node sent to the browser (no input/output to avoid leaking classified content). */
export interface SimplifiedTask {
  readonly name: string;
  readonly type: "call" | "run" | "set" | "switch" | "for" | "raise" | "emit" | "wait";
  readonly condition?: string;
  readonly callType?: string;
  readonly switchCases?: readonly { readonly name: string; readonly when?: string }[];
  readonly forEach?: string;
  readonly flowDirective?: string;
  readonly metadata?: { readonly description?: string };
}

/** Per-step execution state accumulated during a run. */
export interface StepState {
  readonly taskIndex: number;
  readonly taskName: string;
  readonly status: "pending" | "running" | "completed" | "failed" | "skipped";
  readonly taintBefore?: ClassificationLevel;
  readonly taintAfter?: ClassificationLevel;
  readonly duration?: number;
  readonly error?: string;
  readonly healingPhase?: HealingPhase;
  readonly attemptNumber?: number;
  readonly branchTaken?: string;
}

/** Minimal version store interface for approval workflows. */
export interface MinimalWorkflowVersionStore {
  listWorkflowVersions(workflowName: string): Promise<readonly WorkflowVersion[]>;
  approveWorkflowVersion(versionId: string, reviewedBy: string): Promise<boolean>;
  rejectWorkflowVersion(versionId: string, reviewedBy: string, reason: string): Promise<boolean>;
}

/** Minimal run registry interface to avoid cross-layer imports. */
export interface MinimalRunRegistry {
  listActiveRuns(): readonly {
    readonly runId: string;
    readonly workflowName: string;
    readonly status: string;
    readonly currentTaskIndex: number;
    readonly currentTaskName: string;
    readonly startedAt: string;
    readonly paused: boolean;
    readonly taint?: ClassificationLevel;
  }[];
  stopRun(runId: string): boolean;
  pauseRun(runId: string): boolean;
  unpauseRun(runId: string): boolean;
  subscribe(
    listener: (event: RegistryEventShape) => void,
  ): () => void;
  /** Get accumulated step history for a run. */
  getRunStepHistory(runId: string): readonly StepState[];
  /** Subscribe to rich per-step events. */
  subscribeRichEvents(
    listener: (event: RichWorkflowEvent) => void,
  ): () => void;
}

/** Shape of registry events we consume. */
export interface RegistryEventShape {
  readonly type: string;
  readonly runId: string;
  readonly workflowName: string;
  readonly status: string;
  readonly currentTaskIndex?: number;
  readonly currentTaskName?: string;
  readonly taint?: ClassificationLevel;
  readonly error?: string;
}

/** Tidepool workflows handler interface. */
export interface TidepoolWorkflowsHandler {
  /** Subscribe a WebSocket client to workflow updates. */
  subscribeLive(socket: WebSocket): void;
  /** Unsubscribe a WebSocket client. */
  unsubscribeLive(socket: WebSocket): void;
  /** Fetch the workflow list for a client. */
  fetchWorkflowList(): Promise<Record<string, unknown>>;
  /** Fetch a single workflow definition with full YAML. */
  fetchWorkflowDetail(
    name: string,
    sessionTaint: ClassificationLevel,
  ): Promise<Record<string, unknown>>;
  /** Fetch currently active runs. */
  fetchActiveRuns(): Record<string, unknown>;
  /** Fetch past run history for a workflow. */
  fetchRunHistory(
    sessionTaint: ClassificationLevel,
    workflowName?: string,
    limit?: number,
  ): Promise<Record<string, unknown>>;
  /** Control a running workflow (stop/pause/unpause). */
  controlRun(
    runId: string,
    action: string,
  ): Record<string, unknown>;
  /** Delete a saved workflow definition. */
  deleteWorkflow(name: string): Promise<Record<string, unknown>>;
  /** Start a workflow run immediately. */
  startRun(
    name: string,
    sessionTaint: ClassificationLevel,
  ): Promise<Record<string, unknown>>;
  /** Schedule a workflow as a cron job. */
  scheduleRun(
    name: string,
    expression: string,
    classification: ClassificationLevel,
  ): Record<string, unknown>;
  /** Fetch run detail with task graph and step states. */
  fetchRunDetail(
    runId: string,
    sessionTaint: ClassificationLevel,
    workflowName?: string,
  ): Promise<Record<string, unknown>>;
  /** Fetch healing status for a workflow. */
  fetchHealingStatus(
    workflowName: string,
    sessionTaint: ClassificationLevel,
  ): Promise<Record<string, unknown>>;
  /** Approve a proposed workflow version. */
  approveVersion(
    versionId: string,
    reviewedBy: string,
  ): Promise<Record<string, unknown>>;
  /** Reject a proposed workflow version with reason. */
  rejectVersion(
    versionId: string,
    reviewedBy: string,
    reason: string,
  ): Promise<Record<string, unknown>>;
  /** Broadcast the current workflow list to all live subscribers. */
  broadcastWorkflowList(): Promise<void>;
  /** Remove a socket from all subscriptions. */
  removeSocket(socket: WebSocket): void;
}

/** Options for creating a TidepoolWorkflowsHandler. */
export interface WorkflowsHandlerOptions {
  readonly store: MinimalWorkflowStore;
  readonly registry: MinimalRunRegistry;
  readonly workflowExecutor?: WorkflowExecutorFn;
  readonly cronManager?: MinimalCronManager;
  readonly versionStore?: MinimalWorkflowVersionStore;
  readonly parseWorkflow?: (yaml: string) => SimplifiedTask[];
}

/**
 * Minimal workflow version shape — avoids cross-layer import from workflow/.
 * Matches the structural subset of workflow/healing/types.ts WorkflowVersion.
 */
export interface WorkflowVersion {
  readonly versionId: string;
  readonly workflowName: string;
  readonly versionNumber: number;
  readonly status: "PROPOSED" | "APPROVED" | "REJECTED" | "SUPERSEDED";
  readonly source: "human" | "self_healing";
  readonly proposedAt: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
  readonly diff?: string;
  readonly authorReasoning?: string;
}

/**
 * Minimal rich workflow event shape — avoids cross-layer import from workflow/.
 * The tidepool layer treats these as opaque JSON except for stripping classified fields.
 */
export type RichWorkflowEvent = {
  readonly type: string;
  readonly runId: string;
  readonly workflowName: string;
  readonly timestamp: string;
};
