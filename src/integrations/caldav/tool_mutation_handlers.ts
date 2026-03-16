/**
 * CalDAV mutation tool handlers.
 *
 * Handlers for caldav_events_create, caldav_events_update, and
 * caldav_events_delete — all write operations.
 *
 * @module
 */

import type {
  CalDavEvent,
  CalDavEventInput,
  CalDavToolContext,
} from "./types.ts";
import { generateVEvent, parseVEvent } from "./ical.ts";
import { buildMultigetReport } from "./tool_reports.ts";
import { resolveCalendarUrl } from "./tool_query_handlers.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("caldav:tools");

/** Execute caldav_events_create. */
export async function createCalDavEvent(
  ctx: CalDavToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const summary = input.summary;
  const start = input.start;
  const end = input.end;

  if (typeof summary !== "string" || summary.length === 0) {
    return "Error: caldav_events_create requires 'summary'.";
  }
  if (typeof start !== "string" || start.length === 0) {
    return "Error: caldav_events_create requires 'start'.";
  }
  if (typeof end !== "string" || end.length === 0) {
    return "Error: caldav_events_create requires 'end'.";
  }

  const calendarUrl = resolveCalendarUrl(ctx, input);
  const uid = crypto.randomUUID();

  log.info("Executing caldav_events_create", {
    operation: "executeEventsCreate",
    summary,
  });

  const icalData = generateVEvent(buildCreateEventInput(uid, input));
  const eventUrl = `${calendarUrl.replace(/\/$/, "")}/${uid}.ics`;
  const result = await ctx.client.put(eventUrl, icalData);

  if (!result.ok) {
    return `Error creating event: ${result.error.message}`;
  }

  return JSON.stringify({
    uid,
    etag: result.value.etag,
    url: result.value.href,
    summary,
    start,
    end,
    _classification: ctx.sessionTaint(),
    _origin: `caldav:event:${uid}`,
  });
}

/** @deprecated Use createCalDavEvent instead */
export const executeEventsCreate = createCalDavEvent;

/** Build the event input for creation from tool input. */
function buildCreateEventInput(
  uid: string,
  input: Record<string, unknown>,
): CalDavEventInput {
  const allDay = input.all_day === true;
  const attendees = Array.isArray(input.attendees)
    ? input.attendees.map((email: unknown) => ({ email: String(email) }))
    : undefined;

  const recurrence = input.recurrence && typeof input.recurrence === "object"
    ? input.recurrence as CalDavEvent["recurrence"]
    : undefined;

  return {
    uid,
    summary: input.summary as string,
    start: input.start as string,
    end: input.end as string,
    allDay,
    ...(typeof input.location === "string" ? { location: input.location } : {}),
    ...(typeof input.description === "string"
      ? { description: input.description }
      : {}),
    ...(attendees ? { attendees } : {}),
    ...(recurrence ? { recurrence } : {}),
  };
}

/** Execute caldav_events_update. */
export async function updateCalDavEvent(
  ctx: CalDavToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const eventUid = input.event_uid;
  const etag = input.etag;

  if (typeof eventUid !== "string" || eventUid.length === 0) {
    return "Error: caldav_events_update requires 'event_uid'.";
  }
  if (typeof etag !== "string" || etag.length === 0) {
    return "Error: caldav_events_update requires 'etag' for conflict detection.";
  }

  const calendarUrl = resolveCalendarUrl(ctx, input);

  log.info("Executing caldav_events_update", {
    operation: "executeEventsUpdate",
    eventUid,
  });

  const existing = await fetchExistingEvent(ctx, calendarUrl, eventUid);
  if (!existing.ok) return existing.error;

  const updated = generateVEvent(
    buildUpdateEventInput(eventUid, existing.value.event, input),
  );

  const eventHref = existing.value.href ||
    `${calendarUrl.replace(/\/$/, "")}/${eventUid}.ics`;
  const putResult = await ctx.client.put(eventHref, updated, etag);

  if (!putResult.ok) {
    if (putResult.error.status === 412) {
      return "Error: ETag mismatch — the event was modified by another client. Fetch the latest version and retry.";
    }
    return `Error updating event: ${putResult.error.message}`;
  }

  return JSON.stringify({
    uid: eventUid,
    etag: putResult.value.etag,
    updated: true,
    _classification: ctx.sessionTaint(),
    _origin: `caldav:event:${eventUid}`,
  });
}

/** @deprecated Use updateCalDavEvent instead */
export const executeEventsUpdate = updateCalDavEvent;

/** Fetch existing event for update by UID. */
async function fetchExistingEvent(
  ctx: CalDavToolContext,
  calendarUrl: string,
  eventUid: string,
): Promise<
  { ok: true; value: { event: CalDavEvent; href: string } } | {
    ok: false;
    error: string;
  }
> {
  const reportBody = buildMultigetReport(eventUid);
  const getResult = await ctx.client.report(calendarUrl, reportBody);

  if (!getResult.ok) {
    return {
      ok: false,
      error: `Error fetching event for update: ${getResult.error.message}`,
    };
  }

  for (const resource of getResult.value.resources) {
    const parsed = parseVEvent(resource.calendarData, {
      url: resource.href,
      etag: resource.etag,
    });
    if (parsed.ok && parsed.value.uid === eventUid) {
      return { ok: true, value: { event: parsed.value, href: resource.href } };
    }
  }

  return {
    ok: false,
    error: `Error: Event with UID '${eventUid}' not found for update.`,
  };
}

/** Build merged event input for update. */
function buildUpdateEventInput(
  eventUid: string,
  existing: CalDavEvent,
  input: Record<string, unknown>,
): CalDavEventInput {
  return {
    uid: eventUid,
    summary: typeof input.summary === "string"
      ? input.summary
      : existing.summary,
    start: typeof input.start === "string" ? input.start : existing.start,
    end: typeof input.end === "string" ? input.end : existing.end,
    allDay: existing.allDay,
    location: typeof input.location === "string"
      ? input.location
      : existing.location,
    description: typeof input.description === "string"
      ? input.description
      : existing.description,
    attendees: Array.isArray(input.attendees)
      ? input.attendees.map((email: unknown) => ({ email: String(email) }))
      : existing.attendees.length > 0
      ? [...existing.attendees]
      : undefined,
    organizer: existing.organizer,
    status: existing.status,
    recurrence: existing.recurrence,
  };
}

/** Execute caldav_events_delete. */
export async function deleteCalDavEvent(
  ctx: CalDavToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const eventUid = input.event_uid;
  const etag = input.etag;

  if (typeof eventUid !== "string" || eventUid.length === 0) {
    return "Error: caldav_events_delete requires 'event_uid'.";
  }
  if (typeof etag !== "string" || etag.length === 0) {
    return "Error: caldav_events_delete requires 'etag' for safe deletion.";
  }

  const calendarUrl = resolveCalendarUrl(ctx, input);
  const eventUrl = `${calendarUrl.replace(/\/$/, "")}/${eventUid}.ics`;

  log.info("Executing caldav_events_delete", {
    operation: "executeEventsDelete",
    eventUid,
  });

  const result = await ctx.client.deleteResource(eventUrl, etag);

  if (!result.ok) {
    if (result.error.status === 412) {
      return "Error: ETag mismatch — the event was modified by another client. Fetch the latest version and retry.";
    }
    return `Error deleting event: ${result.error.message}`;
  }

  return JSON.stringify({
    uid: eventUid,
    deleted: true,
    _origin: `caldav:event:${eventUid}`,
  });
}

/** @deprecated Use deleteCalDavEvent instead */
export const executeEventsDelete = deleteCalDavEvent;
