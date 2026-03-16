/**
 * Daemon install operations: write service definitions and start the daemon.
 * @module
 */

import {
  detectDaemonManager,
  encodeUtf16Base64,
  generateLaunchdPlist,
  generateSystemdUnit,
  invokeCommand,
  invokeElevatedCommand,
  LAUNCHD_LABEL,
  launchdPlistPath,
  logDir,
  SYSTEMD_UNIT,
  systemdUnitPath,
  WINDOWS_SERVICE_NAME,
} from "./daemon.ts";
import type { DaemonResult } from "./daemon.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("cli.daemon");

/** Install and start via launchd (macOS). */
async function installLaunchdDaemon(
  binaryPath: string,
): Promise<DaemonResult> {
  const plist = generateLaunchdPlist({ binaryPath });
  const plistPath = launchdPlistPath();
  const launchAgentsDir = `${Deno.env.get("HOME")}/Library/LaunchAgents`;
  await Deno.mkdir(launchAgentsDir, { recursive: true });
  await Deno.writeTextFile(plistPath, plist);
  const uid = Deno.uid?.() ?? (await invokeCommand("id", ["-u"])).stdout.trim();
  const domain = `gui/${uid}`;
  // Use bootout/bootstrap instead of unload/load to clear throttle state
  await invokeCommand("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
  const result = await invokeCommand("launchctl", [
    "bootstrap",
    domain,
    plistPath,
  ]);
  if (!result.success) {
    return { ok: false, message: `Failed to start daemon: ${result.stderr}` };
  }
  // Kickstart ensures the process actually launches immediately
  await invokeCommand("launchctl", [
    "kickstart",
    `${domain}/${LAUNCHD_LABEL}`,
  ]);
  return {
    ok: true,
    message: `Daemon installed and started (launchd: ${LAUNCHD_LABEL})`,
  };
}

/** Install and start via systemd (Linux). */
async function installSystemdDaemon(
  binaryPath: string,
): Promise<DaemonResult> {
  const unit = generateSystemdUnit({ binaryPath });
  const unitPath = systemdUnitPath();
  const unitDir = `${Deno.env.get("HOME")}/.config/systemd/user`;
  await Deno.mkdir(unitDir, { recursive: true });
  await Deno.writeTextFile(unitPath, unit);

  const lingerResult = await invokeCommand("loginctl", [
    "enable-linger",
    Deno.env.get("USER") ?? "",
  ]);
  if (!lingerResult.success) {
    log.warn("Linger enable failed", {
      operation: "installDaemon",
      stderr: lingerResult.stderr,
    });
    console.log(
      "  \u26a0 Could not enable linger (daemon will stop on logout):",
      lingerResult.stderr,
    );
    console.log("    Fix: sudo loginctl enable-linger $USER");
  }

  await invokeCommand("systemctl", ["--user", "daemon-reload"]);
  await invokeCommand("systemctl", ["--user", "enable", SYSTEMD_UNIT]);
  const result = await invokeCommand("systemctl", [
    "--user",
    "start",
    SYSTEMD_UNIT,
  ]);
  return result.success
    ? {
      ok: true,
      message: `Daemon installed and started (systemd: ${SYSTEMD_UNIT})`,
    }
    : { ok: false, message: `Failed to start daemon: ${result.stderr}` };
}

/** Query Windows Service state and return early result if not startable. */
async function queryWindowsServiceState(): Promise<DaemonResult | null> {
  const queryResult = await invokeCommand("sc", [
    "query",
    WINDOWS_SERVICE_NAME,
  ]);
  if (!queryResult.success) {
    return {
      ok: false,
      message:
        `Windows Service '${WINDOWS_SERVICE_NAME}' is not installed. Re-run the installer to set it up.`,
    };
  }
  if (queryResult.stdout.includes("RUNNING")) {
    return {
      ok: true,
      message:
        `Daemon is already running (Windows Service: ${WINDOWS_SERVICE_NAME})`,
    };
  }
  return null;
}

/** Issue the start command and verify the service is running. */
async function issueWindowsServiceStart(): Promise<DaemonResult> {
  const startScript = [
    `Start-Service -Name '${WINDOWS_SERVICE_NAME}' -ErrorAction Stop`,
    `Start-Sleep -Seconds 2`,
  ].join("; ");
  await invokeElevatedCommand(encodeUtf16Base64(startScript));

  const verifyResult = await invokeCommand("sc", [
    "query",
    WINDOWS_SERVICE_NAME,
  ]);
  const isRunning = verifyResult.success &&
    verifyResult.stdout.includes("RUNNING");
  return isRunning
    ? {
      ok: true,
      message: `Daemon started (Windows Service: ${WINDOWS_SERVICE_NAME})`,
    }
    : {
      ok: false,
      message: "Failed to start service. Try running from an admin terminal.",
    };
}

/** Start via Windows Service (service must already be installed). */
async function startWindowsService(): Promise<DaemonResult> {
  const earlyResult = await queryWindowsServiceState();
  if (earlyResult) return earlyResult;
  return issueWindowsServiceStart();
}

/**
 * Install and start the Triggerfish daemon on the current OS.
 *
 * On macOS: writes a launchd plist and loads it via launchctl.
 * On Linux: writes a systemd user unit, reloads the daemon, enables and starts.
 *
 * @param binaryPath - Absolute path to the triggerfish binary.
 * @returns Result indicating success or failure.
 */
export async function installAndStartDaemon(
  binaryPath: string,
): Promise<DaemonResult> {
  const manager = detectDaemonManager();
  await Deno.mkdir(logDir(), { recursive: true });

  switch (manager) {
    case "launchd":
      return installLaunchdDaemon(binaryPath);
    case "systemd":
      return installSystemdDaemon(binaryPath);
    case "windows-service":
      return startWindowsService();
    default:
      return { ok: false, message: `Unsupported daemon manager: ${manager}` };
  }
}
