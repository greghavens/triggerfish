/**
 * Google Calendar module.
 *
 * Calendar service, tool definitions, and tool executors.
 *
 * @module
 */

export type {
  Attendee,
  CalendarCreateOptions,
  CalendarEvent,
  CalendarListOptions,
  CalendarService,
  CalendarUpdateOptions,
} from "./types_calendar.ts";

export { createCalendarService } from "./calendar.ts";

export {
  buildCalendarCreateDef,
  buildCalendarListDef,
  buildCalendarUpdateDef,
} from "./tools_defs_calendar.ts";

export {
  createGoogleCalendarEvent,
  executeCalendarCreate,
  executeCalendarList,
  executeCalendarUpdate,
  listGoogleCalendarEvents,
  updateGoogleCalendarEvent,
} from "./tools_exec_calendar.ts";
