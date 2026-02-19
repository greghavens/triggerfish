/**
 * Interactive chat REPL for the CLI channel.
 *
 * Connects to the gateway WebSocket and provides a full terminal UI
 * (TTY mode with scroll regions, raw keypress handling, history, suggestions)
 * and a simple line-buffered fallback for piped/non-TTY input.
 * @module
 */

import { join } from "@std/path";
import { loadConfig } from "../../core/config.ts";
import type { TriggerFishConfig } from "../../core/config.ts";
import { resolveBaseDir, resolveConfigPath } from "../../cli/paths.ts";
import {
  createEventHandler,
  createScreenEventHandler,
  formatBanner,
  formatError,
  printBanner,
  renderError,
  renderPrompt,
} from "../../cli/chat_ui.ts";
import type { ToolDisplayMode } from "../../cli/chat_ui.ts";
import {
  createKeypressReader,
  createLineEditor,
  createSuggestionEngine,
} from "../../cli/terminal.ts";
import type { LineEditor } from "../../cli/terminal.ts";
import { loadInputHistory, saveInputHistory } from "../../cli/history.ts";
import { createScreenManager, taintColor } from "../../cli/screen.ts";
import type { OrchestratorEvent } from "../../agent/orchestrator.ts";
import type { ChatEvent } from "../../gateway/chat.ts";
import { imageBlock, readClipboardImage } from "../../image/mod.ts";
import type {
  ContentBlock,
  ImageContentBlock,
  MessageContent,
} from "../../image/mod.ts";

/**
 * Run an interactive chat REPL.
 *
 * Connects to the daemon's gateway WebSocket at /chat for the shared
 * session. All terminal UI (raw mode, scroll regions, keypress reader,
 * input history, suggestions, ESC interrupt, Ctrl+O toggle) is preserved.
 * The daemon owns the session, orchestrator, and policy engine.
 */
export async function runChat(): Promise<void> {
  const configPath = resolveConfigPath();

  // Load config (for banner display only)
  const configResult = loadConfig(configPath);
  if (!configResult.ok) {
    console.log(`Configuration error: ${configResult.error}`);
    console.log("Run 'triggerfish dive' to fix your configuration.\n");
    Deno.exit(1);
  }

  const config = configResult.value;
  const baseDir = resolveBaseDir();
  const dataDir = join(baseDir, "data");
  await Deno.mkdir(dataDir, { recursive: true });

  // Connect to the daemon's chat WebSocket
  const gatewayUrl = "ws://127.0.0.1:18789/chat";
  let ws: WebSocket;
  try {
    ws = new WebSocket(gatewayUrl);
  } catch {
    console.log("Cannot connect to daemon. Is it running?");
    console.log("Run 'triggerfish start' or 'triggerfish run' first.\n");
    Deno.exit(1);
    return;
  }

  // Wait for connection + connected event
  let providerName = "unknown";
  let _modelName = "";
  const connected = Promise.withResolvers<void>();

  ws.addEventListener("error", () => {
    console.log("Cannot connect to daemon. Is it running?");
    console.log("Run 'triggerfish start' or 'triggerfish run' first.\n");
    Deno.exit(1);
  });

  ws.addEventListener("open", () => {
    // Connection established, wait for "connected" event
  });

  // Determine if we're in TTY mode
  const isTty = Deno.stdin.isTerminal();

  // Set up display mode toggle (Ctrl+O)
  let displayMode: ToolDisplayMode = "compact";
  const getDisplayMode = (): ToolDisplayMode => displayMode;

  // Set up screen manager
  const screen = createScreenManager();

  // Create event handler — use screen-aware handler for TTY, legacy for pipes
  const eventHandler = isTty
    ? createScreenEventHandler(screen, getDisplayMode)
    : createEventHandler();

  // State tracking
  const state = { isProcessing: false };
  const messageQueue: string[] = [];

  // Password mode state — active when the daemon sends a secret_prompt event.
  // While active, keypress input collects characters for the secret value
  // instead of the normal line editor.
  interface PasswordModeState {
    readonly nonce: string;
    readonly name: string;
    readonly hint?: string;
    readonly chars: string[];
  }
  let passwordMode: PasswordModeState | null = null;

  /** Send the next queued message (if any). */
  function drainQueue(): void {
    if (messageQueue.length === 0) return;
    const next = messageQueue.shift()!;
    screen.writeOutput(`  ${taintColor(screen.getTaint())}\x1b[1m❯\x1b[0m ${next}`);
    screen.writeOutput(`  \x1b[2m(queued)\x1b[0m`);
    screen.writeOutput("");
    state.isProcessing = true;
    try {
      ws.send(JSON.stringify({ type: "message", content: next }));
    } catch {
      screen.writeOutput(formatError("Lost connection to daemon"));
      state.isProcessing = false;
      screen.redrawInput(editor);
    }
  }

  // Route incoming WebSocket events to the event handler
  ws.addEventListener("message", (event: MessageEvent) => {
    try {
      const data = typeof event.data === "string"
        ? event.data
        : new TextDecoder().decode(event.data as ArrayBuffer);
      const evt = JSON.parse(data) as ChatEvent;

      if (evt.type === "connected") {
        providerName = evt.provider;
        _modelName = evt.model;
        if (evt.taint) {
          screen.setTaint(evt.taint);
        }
        connected.resolve();
        return;
      }

      if (evt.type === "taint_changed") {
        screen.setTaint(evt.level);
        if (isTty) screen.redrawInput(editor);
        return;
      }

      if (evt.type === "mcp_status") {
        if (isTty) {
          screen.setMcpStatus(evt.connected, evt.configured);
          screen.redrawInput(editor);
        }
        return;
      }

      if (evt.type === "secret_prompt") {
        if (isTty) {
          // Enter password mode — capture keystrokes for the secret value
          passwordMode = {
            nonce: evt.nonce,
            name: evt.name,
            hint: evt.hint,
            chars: [],
          };
          screen.stopSpinner();
          const hintStr = evt.hint ? ` (${evt.hint})` : "";
          screen.writeOutput(`  \x1b[33m\u{1f512} Enter value for '${evt.name}'${hintStr}\x1b[0m`);
          screen.setStatus("\u{1f512} Type secret, Enter to submit, Esc to cancel");
          screen.redrawInput(editor);
        }
        // Non-TTY path is handled in runSimpleWsRepl
        return;
      }

      if (evt.type === "cancelled") {
        if (isTty) {
          screen.stopSpinner();
          screen.redrawInput(editor);
        }
        state.isProcessing = false;
        drainQueue();
        return;
      }

      if (evt.type === "error") {
        if (isTty) {
          screen.stopSpinner();
          screen.writeOutput(formatError(evt.message));
          screen.writeOutput("");
          screen.redrawInput(editor);
        } else {
          renderError(evt.message);
          renderPrompt();
        }
        state.isProcessing = false;
        drainQueue();
        return;
      }

      if (evt.type === "compact_start") {
        if (isTty) {
          screen.startSpinner("Summarizing history...");
        } else {
          console.log("  Summarizing history...");
        }
        return;
      }

      if (evt.type === "compact_complete") {
        const saved = evt.tokensBefore - evt.tokensAfter;
        const msg =
          `  Compacted: ${evt.messagesBefore} → ${evt.messagesAfter} messages (saved ~${saved} tokens)`;
        if (isTty) {
          screen.stopSpinner();
          screen.writeOutput(msg);
          screen.redrawInput(editor);
        } else {
          console.log(msg);
          renderPrompt();
        }
        return;
      }

      if (evt.type === "response_chunk") {
        eventHandler(evt as OrchestratorEvent);
        if (isTty) screen.redrawInput(editor);
        return;
      }

      if (evt.type === "response") {
        // The event handler will render the response text
        eventHandler(evt as OrchestratorEvent);
        state.isProcessing = false;
        if (isTty) {
          screen.writeOutput("");
          screen.redrawInput(editor);
        } else {
          renderPrompt();
        }
        drainQueue();
        return;
      }

      // Forward all other events (llm_start, llm_complete, tool_call, tool_result)
      eventHandler(evt as OrchestratorEvent);
      if (isTty) {
        screen.redrawInput(editor);
      }
    } catch {
      // Ignore parse errors
    }
  });

  // Handle WebSocket close
  ws.addEventListener("close", () => {
    if (isTty) {
      screen.writeOutput("  \x1b[31mDisconnected from daemon.\x1b[0m");
      screen.writeOutput("");
      screen.redrawInput(editor);
    } else {
      console.log("\n  Disconnected from daemon.\n");
    }
    state.isProcessing = false;
  });

  // Wait for the connected event before showing UI
  // Timeout after 5 seconds
  const timeout = setTimeout(() => {
    console.log("Timed out waiting for daemon. Is it running?");
    console.log("Run 'triggerfish start' or 'triggerfish run' first.\n");
    ws.close();
    Deno.exit(1);
  }, 5000);
  await connected.promise;
  clearTimeout(timeout);

  // Load input history
  const historyFilePath = join(dataDir, "input_history.json");
  let inputHistory = await loadInputHistory(historyFilePath);

  // Set up suggestion engine
  const suggestionEngine = createSuggestionEngine();

  // If not a TTY, fall back to the simple line-buffered REPL
  if (!isTty) {
    printBanner(providerName, config.models.primary.model, "");
    await runSimpleWsRepl(ws, providerName, config);
    return;
  }

  // ─── TTY mode: raw terminal with scroll regions ──────────────

  // Print banner via screen manager
  screen.init();
  screen.writeOutput(
    formatBanner(providerName, config.models.primary.model, ""),
  );

  // Create keypress reader and line editor
  const keypressReader = createKeypressReader();
  let editor: LineEditor = createLineEditor();
  let stashedInput = ""; // Stash current input when entering history navigation
  let pendingImages: ImageContentBlock[] = []; // Images pasted with Ctrl+V, sent with next message

  // Cleanup function — must run on exit
  function cleanup(): void {
    keypressReader.stop();
    screen.cleanup();
    saveInputHistory(historyFilePath, inputHistory).catch(() => {});
    try {
      ws.close();
    } catch { /* already closed */ }
  }

  // Handle SIGINT (Ctrl+C from outside raw mode, e.g. kill signal)
  try {
    Deno.addSignalListener("SIGINT", () => {
      if (state.isProcessing) {
        try {
          ws.send(JSON.stringify({ type: "cancel" }));
        } catch { /* ignore */ }
        screen.writeOutput(`  \x1b[33m⚠ Interrupted\x1b[0m`);
      } else {
        cleanup();
        Deno.exit(0);
      }
    });
  } catch {
    // Signal listeners may not be supported on all platforms
  }

  // Handle terminal resize — SIGWINCH on Unix, polling fallback on Windows
  const resizeHandler = () => {
    screen.handleResize();
    screen.redrawInput(editor);
  };
  try {
    Deno.addSignalListener("SIGWINCH", resizeHandler);
  } catch {
    // SIGWINCH not supported (Windows/PowerShell) — poll for size changes
    screen.startResizePolling(resizeHandler);
  }

  // Draw initial input prompt
  screen.redrawInput(editor);

  // Start reading keypresses
  keypressReader.start();

  let lastCtrlCTime = 0;

  for await (const keypress of keypressReader) {
    // ─── Interrupt keys (work in any mode) ──────────────────
    if (keypress.key === "esc" && state.isProcessing) {
      try {
        ws.send(JSON.stringify({ type: "cancel" }));
      } catch { /* ignore */ }
      screen.writeOutput(`  \x1b[33m⚠ Interrupted\x1b[0m`);
      continue;
    }

    if (keypress.key === "ctrl+c") {
      if (state.isProcessing) {
        const now = Date.now();
        if (now - lastCtrlCTime < 1000) {
          cleanup();
          return;
        }
        lastCtrlCTime = now;
        try {
          ws.send(JSON.stringify({ type: "cancel" }));
        } catch { /* ignore */ }
        screen.writeOutput(
          `  \x1b[33m⚠ Interrupted (Ctrl+C again to exit)\x1b[0m`,
        );
      } else {
        cleanup();
        return;
      }
      continue;
    }

    // ─── Password mode (secret_prompt active) ─────────────
    if (passwordMode !== null) {
      const pm: PasswordModeState = passwordMode; // capture for TypeScript narrowing
      if (keypress.key === "enter") {
        // Submit the secret value
        const value = pm.chars.join("");
        try {
          ws.send(JSON.stringify({
            type: "secret_prompt_response",
            nonce: pm.nonce,
            value,
          }));
        } catch { /* ignore */ }
        screen.writeOutput(`  \x1b[32m\u2713 Secret submitted\x1b[0m`);
        screen.clearStatus();
        passwordMode = null;
        screen.redrawInput(editor);
        continue;
      }
      if (keypress.key === "esc" || keypress.key === "ctrl+c") {
        // Cancel the secret prompt
        try {
          ws.send(JSON.stringify({
            type: "secret_prompt_response",
            nonce: pm.nonce,
            value: null,
          }));
        } catch { /* ignore */ }
        screen.writeOutput(`  \x1b[33m\u2717 Secret entry cancelled\x1b[0m`);
        screen.clearStatus();
        passwordMode = null;
        screen.redrawInput(editor);
        continue;
      }
      if (keypress.key === "backspace") {
        if (pm.chars.length > 0) {
          pm.chars.pop();
          const masked = "\u25cf".repeat(pm.chars.length);
          screen.setStatus(`\u{1f512} ${pm.name}: ${masked}`);
        }
        continue;
      }
      // Printable character → accumulate
      if (keypress.char !== null) {
        pm.chars.push(keypress.char);
        const masked = "\u25cf".repeat(pm.chars.length);
        screen.setStatus(`\u{1f512} ${pm.name}: ${masked}`);
        continue;
      }
      // Ignore all other keys in password mode
      continue;
    }

    // ─── Input handling (works in both idle and processing) ─
    switch (keypress.key) {
      case "shift+enter": {
        // Insert newline for multi-line input
        editor = editor.insert("\n");
        editor = editor.setSuggestion("");
        screen.redrawInput(editor);
        break;
      }

      case "enter": {
        const text = editor.text.trim();

        if (text.length === 0) {
          break;
        }

        // Echo the submitted text into the output region
        const displayText = text.includes("\n")
          ? text.split("\n").join(`\n  ${"\x1b[2m"}·\x1b[0m `)
          : text;
        screen.writeOutput(`  ${taintColor(screen.getTaint())}\x1b[1m❯\x1b[0m ${displayText}`);
        screen.writeOutput("");

        // Add to history and save
        inputHistory = inputHistory.push(text);
        inputHistory = inputHistory.resetNavigation();
        saveInputHistory(historyFilePath, inputHistory).catch(() => {});

        // Clear editor
        editor = editor.clear();
        screen.redrawInput(editor);
        stashedInput = "";

        // Handle slash commands locally (only in idle mode)
        if (!state.isProcessing) {
          if (text === "/quit" || text === "/exit" || text === "/q") {
            screen.writeOutput("  Goodbye.");
            cleanup();
            return;
          }

          if (text === "/clear") {
            ws.send(JSON.stringify({ type: "clear" }));
            screen.setTaint("PUBLIC");
            screen.cleanup();
            screen.init();
            screen.writeOutput(
              formatBanner(providerName, config.models.primary.model, ""),
            );
            screen.redrawInput(editor);
            break;
          }

          if (text === "/help") {
            screen.writeOutput(
              "  Commands:\n" +
                "    /quit, /exit, /q     — Exit chat\n" +
                "    /clear               — Clear screen\n" +
                "    /compact             — Summarize conversation history\n" +
                "    /verbose             — Toggle tool display detail\n" +
                "    /help                — Show this help\n" +
                "    Ctrl+V               — Paste image from clipboard\n" +
                "    Ctrl+O               — Toggle tool display mode\n" +
                "    ESC                  — Interrupt current operation\n" +
                "    Shift+Enter          — New line in message\n" +
                "    Up/Down              — Navigate input history\n" +
                "    Tab                  — Accept suggestion",
            );
            break;
          }

          if (text === "/verbose") {
            displayMode = displayMode === "compact" ? "expanded" : "compact";
            screen.writeOutput(`  Tool display: ${displayMode}`);
            break;
          }

          if (text === "/compact") {
            screen.writeOutput("  Compacting conversation history...");
            ws.send(JSON.stringify({ type: "compact" }));
            break;
          }

          // Build message content — multimodal if images are pending
          let messageContent: MessageContent = text;
          if (pendingImages.length > 0) {
            const blocks: ContentBlock[] = [
              ...pendingImages,
              { type: "text" as const, text },
            ];
            messageContent = blocks;
            pendingImages = [];
          }

          // Send message to daemon via WebSocket
          state.isProcessing = true;
          try {
            ws.send(
              JSON.stringify({ type: "message", content: messageContent }),
            );
          } catch {
            screen.writeOutput(formatError("Lost connection to daemon"));
            state.isProcessing = false;
            screen.writeOutput("");
            screen.redrawInput(editor);
          }
        } else {
          // Processing mode — queue the message
          messageQueue.push(text);
          screen.writeOutput(
            `  \x1b[2m(queued — will send after current response)\x1b[0m`,
          );
        }

        break;
      }

      case "backspace":
        editor = editor.backspace();
        updateSuggestion();
        screen.redrawInput(editor);
        break;

      case "delete":
        editor = editor.deleteChar();
        updateSuggestion();
        screen.redrawInput(editor);
        break;

      case "left":
        editor = editor.moveCursor("left");
        screen.redrawInput(editor);
        break;

      case "right":
        editor = editor.moveCursor("right");
        screen.redrawInput(editor);
        break;

      case "home":
      case "ctrl+a":
        editor = editor.moveCursor("home");
        screen.redrawInput(editor);
        break;

      case "end":
      case "ctrl+e":
        editor = editor.moveCursor("end");
        screen.redrawInput(editor);
        break;

      case "up": {
        // Stash current input when first entering history
        if (inputHistory.index === -1 && editor.text.length > 0) {
          stashedInput = editor.text;
        }
        inputHistory = inputHistory.up();
        const histText = inputHistory.current();
        if (histText !== null) {
          editor = editor.setText(histText);
          editor = editor.setSuggestion("");
          screen.redrawInput(editor);
        }
        break;
      }

      case "down": {
        inputHistory = inputHistory.down();
        const histText = inputHistory.current();
        if (histText !== null) {
          editor = editor.setText(histText);
        } else {
          // Back to fresh input — restore stashed text
          editor = editor.setText(stashedInput);
          stashedInput = "";
        }
        editor = editor.setSuggestion("");
        screen.redrawInput(editor);
        break;
      }

      case "tab":
        editor = editor.acceptSuggestion();
        screen.redrawInput(editor);
        break;

      case "ctrl+v": {
        // Paste image from clipboard
        const clipResult = await readClipboardImage();
        if (clipResult.ok) {
          const img = imageBlock(
            clipResult.value.data,
            clipResult.value.mimeType,
          );
          pendingImages.push(img);
          const sizeKb = (clipResult.value.data.length / 1024).toFixed(1);
          screen.setStatus(
            `Image pasted (${clipResult.value.mimeType}, ${sizeKb}KB) — will send with next message`,
          );
          setTimeout(() => screen.clearStatus(), 3000);
        } else {
          screen.setStatus(clipResult.error);
          setTimeout(() => screen.clearStatus(), 3000);
        }
        break;
      }

      case "ctrl+o":
        displayMode = displayMode === "compact" ? "expanded" : "compact";
        screen.setStatus(`Display: ${displayMode}`);
        setTimeout(() => screen.clearStatus(), 1500);
        break;

      case "ctrl+d":
        if (editor.text.length === 0) {
          cleanup();
          return;
        }
        break;

      case "ctrl+u":
        // Clear line
        editor = editor.clear();
        screen.redrawInput(editor);
        break;

      case "ctrl+w": {
        // Delete word backwards
        const text = editor.text;
        let cursor = editor.cursor;
        // Skip trailing spaces
        while (cursor > 0 && text[cursor - 1] === " ") cursor--;
        // Delete to previous space
        while (cursor > 0 && text[cursor - 1] !== " ") cursor--;
        editor = editor.setText(
          text.slice(0, cursor) + text.slice(editor.cursor),
        );
        screen.redrawInput(editor);
        break;
      }

      case "esc":
        // ESC in idle mode — ignore
        break;

      default:
        // Printable character
        if (keypress.char !== null) {
          editor = editor.insert(keypress.char);
          inputHistory = inputHistory.resetNavigation();
          stashedInput = "";
          updateSuggestion();
          screen.redrawInput(editor);
        }
        break;
    }
  }

  // EOF reached
  cleanup();

  /** Update the suggestion based on current editor text. */
  function updateSuggestion(): void {
    const suggestion = suggestionEngine.suggest(
      editor.text,
      inputHistory.entries as string[],
    );
    if (suggestion) {
      const remainder = suggestion.slice(editor.text.length);
      editor = editor.setSuggestion(remainder);
    } else {
      editor = editor.setSuggestion("");
    }
  }
}

/**
 * Simple line-buffered REPL for non-TTY environments (piped input).
 *
 * Connects to the daemon via WebSocket. Falls back to the original
 * stdin.read() approach for compatibility with piped input.
 */
export async function runSimpleWsRepl(
  ws: WebSocket,
  providerName: string,
  config: TriggerFishConfig,
): Promise<void> {
  const decoder = new TextDecoder();
  const buf = new Uint8Array(8192);
  let partial = "";

  renderPrompt();

  while (true) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;

    partial += decoder.decode(buf.subarray(0, n));

    let newlineIdx: number;
    while ((newlineIdx = partial.indexOf("\n")) !== -1) {
      const line = partial.slice(0, newlineIdx).trimEnd();
      partial = partial.slice(newlineIdx + 1);

      if (line === "/quit" || line === "/exit" || line === "/q") {
        console.log("\n  Goodbye.\n");
        ws.close();
        return;
      }

      if (line === "/clear") {
        ws.send(JSON.stringify({ type: "clear" }));
        console.log("\x1b[2J\x1b[H");
        printBanner(providerName, config.models.primary.model, "");
        renderPrompt();
        continue;
      }

      if (line === "/compact") {
        console.log("  Compacting conversation history...");
        ws.send(JSON.stringify({ type: "compact" }));
        // compact_start/compact_complete handled by the main event handler
        renderPrompt();
        continue;
      }

      if (line.length === 0) {
        renderPrompt();
        continue;
      }

      // Send to daemon and wait for response
      console.log();
      const responsePromise = Promise.withResolvers<void>();

      const handler = async (event: MessageEvent) => {
        try {
          const data = typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer);
          const evt = JSON.parse(data) as ChatEvent;

          // Handle secret prompt in non-TTY mode: read a line from stdin
          if (evt.type === "secret_prompt") {
            const hintStr = evt.hint ? ` (${evt.hint})` : "";
            const enc = new TextEncoder();
            Deno.stderr.writeSync(enc.encode(`  Enter value for '${evt.name}'${hintStr}: `));
            const lineBuf = new Uint8Array(4096);
            const nRead = await Deno.stdin.read(lineBuf);
            const value = nRead !== null
              ? new TextDecoder().decode(lineBuf.subarray(0, nRead)).trimEnd()
              : null;
            try {
              ws.send(JSON.stringify({
                type: "secret_prompt_response",
                nonce: evt.nonce,
                value: value && value.length > 0 ? value : null,
              }));
            } catch { /* ignore */ }
            return;
          }

          if (evt.type === "response" || evt.type === "error") {
            if (evt.type === "error") {
              renderError(evt.message);
            }
            ws.removeEventListener("message", handler);
            responsePromise.resolve();
          }
        } catch {
          // ignore
        }
      };

      ws.addEventListener("message", handler);
      ws.send(JSON.stringify({ type: "message", content: line }));
      await responsePromise.promise;

      renderPrompt();
    }
  }
  ws.close();
}
