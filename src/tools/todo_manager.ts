/**
 * Todo manager — factory and storage operations for agent todo lists.
 *
 * Creates a TodoManager bound to a specific agent and storage provider.
 * Handles persistence, validation, and auto-preservation of dropped items.
 *
 * @module
 */

import type {
  RevisionedTodoList,
  TodoItem,
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

/** Parse a current or legacy list, returning an empty list on failure. */
function parseTodoListFromStorage(raw: string | null): RevisionedTodoList {
  if (raw === null) return { todos: [], revision: "empty" };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.todos)) {
      return {
        todos: parsed.todos
          .map(verifyTodoItem)
          .filter((item: TodoItem | null): item is TodoItem => item !== null),
        revision: typeof parsed.revision === "string"
          ? parsed.revision
          : "legacy",
      };
    }
  } catch {
    // Preserve the historical behavior for damaged stored lists.
  }
  return { todos: [], revision: "legacy" };
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

/** Write validated todo items to storage, merging preserved items. */
async function writeTodoList(
  storage: TodoManagerOptions["storage"],
  key: string,
  todos: readonly TodoItem[],
  expectedRevision?: string,
): Promise<RevisionedTodoList | null> {
  const validated = todos
    .map(verifyTodoItem)
    .filter((item): item is TodoItem => item !== null);
  if (expectedRevision !== undefined && !storage.compareAndSet) return null;
  while (true) {
    const raw = await storage.get(key);
    const current = parseTodoListFromStorage(raw);
    if (
      expectedRevision !== undefined && current.revision !== expectedRevision
    ) return null;
    const preserved = validated.every((todo) => todo.status === "completed")
      ? []
      : preserveAbsentTodoItems(
        current.todos,
        new Set(validated.map((todo) => todo.id)),
      );
    const merged = {
      todos: [...preserved, ...validated],
      revision: crypto.randomUUID(),
    };
    const next = JSON.stringify(merged);
    if (!storage.compareAndSet) {
      await storage.set(key, next);
      return merged;
    }
    if (await storage.compareAndSet(key, raw, next)) return merged;
    if (expectedRevision !== undefined) return null;
  }
}

/**
 * Create a TodoManager bound to a specific agent and storage provider.
 */
export function createTodoManager(options: TodoManagerOptions): TodoManager {
  const { storage, agentId } = options;
  const key = todoKey(agentId);

  return {
    async read(): Promise<RevisionedTodoList> {
      const raw = await storage.get(key);
      return parseTodoListFromStorage(raw);
    },
    async write(todos: readonly TodoItem[]): Promise<RevisionedTodoList> {
      const result = await writeTodoList(storage, key, todos);
      if (!result) throw new Error("Unconditional todo write failed");
      return result;
    },
    writeIfCurrent(todos, expectedRevision) {
      return writeTodoList(storage, key, todos, expectedRevision);
    },
  };
}
