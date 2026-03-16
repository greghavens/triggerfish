/**
 * OS-native daemon management for Triggerfish.
 *
 * Types, detection, path resolution, service definition generators,
 * and shell command helpers. Lifecycle operations, logging, and
 * self-update are in dedicated sub-modules.
 * @module
 */

import { join } from "@std/path";
import { resolveBaseDir } from "../config/paths.ts";

// ─── Types ───────────────────────────────────────────────────────

/** Supported daemon manager types. */
export type DaemonManagerType =
  | "launchd"
  | "systemd"
  | "windows-service"
  | "unsupported";

/** Options for generating daemon service definitions. */
export interface DaemonOptions {
  readonly binaryPath: string;
}

/** Result of a daemon operation. */
export interface DaemonResult {
  readonly ok: boolean;
  readonly message: string;
}

/** Daemon status information. */
export interface DaemonStatus {
  readonly running: boolean;
  readonly pid?: number;
  readonly uptime?: string;
  readonly manager: DaemonManagerType;
  readonly message: string;
}

// ─── Constants ───────────────────────────────────────────────────

/** @internal Service name constants — exported for sub-modules. */
export const LAUNCHD_LABEL = "dev.triggerfish.agent";
export const SYSTEMD_UNIT = "triggerfish.service";
export const WINDOWS_SERVICE_NAME = "Triggerfish";
/** @deprecated Legacy scheduled task name — kept for cleanup during upgrade. */
export const SCHTASKS_TASK_NAME = "Triggerfish";

// ─── Detection & paths ──────────────────────────────────────────

/**
 * Detect the OS-native daemon manager on the current system.
 *
 * @returns The daemon manager type for the host OS.
 */
export function detectDaemonManager(): DaemonManagerType {
  const os = Deno.build.os;
  switch (os) {
    case "darwin":
      return "launchd";
    case "linux":
      return "systemd";
    case "windows":
      return "windows-service";
    default:
      return "unsupported";
  }
}

/** @internal Get the path where the launchd plist is installed. */
export function launchdPlistPath(): string {
  return `${Deno.env.get("HOME")}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;
}

/** @internal Get the path where the systemd unit file is installed. */
export function systemdUnitPath(): string {
  return `${Deno.env.get("HOME")}/.config/systemd/user/${SYSTEMD_UNIT}`;
}

/** Get the log directory path. */
export function logDir(): string {
  return join(resolveBaseDir(), "logs");
}

/** Get the stdout log file path. */
export function logFilePath(): string {
  return join(logDir(), "triggerfish.log");
}

// ─── Service definition generators ──────────────────────────────

/** Build the inner <dict> content for the launchd plist. */
function buildLaunchdDictEntries(
  binaryPath: string,
  userPath: string,
  logFile: string,
): string {
  return `  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binaryPath}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${userPath}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>`;
}

/**
 * Generate a macOS launchd plist for the Triggerfish daemon.
 *
 * @param options - Daemon configuration including binary path.
 * @returns XML plist string for ~/Library/LaunchAgents/.
 */
export function generateLaunchdPlist(options: DaemonOptions): string {
  const logFile = logFilePath();
  // Capture the user's PATH at install time so MCP subprocess spawning
  // can find npx, node, deno, python, etc. launchd has a minimal default PATH.
  const userPath = Deno.env.get("PATH") ?? "/usr/local/bin:/usr/bin:/bin";
  const entries = buildLaunchdDictEntries(
    options.binaryPath,
    userPath,
    logFile,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries}
</dict>
</plist>
`;
}

/**
 * Generate a Linux systemd user unit file for the Triggerfish daemon.
 *
 * @param options - Daemon configuration including binary path.
 * @returns Systemd unit file content for ~/.config/systemd/user/.
 */
export function generateSystemdUnit(options: DaemonOptions): string {
  // Capture the user's PATH at install time so MCP subprocess spawning
  // can find npx, node, deno, python, etc.
  const userPath = Deno.env.get("PATH") ?? "/usr/local/bin:/usr/bin:/bin";
  return `[Unit]
Description=Triggerfish AI Agent
After=network.target

[Service]
Type=simple
ExecStart=${options.binaryPath} run
Restart=on-failure
RestartSec=5
Environment=DENO_DIR=%h/.cache/deno
Environment="PATH=${userPath}"

[Install]
WantedBy=default.target
`;
}

// ─── Shell command helpers ───────────────────────────────────────

/**
 * Encode a PowerShell command as UTF-16LE Base64 for use with -EncodedCommand.
 * @internal Exported for sub-modules.
 */
export function encodeUtf16Base64(command: string): string {
  const bytes = new Uint8Array(command.length * 2);
  for (let i = 0; i < command.length; i++) {
    const code = command.charCodeAt(i);
    bytes[i * 2] = code & 0xFF;
    bytes[i * 2 + 1] = (code >> 8) & 0xFF;
  }
  // Process in chunks to avoid call stack overflow on large commands
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Run a shell command and capture output.
 * @internal Exported for sub-modules.
 *
 * @param cmd - Command name.
 * @param args - Command arguments.
 * @returns Decoded stdout, stderr, and success flag.
 */
export async function invokeCommand(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; success: boolean }> {
  const command = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
    success: output.success,
  };
}

/**
 * Run an encoded PowerShell command with automatic elevation detection.
 * @internal Exported for sub-modules.
 *
 * If already running as admin, runs directly. Otherwise uses
 * Start-Process -Verb RunAs for UAC elevation.
 */
export async function invokeElevatedCommand(encoded: string): Promise<void> {
  const isElevated = await invokeCommand("powershell", [
    "-NoProfile",
    "-Command",
    "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
  ]);

  if (isElevated.stdout === "True") {
    await invokeCommand("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encoded,
    ]);
  } else {
    await invokeCommand("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$null = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${encoded}'`,
    ]);
  }
}

/** @deprecated Use invokeCommand instead */
export const runCommand = invokeCommand;

/** @deprecated Use invokeElevatedCommand instead */
export const runElevatedCommand = invokeElevatedCommand;

// ─── Re-exports from sub-modules ────────────────────────────────

export {
  cleanupOldBinary,
  fetchDaemonStatus,
  getDaemonStatus,
  installAndStartDaemon,
  restartDaemon,
  stopDaemon,
  uninstallDaemon,
} from "./lifecycle.ts";

export { bundleLogs, tailLogs } from "./logs.ts";

export type { UpdateResult } from "./updater/mod.ts";
export { updateTriggerfish, upgradeTriggerfish } from "./updater/mod.ts";
