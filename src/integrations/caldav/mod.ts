/**
 * CalDAV integration — universal calendar access via CalDAV (RFC 4791).
 *
 * Supports iCloud Calendar, Google Calendar, Fastmail, Nextcloud,
 * Radicale, Synology, and most self-hosted CalDAV servers.
 *
 * @module
 */

export type {
  CalDavAttendee,
  CalDavAuthMethod,
  CalDavBasicCredentials,
  CalDavCalendar,
  CalDavClientInterface,
  CalDavClientResult,
  CalDavConfig,
  CalDavCredentials,
  CalDavError,
  CalDavEvent,
  CalDavEventInput,
  CalDavFreeBusy,
  CalDavOAuth2Credentials,
  CalDavRecurrence,
  CalDavToolContext,
  DiscoveryResult,
  PropfindResource,
  PropfindResponse,
  PutResponse,
  ReportResource,
  ReportResponse,
} from "./types.ts";

export { buildAuthHeaders, resolveCalDavCredentials } from "./auth.ts";
export type { ResolveCalDavCredentialsOptions } from "./auth.ts";

export { createCalDavClient } from "./client.ts";
export type { CalDavClientOptions } from "./client.ts";

export { discoverCalDavEndpoint, listCalendars } from "./discovery.ts";
export type {
  DiscoverEndpointOptions,
  ListCalendarsOptions,
} from "./discovery.ts";

export {
  expandRecurrence,
  generateVEvent,
  parseFreeBusy,
  parseRRule,
  parseVEvent,
  parseVEvents,
  unfoldLines,
} from "./ical.ts";

export {
  CALDAV_SYSTEM_PROMPT,
  createCalDavToolExecutor,
  getCalDavToolDefinitions,
  loadCalDavToolDefinitions,
} from "./tools.ts";

export {
  buildCalendarQueryReport,
  buildFreeBusyReport,
  buildMultigetReport,
  formatEventDetail,
  formatEventSummary,
} from "./tool_reports.ts";

export { parsePropfindXml, parseReportXml } from "./client_xml.ts";
