/**
 * Tool executor dispatch — routes tool calls to the appropriate handler.
 *
 * Given a set of optional subsystem executors (memory, browser, plan, etc.),
 * builds a single ToolExecutor function that tries each in order, falling
 * back to built-in filesystem/cron/subagent handlers.
 *
 * @module
 */

import type { ToolExecutor } from "../../../core/types/tool.ts";

export type {
  SubsystemExecutor,
  ToolExecutorOptions,
} from "./executor_types.ts";
import type {
  SubsystemExecutor,
  ToolExecutorOptions,
} from "./executor_types.ts";

import { dispatchCronTool } from "./executor_cron.ts";
import { createCwdTracker, type CwdTracker } from "./executor_cwd.ts";

export {
  buildCoreSubsystems,
  buildExtendedSubsystems,
  buildTodoExecutor,
  buildWebExecutor,
  dispatchAgentTool,
  dispatchFilesystemTool,
  dispatchSubagentTask,
  dispatchToSubsystems,
  listRegisteredAgents,
} from "./executor_handlers.ts";

import {
  buildCoreSubsystems,
  buildExtendedSubsystems,
  buildTodoExecutor,
  buildWebExecutor,
  dispatchAgentTool,
  dispatchFilesystemTool,
  dispatchToSubsystems,
} from "./executor_handlers.ts";

// ─── Main executor factory ───────────────────────────────────────────────────

/** Context needed to route a tool call through all dispatch layers. */
interface ToolCallContext {
  readonly chain: (SubsystemExecutor | null | undefined)[];
  readonly opts: ToolExecutorOptions;
  readonly cwdTracker: CwdTracker;
}

/** Route a single tool call through subsystems, builtins, and cron. */
async function routeToolCall(
  ctx: ToolCallContext,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const subsystemResult = await dispatchToSubsystems(ctx.chain, name, input);
  if (subsystemResult !== null) return subsystemResult;

  const fsResult = dispatchFilesystemTool(
    name,
    input,
    ctx.opts,
    ctx.cwdTracker,
  );
  if (fsResult !== null) return fsResult;

  const agentResult = dispatchAgentTool(name, input, ctx.opts);
  if (agentResult !== null) return agentResult;

  return dispatchCronTool(name, input, ctx.opts.cronManager) ??
    `Unknown tool: ${name}`;
}

/**
 * Create a tool executor backed by ExecTools, direct filesystem access,
 * and optional subsystem executors for scheduling, planning, browser, etc.
 *
 * Tools that operate on absolute paths (read_file, list_directory, search_files)
 * use Deno APIs directly. Tools that operate on the workspace (write_file,
 * run_command) use ExecTools for sandboxing. Cron tools delegate to CronManager.
 */
export function createToolExecutor(opts: ToolExecutorOptions): ToolExecutor {
  const todoExecutor = buildTodoExecutor(opts);
  const webExecutor = buildWebExecutor(opts);
  const chain = [
    ...buildCoreSubsystems(opts, todoExecutor),
    ...buildExtendedSubsystems(opts, webExecutor),
  ];

  const cwdTracker = createCwdTracker();
  const ctx: ToolCallContext = { chain, opts, cwdTracker };
  return (name: string, input: Record<string, unknown>): Promise<string> =>
    routeToolCall(ctx, name, input);
}
