/**
 * Defines the Transport interface and stdio/SSE implementations for communicating with MCP servers.
 *
 * @module
 */

import type { Result } from "../../core/types/classification.ts";
import { createLogger } from "../../core/logger/logger.ts";
import { safeFetchWithRedirects } from "../../core/security/mod.ts";
import type { SsrfChecker } from "../../core/security/mod.ts";

const log = createLogger("mcp");

/**
 * Validates a URL before a network connection is established.
 *
 * Implementations should check the URL against an SSRF denylist via DNS
 * resolution. Inject `resolveAndCheck` from `src/tools/web/ssrf.ts` at
 * the gateway wiring layer — mcp/ cannot import from tools/ directly
 * (dependency layer constraint).
 *
 * Returns Ok(void) if the URL is safe, Err(reason) if it should be blocked.
 */
export type UrlValidator = (url: string) => Promise<Result<void, string>>;

/** Transport interface for MCP client-server communication. */
export interface Transport {
  /** Establish connection to the MCP server. */
  connect(): Promise<void>;
  /** Disconnect from the MCP server. */
  disconnect(): Promise<void>;
  /** Send a JSON-RPC message string to the server. */
  send(msg: string): Promise<void>;
  /** Register a handler for incoming messages from the server. */
  onMessage(handler: (msg: string) => void): void;
}

/**
 * StdioTransport spawns a subprocess and communicates via stdin/stdout.
 *
 * The MCP server is started as a child process. Requests are written to
 * its stdin and responses are read from its stdout, one JSON message per line.
 */
export class StdioTransport implements Transport {
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #env?: Readonly<Record<string, string>>;
  #process: Deno.ChildProcess | null = null;
  readonly #handlers: Array<(msg: string) => void> = [];

  constructor(
    command: string,
    args: readonly string[] = [],
    env?: Readonly<Record<string, string>>,
  ) {
    this.#command = command;
    this.#args = args;
    this.#env = env;
  }

  // deno-lint-ignore require-await
  async connect(): Promise<void> {
    const cmd = new Deno.Command(this.#command, {
      args: [...this.#args],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env: { PATH: Deno.env.get("PATH") ?? "", ...this.#env },
    });
    this.#process = cmd.spawn();

    // Read stdout line by line and dispatch to handlers
    const reader = this.#process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const readLoop = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length > 0) {
              for (const handler of this.#handlers) {
                handler(trimmed);
              }
            }
          }
        }
      } catch (err) {
        log.debug("MCP stdio read loop terminated", {
          command: this.#command,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    readLoop();
  }

  // deno-lint-ignore require-await
  async disconnect(): Promise<void> {
    if (this.#process) {
      try {
        this.#process.stdin.getWriter().close();
      } catch (err) {
        log.debug("MCP stdio stdin already closed on disconnect", {
          command: this.#command,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.#process.kill();
      this.#process = null;
    }
  }

  async send(msg: string): Promise<void> {
    if (!this.#process) {
      throw new Error("Transport not connected");
    }
    const writer = this.#process.stdin.getWriter();
    const encoder = new TextEncoder();
    await writer.write(encoder.encode(msg + "\n"));
    writer.releaseLock();
  }

  onMessage(handler: (msg: string) => void): void {
    this.#handlers.push(handler);
  }
}

/** Delay before re-establishing a dropped SSE stream (EventSource parity). */
const SSE_RECONNECT_DELAY_MS = 3_000;

/** Extract a hostname for logging without exposing the full URL. */
function sseHostnameForLog(urlStr: string): string {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return "<unparseable>";
  }
}

/** Validate an SSE response and return its body stream, or throw. */
function extractEventStreamBody(
  response: Response,
): ReadableStream<Uint8Array> {
  if (!response.ok) {
    void response.body?.cancel();
    throw new Error(`SSE connection failed: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("SSE connection failed: response has no body");
  }
  return response.body;
}

/** Mutable accumulator state for the streaming SSE parser. */
interface SseParserState {
  buffer: string;
  eventType: string;
  dataLines: string[];
}

/** Apply one SSE field line to the parser state, dispatching on blank lines. */
function consumeSseFieldLine(
  state: SseParserState,
  line: string,
  onMessage: (data: string) => void,
): void {
  if (line === "") {
    if (state.dataLines.length > 0 && state.eventType === "message") {
      onMessage(state.dataLines.join("\n"));
    }
    state.eventType = "message";
    state.dataLines = [];
    return;
  }
  if (line.startsWith(":")) return;
  const colon = line.indexOf(":");
  const field = colon === -1 ? line : line.slice(0, colon);
  const rawValue = colon === -1 ? "" : line.slice(colon + 1);
  const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
  if (field === "data") state.dataLines.push(value);
  if (field === "event") state.eventType = value;
}

/**
 * Create a streaming SSE parser that emits the data of default "message"
 * events, matching EventSource.onmessage semantics: named events (e.g.
 * "endpoint") are not dispatched and comment lines are ignored.
 */
function createSseMessageParser(
  onMessage: (data: string) => void,
): (chunk: string) => void {
  const state: SseParserState = {
    buffer: "",
    eventType: "message",
    dataLines: [],
  };
  return (chunk: string) => {
    state.buffer += chunk;
    const lines = state.buffer.split("\n");
    state.buffer = lines.pop() ?? "";
    for (const line of lines) {
      consumeSseFieldLine(
        state,
        line.endsWith("\r") ? line.slice(0, -1) : line,
        onMessage,
      );
    }
  };
}

/**
 * SSETransport connects to an MCP server via HTTP Server-Sent Events.
 *
 * Requests are sent via HTTP POST and responses arrive as SSE events.
 * Both directions go through `safeFetchWithRedirects`, so the SSRF
 * denylist is re-checked for the initial URL AND every redirect hop of
 * every request. The receive path is a fetch-based SSE reader rather
 * than the platform EventSource, because EventSource follows redirects
 * with no way to disable them or observe the post-redirect URL. A
 * dropped stream is re-established (with full re-validation) after
 * `SSE_RECONNECT_DELAY_MS`, mirroring EventSource retry behavior.
 *
 * Pass a `urlValidator` (e.g. wrapping `resolveAndCheck` from
 * tools/web/ssrf.ts) to gate the connection before it is established.
 * Per-hop checks use `ssrfChecker` (default: DNS-resolving
 * `resolveAndCheck`); inject one in tests to avoid real DNS.
 */
export class SSETransport implements Transport {
  readonly #url: string;
  readonly #urlValidator: UrlValidator | null;
  readonly #ssrfChecker: SsrfChecker | undefined;
  readonly #handlers: Array<(msg: string) => void> = [];
  #abort: AbortController | null = null;
  #readLoop: Promise<void> | null = null;
  #reconnectTimer: number | undefined;
  #closed = true;

  constructor(
    url: string,
    urlValidator?: UrlValidator,
    ssrfChecker?: SsrfChecker,
  ) {
    this.#url = url;
    this.#urlValidator = urlValidator ?? null;
    this.#ssrfChecker = ssrfChecker;
  }

  async connect(): Promise<void> {
    await this.#enforceConnectPolicy();
    this.#closed = false;
    const body = await this.#openValidatedEventStream();
    this.#readLoop = this.#consumeEventStream(body);
  }

  /** Run the injected URL validator (connect-time SSRF gate). */
  async #enforceConnectPolicy(): Promise<void> {
    if (!this.#urlValidator) {
      log.debug("MCP SSE connecting without injected URL validator", {
        url: this.#url,
      });
      return;
    }
    const result = await this.#urlValidator(this.#url);
    if (!result.ok) {
      log.warn("MCP SSE connection blocked by SSRF policy", {
        url: this.#url,
        reason: result.error,
      });
      throw new Error(
        `SSE connection blocked by SSRF policy: ${result.error}`,
      );
    }
    log.debug("MCP SSE SSRF check passed", { url: this.#url });
  }

  /** Open the SSE stream; every redirect hop is SSRF-re-checked. */
  async #openValidatedEventStream(): Promise<ReadableStream<Uint8Array>> {
    this.#abort = new AbortController();
    const result = await safeFetchWithRedirects(
      this.#url,
      {
        headers: { "Accept": "text/event-stream" },
        signal: this.#abort.signal,
      },
      this.#ssrfChecker,
    );
    if (!result.ok) {
      log.warn("MCP SSE stream blocked by per-hop SSRF check", {
        operation: "openValidatedEventStream",
        hostname: sseHostnameForLog(this.#url),
        reason: result.error,
      });
      throw new Error(`SSE connection blocked: ${result.error}`);
    }
    return extractEventStreamBody(result.value);
  }

  /** Read the SSE stream and dispatch "message" events to handlers. */
  async #consumeEventStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parseChunk = createSseMessageParser((data) => {
      for (const handler of this.#handlers) handler(data);
    });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parseChunk(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      log.debug("MCP SSE stream read terminated", {
        hostname: sseHostnameForLog(this.#url),
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!this.#closed) this.#scheduleReconnect();
  }

  /** Re-establish a dropped stream after a delay, re-running validation. */
  #scheduleReconnect(): void {
    log.warn("MCP SSE stream ended unexpectedly; scheduling reconnect", {
      operation: "scheduleReconnect",
      hostname: sseHostnameForLog(this.#url),
      delayMs: SSE_RECONNECT_DELAY_MS,
    });
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      if (this.#closed) return;
      this.connect().catch((err) => {
        log.warn("MCP SSE reconnect attempt failed", {
          operation: "scheduleReconnect",
          hostname: sseHostnameForLog(this.#url),
          err,
        });
        if (!this.#closed) this.#scheduleReconnect();
      });
    }, SSE_RECONNECT_DELAY_MS);
  }

  async disconnect(): Promise<void> {
    this.#closed = true;
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#abort?.abort();
    this.#abort = null;
    if (this.#readLoop) {
      await this.#readLoop;
      this.#readLoop = null;
    }
  }

  async send(msg: string): Promise<void> {
    const result = await safeFetchWithRedirects(
      this.#url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: msg,
      },
      this.#ssrfChecker,
    );
    if (!result.ok) {
      log.warn("MCP SSE send blocked by per-hop SSRF check", {
        operation: "send",
        hostname: sseHostnameForLog(this.#url),
        reason: result.error,
      });
      throw new Error(`SSE send blocked: ${result.error}`);
    }
    await result.value.body?.cancel();
  }

  onMessage(handler: (msg: string) => void): void {
    this.#handlers.push(handler);
  }
}
