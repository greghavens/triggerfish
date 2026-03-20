/**
 * Tool executor dispatch and built-in handlers.
 *
 * @module
 */

export {
  buildCoreSubsystems,
  buildExtendedSubsystems,
  buildTodoExecutor,
  buildWebExecutor,
  createToolExecutor,
  dispatchAgentTool,
  dispatchFilesystemTool,
  dispatchSubagentTask,
  dispatchToSubsystems,
  listRegisteredAgents,
} from "./executor.ts";
export type {
  SubsystemExecutor,
  ToolExecutorOptions,
} from "./executor_types.ts";
export { dispatchCronTool } from "./executor_cron.ts";
export {
  enumerateDirectoryContents,
  executeEditFile,
  executeListDirectory,
  executeReadFile,
  executeRunCommand,
  executeSearchFiles,
  executeWriteFile,
  invokeShellCommand,
  loadFileContent,
  modifyFileContent,
  persistFileContent,
  queryFilesystem,
} from "./executor_filesystem.ts";
export {
  createCwdTracker,
  type CwdTracker,
  syncCwdAfterCommand,
  updateCwdAfterCommand,
} from "./executor_cwd.ts";
