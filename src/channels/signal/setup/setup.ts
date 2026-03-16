/**
 * Signal channel guided setup — re-export barrel.
 *
 * Sub-modules:
 * - setup_resolver.ts: Binary and Java resolution
 * - setup_link.ts: Device linking and QR code rendering
 * - setup_daemon.ts: Daemon TCP/Unix lifecycle management
 * - ../install/setup_archive.ts: Archive download and extraction utilities
 * - ../install/setup_jre.ts: JRE download and installation from Adoptium
 * - ../install/setup_signal_cli.ts: Signal-cli download and installation from GitHub
 *
 * @module
 */

// ─── Resolver: binary + Java resolution ─────────────────────────
export {
  checkJava,
  checkSignalCli,
  type GitHubRelease,
  javaHomeBin,
  resolveJavaHome,
  resolveSignalCliBinDir,
  SIGNAL_CLI_KNOWN_GOOD_VERSION,
  type SignalSetupResult,
  tryJava,
  trySignalCli,
  verifyJava,
  verifySignalCli,
  warnIfOldVersion,
} from "./setup_resolver.ts";

// ─── JRE installer: download + install JRE ──────────────────────
export { downloadJre, fetchJre } from "../install/setup_jre.ts";

// ─── Signal-cli installer: download + install signal-cli ────────
export {
  downloadSignalCli,
  fetchKnownGoodRelease,
  fetchSignalCli,
  type SignalCliInstall,
} from "../install/setup_signal_cli.ts";

// ─── Link: device linking + QR ──────────────────────────────────
export { renderQrCode, startLinkProcess } from "./setup_link.ts";

// ─── Daemon: TCP + Unix socket lifecycle ────────────────────────
export {
  type DaemonHandle,
  isDaemonHealthy,
  isDaemonRunning,
  isDaemonRunningUnix,
  startDaemon,
  startDaemonUnix,
  waitForDaemon,
  waitForDaemonUnix,
} from "./setup_daemon.ts";
