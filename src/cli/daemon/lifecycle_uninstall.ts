/**
 * Daemon uninstall and cleanup: remove service definitions and old binaries.
 * @module
 */

import {
  detectDaemonManager,
  encodeUtf16Base64,
  invokeCommand,
  invokeElevatedCommand,
  launchdPlistPath,
  SCHTASKS_TASK_NAME,
  SYSTEMD_UNIT,
  systemdUnitPath,
  WINDOWS_SERVICE_NAME,
} from "./daemon.ts";
import type { DaemonResult } from "./daemon.ts";
import { stopDaemon } from "./lifecycle_stop.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("cli.daemon.uninstall");

/** Uninstall launchd daemon (macOS). */
async function uninstallLaunchdDaemon(): Promise<DaemonResult> {
  try {
    await Deno.remove(launchdPlistPath());
  } catch (err) {
    log.debug("Launchd plist already removed", { operation: "uninstallLaunchdDaemon", err });
  }
  return { ok: true, message: "Daemon uninstalled" };
}

/** Uninstall systemd daemon (Linux). */
async function uninstallSystemdDaemon(): Promise<DaemonResult> {
  await invokeCommand("systemctl", ["--user", "disable", SYSTEMD_UNIT]);
  try {
    await Deno.remove(systemdUnitPath());
  } catch (err) {
    log.debug("Systemd unit file already removed", { operation: "uninstallSystemdDaemon", err });
  }
  await invokeCommand("systemctl", ["--user", "daemon-reload"]);
  return { ok: true, message: "Daemon uninstalled" };
}

/** Uninstall Windows Service. */
async function uninstallWindowsService(): Promise<DaemonResult> {
  const script = [
    `Stop-Service -Name '${WINDOWS_SERVICE_NAME}' -Force -ErrorAction SilentlyContinue`,
    `Start-Sleep -Seconds 2`,
    `sc.exe delete '${WINDOWS_SERVICE_NAME}' | Out-Null`,
    `schtasks /delete /tn '${SCHTASKS_TASK_NAME}' /f 2>$null | Out-Null`,
  ].join("; ");
  await invokeElevatedCommand(encodeUtf16Base64(script));
  const verifyResult = await invokeCommand("sc", [
    "query",
    WINDOWS_SERVICE_NAME,
  ]);
  const removed = !verifyResult.success ||
    verifyResult.stderr.includes("1060");
  return removed ? { ok: true, message: "Daemon uninstalled" } : {
    ok: false,
    message: "Failed to uninstall daemon. Try running from an admin terminal.",
  };
}

/**
 * Uninstall the Triggerfish daemon completely.
 *
 * Stops the daemon and removes the service definition.
 *
 * @returns Result indicating success or failure.
 */
export async function uninstallDaemon(): Promise<DaemonResult> {
  await stopDaemon();
  const manager = detectDaemonManager();
  switch (manager) {
    case "launchd":
      return uninstallLaunchdDaemon();
    case "systemd":
      return uninstallSystemdDaemon();
    case "windows-service":
      return uninstallWindowsService();
    default:
      return { ok: false, message: `Unsupported daemon manager: ${manager}` };
  }
}

/**
 * Clean up leftover `.old` binary from a previous Windows update.
 *
 * On Windows, the update process renames the running binary to `{path}.old`
 * before placing the new one. This function removes the `.old` file if present.
 * Safe to call on any platform -- no-ops on Unix.
 */
export async function cleanupOldBinary(): Promise<void> {
  if (Deno.build.os !== "windows") return;
  try {
    const execPath = Deno.execPath();
    const oldPath = `${execPath}.old`;
    await Deno.remove(oldPath);
  } catch (err) {
    log.debug("Old binary cleanup skipped — not present or inaccessible", { operation: "cleanupOldBinary", err });
  }
}
