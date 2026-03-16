/**
 * CalDAV tool definitions and system prompt.
 *
 * Defines the 7 `caldav_*` tool schemas that the LLM sees.
 * Separated from execution logic so definitions can be loaded without
 * pulling in the full handler chain.
 *
 * @module
 */

import type { ToolDefinition } from "../../core/types/tool.ts";

// ─── Tool Definitions ─────────────────────────────────────────────────────────

/** Build the caldav_calendars_list tool definition. */
function buildCalendarsListDef(): ToolDefinition {
  return {
    name: "caldav_calendars_list",
    description:
      "List available CalDAV calendars. Returns calendar names, URLs, and colors.",
    parameters: {},
  };
}

/** Build the caldav_events_list tool definition. */
function buildEventsListDef(): ToolDefinition {
  return {
    name: "caldav_events_list",
    description:
      "List events in a date range. Returns events with summary, times, and location.",
    parameters: {
      time_min: {
        type: "string",
        description:
          "Start of date range (ISO 8601, e.g. '2025-03-01T00:00:00Z')",
        required: true,
      },
      time_max: {
        type: "string",
        description:
          "End of date range (ISO 8601, e.g. '2025-03-31T23:59:59Z')",
        required: true,
      },
      calendar_id: {
        type: "string",
        description: "Calendar URL. Uses default calendar if omitted.",
        required: false,
      },
      max_results: {
        type: "number",
        description: "Maximum number of events to return (default: 50)",
        required: false,
      },
    },
  };
}

/** Build the caldav_events_get tool definition. */
function buildEventsGetDef(): ToolDefinition {
  return {
    name: "caldav_events_get",
    description:
      "Get full details for a specific event by UID. Includes attendees, recurrence, and notes.",
    parameters: {
      event_uid: {
        type: "string",
        description: "The UID of the event to retrieve",
        required: true,
      },
      calendar_id: {
        type: "string",
        description: "Calendar URL. Uses default calendar if omitted.",
        required: false,
      },
    },
  };
}

/** Build the caldav_events_create tool definition. */
function buildEventsCreateDef(): ToolDefinition {
  return {
    name: "caldav_events_create",
    description:
      "Create a new calendar event. Returns the created event with its UID and ETag.",
    parameters: {
      summary: {
        type: "string",
        description: "Event title/summary",
        required: true,
      },
      start: {
        type: "string",
        description:
          "Event start time (ISO 8601, e.g. '20250315T100000Z' or '20250315' for all-day)",
        required: true,
      },
      end: {
        type: "string",
        description: "Event end time (ISO 8601, same format as start)",
        required: true,
      },
      calendar_id: {
        type: "string",
        description: "Calendar URL. Uses default calendar if omitted.",
        required: false,
      },
      location: {
        type: "string",
        description: "Event location",
        required: false,
      },
      description: {
        type: "string",
        description: "Event description/notes",
        required: false,
      },
      all_day: {
        type: "boolean",
        description: "Whether this is an all-day event",
        required: false,
      },
      attendees: {
        type: "array",
        description:
          'List of attendee emails (e.g. ["alice@example.com", "bob@example.com"])',
        required: false,
        items: { type: "string" },
      },
      recurrence: {
        type: "object",
        description:
          'Recurrence rule (e.g. {"frequency": "WEEKLY", "count": 10})',
        required: false,
      },
    },
  };
}

/** Build the caldav_events_update tool definition. */
function buildEventsUpdateDef(): ToolDefinition {
  return {
    name: "caldav_events_update",
    description:
      "Update an existing calendar event. Requires the event's ETag for conflict detection.",
    parameters: {
      event_uid: {
        type: "string",
        description: "The UID of the event to update",
        required: true,
      },
      etag: {
        type: "string",
        description:
          "Current ETag of the event (from events.get or events.list). Required for conflict detection.",
        required: true,
      },
      calendar_id: {
        type: "string",
        description: "Calendar URL. Uses default calendar if omitted.",
        required: false,
      },
      summary: {
        type: "string",
        description: "New event title",
        required: false,
      },
      start: {
        type: "string",
        description: "New start time",
        required: false,
      },
      end: {
        type: "string",
        description: "New end time",
        required: false,
      },
      location: {
        type: "string",
        description: "New location",
        required: false,
      },
      description: {
        type: "string",
        description: "New description",
        required: false,
      },
      attendees: {
        type: "array",
        description: "New attendee list (replaces existing)",
        required: false,
        items: { type: "string" },
      },
    },
  };
}

/** Build the caldav_events_delete tool definition. */
function buildEventsDeleteDef(): ToolDefinition {
  return {
    name: "caldav_events_delete",
    description:
      "Delete a calendar event. Requires the event's ETag for safe deletion.",
    parameters: {
      event_uid: {
        type: "string",
        description: "The UID of the event to delete",
        required: true,
      },
      etag: {
        type: "string",
        description:
          "Current ETag of the event. Required for conflict detection.",
        required: true,
      },
      calendar_id: {
        type: "string",
        description: "Calendar URL. Uses default calendar if omitted.",
        required: false,
      },
    },
  };
}

/** Build the caldav_freebusy tool definition. */
function buildFreebusyDef(): ToolDefinition {
  return {
    name: "caldav_freebusy",
    description:
      "Query free/busy availability for a time range. Returns busy periods.",
    parameters: {
      time_min: {
        type: "string",
        description: "Start of time range (ISO 8601)",
        required: true,
      },
      time_max: {
        type: "string",
        description: "End of time range (ISO 8601)",
        required: true,
      },
      calendar_id: {
        type: "string",
        description: "Calendar URL. Uses default calendar if omitted.",
        required: false,
      },
    },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Get all 7 CalDAV tool definitions. */
export function loadCalDavToolDefinitions(): readonly ToolDefinition[] {
  return [
    buildCalendarsListDef(),
    buildEventsListDef(),
    buildEventsGetDef(),
    buildEventsCreateDef(),
    buildEventsUpdateDef(),
    buildEventsDeleteDef(),
    buildFreebusyDef(),
  ];
}

/** @deprecated Use loadCalDavToolDefinitions instead */
export const getCalDavToolDefinitions = loadCalDavToolDefinitions;

/** System prompt section explaining CalDAV tools to the LLM. */
export const CALDAV_SYSTEM_PROMPT = `## CalDAV Calendar Access

You have access to CalDAV calendar tools via 7 caldav_* tools.

- Use caldav_calendars_list to see available calendars.
- Use caldav_events_list with time_min/time_max to query events in a date range.
- Use caldav_events_get to fetch full event details (attendees, recurrence, notes).
- Use caldav_events_create to create new events. Provide summary, start, and end at minimum.
- Use caldav_events_update to modify events — always provide the current etag for conflict detection.
- Use caldav_events_delete to remove events — requires etag.
- Use caldav_freebusy to check availability for scheduling.
- Calendar data may contain meeting links, attendee emails, and internal project names — treat it as at least INTERNAL.
- Never narrate your intent to use calendar tools — just call them directly.`;
