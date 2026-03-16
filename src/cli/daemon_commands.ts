/**
 * Daemon lifecycle CLI commands.
 *
 * Handles start, stop, status, logs, and update operations for the
 * Triggerfish daemon process.
 *
 * @module
 */

import { Confirm } from "@cliffy/prompt";
import {
  bundleLogs,
  fetchDaemonStatus,
  installAndStartDaemon,
  restartDaemon,
  stopDaemon,
  tailLogs,
  upgradeTriggerfish,
} from "./daemon/daemon.ts";
import {
  type DaemonState,
  daemonStatePath,
  TIDEPOOL_PORT,
} from "./constants.ts";
import { fetchChangelogRange } from "./daemon/updater/changelog.ts";
import { formatChangelogPlainText } from "./daemon/updater/changelog_format.ts";
import { createLogger } from "../core/logger/mod.ts";

const log = createLogger("cli.daemon");

// ─── Daemon status ────────────────────────────────────────────────────────────

/** Show daemon status. */
export async function reportDaemonStatus(): Promise<void> {
  const status = await fetchDaemonStatus();

  if (status.running) {
    console.log("✓ Triggerfish is running");
    if (status.pid) console.log(`  PID: ${status.pid}`);
    if (status.uptime) console.log(`  Since: ${status.uptime}`);
    console.log(`  Manager: ${status.manager}`);
  } else {
    console.log("✗ Triggerfish is not running");
    console.log("\nRun 'triggerfish start' to launch the daemon.");
  }
}

// ─── Daemon start / stop ──────────────────────────────────────────────────────

/** Remove stale daemon state file so we only read fresh state after start. */
async function clearDaemonState(): Promise<void> {
  try {
    await Deno.remove(daemonStatePath());
  } catch {
    // File may not exist — that's fine.
  }
}

/**
 * Poll for the daemon state file until it appears or timeout.
 *
 * The daemon writes `daemon.json` after Tidepool is listening.
 * Returns null if the file does not appear within the deadline.
 */
async function waitForDaemonState(
  timeoutMs: number = 10_000,
): Promise<DaemonState | null> {
  const statePath = daemonStatePath();
  const deadline = Date.now() + timeoutMs;
  const pollMs = 500;

  while (Date.now() < deadline) {
    try {
      const text = await Deno.readTextFile(statePath);
      return JSON.parse(text) as DaemonState;
    } catch {
      // Not ready yet — wait and retry.
    }
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
  return null;
}

/** Install the Triggerfish daemon and start it. */
export async function launchDaemon(): Promise<void> {
  await clearDaemonState();
  const result = await installAndStartDaemon(Deno.execPath());
  if (result.ok) {
    console.log("✓ Daemon installed and started");
    const state = await waitForDaemonState();
    if (state) {
      console.log(`  Tidepool: ${state.tidepoolUrl}`);
    } else {
      console.log(
        `  Tidepool: http://127.0.0.1:${TIDEPOOL_PORT} (waiting for daemon — run 'triggerfish status' to check)`,
      );
    }
  } else {
    log.error("Daemon start failed", {
      operation: "startDaemon",
      message: result.message,
    });
    console.log(`✗ ${result.message}`);
    Deno.exit(1);
  }
}

/** Stop the Triggerfish daemon. */
export async function haltDaemon(): Promise<void> {
  const result = await stopDaemon();
  if (result.ok) {
    console.log("✓ Daemon stopped");
  } else {
    log.error("Daemon stop failed", {
      operation: "stopDaemon",
      message: result.message,
    });
    console.log(`✗ ${result.message}`);
    Deno.exit(1);
  }
}

/** Restart the Triggerfish daemon (stop, wait, start). */
export async function restartDaemonProcess(): Promise<void> {
  const result = await restartDaemon(Deno.execPath());
  if (result.ok) {
    console.log("✓ Daemon restarted");
  } else {
    log.error("Daemon restart failed", {
      operation: "restartDaemon",
      message: result.message,
    });
    console.log(`✗ ${result.message}`);
    Deno.exit(1);
  }
}

// ─── Daemon logs ──────────────────────────────────────────────────────────────

/**
 * Tail or bundle daemon logs.
 *
 * Subcommands:
 * - `view` (default) -- stream the log file to stdout, optionally following.
 * - `bundle` -- copy all log files to a temporary directory and print the path.
 */
export async function displayDaemonLogs(
  subcommand: string | undefined,
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  if (subcommand === "bundle") {
    await bundleLogs();
    return;
  }
  // "view" or no subcommand -> old streaming behaviour
  const follow = flags.tail === true;
  const levelFilter = typeof flags.level === "string" ? flags.level : undefined;
  await tailLogs(follow, 50, levelFilter);
}

// ─── Update ───────────────────────────────────────────────────────────────────

/** Prompt user to start daemon if it was not running after update. */
async function promptDaemonStartAfterUpdate(): Promise<void> {
  const startIt = await Confirm.prompt({
    message: "Daemon was not running. Start it now?",
    default: true,
  });
  if (!startIt) return;
  const startResult = await installAndStartDaemon(Deno.execPath());
  console.log(startResult.ok ? "✓ Daemon started" : `✗ ${startResult.message}`);
}

/** Display release notes between old and new version after update. */
async function displayPostUpdateChangelog(
  previousVersion: string,
  newVersion: string,
): Promise<void> {
  try {
    const changelog = await fetchChangelogRange(previousVersion, newVersion);
    if (changelog.ok && changelog.value.releases.length > 0) {
      console.log("\nWhat's new:\n");
      console.log(formatChangelogPlainText(changelog.value));
    }
  } catch (err) {
    // Non-critical: log but don't disrupt update flow
    log.warn("Changelog fetch failed after update", {
      operation: "displayPostUpdateChangelog",
      err,
    });
  }
}

/** Handle a successful update result (new version or already up to date). */
async function handleUpdateSuccess(result: {
  readonly previousVersion?: string;
  readonly newVersion?: string;
  readonly message: string;
  readonly wasRunning?: boolean;
}): Promise<void> {
  if (result.previousVersion === result.newVersion) {
    console.log("✓ Already up to date (" + result.newVersion + ")");
    return;
  }
  console.log("✓", result.message);
  if (
    result.previousVersion && result.newVersion &&
    result.previousVersion !== result.newVersion
  ) {
    await displayPostUpdateChangelog(result.previousVersion, result.newVersion);
  }
  if (result.wasRunning) {
    console.log("\nRun 'triggerfish status' to verify the daemon restarted.");
  } else {
    await promptDaemonStartAfterUpdate();
  }
}

/** Download and install the latest release binary. */
export async function installUpdate(): Promise<void> {
  console.log("Updating Triggerfish...\n");
  const result = await upgradeTriggerfish();
  if (result.ok) {
    await handleUpdateSuccess(result);
  } else {
    log.error("Triggerfish self-update failed", {
      operation: "updateTriggerfish",
      message: result.message,
    });
    console.log("✗", result.message);
    Deno.exit(1);
  }
}

/** @deprecated Use reportDaemonStatus instead */
export const runDaemonStatus = reportDaemonStatus;

/** @deprecated Use launchDaemon instead */
export const runDaemonStart = launchDaemon;

/** @deprecated Use haltDaemon instead */
export const runDaemonStop = haltDaemon;

/** @deprecated Use restartDaemonProcess instead */
export const runDaemonRestart = restartDaemonProcess;

/** @deprecated Use displayDaemonLogs instead */
export const runDaemonLogs = displayDaemonLogs;

/** @deprecated Use installUpdate instead */
export const runUpdate = installUpdate;
