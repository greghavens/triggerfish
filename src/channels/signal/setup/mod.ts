/**
 * Signal channel setup — guided installation, linking, and daemon lifecycle.
 *
 * Re-exports from sub-modules:
 * - setup_resolver.ts: Binary and Java resolution
 * - setup_link.ts: Device linking and QR code rendering
 * - setup_daemon.ts: Daemon TCP/Unix lifecycle management
 * - setup_daemon_stderr.ts: Daemon stderr collection
 * - setup.ts: Top-level re-export barrel
 *
 * @module
 */

export {
  checkJava,
  checkSignalCli,
  javaHomeBin,
  resolveJavaHome,
  resolveSignalCliBinDir,
  SIGNAL_CLI_KNOWN_GOOD_VERSION,
  tryJava,
  trySignalCli,
  verifyJava,
  verifySignalCli,
  warnIfOldVersion,
} from "./setup_resolver.ts";
export type { GitHubRelease, SignalSetupResult } from "./setup_resolver.ts";

export { renderQrCode, startLinkProcess } from "./setup_link.ts";

export {
  isDaemonHealthy,
  isDaemonRunning,
  isDaemonRunningUnix,
  startDaemon,
  startDaemonUnix,
  waitForDaemon,
  waitForDaemonUnix,
} from "./setup_daemon.ts";
export type { DaemonHandle } from "./setup_daemon.ts";

export { createDaemonStderrCollector } from "./setup_daemon_stderr.ts";
export type { StderrCollector } from "./setup_daemon_stderr.ts";
