/**
 * Parent-side filesystem sandbox client.
 *
 * Manages a sandboxed Deno subprocess with NDJSON over stdin/stdout.
 * Permissions are scoped to the taint-appropriate workspace subdirectory;
 * worker is respawned automatically on taint escalation.
 *
 * @module
 */

import { createLogger } from "../../core/logger/logger.ts";
import type { SandboxRequest, SandboxResponse } from "./protocol.ts";

const log = createLogger("fs-sandbox");

/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Interface for the filesystem sandbox client. */
export interface FilesystemSandbox {
  /** Send a request to the sandbox worker and wait for a response. */
  request(req: SandboxRequest): Promise<SandboxResponse>;
  /** Shut down the sandbox worker subprocess. */
  shutdown(): Promise<void>;
}

/** Options for creating a filesystem sandbox. */
export interface FilesystemSandboxOptions {
  /** Resolves the taint-appropriate workspace path. Worker respawns on change. */
  readonly resolveWorkspacePath: () => string;
  /** Request timeout in milliseconds (default: 30000). */
  readonly timeoutMs?: number;
}

/** Pending request awaiting a response from the worker. */
interface PendingRequest {
  readonly resolve: (resp: SandboxResponse) => void;
  readonly reject: (err: Error) => void;
  readonly timer: number;
}

/**
 * Probe whether the Deno runtime is available as a subprocess.
 *
 * Returns false when running as a `deno compile`d binary on a machine
 * without Deno installed — the sandbox requires spawning a child
 * `deno run` process which is impossible without the runtime.
 */
export function probeDenoRuntime(): boolean {
  try {
    const result = new Deno.Command("deno", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).outputSync();
    return result.success;
  } catch {
    log.warn("Deno runtime not found, filesystem sandbox disabled", {
      operation: "probeDenoRuntime",
    });
    return false;
  }
}

/**
 * Extract the worker script to a real temp file for subprocess execution.
 *
 * Needed because `deno compile` embeds sources in a virtual FS that child
 * `deno run` processes cannot access.
 */
function extractWorkerToTempFile(): string {
  const source = Deno.readTextFileSync(import.meta.dirname + "/worker.ts");
  const tmpPath = Deno.makeTempFileSync({ suffix: "_sandbox_worker.ts" });
  Deno.writeTextFileSync(tmpPath, source);
  log.debug("Extracted sandbox worker to temp file", { dest: tmpPath });
  return tmpPath;
}

/**
 * Create a filesystem sandbox backed by a restricted Deno subprocess.
 * Spawned lazily on first request, restarted on crash or taint change.
 */
export function createFilesystemSandbox(
  opts: FilesystemSandboxOptions,
): FilesystemSandbox {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending = new Map<string, PendingRequest>();
  let process: Deno.ChildProcess | null = null;
  let stdinWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let idCounter = 0;
  let shutdownRequested = false;
  let workerTempPath: string | null = null;
  /** The workspace path the current worker was spawned with. */
  let activeWorkspacePath: string | null = null;

  /** Spawn the worker subprocess with restricted permissions. */
  function spawnWorker(workspacePath: string): void {
    if (!workerTempPath) {
      workerTempPath = extractWorkerToTempFile();
    }
    activeWorkspacePath = workspacePath;
    log.debug("Spawning filesystem sandbox worker", {
      workspace: workspacePath,
      workerPath: workerTempPath,
    });
    const cmd = new Deno.Command("deno", {
      args: [
        "run",
        "--no-prompt",
        "--deny-net",
        "--deny-env",
        "--deny-ffi",
        `--allow-read=${workspacePath},${workerTempPath}`,
        `--allow-write=${workspacePath}`,
        "--allow-run=grep,find",
        workerTempPath,
        workspacePath,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    process = cmd.spawn();
    stdinWriter = process.stdin.getWriter();

    startReadLoop(process);
    startStderrDrain(process);
    startExitWatch(process);
  }

  /** Read stdout line-by-line, resolve matching pending promises. */
  function startReadLoop(proc: Deno.ChildProcess): void {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            dispatchResponse(trimmed);
          }
        }
      } catch (err) {
        log.debug("Sandbox worker stdout read loop ended", { err });
      }
    })();
  }

  /** Parse a response line and resolve the matching pending request. */
  function dispatchResponse(line: string): void {
    let resp: SandboxResponse;
    try {
      resp = JSON.parse(line) as SandboxResponse;
    } catch {
      log.warn("Sandbox worker sent unparseable response", { line });
      return;
    }
    const entry = pending.get(resp.id);
    if (!entry) {
      log.warn("Sandbox worker response for unknown request id", {
        id: resp.id,
      });
      return;
    }
    pending.delete(resp.id);
    clearTimeout(entry.timer);
    entry.resolve(resp);
  }

  /** Drain stderr to debug logs. */
  function startStderrDrain(proc: Deno.ChildProcess): void {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true }).trim();
          if (text.length > 0) {
            log.debug("Sandbox worker stderr", { output: text });
          }
        }
      } catch (err) {
        log.debug("Sandbox worker stderr stream closed", { err });
      }
    })();
  }

  /** Watch for process exit, reject all pending, allow respawn. */
  function startExitWatch(proc: Deno.ChildProcess): void {
    proc.status.then((status) => {
      if (process !== proc) return; // stale exit from replaced worker
      log.debug("Sandbox worker exited unexpectedly", {
        code: status.code,
        operation: "startExitWatch",
      });
      process = null;
      stdinWriter = null;
      rejectAllPending("Sandbox worker exited unexpectedly");
    });
  }

  /** Reject all pending requests with an error message. */
  function rejectAllPending(reason: string): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`${reason} (request id: ${id})`));
    }
    pending.clear();
  }

  /**
   * Ensure the worker is running with the correct workspace path.
   * If the taint-resolved path differs from the active worker's path,
   * the old worker is killed and a new one spawned with updated
   * OS-level permissions.
   */
  function ensureWorker(): void {
    if (shutdownRequested) {
      throw new Error("Sandbox has been shut down");
    }
    const requiredPath = opts.resolveWorkspacePath();
    if (process && activeWorkspacePath === requiredPath) {
      return;
    }
    if (process) {
      log.info("Sandbox workspace path changed, respawning worker", {
        previous: activeWorkspacePath,
        current: requiredPath,
      });
      rejectAllPending("Sandbox workspace path changed (taint escalation)");
      try { stdinWriter?.close(); } catch (err) {
        log.debug("Sandbox stdin close during respawn", { err });
      }
      try { process.kill(); } catch (err) {
        log.debug("Sandbox kill during respawn", { err });
      }
      stdinWriter = null;
      process = null;
      activeWorkspacePath = null;
    }
    spawnWorker(requiredPath);
  }

  return {
    request(req: SandboxRequest): Promise<SandboxResponse> {
      ensureWorker();

      const id = String(++idCounter);
      const tagged: SandboxRequest = { ...req, id };
      const encoder = new TextEncoder();

      return new Promise<SandboxResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              `Sandbox request timed out after ${timeoutMs}ms (id: ${id}, op: ${req.op})`,
            ),
          );
          killWorker();
        }, timeoutMs);

        pending.set(id, { resolve, reject, timer });

        const payload = encoder.encode(JSON.stringify(tagged) + "\n");
        stdinWriter!.write(payload).catch((err: unknown) => {
          pending.delete(id);
          clearTimeout(timer);
          log.debug("Sandbox stdin write failed", { err, id, op: req.op });
          reject(
            new Error(
              `Sandbox stdin write failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          );
        });
      });
    },

    async shutdown(): Promise<void> {
      shutdownRequested = true;
      rejectAllPending("Sandbox shutting down");
      await killWorker();
    },
  };

  /** Kill the worker process and clean up. */
  async function killWorker(): Promise<void> {
    if (stdinWriter) {
      try { await stdinWriter.close(); } catch (err) {
        log.debug("Sandbox stdin already closed during kill", { err });
      }
      stdinWriter = null;
    }
    if (process) {
      try { process.kill(); } catch (err) {
        log.debug("Sandbox worker already dead during kill", { err });
      }
      try { await process.status; } catch (err) {
        log.debug("Sandbox worker status already resolved", { err });
      }
      process = null;
    }
    activeWorkspacePath = null;
    if (workerTempPath) {
      try { Deno.removeSync(workerTempPath); } catch (err) {
        log.debug("Sandbox temp file already removed", { err });
      }
      workerTempPath = null;
    }
  }
}
