/**
 * CLI argument parsing, help text, and version display.
 *
 * Parses raw argv into structured ParsedCommand objects with
 * command, subcommand, and flags. Handles --version detection,
 * unknown-command fallback, and multi-positional subcommand parsing
 * for config, cron, connect, disconnect, logs, and tidepool.
 *
 * @module
 */

import { VERSION } from "./version.ts";

// ─── Command parsing ──────────────────────────────────────────────────────────

/** Known CLI commands. */
const KNOWN_COMMANDS = new Set([
  "changelog",
  "chat",
  "connect",
  "cron",
  "disconnect",
  "run",
  "run-triggers",
  "start",
  "stop",
  "status",
  "logs",
  "config",
  "dive",
  "patrol",
  "tidepool",
  "update",
  "help",
  "version",
]);

/** Options that influence default command selection. */
export interface ParseOptions {
  readonly configExists?: boolean;
}

/** Result of parsing CLI arguments. */
export interface ParsedCommand {
  readonly command: string;
  readonly subcommand?: string;
  readonly flags: Readonly<Record<string, boolean | string>>;
}

/**
 * Parse CLI arguments into a structured command object.
 *
 * @param args - Raw command-line argument array (without the binary name).
 * @param options - Optional context influencing defaults.
 * @returns Parsed command with optional subcommand and flags.
 */
export function parseCommand(
  args: readonly string[],
  options: ParseOptions = {},
): ParsedCommand {
  const flags: Record<string, boolean | string> = {};

  // Handle special flags first
  if (args.includes("--version")) {
    return { command: "version", flags };
  }

  // Extract flags from args (supports --key and --key=value)
  const positional: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        flags[key] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  // No positional args
  if (positional.length === 0) {
    const configExists = options.configExists ?? true;
    return { command: configExists ? "help" : "dive", flags };
  }

  const command = positional[0];

  // Unknown command → help
  if (!KNOWN_COMMANDS.has(command)) {
    return { command: "help", flags };
  }

  // Commands with subcommands
  if (command === "config" && positional.length > 1) {
    const sub = positional[1];
    if (sub === "add-channel" && positional.length > 2) {
      flags["channel_type"] = positional[2];
    } else if (sub === "remove-channel" && positional.length > 2) {
      flags["channel_type"] = positional[2];
    } else if (sub === "add-plugin" && positional.length > 2) {
      flags["plugin_type"] = positional[2];
    } else if (sub === "set" && positional.length >= 4) {
      flags["config_key"] = positional[2];
      flags["config_value"] = positional.slice(3).join(" ");
    } else if (sub === "get" && positional.length >= 3) {
      flags["config_key"] = positional[2];
    } else if (sub === "set-secret" && positional.length >= 4) {
      flags["secret_key"] = positional[2];
      flags["secret_value"] = positional.slice(3).join(" ");
    } else if (sub === "get-secret" && positional.length >= 3) {
      flags["secret_key"] = positional[2];
    }
    return { command, subcommand: sub, flags };
  }
  if (command === "cron" && positional.length > 1) {
    // Capture remaining positional args as flags for cron subcommands
    const sub = positional[1];
    if (sub === "add" && positional.length >= 4) {
      flags["expression"] = positional[2];
      flags["task"] = positional.slice(3).join(" ");
    } else if (
      (sub === "delete" || sub === "history") && positional.length > 2
    ) {
      flags["job_id"] = positional[2];
    }
    return { command, subcommand: sub, flags };
  }
  if (
    (command === "connect" || command === "disconnect") && positional.length > 1
  ) {
    const sub = positional[1];
    return { command, subcommand: sub, flags };
  }
  if (command === "logs" && positional.length > 1) {
    const sub = positional[1];
    return { command, subcommand: sub, flags };
  }
  if (command === "tidepool" && positional.length > 1) {
    const sub = positional[1];
    return { command, subcommand: sub, flags };
  }
  if (command === "changelog") {
    // positional[1] = from_version (exclusive lower bound)
    // positional[2] = to_version (inclusive upper bound)
    if (positional.length > 1) flags["from_version"] = positional[1];
    if (positional.length > 2) flags["to_version"] = positional[2];
    return { command, flags };
  }

  return { command, flags };
}

// ─── Help / Version ───────────────────────────────────────────────────────────

/** Display help text. */
export function showHelp(): void {
  console.log(`
Triggerfish - Secure Multi-Channel AI Agent Platform

USAGE:
  triggerfish [command] [options]

COMMANDS:
  changelog   Show release notes between versions
  chat        Start an interactive chat session
  config      Manage configuration (add channels, etc.)
  connect     Connect an external service (e.g. Google)
  cron        Manage scheduled cron jobs
  disconnect  Disconnect an external service
  dive        First-run setup wizard (creates triggerfish.yaml)
  run         Run the gateway server in foreground
  start       Install and start the daemon
  stop        Stop the daemon
  status      Show daemon status
  logs        View or bundle daemon logs
  patrol      Run health diagnostics
  tidepool    Tidepool A2UI controls
  update      Pull latest code, recompile, and restart
  help        Show this help message
  version     Show version information

CONFIG SUBCOMMANDS:
  config set <key> <value>                 Set a config value (dotted YAML path)
  config get <key>                         Get a config value
  config validate                          Validate configuration
  config add-channel [type]                Add a channel (telegram, slack, discord, etc.)
  config add-plugin [name]                 Add a plugin (obsidian)
  config set-secret <key> <value>          Store a secret in OS keychain
  config get-secret <key>                  Retrieve a secret from OS keychain
  config migrate-secrets                   Migrate plaintext secrets to keychain

LOGS SUBCOMMANDS:
  logs view                              View daemon logs (default, --tail to follow)
  logs bundle                            Bundle all log files into a temporary directory

TIDEPOOL SUBCOMMANDS:
  tidepool url                           Print Tidepool A2UI URL (if running)

CRON SUBCOMMANDS:
  cron list                              List all cron jobs
  cron add "<schedule>" <task>           Create a new cron job
  cron delete <job_id>                   Delete a cron job
  cron history <job_id>                  Show execution history

INTEGRATIONS:
  connect google                         Authenticate with Google Workspace
  connect github                         Authenticate with GitHub
  disconnect google                      Remove Google authentication
  disconnect github                      Remove GitHub authentication

CHANGELOG:
  changelog                        Show the last 5 releases
  changelog <from>                 Show all changes since a version (e.g. 0.2.16)
  changelog <from> <to>            Show delta between two versions

EXAMPLES:
  triggerfish changelog                             # Show recent release notes
  triggerfish changelog 0.2.16                      # What changed since 0.2.16
  triggerfish changelog 0.2.16 0.3.3               # Delta between 0.2.16 and 0.3.3
  triggerfish chat                                  # Start chatting with your agent
  triggerfish cron add "0 9 * * *" morning briefing # Daily 9am task
  triggerfish cron list                             # Show all cron jobs
  triggerfish cron delete <uuid>                    # Remove a job
  triggerfish cron history <uuid>                   # View execution log
  triggerfish config set <key> <value>                  # Set any config value
  triggerfish config get <key>                          # Read any config value
  triggerfish config add-channel telegram              # Add Telegram channel
  triggerfish config add-channel                       # Interactive channel selection
  triggerfish config add-plugin obsidian              # Add Obsidian vault plugin
  triggerfish config add-plugin                       # Interactive plugin selection
  triggerfish dive                                  # Interactive setup
  triggerfish run                                   # Run gateway in foreground
  triggerfish start                                 # Install and start daemon
  triggerfish stop                                  # Stop the daemon
  triggerfish status                                # Check daemon status
  triggerfish logs view --tail                      # Follow daemon logs
  triggerfish logs bundle                           # Bundle logs into a temp directory
  triggerfish connect google                          # Link Google account
  triggerfish disconnect google                       # Remove Google account
  triggerfish patrol                                # Health check
  triggerfish tidepool url                          # Show Tidepool A2UI URL
  triggerfish update                                # Update to latest version

For more information, visit: https://trigger.fish/docs
`);
}

/** Display version information. */
export function showVersion(): void {
  console.log(`Triggerfish ${VERSION}`);
}
