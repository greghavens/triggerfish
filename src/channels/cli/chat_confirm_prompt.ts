/**
 * Confirm prompt keypress handling for the CLI chat REPL.
 *
 * Routes keypresses while the terminal is in confirm-prompt mode
 * (confirm_prompt event), handling Y/Enter (approve) and N/Esc (deny).
 *
 * @module
 */

import type { ChatReplDeps, ConfirmModeState } from "./chat_ws_types.ts";
import { drainPendingNotifications } from "./ws_route_status.ts";

/**
 * Route a keypress while confirm-prompt mode is active.
 *
 * Handles Y/Enter (approve), N/Esc (deny). All other keys are ignored.
 */
export function routeConfirmPromptKeypress(
  keypress: { readonly key: string; readonly char: string | null },
  pm: ConfirmModeState,
  deps: ChatReplDeps,
): void {
  const isYKey = keypress.key === "y" ||
    (keypress.char !== null && keypress.char.toLowerCase() === "y");

  if (isYKey || keypress.key === "enter") {
    approveConfirmPrompt(pm, deps);
    return;
  }
  const isN = keypress.key === "n" ||
    (keypress.char !== null && keypress.char.toLowerCase() === "n");

  if (isN || keypress.key === "esc") {
    denyConfirmPrompt(pm, deps);
    return;
  }
}

/** Approve the confirm prompt and notify the daemon. */
function approveConfirmPrompt(
  pm: ConfirmModeState,
  deps: ChatReplDeps,
): void {
  const { ws, screen, state, log } = deps;
  try {
    ws.send(JSON.stringify({
      type: "confirm_prompt_response",
      nonce: pm.nonce,
      approved: true,
    }));
    log.debug("Confirm prompt approved", {
      operation: "approveConfirmPrompt",
      nonce: pm.nonce,
    });
  } catch (err: unknown) {
    log.debug("WebSocket confirm prompt send failed", {
      operation: "approveConfirmPrompt",
      err,
    });
  }
  screen.clearStatus();
  state.confirmMode = null;
  state.isProcessing = true;
  screen.startSpinner("Restarting...");
  screen.redrawInput(deps.getEditor());
  drainPendingNotifications(state, screen, deps.getEditor());
}

/** Deny the confirm prompt and notify the daemon. */
function denyConfirmPrompt(
  pm: ConfirmModeState,
  deps: ChatReplDeps,
): void {
  const { ws, screen, state, log } = deps;
  try {
    ws.send(JSON.stringify({
      type: "confirm_prompt_response",
      nonce: pm.nonce,
      approved: false,
    }));
    log.debug("Confirm prompt denied", {
      operation: "denyConfirmPrompt",
      nonce: pm.nonce,
    });
  } catch (err: unknown) {
    log.debug("WebSocket confirm deny send failed", {
      operation: "denyConfirmPrompt",
      err,
    });
  }
  screen.writeOutput("  \x1b[2mAction denied\x1b[0m");
  screen.clearStatus();
  state.confirmMode = null;
  screen.redrawInput(deps.getEditor());
  drainPendingNotifications(state, screen, deps.getEditor());
}
