/**
 * Google Workspace tool definitions and system prompt.
 *
 * Consolidated 5 service-scoped tools (gmail, calendar, tasks, drive, sheets)
 * with `action` parameter dispatch.
 *
 * @module
 */

import type { ToolDefinition } from "../../core/types/tool.ts";

// ── Gmail ───────────────────────────────────────────────────────────

function buildGoogleGmailDef(): ToolDefinition {
  return {
    name: "google_gmail",
    description: "Gmail operations. Actions: search, read, send, label.\n" +
      "- search: find emails. Params: query (required), max_results?\n" +
      "- read: read full email. Params: message_id (required)\n" +
      "- send: send email. Params: to (required), subject (required), body (required), cc?, bcc?\n" +
      "- label: modify labels. Params: message_id (required), add_labels?, remove_labels?",
    parameters: {
      action: {
        type: "string",
        description: "The operation: search, read, send, label",
        required: true,
      },
      query: {
        type: "string",
        description:
          "Gmail search query, same syntax as Gmail search box (search)",
        required: false,
      },
      message_id: {
        type: "string",
        description: "Gmail message ID (read, label)",
        required: false,
      },
      to: {
        type: "string",
        description: "Recipient email address (send)",
        required: false,
      },
      subject: {
        type: "string",
        description: "Email subject line (send)",
        required: false,
      },
      body: {
        type: "string",
        description: "Email body text (send)",
        required: false,
      },
      cc: {
        type: "string",
        description: "CC recipients, comma-separated (send)",
        required: false,
      },
      bcc: {
        type: "string",
        description: "BCC recipients, comma-separated (send)",
        required: false,
      },
      add_labels: {
        type: "string",
        description:
          "Comma-separated label IDs to add, e.g. 'STARRED,IMPORTANT' (label)",
        required: false,
      },
      remove_labels: {
        type: "string",
        description:
          "Comma-separated label IDs to remove, e.g. 'UNREAD,INBOX' (label)",
        required: false,
      },
      max_results: {
        type: "number",
        description: "Maximum results to return (search, default: 10)",
        required: false,
      },
    },
  };
}

// ── Calendar ────────────────────────────────────────────────────────

function buildGoogleCalendarDef(): ToolDefinition {
  return {
    name: "google_calendar",
    description: "Calendar operations. Actions: list, create, update.\n" +
      "- list: list upcoming events. Params: time_min?, time_max?, max_results?, calendar_id?\n" +
      "- create: create event. Params: summary (required), start (required), end (required), description?, location?, attendees?, calendar_id?\n" +
      "- update: update event. Params: event_id (required), summary?, start?, end?, description?, location?, attendees?, calendar_id?",
    parameters: {
      action: {
        type: "string",
        description: "The operation: list, create, update",
        required: true,
      },
      event_id: {
        type: "string",
        description: "Event ID to update (update)",
        required: false,
      },
      summary: {
        type: "string",
        description: "Event title/summary (create, update)",
        required: false,
      },
      start: {
        type: "string",
        description: "Start time ISO 8601 (list: time_min, create, update)",
        required: false,
      },
      end: {
        type: "string",
        description: "End time ISO 8601 (list: time_max, create, update)",
        required: false,
      },
      time_min: {
        type: "string",
        description: "Start of time range ISO 8601 (list, defaults to now)",
        required: false,
      },
      time_max: {
        type: "string",
        description:
          "End of time range ISO 8601 (list, defaults to 7 days from now)",
        required: false,
      },
      description: {
        type: "string",
        description: "Event description/notes (create, update)",
        required: false,
      },
      location: {
        type: "string",
        description: "Event location (create, update)",
        required: false,
      },
      attendees: {
        type: "string",
        description: "Comma-separated email addresses (create, update)",
        required: false,
      },
      calendar_id: {
        type: "string",
        description: "Calendar ID (default: 'primary')",
        required: false,
      },
      max_results: {
        type: "number",
        description: "Maximum events to return (list, default: 10)",
        required: false,
      },
    },
  };
}

// ── Tasks ───────────────────────────────────────────────────────────

function buildGoogleTasksDef(): ToolDefinition {
  return {
    name: "google_tasks",
    description: "Task operations. Actions: list, create, complete.\n" +
      "- list: list tasks. Params: task_list_id?, show_completed?, max_results?\n" +
      "- create: create task. Params: title (required), notes?, due?, task_list_id?\n" +
      "- complete: complete task. Params: task_id (required), task_list_id?",
    parameters: {
      action: {
        type: "string",
        description: "The operation: list, create, complete",
        required: true,
      },
      task_id: {
        type: "string",
        description: "Task ID to complete (complete)",
        required: false,
      },
      title: {
        type: "string",
        description: "Task title (create)",
        required: false,
      },
      notes: {
        type: "string",
        description: "Task notes/description (create)",
        required: false,
      },
      due: {
        type: "string",
        description: "Due date ISO 8601 (create)",
        required: false,
      },
      task_list_id: {
        type: "string",
        description: "Task list ID (default: '@default')",
        required: false,
      },
      show_completed: {
        type: "boolean",
        description: "Include completed tasks (list, default: true)",
        required: false,
      },
      max_results: {
        type: "number",
        description: "Maximum tasks to return (list, default: 20)",
        required: false,
      },
    },
  };
}

// ── Drive ───────────────────────────────────────────────────────────

function buildGoogleDriveDef(): ToolDefinition {
  return {
    name: "google_drive",
    description: "Drive operations. Actions: search, read.\n" +
      "- search: search for files. Params: query (required), max_results?\n" +
      "- read: read file content. Params: file_id (required)",
    parameters: {
      action: {
        type: "string",
        description: "The operation: search, read",
        required: true,
      },
      query: {
        type: "string",
        description:
          "Drive search query, e.g. \"name contains 'report'\" (search)",
        required: false,
      },
      file_id: {
        type: "string",
        description: "Drive file ID from search results (read)",
        required: false,
      },
      max_results: {
        type: "number",
        description: "Maximum files to return (search, default: 10)",
        required: false,
      },
    },
  };
}

// ── Sheets ──────────────────────────────────────────────────────────

function buildGoogleSheetsDef(): ToolDefinition {
  return {
    name: "google_sheets",
    description: "Sheets operations. Actions: read, write.\n" +
      "- read: read cell range. Params: spreadsheet_id (required), range (required)\n" +
      "- write: write cell range. Params: spreadsheet_id (required), range (required), values (required)",
    parameters: {
      action: {
        type: "string",
        description: "The operation: read, write",
        required: true,
      },
      spreadsheet_id: {
        type: "string",
        description: "Spreadsheet ID from URL or drive_search",
        required: false,
      },
      range: {
        type: "string",
        description: "Cell range in A1 notation, e.g. 'Sheet1!A1:D10'",
        required: false,
      },
      values: {
        type: "string",
        description:
          'JSON-encoded 2D array of values, e.g. \'[["Name","Age"],["Alice","30"]]\' (write)',
        required: false,
      },
    },
  };
}

// ── Public API ──────────────────────────────────────────────────────

/** Get all 5 consolidated Google Workspace tool definitions. */
export function buildGoogleToolDefinitions(): readonly ToolDefinition[] {
  return [
    buildGoogleGmailDef(),
    buildGoogleCalendarDef(),
    buildGoogleTasksDef(),
    buildGoogleDriveDef(),
    buildGoogleSheetsDef(),
  ];
}

/** @deprecated Use buildGoogleToolDefinitions instead */
export const getGoogleToolDefinitions = buildGoogleToolDefinitions;

/** System prompt section explaining Google Workspace tools to the LLM. */
export const GOOGLE_TOOLS_SYSTEM_PROMPT = `## Google Workspace

You have access to Google Workspace tools for Gmail, Calendar, Tasks, Drive, and Sheets.

- \`google_gmail\`: action = search | read | send | label
- \`google_calendar\`: action = list | create | update
- \`google_tasks\`: action = list | create | complete
- \`google_drive\`: action = search | read — for spreadsheets, prefer google_sheets
- \`google_sheets\`: action = read | write

When the user asks about their schedule, emails, or documents, use these tools directly — never narrate intent.
All Google data is classified at least INTERNAL. Do not share Google data on PUBLIC channels.`;
