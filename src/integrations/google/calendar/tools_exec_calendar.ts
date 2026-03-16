/**
 * Calendar tool executor.
 *
 * Handles dispatch for calendar_list, calendar_create, and calendar_update.
 *
 * @module
 */

import type { CalendarService } from "../types.ts";

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

/** Parse a comma-separated string into a trimmed, non-empty array. */
function parseCommaSeparated(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Read an optional string field from input. */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Read an optional number field from input with a default. */
function optionalNumber(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

/** Format calendar events list into a JSON string. */
function formatCalendarEvents(
  events: ReadonlyArray<{
    readonly id: string;
    readonly summary: string;
    readonly start: string;
    readonly end: string;
    readonly location?: string;
    readonly attendees?: ReadonlyArray<{ readonly email: string }>;
  }>,
): string {
  return JSON.stringify(
    events.map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start,
      end: e.end,
      location: e.location,
      attendees: e.attendees?.map((a) => a.email),
    })),
  );
}

/** Execute calendar_list tool. */
export async function listGoogleCalendarEvents(
  calendar: CalendarService,
  input: Record<string, unknown>,
): Promise<string> {
  const result = await calendar.list({
    timeMin: optionalString(input.time_min),
    timeMax: optionalString(input.time_max),
    maxResults: optionalNumber(input.max_results, 10),
    calendarId: optionalString(input.calendar_id),
  });
  if (!result.ok) return `Error: ${result.error.message}`;

  if (result.value.length === 0) {
    return "No upcoming events found.";
  }
  return formatCalendarEvents(result.value);
}

/** @deprecated Use listGoogleCalendarEvents instead */
export const executeCalendarList = listGoogleCalendarEvents;

/** Execute calendar_create tool. */
export async function createGoogleCalendarEvent(
  calendar: CalendarService,
  input: Record<string, unknown>,
): Promise<string> {
  const sumErr = requireNonEmptyString(
    input.summary,
    "summary",
    "calendar_create",
  );
  if (sumErr) return sumErr;
  const startErr = requireNonEmptyString(
    input.start,
    "start",
    "calendar_create",
  );
  if (startErr) {
    return `Error: calendar_create requires a 'start' argument (ISO 8601).`;
  }
  const endErr = requireNonEmptyString(input.end, "end", "calendar_create");
  if (endErr) {
    return `Error: calendar_create requires an 'end' argument (ISO 8601).`;
  }

  const result = await calendar.create({
    summary: input.summary as string,
    start: input.start as string,
    end: input.end as string,
    description: optionalString(input.description),
    location: optionalString(input.location),
    attendees: parseCommaSeparated(input.attendees),
    calendarId: optionalString(input.calendar_id),
  });
  if (!result.ok) return `Error: ${result.error.message}`;

  return JSON.stringify({
    created: true,
    id: result.value.id,
    summary: result.value.summary,
    start: result.value.start,
    end: result.value.end,
    link: result.value.htmlLink,
  });
}

/** @deprecated Use createGoogleCalendarEvent instead */
export const executeCalendarCreate = createGoogleCalendarEvent;

/** Execute calendar_update tool. */
export async function updateGoogleCalendarEvent(
  calendar: CalendarService,
  input: Record<string, unknown>,
): Promise<string> {
  const err = requireNonEmptyString(
    input.event_id,
    "event_id",
    "calendar_update",
  );
  if (err) return err;

  const result = await calendar.update({
    eventId: input.event_id as string,
    summary: optionalString(input.summary),
    start: optionalString(input.start),
    end: optionalString(input.end),
    description: optionalString(input.description),
    location: optionalString(input.location),
    attendees: parseCommaSeparated(input.attendees),
    calendarId: optionalString(input.calendar_id),
  });
  if (!result.ok) return `Error: ${result.error.message}`;

  return JSON.stringify({
    updated: true,
    id: result.value.id,
    summary: result.value.summary,
  });
}

/** @deprecated Use updateGoogleCalendarEvent instead */
export const executeCalendarUpdate = updateGoogleCalendarEvent;
