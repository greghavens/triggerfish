/**
 * Self-update orchestrator: coordinate download, verification, binary swap,
 * and daemon restart.
 * @module
 */

import { VERSION } from "../../version.ts";
import {
  fetchDaemonStatus,
  installAndStartDaemon,
  stopDaemon,
} from "../lifecycle.ts";
import { findInstalledBinary, replaceBinary } from "./binary.ts";
import { fetchAndVerifyRelease } from "./download.ts";
import { fetchLatestRelease } from "./release.ts";
import { createLogger } from "../../../core/logger/mod.ts";

const log = createLogger("cli.updater");

/** Result of an update operation. */
export interface UpdateResult {
  readonly ok: boolean;
  readonly message: string;
  readonly previousVersion?: string;
  readonly newVersion?: string;
  /** Whether the daemon was running before the update began. */
  readonly wasRunning?: boolean;
}

/** Check whether the current version already matches the latest. */
function checkAlreadyUpToDate(latestTag: string): UpdateResult | null {
  if (VERSION !== "dev" && VERSION === latestTag) {
    return {
      ok: true,
      message: `Already up to date (${VERSION})`,
      previousVersion: VERSION,
      newVersion: latestTag,
    };
  }
  return null;
}

/** Replace the binary and restart daemon if needed. */
async function performBinarySwap(
  tmpPath: string,
  binaryPath: string,
  wasRunning: boolean,
): Promise<string | null> {
  log.info("Replacing binary", {
    operation: "applyUpdate",
    step: "replaceBinary",
  });
  console.log("  Replacing binary...");
  try {
    await replaceBinary(tmpPath, binaryPath);
  } catch (e) {
    log.error("Binary replacement failed", {
      operation: "applyUpdate",
      err: e,
    });
    if (wasRunning) {
      console.log("  Restarting daemon with old binary...");
      await installAndStartDaemon(binaryPath);
    }
    try {
      await Deno.remove(tmpPath);
    } catch { /* cleanup */ }
    return `Failed to replace binary: ${e}`;
  }
  if (wasRunning) {
    console.log("  Restarting daemon...");
    await installAndStartDaemon(binaryPath);
  }
  return null;
}

/** Stop the daemon if running, swap the binary, and restart if needed. */
async function stopAndSwapBinary(tmpPath: string): Promise<{
  wasRunning: boolean;
  error?: string;
}> {
  const binaryPath = await findInstalledBinary();
  const wasRunning = (await fetchDaemonStatus()).running;
  if (wasRunning) {
    log.info("Stopping daemon for update", {
      operation: "applyUpdate",
      step: "stopDaemon",
    });
    console.log("  Stopping daemon...");
    await stopDaemon();
  }
  const swapError = await performBinarySwap(tmpPath, binaryPath, wasRunning);
  return { wasRunning, error: swapError ?? undefined };
}

/** Build the success result after a completed update. */
function buildSuccessResult(
  latestTag: string,
  wasRunning: boolean,
): UpdateResult {
  return {
    ok: true,
    message: `Updated from ${VERSION} to ${latestTag}`,
    previousVersion: VERSION,
    newVersion: latestTag,
    wasRunning,
  };
}

/**
 * Update Triggerfish to the latest tagged release.
 *
 * Downloads the platform binary from the latest GitHub release, verifies
 * its SHA256 checksum, stops the running daemon, replaces the binary
 * in-process (no detached child), and restarts the daemon if it was running.
 *
 * @returns Result indicating success or failure with version information.
 */
export async function upgradeTriggerfish(): Promise<UpdateResult> {
  console.log("Checking for updates...");
  const release = await fetchLatestRelease();
  if ("error" in release) return { ok: false, message: release.error };
  const { tag: latestTag } = release.metadata;

  const upToDate = checkAlreadyUpToDate(latestTag);
  if (upToDate) return upToDate;

  console.log(`  Current: ${VERSION}`);
  console.log(`  Latest:  ${latestTag}`);

  const downloaded = await fetchAndVerifyRelease(release.metadata);
  if ("error" in downloaded) return { ok: false, message: downloaded.error };

  const swap = await stopAndSwapBinary(downloaded.tmpPath);
  if (swap.error) return { ok: false, message: swap.error };

  return buildSuccessResult(latestTag, swap.wasRunning);
}

/** @deprecated Use upgradeTriggerfish instead */
export const updateTriggerfish = upgradeTriggerfish;
