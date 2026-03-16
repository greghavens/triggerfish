/**
 * Todo manager — factory and storage operations for agent todo lists.
 *
 * Creates a TodoManager bound to a specific agent and storage provider.
 * Handles persistence, validation, and auto-preservation of dropped items.
 *
 * @module
 */

import type {
  TodoItem,
  TodoList,
  TodoManager,
  TodoManagerOptions,
  TodoStatus,
} from "./todo_defs.ts";
import { verifyTodoItem } from "./todo_validation.ts";

/**
 * Build the storage key for an agent's todo list.
 */
function todoKey(agentId: string): string {
  return `todos:${agentId}`;
}

/** Parse and validate a todo list from raw storage JSON, returning empty on failure. */
function parseTodoListFromStorage(raw: string | null): readonly TodoItem[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.todos)) return [];
    return parsed.todos
      .map(verifyTodoItem)
      .filter((item: TodoItem | null): item is TodoItem => item !== null);
  } catch {
    return [];
  }
}

/** Mark old items absent from the new list as completed (auto-preserve). */
function preserveAbsentTodoItems(
  oldItems: readonly TodoItem[],
  newIds: ReadonlySet<string>,
): readonly TodoItem[] {
  return oldItems
    .filter((old) => !newIds.has(old.id))
    .map((old): TodoItem => ({
      ...old,
      status: "completed" as TodoStatus,
      updated_at: new Date().toISOString(),
    }));
}

/** Resolve preserved items from storage when not all incoming items are done. */
async function resolvePreservedTodoItems(
  storage: TodoManagerOptions["storage"],
  key: string,
  validated: readonly TodoItem[],
): Promise<readonly TodoItem[]> {
  const allDone = validated.every((t) => t.status === "completed");
  if (allDone) return [];
  const oldRaw = await storage.get(key);
  const oldItems = parseTodoListFromStorage(oldRaw);
  const newIds = new Set(validated.map((t) => t.id));
  return preserveAbsentTodoItems(oldItems, newIds);
}

/** Write validated todo items to storage, merging preserved items. */
async function writeTodoList(
  storage: TodoManagerOptions["storage"],
  key: string,
  todos: readonly TodoItem[],
): Promise<TodoList> {
  const validated = todos
    .map(verifyTodoItem)
    .filter((item): item is TodoItem => item !== null);
  if (validated.length === 0) {
    await storage.delete(key);
    return { todos: [] };
  }
  const preserved = await resolvePreservedTodoItems(storage, key, validated);
  const merged: TodoList = { todos: [...preserved, ...validated] };
  await storage.set(key, JSON.stringify(merged));
  return merged;
}

/**
 * Create a TodoManager bound to a specific agent and storage provider.
 */
export function createTodoManager(options: TodoManagerOptions): TodoManager {
  const { storage, agentId } = options;
  const key = todoKey(agentId);

  return {
    async read(): Promise<TodoList> {
      const raw = await storage.get(key);
      return { todos: [...parseTodoListFromStorage(raw)] };
    },
    write(todos: readonly TodoItem[]): Promise<TodoList> {
      return writeTodoList(storage, key, todos);
    },
  };
}
