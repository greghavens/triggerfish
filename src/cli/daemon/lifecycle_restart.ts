/**
 * Daemon restart operations: stop, wait for completion, then start.
 * @module
 */

import type { DaemonResult, DaemonStatus } from "./daemon.ts";
import { fetchDaemonStatus } from "./lifecycle_status.ts";
import { installAndStartDaemon } from "./lifecycle_install.ts";
import { stopDaemon } from "./lifecycle_stop.ts";

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 5000;

/** Injectable dependencies for restart — enables unit testing. */
export interface RestartDeps {
  readonly stopDaemon: () => Promise<DaemonResult>;
  readonly getDaemonStatus: () => Promise<DaemonStatus>;
  readonly installAndStartDaemon: (binaryPath: string) => Promise<DaemonResult>;
  readonly pollIntervalMs: number;
  readonly pollTimeoutMs: number;
}

const defaultDeps: RestartDeps = {
  stopDaemon,
  getDaemonStatus: fetchDaemonStatus,
  installAndStartDaemon,
  pollIntervalMs: POLL_INTERVAL_MS,
  pollTimeoutMs: POLL_TIMEOUT_MS,
};

/**
 * Poll daemon status until it reports not running or timeout is reached.
 *
 * @returns True if the daemon stopped within the timeout, false otherwise.
 */
async function awaitDaemonStopped(deps: RestartDeps): Promise<boolean> {
  const deadline = Date.now() + deps.pollTimeoutMs;
  while (Date.now() < deadline) {
    const status = await deps.getDaemonStatus();
    if (!status.running) return true;
    await new Promise((resolve) => setTimeout(resolve, deps.pollIntervalMs));
  }
  return false;
}

/**
 * Restart the Triggerfish daemon: stop, wait for exit, then start.
 *
 * @param binaryPath - Absolute path to the triggerfish binary.
 * @param deps - Injectable dependencies (defaults to real implementations).
 * @returns Result indicating success or failure.
 */
export async function restartDaemon(
  binaryPath: string,
  deps: RestartDeps = defaultDeps,
): Promise<DaemonResult> {
  const stopResult = await deps.stopDaemon();
  if (!stopResult.ok) {
    return {
      ok: false,
      message: `Restart failed (stop): ${stopResult.message}`,
    };
  }

  const stopped = await awaitDaemonStopped(deps);
  if (!stopped) {
    return {
      ok: false,
      message:
        `Restart failed: daemon did not stop within ${deps.pollTimeoutMs}ms`,
    };
  }

  return deps.installAndStartDaemon(binaryPath);
}
