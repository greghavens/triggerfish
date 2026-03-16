/**
 * Tidepool CLI command handler.
 *
 * Provides `triggerfish tidepool` subcommands:
 * - `open` (default) — launch native Tauri window, or fall back to browser
 * - `url`  — print the authenticated Tidepool URL
 * @module
 */

import {
  type DaemonState,
  daemonStatePath,
  TIDEPOOL_NATIVE_BINARY,
  TIDEPOOL_PORT,
} from "../constants.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("cli:tidepool");

/**
 * Read the daemon state file to get the authenticated Tidepool URL.
 *
 * Returns null if the state file does not exist or is unreadable.
 */
async function readDaemonState(): Promise<DaemonState | null> {
  try {
    const text = await Deno.readTextFile(daemonStatePath());
    return JSON.parse(text) as DaemonState;
  } catch (err: unknown) {
    log.debug("Daemon state file unreadable", { operation: "readDaemonState", err });
    return null;
  }
}

/**
 * Probes the Tidepool HTTP endpoint to check if it is currently running.
 *
 * Reads the session key from the daemon state file so the probe
 * request passes authentication.
 *
 * @returns `true` if the server responded successfully, `false` otherwise.
 */
export async function probeTidepool(): Promise<boolean> {
  try {
    const state = await readDaemonState();
    const url = state?.tidepoolUrl ?? `http://127.0.0.1:${TIDEPOOL_PORT}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(2000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch (err: unknown) {
    log.debug("Tidepool probe failed", { operation: "probeTidepool", err });
    return false;
  }
}

/**
 * Locate the native Tauri binary on disk.
 *
 * Searches in order: `~/.local/bin/`, sibling of the current executable,
 * `/usr/local/bin/`. Returns the full path if found, null otherwise.
 */
export async function locateTauriNativeBinary(): Promise<string | null> {
  const candidates = buildTauriBinaryCandidates();
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Build the list of candidate paths for the Tauri binary. */
function buildTauriBinaryCandidates(): readonly string[] {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  const execDir = Deno.execPath().replace(/[/\\][^/\\]+$/, "");
  const binary = Deno.build.os === "windows"
    ? `${TIDEPOOL_NATIVE_BINARY}.exe`
    : TIDEPOOL_NATIVE_BINARY;

  return [
    `${home}/.local/bin/${binary}`,
    `${execDir}/${binary}`,
    `/usr/local/bin/${binary}`,
  ];
}

/** Check whether a file exists at the given path. */
async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile;
  } catch (err: unknown) {
    log.debug("File stat failed", { operation: "fileExists", path, err });
    return false;
  }
}

/**
 * Spawn the native Tauri binary as a detached process.
 *
 * Stdio is set to null so the CLI can exit immediately.
 * The Tauri binary reads state files itself — no args needed.
 */
function spawnNativeTidepool(binaryPath: string): void {
  log.info("Launching native Tidepool window", {
    operation: "spawnNativeTidepool",
    binaryPath,
  });
  const command = new Deno.Command(binaryPath, {
    stdin: "null",
    stdout: "null",
    stderr: "null",
  });
  const child = command.spawn();
  child.unref();
}

/**
 * Open a URL in the user's default browser.
 *
 * Uses `open` on macOS, `xdg-open` on Linux, and `start` on Windows.
 */
function openTidepoolInBrowser(url: string): void {
  log.info("Opening Tidepool in browser", {
    operation: "openTidepoolInBrowser",
    url,
  });
  const opener = selectBrowserOpener();
  const args = Deno.build.os === "windows" ? ["", url] : [url];
  const command = new Deno.Command(opener, {
    args,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  });
  const child = command.spawn();
  child.unref();
}

/** Select the platform-appropriate URL opener command. */
function selectBrowserOpener(): string {
  switch (Deno.build.os) {
    case "darwin":
      return "open";
    case "windows":
      return "cmd";
    default:
      return "xdg-open";
  }
}

/** Print a "not running" message with guidance. */
function printNotRunning(): void {
  console.log("✗ Tidepool is not running.");
  console.log(
    "  Run 'triggerfish run' or 'triggerfish start' to launch the gateway.",
  );
}

/**
 * Handle the `triggerfish tidepool open` subcommand (default).
 *
 * 1. Locate the Tauri native binary.
 * 2. If found: spawn detached — Tauri reads state files directly.
 * 3. If not found: probe gateway, read URL, open in browser.
 */
async function openTidepool(): Promise<void> {
  const nativeBinary = await locateTauriNativeBinary();

  if (nativeBinary) {
    spawnNativeTidepool(nativeBinary);
    console.log("  Tidepool native window launched.");
    return;
  }

  log.info("Native binary not found, falling back to browser", {
    operation: "openTidepool",
  });

  const state = await readDaemonState();
  if (!state) {
    printNotRunning();
    return;
  }

  const alive = await probeTidepool();
  if (!alive) {
    printNotRunning();
    return;
  }

  openTidepoolInBrowser(state.tidepoolUrl);
  console.log(`  Opened Tidepool in browser: ${state.tidepoolUrl}`);
}

/** Handle the `triggerfish tidepool url` subcommand. */
async function printTidepoolUrl(): Promise<void> {
  const state = await readDaemonState();
  if (!state) {
    printNotRunning();
    return;
  }

  const alive = await probeTidepool();
  if (alive) {
    console.log(`  Tidepool: ${state.tidepoolUrl}`);
  } else {
    printNotRunning();
  }
}

/**
 * Handle the `triggerfish tidepool` command.
 *
 * Supported subcommands:
 * - `open` (default) — launch native window or browser fallback
 * - `url` — print the Tidepool URL if live
 *
 * @param subcommand - The subcommand string parsed from the CLI args.
 * @param _flags     - Parsed flags (unused; reserved for future options).
 */
export async function launchTidepoolServer(
  subcommand: string | undefined,
  _flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  switch (subcommand) {
    case undefined:
    case "open":
      await openTidepool();
      return;
    case "url":
      await printTidepoolUrl();
      return;
    default:
      console.log(`Unknown tidepool subcommand: ${subcommand}`);
      console.log("Valid subcommands: open, url");
      console.log(
        "  triggerfish tidepool         # Open native window or browser",
      );
      console.log(
        "  triggerfish tidepool url     # Print Tidepool URL if running",
      );
  }
}

/** @deprecated Use launchTidepoolServer instead */
export const runTidepool = launchTidepoolServer;
