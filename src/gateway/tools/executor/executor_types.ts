/**
 * Type definitions and options for tool executor dispatch.
 *
 * @module
 */

import type { ToolExecutionContext } from "../../../core/types/tool.ts";
import { createExecTools } from "../../../exec/tools.ts";
import type { FilesystemSandbox } from "../../../exec/sandbox/mod.ts";
import type { TodoManager } from "../../../tools/mod.ts";
import type { SearchProvider, WebFetcher } from "../../../tools/web/mod.ts";
import type { LlmProviderRegistry } from "../../../core/types/llm.ts";
import type { CronManager } from "../../../scheduler/cron/parser.ts";
import type { SkillContextTracker } from "../../../tools/skills/mod.ts";

/** Generic executor signature used by optional subsystem executors. */
export type SubsystemExecutor = (
  name: string,
  input: Record<string, unknown>,
  context?: ToolExecutionContext,
) => Promise<string | null>;

/** Options for creating a tool executor. */
export interface ToolExecutorOptions {
  readonly execTools: ReturnType<typeof createExecTools>;
  /**
   * Sandboxed Deno subprocess for filesystem operations.
   * When provided, read/write/list/search/edit are routed through the
   * subprocess (OS-level permission enforcement). When absent, handlers
   * fall back to direct Deno API calls (backward compat for tests).
   */
  readonly filesystemSandbox?: FilesystemSandbox;
  readonly cronManager?: CronManager;
  readonly todoManager?: TodoManager;
  readonly searchProvider?: SearchProvider;
  readonly webFetcher?: WebFetcher;
  readonly memoryExecutor?: SubsystemExecutor;
  readonly planExecutor?: SubsystemExecutor;
  readonly browserExecutor?: SubsystemExecutor;
  readonly tidepoolExecutor?: SubsystemExecutor;
  readonly providerRegistry?: LlmProviderRegistry;
  readonly sessionExecutor?: SubsystemExecutor;
  readonly imageExecutor?: SubsystemExecutor;
  readonly exploreExecutor?: SubsystemExecutor;
  readonly googleExecutor?: SubsystemExecutor;
  readonly githubExecutor?: SubsystemExecutor;
  readonly caldavExecutor?: SubsystemExecutor;
  readonly notionExecutor?: SubsystemExecutor;
  /** Executor for x_posts, x_users, x_engage, x_lists, x_quota. */
  readonly xExecutor?: SubsystemExecutor;
  readonly obsidianExecutor?: SubsystemExecutor;
  readonly llmTaskExecutor?: SubsystemExecutor;
  readonly summarizeExecutor?: SubsystemExecutor;
  readonly healthcheckExecutor?: SubsystemExecutor;
  readonly mcpExecutor?: SubsystemExecutor;
  readonly claudeExecutor?: SubsystemExecutor;
  readonly subagentFactory?: (
    task: string,
    tools?: string,
    spawnOpts?: { readonly maxIterations?: number },
  ) => Promise<string>;
  readonly secretExecutor?: SubsystemExecutor;
  readonly triggerExecutor?: SubsystemExecutor;
  readonly triggerManageExecutor?: SubsystemExecutor;
  readonly skillExecutor?: SubsystemExecutor;
  readonly releaseNotesExecutor?: SubsystemExecutor;
  /** Executor for `simulate_tool_call` — dry-run security pipeline simulation. */
  readonly simulateExecutor?: SubsystemExecutor;
  /** Executor for team_create, team_status, team_disband, team_message. */
  readonly teamExecutor?: SubsystemExecutor;
  /** Executor for workflow_run, workflow_save, workflow_list, workflow_get, workflow_delete, workflow_history. */
  readonly workflowExecutor?: SubsystemExecutor;
  /** Executor for ssh_execute, ssh_session_open, ssh_session_write, ssh_session_read, ssh_session_close. */
  readonly sshExecutor?: SubsystemExecutor;
  /** Composite executor for dynamically loaded plugins (`plugin_<name>_<tool>`). */
  readonly pluginExecutor?: SubsystemExecutor;
  /** Executor for plugin management tools (plugin_list, plugin_install, plugin_reload). */
  readonly pluginToolExecutor?: SubsystemExecutor;
  /** Executor for config_manage — triggerfish.yaml configuration management. */
  readonly configManageExecutor?: SubsystemExecutor;
  /** Executor for mcp_manage — MCP server lifecycle management. */
  readonly mcpManageExecutor?: SubsystemExecutor;
  /** Executor for daemon_manage — daemon restart/status with user approval. */
  readonly daemonManageExecutor?: SubsystemExecutor;
  /** Executor for spine_manage — SPINE.md view/append. */
  readonly spineManageExecutor?: SubsystemExecutor;
  /**
   * Skill context tracker for the session. When provided, web_fetch domain
   * restrictions are enforced per the active skill's networkDomains declaration.
   */
  readonly skillContextTracker?: SkillContextTracker;
}
