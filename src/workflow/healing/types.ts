/**
 * Workflow-domain healing types — rich events, versioning, deviations, and status.
 *
 * These types are specific to the workflow engine's healing subsystem.
 * Shared types (config, categories, phases) live in core/types/healing.ts.
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";
import type { HealingPhase, WorkflowHealth } from "../../core/types/healing.ts";
import type { WorkflowTaskEntry } from "../types.ts";

// --- Rich Workflow Events ---

/** Base fields present on all rich workflow events. */
interface RichEventBase {
  readonly runId: string;
  readonly workflowName: string;
  readonly timestamp: string;
}

/** Emitted before a task begins execution. */
export interface StepStartedEvent extends RichEventBase {
  readonly type: "STEP_STARTED";
  readonly taskName: string;
  readonly taskIndex: number;
  readonly taskDef: WorkflowTaskEntry;
  readonly input: unknown;
  readonly runningTaint: ClassificationLevel;
}

/** Emitted after a task completes successfully. */
export interface StepCompletedEvent extends RichEventBase {
  readonly type: "STEP_COMPLETED";
  readonly taskName: string;
  readonly taskIndex: number;
  readonly output: unknown;
  readonly duration: number;
  readonly taintAfter: ClassificationLevel;
}

/** Emitted when a task fails. */
export interface StepFailedEvent extends RichEventBase {
  readonly type: "STEP_FAILED";
  readonly taskName: string;
  readonly taskIndex: number;
  readonly error: string;
  readonly input: unknown;
  readonly attemptNumber: number;
}

/** Emitted when a task is skipped due to its `if` condition evaluating false. */
export interface StepSkippedEvent extends RichEventBase {
  readonly type: "STEP_SKIPPED";
  readonly taskName: string;
  readonly taskIndex: number;
  readonly reason: string;
}

/** Emitted when a switch task selects a branch. */
export interface BranchTakenEvent extends RichEventBase {
  readonly type: "BRANCH_TAKEN";
  readonly switchName: string;
  readonly branch: string;
  readonly condition: string;
}

/** Emitted when the workflow is paused. */
export interface WorkflowPausedEvent extends RichEventBase {
  readonly type: "WORKFLOW_PAUSED";
  readonly reason: string;
  readonly pausedAt: string;
}

/** Emitted when the workflow resumes from pause. */
export interface WorkflowResumedEvent extends RichEventBase {
  readonly type: "WORKFLOW_RESUMED";
  readonly resumedAt: string;
}

/** Emitted when the workflow completes successfully. */
export interface WorkflowCompletedEvent extends RichEventBase {
  readonly type: "WORKFLOW_COMPLETED";
  readonly output: unknown;
  readonly taskCount: number;
}

/** Emitted when the workflow faults (unrecoverable failure). */
export interface WorkflowFaultedEvent extends RichEventBase {
  readonly type: "WORKFLOW_FAULTED";
  readonly error: string;
  readonly failedTaskName?: string;
  readonly failedTaskIndex?: number;
}

/** Discriminated union of all rich workflow events. */
export type RichWorkflowEvent =
  | StepStartedEvent
  | StepCompletedEvent
  | StepFailedEvent
  | StepSkippedEvent
  | BranchTakenEvent
  | WorkflowPausedEvent
  | WorkflowResumedEvent
  | WorkflowCompletedEvent
  | WorkflowFaultedEvent;

// --- Workflow Versioning ---

/** Lifecycle status of a workflow version. */
export type VersionStatus = "PROPOSED" | "APPROVED" | "REJECTED" | "SUPERSEDED";

/** A full-snapshot workflow version record. */
export interface WorkflowVersion {
  readonly versionId: string;
  readonly workflowName: string;
  readonly agentId: string;
  readonly versionNumber: number;
  readonly definition: string;
  readonly diff: string;
  readonly status: VersionStatus;
  readonly source: "human" | "self_healing";
  readonly authorReasoning: string;
  readonly runId?: string;
  readonly proposedAt: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
}

// --- Runtime Deviations ---

/** A runtime workaround applied by the lead without changing the definition. */
export interface RuntimeDeviation {
  readonly taskName: string;
  readonly deviationDescription: string;
  readonly leadReasoning: string;
  readonly runId: string;
  readonly appliedAt: string;
}

// --- Step Metadata ---

/** Required metadata fields for each step when self-healing is enabled. */
export interface StepMetadata {
  readonly description: string;
  readonly expects: string;
  readonly produces: string;
}

// --- Rich Workflow Status ---

/** Extended workflow state including healing-specific states. */
export type WorkflowState =
  | "IDLE"
  | "RUNNING"
  | "PAUSED_HEALING"
  | "PAUSED_AWAITING_APPROVAL"
  | "PAUSED_TIMEOUT"
  | "COMPLETED"
  | "FAULTED"
  | "ESCALATED"
  | "CANCELLED";

/** Last run outcome as reported in status. */
export type LastRunOutcome =
  | "success"
  | "faulted"
  | "paused"
  | "cancelled"
  | "healed";

/** Rich structured workflow status — UI-ready without business logic. */
export interface WorkflowStatusDetail {
  readonly state: WorkflowState;
  readonly health: WorkflowHealth;
  readonly source: "human" | "self_healing" | "scheduler" | "api";
  readonly pausedReason?: string;
  readonly healingPhase?: HealingPhase;
  readonly pendingApproval?: PendingApprovalSummary;
  readonly lastRunAt?: string;
  readonly lastRunOutcome?: LastRunOutcome;
  readonly nextRunAt?: string;
  readonly versionStatus: VersionStatus;
  readonly activeDeviations: number;
}

/** Summary of a pending approval for status display. */
export interface PendingApprovalSummary {
  readonly versionId: string;
  readonly proposedAt: string;
  readonly authorReasoning: string;
}

/** Event emitted on workflow status transitions. */
export interface WorkflowStatusEvent {
  readonly workflowName: string;
  readonly runId: string;
  readonly previousState: WorkflowState;
  readonly currentState: WorkflowState;
  readonly status: WorkflowStatusDetail;
  readonly timestamp: string;
  readonly message?: string;
}
