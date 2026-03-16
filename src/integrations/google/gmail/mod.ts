/**
 * Gmail module.
 *
 * Gmail service, tool definitions, and tool executors.
 *
 * @module
 */

export type {
  GmailLabelOptions,
  GmailMessage,
  GmailSearchOptions,
  GmailSendOptions,
  GmailService,
} from "./types_gmail.ts";

export { createGmailService } from "./gmail.ts";

export {
  buildGmailLabelDef,
  buildGmailReadDef,
  buildGmailSearchDef,
  buildGmailSendDef,
} from "./tools_defs_gmail.ts";

export {
  executeGmailLabel,
  executeGmailRead,
  executeGmailSearch,
  executeGmailSend,
  labelGmailMessage,
  queryGmailMessages,
  readGmailMessage,
  sendGmailMessage,
} from "./tools_exec_gmail.ts";
