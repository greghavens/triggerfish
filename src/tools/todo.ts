/**
 * Todo tool — barrel re-exports.
 *
 * Aggregates the manager, executor, formatters, validation, and definitions
 * into a single import surface for consumers.
 *
 * @module
 */

// ─── Barrel re-exports from todo_defs.ts ────────────────────────────────────

export {
  buildTodoToolDefinitions,
  getTodoToolDefinitions,
  TODO_SYSTEM_PROMPT,
} from "./todo_defs.ts";
export type {
  TodoItem,
  TodoList,
  TodoManager,
  TodoManagerOptions,
  TodoPriority,
  TodoStatus,
} from "./todo_defs.ts";

// ─── Manager ────────────────────────────────────────────────────────────────

export { createTodoManager } from "./todo_manager.ts";

// ─── Executor ───────────────────────────────────────────────────────────────

export { createTodoToolExecutor } from "./todo_executor.ts";

// ─── Formatters & event extraction ──────────────────────────────────────────

export {
  extractTodosFromEvent,
  formatTodoListAnsi,
  formatTodoListHtml,
} from "./todo_formatters.ts";
