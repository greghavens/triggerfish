/**
 * Google Workspace shared types — barrel re-export.
 *
 * All interfaces for OAuth2 auth, Gmail, Calendar, Tasks, Drive,
 * and Sheets services. Split by domain concept into dedicated files.
 *
 * @module
 */

export type {
  GoogleApiClient,
  GoogleApiError,
  GoogleApiResult,
  GoogleAuthConfig,
  GoogleAuthConsentResult,
  GoogleAuthManager,
  GoogleAuthResult,
  GoogleTokens,
} from "./auth/types_auth.ts";

export type {
  GmailLabelOptions,
  GmailMessage,
  GmailSearchOptions,
  GmailSendOptions,
  GmailService,
} from "./gmail/types_gmail.ts";

export type {
  Attendee,
  CalendarCreateOptions,
  CalendarEvent,
  CalendarListOptions,
  CalendarService,
  CalendarUpdateOptions,
} from "./calendar/types_calendar.ts";

export type {
  TaskCreateOptions,
  TaskItem,
  TaskListOptions,
  TasksService,
} from "./tasks/types_tasks.ts";

export type {
  DriveFile,
  DriveSearchOptions,
  DriveService,
} from "./drive/types_drive.ts";

export type {
  SheetRange,
  SheetsService,
  SheetWriteOptions,
} from "./sheets/types_sheets.ts";

export type { GoogleToolContext } from "./auth/types_context.ts";
