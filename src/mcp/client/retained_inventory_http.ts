/** Bounded Streamable HTTP requests for a reviewed retained-inventory endpoint. */

import { safeFetchWithRedirects } from "../../core/security/mod.ts";
import { isRetainedInventoryOperation } from "../retained_inventory.ts";
import type { Transport } from "./transport.ts";

export const retainedInventoryProtocolVersion = "2025-06-18";

const unavailable = () => new Error("Retained inventory MCP is unavailable.");
const maxResponseBytes = 1_048_576;

interface InventoryRpcMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: { readonly name?: string };
  readonly result?: { readonly protocolVersion?: string };
  readonly error?: unknown;
}

function readMatchingRpc(
  text: string,
  id: number,
): InventoryRpcMessage | undefined {
  try {
    const message = JSON.parse(text);
    return message?.jsonrpc === "2.0" && message.id === id
      ? message
      : undefined;
  } catch {
    return undefined;
  }
}

async function readInventoryReply(
  response: Response,
  id: number,
  protectedValues: readonly string[],
): Promise<InventoryRpcMessage | undefined> {
  if (!response.body) return;
  const type = response.headers.get("content-type")?.split(";", 1)[0];
  const reader = response.body.getReader();
  const sse = type === "text/event-stream";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  const scrubbed = (rpc: InventoryRpcMessage | undefined) => {
    if (!rpc || rpc.error !== undefined) throw unavailable();
    // Keep echoed credentials and upstream session IDs out of tool
    // results, provider history, and error logs.
    const encoded = JSON.stringify(rpc);
    if (protectedValues.some((value) => encoded.includes(value))) {
      throw unavailable();
    }
    return rpc;
  };
  try {
    if (type !== "application/json" && !sse) return;
    for (;;) {
      const { done, value } = await reader.read();
      if (!done) bytes += value.length;
      if (bytes > maxResponseBytes) return;
      text += decoder.decode(value, { stream: !done });
      if (sse) {
        let boundary: RegExpMatchArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(text)) !== null) {
          const lines = text.slice(0, boundary.index).split(/\r?\n/);
          text = text.slice(boundary.index! + boundary[0].length);
          const data = lines.filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart()).join("\n");
          const rpc = readMatchingRpc(data, id);
          if (rpc) return scrubbed(rpc);
        }
      }
      if (done) return sse ? undefined : scrubbed(readMatchingRpc(text, id));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export class RetainedInventoryHttpTransport implements Transport {
  readonly #handlers: Array<(message: string) => void> = [];
  #connection?: AbortController;
  #session?: string;
  #protocol?: string;

  constructor(
    private readonly endpoint: string,
    private readonly getCredential: () => Promise<string | undefined>,
    private readonly timeoutMs: number,
    private readonly request = safeFetchWithRedirects,
  ) {}

  connect(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.#connection = new AbortController();
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.#connection?.abort();
    this.#connection = undefined;
    this.#session = undefined;
    this.#protocol = undefined;
    return Promise.resolve();
  }

  onMessage(handler: (message: string) => void): void {
    this.#handlers.push(handler);
  }

  async send(message: string): Promise<void> {
    const rpc = JSON.parse(message) as InventoryRpcMessage;
    const connection = this.#connection;
    const initial = rpc.method === "initialize";
    const notification = rpc.method === "notifications/initialized";
    if (
      !connection || (initial ? !!this.#protocol : !this.#protocol) ||
      (!initial && !notification && rpc.method !== "tools/list" &&
        !(rpc.method === "tools/call" &&
          isRetainedInventoryOperation(rpc.params?.name))) ||
      (notification ? rpc.id !== undefined : !Number.isSafeInteger(rpc.id))
    ) throw unavailable();
    try {
      const signal = AbortSignal.any([
        connection.signal,
        AbortSignal.timeout(this.timeoutMs),
      ]);
      const credential = await this.getCredential();
      if (
        !credential || !/^[A-Za-z0-9._~+/:=-]{8,2048}$/.test(credential) ||
        signal.aborted
      ) throw unavailable();
      const reply = await this.request(
        this.endpoint,
        {
          method: "POST",
          headers: {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            "X-API-Key": credential,
            ...(this.#session && { "Mcp-Session-Id": this.#session }),
            ...(this.#protocol && { "MCP-Protocol-Version": this.#protocol }),
          },
          body: message,
          signal,
        },
        undefined,
        {
          maxRedirects: 0,
          isUrlAllowed: (url) => url === this.endpoint,
        },
      );
      if (!reply.ok) throw unavailable();
      const response = reply.value;
      if (!response.ok || notification) {
        await response.body?.cancel();
        if (!response.ok || response.status !== 202) throw unavailable();
        return;
      }
      const result = await readInventoryReply(response, rpc.id!, [
        credential,
        ...(this.#session ? [this.#session] : []),
      ]);
      if (
        !result || credential !== await this.getCredential() || signal.aborted
      ) throw unavailable();
      if (initial) {
        const protocol = result.result?.protocolVersion;
        const session = response.headers.get("mcp-session-id");
        if (
          (protocol !== retainedInventoryProtocolVersion &&
            protocol !== "2025-03-26") ||
          (session !== null &&
            (!/^[A-Za-z0-9._~+/:=-]{1,512}$/.test(session) ||
              session.includes(credential)))
        ) throw unavailable();
        this.#protocol = protocol;
        this.#session = session ?? undefined;
      }
      for (const handler of this.#handlers) handler(JSON.stringify(result));
    } catch {
      throw unavailable();
    }
  }
}
