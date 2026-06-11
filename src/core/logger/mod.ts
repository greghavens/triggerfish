/**
 * Logger module — structured logging with file rotation.
 *
 * @module
 */

export type { LogLevel, UserLogLevel } from "./levels.ts";
export {
  LOG_LEVEL_ORDER,
  parseUserLogLevel,
  shouldLog,
  USER_LEVEL_MAP,
} from "./levels.ts";
export type { FileWriter, FileWriterConfig } from "./writer.ts";
export { createFileWriter } from "./writer.ts";
export type { Logger, LoggerConfig } from "./logger.ts";
export {
  createLogger,
  initLogger,
  isLoggerInitialized,
  shutdownLogger,
} from "./logger.ts";
export {
  formatTaggedEntry,
  MAX_EXTERNAL_BYTES,
  sanitizeExternal,
  tagExternal,
} from "./sanitizer.ts";
export { redactCredentialText, redactSecretValue } from "./redactor.ts";
export type { AuditEvent, AuditLogConfig } from "./audit.ts";
export { initAuditLog, shutdownAuditLog, writeAuditEvent } from "./audit.ts";
