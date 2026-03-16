/**
 * Screen layout manager with ANSI scroll regions.
 *
 * Manages a terminal layout where output scrolls in the upper region
 * while the input prompt stays fixed at the bottom. Uses DECSTBM
 * escape sequences for scroll region control.
 *
 * Falls back to simple line-by-line output for non-TTY environments.
 *
 * Sub-modules:
 * - screen_tty.ts: Full TTY implementation with scroll regions
 *
 * @module
 */

import type { LineEditor } from "./terminal.ts";
import type { ClassificationLevel } from "../../core/types/classification.ts";
import { createTtyScreenManager } from "./screen_tty.ts";

// ─── ANSI color codes (exported for sub-modules) ─────────────────

export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const CYAN = "\x1b[36m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const RED = "\x1b[31m";
export const ORANGE = "\x1b[38;5;208m";

/** ANSI color code for a classification level. */
export function taintColor(level: ClassificationLevel): string {
  switch (level) {
    case "PUBLIC":
      return GREEN;
    case "INTERNAL":
      return YELLOW;
    case "CONFIDENTIAL":
      return ORANGE;
    case "RESTRICTED":
      return RED;
  }
}

// ─── Terminal I/O primitives (exported for sub-modules) ──────────

const enc = new TextEncoder();

/** Write raw text to stdout synchronously. */
export function rawWrite(text: string): void {
  Deno.stdout.writeSync(enc.encode(text));
}

// ─── Spinner frames and thinking messages ────────────────────────

export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

export const THINKING_VERBS: readonly string[] = [
  "Thinking",
  "Reasoning",
  "Considering",
  "Analyzing",
  "Pondering",
  "Evaluating",
  "Processing",
  "Synthesizing",
  "Reflecting",
  "Deliberating",
  "Formulating",
  "Examining",
  "Contemplating",
  "Computing",
  "Assembling",
];

// ─── Terminal dimensions ─────────────────────────────────────────

/** Terminal dimensions. */
export interface TermSize {
  columns: number;
  rows: number;
}

/** Get current terminal dimensions. */
export function retrieveTerminalSize(): TermSize {
  try {
    return Deno.consoleSize();
  } catch {
    return { columns: 80, rows: 24 };
  }
}

/** @deprecated Use retrieveTerminalSize instead */
export const getTermSize = retrieveTerminalSize;

// ─── Screen manager interface ────────────────────────────────────

/** Screen manager interface for managing terminal layout. */
export interface ScreenManager {
  /** Initialize scroll region and draw initial layout. */
  init(): void;
  /** Write a line of text into the scroll region (auto-scrolls). */
  writeOutput(text: string): void;
  /** Replace the last writeOutput content in-place (same-height only, else appends). */
  replaceLastOutput(text: string): void;
  /**
   * Write streaming text at the current scroll position without forced newline.
   * Handles embedded newlines by scrolling as needed.
   */
  writeChunk(text: string): void;
  /** Redraw the input line at the bottom with current editor state. */
  redrawInput(editor: LineEditor): void;
  /** Show a status message in the status bar. */
  setStatus(text: string): void;
  /** Clear status bar. */
  clearStatus(): void;
  /** Start an animated spinner in the status bar. */
  startSpinner(text: string): void;
  /** Stop the animated spinner and clear the status bar. */
  stopSpinner(): void;
  /** Set the current session taint level (updates separator colors). */
  setTaint(level: ClassificationLevel): void;
  /** Get the current session taint level. */
  getTaint(): ClassificationLevel;
  /**
   * Update the MCP server connection indicator in the bottom separator.
   * @param connected - Number of currently connected MCP servers
   * @param configured - Total number of configured (non-disabled) MCP servers
   */
  setMcpStatus(connected: number, configured: number): void;
  /** Handle terminal resize. */
  handleResize(): void;
  /**
   * Start polling for terminal resize changes.
   * Used as a fallback on platforms without SIGWINCH (e.g. Windows).
   * The callback is invoked whenever a size change is detected.
   */
  startResizePolling(onResize: () => void): void;
  /** Stop resize polling (called during cleanup). */
  stopResizePolling(): void;
  /** Restore terminal to normal mode. */
  cleanup(): void;
  /** Whether running in TTY mode (vs dumb/piped). */
  readonly isTty: boolean;
}

// ─── Factory ─────────────────────────────────────────────────────

/**
 * Create a screen manager.
 *
 * If stdin is a TTY, uses ANSI scroll regions to keep the input
 * prompt fixed at the bottom. Otherwise, falls back to simple
 * line-by-line output.
 *
 * @returns A ScreenManager instance
 */
export function createScreenManager(): ScreenManager {
  const isTty = Deno.stdin.isTerminal();

  if (!isTty) {
    return createDumbScreenManager();
  }

  return createTtyScreenManager();
}

// ─── Dumb screen manager (non-TTY fallback) ──────────────────────

/** Build the no-op methods shared by all dumb screen managers. */
function buildDumbScreenNoops(): Pick<
  ScreenManager,
  | "init"
  | "setTaint"
  | "setMcpStatus"
  | "setStatus"
  | "clearStatus"
  | "startSpinner"
  | "stopSpinner"
  | "handleResize"
  | "startResizePolling"
  | "stopResizePolling"
  | "cleanup"
> {
  const noop = (): void => {};
  return {
    init: noop,
    setTaint: noop,
    setMcpStatus: noop,
    setStatus: noop,
    clearStatus: noop,
    startSpinner: noop,
    stopSpinner: noop,
    handleResize: noop,
    startResizePolling: noop,
    stopResizePolling: noop,
    cleanup: noop,
  };
}

/** Create a dumb screen manager for non-TTY environments. */
function createDumbScreenManager(): ScreenManager {
  return {
    isTty: false,
    ...buildDumbScreenNoops(),
    writeOutput(text: string): void {
      console.log(text);
    },
    replaceLastOutput(text: string): void {
      console.log(text);
    },
    writeChunk(text: string): void {
      rawWrite(text);
    },
    redrawInput(_editor: LineEditor): void {
      rawWrite(" ❯ ");
    },
    getTaint(): ClassificationLevel {
      return "PUBLIC";
    },
  };
}
