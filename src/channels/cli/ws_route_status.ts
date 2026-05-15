/**
 * WebSocket event handlers for connection status and notifications.
 *
 * Handles connected, taint_changed, mcp_status, notification, and
 * bumpers_status events from the daemon.
 * @module
 */

import { createLogger } from "../../core/logger/mod.ts";
import { renderPrompt } from "../../cli/chat/chat_ui.ts";
import type { ScreenManager } from "../../cli/terminal/screen.ts";
import type { LineEditor } from "../../cli/terminal/terminal.ts";
import type { OrchestratorEvent } from "../../agent/orchestrator/orchestrator_types.ts";
import type { ChatEvent } from "../../core/types/chat_event.ts";
import {
  isPromptActive,
  type WsRouterDeps,
  type WsRouterState,
} from "./chat_ws_types.ts";

const log = createLogger("cli-channel");

/** Resolved context passed to each per-event-type handler. */
export interface RouterContext {
  readonly screen: ScreenManager;
  readonly isTty: boolean;
  readonly editor: LineEditor;
  readonly eventHandler: (evt: OrchestratorEvent) => void;
  readonly state: WsRouterState;
  readonly deps: WsRouterDeps;
}

/** Handle the "connected" event from the daemon. */
export function routeConnectedEvent(
  evt: Extract<ChatEvent, { type: "connected" }>,
  ctx: RouterContext,
  resolveConnected: () => void,
): void {
  ctx.state.providerName = evt.provider;
  ctx.state.workspacePath = evt.workspace ?? "";
  if (evt.taint) {
    ctx.screen.setTaint(evt.taint);
  }
  resolveConnected();
}

/** Handle "taint_changed" event. */
export function routeTaintChangedEvent(
  evt: Extract<ChatEvent, { type: "taint_changed" }>,
  ctx: RouterContext,
): void {
  log.warn("Session taint changed", {
    operation: "routeTaintChangedEvent",
    level: evt.level,
  });
  ctx.screen.setTaint(evt.level);
  if (ctx.isTty) ctx.screen.redrawInput(ctx.editor);
}

/** Handle "mcp_status" event. */
export function routeMcpStatusEvent(
  evt: Extract<ChatEvent, { type: "mcp_status" }>,
  ctx: RouterContext,
): void {
  if (ctx.isTty) {
    ctx.screen.setMcpStatus(evt.connected, evt.configured);
    ctx.screen.redrawInput(ctx.editor);
  }
}

/** Render a trigger notification into the scroll region. */
function displayNotification(
  message: string,
  screen: ScreenManager,
  editor: LineEditor,
): void {
  screen.writeOutput(`  \x1b[33m\u26a1 [trigger]\x1b[0m ${message}`);
  screen.writeOutput("");
  screen.redrawInput(editor);
}

/** Handle "notification" event. */
export function routeNotificationEvent(
  evt: Extract<ChatEvent, { type: "notification" }>,
  ctx: RouterContext,
): void {
  if (ctx.isTty) {
    if (isPromptActive(ctx.state)) {
      ctx.state.pendingNotifications.push(evt.message);
      log.info("Trigger notification queued (prompt active)", {
        operation: "routeNotificationEvent",
        message: evt.message,
      });
      return;
    }
    displayNotification(evt.message, ctx.screen, ctx.editor);
  } else {
    log.info("Trigger notification received", {
      operation: "routeNotificationEvent",
      message: evt.message,
    });
    renderPrompt();
  }
}

/**
 * Drain queued trigger notifications after a prompt has been dismissed.
 *
 * Notifications are queued (rather than displayed) while a confirm,
 * secret, credential, or trigger prompt is active to keep the dialog's
 * context visible. Once the user resolves the prompt, this is called to
 * render any messages that arrived in the meantime.
 */
export function drainPendingNotifications(
  state: WsRouterState,
  screen: ScreenManager,
  editor: LineEditor,
): void {
  if (!screen.isTty) return;
  if (state.pendingNotifications.length === 0) return;
  const pending = state.pendingNotifications;
  state.pendingNotifications = [];
  log.debug("Draining queued notifications", {
    operation: "drainPendingNotifications",
    count: pending.length,
  });
  for (const message of pending) {
    displayNotification(message, screen, editor);
  }
}

/** Handle "bumpers_status" event. */
export function routeBumpersStatusEvent(
  evt: Extract<ChatEvent, { type: "bumpers_status" }>,
  ctx: RouterContext,
): void {
  const label = evt.enabled ? "Bumpers deployed." : "No bumpers deployed.";
  ctx.screen.writeOutput(`  ${label}`);
  if (ctx.isTty) ctx.screen.redrawInput(ctx.editor);
}

/** Handle "chat_history" event — render persisted messages in the terminal. */
export function routeChatHistoryEvent(
  evt: Extract<ChatEvent, { type: "chat_history" }>,
  ctx: RouterContext,
): void {
  if (evt.entries.length === 0) return;
  log.info("Chat history delivered to CLI terminal", {
    operation: "routeChatHistoryEvent",
    entryCount: evt.entries.length,
  });
  ctx.screen.writeOutput("  \x1b[2m── restored session history ──\x1b[0m");
  for (const entry of evt.entries) {
    if (entry.role === "user") {
      ctx.screen.writeOutput(`  \x1b[1m❯\x1b[0m ${entry.text}`);
    } else {
      ctx.screen.writeOutput(`  ${entry.text}`);
    }
  }
  ctx.screen.writeOutput("  \x1b[2m── end of history ──\x1b[0m");
  ctx.screen.writeOutput("");
  if (ctx.isTty) ctx.screen.redrawInput(ctx.editor);
}
