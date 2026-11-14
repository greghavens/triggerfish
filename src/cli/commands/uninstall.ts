/**
 * Full uninstall command for Triggerfish.
 *
 * Removes the daemon, app shortcuts, binaries, and optionally user data.
 * @module
 */

import { resolveBaseDir } from "../config/paths.ts";
import { createLogger } from "../../core/logger/mod.ts";
import { TIDEPOOL_NATIVE_BINARY } from "../constants.ts";

const log = createLogger("cli:uninstall");

/**
 * Run the `triggerfish uninstall` command.
 *
 * Steps:
 * 1. Stop and uninstall the daemon service.
 * 2. Unregister the Tidepool app shortcut.
 * 3. Remove binaries from the install directory.
 * 4. Optionally remove `~/.triggerfish` (config, memory, logs).
 */
export async function runUninstall(): Promise<void> {
  console.log("\n  Triggerfish Uninstall");
  console.log("  ====================\n");

  await stopAndUninstallDaemon();
  await removeAppShortcut();
  await removeBinaries();
  await promptDataRemoval();

  console.log("\n  Triggerfish has been uninstalled.\n");
}

/** Stop the running daemon and remove the service definition. */
async function stopAndUninstallDaemon(): Promise<void> {
  console.log("  Stopping daemon...");
  try {
    const { uninstallDaemon } = await import(
      "../daemon/lifecycle_uninstall.ts"
    );
    const result = await uninstallDaemon();
    log.info("Daemon uninstall completed", {
      operation: "stopAndUninstallDaemon",
      ok: result.ok,
      message: result.message,
    });
    console.log(`  ${result.ok ? "✓" : "✗"} ${result.message}`);
  } catch (err: unknown) {
    log.error("Daemon uninstall encountered an error", {
      operation: "stopAndUninstallDaemon",
      err,
    });
    console.log("  ✗ Could not uninstall daemon (may not be installed).");
  }
}

/** Remove the OS app launcher shortcut for Tidepool. */
async function removeAppShortcut(): Promise<void> {
  console.log("  Removing app shortcuts...");
  try {
    const { unregisterTidepoolApp } = await import(
      "../daemon/app_registration.ts"
    );
    const result = await unregisterTidepoolApp();
    console.log(`  ${result.ok ? "✓" : "✗"} ${result.message}`);
  } catch (err: unknown) {
    log.error("App shortcut removal encountered an error", {
      operation: "removeAppShortcut",
      err,
    });
    console.log("  ✗ Could not remove app shortcut.");
  }
}

/** Remove the triggerfish and triggerfish-tidepool binaries. */
async function removeBinaries(): Promise<void> {
  console.log("  Removing binaries...");
  const installDir = resolveInstallDir();

  const binaries = [
    "triggerfish",
    TIDEPOOL_NATIVE_BINARY,
  ];
  if (Deno.build.os === "windows") {
    binaries[0] += ".exe";
    binaries[1] += ".exe";
  }

  for (const name of binaries) {
    const path = `${installDir}/${name}`;
    try {
      await Deno.remove(path);
      console.log(`  ✓ Removed ${path}`);
    } catch (err: unknown) {
      log.debug("Binary removal skipped", {
        operation: "removeBinaries",
        path,
        err,
      });
    }
  }
}

/** Determine the install directory from the current executable path. */
function resolveInstallDir(): string {
  return Deno.execPath().replace(/[/\\][^/\\]+$/, "");
}

/** Prompt the user to optionally remove ~/.triggerfish data. */
async function promptDataRemoval(): Promise<void> {
  const baseDir = resolveBaseDir();
  console.log("");
  console.log(`  Remove ${baseDir}?`);
  console.log("  Contains config, memory, and logs.");

  const answer = prompt("  Delete data directory? [y/N]") ?? "n";
  if (answer.toLowerCase() === "y") {
    try {
      await Deno.remove(baseDir, { recursive: true });
      log.info("Data directory removed", {
        operation: "promptDataRemoval",
        baseDir,
      });
      console.log(`  ✓ Removed ${baseDir}`);
    } catch (err: unknown) {
      log.error("Data directory removal failed", {
        operation: "promptDataRemoval",
        err,
      });
      console.log(`  ✗ Could not remove ${baseDir}`);
    }
  } else {
    console.log(`  Kept ${baseDir} (safe to reinstall later).`);
  }
}
