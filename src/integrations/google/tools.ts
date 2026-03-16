/**
 * Google Workspace tool executor.
 *
 * Creates a chain-compatible executor for the 5 consolidated Google
 * Workspace tools. Each tool dispatches on the `action` parameter
 * to the per-service executor module.
 *
 * @module
 */

import type { GoogleToolContext } from "./types.ts";
import { recordGoogleLineage } from "./lineage.ts";

import {
  labelGmailMessage,
  queryGmailMessages,
  readGmailMessage,
  sendGmailMessage,
} from "./gmail/tools_exec_gmail.ts";
import {
  createGoogleCalendarEvent,
  listGoogleCalendarEvents,
  updateGoogleCalendarEvent,
} from "./calendar/tools_exec_calendar.ts";
import {
  completeGoogleTask,
  createGoogleTask,
  listGoogleTasks,
} from "./tasks/tools_exec_tasks.ts";
import {
  queryGoogleDrive,
  readGoogleDriveFile,
} from "./drive/tools_exec_drive.ts";
import {
  readGoogleSheet,
  writeGoogleSheet,
} from "./sheets/tools_exec_sheets.ts";

// ─── Barrel re-exports from tools_defs.ts ───────────────────────────────────

export {
  getGoogleToolDefinitions,
  GOOGLE_TOOLS_SYSTEM_PROMPT,
  buildGoogleToolDefinitions,
} from "./tools_defs.ts";

// ─── Action dispatch tables ─────────────────────────────────────────────────

type ActionHandler = (input: Record<string, unknown>) => Promise<string>;

/** Wrap an executor call so lineage is recorded after a successful response. */
function withLineage(
  ctx: GoogleToolContext,
  service: string,
  action: string,
  handler: (input: Record<string, unknown>) => Promise<string>,
): ActionHandler {
  return async (input) => {
    const result = await handler(input);
    await recordGoogleLineage(ctx, service, action, result);
    return result;
  };
}

function buildGmailDispatch(
  ctx: GoogleToolContext,
): Readonly<Record<string, ActionHandler>> {
  return {
    search: withLineage(
      ctx,
      "gmail",
      "search",
      (i) => queryGmailMessages(ctx.gmail, i),
    ),
    read: withLineage(
      ctx,
      "gmail",
      "read",
      (i) => readGmailMessage(ctx.gmail, i),
    ),
    send: withLineage(
      ctx,
      "gmail",
      "send",
      (i) => sendGmailMessage(ctx.gmail, i),
    ),
    label: withLineage(
      ctx,
      "gmail",
      "label",
      (i) => labelGmailMessage(ctx.gmail, i),
    ),
  };
}

function buildCalendarDispatch(
  ctx: GoogleToolContext,
): Readonly<Record<string, ActionHandler>> {
  return {
    list: withLineage(
      ctx,
      "calendar",
      "list",
      (i) => listGoogleCalendarEvents(ctx.calendar, i),
    ),
    create: withLineage(
      ctx,
      "calendar",
      "create",
      (i) => createGoogleCalendarEvent(ctx.calendar, i),
    ),
    update: withLineage(
      ctx,
      "calendar",
      "update",
      (i) => updateGoogleCalendarEvent(ctx.calendar, i),
    ),
  };
}

function buildTasksDispatch(
  ctx: GoogleToolContext,
): Readonly<Record<string, ActionHandler>> {
  return {
    list: withLineage(
      ctx,
      "tasks",
      "list",
      (i) => listGoogleTasks(ctx.tasks, i),
    ),
    create: withLineage(
      ctx,
      "tasks",
      "create",
      (i) => createGoogleTask(ctx.tasks, i),
    ),
    complete: withLineage(
      ctx,
      "tasks",
      "complete",
      (i) => completeGoogleTask(ctx.tasks, i),
    ),
  };
}

function buildDriveDispatch(
  ctx: GoogleToolContext,
): Readonly<Record<string, ActionHandler>> {
  return {
    search: withLineage(
      ctx,
      "drive",
      "search",
      (i) => queryGoogleDrive(ctx.drive, i),
    ),
    read: withLineage(
      ctx,
      "drive",
      "read",
      (i) => readGoogleDriveFile(ctx.drive, i),
    ),
  };
}

function buildSheetsDispatch(
  ctx: GoogleToolContext,
): Readonly<Record<string, ActionHandler>> {
  return {
    read: withLineage(
      ctx,
      "sheets",
      "read",
      (i) => readGoogleSheet(ctx.sheets, i),
    ),
    write: withLineage(
      ctx,
      "sheets",
      "write",
      (i) => writeGoogleSheet(ctx.sheets, i),
    ),
  };
}

// ─── Executor ───────────────────────────────────────────────────────────────

/**
 * Create a tool executor for Google Workspace tools.
 *
 * Returns null for unknown tool names (allowing chaining with other executors).
 *
 * @param ctx - Google tool context with services and session state
 * @returns An executor function: (name, input) => Promise<string | null>
 */
export function createGoogleToolExecutor(
  ctx: GoogleToolContext,
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  const dispatchers: Readonly<
    Record<string, Readonly<Record<string, ActionHandler>>>
  > = {
    google_gmail: buildGmailDispatch(ctx),
    google_calendar: buildCalendarDispatch(ctx),
    google_tasks: buildTasksDispatch(ctx),
    google_drive: buildDriveDispatch(ctx),
    google_sheets: buildSheetsDispatch(ctx),
  };

  // deno-lint-ignore require-await
  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    const actionMap = dispatchers[name];
    if (!actionMap) return null;

    const action = input.action;
    if (typeof action !== "string" || action.length === 0) {
      return `Error: ${name} requires an 'action' parameter (string).`;
    }

    const handler = actionMap[action];
    if (!handler) {
      const valid = Object.keys(actionMap).join(", ");
      return `Error: unknown action "${action}" for ${name}. Valid actions: ${valid}`;
    }

    return handler(input);
  };
}
