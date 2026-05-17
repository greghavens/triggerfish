/**
 * Tests for trigger-notification queueing while a prompt is active.
 *
 * When the daemon broadcasts a `notification` event (e.g. a trigger
 * result) while the user is being asked to respond to a confirm,
 * secret, credential, or trigger prompt, the notification must be
 * queued — not written — so it does not scroll the prompt's context
 * out of view. Once the prompt is dismissed, the queue must drain.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  drainPendingNotifications,
  type RouterContext,
  routeNotificationEvent,
} from "../../../src/channels/cli/ws_route_status.ts";
import type {
  ConfirmModeState,
  CredentialModeState,
  PasswordModeState,
  TriggerPromptModeState,
  WsRouterState,
} from "../../../src/channels/cli/chat_ws_types.ts";
import type { ScreenManager } from "../../../src/cli/terminal/screen.ts";
import type { LineEditor } from "../../../src/cli/terminal/terminal.ts";

function createFakeScreen() {
  const output: string[] = [];
  const redraws = 0;
  return {
    output,
    redraws,
    isTty: true,
    writeOutput(text: string) {
      output.push(text);
    },
    redrawInput(_editor: unknown) {
      this.redraws++;
    },
    clearStatus() {},
    setStatus(_text: string) {},
    startSpinner(_text: string) {},
    stopSpinner() {},
    replaceLastOutput(_text: string) {},
    writeChunk(_text: string) {},
    init() {},
    cleanup() {},
    setMcpStatus(_c: number, _t: number) {},
    setTaint(_level: unknown) {},
    getTaint() {
      return "PUBLIC" as const;
    },
    handleResize() {},
    startResizePolling(_cb: () => void) {},
    stopResizePolling() {},
  };
}

function createState(): WsRouterState {
  return {
    isProcessing: false,
    passwordMode: null,
    credentialMode: null,
    triggerPromptMode: null,
    pendingTriggerPrompt: null,
    confirmMode: null,
    pendingNotifications: [],
    providerName: "test",
    workspacePath: "",
  };
}

function createCtx(
  screen: ReturnType<typeof createFakeScreen>,
  state: WsRouterState,
): RouterContext {
  const editor = { text: "", cursor: 0 } as unknown as LineEditor;
  return {
    screen: screen as unknown as ScreenManager,
    isTty: true,
    editor,
    eventHandler: () => {},
    state,
    deps: {
      screen: screen as unknown as ScreenManager,
      isTty: true,
      getEditor: () => editor,
      eventHandler: () => {},
      state,
      messageQueue: [],
      ws: {} as WebSocket,
      resolveConnected: () => {},
    },
  };
}

Deno.test("notification: writes immediately when no prompt is active", () => {
  const screen = createFakeScreen();
  const state = createState();
  const ctx = createCtx(screen, state);

  routeNotificationEvent(
    { type: "notification", message: "hello" },
    ctx,
  );

  assertEquals(state.pendingNotifications.length, 0);
  assertEquals(screen.output.length, 2);
  assertStringIncludes(screen.output[0], "hello");
});

const promptActivators: ReadonlyArray<{
  readonly name: string;
  readonly apply: (s: WsRouterState) => void;
}> = [
  {
    name: "confirm",
    apply: (s) => {
      s.confirmMode = {
        nonce: "n1",
        message: "restart?",
      } satisfies ConfirmModeState;
    },
  },
  {
    name: "secret",
    apply: (s) => {
      s.passwordMode = {
        nonce: "n2",
        name: "API_KEY",
        chars: [],
      } satisfies PasswordModeState;
    },
  },
  {
    name: "credential",
    apply: (s) => {
      s.credentialMode = {
        nonce: "n3",
        name: "smtp",
        phase: "username",
        username: [],
        password: [],
      } satisfies CredentialModeState;
    },
  },
  {
    name: "trigger",
    apply: (s) => {
      s.triggerPromptMode = {
        source: "cron",
        classification: "PUBLIC",
      } satisfies TriggerPromptModeState;
    },
  },
];

for (const activator of promptActivators) {
  Deno.test(`notification: queues when ${activator.name} prompt is active`, () => {
    const screen = createFakeScreen();
    const state = createState();
    activator.apply(state);
    const ctx = createCtx(screen, state);

    routeNotificationEvent(
      { type: "notification", message: "trigger fired" },
      ctx,
    );

    assertEquals(screen.output.length, 0);
    assertEquals(state.pendingNotifications, ["trigger fired"]);
  });
}

Deno.test("notification: multiple queued messages preserve order", () => {
  const screen = createFakeScreen();
  const state = createState();
  state.confirmMode = { nonce: "n", message: "restart?" };
  const ctx = createCtx(screen, state);

  routeNotificationEvent({ type: "notification", message: "first" }, ctx);
  routeNotificationEvent({ type: "notification", message: "second" }, ctx);
  routeNotificationEvent({ type: "notification", message: "third" }, ctx);

  assertEquals(state.pendingNotifications, ["first", "second", "third"]);
  assertEquals(screen.output.length, 0);
});

Deno.test("drainPendingNotifications: emits queued messages in order and clears queue", () => {
  const screen = createFakeScreen();
  const state = createState();
  state.pendingNotifications = ["first", "second"];
  const editor = { text: "", cursor: 0 } as unknown as LineEditor;

  drainPendingNotifications(
    state,
    screen as unknown as ScreenManager,
    editor,
  );

  assertEquals(state.pendingNotifications.length, 0);
  assertStringIncludes(screen.output[0], "first");
  assertStringIncludes(screen.output[2], "second");
});

Deno.test("drainPendingNotifications: no-op when queue is empty", () => {
  const screen = createFakeScreen();
  const state = createState();
  const editor = { text: "", cursor: 0 } as unknown as LineEditor;

  drainPendingNotifications(
    state,
    screen as unknown as ScreenManager,
    editor,
  );

  assertEquals(screen.output.length, 0);
});
