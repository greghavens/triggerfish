/**
 * CLI entry point and command router for Triggerfish.
 *
 * Parses command-line arguments, dispatches to the appropriate command
 * handler, and manages daemon lifecycle operations.
 *
 * Sub-modules:
 * - main_commands.ts: Argument parsing, help text, version display
 * - dive_command.ts: Dive wizard and patrol health diagnostics
 * - daemon_commands.ts: Daemon start/stop/status/logs/update
 * - platform.ts: Gateway probe, Windows ANSI support
 *
 * @module
 */

import { resolveConfigPath } from "./config/paths.ts";
import { cleanupOldBinary } from "./daemon/daemon.ts";
import { parseCommand, showHelp, showVersion } from "./main_commands.ts";
import { enableWindowsAnsi } from "./platform.ts";
import { launchDiveWizard, launchPatrolDiagnostics } from "./dive_command.ts";
import {
  displayDaemonLogs,
  haltDaemon,
  installUpdate,
  launchDaemon,
  reportDaemonStatus,
  restartDaemonProcess,
} from "./daemon_commands.ts";
import {
  createLogger,
  initLogger,
  isLoggerInitialized,
} from "../core/logger/mod.ts";

const log = createLogger("cli");

// Re-export config types and functions for backward-compatibility (tests and other modules import from here)
export {
  loadConfig,
  loadConfigWithSecrets,
  validateConfig,
} from "../core/config.ts";
export type { Err, Ok, Result } from "../core/config.ts";
export type { TriggerFishConfig } from "../core/config.ts";

// Re-export initiateGoogleOAuth for backward-compatibility (wizard.ts imports it via dynamic import)
export { initiateGoogleOAuth, performGoogleOAuth } from "./commands/connect.ts";

// Re-export command parsing for backward-compatibility (tests import from here)
export {
  parseCommand,
  type ParsedCommand,
  type ParseOptions,
  showHelp,
  showVersion,
} from "./main_commands.ts";

// Re-export platform and command functions for backward-compatibility
export { enableWindowsAnsi, probeGateway } from "./platform.ts";
export { launchPatrolDiagnostics, runPatrol } from "./dive_command.ts";

// ─── Command dispatch ─────────────────────────────────────────────────────────

/** Parsed command context passed to each command handler. */
interface CommandContext {
  readonly subcommand?: string | undefined;
  readonly flags: Readonly<Record<string, boolean | string>>;
}

/** Build the dispatch map of command name to async handler. */
function buildCommandDispatchMap(
  ctx: CommandContext,
): Record<string, () => Promise<void>> {
  return {
    changelog: async () => {
      const { displayChangelog } = await import("./commands/changelog.ts");
      await displayChangelog(ctx.subcommand, ctx.flags);
    },
    chat: async () => {
      const { runChat } = await import("../channels/cli/chat.ts");
      await runChat();
    },
    config: async () => {
      const { dispatchConfigCommand } = await import("./config/config.ts");
      await dispatchConfigCommand(ctx.subcommand, ctx.flags);
    },
    connect: async () => {
      const { establishServiceConnection } = await import(
        "./commands/connect.ts"
      );
      await establishServiceConnection(ctx.subcommand, ctx.flags);
    },
    cron: async () => {
      const { dispatchCronCommand } = await import("./commands/cron.ts");
      await dispatchCronCommand(ctx.subcommand, ctx.flags);
    },
    disconnect: async () => {
      const { terminateServiceConnection } = await import(
        "./commands/connect.ts"
      );
      await terminateServiceConnection(ctx.subcommand, ctx.flags);
    },
    dive: () => launchDiveWizard(ctx.flags),
    patrol: () => launchPatrolDiagnostics(),
    run: async () => {
      const { runStart } = await import("../gateway/startup/startup.ts");
      await runStart();
    },
    skill: async () => {
      const { dispatchSkillCommand } = await import("./commands/skill.ts");
      const { createReefRegistry, createSkillLoader } = await import(
        "../gateway/skills.ts"
      );
      await dispatchSkillCommand(ctx.subcommand, ctx.flags, {
        createRegistry: () => createReefRegistry(),
        createLoader: (managedDir: string) =>
          createSkillLoader({
            directories: [managedDir],
            dirTypes: { [managedDir]: "managed" },
          }),
      });
    },
    "run-triggers": async () => {
      const { invokeTriggerCycle } = await import(
        "./commands/run_triggers.ts"
      );
      await invokeTriggerCycle();
    },
    restart: () => restartDaemonProcess(),
    start: () => launchDaemon(),
    stop: () => haltDaemon(),
    status: () => reportDaemonStatus(),
    logs: () => displayDaemonLogs(ctx.subcommand, ctx.flags),
    tidepool: async () => {
      const { launchTidepoolServer } = await import("./commands/tidepool.ts");
      await launchTidepoolServer(ctx.subcommand, ctx.flags);
    },
    uninstall: async () => {
      const { runUninstall } = await import("./commands/uninstall.ts");
      await runUninstall();
    },
    update: () => installUpdate(),
    version: () => {
      showVersion();
      return Promise.resolve();
    },
    help: () => {
      showHelp();
      return Promise.resolve();
    },
  };
}

/** Check whether a config file exists at the resolved path. */
async function detectConfigExists(): Promise<boolean> {
  try {
    await Deno.stat(resolveConfigPath());
    return true;
  } catch {
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/** Main CLI entry point. */
async function main(): Promise<void> {
  // Initialize logger for interactive CLI commands (dive, patrol, config, etc.).
  // Guard preserves any test-configured logger already set before main() runs —
  // without it, test loggers would be overridden here at process startup.
  if (!isLoggerInitialized()) {
    initLogger({ level: "INFO", console: false });
  }
  enableWindowsAnsi();
  await cleanupOldBinary();

  const configExists = await detectConfigExists();
  const parsed = parseCommand(Deno.args, { configExists });
  const dispatch = buildCommandDispatchMap(parsed);
  const handler = dispatch[parsed.command] ?? dispatch["help"];
  await handler();
}

// Execute main if this is the entry point
if (import.meta.main) {
  // Force-exit after completion to prevent Deno from hanging on Windows due to
  // stdin raw-mode handles left open by interactive prompts (Cliffy). Without
  // Deno.exit(0), the process lingers for minutes after "Daemon restarted" is
  // printed on Windows because the TTY handle is never fully released.
  main().then(() => Deno.exit(0)).catch((err) => {
    log.error("Fatal startup error", { operation: "main", err });
    console.error("Fatal error:", err);
    Deno.exit(1);
  });
}
