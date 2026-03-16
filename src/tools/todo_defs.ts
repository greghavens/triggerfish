/**
 * Todo tool types, definitions, and system prompt.
 *
 * Defines TodoItem, TodoManager, and the tool schemas for todo_read
 * and todo_write. Separated from the manager implementation and
 * formatters in `todo.ts` for lighter type-only imports.
 *
 * @module
 */

import type { StorageProvider } from "../core/storage/provider.ts";
import type { ToolDefinition } from "../core/types/tool.ts";

/** Priority level for a todo item. */
export type TodoPriority = "high" | "medium" | "low";

/** Status of a todo item. */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** A single todo item. */
export interface TodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: TodoStatus;
  readonly priority: TodoPriority;
  readonly created_at: string;
  readonly updated_at: string;
}

/** The full todo list payload for read/write operations. */
export interface TodoList {
  readonly todos: readonly TodoItem[];
}

/** Options for creating a TodoManager. */
export interface TodoManagerOptions {
  readonly storage: StorageProvider;
  readonly agentId: string;
}

/** Manager for agent todo operations. */
export interface TodoManager {
  /** Read the full todo list. */
  read(): Promise<TodoList>;
  /** Replace the full todo list. */
  write(todos: readonly TodoItem[]): Promise<TodoList>;
}

function buildTodoReadDef(): ToolDefinition {
  return {
    name: "todo_read",
    description:
      "Read the current todo list. Returns all todo items with their id, content, status, priority, and timestamps.",
    parameters: {},
  };
}

function buildTodoWriteParams(): ToolDefinition["parameters"] {
  return {
    todos: {
      type: "array",
      description:
        "The complete list of todo items. Each item: {id, content, status, priority, created_at, updated_at}",
      required: true,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          content: { type: "string" },
          status: { type: "string" },
          priority: { type: "string" },
          created_at: { type: "string" },
          updated_at: { type: "string" },
        },
      },
    },
  };
}

function buildTodoWriteDef(): ToolDefinition {
  return {
    name: "todo_write",
    description:
      "Replace the entire todo list. Takes the full list of todos — this is a complete replacement, not a partial update. " +
      "Each todo must have: id (string), content (string), status (pending|in_progress|completed), " +
      "priority (high|medium|low), created_at (ISO timestamp), updated_at (ISO timestamp).",
    parameters: buildTodoWriteParams(),
  };
}

/** Tool definitions for todo_read and todo_write. */
export function buildTodoToolDefinitions(): readonly ToolDefinition[] {
  return [
    buildTodoReadDef(),
    buildTodoWriteDef(),
  ];
}

/**
 * Platform-level system prompt section for the todo tool.
 *
 * This is appended to the system prompt AFTER SPINE.md and tool definitions.
 * SPINE.md remains the foundation of the agent's identity and mission.
 * This section layers on platform behaviour that every agent gets regardless
 * of user configuration — the user never needs to know about it or set it up.
 */
export const TODO_SYSTEM_PROMPT = `## Task Planning

You have a todo list (todo_read / todo_write) for tracking multi-step work.

- Only use todos for genuinely complex implementation tasks (3+ distinct coding steps). Simple questions, lookups, research, and analysis do not need todos.
- Do NOT create todos for the current request unless it is clearly multi-step implementation work.
- Do NOT read the todo list unless the user asks about previous tasks or you need to resume work.
- Do NOT create todos when executing a skill — the skill already defines your workflow.
- When you do use todos: keep one task in_progress at a time, mark completed immediately when done.`;

/** @deprecated Use buildTodoToolDefinitions instead */
export const getTodoToolDefinitions = buildTodoToolDefinitions;
