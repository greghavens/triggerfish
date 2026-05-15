/**
 * Password/secret prompt keypress handling for the CLI chat REPL.
 *
 * Routes keypresses while the terminal is in password mode (secret_prompt),
 * handling enter (submit), esc/ctrl+c (cancel), backspace, and printable
 * character input.
 *
 * @module
 */

import type { ScreenManager } from "../../cli/terminal/screen.ts";
import type {
  ChatReplDeps,
  CredentialModeState,
  PasswordModeState,
  WsRouterState,
} from "./chat_ws_types.ts";
import { drainPendingNotifications } from "./ws_route_status.ts";

/**
 * Route a keypress while password mode (secret_prompt) is active.
 *
 * Handles enter (submit), esc/ctrl+c (cancel), backspace, and
 * printable character input. Mutates `pm.chars` and `state.passwordMode`
 * as side effects.
 */
export function routePasswordKeypress(
  keypress: { readonly key: string; readonly char: string | null },
  pm: PasswordModeState,
  deps: ChatReplDeps,
): void {
  if (keypress.key === "enter") {
    submitPasswordValue(pm, deps);
    return;
  }
  if (keypress.key === "esc" || keypress.key === "ctrl+c") {
    cancelPasswordEntry(pm, deps);
    return;
  }
  if (keypress.key === "backspace") {
    deletePasswordChar(pm, deps.screen);
    return;
  }
  if (keypress.char !== null) {
    appendPasswordChar(pm, keypress.char, deps.screen);
  }
}

/** Submit the accumulated password value via WebSocket. */
function submitPasswordValue(
  pm: PasswordModeState,
  deps: ChatReplDeps,
): void {
  const { ws, screen, state, log } = deps;
  const value = pm.chars.join("");
  try {
    ws.send(JSON.stringify({
      type: "secret_prompt_response",
      nonce: pm.nonce,
      value,
    }));
    log.debug("Secret prompt value submitted", {
      operation: "submitPasswordValue",
      nonce: pm.nonce,
    });
  } catch (err: unknown) {
    log.debug("WebSocket secret send failed", {
      operation: "submitPasswordValue",
      err,
    });
  }
  screen.writeOutput("  \x1b[32m\u2713 Secret submitted\x1b[0m");
  screen.clearStatus();
  state.passwordMode = null;
  screen.redrawInput(deps.getEditor());
  drainPendingNotifications(state, screen, deps.getEditor());
}

/** Cancel the password entry and notify the daemon. */
function cancelPasswordEntry(
  pm: PasswordModeState,
  deps: ChatReplDeps,
): void {
  const { ws, screen, state, log } = deps;
  try {
    ws.send(JSON.stringify({
      type: "secret_prompt_response",
      nonce: pm.nonce,
      value: null,
    }));
    log.debug("Secret prompt entry cancelled", {
      operation: "cancelPasswordEntry",
      nonce: pm.nonce,
    });
  } catch (err: unknown) {
    log.debug("WebSocket secret cancel send failed", {
      operation: "cancelPasswordEntry",
      err,
    });
  }
  screen.writeOutput("  \x1b[33m\u2717 Secret entry cancelled\x1b[0m");
  screen.clearStatus();
  state.passwordMode = null;
  screen.redrawInput(deps.getEditor());
  drainPendingNotifications(state, screen, deps.getEditor());
}

/** Delete the last character from the password buffer. */
function deletePasswordChar(
  pm: PasswordModeState,
  screen: ScreenManager,
): void {
  if (pm.chars.length > 0) {
    pm.chars.pop();
    const masked = "\u25cf".repeat(pm.chars.length);
    screen.setStatus("\u{1f512} " + pm.name + ": " + masked);
  }
}

/** Append a printable character to the password buffer. */
function appendPasswordChar(
  pm: PasswordModeState,
  char: string,
  screen: ScreenManager,
): void {
  pm.chars.push(char);
  const masked = "\u25cf".repeat(pm.chars.length);
  screen.setStatus("\u{1f512} " + pm.name + ": " + masked);
}

// ─── Credential mode keypress handling ──────────────────────────

/**
 * Route a keypress while credential mode (credential_prompt) is active.
 *
 * In the username phase, characters are shown (not masked).
 * In the password phase, characters are masked with bullets.
 * Enter advances from username to password, or submits from password.
 * Esc/Ctrl+C cancels the entire flow.
 */
export function routeCredentialKeypress(
  keypress: { readonly key: string; readonly char: string | null },
  cm: CredentialModeState,
  deps: ChatReplDeps,
): void {
  if (keypress.key === "esc" || keypress.key === "ctrl+c") {
    cancelCredentialEntry(cm, deps);
    return;
  }

  if (cm.phase === "username") {
    routeCredentialUsernameKeypress(keypress, cm, deps);
  } else {
    routeCredentialPasswordKeypress(keypress, cm, deps);
  }
}

/** Route keypresses during the username phase. */
function routeCredentialUsernameKeypress(
  keypress: { readonly key: string; readonly char: string | null },
  cm: CredentialModeState,
  deps: ChatReplDeps,
): void {
  if (keypress.key === "enter") {
    advanceToPasswordPhase(cm, deps.state, deps.screen);
    return;
  }
  if (keypress.key === "backspace") {
    if (cm.username.length > 0) {
      cm.username.pop();
      deps.screen.setStatus(
        "\u{1f512} " + cm.name + " username: " + cm.username.join(""),
      );
    }
    return;
  }
  if (keypress.char !== null) {
    cm.username.push(keypress.char);
    deps.screen.setStatus(
      "\u{1f512} " + cm.name + " username: " + cm.username.join(""),
    );
  }
}

/** Advance from the username phase to the password phase. */
function advanceToPasswordPhase(
  cm: CredentialModeState,
  state: WsRouterState,
  screen: ScreenManager,
): void {
  // Mutate phase to password — CredentialModeState.phase is typed as
  // a union but the object is mutable via the WsRouterState holder.
  (cm as { phase: string }).phase = "password";
  state.credentialMode = cm;
  screen.setStatus(
    "\u{1f512} Type password, Enter to submit, Esc to cancel",
  );
}

/** Route keypresses during the password phase. */
function routeCredentialPasswordKeypress(
  keypress: { readonly key: string; readonly char: string | null },
  cm: CredentialModeState,
  deps: ChatReplDeps,
): void {
  if (keypress.key === "enter") {
    submitCredentialValue(cm, deps);
    return;
  }
  if (keypress.key === "backspace") {
    if (cm.password.length > 0) {
      cm.password.pop();
      const masked = "\u25cf".repeat(cm.password.length);
      deps.screen.setStatus("\u{1f512} " + cm.name + " password: " + masked);
    }
    return;
  }
  if (keypress.char !== null) {
    cm.password.push(keypress.char);
    const masked = "\u25cf".repeat(cm.password.length);
    deps.screen.setStatus("\u{1f512} " + cm.name + " password: " + masked);
  }
}

/** Submit the accumulated credential (username + password) via WebSocket. */
function submitCredentialValue(
  cm: CredentialModeState,
  deps: ChatReplDeps,
): void {
  const { ws, screen, state, log } = deps;
  const username = cm.username.join("");
  const password = cm.password.join("");
  try {
    ws.send(JSON.stringify({
      type: "credential_prompt_response",
      nonce: cm.nonce,
      username,
      password,
    }));
    log.debug("Credential prompt value submitted", {
      operation: "submitCredentialValue",
      nonce: cm.nonce,
    });
  } catch (err: unknown) {
    log.debug("WebSocket credential send failed", {
      operation: "submitCredentialValue",
      err,
    });
  }
  screen.writeOutput("  \x1b[32m\u2713 Credential submitted\x1b[0m");
  screen.clearStatus();
  state.credentialMode = null;
  screen.redrawInput(deps.getEditor());
  drainPendingNotifications(state, screen, deps.getEditor());
}

/** Cancel the credential entry and notify the daemon. */
function cancelCredentialEntry(
  cm: CredentialModeState,
  deps: ChatReplDeps,
): void {
  const { ws, screen, state, log } = deps;
  try {
    ws.send(JSON.stringify({
      type: "credential_prompt_response",
      nonce: cm.nonce,
      username: null,
      password: null,
    }));
    log.debug("Credential prompt entry cancelled", {
      operation: "cancelCredentialEntry",
      nonce: cm.nonce,
    });
  } catch (err: unknown) {
    log.debug("WebSocket credential cancel send failed", {
      operation: "cancelCredentialEntry",
      err,
    });
  }
  screen.writeOutput("  \x1b[33m\u2717 Credential entry cancelled\x1b[0m");
  screen.clearStatus();
  state.credentialMode = null;
  screen.redrawInput(deps.getEditor());
  drainPendingNotifications(state, screen, deps.getEditor());
}
