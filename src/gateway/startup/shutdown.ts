/**
 * Graceful shutdown handlers for the Triggerfish gateway.
 *
 * Provides SIGTERM/SIGINT listeners, service teardown, and
 * logger drain on process exit.
 *
 * @module
 */

import type { createLogger } from "../../core/logger/mod.ts";
import { shutdownLogger } from "../../core/logger/mod.ts";

/** Dependencies for the shutdown handler. */
export interface ShutdownDeps {
  signalDaemonState: {
    handle: { child: { kill(signo?: number | Deno.Signal): void } } | null;
  };
  schedulerService: { stop(): void };
  sentinelAssessment?: { stop(): void };
  server: { stop(): Promise<void> };
  tidepoolHost: { stop(): Promise<void> };
  memoryDb: { close(): void };
  storage: { close(): Promise<void> };
  log: ReturnType<typeof createLogger>;
}

/** Kill the Signal daemon child process if it is running. */
export function stopSignalDaemon(deps: ShutdownDeps): void {
  if (!deps.signalDaemonState.handle) return;
  try {
    deps.signalDaemonState.handle.child.kill("SIGTERM");
  } catch { /* already dead */ }
  deps.signalDaemonState.handle = null;
}

/** Stop all services and close resources in order. */
export async function stopAllServices(deps: ShutdownDeps): Promise<void> {
  deps.sentinelAssessment?.stop();
  try {
    deps.schedulerService.stop();
  } catch { /* best effort */ }
  try {
    await deps.server.stop();
  } catch { /* best effort */ }
  try {
    await deps.tidepoolHost.stop();
  } catch { /* best effort */ }
  try {
    deps.memoryDb.close();
  } catch { /* best effort */ }
  try {
    await deps.storage.close();
  } catch { /* best effort */ }
}

/** Drain the logger after all services have stopped. */
export async function drainLoggerOnShutdown(): Promise<void> {
  try {
    await shutdownLogger();
  } catch { /* best effort */ }
}

/** Attach SIGTERM/SIGINT listeners that trigger graceful shutdown. */
export function addSignalListeners(handler: () => void): void {
  try {
    Deno.addSignalListener("SIGTERM", handler);
  } catch { /* not supported on all platforms */ }
  try {
    Deno.addSignalListener("SIGINT", handler);
  } catch { /* not supported on all platforms */ }
}

/** Register SIGTERM/SIGINT handlers for graceful shutdown. */
export function registerShutdownHandlers(deps: ShutdownDeps): void {
  let shuttingDown = false;
  const handleShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.log.info("Shutting down...");
    stopSignalDaemon(deps);
    await stopAllServices(deps);
    deps.log.info("Shutdown complete");
    await drainLoggerOnShutdown();
    Deno.exit(0);
  };
  addSignalListeners(() => {
    handleShutdown();
  });
}
