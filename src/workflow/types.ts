/**
 * Workflow engine types — CNCF Serverless Workflow DSL 1.0 with Triggerfish extensions.
 *
 * @module
 */

import type { ClassificationLevel, Result } from "../core/types/classification.ts";
import type { SessionId } from "../core/types/session.ts";
import type { StorageProvider } from "../core/storage/provider.ts";
import type { ToolExecutor } from "../agent/orchestrator.ts";
import type { OrchestratorFactory } from "../scheduler/service.ts";

// ─── Duration ────────────────────────────────────────────────────────────────

/** Duration string, e.g. "30m", "5s", "1h". */
export type Duration = string;

// ─── Flow control ─────────────────────────────────────────────────────────────

/** What to do after a task completes. */
export type FlowDirective = "continue" | "end" | "exit" | string;

// ─── Resource definitions ─────────────────────────────────────────────────────

/** Authentication policy reference. */
export interface AuthenticationPolicy {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Retry policy. */
export interface RetryPolicy {
  readonly maxAttempts?: number;
  readonly delay?: Duration;
  readonly backoff?: "constant" | "linear" | "exponential";
}

/** Catalog definition. */
export interface CatalogDefinition {
  readonly endpoint: string;
}

/** Extension definition. */
export interface ExtensionDefinition {
  readonly name: string;
  readonly [key: string]: unknown;
}

/** Shared resources declared in the `use` block. */
export interface WorkflowResources {
  readonly authentications?: Readonly<Record<string, AuthenticationPolicy>>;
  readonly retries?: Readonly<Record<string, RetryPolicy>>;
  readonly catalogs?: Readonly<Record<string, CatalogDefinition>>;
  readonly extensions?: readonly ExtensionDefinition[];
}

// ─── Input/Output ─────────────────────────────────────────────────────────────

/** Input transform applied before a task executes. */
export interface InputTransform {
  readonly schema?: Record<string, unknown>;
  readonly from?: string | Record<string, unknown>;
}

/** Output transform applied to a task's raw output. */
export interface OutputTransform {
  readonly schema?: Record<string, unknown>;
  readonly as?: string | Record<string, unknown>;
}

/** Export transform — writes data back to workflow context. */
export interface ExportTransform {
  readonly as?: string | Record<string, unknown>;
}

/** JSON Schema-based input definition for a workflow. */
export interface WorkflowInput {
  readonly schema?: Record<string, unknown>;
  readonly from?: string | Record<string, unknown>;
}

/** Output definition for a workflow. */
export interface WorkflowOutput {
  readonly schema?: Record<string, unknown>;
  readonly as?: string | Record<string, unknown>;
}

// ─── Task types ───────────────────────────────────────────────────────────────

/** Call task — invoke HTTP, gRPC, OpenAPI, AsyncAPI, or custom functions. */
export interface CallTask {
  readonly type: string;
  readonly with: Record<string, unknown>;
  readonly retry?: string | RetryPolicy;
}

/** Run task — execute a container, script, shell command, or sub-workflow. */
export interface RunTask {
  readonly type: "container" | "script" | "shell" | "workflow";
  readonly with: Record<string, unknown>;
}

/** Switch case — conditional branching. */
export interface SwitchCase {
  readonly name: string;
  readonly when?: string;
  readonly then: FlowDirective;
}

/** For loop task. */
export interface ForTask {
  readonly each: string;
  readonly in: string;
  readonly at?: string;
  readonly do: readonly TaskNode[];
}

/** Raise error task. */
export interface RaiseTask {
  readonly error: {
    readonly type: string;
    readonly status: number;
    readonly title?: string;
    readonly detail?: string;
    readonly instance?: string;
  };
}

/** Emit event task. */
export interface EmitTask {
  readonly event: {
    readonly type: string;
    readonly source: string;
    readonly data?: Record<string, unknown>;
  };
}

/** Event filter for listen tasks. */
export interface EventFilter {
  readonly type?: string;
  readonly source?: string;
  readonly [key: string]: unknown;
}

/** Listen for events task. */
export interface ListenTask {
  readonly to: EventFilter;
  readonly timeout?: Duration;
}

/**
 * A single task in a workflow. Named map entry — the key is the task name.
 * Exactly one task type property must be present.
 */
export interface TaskNode {
  readonly name: string;

  // Exactly one task type
  readonly call?: CallTask;
  readonly run?: RunTask;
  readonly set?: Record<string, unknown>;
  readonly switch?: readonly SwitchCase[];
  readonly for?: ForTask;
  readonly raise?: RaiseTask;
  readonly emit?: EmitTask;
  readonly listen?: ListenTask;
  readonly wait?: Duration;

  // Common optional fields
  readonly if?: string;
  readonly input?: InputTransform;
  readonly output?: OutputTransform;
  readonly export?: ExportTransform;
  readonly timeout?: Duration;
  readonly then?: FlowDirective;
  readonly metadata?: Record<string, unknown>;
}

// ─── Workflow definition ──────────────────────────────────────────────────────

/** A parsed workflow definition, extended with Triggerfish metadata. */
export interface WorkflowDefinition {
  readonly dsl: string;
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly input?: WorkflowInput;
  readonly output?: WorkflowOutput;
  readonly do: readonly TaskNode[];
  readonly use?: WorkflowResources;
  readonly timeout?: Duration;

  // Triggerfish extensions
  readonly classificationCeiling?: ClassificationLevel;
  readonly requiresTools: readonly string[];
  readonly networkDomains: readonly string[];
  readonly tags: readonly string[];
  readonly approvalRequired: boolean;
}

// ─── Execution state ──────────────────────────────────────────────────────────

/** Workflow execution status values. */
export type ExecutionStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAULTED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "CLASSIFICATION_BLOCKED";

/** Result of a single task execution. */
export interface TaskResult {
  readonly taskName: string;
  readonly taskType: string;
  readonly status: "SUCCESS" | "FAILED" | "SKIPPED" | "BLOCKED";
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly duration: number;
  readonly taintBefore: ClassificationLevel;
  readonly taintAfter: ClassificationLevel;
  readonly deterministic: boolean;
  readonly output?: unknown;
  readonly error?: string;
  readonly lineageId?: string;
}

/** RFC 7807 workflow error. */
export interface WorkflowError {
  readonly type: string;
  readonly status: number;
  readonly title: string;
  readonly detail?: string;
  readonly instance?: string;
}

/** Runtime state of a workflow execution. */
export interface ExecutionState {
  readonly runId: string;
  readonly workflowName: string;
  readonly workflowVersion: string;
  readonly status: ExecutionStatus;
  readonly startedAt: Date;
  readonly completedAt?: Date;
  readonly currentTaskIndex: number;
  readonly currentTaskName: string;
  readonly data: Record<string, unknown>;
  readonly taintAtStart: ClassificationLevel;
  readonly taintCurrent: ClassificationLevel;
  readonly classificationCeiling?: ClassificationLevel;
  readonly taskResults: readonly TaskResult[];
  readonly error?: WorkflowError;
}

// ─── Custom call param types ──────────────────────────────────────────────────

/** call: triggerfish:llm — non-deterministic. */
export interface LlmCallParams {
  readonly task: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly responseFormat?: "text" | "json";
}

/** call: triggerfish:memory */
export interface MemoryCallParams {
  readonly operation: "save" | "search" | "get" | "list" | "delete";
  readonly key?: string;
  readonly content?: string;
  readonly query?: string;
  readonly tags?: readonly string[];
}

/** call: triggerfish:web_search */
export interface WebSearchCallParams {
  readonly query: string;
  readonly maxResults?: number;
}

/** call: triggerfish:web_fetch */
export interface WebFetchCallParams {
  readonly url: string;
  readonly maxLength?: number;
}

/** call: triggerfish:mcp */
export interface McpCallParams {
  readonly server: string;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
}

/** call: triggerfish:agent */
export interface AgentCallParams {
  readonly task: string;
  readonly agentId?: string;
  readonly timeout?: string;
}

/** call: triggerfish:message */
export interface MessageCallParams {
  readonly channel: string;
  readonly recipient: string;
  readonly text: string;
}

// ─── Engine interface ─────────────────────────────────────────────────────────

/** Context injected into every workflow execution. */
export interface WorkflowExecutionContext {
  readonly agentId: string;
  readonly sessionId: SessionId;
  readonly sessionTaint: ClassificationLevel;
  readonly escalateTaint: (level: ClassificationLevel, reason: string) => void;
  readonly toolExecutor: ToolExecutor;
  readonly storage: StorageProvider;
  readonly orchestratorFactory?: OrchestratorFactory;
}

/** The workflow engine — parses, validates, stores, and executes workflows. */
export interface WorkflowEngine {
  /** Parse and validate a YAML workflow definition. */
  parse(yaml: string): Result<WorkflowDefinition, string>;

  /** Store a workflow definition. Classification set to session taint. */
  store(
    definition: WorkflowDefinition,
    agentId: string,
    sessionTaint: ClassificationLevel,
  ): Promise<Result<void, string>>;

  /** List stored workflows visible at the given classification level. */
  list(
    agentId: string,
    sessionTaint: ClassificationLevel,
  ): Promise<readonly WorkflowDefinition[]>;

  /** Get a specific workflow by name (classification-gated). */
  get(
    name: string,
    agentId: string,
    sessionTaint: ClassificationLevel,
  ): Promise<WorkflowDefinition | null>;

  /** Delete a stored workflow. */
  delete(
    name: string,
    agentId: string,
    sessionTaint: ClassificationLevel,
  ): Promise<Result<void, string>>;

  /** Execute a workflow. Returns the final execution state. */
  execute(
    definition: WorkflowDefinition,
    input: Record<string, unknown>,
    context: WorkflowExecutionContext,
  ): Promise<ExecutionState>;

  /** Get execution history for a workflow. */
  history(
    workflowName: string,
    agentId: string,
    sessionTaint: ClassificationLevel,
    limit?: number,
  ): Promise<readonly ExecutionState[]>;
}

/** Options for createWorkflowEngine. */
export interface CreateWorkflowEngineOptions {
  readonly storage: StorageProvider;
}

// ─── Task handler internals ───────────────────────────────────────────────────

/** Internal result from a task handler. */
export interface TaskHandlerResult {
  readonly output: unknown;
  readonly taintDelta: ClassificationLevel;
  readonly skipped: boolean;
  readonly blocked: boolean;
  readonly error?: string;
}
