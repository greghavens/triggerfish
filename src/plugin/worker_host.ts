/**
 * Host-side plugin sandbox worker management.
 *
 * Spawns `worker_runtime.ts` in a Deno Worker whose permissions are
 * restricted to the plugin's own directory (read) and the manifest's
 * declared endpoints (net). Module imports are limited to public code
 * registries. The worker is spawned lazily on first use and respawned
 * on crash; plugin load and executor initialization replay on respawn.
 *
 * @module
 */

import type { ClassificationLevel } from "../core/types/classification.ts";
import type { Result } from "../core/types/classification.ts";
import { createLogger } from "../core/logger/logger.ts";
import type { PluginLogger } from "./types.ts";

const log = createLogger("plugin-worker");

/** Single tool-call timeout. Load/init share it for simplicity. */
// ponytail: one flat 60s timeout for load, init, and exec; per-op budgets if a slow plugin needs them
const RPC_TIMEOUT_MS = 60_000;

/** Public code registries plugin imports may be fetched from. */
const IMPORT_REGISTRIES = [
  "deno.land",
  "jsr.io",
  "esm.sh",
  "cdn.jsdelivr.net",
  "registry.npmjs.org",
  "unpkg.com",
];

/** Serializable subset of a plugin's exports. Must match worker_runtime.ts. */
export interface SerializedPluginExports {
  readonly manifest: unknown;
  readonly toolDefinitions: unknown;
  readonly systemPrompt?: string;
  readonly hasCreateExecutor: boolean;
}

/** RPC response from the worker. */
interface RpcResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

/** A live sandboxed plugin executor backed by a restricted worker. */
export interface PluginWorker {
  /** Execute a plugin tool inside the sandbox worker. */
  readonly execute: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string | null>;
  /** Terminate the worker. A later execute() respawns it. */
  readonly terminate: () => void;
}

/** Options for creating a sandboxed plugin worker. */
export interface PluginWorkerOptions {
  /** Absolute path to the plugin's mod.ts. */
  readonly modPath: string;
  /** Plugin directory granted read access inside the worker. */
  readonly pluginDir: string;
  /** Manifest-declared endpoints granted net access inside the worker. */
  readonly declaredEndpoints: readonly string[];
  /** Plugin name for context and logging. */
  readonly pluginName: string;
  /** Plugin-specific settings passed into the worker context. */
  readonly pluginConfig: Readonly<Record<string, unknown>>;
  /** Live getter for the current session taint level. */
  readonly getSessionTaint: () => ClassificationLevel;
  /** Logger receiving log messages forwarded from the worker. */
  readonly pluginLog: PluginLogger;
}

/** Map declared endpoints (URLs or bare hosts) to a net allowlist. */
export function resolveNetAllowlist(
  endpoints: readonly string[],
): string[] {
  return endpoints.map((ep) => {
    try {
      return new URL(ep).host;
    } catch {
      return ep;
    }
  }).filter((host) => host.length > 0);
}

/** Spawn a restricted worker for a plugin directory. */
function spawnRestrictedWorker(
  pluginDir: string,
  netAllowlist: readonly string[],
  name: string,
): Worker {
  return new Worker(import.meta.resolve("./worker_runtime.ts"), {
    type: "module",
    name: `plugin-${name}`,
    deno: {
      permissions: {
        read: [pluginDir],
        write: false,
        net: netAllowlist.length > 0 ? [...netAllowlist] : false,
        env: false,
        run: false,
        ffi: false,
        sys: false,
        import: [...IMPORT_REGISTRIES],
      },
    },
  });
}

/** Pending RPC awaiting a worker response. */
interface PendingRpc {
  readonly resolve: (resp: RpcResponse) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Wire a worker's messages into the pending map and plugin logger. */
function attachWorkerHandlers(
  worker: Worker,
  pending: Map<number, PendingRpc>,
  pluginLog: PluginLogger,
  onCrash: (reason: string) => void,
): void {
  worker.onmessage = (event: MessageEvent) => {
    const data = event.data as {
      id?: number;
      log?: {
        level: "debug" | "info" | "warn" | "error";
        msg: string;
        ctx?: Record<string, unknown>;
      };
    };
    if (data?.log) {
      pluginLog[data.log.level](data.log.msg, data.log.ctx);
      return;
    }
    if (typeof data?.id !== "number") return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    entry.resolve(data as RpcResponse);
  };
  worker.onerror = (event: ErrorEvent) => {
    event.preventDefault();
    onCrash(event.message || "Plugin worker crashed");
  };
}

/**
 * Create a sandboxed plugin executor backed by a restricted worker.
 *
 * The worker is spawned lazily on first execute() and respawned after
 * a crash or terminate(); plugin load and init replay on each spawn.
 */
export function createPluginWorker(opts: PluginWorkerOptions): PluginWorker {
  const netAllowlist = resolveNetAllowlist(opts.declaredEndpoints);
  const pending = new Map<number, PendingRpc>();
  let worker: Worker | null = null;
  let ready: Promise<Result<void, string>> | null = null;
  let idCounter = 0;

  function rpc(msg: Record<string, unknown>): Promise<RpcResponse> {
    if (!worker) {
      return Promise.resolve({
        id: 0,
        ok: false,
        error: "Plugin worker is not running",
      });
    }
    return sendWorkerRequest(worker, pending, msg, ++idCounter);
  }

  function teardown(reason: string): void {
    log.warn("Plugin worker terminated", {
      operation: "teardown",
      plugin: opts.pluginName,
      reason,
    });
    worker?.terminate();
    worker = null;
    ready = null;
    rejectAllPending(pending, reason);
  }

  async function loadAndInit(): Promise<Result<void, string>> {
    const loaded = await rpc({ op: "load", modPath: opts.modPath });
    if (!loaded.ok) {
      return {
        ok: false,
        error: loaded.error ?? "Plugin load failed in sandbox worker",
      };
    }
    const inited = await rpc({
      op: "init",
      pluginName: opts.pluginName,
      config: opts.pluginConfig,
      taint: opts.getSessionTaint(),
    });
    if (!inited.ok) {
      return {
        ok: false,
        error: inited.error ?? "Plugin init failed in sandbox worker",
      };
    }
    return { ok: true, value: undefined };
  }

  function ensureReady(): Promise<Result<void, string>> {
    if (worker && ready) return ready;
    log.info("Spawning sandboxed plugin worker", {
      operation: "ensureReady",
      plugin: opts.pluginName,
      pluginDir: opts.pluginDir,
      netAllowlist,
    });
    worker = spawnRestrictedWorker(
      opts.pluginDir,
      netAllowlist,
      opts.pluginName,
    );
    attachWorkerHandlers(worker, pending, opts.pluginLog, teardown);
    ready = loadAndInit();
    return ready;
  }

  return {
    execute: async (name, input) => {
      const readiness = await ensureReady();
      if (!readiness.ok) {
        teardown(readiness.error);
        return `Plugin ${opts.pluginName} error: ${readiness.error}`;
      }
      const resp = await rpc({
        op: "exec",
        name,
        input,
        taint: opts.getSessionTaint(),
      });
      if (!resp.ok) {
        return `Plugin ${opts.pluginName} error: ${
          resp.error ?? "sandbox execution failed"
        }`;
      }
      return resp.value as string | null;
    },
    terminate: () => teardown("Plugin worker shut down by host"),
  };
}

/** Send one request to a worker and await its response with a timeout. */
function sendWorkerRequest(
  worker: Worker,
  pending: Map<number, PendingRpc>,
  msg: Record<string, unknown>,
  id: number,
): Promise<RpcResponse> {
  return new Promise<RpcResponse>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({
        id,
        ok: false,
        error: `Plugin worker request timed out after ${RPC_TIMEOUT_MS}ms`,
      });
    }, RPC_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    worker.postMessage({ ...msg, id });
  });
}

/** Reject every pending request with the given reason. */
function rejectAllPending(
  pending: Map<number, PendingRpc>,
  reason: string,
): void {
  for (const [id, entry] of pending) {
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve({ id, ok: false, error: reason });
  }
}

/**
 * Inspect a plugin module inside a restricted worker without executing
 * it in the host: import runs with read access to the plugin directory
 * only and no network. Returns the serializable exports for validation.
 */
export async function inspectPluginModule(
  modPath: string,
  pluginDir: string,
  pluginLog: PluginLogger,
): Promise<Result<SerializedPluginExports, string>> {
  const pending = new Map<number, PendingRpc>();
  const worker = spawnRestrictedWorker(pluginDir, [], "inspect");
  attachWorkerHandlers(
    worker,
    pending,
    pluginLog,
    (reason) => rejectAllPending(pending, reason),
  );
  try {
    const resp = await sendWorkerRequest(
      worker,
      pending,
      { op: "load", modPath },
      1,
    );
    if (!resp.ok) {
      return { ok: false, error: resp.error ?? "Plugin inspection failed" };
    }
    return { ok: true, value: resp.value as SerializedPluginExports };
  } finally {
    worker.terminate();
  }
}
