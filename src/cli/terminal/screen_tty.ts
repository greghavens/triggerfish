/**
 * TTY-aware screen manager factory.
 *
 * Assembles the ScreenManager interface from TTY state helpers,
 * wiring scroll regions, input bar, spinner, and resize polling
 * into a single implementation.
 *
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";
import type { ScreenManager } from "./screen.ts";
import { DIM, retrieveTerminalSize } from "./screen.ts";
import {
  cleanupTtyState,
  createTtyState,
  drawInputBar,
  drawStatusBar,
  initializeScreen,
  replaceTtyOutput,
  resizeTerminalScreen,
  startSpinnerTimer,
  stopSpinnerTimer,
  writeTtyChunk,
  writeTtyOutput,
} from "./screen_tty_state.ts";

/** Create a TTY-aware screen manager with scroll regions. */
export function createTtyScreenManager(): ScreenManager {
  const s = createTtyState();

  return {
    isTty: true,
    init: () => initializeScreen(s),
    writeOutput: (text: string) => writeTtyOutput(s, text),
    replaceLastOutput: (text: string) => replaceTtyOutput(s, text),
    writeChunk: (text: string) => writeTtyChunk(s, text),
    redrawInput: (editor) => drawInputBar(s, editor),
    setTaint: (level: ClassificationLevel) => {
      s.currentTaint = level;
    },
    getTaint: () => s.currentTaint,
    setMcpStatus: (connected: number, configured: number) => {
      s.mcpConnected = connected;
      s.mcpConfigured = configured;
    },
    setStatus: (text: string) => {
      s.statusText = `${DIM}${text}`;
      drawStatusBar(s);
    },
    clearStatus: () => {
      s.statusText = "";
      drawStatusBar(s);
    },
    startSpinner: (text: string) => startSpinnerTimer(s, text),
    stopSpinner: () => stopSpinnerTimer(s),
    handleResize: () => resizeTerminalScreen(s),
    startResizePolling: (onResize: () => void) => {
      if (s.resizePollTimer !== null) return;
      s.resizePollTimer = setInterval(() => {
        const newSize = retrieveTerminalSize();
        if (
          newSize.columns !== s.size.columns ||
          newSize.rows !== s.size.rows
        ) {
          onResize();
        }
      }, 300);
    },
    stopResizePolling: () => {
      if (s.resizePollTimer !== null) {
        clearInterval(s.resizePollTimer);
        s.resizePollTimer = null;
      }
    },
    cleanup: () => cleanupTtyState(s),
  };
}
