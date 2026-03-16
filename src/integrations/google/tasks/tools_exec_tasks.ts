/**
 * Tasks tool executor.
 *
 * Handles dispatch for tasks_list, tasks_create, and tasks_complete.
 *
 * @module
 */

import type { TasksService } from "../types.ts";

/** Validate that a value is a non-empty string. */
function requireNonEmptyString(
  value: unknown,
  field: string,
  tool: string,
): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return `Error: ${tool} requires a non-empty '${field}' argument.`;
  }
  return null;
}

/** Read an optional string field from input. */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Format tasks list into a JSON string. */
function formatTasksList(
  tasks: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly due?: string;
    readonly notes?: string;
  }>,
): string {
  return JSON.stringify(
    tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      due: t.due,
      notes: t.notes,
    })),
  );
}

/** Execute tasks_list tool. */
export async function listGoogleTasks(
  tasks: TasksService,
  input: Record<string, unknown>,
): Promise<string> {
  const result = await tasks.list({
    taskListId: optionalString(input.task_list_id),
    showCompleted: typeof input.show_completed === "boolean"
      ? input.show_completed
      : undefined,
    maxResults: typeof input.max_results === "number" ? input.max_results : 20,
  });
  if (!result.ok) return `Error: ${result.error.message}`;

  if (result.value.length === 0) {
    return "No tasks found.";
  }
  return formatTasksList(result.value);
}

/** @deprecated Use listGoogleTasks instead */
export const executeTasksList = listGoogleTasks;

/** Execute tasks_create tool. */
export async function createGoogleTask(
  tasks: TasksService,
  input: Record<string, unknown>,
): Promise<string> {
  const err = requireNonEmptyString(input.title, "title", "tasks_create");
  if (err) return err;

  const result = await tasks.create({
    title: input.title as string,
    notes: optionalString(input.notes),
    due: optionalString(input.due),
    taskListId: optionalString(input.task_list_id),
  });
  if (!result.ok) return `Error: ${result.error.message}`;

  return JSON.stringify({
    created: true,
    id: result.value.id,
    title: result.value.title,
  });
}

/** @deprecated Use createGoogleTask instead */
export const executeTasksCreate = createGoogleTask;

/** Execute tasks_complete tool. */
export async function completeGoogleTask(
  tasks: TasksService,
  input: Record<string, unknown>,
): Promise<string> {
  const err = requireNonEmptyString(input.task_id, "task_id", "tasks_complete");
  if (err) return err;

  const result = await tasks.complete(
    input.task_id as string,
    optionalString(input.task_list_id),
  );
  if (!result.ok) return `Error: ${result.error.message}`;

  return JSON.stringify({
    completed: true,
    id: result.value.id,
    title: result.value.title,
  });
}

/** @deprecated Use completeGoogleTask instead */
export const executeTasksComplete = completeGoogleTask;
