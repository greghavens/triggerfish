/**
 * Plugin sandbox worker — runs inside a permission-restricted Deno Worker.
 *
 * The parent (`worker_host.ts`) spawns this worker with permissions
 * limited to the plugin's own directory (read) and the manifest's
 * declared endpoints (net); env, run, write, ffi and sys are denied.
 * The plugin module is imported and executed entirely inside this
 * worker, so its top-level code and executors never gain daemon
 * permissions.
 *
 * Must not import the core logger (file logging is not permitted in
 * the sandbox) — plugin logs are forwarded to the host via postMessage.
 *
 * @module
 */

import type {
  PluginContext,
  PluginExports,
  PluginToolExecutor,
} from "./types.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";

/** Request messages from the host. Must match worker_host.ts. */
interface WorkerRequest {
  readonly id: number;
  readonly op: "load" | "init" | "exec";
  readonly modPath?: string;
  readonly pluginName?: string;
  readonly config?: Record<string, unknown>;
  readonly taint?: ClassificationLevel;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
}

/** Serializable subset of a plugin's exports sent back on load. */
interface SerializedExports {
  readonly manifest: unknown;
  readonly toolDefinitions: unknown;
  readonly systemPrompt?: string;
  readonly hasCreateExecutor: boolean;
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(data: unknown): void;
};

let pluginModule: PluginExports | null = null;
let executor: PluginToolExecutor | null = null;
let currentTaint: ClassificationLevel = "PUBLIC";

function reply(id: number, ok: boolean, value?: unknown, error?: string): void {
  workerScope.postMessage({ id, ok, value, error });
}

function forwardLog(
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  ctx?: Record<string, unknown>,
): void {
  workerScope.postMessage({ log: { level, msg, ctx } });
}

async function handleLoad(modPath: string): Promise<SerializedExports> {
  const mod = (await import(modPath)) as PluginExports;
  pluginModule = mod;
  return {
    manifest: mod.manifest,
    toolDefinitions: mod.toolDefinitions,
    systemPrompt: mod.systemPrompt,
    hasCreateExecutor: typeof mod.createExecutor === "function",
  };
}

async function handleInit(
  pluginName: string,
  config: Record<string, unknown>,
): Promise<null> {
  if (!pluginModule) throw new Error("Plugin module not loaded before init");
  const context: PluginContext = {
    pluginName,
    getSessionTaint: () => currentTaint,
    // Taint escalation is handled by the gateway layer, mirroring the
    // host-side PluginContext — plugins cannot directly escalate taint.
    escalateTaint: () => {},
    log: {
      debug: (msg, ctx) => forwardLog("debug", msg, ctx),
      info: (msg, ctx) => forwardLog("info", msg, ctx),
      warn: (msg, ctx) => forwardLog("warn", msg, ctx),
      error: (msg, ctx) => forwardLog("error", msg, ctx),
    },
    config,
  };
  executor = await pluginModule.createExecutor(context);
  return null;
}

async function handleExec(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (!executor) throw new Error("Plugin executor not initialized before exec");
  return await executor(name, input);
}

async function dispatchRequest(req: WorkerRequest): Promise<unknown> {
  switch (req.op) {
    case "load":
      return await handleLoad(req.modPath ?? "");
    case "init":
      currentTaint = req.taint ?? "PUBLIC";
      return await handleInit(req.pluginName ?? "", req.config ?? {});
    case "exec":
      currentTaint = req.taint ?? currentTaint;
      return await handleExec(req.name ?? "", req.input ?? {});
    default:
      throw new Error(`Plugin worker received unknown operation: ${req.op}`);
  }
}

workerScope.onmessage = async (event: MessageEvent) => {
  const req = event.data as WorkerRequest;
  try {
    reply(req.id, true, await dispatchRequest(req));
  } catch (err) {
    reply(
      req.id,
      false,
      undefined,
      err instanceof Error ? err.message : String(err),
    );
  }
};

workerScope.postMessage({ ready: true });
