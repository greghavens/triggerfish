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
  "restart",
  "run",
  "run-triggers",
  "sentinel",
  "skill",
  "start",
  "stop",
  "status",
  "logs",
  "config",
  "dive",
  "patrol",
  "tidepool",
  "uninstall",
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
  if (
    (command === "tidepool" || command === "sentinel") && positional.length > 1
  ) {
    const sub = positional[1];
    return { command, subcommand: sub, flags };
  }
  if (command === "skill" && positional.length > 1) {
    const sub = positional[1];
    if (sub === "search" && positional.length > 2) {
      flags["query"] = positional.slice(2).join(" ");
    } else if (sub === "install" && positional.length > 2) {
      flags["skill_name"] = positional[2];
    } else if (sub === "update" && positional.length > 2) {
      flags["skill_name"] = positional[2];
    } else if (sub === "publish" && positional.length > 2) {
      flags["skill_path"] = positional[2];
    }
    return { command, subcommand: sub, flags };
  }
  if (command === "changelog" && positional.length > 1) {
    const sub = positional[1];
    if (positional.length > 2) {
      flags["changelog_to"] = positional[2];
    }
    return { command, subcommand: sub, flags };
  }

  return { command, flags };
}

// ─── Help / Version ───────────────────────────────────────────────────────────

const HELP_HEADER = `
Triggerfish - Secure Multi-Channel AI Agent Platform

USAGE:
  triggerfish [command] [options]`;

const HELP_COMMANDS = `
COMMANDS:
  changelog   Show release notes between versions
  chat        Start an interactive chat session
  config      Manage configuration (add channels, etc.)
  connect     Connect an external service (e.g. Google)
  cron        Manage scheduled cron jobs
  disconnect  Disconnect an external service
  dive        First-run setup wizard (creates triggerfish.yaml)
  run         Run the gateway server in foreground
  sentinel    Investigate imported security findings and asset relationships
  skill       Manage skills from The Reef marketplace
  start       Install and start the daemon
  stop        Stop the daemon
  status      Show daemon status
  logs        View or bundle daemon logs
  patrol      Run health diagnostics
  restart     Stop and restart the daemon
  tidepool    Open Tidepool UI (native window or browser)
  uninstall   Remove Triggerfish completely
  update      Pull latest code, recompile, and restart
  help        Show this help message
  version     Show version information`;

const HELP_CONFIG_SUBCOMMANDS = `
CONFIG SUBCOMMANDS:
  config set <key> <value>                 Set a config value (dotted YAML path)
  config get <key>                         Get a config value
  config validate                          Validate configuration
  config add-channel [type]                Add a channel (telegram, slack, discord, etc.)
  config add-plugin [name]                 Add a plugin (obsidian)
  config set-secret <key> <value>          Store a secret in OS keychain
  config get-secret <key>                  Retrieve a secret from OS keychain
  config migrate-secrets                   Migrate plaintext secrets to keychain`;

const HELP_OTHER_SUBCOMMANDS = `
SKILL SUBCOMMANDS:
  skill search <query>                   Search The Reef for skills
  skill install <name>                   Install a skill from The Reef
  skill update [name]                    Check for available updates
  skill publish <path>                   Validate and prepare for publishing
  skill list                             List installed managed skills

LOGS SUBCOMMANDS:
  logs view                              View daemon logs (default, --tail to follow)
  logs bundle                            Archive all log files (.tar.gz or .zip)

TIDEPOOL SUBCOMMANDS:
  tidepool                               Open native window (or browser fallback)
  tidepool open                          Same as above
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
  disconnect github                      Remove GitHub authentication`;

const HELP_EXAMPLES_CORE = `
EXAMPLES:
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
  triggerfish config add-plugin                       # Interactive plugin selection`;

const HELP_EXAMPLES_OPS =
  `  triggerfish dive                                  # Interactive setup
  triggerfish run                                   # Run gateway in foreground
  triggerfish start                                 # Install and start daemon
  triggerfish stop                                  # Stop the daemon
  triggerfish restart                               # Stop and restart daemon
  triggerfish status                                # Check daemon status
  triggerfish logs view --tail                      # Follow daemon logs
  triggerfish logs bundle                           # Archive logs into .tar.gz or .zip
  triggerfish connect google                          # Link Google account
  triggerfish disconnect google                       # Remove Google account
  triggerfish patrol                                # Health check
  triggerfish tidepool                              # Open Tidepool UI
  triggerfish tidepool url                          # Show Tidepool A2UI URL
  triggerfish uninstall                             # Remove Triggerfish completely
  triggerfish update                                # Update to latest version

For more information, visit: https://trigger.fish/docs`;

/** Display help text. */
export function showHelp(): void {
  const sections = [
    HELP_HEADER,
    HELP_COMMANDS,
    HELP_CONFIG_SUBCOMMANDS,
    HELP_OTHER_SUBCOMMANDS,
    HELP_EXAMPLES_CORE,
    HELP_EXAMPLES_OPS,
  ];
  console.log(sections.join("\n") + "\n");
}

/** Display version information. */
export function showVersion(): void {
  console.log(`Triggerfish ${VERSION}`);
}
