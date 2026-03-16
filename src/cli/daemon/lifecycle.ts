/**
 * Daemon lifecycle operations: install, start, stop, status, uninstall.
 *
 * Barrel re-exporting from domain-specific sub-modules.
 * @module
 */

export { installAndStartDaemon } from "./lifecycle_install.ts";
export { stopDaemon } from "./lifecycle_stop.ts";
export { fetchDaemonStatus, getDaemonStatus } from "./lifecycle_status.ts";
export { restartDaemon } from "./lifecycle_restart.ts";
export { cleanupOldBinary, uninstallDaemon } from "./lifecycle_uninstall.ts";
