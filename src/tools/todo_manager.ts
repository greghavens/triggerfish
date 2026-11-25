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
import {
  canFlowTo,
  maxClassification,
  parseClassification,
} from "../core/types/classification.ts";
import { canPersistExecutionChecklistItems } from "../core/execution_checklists.ts";
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
      const level = typeof parsed._classification === "string"
        ? parseClassification(parsed._classification)
        : undefined;
      return {
        todos: parsed.todos
          .map(verifyTodoItem)
          .filter((item: TodoItem | null): item is TodoItem => item !== null),
        revision: typeof parsed.revision === "string"
          ? parsed.revision
          : "legacy",
        ...(level?.ok && { _classification: level.value }),
      };
    }
  } catch {
    // Preserve the historical behavior for damaged stored lists.
  }
  return { todos: [], revision: "legacy" };
}

/** A scoped list cannot disclose or merge records outside its current taint. */
export class TodoScopeUnavailable extends Error {
  constructor(invalidFields = false) {
    super(
      invalidFields
        ? "Todo list contains invalid, oversized, or credential-bearing fields."
        : "Todo list is unavailable at the current classification.",
    );
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

/** Write validated todo items to storage, merging preserved items. */
async function writeTodoList(
  { storage, getClassification }: TodoManagerOptions,
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
    const level = getClassification?.();
    if (level && raw !== null) {
      if (
        (current._classification &&
          !canFlowTo(current._classification, level)) ||
        (!current._classification && validated.length > 0)
      ) throw new TodoScopeUnavailable();
    }
    const preserved = validated.every((todo) => todo.status === "completed")
      ? []
      : preserveAbsentTodoItems(
        current.todos,
        new Set(validated.map((todo) => todo.id)),
      );
    const items = [...preserved, ...validated];
    if (level && !canPersistExecutionChecklistItems(items)) {
      throw new TodoScopeUnavailable(true);
    }
    const merged = {
      todos: items,
      revision: crypto.randomUUID(),
      ...(level && {
        _classification: current._classification
          ? maxClassification(current._classification, level)
          : level,
      }),
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
    ...(options.getClassification && { requiresRootDispatch: true }),
    async read(readCeiling): Promise<RevisionedTodoList> {
      const raw = await storage.get(key);
      const list = parseTodoListFromStorage(raw);
      if (
        raw !== null && options.getClassification &&
        (!list._classification ||
          !canFlowTo(
            list._classification,
            readCeiling ?? options.getClassification(),
          ))
      ) throw new TodoScopeUnavailable();
      return list;
    },
    async write(todos: readonly TodoItem[]): Promise<RevisionedTodoList> {
      const result = await writeTodoList(options, key, todos);
      if (!result) throw new Error("Unconditional todo write failed");
      return result;
    },
    writeIfCurrent(todos, expectedRevision) {
      return writeTodoList(options, key, todos, expectedRevision);
    },
  };
}
