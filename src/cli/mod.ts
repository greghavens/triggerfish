/**
 * CLI module — entry point, command parsing, config loading, and daemon management.
 * @module
 */

export { loadConfig, parseCommand, validateConfig } from "./main.ts";

export type {
  Err,
  Ok,
  ParsedCommand,
  ParseOptions,
  Result,
  TriggerFishConfig,
} from "./main.ts";

export { enableWindowsAnsi, probeGateway } from "./platform.ts";
export { launchPatrolDiagnostics, runPatrol } from "./dive_command.ts";
export {
  displayDaemonLogs,
  haltDaemon,
  installUpdate,
  launchDaemon,
  reportDaemonStatus,
  runDaemonLogs,
  runDaemonStart,
  runDaemonStatus,
  runDaemonStop,
  runUpdate,
} from "./daemon_commands.ts";

export {
  detectDaemonManager,
  generateLaunchdPlist,
  generateSystemdUnit,
} from "./daemon/daemon.ts";

export type { DaemonManagerType, DaemonOptions } from "./daemon/daemon.ts";

export {
  createKeypressReader,
  createLineEditor,
  createSuggestionEngine,
  parseKeypresses,
} from "./terminal/terminal.ts";

export type {
  Keypress,
  KeypressReader,
  LineEditor,
  SuggestionEngine,
} from "./terminal/terminal.ts";

export {
  createInputHistory,
  loadInputHistory,
  saveInputHistory,
} from "./chat/history.ts";

export type { InputHistory } from "./chat/history.ts";

export { createScreenManager } from "./terminal/screen.ts";
export type { ScreenManager } from "./terminal/screen.ts";

export {
  createScreenEventHandler,
  formatBanner,
  formatError,
  formatResponse,
  formatToolCallCompact,
  formatToolCallExpanded,
  formatToolCompact,
  formatToolResultExpanded,
} from "./chat/chat_ui.ts";
export type { ToolDisplayMode } from "./chat/chat_ui.ts";

export { GATEWAY_PORT, TIDEPOOL_PORT } from "./constants.ts";
