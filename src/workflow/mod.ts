/**
 * Workflow engine module — CNCF Serverless Workflow DSL 1.0 execution.
 * @module
 */

export type {
  CallTask,
  EmitTask,
  ForTask,
  RaiseTask,
  RunTask,
  SetTask,
  SwitchTask,
  WaitTask,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowId,
  WorkflowRunResult,
  WorkflowRunState,
  WorkflowStatus,
  WorkflowTask,
  WorkflowTaskEntry,
} from "./types.ts";
export { createWorkflowId } from "./types.ts";

export {
  enforceDoBlockSchema,
  parseWorkflowYaml,
  validateDoBlock,
} from "./parser.ts";
export type { ParseResult } from "./parser.ts";

export { createWorkflowContext } from "./context.ts";
export type { WorkflowContext } from "./context.ts";

export { executeWorkflow } from "./engine.ts";
export type {
  EngineResult,
  ExecuteWorkflowOptions,
  WorkflowToolExecutor,
} from "./engine.ts";

export { isDispatchError, resolveCallDispatch } from "./dispatch.ts";

export {
  applySetTask,
  emitWorkflowEvent,
  evaluateSwitchTask,
  executeCallTask,
  executeEmitTask,
  executeForTask,
  executeRaiseTask,
  executeRunTask,
  executeSetTask,
  executeSwitchTask,
  executeWaitTask,
  invokeRunTask,
  parseDuration,
  parseToolResult,
  raiseWorkflowError,
} from "./task_runners.ts";
export type { SubWorkflowExecutor } from "./task_runners.ts";

export {
  executeRunScript,
  executeRunShell,
  executeRunSubWorkflow,
} from "./run_executors.ts";

export {
  evaluateConditionExpression,
  evaluateExpression,
  resolveDotPath,
} from "./expressions.ts";

export {
  enforceEmitTaskSchema,
  enforceForTaskSchema,
  enforceRaiseTaskSchema,
  enforceRunTaskSchema,
  enforceSetTaskSchema,
  enforceSwitchTaskSchema,
  enforceWaitTaskSchema,
  validateEmitTask,
  validateForTask,
  validateRaiseTask,
  validateRunTask,
  validateSetTask,
  validateSwitchTask,
  validateWaitTask,
} from "./validators.ts";

export {
  applyInputTransform,
  applyOutputTransform,
  filterInternalKeys,
  findTaskIndex,
  resolveSwitchOrTaskFlow,
} from "./helpers.ts";

export {
  dispatchWorkflowControlAction,
  executeWorkflowControl,
  executeWorkflowDelete,
  executeWorkflowGet,
  executeWorkflowHistory,
  executeWorkflowList,
  executeWorkflowRun,
  executeWorkflowSave,
} from "./tool_handlers.ts";

export {
  createWorkflowRunRegistry,
  WorkflowCancelledError,
} from "./registry.ts";
export type {
  ActiveRunSnapshot,
  CompleteRunOptions,
  RegisterRunOptions,
  RegistryEvent,
  RegistryListener,
  RunControl,
  RunRegistration,
  StepState,
  TaskProgressOptions,
  WorkflowRunRegistry,
} from "./registry.ts";

export { createWorkflowStore } from "./store.ts";
export type { StoredWorkflow, WorkflowStore } from "./store.ts";

export {
  buildWorkflowToolDefinitions,
  createWorkflowToolExecutor,
  getWorkflowToolDefinitions,
  WORKFLOW_SYSTEM_PROMPT,
} from "./tools.ts";
export type { WorkflowToolContext } from "./tools.ts";

export type {
  BranchTakenEvent,
  LastRunOutcome,
  PendingApprovalSummary,
  RichWorkflowEvent,
  RuntimeDeviation,
  StepCompletedEvent,
  StepFailedEvent,
  StepMetadata,
  StepSkippedEvent,
  StepStartedEvent,
  VersionStatus,
  WorkflowCompletedEvent,
  WorkflowFaultedEvent,
  WorkflowPausedEvent,
  WorkflowResumedEvent,
  WorkflowState,
  WorkflowStatusDetail,
  WorkflowStatusEvent,
  WorkflowVersion,
} from "./healing/mod.ts";

export {
  createScopedPauseController,
  createWorkflowVersionStore,
  enforceStepMetadataRequirements,
  enforceStepMetadataSchema,
  parseSelfHealingConfig,
  validateStepMetadata,
} from "./healing/mod.ts";
export type {
  ScopedPauseController,
  WorkflowVersionStore,
} from "./healing/mod.ts";

export { WORKFLOW_CREATION_PROMPT } from "./creation_prompt.ts";
