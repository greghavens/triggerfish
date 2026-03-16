/**
 * Keypress routing and interrupt handling for the CLI chat REPL.
 *
 * Routes individual keypresses to the appropriate handler (editing,
 * history, clipboard, mode toggle, etc.) and manages interrupt signals
 * (ESC, Ctrl+C, SIGINT, SIGWINCH).
 *
 * @module
 */

import type { Logger } from "../../core/logger/logger.ts";
import type { TriggerFishConfig } from "../../core/config.ts";
import { createSuggestionEngine } from "../../cli/terminal/terminal.ts";
import type { ScreenManager } from "../../cli/terminal/screen.ts";
import type { ChatReplDeps } from "./chat_ws_types.ts";
import type { ChatReplState } from "./chat_input.ts";
import { applyClipboardPaste, respondToEnterKeypress } from "./chat_input.ts";
import {
  deleteWordBackward,
  navigateHistoryDown,
  navigateHistoryUp,
  refreshAutocompleteSuggestion,
} from "./chat_commands.ts";

/** Loop-level context for the keypress router. */
export interface KeypressLoopOpts {
  readonly config: TriggerFishConfig;
  readonly messageQueue: string[];
  readonly historyFilePath: string;
  readonly suggestionEngine: ReturnType<typeof createSuggestionEngine>;
  readonly cleanup: () => void;
}

/** Send a cancel message to the daemon WebSocket. */
export function sendCancelMessage(ws: WebSocket, log: Logger): void {
  try {
    ws.send(JSON.stringify({ type: "cancel" }));
  } catch (err: unknown) {
    log.debug("WebSocket cancel message send failed", { err });
  }
}

/** Handle the ESC key during active processing (interrupt). */
export function respondToEscInterrupt(
  ws: WebSocket,
  screen: ScreenManager,
  log: Logger,
): void {
  sendCancelMessage(ws, log);
  screen.writeOutput("  \x1b[33m\u26a0 Interrupted\x1b[0m");
}

/** Handle Ctrl+C: cancel or exit depending on processing state. */
export function respondToCtrlCKeypress(
  rs: ChatReplState,
  deps: ChatReplDeps,
  cleanup: () => void,
): "exit" | "continue" {
  rs.isPasting = false;
  if (!deps.state.isProcessing) {
    cleanup();
    return "exit";
  }
  const now = Date.now();
  if (now - rs.lastCtrlCTime < 1000) {
    cleanup();
    return "exit";
  }
  rs.lastCtrlCTime = now;
  sendCancelMessage(deps.ws, deps.log);
  deps.screen.writeOutput(
    "  \x1b[33m\u26a0 Interrupted (Ctrl+C again to exit)\x1b[0m",
  );
  return "continue";
}

/** @deprecated Use respondToEscInterrupt instead */
export const handleEscInterrupt = respondToEscInterrupt;

/** @deprecated Use respondToCtrlCKeypress instead */
export const handleCtrlCKeypress = respondToCtrlCKeypress;

/** Install SIGINT and SIGWINCH signal handlers for TTY mode. */
export function installChatSignalHandlers(
  deps: ChatReplDeps,
  cleanup: () => void,
): void {
  installSigintHandler(deps, cleanup);
  installSigwinchHandler(deps);
}

/** Install a SIGINT handler that cancels or exits. */
function installSigintHandler(
  deps: ChatReplDeps,
  cleanup: () => void,
): void {
  const { state, ws, screen, log } = deps;
  try {
    Deno.addSignalListener("SIGINT", () => {
      if (state.isProcessing) {
        sendCancelMessage(ws, log);
        screen.writeOutput("  \x1b[33m\u26a0 Interrupted\x1b[0m");
      } else {
        cleanup();
        Deno.exit(0);
      }
    });
  } catch (_err: unknown) {
    log.debug("Signal listener not supported", { signal: "SIGINT" });
  }
}

/** Install a SIGWINCH handler for terminal resize. */
function installSigwinchHandler(deps: ChatReplDeps): void {
  const { screen, log } = deps;
  const resizeHandler = () => {
    screen.handleResize();
    screen.redrawInput(deps.getEditor());
  };
  try {
    Deno.addSignalListener("SIGWINCH", resizeHandler);
  } catch (_err: unknown) {
    log.debug("Signal listener not supported", { signal: "SIGWINCH" });
    screen.startResizePolling(resizeHandler);
  }
}

/**
 * Route an input keypress to the appropriate handler.
 *
 * Returns "exit" to leave the loop, or void to continue.
 */
export async function routeInputKeypress(
  keypress: { readonly key: string; readonly char: string | null },
  rs: ChatReplState,
  deps: ChatReplDeps,
  loopOpts: KeypressLoopOpts,
): Promise<"exit" | void> {
  const { key, char } = keypress;
  switch (key) {
    case "paste_start":
      rs.isPasting = true;
      break;

    case "paste_end":
      rs.isPasting = false;
      deps.screen.redrawInput(rs.editor);
      break;

    case "shift+enter":
      handleShiftEnter(rs, deps.screen);
      break;

    case "enter": {
      if (rs.isPasting) {
        handleShiftEnter(rs, deps.screen);
        break;
      }
      const result = respondToEnterKeypress(rs, deps, {
        config: loopOpts.config,
        messageQueue: loopOpts.messageQueue,
        historyFilePath: loopOpts.historyFilePath,
      });
      if (result.shouldExit) {
        loopOpts.cleanup();
        return "exit";
      }
      break;
    }

    case "backspace":
      rs.editor = rs.editor.backspace();
      refreshAutocompleteSuggestion(rs, loopOpts.suggestionEngine);
      deps.screen.redrawInput(rs.editor);
      break;

    case "delete":
      rs.editor = rs.editor.deleteChar();
      refreshAutocompleteSuggestion(rs, loopOpts.suggestionEngine);
      deps.screen.redrawInput(rs.editor);
      break;

    case "left":
    case "right":
    case "home":
    case "end":
    case "ctrl+a":
    case "ctrl+e":
      handleCursorMovement(key, rs, deps.screen);
      break;

    case "up":
      navigateHistoryUp(rs, deps.screen);
      break;

    case "down":
      navigateHistoryDown(rs, deps.screen);
      break;

    case "tab":
      rs.editor = rs.editor.acceptSuggestion();
      deps.screen.redrawInput(rs.editor);
      break;

    case "ctrl+v":
      rs.pendingImages = await applyClipboardPaste(
        rs.pendingImages,
        deps.screen,
        deps.log,
      );
      break;

    case "ctrl+o":
      toggleDisplayMode(rs, deps.screen);
      break;

    case "ctrl+d":
      if (rs.editor.text.length === 0) {
        loopOpts.cleanup();
        return "exit";
      }
      break;

    case "ctrl+u":
      rs.editor = rs.editor.clear();
      deps.screen.redrawInput(rs.editor);
      break;

    case "ctrl+w":
      rs.editor = deleteWordBackward(rs.editor);
      deps.screen.redrawInput(rs.editor);
      break;

    case "esc":
      rs.isPasting = false;
      break;

    default:
      if (char !== null) {
        handlePrintableChar(rs, char, deps.screen, loopOpts.suggestionEngine);
      }
      break;
  }
}

/** Handle shift+enter: insert a newline. */
function handleShiftEnter(
  rs: ChatReplState,
  screen: ScreenManager,
): void {
  rs.editor = rs.editor.insert("\n");
  rs.editor = rs.editor.setSuggestion("");
  screen.redrawInput(rs.editor);
}

/** Handle cursor movement keys. */
function handleCursorMovement(
  key: string,
  rs: ChatReplState,
  screen: ScreenManager,
): void {
  const directionMap: Record<string, string> = {
    "left": "left",
    "right": "right",
    "home": "home",
    "end": "end",
    "ctrl+a": "home",
    "ctrl+e": "end",
  };
  const direction = directionMap[key];
  if (direction) {
    rs.editor = rs.editor.moveCursor(
      direction as "left" | "right" | "home" | "end",
    );
    screen.redrawInput(rs.editor);
  }
}

/** Toggle the tool display mode between compact and expanded. */
function toggleDisplayMode(
  rs: ChatReplState,
  screen: ScreenManager,
): void {
  rs.displayMode = rs.displayMode === "compact" ? "expanded" : "compact";
  screen.setStatus("Display: " + rs.displayMode);
  setTimeout(() => screen.clearStatus(), 1500);
}

/** Handle a printable character insertion. */
function handlePrintableChar(
  rs: ChatReplState,
  char: string,
  screen: ScreenManager,
  suggestionEngine: ReturnType<typeof createSuggestionEngine>,
): void {
  rs.editor = rs.editor.insert(char);
  rs.inputHistory = rs.inputHistory.resetNavigation();
  rs.stashedInput = "";
  refreshAutocompleteSuggestion(rs, suggestionEngine);
  screen.redrawInput(rs.editor);
}
