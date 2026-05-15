/**
 * Shared types and queue logic for the CLI WebSocket message router.
 *
 * Contains the mutable state interfaces, dependency container, and
 * message queue drain function shared between the router and the
 * keypress loop.
 *
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";
import { createLogger } from "../../core/logger/logger.ts";
import type { Logger } from "../../core/logger/logger.ts";
import { formatError } from "../../cli/chat/chat_ui.ts";
import type { ScreenManager } from "../../cli/terminal/screen.ts";
import { taintColor } from "../../cli/terminal/screen.ts";
import type { LineEditor } from "../../cli/terminal/terminal.ts";
import type { OrchestratorEvent } from "../../agent/orchestrator/orchestrator_types.ts";

const log = createLogger("cli");

/** Password-mode state — active when the daemon sends a secret_prompt event. */
export interface PasswordModeState {
  readonly nonce: string;
  readonly name: string;
  readonly hint?: string;
  readonly chars: string[];
}

/** Trigger-prompt-mode state — active when the daemon sends a trigger_prompt event. */
export interface TriggerPromptModeState {
  readonly source: string;
  readonly classification: ClassificationLevel;
}

/** Credential-mode state — active when the daemon sends a credential_prompt event. */
export interface CredentialModeState {
  readonly nonce: string;
  readonly name: string;
  readonly hint?: string;
  readonly phase: "username" | "password";
  readonly username: string[];
  readonly password: string[];
}

/** Confirm-mode state — active when the daemon sends a confirm_prompt event. */
export interface ConfirmModeState {
  readonly nonce: string;
  readonly message: string;
}

/** Mutable refs shared between the WS router and the keypress loop. */
export interface WsRouterState {
  isProcessing: boolean;
  passwordMode: PasswordModeState | null;
  credentialMode: CredentialModeState | null;
  triggerPromptMode: TriggerPromptModeState | null;
  pendingTriggerPrompt: TriggerPromptModeState | null;
  confirmMode: ConfirmModeState | null;
  pendingNotifications: string[];
  providerName: string;
  workspacePath: string;
}

/**
 * Whether any interactive prompt is currently awaiting the user's response.
 *
 * Used to gate async writes (trigger notifications, etc.) that would
 * otherwise scroll the active prompt's context out of view.
 */
export function isPromptActive(state: WsRouterState): boolean {
  return state.confirmMode !== null ||
    state.passwordMode !== null ||
    state.credentialMode !== null ||
    state.triggerPromptMode !== null;
}

/**
 * Shared dependencies for TTY-mode keypress handlers.
 *
 * Bundles the recurring (ws, screen, state, log) parameters that nearly
 * every function in the CLI chat modules needs. Constructed once in
 * `runChat()` and threaded through the call tree.
 */
export interface ChatReplDeps {
  readonly ws: WebSocket;
  readonly screen: ScreenManager;
  readonly state: WsRouterState;
  readonly getEditor: () => LineEditor;
  readonly log: Logger;
}

/** Dependencies injected into the WebSocket message router. */
export interface WsRouterDeps {
  readonly screen: ScreenManager;
  readonly isTty: boolean;
  readonly getEditor: () => LineEditor;
  readonly eventHandler: (evt: OrchestratorEvent) => void;
  readonly state: WsRouterState;
  readonly messageQueue: string[];
  readonly ws: WebSocket;
  readonly resolveConnected: () => void;
}

/**
 * Send the next queued message over the WebSocket.
 *
 * Called after a response completes to drain any messages queued
 * while the previous turn was processing.
 */
export function sendNextQueuedMessage(deps: WsRouterDeps): void {
  const { messageQueue, screen, state, ws } = deps;
  if (messageQueue.length === 0) return;
  const next = messageQueue.shift()!;
  const editor = deps.getEditor();
  screen.writeOutput(
    `  ${taintColor(screen.getTaint())}\x1b[1m❯\x1b[0m ${next}`,
  );
  screen.writeOutput(`  \x1b[2m(queued)\x1b[0m`);
  screen.writeOutput("");
  state.isProcessing = true;
  try {
    ws.send(JSON.stringify({ type: "message", content: next }));
  } catch (err: unknown) {
    log.debug("WebSocket send failed: connection closed", { error: err });
    screen.writeOutput(formatError("Lost connection to daemon"));
    state.isProcessing = false;
    screen.redrawInput(editor);
  }
}
