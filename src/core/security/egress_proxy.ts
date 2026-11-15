/** Local TCP egress mediation. Resolve, validate, then connect to the literal IP. */

import type { Result } from "../types/classification.ts";
import { createLogger } from "../logger/mod.ts";
import { resolveAndCheck } from "./ssrf.ts";
import { readEgressTarget, replyEgressTarget } from "./egress_protocol.ts";

const log = createLogger("egress-proxy");
const HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_CONNECTIONS = 128;

/** Trusted policy callback returning a validated literal IP, never a hostname. */
export type EgressResolver = (
  hostname: string,
  port: number,
) => Promise<Result<string, string>>;

/** A local SOCKSv5 proxy whose TCP destinations are policy checked and pinned. */
export interface EgressProxy {
  readonly url: string;
  /** Stop new connections while allowing existing response bodies to drain. */
  readonly stopAccepting: () => void;
  /** Close the listener and every pending/active tunnel. */
  readonly close: () => Promise<void>;
}

/** Accept only literal addresses so a policy result cannot trigger a second DNS lookup. */
function normalizeLiteralAddress(address: string): string | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
    return address.split(".").every((part) =>
        Number(part) <= 255 && (part === "0" || !part.startsWith("0"))
      )
      ? address
      : null;
  }
  if (!address.includes(":")) return null;
  try {
    return new URL(`http://[${address.replace(/^\[|\]$/g, "")}]`).hostname
      .slice(1, -1);
  } catch {
    return null;
  }
}

/** Close a socket, tolerating a peer or sibling pipe that already closed it. */
function closeConnection(conn: Deno.Conn): void {
  try {
    conn.close();
  } catch (err) {
    if (!(err instanceof Deno.errors.BadResource)) {
      log.debug("Egress socket already closed", {
        operation: "closeConnection",
        err,
      });
    }
  }
}

/** Copy opaque application bytes. TLS stays end-to-end between the client and origin. */
async function forwardTunnel(
  client: Deno.Conn,
  upstream: Deno.Conn,
): Promise<void> {
  const forward = async (from: Deno.Conn, to: Deno.Conn) => {
    try {
      await from.readable.pipeTo(to.writable);
    } catch (err) {
      log.debug("Egress tunnel stream ended", {
        operation: "forwardTunnel",
        err,
      });
    } finally {
      closeConnection(client);
      closeConnection(upstream);
    }
  };
  await Promise.all([forward(client, upstream), forward(upstream, client)]);
}

/** Validate a target and open only the exact returned IP address. */
async function connectApprovedTarget(
  conn: Deno.Conn,
  resolver: EgressResolver,
  signal: AbortSignal,
): Promise<Deno.TcpConn | null> {
  const target = await readEgressTarget(conn);
  if (!target) {
    log.warn(
      "Egress request denied: unsupported or malformed SOCKSv5 request",
      { operation: "connectApprovedTarget" },
    );
    return null;
  }
  const resolved = await resolver(target.hostname, target.port);
  const address = resolved.ok ? normalizeLiteralAddress(resolved.value) : null;
  if (!address) {
    log.warn("Outbound connection blocked by egress policy", {
      operation: "connectApprovedTarget",
      hostname: target.hostname,
      port: target.port,
      reason: resolved.ok
        ? "Policy returned a non-literal address"
        : resolved.error,
    });
    await replyEgressTarget(conn, false);
    return null;
  }
  const upstream = await Deno.connect({
    hostname: address,
    port: target.port,
    signal,
  });
  try {
    await replyEgressTarget(conn, true);
    return upstream;
  } catch (err) {
    closeConnection(upstream);
    throw err;
  }
}

/** Create an ephemeral loopback-only proxy with bounded handshakes and connection count. */
export function createEgressProxy(
  resolver: EgressResolver = resolveAndCheck,
): Result<EgressProxy, string> {
  let listener: Deno.TcpListener;
  try {
    listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  } catch (err) {
    log.error("Egress proxy listener failed", {
      operation: "createEgressProxy",
      err,
    });
    return { ok: false, error: "Egress proxy could not start" };
  }
  const controllers = new Set<AbortController>();
  const tasks = new Set<Promise<void>>();
  let accepting = true;
  const stopAccepting = () => {
    if (!accepting) return;
    accepting = false;
    listener.close();
  };
  const serve = async (client: Deno.TcpConn, controller: AbortController) => {
    const timeout = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
    const abort = () => closeConnection(client);
    controller.signal.addEventListener("abort", abort, { once: true });
    let upstream: Deno.TcpConn | null = null;
    try {
      upstream = await connectApprovedTarget(
        client,
        resolver,
        controller.signal,
      );
      clearTimeout(timeout);
      if (upstream) await forwardTunnel(client, upstream);
    } catch (err) {
      if (controller.signal.aborted) {
        log.debug("Egress connection cancelled", {
          operation: "serveEgressConnection",
          err,
        });
      } else {
        log.warn("Egress connection refused", {
          operation: "serveEgressConnection",
          err,
        });
      }
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", abort);
      controller.abort();
      closeConnection(client);
      if (upstream) closeConnection(upstream);
      controllers.delete(controller);
    }
  };
  const acceptTask = (async () => {
    try {
      for await (const client of listener) {
        if (controllers.size >= MAX_CONNECTIONS) {
          log.warn("Egress connection denied: connection limit reached", {
            operation: "createEgressProxy",
          });
          closeConnection(client);
          continue;
        }
        const controller = new AbortController();
        controllers.add(controller);
        const task = serve(client, controller);
        tasks.add(task);
        void task.then(() => tasks.delete(task));
      }
    } catch (err) {
      if (accepting) {
        log.error("Egress proxy accept failed", {
          operation: "createEgressProxy",
          err,
        });
      }
      stopAccepting();
    }
  })();
  return {
    ok: true,
    value: {
      url: `socks5h://127.0.0.1:${listener.addr.port}`,
      stopAccepting,
      close: async () => {
        stopAccepting();
        for (const controller of controllers) controller.abort();
        await acceptTask;
        await Promise.all(tasks);
      },
    },
  };
}
