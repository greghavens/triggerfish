/**
 * Daemon status queries: check whether the daemon is running on each OS.
 * @module
 */

import {
  detectDaemonManager,
  invokeCommand,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  WINDOWS_SERVICE_NAME,
} from "./daemon.ts";
import type { DaemonStatus } from "./daemon.ts";

/** Get launchd daemon status (macOS). */
async function getLaunchdStatus(): Promise<DaemonStatus> {
  const result = await invokeCommand("launchctl", ["list", LAUNCHD_LABEL]);
  if (result.success) {
    const pidMatch = result.stdout.match(/"PID"\s*=\s*(\d+)/);
    return {
      running: true,
      pid: pidMatch ? parseInt(pidMatch[1], 10) : undefined,
      manager: "launchd",
      message: `Daemon is running (launchd: ${LAUNCHD_LABEL})`,
    };
  }
  return {
    running: false,
    manager: "launchd",
    message: "Daemon is not running",
  };
}

/** Fetch PID and uptime from systemctl show output. */
async function fetchSystemdRunningDetails(): Promise<DaemonStatus> {
  const showResult = await invokeCommand("systemctl", [
    "--user",
    "show",
    SYSTEMD_UNIT,
    "--property=MainPID,ActiveEnterTimestamp",
  ]);
  const pidMatch = showResult.stdout.match(/MainPID=(\d+)/);
  const tsMatch = showResult.stdout.match(/ActiveEnterTimestamp=(.+)/);
  return {
    running: true,
    pid: pidMatch ? parseInt(pidMatch[1], 10) : undefined,
    uptime: tsMatch ? tsMatch[1] : undefined,
    manager: "systemd",
    message: `Daemon is running (systemd: ${SYSTEMD_UNIT})`,
  };
}

/** Get systemd daemon status (Linux). */
async function getSystemdStatus(): Promise<DaemonStatus> {
  const result = await invokeCommand("systemctl", [
    "--user",
    "is-active",
    SYSTEMD_UNIT,
  ]);
  if (result.stdout !== "active") {
    return {
      running: false,
      manager: "systemd",
      message: "Daemon is not running",
    };
  }
  return fetchSystemdRunningDetails();
}

/** Get Windows Service daemon status. */
async function getWindowsServiceStatus(): Promise<DaemonStatus> {
  const result = await invokeCommand("sc", ["query", WINDOWS_SERVICE_NAME]);
  if (!(result.success && result.stdout.includes("RUNNING"))) {
    return {
      running: false,
      manager: "windows-service",
      message: "Daemon is not running",
    };
  }
  const tasklistResult = await invokeCommand("tasklist", [
    "/fi",
    "imagename eq triggerfish.exe",
    "/fo",
    "CSV",
    "/nh",
  ]);
  const pidMatch = tasklistResult.stdout.match(/"triggerfish\.exe","(\d+)"/);
  return {
    running: true,
    pid: pidMatch ? parseInt(pidMatch[1], 10) : undefined,
    manager: "windows-service",
    message: `Daemon is running (Windows Service: ${WINDOWS_SERVICE_NAME})`,
  };
}

/**
 * Get the current status of the Triggerfish daemon.
 *
 * @returns Status information including whether the daemon is running.
 */
// deno-lint-ignore require-await
export async function fetchDaemonStatus(): Promise<DaemonStatus> {
  const manager = detectDaemonManager();
  switch (manager) {
    case "launchd":
      return getLaunchdStatus();
    case "systemd":
      return getSystemdStatus();
    case "windows-service":
      return getWindowsServiceStatus();
    default:
      return {
        running: false,
        manager,
        message: `Unsupported daemon manager: ${manager}`,
      };
  }
}

/** @deprecated Use fetchDaemonStatus instead */
export const getDaemonStatus = fetchDaemonStatus;
