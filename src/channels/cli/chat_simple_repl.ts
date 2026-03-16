/**
 * Simple line-buffered REPL for non-TTY environments (piped input).
 *
 * Connects to the daemon via WebSocket. Falls back to stdin.read()
 * for compatibility with piped input.
 * @module
 */

import { createLogger } from "../../core/logger/logger.ts";
import type { TriggerFishConfig } from "../../core/config.ts";
import {
  printBanner,
  renderError,
  renderPrompt,
} from "../../cli/chat/chat_ui.ts";
import type { ChatEvent } from "../../core/types/chat_event.ts";

/** Bundled context for the non-TTY simple REPL. */
interface SimpleReplContext {
  readonly ws: WebSocket;
  readonly providerName: string;
  readonly config: TriggerFishConfig;
  readonly workspace: string;
  readonly log: ReturnType<typeof createLogger>;
}

/** Read a secret value from stdin and send the response over WebSocket. */
async function handleSecretPromptEvent(
  evt: ChatEvent & { type: "secret_prompt" },
  ctx: SimpleReplContext,
): Promise<void> {
  const hintStr = evt.hint ? ` (${evt.hint})` : "";
  const enc = new TextEncoder();
  Deno.stderr.writeSync(
    enc.encode(`  Enter value for '${evt.name}'${hintStr}: `),
  );
  const lineBuf = new Uint8Array(4096);
  const nRead = await Deno.stdin.read(lineBuf);
  const value = nRead !== null
    ? new TextDecoder().decode(lineBuf.subarray(0, nRead)).trimEnd()
    : null;
  try {
    ctx.ws.send(JSON.stringify({
      type: "secret_prompt_response",
      nonce: evt.nonce,
      value: value && value.length > 0 ? value : null,
    }));
    ctx.log.debug("Secret prompt response sent", {
      operation: "handleSecretPromptEvent",
      nonce: evt.nonce,
      hasValue: value !== null && value.length > 0,
    });
  } catch (err: unknown) {
    ctx.log.debug("WebSocket secret send failed", {
      operation: "handleSecretPromptEvent",
      err,
    });
  }
}

/** Read a credential (username + password) from stdin and send the response over WebSocket. */
async function handleCredentialPromptEvent(
  evt: ChatEvent & { type: "credential_prompt" },
  ctx: SimpleReplContext,
): Promise<void> {
  const hintStr = evt.hint ? ` (${evt.hint})` : "";
  const enc = new TextEncoder();
  const lineBuf = new Uint8Array(4096);

  // Read username
  Deno.stderr.writeSync(
    enc.encode(`  Enter username for '${evt.name}'${hintStr}: `),
  );
  const nUsername = await Deno.stdin.read(lineBuf);
  const username = nUsername !== null
    ? new TextDecoder().decode(lineBuf.subarray(0, nUsername)).trimEnd()
    : null;

  if (!username || username.length === 0) {
    try {
      ctx.ws.send(JSON.stringify({
        type: "credential_prompt_response",
        nonce: evt.nonce,
        username: null,
        password: null,
      }));
      ctx.log.debug("Credential prompt cancelled (empty username)", {
        operation: "handleCredentialPromptEvent",
        nonce: evt.nonce,
      });
    } catch (err: unknown) {
      ctx.log.debug("WebSocket credential cancel send failed", {
        operation: "handleCredentialPromptEvent",
        err,
      });
    }
    return;
  }

  // Read password
  Deno.stderr.writeSync(
    enc.encode(`  Enter password for '${evt.name}': `),
  );
  const nPassword = await Deno.stdin.read(lineBuf);
  const password = nPassword !== null
    ? new TextDecoder().decode(lineBuf.subarray(0, nPassword)).trimEnd()
    : null;

  try {
    ctx.ws.send(JSON.stringify({
      type: "credential_prompt_response",
      nonce: evt.nonce,
      username,
      password: password && password.length > 0 ? password : null,
    }));
    ctx.log.debug("Credential prompt response sent", {
      operation: "handleCredentialPromptEvent",
      nonce: evt.nonce,
    });
  } catch (err: unknown) {
    ctx.log.debug("WebSocket credential send failed", {
      operation: "handleCredentialPromptEvent",
      err,
    });
  }
}

/** Dispatch a REPL slash command, returning true if the input was a quit command. */
function dispatchSlashCommand(
  line: string,
  ctx: SimpleReplContext,
): "quit" | "handled" | "not_command" {
  if (line === "/quit" || line === "/exit" || line === "/q") {
    console.log("\n  Goodbye.\n");
    return "quit";
  }
  if (line === "/clear") {
    ctx.ws.send(JSON.stringify({ type: "clear" }));
    console.log("\x1b[2J\x1b[H");
    printBanner(
      ctx.providerName,
      ctx.config.models.primary.model,
      ctx.workspace,
    );
    return "handled";
  }
  if (line === "/compact") {
    console.log("  Compacting conversation history...");
    ctx.ws.send(JSON.stringify({ type: "compact" }));
    return "handled";
  }
  return "not_command";
}

/** Create a one-shot message handler that resolves on response/error events. */
function createResponseHandler(
  ctx: SimpleReplContext,
  resolve: () => void,
): (event: MessageEvent) => void {
  const handler = async (event: MessageEvent) => {
    try {
      const data = typeof event.data === "string"
        ? event.data
        : new TextDecoder().decode(event.data as ArrayBuffer);
      const evt = JSON.parse(data) as ChatEvent;
      if (evt.type === "secret_prompt") {
        await handleSecretPromptEvent(evt, ctx);
        return;
      }
      if (evt.type === "credential_prompt") {
        await handleCredentialPromptEvent(
          evt as ChatEvent & { type: "credential_prompt" },
          ctx,
        );
        return;
      }
      if (evt.type === "response" || evt.type === "error") {
        if (evt.type === "error") renderError(evt.message);
        ctx.ws.removeEventListener("message", handler);
        resolve();
      }
    } catch (err: unknown) {
      ctx.log.warn("Message parse failed", { error: err });
    }
  };
  return handler;
}

/** Send a user line to the daemon and wait for the response/error event. */
async function sendLineAndAwaitResponse(
  line: string,
  ctx: SimpleReplContext,
): Promise<void> {
  console.log();
  const responsePromise = Promise.withResolvers<void>();
  const handler = createResponseHandler(ctx, responsePromise.resolve);
  ctx.ws.addEventListener("message", handler);
  ctx.ws.send(JSON.stringify({ type: "message", content: line }));
  await responsePromise.promise;
}

/** Process a single complete line from stdin, returning true if the REPL should exit. */
async function processReplLine(
  line: string,
  ctx: SimpleReplContext,
): Promise<boolean> {
  const result = dispatchSlashCommand(line, ctx);
  if (result === "quit") {
    ctx.ws.close();
    return true;
  }
  if (result === "handled" || line.length === 0) {
    renderPrompt();
    return false;
  }
  await sendLineAndAwaitResponse(line, ctx);
  renderPrompt();
  return false;
}

/** REPL state for the line-buffered stdin reader. */
interface ReplState {
  partial: string;
}

/** Drain complete lines from the buffer and process each one. Returns true to exit. */
async function drainCompleteLines(
  state: ReplState,
  ctx: SimpleReplContext,
): Promise<boolean> {
  let newlineIdx: number;
  while ((newlineIdx = state.partial.indexOf("\n")) !== -1) {
    const line = state.partial.slice(0, newlineIdx).trimEnd();
    state.partial = state.partial.slice(newlineIdx + 1);
    if (await processReplLine(line, ctx)) return true;
  }
  return false;
}

/** Options for the non-TTY simple REPL. */
export interface SimpleReplOpts {
  readonly providerName: string;
  readonly config: TriggerFishConfig;
  readonly workspace: string;
}

/**
 * Simple line-buffered REPL for non-TTY environments (piped input).
 *
 * Reads stdin line-by-line, sends each to the daemon via WebSocket,
 * and waits for the response before prompting again.
 */
export async function startWebSocketRepl(
  ws: WebSocket,
  opts: SimpleReplOpts,
): Promise<void> {
  const log = createLogger("cli");
  const ctx: SimpleReplContext = {
    ws,
    providerName: opts.providerName,
    config: opts.config,
    workspace: opts.workspace,
    log,
  };
  const decoder = new TextDecoder();
  const buf = new Uint8Array(8192);
  const state: ReplState = { partial: "" };

  renderPrompt();
  while (true) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;
    state.partial += decoder.decode(buf.subarray(0, n));
    if (await drainCompleteLines(state, ctx)) return;
  }
  ws.close();
}

/** @deprecated Use startWebSocketRepl instead */
export const runSimpleWsRepl = startWebSocketRepl;
