/**
 * Parent-side filesystem sandbox client.
 *
 * Manages a sandboxed Deno Worker with OS-level permission restrictions.
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
  /** Shut down the sandbox worker. */
  shutdown(): void;
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
  readonly timer: ReturnType<typeof setInterval>;
}

/**
 * Create a filesystem sandbox backed by a permission-restricted Deno Worker.
 * Spawned lazily on first request, restarted on crash or taint change.
 */
export function createFilesystemSandbox(
  opts: FilesystemSandboxOptions,
): FilesystemSandbox {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const workerUrl = import.meta.resolve("./worker.ts");
  const pending = new Map<string, PendingRequest>();
  let worker: Worker | null = null;
  let idCounter = 0;
  let shutdownRequested = false;
  /** The workspace path the current worker was spawned with. */
  let activeWorkspacePath: string | null = null;

  /** Spawn the worker with restricted permissions scoped to the workspace. */
  function spawnWorker(workspacePath: string): void {
    activeWorkspacePath = workspacePath;
    log.debug("Spawning filesystem sandbox worker", {
      workspace: workspacePath,
    });
    worker = new Worker(workerUrl, {
      type: "module",
      name: "fs-sandbox",
      deno: {
        permissions: {
          read: [workspacePath],
          write: [workspacePath],
          net: false,
          env: false,
          ffi: false,
          run: ["grep", "find"],
        },
      },
    });

    worker.onmessage = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === "ready") {
        log.debug("Sandbox worker initialized", { workspace: workspacePath });
        return;
      }
      dispatchResponse(data as SandboxResponse);
    };

    worker.onerror = (event: ErrorEvent) => {
      log.error("Sandbox worker unhandled error", {
        operation: "workerError",
        err: event.error ?? event.message,
      });
      event.preventDefault();
      terminateWorker();
      rejectAllPending("Sandbox worker encountered an error");
    };

    // Initialize the worker with the workspace path
    worker.postMessage({ type: "init", workspacePath });
  }

  /** Resolve the matching pending request from a worker response. */
  function dispatchResponse(resp: SandboxResponse): void {
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

  /** Reject all pending requests with an error message. */
  function rejectAllPending(reason: string): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`${reason} (request id: ${id})`));
    }
    pending.clear();
  }

  /** Terminate the current worker and clear state. */
  function terminateWorker(): void {
    if (worker) {
      try {
        worker.terminate();
      } catch (err) {
        log.debug("Sandbox worker already terminated", { err });
      }
      worker = null;
    }
    activeWorkspacePath = null;
  }

  /**
   * Ensure the worker is running with the correct workspace path.
   * If the taint-resolved path differs from the active worker's path,
   * the old worker is terminated and a new one spawned with updated
   * OS-level permissions.
   */
  function ensureWorker(): void {
    if (shutdownRequested) {
      throw new Error("Sandbox has been shut down");
    }
    const requiredPath = opts.resolveWorkspacePath();
    if (worker && activeWorkspacePath === requiredPath) {
      return;
    }
    if (worker) {
      log.info("Sandbox workspace path changed, respawning worker", {
        previous: activeWorkspacePath,
        current: requiredPath,
      });
      rejectAllPending("Sandbox workspace path changed (taint escalation)");
      terminateWorker();
    }
    spawnWorker(requiredPath);
  }

  return {
    request(req: SandboxRequest): Promise<SandboxResponse> {
      ensureWorker();

      const id = String(++idCounter);
      const tagged: SandboxRequest = { ...req, id };

      return new Promise<SandboxResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              `Sandbox request timed out after ${timeoutMs}ms (id: ${id}, op: ${req.op})`,
            ),
          );
          rejectAllPending("Sandbox worker timed out, terminating");
          terminateWorker();
        }, timeoutMs);

        pending.set(id, { resolve, reject, timer });

        try {
          worker!.postMessage(tagged);
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          log.debug("Sandbox postMessage failed", { err, id, op: req.op });
          reject(
            new Error(
              `Sandbox postMessage failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          );
        }
      });
    },

    shutdown(): void {
      shutdownRequested = true;
      rejectAllPending("Sandbox shutting down");
      terminateWorker();
    },
  };
}
