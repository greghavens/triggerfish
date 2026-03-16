/**
 * Screen event handlers for tool call and result display.
 *
 * Handles tool_call and tool_result events with compact/expanded
 * display modes, edit_file diffs, todo lists, and plan exits.
 * @module
 */

import type { ScreenManager } from "../../terminal/screen.ts";
import {
  extractTodosFromEvent,
  formatTodoListAnsi,
} from "../../../tools/todo.ts";
import { DIM, RED, RESET, YELLOW } from "../render/ansi.ts";
import type { ToolDisplayMode } from "../render/ansi.ts";
import {
  formatEditFileDiff,
  formatPlanMarkdown,
  formatToolCallExpanded,
  formatToolCompact,
  formatToolCompactInProgress,
  formatToolResultExpanded,
  isPlanExitTool,
  isTodoTool,
} from "../render/tool_display.ts";
import type { ScreenHandlerState } from "./event_handler_state.ts";

// ─── edit_file helpers ───────────────────────────────────────────────────────

/** Check whether edit_file args contain old_text and new_text strings. */
function hasEditFileDiffArgs(args: Record<string, unknown>): boolean {
  return typeof args.old_text === "string" && typeof args.new_text === "string";
}

/** Truncate a tool result to a single summary line. */
function truncateResultLine(result: string): string {
  const first = result.split("\n")[0];
  return first.length > 80 ? first.slice(0, 80) + "\u2026" : first;
}

// ─── Tool event handlers ─────────────────────────────────────────────────────

/** Handle tool_call event. */
export function dispatchScreenToolCall(
  state: ScreenHandlerState,
  screen: ScreenManager,
  getDisplayMode: () => ToolDisplayMode,
  event: { name: string; args: Record<string, unknown> },
): void {
  state.pendingToolCall = { name: event.name, args: event.args };
  if (isTodoTool(event.name) || isPlanExitTool(event.name, event.args)) {
    // stored above — no display until result arrives
  } else if (getDisplayMode() === "compact") {
    screen.writeOutput(formatToolCompactInProgress(event.name, event.args));
  } else if (event.name !== "edit_file") {
    screen.writeOutput(formatToolCallExpanded(event.name, event.args));
  }
  if (screen.isTty) screen.startSpinner(event.name);
}

/** Handle tool_result for todo tools. */
function handleTodoToolResult(
  state: ScreenHandlerState,
  screen: ScreenManager,
  event: { name: string; result: string },
): void {
  const todos = extractTodosFromEvent(event.name, {
    args: state.pendingToolCall?.args,
    result: event.result,
  });
  state.pendingToolCall = null;
  if (todos) screen.writeOutput(formatTodoListAnsi(todos) + "\n");
}

/** Handle tool_result for plan_manage(exit) tool. */
function handlePlanExitToolResult(
  state: ScreenHandlerState,
  screen: ScreenManager,
  event: { result: string; blocked: boolean },
): void {
  state.pendingToolCall = null;
  if (!event.blocked) {
    screen.writeOutput(formatPlanMarkdown(event.result));
  } else {
    screen.writeOutput(
      `  ${YELLOW}\u26a1${RESET} plan_manage(exit)  ${RED}\u2717${RESET} ${DIM}blocked${RESET}`,
    );
  }
}

/** Handle tool_result event dispatch. */
export function dispatchScreenToolResult(
  state: ScreenHandlerState,
  screen: ScreenManager,
  getDisplayMode: () => ToolDisplayMode,
  event: { name: string; result: string; blocked: boolean },
): void {
  if (isTodoTool(event.name)) {
    handleTodoToolResult(state, screen, event);
  } else if (isPlanExitTool(event.name, state.pendingToolCall?.args)) {
    handlePlanExitToolResult(state, screen, event);
  } else if (
    state.pendingToolCall?.name === "edit_file" &&
    !event.blocked &&
    hasEditFileDiffArgs(state.pendingToolCall.args)
  ) {
    const diffDisplay = formatEditFileDiff(
      state.pendingToolCall.args.old_text as string,
      state.pendingToolCall.args.new_text as string,
      truncateResultLine(event.result),
    );
    if (getDisplayMode() === "compact") {
      // In-progress was 2 lines; diff is taller — replaceLastOutput falls back to append
      screen.replaceLastOutput(diffDisplay);
    } else {
      screen.writeOutput(diffDisplay);
    }
    state.pendingToolCall = null;
  } else if (getDisplayMode() === "compact" && state.pendingToolCall) {
    screen.replaceLastOutput(
      formatToolCompact(
        state.pendingToolCall.name,
        state.pendingToolCall.args,
        event.result,
        event.blocked,
      ),
    );
    state.pendingToolCall = null;
  } else {
    screen.writeOutput(formatToolResultExpanded(event.result, event.blocked));
  }
}

/** @deprecated Use dispatchScreenToolCall instead */
export const handleScreenToolCall = dispatchScreenToolCall;

/** @deprecated Use dispatchScreenToolResult instead */
export const handleScreenToolResult = dispatchScreenToolResult;
