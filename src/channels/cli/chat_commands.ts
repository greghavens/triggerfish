/**
 * Slash command dispatch and text editing utilities for the CLI chat REPL.
 *
 * Handles slash commands (/quit, /exit, /clear, /help, /verbose, /compact),
 * input history navigation, autocomplete suggestions, and word deletion.
 *
 * @module
 */

import type { TriggerFishConfig } from "../../core/config.ts";
import type { ToolDisplayMode } from "../../cli/chat/chat_ui.ts";
import { formatBanner } from "../../cli/chat/chat_ui.ts";
import type { LineEditor } from "../../cli/terminal/terminal.ts";
import { createSuggestionEngine } from "../../cli/terminal/terminal.ts";
import type { ScreenManager } from "../../cli/terminal/screen.ts";
import type { ChatReplDeps } from "./chat_ws_types.ts";
import type { ChatReplState } from "./chat_input.ts";

/** Options for dispatching a slash command. */
export interface SlashCommandOpts {
  readonly config: TriggerFishConfig;
  readonly displayMode: ToolDisplayMode;
}

/** Result of dispatching a slash command. */
export interface SlashCommandResult {
  /** Whether the input was recognized as a slash command. */
  readonly handled: boolean;
  /** Whether the caller should exit the REPL. */
  readonly shouldExit: boolean;
  /** New display mode, if the command toggled it. */
  readonly newDisplayMode?: ToolDisplayMode;
}

/**
 * Dispatch a slash command entered by the user.
 *
 * Recognizes /quit, /exit, /q, /clear, /help, /verbose, and /compact.
 * Returns whether the command was handled and whether the REPL should exit.
 */
export function dispatchSlashCommand(
  text: string,
  deps: ChatReplDeps,
  opts: SlashCommandOpts,
): SlashCommandResult {
  if (text === "/quit" || text === "/exit" || text === "/q") {
    return { handled: true, shouldExit: true };
  }

  if (text === "/clear") {
    return handleClearCommand(deps, opts.config);
  }

  if (text === "/help") {
    return handleHelpCommand(deps.screen);
  }

  if (text === "/verbose") {
    const newMode: ToolDisplayMode = opts.displayMode === "compact"
      ? "expanded"
      : "compact";
    deps.screen.writeOutput("  Tool display: " + newMode);
    return { handled: true, shouldExit: false, newDisplayMode: newMode };
  }

  if (text === "/compact") {
    deps.screen.writeOutput("  Compacting conversation history...");
    deps.ws.send(JSON.stringify({ type: "compact" }));
    return { handled: true, shouldExit: false };
  }

  if (text === "/bumpers") {
    deps.ws.send(JSON.stringify({ type: "bumpers" }));
    return { handled: true, shouldExit: false };
  }

  return { handled: false, shouldExit: false };
}

/** Handle the /clear slash command. */
function handleClearCommand(
  deps: ChatReplDeps,
  config: TriggerFishConfig,
): SlashCommandResult {
  const { ws, screen, state } = deps;
  ws.send(JSON.stringify({ type: "clear" }));
  screen.setTaint("PUBLIC");
  screen.cleanup();
  screen.init();
  screen.writeOutput(
    formatBanner(
      state.providerName,
      config.models.primary.model,
      state.workspacePath,
    ),
  );
  screen.redrawInput(deps.getEditor());
  return { handled: true, shouldExit: false };
}

/** Handle the /help slash command. */
function handleHelpCommand(screen: ScreenManager): SlashCommandResult {
  screen.writeOutput(
    "  Commands:\n" +
      "    /quit, /exit, /q     \u2014 Exit chat\n" +
      "    /clear               \u2014 Clear screen\n" +
      "    /compact             \u2014 Summarize conversation history\n" +
      "    /bumpers             \u2014 Toggle taint escalation bumpers\n" +
      "    /verbose             \u2014 Toggle tool display detail\n" +
      "    /sentinel            — Toggle Sentinel mode\n" +
      "    /sentinel status     — Show the current chat mode\n" +
      "    /sentinel case ID    — Select a case in Sentinel mode\n" +
      "    /sentinel-agent TEXT — Ask an isolated Sentinel worker\n" +
      "    /help                \u2014 Show this help\n" +
      "    Ctrl+V               \u2014 Paste image from clipboard\n" +
      "    Ctrl+O               \u2014 Toggle tool display mode\n" +
      "    ESC                  \u2014 Interrupt current operation\n" +
      "    Shift+Enter          \u2014 New line in message\n" +
      "    Up/Down              \u2014 Navigate input history\n" +
      "    Tab                  \u2014 Accept suggestion",
  );
  return { handled: true, shouldExit: false };
}

/** Navigate input history upward (older entries). */
export function navigateHistoryUp(
  rs: ChatReplState,
  screen: ScreenManager,
): void {
  if (rs.inputHistory.index === -1 && rs.editor.text.length > 0) {
    rs.stashedInput = rs.editor.text;
  }
  rs.inputHistory = rs.inputHistory.up();
  const histText = rs.inputHistory.current();
  if (histText !== null) {
    rs.editor = rs.editor.setText(histText);
    rs.editor = rs.editor.setSuggestion("");
    screen.redrawInput(rs.editor);
  }
}

/** Navigate input history downward (newer entries or back to stashed). */
export function navigateHistoryDown(
  rs: ChatReplState,
  screen: ScreenManager,
): void {
  rs.inputHistory = rs.inputHistory.down();
  const histText = rs.inputHistory.current();
  if (histText !== null) {
    rs.editor = rs.editor.setText(histText);
  } else {
    rs.editor = rs.editor.setText(rs.stashedInput);
    rs.stashedInput = "";
  }
  rs.editor = rs.editor.setSuggestion("");
  screen.redrawInput(rs.editor);
}

/** Refresh the autocomplete suggestion based on current editor text. */
export function refreshAutocompleteSuggestion(
  rs: ChatReplState,
  suggestionEngine: ReturnType<typeof createSuggestionEngine>,
): void {
  const suggestion = suggestionEngine.suggest(
    rs.editor.text,
    rs.inputHistory.entries as string[],
  );
  if (suggestion) {
    const remainder = suggestion.slice(rs.editor.text.length);
    rs.editor = rs.editor.setSuggestion(remainder);
  } else {
    rs.editor = rs.editor.setSuggestion("");
  }
}

/**
 * Delete one word backward from the cursor position.
 *
 * Skips trailing spaces, then deletes back to the previous space boundary.
 */
export function deleteWordBackward(editor: LineEditor): LineEditor {
  const text = editor.text;
  let cursor = editor.cursor;
  while (cursor > 0 && text[cursor - 1] === " ") cursor--;
  while (cursor > 0 && text[cursor - 1] !== " ") cursor--;
  return editor.setText(
    text.slice(0, cursor) + text.slice(editor.cursor),
  );
}
