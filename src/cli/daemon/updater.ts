/**
 * Self-update system: download, verify, and replace the Triggerfish binary.
 * @module
 */

import { join, dirname } from "@std/path";
import { resolveBaseDir } from "../config/paths.ts";
import { VERSION } from "../version.ts";
import { runCommand } from "./daemon.ts";
import { getDaemonStatus, stopDaemon, installAndStartDaemon } from "./lifecycle.ts";
import { cacheChangelogJson } from "../commands/changelog.ts";

/** Result of an update operation. */
export interface UpdateResult {
  readonly ok: boolean;
  readonly message: string;
  readonly previousVersion?: string;
  readonly newVersion?: string;
  /** Whether the daemon was running before the update began. */
  readonly wasRunning?: boolean;
}

const GITHUB_REPO = "greghavens/triggerfish";
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}`;

/**
 * Resolve the platform-specific asset name for the current OS and architecture.
 */
function resolveAssetName(): string {
  const os = Deno.build.os === "darwin" ? "macos" : Deno.build.os;
  const arch = Deno.build.arch === "aarch64" ? "arm64" : "x64";
  const ext = Deno.build.os === "windows" ? ".exe" : "";
  return `triggerfish-${os}-${arch}${ext}`;
}

/**
 * Compute SHA256 hex digest of a file.
 *
 * @param path - Absolute path to the file.
 * @returns Lowercase hex string of the SHA-256 hash.
 */
async function sha256File(path: string): Promise<string> {
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
async function replaceBinary(tmpPath: string, binaryPath: string): Promise<void> {
  const targetDir = dirname(binaryPath);

  if (Deno.build.os === "windows") {
    // Windows: rename current -> .old, then move new -> current
    const oldPath = `${binaryPath}.old`;
    try { await Deno.remove(oldPath); } catch { /* no old file */ }
    try {
      await Deno.rename(binaryPath, oldPath);
    } catch {
      // Binary may not exist yet (fresh install path)
    }
    await Deno.rename(tmpPath, binaryPath);
    return;
  }

  // Unix path
  const writable = await canWriteToDir(targetDir);

  if (writable) {
    // Try atomic rename (works when same filesystem)
    try {
      await Deno.rename(tmpPath, binaryPath);
    } catch {
      // Cross-device: copy + remove + chmod
      await Deno.copyFile(tmpPath, binaryPath);
      await Deno.remove(tmpPath);
    }
    await Deno.chmod(binaryPath, 0o755);
    // macOS: clear quarantine/provenance xattrs so Gatekeeper doesn't kill it
    if (Deno.build.os === "darwin") {
      await runCommand("xattr", ["-cr", binaryPath]);
    }
  } else {
    // Need elevated permissions
    console.log(`  Binary directory (${targetDir}) requires elevated permissions.`);
    console.log("  You may be prompted for your password.\n");
    const mv = new Deno.Command("sudo", {
      args: ["mv", tmpPath, binaryPath],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const mvResult = await mv.output();
    if (!mvResult.success) {
      throw new Error("Failed to move binary with sudo. Check permissions and try again.");
    }
    const chmod = new Deno.Command("sudo", {
      args: ["chmod", "755", binaryPath],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await chmod.output();
    // macOS: clear quarantine/provenance xattrs so Gatekeeper doesn't kill it
    if (Deno.build.os === "darwin") {
      await runCommand("sudo", ["xattr", "-cr", binaryPath]);
    }
  }
}

/**
 * Find the installed triggerfish binary path.
 */
async function findInstalledBinary(): Promise<string> {
  // First, try to resolve from the currently running executable.
  // This handles custom install directories on any platform.
  try {
    const execPath = Deno.execPath();
    if (execPath && execPath.toLowerCase().includes("triggerfish")) {
      await Deno.stat(execPath);
      return execPath;
    }
  } catch {
    // Fall through to candidate search
  }

  // Check common locations in order of preference
  const candidates: string[] = [];

  if (Deno.build.os === "windows") {
    const localAppData = Deno.env.get("LOCALAPPDATA") ?? "";
    candidates.push(`${localAppData}\\Triggerfish\\triggerfish.exe`);
  } else {
    const home = Deno.env.get("HOME") ?? "";
    candidates.push("/usr/local/bin/triggerfish");
    candidates.push(`${home}/.local/bin/triggerfish`);
  }

  for (const path of candidates) {
    try {
      await Deno.stat(path);
      return path;
    } catch {
      continue;
    }
  }

  // Return platform-appropriate default
  if (Deno.build.os === "windows") {
    const localAppData = Deno.env.get("LOCALAPPDATA") ?? "";
    return `${localAppData}\\Triggerfish\\triggerfish.exe`;
  }
  const home = Deno.env.get("HOME") ?? "";
  return `${home}/.local/bin/triggerfish`;
}

/**
 * Download CHANGELOG.json from a release's asset list and cache it locally.
 *
 * Silently no-ops if the asset is absent or the download fails — changelog
 * caching must never block an update.
 *
 * @param assets - Release assets from the GitHub API response.
 */
async function fetchAndCacheChangelogAsset(
  assets: readonly { name: string; browser_download_url: string }[],
): Promise<void> {
  const asset = assets.find((a) => a.name === "CHANGELOG.json");
  if (!asset) return;

  const resp = await fetch(asset.browser_download_url);
  if (!resp.ok) return;

  const data = await resp.json();
  await cacheChangelogJson(data);
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
export async function updateTriggerfish(): Promise<UpdateResult> {
  const currentVersion = VERSION;

  // 1. Fetch latest release metadata
  console.log("Checking for updates...");
  type ReleaseAsset = { name: string; browser_download_url: string };
  let latestTag: string;
  let downloadUrl: string;
  let checksumsUrl: string | undefined;
  let releaseAssets: readonly ReleaseAsset[] = [];
  try {
    const resp = await fetch(`${GITHUB_API}/releases/latest`, {
      headers: { "User-Agent": "triggerfish-updater" },
    });
    if (!resp.ok) {
      return { ok: false, message: `Failed to check for updates: HTTP ${resp.status}` };
    }
    const release = await resp.json() as {
      tag_name: string;
      assets: readonly ReleaseAsset[];
    };
    latestTag = release.tag_name;
    releaseAssets = release.assets;

    const assetName = resolveAssetName();
    const asset = release.assets.find((a) => a.name === assetName);
    if (!asset) {
      return {
        ok: false,
        message: `No binary for this platform (${assetName}) in release ${latestTag}`,
      };
    }
    downloadUrl = asset.browser_download_url;

    const checksumsAsset = release.assets.find((a) => a.name === "SHA256SUMS.txt");
    if (checksumsAsset) {
      checksumsUrl = checksumsAsset.browser_download_url;
    }
  } catch (e) {
    return { ok: false, message: `Failed to check for updates: ${e}` };
  }

  // 2. Compare versions — skip if already on latest (unless dev build)
  if (currentVersion !== "dev" && currentVersion === latestTag) {
    return {
      ok: true,
      message: `Already up to date (${currentVersion})`,
      previousVersion: currentVersion,
      newVersion: latestTag,
    };
  }

  console.log(`  Current: ${currentVersion}`);
  console.log(`  Latest:  ${latestTag}`);

  // 2a. Fetch and cache CHANGELOG.json from this release (best-effort, non-blocking)
  fetchAndCacheChangelogAsset(releaseAssets).catch(() => {
    // Non-fatal: changelog cache failure does not block the update
  });

  // 3. Download new binary to temp file
  const tmpPath = join(resolveBaseDir(), ".update-tmp");
  try {
    const resp = await fetch(downloadUrl);
    if (!resp.ok || !resp.body) {
      return { ok: false, message: `Download failed: HTTP ${resp.status}` };
    }
    const totalBytes = Number(resp.headers.get("content-length") ?? 0);
    const file = await Deno.open(tmpPath, { write: true, create: true, truncate: true });
    const textEnc = new TextEncoder();
    let downloaded = 0;
    const reader = resp.body.getReader();
    const writer = file.writable.getWriter();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value);
      downloaded += value.byteLength;
      if (totalBytes > 0) {
        const pct = Math.round((downloaded / totalBytes) * 100);
        const mb = (downloaded / 1_048_576).toFixed(1);
        const totalMb = (totalBytes / 1_048_576).toFixed(1);
        Deno.stderr.writeSync(textEnc.encode(`\r  Downloading... ${mb}/${totalMb} MB (${pct}%)`));
      } else {
        const mb = (downloaded / 1_048_576).toFixed(1);
        Deno.stderr.writeSync(textEnc.encode(`\r  Downloading... ${mb} MB`));
      }
    }
    await writer.close();
    Deno.stderr.writeSync(textEnc.encode("\n"));
    if (Deno.build.os !== "windows") {
      await Deno.chmod(tmpPath, 0o755);
    }
  } catch (e) {
    try { await Deno.remove(tmpPath); } catch { /* */ }
    return { ok: false, message: `Download failed: ${e}` };
  }

  // 4. Verify SHA256 checksum
  if (checksumsUrl) {
    console.log("  Verifying checksum...");
    try {
      const resp = await fetch(checksumsUrl);
      if (resp.ok) {
        const checksumsText = await resp.text();
        const assetName = resolveAssetName();
        const actualHash = await sha256File(tmpPath);

        // SHA256SUMS.txt format: "<hash>  <filename>" (two spaces)
        const expectedLine = checksumsText
          .split("\n")
          .find((line) => line.includes(assetName));

        if (expectedLine) {
          const expectedHash = expectedLine.split(/\s+/)[0].toLowerCase();
          if (actualHash !== expectedHash) {
            try { await Deno.remove(tmpPath); } catch { /* */ }
            return {
              ok: false,
              message: `Checksum verification failed.\n  Expected: ${expectedHash}\n  Got:      ${actualHash}`,
            };
          }
          console.log("  Checksum verified.");
        } else {
          console.log("  Warning: asset not found in SHA256SUMS.txt, skipping verification.");
        }
      } else {
        console.log("  Warning: could not download checksums, skipping verification.");
      }
    } catch {
      console.log("  Warning: checksum verification failed, skipping.");
    }
  } else {
    console.log("  Warning: no SHA256SUMS.txt in release, skipping checksum verification.");
  }

  // 5. Find where the current binary is installed
  const binaryPath = await findInstalledBinary();

  // 6. Stop daemon if running
  const status = await getDaemonStatus();
  const wasRunning = status.running;
  if (wasRunning) {
    console.log("  Stopping daemon...");
    await stopDaemon();
  }

  // 7. Replace binary
  console.log("  Replacing binary...");
  try {
    await replaceBinary(tmpPath, binaryPath);
  } catch (e) {
    // Attempt to restart daemon even if replacement failed
    if (wasRunning) {
      console.log("  Restarting daemon with old binary...");
      await installAndStartDaemon(binaryPath);
    }
    try { await Deno.remove(tmpPath); } catch { /* */ }
    return { ok: false, message: `Failed to replace binary: ${e}` };
  }

  // 8. Restart daemon if it was running
  if (wasRunning) {
    console.log("  Restarting daemon...");
    await installAndStartDaemon(binaryPath);
  }

  // 9. Return result
  return {
    ok: true,
    message: `Updated from ${currentVersion} to ${latestTag}`,
    previousVersion: currentVersion,
    newVersion: latestTag,
    wasRunning,
  };
}
