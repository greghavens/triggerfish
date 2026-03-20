/**
 * Tool executor dispatch handlers — subsystem chains, agent tools, and filesystem routing.
 *
 * Contains the subsystem executor chain builders, agent tool dispatchers,
 * and filesystem tool routing used by the main executor factory.
 *
 * @module
 */

import { createTodoToolExecutor } from "../../../tools/mod.ts";
import { createWebToolExecutor } from "../../../tools/web/mod.ts";
import type { LlmProviderRegistry } from "../../../core/types/llm.ts";

import type {
  SubsystemExecutor,
  ToolExecutorOptions,
} from "./executor_types.ts";

import {
  enumerateDirectoryContents,
  executeLogRead,
  invokeShellCommand,
  loadFileContent,
  modifyFileContent,
  persistFileContent,
  queryFilesystem,
} from "./executor_filesystem.ts";

import {
  type CwdTracker,
  resolveAgainstCwd,
  syncCwdAfterCommand,
} from "./executor_cwd.ts";

// ─── Subsystem dispatch chain ────────────────────────────────────────────────

/** Build the first half of the subsystem executor chain. */
export function buildCoreSubsystems(
  opts: ToolExecutorOptions,
  todoExecutor: SubsystemExecutor | null,
): (SubsystemExecutor | null | undefined)[] {
  return [
    todoExecutor,
    opts.memoryExecutor,
    opts.planExecutor,
    opts.browserExecutor,
    opts.tidepoolExecutor,
    opts.sessionExecutor,
    opts.imageExecutor,
    opts.exploreExecutor,
    opts.googleExecutor,
    opts.githubExecutor,
    opts.caldavExecutor,
    opts.notionExecutor,
    opts.obsidianExecutor,
  ];
}

/** Build the second half of the subsystem executor chain. */
export function buildExtendedSubsystems(
  opts: ToolExecutorOptions,
  webExecutor: SubsystemExecutor,
): (SubsystemExecutor | null | undefined)[] {
  return [
    opts.llmTaskExecutor,
    opts.summarizeExecutor,
    opts.healthcheckExecutor,
    opts.claudeExecutor,
    opts.mcpExecutor,
    opts.pluginExecutor,
    opts.pluginToolExecutor,
    opts.secretExecutor,
    opts.triggerExecutor,
    opts.triggerManageExecutor,
    opts.skillExecutor,
    opts.releaseNotesExecutor,
    opts.simulateExecutor,
    opts.teamExecutor,
    opts.workflowExecutor,
    opts.sshExecutor,
    webExecutor,
  ];
}

/**
 * Try each optional subsystem executor in priority order.
 * Returns the first non-null result, or null if none matched.
 */
export async function dispatchToSubsystems(
  chain: (SubsystemExecutor | null | undefined)[],
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  for (const executor of chain) {
    if (!executor) continue;
    const result = await executor(name, input);
    if (result !== null) return result;
  }
  return null;
}

// ─── Agent tool handlers ─────────────────────────────────────────────────────

/** Handle subagent tool call. */
export async function dispatchSubagentTask(
  input: Record<string, unknown>,
  factory: (task: string, tools?: string) => Promise<string>,
): Promise<string> {
  const task = input.task;
  if (typeof task !== "string" || task.length === 0) {
    return "Error: subagent requires a non-empty 'task' argument (string).";
  }
  const toolsArg = typeof input.tools === "string" ? input.tools : undefined;
  try {
    return await factory(task, toolsArg);
  } catch (err) {
    return `Error spawning sub-agent: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}

/** Handle agents_list tool call. */
export function listRegisteredAgents(registry: LlmProviderRegistry): string {
  const defaultProvider = registry.getDefault();
  return JSON.stringify({
    default: defaultProvider?.name ?? "none",
    note:
      "Use 'llm_task' with 'model' parameter to target a specific provider.",
  });
}

/** Dispatch agent-specific tools (subagent, agents_list). */
export function dispatchAgentTool(
  name: string,
  input: Record<string, unknown>,
  opts: ToolExecutorOptions,
): Promise<string> | string | null {
  if (name === "subagent") {
    return opts.subagentFactory
      ? dispatchSubagentTask(input, opts.subagentFactory)
      : "Sub-agent spawning is not available in this context.";
  }
  if (name === "agents_list") {
    return opts.providerRegistry
      ? listRegisteredAgents(opts.providerRegistry)
      : "No provider registry available.";
  }
  return null;
}

// ─── Filesystem dispatch helpers ─────────────────────────────────────────────

/** Return a copy of `input` with `pathKey` resolved against the CWD tracker. */
function resolveFilesystemInput(
  input: Record<string, unknown>,
  cwdTracker: CwdTracker,
  pathKey = "path",
): Record<string, unknown> {
  const raw = input[pathKey];
  if (typeof raw !== "string" || raw.length === 0) return input;
  const resolved = resolveAgainstCwd(cwdTracker, raw);
  if (resolved === raw) return input;
  return { ...input, [pathKey]: resolved };
}

/** Parse exit code from the formatted command result string. */
function parseExitCode(result: string): number {
  const match = result.match(/\[exit code: (\d+)/);
  return match ? Number(match[1]) : -1;
}

/** Run a command, then update the CWD tracker if a `cd` was detected. */
async function invokeCommandWithCwdTracking(
  input: Record<string, unknown>,
  execTools: ToolExecutorOptions["execTools"],
  cwdTracker: CwdTracker,
): Promise<string> {
  const hasExplicitCwd = typeof input.cwd === "string" && input.cwd.length > 0;
  const resolved = (!hasExplicitCwd && cwdTracker.workingDir !== ".")
    ? { ...input, cwd: cwdTracker.workingDir }
    : input;
  const result = await invokeShellCommand(resolved, execTools);
  const command = (input.command ?? input.cmd) as string | undefined;
  if (command && !hasExplicitCwd) {
    syncCwdAfterCommand(cwdTracker, command, parseExitCode(result));
  }
  return result;
}

/** Dispatch filesystem tools. Returns null if not matched. */
export function dispatchFilesystemTool(
  name: string,
  input: Record<string, unknown>,
  opts: ToolExecutorOptions,
  cwdTracker: CwdTracker,
): Promise<string> | null {
  const sandbox = opts.filesystemSandbox;
  switch (name) {
    case "read_file":
      return loadFileContent(
        resolveFilesystemInput(input, cwdTracker),
        sandbox,
      );
    case "write_file":
      return persistFileContent(
        resolveFilesystemInput(input, cwdTracker),
        opts.execTools,
        sandbox,
      );
    case "list_directory":
      return enumerateDirectoryContents(
        resolveFilesystemInput(input, cwdTracker),
        sandbox,
      );
    case "run_command":
      return invokeCommandWithCwdTracking(input, opts.execTools, cwdTracker);
    case "search_files":
      return queryFilesystem(
        resolveFilesystemInput(input, cwdTracker),
        sandbox,
      );
    case "edit_file":
      return modifyFileContent(
        resolveFilesystemInput(input, cwdTracker),
        sandbox,
      );
    case "log_read":
      return executeLogRead(name, input).then((r) =>
        r ?? "No log files found or logs are empty."
      );
    default:
      return null;
  }
}

/** Create the todo tool executor from options. */
export function buildTodoExecutor(
  opts: ToolExecutorOptions,
): SubsystemExecutor | null {
  return opts.todoManager ? createTodoToolExecutor(opts.todoManager) : null;
}

// ─── Shared tool factories ───────────────────────────────────────────────────

/** Create the web tool executor from options. */
export function buildWebExecutor(opts: ToolExecutorOptions): SubsystemExecutor {
  return createWebToolExecutor({
    searchProvider: opts.searchProvider,
    webFetcher: opts.webFetcher,
    getActiveSkillDomains: opts.skillContextTracker
      ? () => {
        const active = opts.skillContextTracker!.getActive();
        if (!active) return null;
        return active.networkDomains;
      }
      : undefined,
  });
}
