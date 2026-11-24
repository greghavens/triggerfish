/**
 * Structured logger with dual output (stderr + file).
 *
 * Call `initLogger()` once at startup to configure the global log level
 * and optional file writer. Then use `createLogger(component)` anywhere
 * to get a component-scoped Logger instance.
 *
 * Without `initLogger()`, loggers degrade gracefully to stderr-only at
 * INFO level — safe for tests and one-off scripts.
 *
 * Format: `[2026-02-17T14:30:45.123Z] [INFO] [gateway] message`
 * Console output goes to **stderr** to keep stdout clean for structured
 * CLI output.
 *
 * @module
 */

import type { LogLevel } from "./levels.ts";
import { shouldLog } from "./levels.ts";
import type { FileWriter } from "./writer.ts";
import { formatTaggedEntry } from "./sanitizer.ts";
import { redactSecretValue } from "./redactor.ts";

/** Logger interface — one method per severity level. */
export interface Logger {
  error(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  trace(msg: string, ...args: unknown[]): void;
  /**
   * Log a message with provenance-tagged external fields.
   *
   * Each value in `externalFields` is sanitized and wrapped in «» delimiters
   * before writing to the log. Existing callers using the five standard
   * methods above are unaffected.
   *
   * @example
   * log.ext("DEBUG", "WS upgrade", { origin: req.headers.get("origin") ?? "" })
   */
  ext(
    level: LogLevel,
    msg: string,
    externalFields: Record<string, string>,
  ): void;
}

/** Configuration for the global logger. */
export interface LoggerConfig {
  /** Minimum severity to emit. */
  readonly level: LogLevel;
  /** Optional file writer for persistent logging. */
  readonly fileWriter?: FileWriter;
  /** Write to stderr. Default: true. */
  readonly console?: boolean;
}

/** Global logger state. */
let globalLevel: LogLevel = "INFO";
let globalFileWriter: FileWriter | undefined;
let globalConsole = true;
let initialized = false;

/**
 * Initialize the global logger. Call once at startup.
 *
 * Subsequent calls override the previous configuration.
 */
export function initLogger(config: LoggerConfig): void {
  globalLevel = config.level;
  globalFileWriter = config.fileWriter;
  globalConsole = config.console ?? true;
  initialized = true;
}

/**
 * Shut down the global logger — flush and close the file writer.
 *
 * Safe to call even if `initLogger()` was never called.
 */
export async function shutdownLogger(): Promise<void> {
  if (globalFileWriter) {
    await globalFileWriter.close();
    globalFileWriter = undefined;
  }
  initialized = false;
}

/** Render one structured arg with the secret-redaction backstop applied. */
function formatRedactedArg(arg: unknown): string {
  const redacted = redactSecretValue(arg);
  return typeof redacted === "string" ? redacted : JSON.stringify(redacted);
}

/** Format a log line with timestamp, level, and component. */
function formatLine(
  level: LogLevel,
  component: string,
  msg: string,
  args: unknown[],
): string {
  const ts = new Date().toISOString();
  const extra = args.length > 0
    ? " " + args.map(formatRedactedArg).join(" ")
    : "";
  return `[${ts}] [${level}] [${component}] ${msg}${extra}\n`;
}

/** Emit a single log line to stderr. */
function emitToConsole(line: string): void {
  Deno.stderr.writeSync(new TextEncoder().encode(line));
}

/** Fire-and-forget write to the file writer, logging failures to stderr. */
function emitToFileWriter(writer: FileWriter, line: string): void {
  writer.write(line).catch((err: unknown) => {
    emitToConsole(
      `[logger] File write failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  });
}

/** Dispatch a log line to configured outputs (stderr and/or file). */
function dispatchLogLine(
  level: LogLevel,
  component: string,
  msg: string,
  args: unknown[],
): void {
  if (!shouldLog(level, globalLevel)) return;
  const line = formatLine(level, component, msg, args);
  if (globalConsole) emitToConsole(line);
  if (globalFileWriter) emitToFileWriter(globalFileWriter, line);
}

/** Build a Logger object that delegates each severity to dispatchLogLine. */
function buildLoggerMethods(component: string): Logger {
  return {
    error(msg: string, ...args: unknown[]) {
      dispatchLogLine("ERROR", component, msg, args);
    },
    warn(msg: string, ...args: unknown[]) {
      dispatchLogLine("WARN", component, msg, args);
    },
    info(msg: string, ...args: unknown[]) {
      dispatchLogLine("INFO", component, msg, args);
    },
    debug(msg: string, ...args: unknown[]) {
      dispatchLogLine("DEBUG", component, msg, args);
    },
    trace(msg: string, ...args: unknown[]) {
      dispatchLogLine("TRACE", component, msg, args);
    },
    ext(level: LogLevel, msg: string, externalFields: Record<string, string>) {
      dispatchLogLine(
        level,
        component,
        formatTaggedEntry(msg, externalFields),
        [],
      );
    },
  };
}

/**
 * Create a component-scoped logger.
 *
 * The returned Logger reads the global configuration set by `initLogger()`.
 * If `initLogger()` was never called, defaults to stderr-only at INFO.
 */
export function createLogger(component: string): Logger {
  return buildLoggerMethods(component);
}

/** Check whether the global logger has been initialized. */
export function isLoggerInitialized(): boolean {
  return initialized;
}
