/**
 * Workflow engine module — CNCF Serverless Workflow DSL 1.0 runtime.
 *
 * @module
 */

// Types
export type {
  WorkflowDefinition,
  TaskNode,
  CallTask,
  RunTask,
  ForTask,
  SwitchCase,
  RaiseTask,
  EmitTask,
  ListenTask,
  ExecutionState,
  ExecutionStatus,
  TaskResult,
  WorkflowError,
  WorkflowEngine,
  WorkflowExecutionContext,
  CreateWorkflowEngineOptions,
  TaskHandlerResult,
  FlowDirective,
  LlmCallParams,
  MemoryCallParams,
  WebSearchCallParams,
  WebFetchCallParams,
  McpCallParams,
  AgentCallParams,
  MessageCallParams,
} from "./types.ts";

// Parser
export { parseWorkflowYaml } from "./parser.ts";

// Context
export type {
  WorkflowContext,
  ContextVars,
  SecretResolver,
} from "./context.ts";
export {
  createWorkflowContext,
  mergeOutput,
  evaluateExpression,
  resolveTemplateString,
  applyOutputTransform,
  scrubSecrets,
  evaluateCondition,
  resolveExpressions,
} from "./context.ts";

// Tasks
export { executeTask, parseDurationMs } from "./tasks.ts";

// Engine
export { createWorkflowEngine } from "./engine.ts";

// Tools
export {
  getWorkflowToolDefinitions,
  createWorkflowToolExecutor,
  WORKFLOW_SYSTEM_PROMPT,
} from "./tools.ts";
