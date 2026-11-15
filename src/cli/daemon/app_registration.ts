/**
 * OS-native application shortcut registration for Triggerfish Tidepool.
 *
 * Creates and removes app launcher entries so the native Tidepool window
 * appears in Spotlight (macOS), application menus (Linux), or Start Menu (Windows).
 * @module
 */

import { dirname, fromFileUrl, join } from "@std/path";
import { detectDaemonManager, runCommand } from "./daemon.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("cli:app-registration");

/** Result of an app registration operation. */
interface AppRegistrationResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Register the Tidepool native app in the OS application launcher.
 *
 * @param binaryPath - Absolute path to the `triggerfish-tidepool` binary.
 * @returns Result indicating success or failure.
 */
export function registerTidepoolApp(
  binaryPath: string,
): Promise<AppRegistrationResult> {
  const manager = detectDaemonManager();
  log.info("Registering Tidepool app shortcut", {
    operation: "registerTidepoolApp",
    manager,
    binaryPath,
  });

  switch (manager) {
    case "launchd":
      return registerMacOsApp(binaryPath);
    case "systemd":
      return registerLinuxApp(binaryPath);
    case "windows-service":
      return registerWindowsApp(binaryPath);
    default:
      return Promise.resolve({
        ok: false,
        message: `App registration unsupported on: ${manager}`,
      });
  }
}

/**
 * Remove the Tidepool native app from the OS application launcher.
 *
 * @returns Result indicating success or failure.
 */
export function unregisterTidepoolApp(): Promise<AppRegistrationResult> {
  const manager = detectDaemonManager();
  log.info("Unregistering Tidepool app shortcut", {
    operation: "unregisterTidepoolApp",
    manager,
  });

  switch (manager) {
    case "launchd":
      return unregisterMacOsApp();
    case "systemd":
      return unregisterLinuxApp();
    case "windows-service":
      return unregisterWindowsApp();
    default:
      return Promise.resolve({
        ok: false,
        message: `App unregistration unsupported on: ${manager}`,
      });
  }
}

// ─── macOS ──────────────────────────────────────────────────────

const MACOS_APP_DIR = `${
  Deno.env.get("HOME") ?? ""
}/Applications/Triggerfish Tidepool.app`;

/** Create a minimal macOS .app bundle with an Info.plist and binary symlink. */
async function registerMacOsApp(
  binaryPath: string,
): Promise<AppRegistrationResult> {
  const contentsDir = `${MACOS_APP_DIR}/Contents/MacOS`;
  await Deno.mkdir(contentsDir, { recursive: true });

  const plist = buildMacOsInfoPlist();
  await Deno.writeTextFile(`${MACOS_APP_DIR}/Contents/Info.plist`, plist);

  const linkPath = `${contentsDir}/triggerfish-tidepool`;
  try {
    await Deno.remove(linkPath);
  } catch (err: unknown) {
    log.debug("Symlink removal skipped", {
      operation: "registerMacOsApp",
      linkPath,
      err,
    });
  }
  await Deno.symlink(binaryPath, linkPath);

  return { ok: true, message: "macOS app bundle created" };
}

/** Build the Info.plist XML for the macOS .app bundle. */
function buildMacOsInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Triggerfish Tidepool</string>
  <key>CFBundleIdentifier</key>
  <string>dev.triggerfish.tidepool</string>
  <key>CFBundleExecutable</key>
  <string>triggerfish-tidepool</string>
  <key>CFBundleVersion</key>
  <string>0.1.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
</dict>
</plist>
`;
}

/** Remove the macOS .app bundle. */
async function unregisterMacOsApp(): Promise<AppRegistrationResult> {
  try {
    await Deno.remove(MACOS_APP_DIR, { recursive: true });
  } catch (err: unknown) {
    log.debug("macOS app bundle removal skipped", {
      operation: "unregisterMacOsApp",
      err,
    });
  }
  return { ok: true, message: "macOS app bundle removed" };
}

// ─── Linux ──────────────────────────────────────────────────────

const LINUX_DESKTOP_DIR = `${
  Deno.env.get("HOME") ?? ""
}/.local/share/applications`;
const LINUX_DESKTOP_FILE =
  `${LINUX_DESKTOP_DIR}/dev.triggerfish.tidepool.desktop`;
const LINUX_ICON_DIR = `${
  Deno.env.get("HOME") ?? ""
}/.local/share/icons/hicolor/256x256/apps`;
const LINUX_ICON_FILE = `${LINUX_ICON_DIR}/dev.triggerfish.tidepool.png`;

/** Create a Linux .desktop file and install the icon. */
async function registerLinuxApp(
  binaryPath: string,
): Promise<AppRegistrationResult> {
  await Deno.mkdir(LINUX_DESKTOP_DIR, { recursive: true });
  await Deno.mkdir(LINUX_ICON_DIR, { recursive: true });

  const desktopEntry = buildLinuxDesktopEntry(binaryPath);
  await Deno.writeTextFile(LINUX_DESKTOP_FILE, desktopEntry);

  await installLinuxIcon();

  await refreshLinuxDesktopCaches();
  return { ok: true, message: "Linux .desktop file created" };
}

/**
 * Locate and install the Tidepool icon for the Linux desktop entry.
 *
 * Tries in order:
 * 1. Embedded in the compiled binary (config/tidepool-icon.png via --include)
 * 2. Source tree (tauri/icons/icon.png — dev mode)
 */
async function installLinuxIcon(): Promise<void> {
  const candidates = buildIconCandidates();
  for (const candidate of candidates) {
    try {
      await Deno.copyFile(candidate, LINUX_ICON_FILE);
      log.info("Tidepool icon installed", {
        operation: "installLinuxIcon",
        source: candidate,
      });
      return;
    } catch {
      // Try next candidate
    }
  }
  log.info("Tidepool icon not found in any location, skipping", {
    operation: "installLinuxIcon",
    candidates,
  });
}

/** Build list of candidate icon paths to try. */
function buildIconCandidates(): readonly string[] {
  const candidates: string[] = [];

  // 1. Embedded via deno compile --include config/
  try {
    const mainModule = dirname(fromFileUrl(import.meta.url));
    // app_registration.ts is at src/cli/daemon/ — config/ is at repo root
    const embedded = join(mainModule, "../../../config/tidepool-icon.png");
    candidates.push(embedded);
  } catch {
    // import.meta.url may not resolve in all contexts
  }

  // 2. Source tree (dev mode)
  try {
    const mainModule = dirname(fromFileUrl(import.meta.url));
    const devIcon = join(mainModule, "../../../tauri/icons/icon.png");
    candidates.push(devIcon);
  } catch {
    // dev mode path
  }

  return candidates;
}

/** Refresh desktop and icon caches so the new entry appears immediately. */
async function refreshLinuxDesktopCaches(): Promise<void> {
  const home = Deno.env.get("HOME") ?? "";
  const iconBase = `${home}/.local/share/icons/hicolor`;
  try {
    await runCommand("gtk-update-icon-cache", [iconBase]);
  } catch (err: unknown) {
    log.debug("Icon cache refresh skipped", {
      operation: "refreshLinuxDesktopCaches",
      err,
    });
  }
  try {
    await runCommand("update-desktop-database", [
      `${home}/.local/share/applications`,
    ]);
  } catch (err: unknown) {
    log.debug("Desktop database refresh skipped", {
      operation: "refreshLinuxDesktopCaches",
      err,
    });
  }
}

/** Build the .desktop file content for Linux app launchers. */
function buildLinuxDesktopEntry(binaryPath: string): string {
  return `[Desktop Entry]
Name=Triggerfish Tidepool
Comment=Triggerfish AI Agent — Tidepool UI
Exec=${binaryPath}
Icon=dev.triggerfish.tidepool
Type=Application
Categories=Utility;Development;
StartupWMClass=dev.triggerfish.tidepool
StartupNotify=true
`;
}

/** Remove the Linux .desktop file and icon. */
async function unregisterLinuxApp(): Promise<AppRegistrationResult> {
  try {
    await Deno.remove(LINUX_DESKTOP_FILE);
  } catch (err: unknown) {
    log.debug("Desktop file removal skipped", {
      operation: "unregisterLinuxApp",
      path: LINUX_DESKTOP_FILE,
      err,
    });
  }
  try {
    await Deno.remove(LINUX_ICON_FILE);
  } catch (err: unknown) {
    log.debug("Icon removal skipped", {
      operation: "unregisterLinuxApp",
      path: LINUX_ICON_FILE,
      err,
    });
  }
  return { ok: true, message: "Linux .desktop file removed" };
}

// ─── Windows ────────────────────────────────────────────────────

/** Create a Start Menu shortcut on Windows via PowerShell. */
async function registerWindowsApp(
  binaryPath: string,
): Promise<AppRegistrationResult> {
  const script = buildWindowsShortcutScript(binaryPath);
  const result = await runCommand("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);

  if (result.success) {
    return { ok: true, message: "Windows Start Menu shortcut created" };
  }
  log.error("Windows app registration failed", {
    operation: "registerWindowsApp",
    err: result.stderr,
  });
  return {
    ok: false,
    message: `Windows shortcut creation failed: ${result.stderr}`,
  };
}

/** Build the PowerShell script that creates a Start Menu shortcut. */
function buildWindowsShortcutScript(binaryPath: string): string {
  const escapedPath = binaryPath.replace(/'/g, "''");
  return [
    `$ws = New-Object -ComObject WScript.Shell`,
    `$startMenu = [System.IO.Path]::Combine($env:APPDATA, 'Microsoft\\Windows\\Start Menu\\Programs')`,
    `$shortcut = $ws.CreateShortcut("$startMenu\\Triggerfish Tidepool.lnk")`,
    `$shortcut.TargetPath = '${escapedPath}'`,
    `$shortcut.Description = 'Triggerfish AI Agent - Tidepool UI'`,
    `$shortcut.Save()`,
  ].join("; ");
}

/** Remove the Windows Start Menu shortcut. */
async function unregisterWindowsApp(): Promise<AppRegistrationResult> {
  const script = [
    `$startMenu = [System.IO.Path]::Combine($env:APPDATA, 'Microsoft\\Windows\\Start Menu\\Programs')`,
    `Remove-Item "$startMenu\\Triggerfish Tidepool.lnk" -Force -ErrorAction SilentlyContinue`,
  ].join("; ");

  await runCommand("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);

  return { ok: true, message: "Windows Start Menu shortcut removed" };
}
