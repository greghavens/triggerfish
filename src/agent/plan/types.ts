/**
 * Plan mode type definitions.
 *
 * Defines the state machine, tool parameters, and data structures
 * for the agent's plan mode — a behavioral constraint that enforces
 * read-only exploration and architectural reasoning before code writes.
 *
 * @module
 */

/** Agent behavioral mode. */
export type AgentMode = "normal" | "plan" | "awaiting_approval";

/** Estimated complexity of a plan. */
export type PlanComplexity = "small" | "medium" | "large";

/** Status of a persisted plan. */
export type PlanStatus =
  | "pending_approval"
  | "approved"
  | "completed"
  | "rejected";

/** A single step in an implementation plan. */
export interface PlanStep {
  readonly id: number;
  readonly description: string;
  readonly files: readonly string[];
  readonly depends_on: readonly number[];
  readonly verification: string;
}

/** A complete implementation plan produced by the agent. */
export interface ImplementationPlan {
  readonly summary: string;
  readonly approach: string;
  readonly alternatives_considered: readonly string[];
  readonly steps: readonly PlanStep[];
  readonly risks: readonly string[];
  readonly files_to_create: readonly string[];
  readonly files_to_modify: readonly string[];
  readonly tests_to_write: readonly string[];
  readonly estimated_complexity: PlanComplexity;
}

/** Runtime plan mode state tracked per-session by the orchestrator. */
export interface PlanModeState {
  readonly mode: AgentMode;
  readonly goal?: string;
  readonly scope?: string;
  readonly activePlan?: ActivePlan;
}

/** An approved plan being executed. */
export interface ActivePlan {
  readonly id: string;
  readonly plan: ImplementationPlan;
  readonly completedSteps: readonly number[];
  readonly currentStep: number;
}

/** Persisted plan record for the history index. */
export interface PlanRecord {
  readonly id: string;
  readonly goal: string;
  readonly status: PlanStatus;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly filePath: string;
}

/** Default plan mode state (normal mode, no active plan). */
export const DEFAULT_PLAN_STATE: PlanModeState = {
  mode: "normal",
};

/** Tools blocked during plan mode. */
export const PLAN_BLOCKED_TOOLS: readonly string[] = [
  "write_file",
];

/**
 * Cron actions blocked during plan mode.
 *
 * The consolidated `cron` tool uses an `action` parameter. These
 * actions are blocked; read-only actions (list, history) are allowed.
 */
export const PLAN_BLOCKED_CRON_ACTIONS: readonly string[] = [
  "create",
  "delete",
];

/** Tools allowed during plan mode. */
export const PLAN_ALLOWED_TOOLS: readonly string[] = [
  "explore",
  "read_file",
  "run_command",
  "list_directory",
  "search_files",
  "glob_files",
  "cron",
  "todo_read",
  "todo_write",
  "plan_manage",
  "plan_step_complete",
  "plan_status",
];
