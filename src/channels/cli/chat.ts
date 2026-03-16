/**
 * Interactive chat REPL for the CLI channel.
 *
 * Connects to the gateway WebSocket and provides a full terminal UI
 * (TTY mode with scroll regions, raw keypress handling, history, suggestions)
 * and a simple line-buffered fallback for piped/non-TTY input.
 *
 * Sub-modules:
 * - chat_connection.ts: Config loading and daemon WebSocket setup
 * - chat_ws_router.ts: WebSocket message routing
 * - chat_simple_repl.ts: Non-TTY fallback REPL
 * - chat_password.ts: Password/secret prompt handling
 * - chat_commands.ts: Slash command dispatch and text editing
 * - chat_input.ts: Message submission and enter key dispatch
 * - chat_keypress.ts: Keypress routing and interrupt handling
 *
 * @module
 */

import { join } from "@std/path";
import { createLogger } from "../../core/logger/logger.ts";
import type { TriggerFishConfig } from "../../core/config.ts";
import {
  createEventHandler,
  createScreenEventHandler,
  formatBanner,
  printBanner,
} from "../../cli/chat/chat_ui.ts";
import {
  createKeypressReader,
  createLineEditor,
  createSuggestionEngine,
} from "../../cli/terminal/terminal.ts";
import { loadInputHistory, saveInputHistory } from "../../cli/chat/history.ts";
import { createScreenManager } from "../../cli/terminal/screen.ts";
import type { OrchestratorEvent } from "../../agent/orchestrator/orchestrator_types.ts";
import type { ChatReplDeps, WsRouterState } from "./chat_ws_types.ts";
import {
  awaitDaemonConnection,
  loadChatConfig,
  openChatWebSocket,
} from "./chat_connection.ts";
import { startWebSocketRepl } from "./chat_simple_repl.ts";
import {
  routeCredentialKeypress,
  routePasswordKeypress,
} from "./chat_password.ts";
import { routeTriggerPromptKeypress } from "./chat_trigger_prompt.ts";
import {
  respondToCtrlCKeypress,
  respondToEscInterrupt,
} from "./chat_keypress.ts";
import {
  installChatSignalHandlers,
  routeInputKeypress,
} from "./chat_keypress.ts";
import type { ChatReplState } from "./chat_input.ts";

// Re-export for external importers
export { runSimpleWsRepl, startWebSocketRepl } from "./chat_simple_repl.ts";

/**
 * Run an interactive chat REPL.
 *
 * Connects to the daemon's gateway WebSocket at /chat for the shared
 * session. All terminal UI (raw mode, scroll regions, keypress reader,
 * input history, suggestions, ESC interrupt, Ctrl+O toggle) is preserved.
 * The daemon owns the session, orchestrator, and policy engine.
 */
export async function startChatSession(): Promise<void> {
  const log = createLogger("cli");
  const { config, dataDir } = await loadChatConfig();
  const ws = openChatWebSocket(log);

  const isTty = Deno.stdin.isTerminal();
  const screen = createScreenManager();
  const state: WsRouterState = {
    isProcessing: false,
    passwordMode: null,
    credentialMode: null,
    triggerPromptMode: null,
    pendingTriggerPrompt: null,
    providerName: "unknown",
    workspacePath: "",
  };
  const messageQueue: string[] = [];

  const rs: ChatReplState = {
    editor: createLineEditor(),
    displayMode: "compact",
    stashedInput: "",
    pendingImages: [],
    lastCtrlCTime: 0,
    isPasting: false,
    inputHistory: await loadInputHistory(join(dataDir, "input_history.json")),
  };

  const eventHandler = isTty
    ? createScreenEventHandler(screen, () => rs.displayMode)
    : createEventHandler();

  await awaitDaemonConnection({
    screen,
    isTty,
    getEditor: () => rs.editor,
    eventHandler: eventHandler as (evt: OrchestratorEvent) => void,
    state,
    messageQueue,
    ws,
  });

  if (!isTty) {
    printBanner(
      state.providerName,
      config.models.primary.model,
      state.workspacePath,
    );
    await startWebSocketRepl(ws, {
      providerName: state.providerName,
      config,
      workspace: state.workspacePath,
    });
    return;
  }

  const deps: ChatReplDeps = {
    ws,
    screen,
    state,
    getEditor: () => rs.editor,
    log,
  };

  await runTtyKeypressLoop(rs, deps, {
    config,
    messageQueue,
    dataDir,
  });
}

/** Options for the TTY keypress loop. */
interface TtyLoopOpts {
  readonly config: TriggerFishConfig;
  readonly messageQueue: string[];
  readonly dataDir: string;
}

/** Run the TTY keypress loop until the user exits or EOF. */
async function runTtyKeypressLoop(
  rs: ChatReplState,
  deps: ChatReplDeps,
  opts: TtyLoopOpts,
): Promise<void> {
  const historyFilePath = join(opts.dataDir, "input_history.json");
  const suggestionEngine = createSuggestionEngine();
  const keypressReader = createKeypressReader();

  deps.screen.init();
  deps.screen.writeOutput(
    formatBanner(
      deps.state.providerName,
      opts.config.models.primary.model,
      deps.state.workspacePath,
    ),
  );

  const cleanup = () =>
    cleanupChatRepl(keypressReader, deps, historyFilePath, rs.inputHistory);

  installChatSignalHandlers(deps, cleanup);

  deps.screen.redrawInput(rs.editor);
  keypressReader.start();

  const loopOpts = {
    config: opts.config,
    messageQueue: opts.messageQueue,
    historyFilePath,
    suggestionEngine,
    cleanup,
  };

  for await (const keypress of keypressReader) {
    const action = routeTopLevelKeypress(keypress, rs, deps, cleanup);
    if (action === "exit") return;
    if (action === "continue") continue;

    const result = await routeInputKeypress(keypress, rs, deps, loopOpts);
    if (result === "exit") return;
  }

  cleanup();
}

/** Route top-level keypresses (interrupts, password mode) before input dispatch. */
function routeTopLevelKeypress(
  keypress: { readonly key: string; readonly char: string | null },
  rs: ChatReplState,
  deps: ChatReplDeps,
  cleanup: () => void,
): "exit" | "continue" | "dispatch" {
  if (keypress.key === "esc" && deps.state.isProcessing) {
    respondToEscInterrupt(deps.ws, deps.screen, deps.log);
    return "continue";
  }
  if (keypress.key === "ctrl+c") {
    return respondToCtrlCKeypress(rs, deps, cleanup);
  }
  if (deps.state.passwordMode !== null) {
    routePasswordKeypress(keypress, deps.state.passwordMode, deps);
    return "continue";
  }
  if (deps.state.credentialMode !== null) {
    routeCredentialKeypress(keypress, deps.state.credentialMode, deps);
    return "continue";
  }
  if (deps.state.triggerPromptMode !== null) {
    routeTriggerPromptKeypress(keypress, deps.state.triggerPromptMode, deps);
    return "continue";
  }
  return "dispatch";
}

/** Clean up resources on REPL exit: stop reader, persist history, close WS. */
function cleanupChatRepl(
  keypressReader: ReturnType<typeof createKeypressReader>,
  deps: ChatReplDeps,
  historyFilePath: string,
  inputHistory: import("../../cli/chat/history.ts").InputHistory,
): void {
  keypressReader.stop();
  deps.screen.cleanup();
  saveInputHistory(historyFilePath, inputHistory).catch((err: unknown) => {
    deps.log.debug("Input history save failed during cleanup", { error: err });
  });
  try {
    deps.ws.close();
  } catch (err: unknown) {
    deps.log.debug("WebSocket send failed: connection closed", { operation: "sendToGateway", err });
  }
}

/** @deprecated Use startChatSession instead */
export const runChat = startChatSession;
