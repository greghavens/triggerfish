/**
 * Todo item validation — constants and validators for untrusted LLM input.
 *
 * Used by the TodoManager to ensure only well-formed items are persisted.
 *
 * @module
 */

import type { TodoItem, TodoStatus } from "./todo_defs.ts";

/** Valid statuses for todo items. */
const VALID_TODO_STATUSES: readonly TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
];

/** Valid priorities for todo items. */
const VALID_TODO_PRIORITIES: readonly string[] = ["high", "medium", "low"];

/** Check that a field is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Validate that a raw object has valid todo item fields. */
function hasValidTodoFields(obj: Record<string, unknown>): boolean {
  if (!isNonEmptyString(obj.id)) return false;
  if (!isNonEmptyString(obj.content)) return false;
  if (!VALID_TODO_STATUSES.includes(obj.status as TodoStatus)) return false;
  if (!VALID_TODO_PRIORITIES.includes(obj.priority as string)) return false;
  if (!isNonEmptyString(obj.created_at)) return false;
  if (!isNonEmptyString(obj.updated_at)) return false;
  return true;
}

/**
 * Validate a single todo item from untrusted LLM input.
 * Returns the validated item or null if invalid.
 */
export function verifyTodoItem(raw: unknown): TodoItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (!hasValidTodoFields(obj)) return null;
  return {
    id: obj.id as string,
    content: obj.content as string,
    status: obj.status as TodoStatus,
    priority: obj.priority as TodoItem["priority"],
    created_at: obj.created_at as string,
    updated_at: obj.updated_at as string,
  };
}

/** @deprecated Use verifyTodoItem instead */
export const validateTodoItem = verifyTodoItem;
