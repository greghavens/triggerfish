/**
 * Binary path resolution and atomic replacement for self-update.
 * @module
 */

import { dirname, join } from "@std/path";
import { invokeCommand } from "../daemon.ts";
import { createLogger } from "../../../core/logger/mod.ts";

const log = createLogger("cli.updater.binary");

/**
 * Compute SHA256 hex digest of a file.
 *
 * @param path - Absolute path to the file.
 * @returns Lowercase hex string of the SHA-256 hash.
 */
export async function sha256File(path: string): Promise<string> {
  const file = await Deno.open(path, { read: true });
  try {
    const buf = await new Response(file.readable).arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(hash)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch (e) {
    // readable stream consumed — file auto-closed
    throw e;
  }
}

/**
 * Check whether we can write to a directory.
 *
 * @param dir - Directory path to check.
 * @returns true if the current process can create files in the directory.
 */
async function canWriteToDir(dir: string): Promise<boolean> {
  const probe = join(dir, `.triggerfish-write-test-${Date.now()}`);
  try {
    await Deno.writeTextFile(probe, "");
    await Deno.remove(probe);
    return true;
  } catch {
    return false;
  }
}

/** Replace the binary on Windows by renaming the old one first. */
async function replaceBinaryWindows(
  tmpPath: string,
  binaryPath: string,
): Promise<void> {
  const oldPath = `${binaryPath}.old`;
  try {
    await Deno.remove(oldPath);
  } catch (err) {
    log.debug("Old binary not present for removal", { operation: "replaceBinaryWindows", err });
  }
  try {
    await Deno.rename(binaryPath, oldPath);
  } catch (err) {
    log.debug("Binary rename skipped — may not exist yet", { operation: "replaceBinaryWindows", err });
  }
  await Deno.rename(tmpPath, binaryPath);
}

/** Replace the binary on Unix when we have write permissions. */
async function replaceBinaryWritable(
  tmpPath: string,
  binaryPath: string,
): Promise<void> {
  try {
    await Deno.rename(tmpPath, binaryPath);
  } catch {
    // Cross-device: copy + remove
    await Deno.copyFile(tmpPath, binaryPath);
    await Deno.remove(tmpPath);
  }
  await Deno.chmod(binaryPath, 0o755);
  if (Deno.build.os === "darwin") {
    await invokeCommand("xattr", ["-cr", binaryPath]);
  }
}

/** Move a file using sudo, throwing on failure. */
async function sudoMoveFile(
  source: string,
  destination: string,
): Promise<void> {
  const mv = new Deno.Command("sudo", {
    args: ["mv", source, destination],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const result = await mv.output();
  if (!result.success) {
    throw new Error(
      "Failed to move binary with sudo. Check permissions and try again.",
    );
  }
}

/** Set file permissions and clear macOS quarantine via sudo. */
async function sudoChmodAndClearQuarantine(
  binaryPath: string,
): Promise<void> {
  const chmod = new Deno.Command("sudo", {
    args: ["chmod", "755", binaryPath],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await chmod.output();
  if (Deno.build.os === "darwin") {
    await invokeCommand("sudo", ["xattr", "-cr", binaryPath]);
  }
}

/** Replace the binary on Unix using sudo for elevated permissions. */
async function replaceBinaryElevated(
  tmpPath: string,
  binaryPath: string,
): Promise<void> {
  const targetDir = dirname(binaryPath);
  console.log(
    `  Binary directory (${targetDir}) requires elevated permissions.`,
  );
  console.log("  You may be prompted for your password.\n");
  await sudoMoveFile(tmpPath, binaryPath);
  await sudoChmodAndClearQuarantine(binaryPath);
}

/**
 * Replace the binary file, handling cross-device moves and permission issues.
 *
 * On Unix: attempts atomic rename, falls back to copy+remove for cross-device.
 * If the target directory isn't writable, attempts via sudo.
 *
 * On Windows: renames current binary to .old, then moves new binary into place.
 *
 * @param tmpPath - Path to the downloaded replacement binary.
 * @param binaryPath - Path where the installed binary lives.
 */
export async function replaceBinary(
  tmpPath: string,
  binaryPath: string,
): Promise<void> {
  if (Deno.build.os === "windows") {
    await replaceBinaryWindows(tmpPath, binaryPath);
    return;
  }
  const targetDir = dirname(binaryPath);
  const writable = await canWriteToDir(targetDir);
  if (writable) {
    await replaceBinaryWritable(tmpPath, binaryPath);
  } else {
    await replaceBinaryElevated(tmpPath, binaryPath);
  }
}

/** Try to resolve binary from the currently running executable. */
async function resolveRunningExecutable(): Promise<string | null> {
  try {
    const execPath = Deno.execPath();
    if (execPath && execPath.toLowerCase().includes("triggerfish")) {
      await Deno.stat(execPath);
      return execPath;
    }
  } catch (err) {
    log.debug("Running executable path resolution failed", { operation: "resolveRunningExecutable", err });
  }
  return null;
}

/** Build platform-specific candidate binary paths. */
function buildBinaryCandidatePaths(): string[] {
  if (Deno.build.os === "windows") {
    const localAppData = Deno.env.get("LOCALAPPDATA") ?? "";
    return [`${localAppData}\\Triggerfish\\triggerfish.exe`];
  }
  const home = Deno.env.get("HOME") ?? "";
  return ["/usr/local/bin/triggerfish", `${home}/.local/bin/triggerfish`];
}

/** Find the first existing path from a list of candidates. */
async function resolveFirstExistingPath(
  candidates: string[],
): Promise<string> {
  for (const path of candidates) {
    try {
      await Deno.stat(path);
      return path;
    } catch {
      continue;
    }
  }
  return candidates[0];
}

/**
 * Find the installed triggerfish binary path.
 */
export async function findInstalledBinary(): Promise<string> {
  const running = await resolveRunningExecutable();
  if (running) return running;

  const candidates = buildBinaryCandidatePaths();
  return resolveFirstExistingPath(candidates);
}
