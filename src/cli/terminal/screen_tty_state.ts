/**
 * TTY screen manager internal state and helper functions.
 *
 * Defines the mutable state interface and low-level operations for
 * scroll regions, input bar drawing, output writing, spinner animation,
 * and terminal resize handling.
 *
 * @module
 */

import type { LineEditor } from "./terminal.ts";
import type { ClassificationLevel } from "../../core/types/classification.ts";
import { rawWrite, retrieveTerminalSize, THINKING_VERBS } from "./screen.ts";
import {
  CLEAR_LINE,
  configureScrollRegion,
  HIDE_CURSOR,
  moveTo,
  RESET_SCROLL,
  SHOW_CURSOR,
} from "./layout/ansi_escape.ts";
import {
  clearRowRange,
  clearStaleSeparatorRows,
  computeVisualRowLayout,
} from "./layout/visual_row_layout.ts";
import type { InputBarRenderOptions } from "./render/input_bar_render.ts";
import {
  computeInputBarLayout,
  renderInputBarFrame,
} from "./render/input_bar_render.ts";
import { renderSpinnerStatusText } from "./render/spinner_render.ts";
import {
  replaceInScrollRegion,
  writeLinesToScrollRegion,
  writeStreamingChunk,
} from "./render/scroll_output.ts";

/** Mutable state for the TTY screen manager. */
export interface TtyState {
  size: { rows: number; columns: number };
  statusText: string;
  inputLineCount: number;
  currentTaint: ClassificationLevel;
  spinnerTimer: ReturnType<typeof setInterval> | null;
  spinnerFrame: number;
  spinnerLabel: string;
  spinnerVerbIdx: number;
  resizePollTimer: ReturnType<typeof setInterval> | null;
  mcpConnected: number;
  mcpConfigured: number;
  knownCursorRow: number;
  knownCursorCol: number;
  streamCursorRow: number;
  streamCursorCol: number;
  lastOutputLineCount: number;
}

/** Create the initial TTY state. */
export function createTtyState(): TtyState {
  return {
    size: retrieveTerminalSize(),
    statusText: "",
    inputLineCount: 1,
    currentTaint: "PUBLIC",
    spinnerTimer: null,
    spinnerFrame: 0,
    spinnerLabel: "",
    spinnerVerbIdx: 0,
    resizePollTimer: null,
    mcpConnected: -1,
    mcpConfigured: 0,
    knownCursorRow: 1,
    knownCursorCol: 1,
    streamCursorRow: 0,
    streamCursorCol: 1,
    lastOutputLineCount: 0,
  };
}

/** Compute the bottom row of the scroll region. */
export function computeScrollBottom(s: TtyState): number {
  return s.size.rows - s.inputLineCount - 3;
}

/** Apply the DECSTBM scroll region based on current state. */
export function applyScrollRegion(s: TtyState): void {
  const bottom = computeScrollBottom(s);
  if (bottom >= 1) {
    rawWrite(configureScrollRegion(1, bottom));
  }
}

/** Adjust the input line count and update scroll region if changed. */
export function adjustInputLineCount(s: TtyState, newCount: number): void {
  if (newCount === s.inputLineCount) return;
  const oldCount = s.inputLineCount;
  s.inputLineCount = newCount;
  applyScrollRegion(s);
  if (newCount < oldCount) {
    clearStaleSeparatorRows(oldCount, newCount, s.size.rows);
  }
}

/** Draw the status bar at the bottom of the terminal. */
export function drawStatusBar(s: TtyState): void {
  rawWrite(HIDE_CURSOR);
  rawWrite(moveTo(s.size.rows, 1));
  rawWrite(CLEAR_LINE);
  if (s.statusText.length > 0) {
    rawWrite(` ${s.statusText}\x1b[0m`);
  }
  rawWrite(moveTo(s.knownCursorRow, s.knownCursorCol));
  rawWrite(SHOW_CURSOR);
}

/** Draw the input bar and update the known cursor position. */
export function drawInputBar(s: TtyState, editor: LineEditor): void {
  const lines = editor.text.split("\n");
  const prefixLen = 3;
  const layout = computeVisualRowLayout(lines, prefixLen, s.size.columns);
  adjustInputLineCount(s, Math.max(layout.total, 1));
  const bar = computeInputBarLayout(s.size.rows, s.inputLineCount);
  const opts: InputBarRenderOptions = {
    editor,
    lines,
    layout,
    bar,
    columns: s.size.columns,
    taint: s.currentTaint,
    mcpConnected: s.mcpConnected,
    mcpConfigured: s.mcpConfigured,
  };
  const cursor = renderInputBarFrame(opts, prefixLen);
  s.knownCursorRow = cursor.row;
  s.knownCursorCol = cursor.col;
}

/** Write complete output text into the scroll region. */
export function writeTtyOutput(s: TtyState, text: string): void {
  s.streamCursorRow = 0;
  s.streamCursorCol = 1;
  s.lastOutputLineCount = writeLinesToScrollRegion(
    text,
    computeScrollBottom(s),
    s.knownCursorRow,
    s.knownCursorCol,
  );
}

/** Replace the last writeOutput content in-place (same-height, else appends). */
export function replaceTtyOutput(s: TtyState, text: string): void {
  s.streamCursorRow = 0;
  s.streamCursorCol = 1;
  s.lastOutputLineCount = replaceInScrollRegion(
    text,
    s.lastOutputLineCount,
    computeScrollBottom(s),
    s.knownCursorRow,
    s.knownCursorCol,
  );
}

/** Write a streaming text chunk and track the stream cursor. */
export function writeTtyChunk(s: TtyState, text: string): void {
  const newPos = writeStreamingChunk({
    text,
    streamRow: s.streamCursorRow,
    streamCol: s.streamCursorCol,
    scrollBottom: computeScrollBottom(s),
    columns: s.size.columns,
    knownCursorRow: s.knownCursorRow,
    knownCursorCol: s.knownCursorCol,
  });
  if (newPos !== null) {
    s.streamCursorRow = newPos.row;
    s.streamCursorCol = newPos.col;
  }
}

/** Initialize the screen: reset size, scroll region, and clear input area. */
export function initializeScreen(s: TtyState): void {
  s.size = retrieveTerminalSize();
  s.inputLineCount = 1;
  applyScrollRegion(s);
  const topSepRow = s.size.rows - 1 - s.inputLineCount - 1;
  clearRowRange(topSepRow, s.size.rows);
  rawWrite(moveTo(1, 1));
}

/** Clear stale input area rows during a terminal resize. */
function clearResizeInputArea(s: TtyState, oldRows: number): void {
  const oldTopSep = oldRows - s.inputLineCount - 2;
  for (let r = oldTopSep; r <= oldRows; r++) {
    if (r >= 1 && r <= s.size.rows) {
      rawWrite(moveTo(r, 1));
      rawWrite(CLEAR_LINE);
    }
  }
  const newTopSep = s.size.rows - s.inputLineCount - 2;
  clearRowRange(newTopSep, s.size.rows);
}

/** Handle terminal resize: refresh size, clear areas, reset scroll region. */
export function resizeTerminalScreen(s: TtyState): void {
  const oldRows = s.size.rows;
  s.size = retrieveTerminalSize();
  s.streamCursorRow = 0;
  s.streamCursorCol = 1;
  clearResizeInputArea(s, oldRows);
  applyScrollRegion(s);
  drawStatusBar(s);
}

/** @deprecated Use resizeTerminalScreen instead */
export const handleTerminalResize = resizeTerminalScreen;

/** Advance spinner one frame, cycling the verb periodically. */
function advanceSpinnerFrame(s: TtyState): void {
  if (s.spinnerFrame > 0 && s.spinnerFrame % 30 === 0) {
    s.spinnerVerbIdx = (s.spinnerVerbIdx + 1) % THINKING_VERBS.length;
  }
  s.statusText = renderSpinnerStatusText(
    s.spinnerFrame,
    s.spinnerVerbIdx,
    s.spinnerLabel,
  );
  drawStatusBar(s);
  s.spinnerFrame++;
}

/** Start the animated spinner timer. */
export function startSpinnerTimer(s: TtyState, text: string): void {
  if (s.spinnerTimer !== null) {
    clearInterval(s.spinnerTimer);
  }
  s.spinnerLabel = text;
  s.spinnerFrame = 0;
  s.spinnerVerbIdx = Math.floor(Math.random() * THINKING_VERBS.length);
  const tick = () => advanceSpinnerFrame(s);
  tick();
  s.spinnerTimer = setInterval(tick, 80);
}

/** Stop the spinner and clear the status bar. */
export function stopSpinnerTimer(s: TtyState): void {
  if (s.spinnerTimer !== null) {
    clearInterval(s.spinnerTimer);
    s.spinnerTimer = null;
  }
  s.statusText = "";
  drawStatusBar(s);
}

/** Clear all timers and reset scroll region for exit. */
export function cleanupTtyState(s: TtyState): void {
  if (s.spinnerTimer !== null) {
    clearInterval(s.spinnerTimer);
    s.spinnerTimer = null;
  }
  if (s.resizePollTimer !== null) {
    clearInterval(s.resizePollTimer);
    s.resizePollTimer = null;
  }
  rawWrite(RESET_SCROLL);
  rawWrite(moveTo(s.size.rows, 1));
  rawWrite(SHOW_CURSOR);
  rawWrite("\n");
}
