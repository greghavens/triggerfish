/**
 * CalDAV read-only tool handlers.
 *
 * Handlers for caldav_calendars_list, caldav_events_list,
 * caldav_events_get, and caldav_freebusy — all query-only operations.
 *
 * @module
 */

import type { CalDavCalendar, CalDavToolContext } from "./types.ts";
import { parseFreeBusy, parseVEvent, parseVEvents } from "./ical.ts";
import { listCalendars } from "./discovery.ts";
import {
  buildCalendarQueryReport,
  buildFreeBusyReport,
  buildMultigetReport,
  formatEventDetail,
  formatEventSummary,
} from "./tool_reports.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("caldav:tools");

/** Resolve the calendar URL from input or default. */
export function resolveCalendarUrl(
  ctx: CalDavToolContext,
  input: Record<string, unknown>,
): string {
  const calendarId = input.calendar_id;
  if (typeof calendarId === "string" && calendarId.length > 0) {
    return calendarId;
  }
  return ctx.defaultCalendar ?? ctx.calendarHomeUrl;
}

/** Execute caldav_calendars_list. */
export async function listCalDavCalendars(
  ctx: CalDavToolContext,
  _input: Record<string, unknown>,
): Promise<string> {
  log.info("Executing caldav_calendars_list", {
    operation: "executeCalendarsList",
  });

  const result = await listCalendars({
    calendarHomeUrl: ctx.calendarHomeUrl,
    client: ctx.client,
  });

  if (!result.ok) {
    return `Error listing calendars: ${result.error}`;
  }

  const calendars = result.value.map((c: CalDavCalendar) => ({
    url: c.url,
    name: c.displayName,
    ...(c.color ? { color: c.color } : {}),
    ...(c.description ? { description: c.description } : {}),
    _classification: ctx.sessionTaint(),
  }));

  return JSON.stringify({ calendars, _origin: "caldav:calendars" });
}

/** @deprecated Use listCalDavCalendars instead */
export const executeCalendarsList = listCalDavCalendars;

/** Execute caldav_events_list. */
export async function listCalDavEvents(
  ctx: CalDavToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const timeMin = input.time_min;
  const timeMax = input.time_max;

  if (typeof timeMin !== "string" || timeMin.length === 0) {
    return "Error: caldav_events_list requires 'time_min' (ISO 8601 date string).";
  }
  if (typeof timeMax !== "string" || timeMax.length === 0) {
    return "Error: caldav_events_list requires 'time_max' (ISO 8601 date string).";
  }

  const calendarUrl = resolveCalendarUrl(ctx, input);
  const maxResults = typeof input.max_results === "number"
    ? input.max_results
    : 50;

  log.info("Executing caldav_events_list", {
    operation: "executeEventsList",
    calendarUrl,
    timeMin,
    timeMax,
  });

  const reportBody = buildCalendarQueryReport(timeMin, timeMax);
  const result = await ctx.client.report(calendarUrl, reportBody);

  if (!result.ok) {
    return `Error listing events: ${result.error.message}`;
  }

  const events = collectEvents(result.value.resources, maxResults, ctx);

  return JSON.stringify({
    events,
    count: events.length,
    _origin: "caldav:events",
  });
}

/** Collect parsed events from REPORT resources, up to maxResults. */
function collectEvents(
  resources: readonly {
    readonly href: string;
    readonly etag: string;
    readonly calendarData: string;
  }[],
  maxResults: number,
  ctx: CalDavToolContext,
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const resource of resources) {
    const parsed = parseVEvents(resource.calendarData, {
      url: resource.href,
      etag: resource.etag,
    });
    if (parsed.ok) {
      for (const event of parsed.value) {
        events.push(formatEventSummary(event, ctx));
        if (events.length >= maxResults) return events;
      }
    }
    if (events.length >= maxResults) return events;
  }
  return events;
}

/** @deprecated Use listCalDavEvents instead */
export const executeEventsList = listCalDavEvents;

/** Execute caldav_events_get. */
export async function fetchCalDavEvent(
  ctx: CalDavToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const eventUid = input.event_uid;
  if (typeof eventUid !== "string" || eventUid.length === 0) {
    return "Error: caldav_events_get requires 'event_uid'.";
  }

  const calendarUrl = resolveCalendarUrl(ctx, input);

  log.info("Executing caldav_events_get", {
    operation: "executeEventsGet",
    eventUid,
  });

  const reportBody = buildMultigetReport(eventUid);
  const result = await ctx.client.report(calendarUrl, reportBody);

  if (!result.ok) {
    return `Error getting event: ${result.error.message}`;
  }

  for (const resource of result.value.resources) {
    const parsed = parseVEvent(resource.calendarData, {
      url: resource.href,
      etag: resource.etag,
    });
    if (parsed.ok && parsed.value.uid === eventUid) {
      return JSON.stringify({
        ...formatEventDetail(parsed.value, ctx),
        _origin: `caldav:event:${eventUid}`,
      });
    }
  }

  return `Error: Event with UID '${eventUid}' not found.`;
}

/** @deprecated Use fetchCalDavEvent instead */
export const executeEventsGet = fetchCalDavEvent;

/** Execute caldav_freebusy. */
export async function queryCalDavFreeBusy(
  ctx: CalDavToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const timeMin = input.time_min;
  const timeMax = input.time_max;

  if (typeof timeMin !== "string" || timeMin.length === 0) {
    return "Error: caldav_freebusy requires 'time_min'.";
  }
  if (typeof timeMax !== "string" || timeMax.length === 0) {
    return "Error: caldav_freebusy requires 'time_max'.";
  }

  const calendarUrl = resolveCalendarUrl(ctx, input);

  log.info("Executing caldav_freebusy", {
    operation: "executeFreeBusy",
    timeMin,
    timeMax,
  });

  const reportBody = buildFreeBusyReport(timeMin, timeMax);
  const result = await ctx.client.report(calendarUrl, reportBody);

  if (!result.ok) {
    return `Error querying free/busy: ${result.error.message}`;
  }

  const periods: Record<string, unknown>[] = [];
  for (const resource of result.value.resources) {
    const parsed = parseFreeBusy(resource.calendarData);
    if (parsed.ok) {
      for (const period of parsed.value) {
        periods.push({
          start: period.start,
          end: period.end,
          type: period.type,
        });
      }
    }
  }

  return JSON.stringify({
    periods,
    _classification: ctx.sessionTaint(),
    _origin: "caldav:freebusy",
  });
}

/** @deprecated Use queryCalDavFreeBusy instead */
export const executeFreeBusy = queryCalDavFreeBusy;
