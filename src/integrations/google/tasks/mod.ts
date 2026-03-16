/**
 * Google Tasks module.
 *
 * Tasks service, tool definitions, and tool executors.
 *
 * @module
 */

export type {
  TaskCreateOptions,
  TaskItem,
  TaskListOptions,
  TasksService,
} from "./types_tasks.ts";

export { createTasksService } from "./tasks.ts";

export {
  buildTasksCompleteDef,
  buildTasksCreateDef,
  buildTasksListDef,
} from "./tools_defs_tasks.ts";

export {
  completeGoogleTask,
  createGoogleTask,
  executeTasksComplete,
  executeTasksCreate,
  executeTasksList,
  listGoogleTasks,
} from "./tools_exec_tasks.ts";
