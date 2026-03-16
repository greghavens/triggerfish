/**
 * Daemon stop operations: halt the running daemon on each OS.
 * @module
 */

import {
  detectDaemonManager,
  encodeUtf16Base64,
  invokeCommand,
  invokeElevatedCommand,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  WINDOWS_SERVICE_NAME,
} from "./daemon.ts";
import type { DaemonResult } from "./daemon.ts";

/** Stop launchd daemon (macOS). */
async function stopLaunchdDaemon(): Promise<DaemonResult> {
  const uid = Deno.uid?.() ?? (await invokeCommand("id", ["-u"])).stdout.trim();
  const target = `gui/${uid}/${LAUNCHD_LABEL}`;
  const result = await invokeCommand("launchctl", ["bootout", target]);
  return result.success
    ? { ok: true, message: "Daemon stopped" }
    : { ok: false, message: `Failed to stop daemon: ${result.stderr}` };
}

/** Stop systemd daemon (Linux). */
async function stopSystemdDaemon(): Promise<DaemonResult> {
  const result = await invokeCommand("systemctl", [
    "--user",
    "stop",
    SYSTEMD_UNIT,
  ]);
  return result.success
    ? { ok: true, message: "Daemon stopped" }
    : { ok: false, message: `Failed to stop daemon: ${result.stderr}` };
}

/** Stop Windows Service and verify it stopped. */
async function stopWindowsServiceDaemon(): Promise<DaemonResult> {
  const stopScript = [
    `Stop-Service -Name '${WINDOWS_SERVICE_NAME}' -Force -ErrorAction Stop`,
    `Start-Sleep -Seconds 2`,
  ].join("; ");
  await invokeElevatedCommand(encodeUtf16Base64(stopScript));

  const verifyResult = await invokeCommand("sc", [
    "query",
    WINDOWS_SERVICE_NAME,
  ]);
  const stopped = verifyResult.stdout.includes("STOPPED") ||
    !verifyResult.success;
  return stopped ? { ok: true, message: "Daemon stopped" } : {
    ok: false,
    message: "Failed to stop daemon. Try running from an admin terminal.",
  };
}

/**
 * Stop the Triggerfish daemon.
 *
 * @returns Result indicating success or failure.
 */
// deno-lint-ignore require-await
export async function stopDaemon(): Promise<DaemonResult> {
  const manager = detectDaemonManager();
  switch (manager) {
    case "launchd":
      return stopLaunchdDaemon();
    case "systemd":
      return stopSystemdDaemon();
    case "windows-service":
      return stopWindowsServiceDaemon();
    default:
      return { ok: false, message: `Unsupported daemon manager: ${manager}` };
  }
}
