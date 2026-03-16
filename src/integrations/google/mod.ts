/**
 * Google Workspace module — Gmail, Calendar, Tasks, Drive, Sheets.
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
  DriveFile,
  DriveSearchOptions,
  DriveService,
  GmailLabelOptions,
  GmailMessage,
  GmailSearchOptions,
  GmailSendOptions,
  GmailService,
  GoogleApiClient,
  GoogleApiError,
  GoogleApiResult,
  GoogleAuthConfig,
  GoogleAuthManager,
  GoogleAuthResult,
  GoogleTokens,
  GoogleToolContext,
  SheetRange,
  SheetsService,
  SheetWriteOptions,
  TaskCreateOptions,
  TaskItem,
  TaskListOptions,
  TasksService,
} from "./types.ts";

export { createGoogleAuthManager } from "./auth/auth.ts";

export { createGoogleApiClient } from "./auth/client.ts";

export { createGmailService } from "./gmail/gmail.ts";
export { createCalendarService } from "./calendar/calendar.ts";
export { createTasksService } from "./tasks/tasks.ts";
export { createDriveService } from "./drive/drive.ts";
export { createSheetsService } from "./sheets/sheets.ts";

export {
  createGoogleToolExecutor,
  getGoogleToolDefinitions,
  GOOGLE_TOOLS_SYSTEM_PROMPT,
  buildGoogleToolDefinitions,
} from "./tools.ts";

export { recordGoogleLineage } from "./lineage.ts";
