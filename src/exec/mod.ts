/**
 * Agent execution environment module.
 *
 * Provides workspace management, execution tools, and a secure
 * command runner for the agent's code development workflow.
 *
 * @module
 */

export { createWorkspace } from "./workspace.ts";
export type {
  ClassifiedPathResult,
  Workspace,
  WorkspaceOptions,
} from "./workspace_types.ts";

export {
  containsPathTraversal,
  extractClassificationPrefix,
  getReadableLevels,
  resolveExplicitClassifiedPath,
  searchReadableLevelsForFile,
  validatePathInWorkspace,
} from "./workspace_paths.ts";

export {
  buildClaudeEnv,
  buildSafeEnv,
  detectShellInjection,
} from "./sanitize.ts";
export type { InjectionCheckResult, SafeEnvOptions } from "./sanitize.ts";

export { createExecTools } from "./tools.ts";
export type {
  ExecTools,
  ExecToolsOptions,
  FileEntry,
  RunResult,
  WriteResult,
} from "./tools.ts";

export { createExecRunner } from "./runner.ts";
export type {
  ExecHistoryEntry,
  ExecRunner,
  ExecRunnerOptions,
} from "./runner.ts";

export { createClaudeSessionManager } from "./claude.ts";
export type {
  ClaudeSession,
  ClaudeSessionConfig,
  ClaudeSessionManager,
  ClaudeSessionManagerOptions,
} from "./claude.ts";
export {
  CLAUDE_SESSION_SYSTEM_PROMPT,
  createClaudeToolExecutor,
  getClaudeToolDefinitions,
} from "./claude.ts";

export { createFilesystemSandbox, probeDenoRuntime } from "./sandbox/mod.ts";
export type {
  FilesystemSandbox,
  FilesystemSandboxOptions,
  SandboxOp,
  SandboxRequest,
  SandboxResponse,
} from "./sandbox/mod.ts";
