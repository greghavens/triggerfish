/**
 * CLI config command — manages triggerfish.yaml interactively.
 *
 * Provides CHANNEL_TYPES, PLUGIN_TYPES constants, all prompt*Config helpers,
 * set/getNestedValue, promptDaemonRestart, all runConfig* functions, and the
 * runConfig() dispatcher.
 * @module
 */

import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { join } from "@std/path";
import { Confirm, Input, Select } from "@cliffy/prompt";
import { backupConfig, expandTilde, resolveConfigPath } from "./paths.ts";
import { getDaemonStatus, installAndStartDaemon, stopDaemon } from "./daemon.ts";
import { validateConfig } from "../core/config.ts";
import { createKeychain } from "../secrets/keychain.ts";
import { findSecretRefs } from "../secrets/resolver.ts";
import {
  checkSignalCli,
  downloadSignalCli,
  fetchLatestVersion,
  isDaemonRunning,
  renderQrCode,
  startDaemon,
  startLinkProcess,
  waitForDaemon,
} from "../channels/signal/setup.ts";

/** Supported channel types for add-channel. */
export const CHANNEL_TYPES = [
  "telegram",
  "slack",
  "discord",
  "whatsapp",
  "webchat",
  "email",
  "signal",
] as const;

type ChannelType = typeof CHANNEL_TYPES[number];

export const PLUGIN_TYPES = [
  "obsidian",
] as const;

type PluginType = typeof PLUGIN_TYPES[number];

/** Prompt for channel-specific config fields and return the config object. */
export async function promptChannelConfig(
  channelType: ChannelType,
): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = {};

  switch (channelType) {
    case "telegram": {
      config.botToken = await Input.prompt({
        message: "Bot token (from @BotFather)",
      });
      const ownerId = await Input.prompt({
        message:
          "Your Telegram user ID (numeric, message @getmyid_bot for your ID number)",
      });
      config.ownerId = parseInt(ownerId, 10) || 0;
      config.classification = await Select.prompt({
        message: "Classification level",
        options: ["INTERNAL", "PUBLIC", "CONFIDENTIAL", "RESTRICTED"],
        default: "INTERNAL",
      });

      break;
    }

    case "slack": {
      config.botToken = await Input.prompt({
        message: "Bot token (xoxb-...)",
      });
      config.appToken = await Input.prompt({
        message: "App token (xapp-... for Socket Mode)",
      });
      config.signingSecret = await Input.prompt({
        message: "Signing secret",
      });
      const slackOwner = await Input.prompt({
        message: "Your Slack user ID (optional, e.g. U012ABC3DEF)",
        default: "",
      });
      if (slackOwner.length > 0) {
        config.ownerId = slackOwner;
      }
      config.classification = await Select.prompt({
        message: "Classification level",
        options: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
        default: "PUBLIC",
      });
      break;
    }

    case "discord": {
      console.log("\n  To set up a Discord bot:\n");
      console.log("    1. Go to https://discord.com/developers/applications");
      console.log('    2. Click "New Application" → name it (e.g. "Triggerfish")');
      console.log("    3. Go to Bot in the sidebar → Reset Token → copy the token");
      console.log("    4. Enable these Privileged Gateway Intents on the Bot page:");
      console.log("       - Message Content Intent (required to read messages)");
      console.log("       - Server Members Intent (optional, for member lookup)");
      console.log("    5. Go to OAuth2 → URL Generator → select 'bot' scope");
      console.log("       Under Bot Permissions, select:");
      console.log("       - Send Messages");
      console.log("       - Read Message History");
      console.log("       - View Channels");
      console.log("    6. Copy the generated URL → open in browser → invite bot to your server");
      console.log("");
      console.log("  To find your Discord user ID:");
      console.log("    Settings → Advanced → enable Developer Mode");
      console.log("    Then click your username → Copy User ID\n");

      config.botToken = await Input.prompt({
        message: "Bot token",
      });
      const discordOwner = await Input.prompt({
        message: "Your Discord user ID (optional, snowflake)",
        default: "",
      });
      if (discordOwner.length > 0) {
        config.ownerId = discordOwner;
      }
      config.classification = await Select.prompt({
        message: "Classification level",
        options: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
        default: "PUBLIC",
      });
      break;
    }

    case "whatsapp": {
      config.accessToken = await Input.prompt({
        message: "Meta Business API access token",
      });
      config.phoneNumberId = await Input.prompt({
        message: "Phone number ID",
      });
      config.verifyToken = await Input.prompt({
        message: "Webhook verify token",
      });
      const webhookPort = await Input.prompt({
        message: "Webhook port",
        default: "8443",
      });
      config.webhookPort = parseInt(webhookPort, 10) || 8443;
      const ownerPhone = await Input.prompt({
        message: "Owner phone number (optional, for owner detection)",
        default: "",
      });
      if (ownerPhone.length > 0) {
        config.ownerPhone = ownerPhone;
      }
      config.classification = await Select.prompt({
        message: "Classification level",
        options: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
        default: "PUBLIC",
      });
      break;
    }

    case "webchat": {
      const port = await Input.prompt({
        message: "WebChat port",
        default: "8765",
      });
      config.port = parseInt(port, 10) || 8765;
      config.classification = await Select.prompt({
        message: "Classification level",
        options: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
        default: "PUBLIC",
      });
      break;
    }

    case "email": {
      config.smtpApiUrl = await Input.prompt({
        message: "SMTP relay API URL (e.g. SendGrid, Mailgun endpoint)",
      });
      config.smtpApiKey = await Input.prompt({
        message: "SMTP relay API key",
      });
      config.imapHost = await Input.prompt({
        message: "IMAP server hostname",
      });
      const imapPort = await Input.prompt({
        message: "IMAP port",
        default: "993",
      });
      config.imapPort = parseInt(imapPort, 10) || 993;
      config.imapUser = await Input.prompt({
        message: "IMAP username (email address)",
      });
      config.imapPassword = await Input.prompt({
        message: "IMAP password",
      });
      config.fromAddress = await Input.prompt({
        message: "From address for outgoing mail",
      });
      const pollInterval = await Input.prompt({
        message: "Poll interval (ms)",
        default: "30000",
      });
      config.pollInterval = parseInt(pollInterval, 10) || 30000;
      const ownerEmail = await Input.prompt({
        message: "Owner email (optional, for owner detection)",
        default: "",
      });
      if (ownerEmail.length > 0) {
        config.ownerEmail = ownerEmail;
      }
      config.classification = await Select.prompt({
        message: "Classification level",
        options: ["CONFIDENTIAL", "PUBLIC", "INTERNAL", "RESTRICTED"],
        default: "CONFIDENTIAL",
      });
      break;
    }

    case "signal": {
      // Step 1: Find or install signal-cli
      console.log("\nChecking for signal-cli...");
      let signalCliPath = "signal-cli";
      let signalJavaHome: string | undefined;
      const cliCheck = await checkSignalCli();

      if (cliCheck.ok) {
        signalCliPath = cliCheck.value.path;
        console.log(`  Found: ${cliCheck.value.version} (${signalCliPath})`);
        signalJavaHome = cliCheck.value.javaHome;
      } else {
        // Not found — offer to download
        console.log(
          "  signal-cli not found on PATH or in ~/.triggerfish/bin/\n",
        );
        const installIt = await Confirm.prompt({
          message: "Download and install signal-cli?",
          default: true,
        });

        if (!installIt) {
          console.error("\n  Install signal-cli manually before continuing:");
          console.error("    https://github.com/AsamK/signal-cli/releases\n");
          Deno.exit(1);
        }

        console.log("\n  Fetching latest release info...");
        const releaseResult = await fetchLatestVersion();
        if (!releaseResult.ok) {
          console.error(`  Failed: ${releaseResult.error}`);
          Deno.exit(1);
        }

        const installResult = await downloadSignalCli(releaseResult.value);
        if (!installResult.ok) {
          console.error(`  Installation failed: ${installResult.error}`);
          Deno.exit(1);
        }

        signalCliPath = installResult.value.path;
        signalJavaHome = installResult.value.javaHome;
      }

      // Step 2: Get phone number
      config.account = await Input.prompt({
        message: "Your Signal phone number (E.164 format, e.g. +15551234567)",
      });

      // Step 3: Link or skip
      const setupMode = await Select.prompt({
        message: "Device setup",
        options: [
          {
            name: "Link to existing Signal account (scan QR with phone)",
            value: "link",
          },
          { name: "Already linked / manual setup", value: "skip" },
        ],
        default: "link",
      });

      const tcpPort = 7583;
      const tcpHost = "localhost";

      if (setupMode === "link") {
        console.log("\nStarting device link...");
        console.log(
          "Open Signal on your phone: Settings > Linked Devices > Link New Device\n",
        );

        const linkResult = await startLinkProcess(
          "Triggerfish",
          signalCliPath,
          signalJavaHome,
        );

        if (!linkResult.ok) {
          console.error(`  Link failed: ${linkResult.error}`);
          console.error(
            `  You can link manually: ${signalCliPath} link -n Triggerfish`,
          );
          Deno.exit(1);
        }

        // Display QR code
        await renderQrCode(linkResult.value.uri);
        console.log("Scan this QR code with Signal on your phone.");
        console.log("Waiting for link to complete...\n");

        // Wait for the link process to finish
        const linkStatus = await linkResult.value.process.status;
        if (!linkStatus.success) {
          console.error("  Device linking failed. Check signal-cli output.");
          Deno.exit(1);
        }
        console.log("  Device linked successfully!\n");
      }

      // Step 4: Start daemon or detect existing
      const alreadyRunning = await isDaemonRunning(tcpHost, tcpPort);
      if (alreadyRunning) {
        console.log(
          `  signal-cli daemon already running on ${tcpHost}:${tcpPort}`,
        );
      } else {
        const startIt = await Confirm.prompt({
          message: `Start signal-cli daemon on tcp://${tcpHost}:${tcpPort}?`,
          default: true,
        });
        if (startIt) {
          console.log("  Starting signal-cli daemon...");
          const daemonResult = startDaemon(
            config.account as string,
            tcpHost,
            tcpPort,
            signalCliPath,
            signalJavaHome,
          );
          if (!daemonResult.ok) {
            console.error(`  Failed: ${daemonResult.error}`);
            console.error(
              `  Start manually: ${signalCliPath} -a ${config.account} daemon --tcp localhost:7583`,
            );
          } else {
            const ready = await waitForDaemon(tcpHost, tcpPort);
            if (ready) {
              console.log("  Daemon is running.");
            } else {
              const stderr = await daemonResult.value.stderrText();
              console.error(
                "  Daemon started but not reachable yet. It may still be initializing.",
              );
              if (stderr) {
                console.error(`  signal-cli stderr: ${stderr}`);
              }
              console.error(
                `  Check: ${signalCliPath} -a ${config.account} daemon --tcp localhost:7583`,
              );
            }
          }
        } else {
          console.log("\n  Start it manually before running Triggerfish:");
          console.log(
            `  ${signalCliPath} -a ${config.account} daemon --tcp ${tcpHost}:${tcpPort}\n`,
          );
        }
      }

      config.endpoint = `tcp://${tcpHost}:${tcpPort}`;

      // Step 5: Policy config
      const enablePairing = await Confirm.prompt({
        message:
          "Enable pairing mode? (new contacts must send a one-time code before chatting)",
        default: false,
      });
      if (enablePairing) {
        config.pairing = true;
        console.log(
          "\n  Pairing mode: new contacts must send a 6-digit code to start chatting.",
        );
        console.log(
          '  Generate codes at runtime: ask your agent "generate a pairing code for Signal"',
        );
        console.log(
          "  Codes expire after 5 minutes and can only be used once.\n",
        );
      }
      config.defaultGroupMode = await Select.prompt({
        message: "Default group chat mode",
        options: [
          { name: "Always respond", value: "always" },
          { name: "Only when mentioned", value: "mentioned-only" },
          { name: "Owner-only commands", value: "owner-only" },
        ],
        default: "always",
      });
      config.classification = await Select.prompt({
        message: "Classification level",
        options: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
        default: "PUBLIC",
      });
      break;
    }
  }

  return config;
}

/** Prompt for plugin-specific config fields and return the config object. */
export async function promptPluginConfig(
  pluginType: PluginType,
): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = {};

  switch (pluginType) {
    case "obsidian": {
      // Vault path with validation
      let vaultPath = "";
      while (true) {
        vaultPath = await Input.prompt({
          message: "Path to your Obsidian vault",
        });
        if (vaultPath.length === 0) {
          console.log("  Vault path is required.");
          continue;
        }
        // Expand ~ to home directory
        vaultPath = expandTilde(vaultPath);
        // Validate .obsidian/ marker
        try {
          await Deno.stat(join(vaultPath, ".obsidian"));
          break;
        } catch {
          console.log(
            `  Not a valid Obsidian vault (no .obsidian/ folder found at ${vaultPath})`,
          );
          console.log("  Please enter the root folder of your Obsidian vault.");
        }
      }
      config.enabled = true;
      config.vault_path = vaultPath;

      config.classification = await Select.prompt({
        message: "Vault classification level",
        options: ["INTERNAL", "PUBLIC", "CONFIDENTIAL", "RESTRICTED"],
        default: "INTERNAL",
      });

      const enableDaily = await Confirm.prompt({
        message: "Enable daily notes?",
        default: true,
      });
      if (enableDaily) {
        config.daily_notes = {
          folder: "daily",
          date_format: "YYYY-MM-DD",
        };
      }

      console.log("  ✓ Obsidian vault configured");
      break;
    }
  }

  return config;
}

/**
 * Set a nested value in an object using a dotted key path.
 * Creates intermediate objects as needed.
 */
export function setNestedValue(
  obj: Record<string, unknown>,
  keyPath: string,
  value: unknown,
): void {
  const parts = keyPath.split(".");
  // deno-lint-ignore no-explicit-any
  let current: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] === undefined || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Get a nested value from an object using a dotted key path.
 */
export function getNestedValue(
  obj: Record<string, unknown>,
  keyPath: string,
): unknown {
  const parts = keyPath.split(".");
  // deno-lint-ignore no-explicit-any
  let current: any = obj;
  for (const part of parts) {
    if (
      current === undefined || current === null || typeof current !== "object"
    ) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

/**
 * Prompt the user to restart the daemon if it's running.
 * Shared by config set, add-channel, and add-plugin commands.
 */
export async function promptDaemonRestart(): Promise<void> {
  const status = await getDaemonStatus();
  if (status.running) {
    const restart = await Confirm.prompt({
      message: "Restart daemon to apply?",
      default: true,
    });
    if (restart) {
      const stopResult = await stopDaemon();
      if (!stopResult.ok) {
        console.log(`✗ Failed to stop daemon: ${stopResult.message}`);
        return;
      }
      const startResult = await installAndStartDaemon(Deno.execPath());
      if (startResult.ok) {
        console.log("✓ Daemon restarted");
      } else {
        console.log(`✗ ${startResult.message}`);
      }
    }
  } else {
    console.log("Daemon is not running. Start it with: triggerfish start");
  }
}

/**
 * Set a config value in triggerfish.yaml by dotted key path.
 */
export async function runConfigSet(
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  const key = flags["config_key"] as string | undefined;
  const rawValue = flags["config_value"] as string | undefined;

  if (!key || rawValue === undefined) {
    console.error("Usage: triggerfish config set <key> <value>");
    Deno.exit(1);
  }

  const configPath = resolveConfigPath();

  let rawYaml: string;
  try {
    rawYaml = await Deno.readTextFile(configPath);
  } catch {
    console.error(`Config not found at ${configPath}`);
    console.error("Run 'triggerfish dive' to create initial config.");
    Deno.exit(1);
  }

  const parsed = parseYaml(rawYaml) as Record<string, unknown>;

  // Coerce value: booleans and numbers
  let value: unknown = rawValue;
  if (rawValue === "true") value = true;
  else if (rawValue === "false") value = false;
  else if (/^\d+$/.test(rawValue)) value = parseInt(rawValue, 10);

  setNestedValue(parsed, key, value);

  await backupConfig(configPath);
  const yaml = stringifyYaml(parsed);
  const content =
    `# Triggerfish Configuration\n# Generated by triggerfish dive\n\n${yaml}`;
  await Deno.writeTextFile(configPath, content);

  // Mask secrets in output
  const display =
    key.includes("key") || key.includes("secret") || key.includes("token")
      ? `${String(rawValue).slice(0, 4)}...${String(rawValue).slice(-4)}`
      : String(value);

  console.log(`\n  ${key} = ${display}\n`);

  await promptDaemonRestart();
}

/**
 * Get a config value from triggerfish.yaml by dotted key path.
 */
export function runConfigGet(
  flags: Readonly<Record<string, boolean | string>>,
): void {
  const key = flags["config_key"] as string | undefined;

  if (!key) {
    console.error("Usage: triggerfish config get <key>");
    Deno.exit(1);
  }

  const configPath = resolveConfigPath();

  let rawYaml: string;
  try {
    rawYaml = Deno.readTextFileSync(configPath);
  } catch {
    console.error(`Config not found at ${configPath}`);
    Deno.exit(1);
  }

  const parsed = parseYaml(rawYaml) as Record<string, unknown>;
  const value = getNestedValue(parsed, key);

  if (value === undefined) {
    console.log(`\n  ${key} is not set\n`);
  } else {
    // Mask secrets in output
    const display =
      key.includes("key") || key.includes("secret") || key.includes("token")
        ? `${String(value).slice(0, 4)}...${String(value).slice(-4)}`
        : String(value);
    console.log(`\n  ${key} = ${display}\n`);
  }
}

/**
 * Validate triggerfish.yaml and report errors.
 */
export function runConfigValidate(): void {
  const configPath = resolveConfigPath();

  let rawYaml: string;
  try {
    rawYaml = Deno.readTextFileSync(configPath);
  } catch {
    console.error(`Config not found at ${configPath}`);
    console.error("Run 'triggerfish dive' to create initial config.");
    Deno.exit(1);
  }

  // Check YAML parses
  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  YAML parse error: ${message}\n`);
    Deno.exit(1);
  }

  if (typeof parsed !== "object" || parsed === null) {
    console.error("\n  Config file did not parse to an object.\n");
    Deno.exit(1);
  }

  // Run structural validation
  const result = validateConfig(parsed as Record<string, unknown>);
  if (!result.ok) {
    console.error(`\n  Validation error: ${result.error}\n`);
    Deno.exit(1);
  }

  // Additional warnings (non-fatal)
  const config = parsed as Record<string, unknown>;
  const warnings: string[] = [];

  const models = config.models as Record<string, unknown> | undefined;
  if (models?.providers) {
    const providers = models.providers as Record<string, unknown>;
    if (Object.keys(providers).length === 0) {
      warnings.push("No LLM providers configured under models.providers");
    }
  }

  const channels = config.channels as Record<string, unknown> | undefined;
  if (!channels || Object.keys(channels).length === 0) {
    warnings.push("No channels configured");
  }

  console.log(`\n  Configuration valid: ${configPath}`);
  if (warnings.length > 0) {
    console.log("\n  Warnings:");
    for (const w of warnings) {
      console.log(`    - ${w}`);
    }
  }
  console.log();
}

/**
 * Store a secret in the OS keychain.
 */
export async function runConfigSetSecret(
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  const key = flags["secret_key"] as string | undefined;
  const value = flags["secret_value"] as string | undefined;

  if (!key || value === undefined) {
    console.error("Usage: triggerfish config set-secret <key> <value>");
    Deno.exit(1);
  }

  const store = createKeychain();
  const result = await store.setSecret(key, value);
  if (result.ok) {
    console.log(`Secret "${key}" stored in keychain.`);
  } else {
    console.error(`Failed to store secret: ${result.error}`);
    Deno.exit(1);
  }
}

/**
 * Retrieve a secret from the OS keychain.
 */
export async function runConfigGetSecret(
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  const key = flags["secret_key"] as string | undefined;

  if (!key) {
    console.error("Usage: triggerfish config get-secret <key>");
    Deno.exit(1);
  }

  const store = createKeychain();
  const result = await store.getSecret(key);
  if (result.ok) {
    console.log(result.value);
  } else {
    console.error(`Secret "${key}" not found in keychain.`);
    Deno.exit(1);
  }
}

/**
 * Add a channel to triggerfish.yaml interactively.
 */
export async function runConfigAddChannel(
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  const configPath = resolveConfigPath();

  // Require interactive terminal
  if (!Deno.stdin.isTerminal()) {
    console.error("Error: add-channel requires an interactive terminal.");
    Deno.exit(1);
  }

  // Determine channel type
  let channelType: ChannelType;
  const flagType = flags.channel_type as string | undefined;

  if (flagType && CHANNEL_TYPES.includes(flagType as ChannelType)) {
    channelType = flagType as ChannelType;
  } else {
    if (flagType) {
      console.log(`Unknown channel type: ${flagType}\n`);
    }
    channelType = (await Select.prompt({
      message: "Channel type",
      options: [
        { name: "Telegram", value: "telegram" },
        { name: "Signal (via signal-cli)", value: "signal" },
        { name: "Slack", value: "slack" },
        { name: "Discord", value: "discord" },
        { name: "WhatsApp", value: "whatsapp" },
        { name: "WebChat (browser-based)", value: "webchat" },
        { name: "Email (IMAP + SMTP relay)", value: "email" },
      ],
    })) as ChannelType;
  }

  // Load existing config
  let rawYaml: string;
  try {
    rawYaml = await Deno.readTextFile(configPath);
  } catch {
    console.error(`Config not found at ${configPath}`);
    console.error("Run 'triggerfish dive' to create initial config.");
    Deno.exit(1);
  }

  const parsed = parseYaml(rawYaml) as Record<string, unknown>;
  const channels = (parsed.channels ?? {}) as Record<string, unknown>;

  // Check if channel already exists
  if (channels[channelType]) {
    const overwrite = await Confirm.prompt({
      message: `${channelType} is already configured. Overwrite?`,
      default: false,
    });
    if (!overwrite) {
      console.log("Cancelled.");
      return;
    }
  }

  console.log(`\nConfiguring ${channelType}...\n`);

  // Prompt for channel-specific fields
  const channelConfig = await promptChannelConfig(channelType);

  // Merge into config
  channels[channelType] = channelConfig;
  parsed.channels = channels;

  // Write back (with backup)
  await backupConfig(configPath);
  const yaml = stringifyYaml(parsed);
  const content =
    `# Triggerfish Configuration\n# Generated by triggerfish dive\n\n${yaml}`;
  await Deno.writeTextFile(configPath, content);

  console.log(`\n✓ ${channelType} added to triggerfish.yaml`);

  await promptDaemonRestart();
}

/**
 * Remove a channel from triggerfish.yaml.
 *
 * Backs up the config before writing, confirms with the user,
 * and prompts for a daemon restart if the daemon is running.
 */
export async function runConfigRemoveChannel(
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  const configPath = resolveConfigPath();

  // Determine channel type
  let channelType: string;
  const flagType = flags.channel_type as string | undefined;

  if (flagType && CHANNEL_TYPES.includes(flagType as ChannelType)) {
    channelType = flagType;
  } else {
    // Load config to show only configured channels
    let rawYaml: string;
    try {
      rawYaml = await Deno.readTextFile(configPath);
    } catch {
      console.error(`Config not found at ${configPath}`);
      console.error("Run 'triggerfish dive' to create initial config.");
      Deno.exit(1);
    }

    const parsed = parseYaml(rawYaml) as Record<string, unknown>;
    const channels = (parsed.channels ?? {}) as Record<string, unknown>;
    const configured = Object.keys(channels).filter((k) =>
      CHANNEL_TYPES.includes(k as ChannelType)
    );

    if (configured.length === 0) {
      console.log("No channels configured.");
      return;
    }

    if (!Deno.stdin.isTerminal()) {
      console.error(
        "Error: remove-channel requires a channel type argument in non-interactive mode.",
      );
      console.error(
        `Usage: triggerfish config remove-channel <${configured.join("|")}>`,
      );
      Deno.exit(1);
    }

    channelType = await Select.prompt({
      message: "Channel to remove",
      options: configured.map((c) => ({ name: c, value: c })),
    });
  }

  // Load config
  let rawYaml: string;
  try {
    rawYaml = await Deno.readTextFile(configPath);
  } catch {
    console.error(`Config not found at ${configPath}`);
    Deno.exit(1);
  }

  const parsed = parseYaml(rawYaml) as Record<string, unknown>;
  const channels = (parsed.channels ?? {}) as Record<string, unknown>;

  if (!channels[channelType]) {
    console.log(`Channel '${channelType}' is not configured.`);
    return;
  }

  // Confirm removal (interactive only)
  if (Deno.stdin.isTerminal()) {
    const confirm = await Confirm.prompt({
      message: `Remove ${channelType} channel configuration?`,
      default: false,
    });
    if (!confirm) {
      console.log("Cancelled.");
      return;
    }
  }

  // Remove and write back
  delete channels[channelType];
  parsed.channels = channels;

  await backupConfig(configPath);
  const yaml = stringifyYaml(parsed);
  const content =
    `# Triggerfish Configuration\n# Generated by triggerfish dive\n\n${yaml}`;
  await Deno.writeTextFile(configPath, content);

  console.log(`\n✓ ${channelType} removed from triggerfish.yaml`);

  await promptDaemonRestart();
}

/**
 * Add a plugin to triggerfish.yaml interactively.
 */
export async function runConfigAddPlugin(
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  const configPath = resolveConfigPath();

  // Require interactive terminal
  if (!Deno.stdin.isTerminal()) {
    console.error("Error: add-plugin requires an interactive terminal.");
    Deno.exit(1);
  }

  // Determine plugin type
  let pluginType: PluginType;
  const flagType = flags.plugin_type as string | undefined;

  if (flagType && PLUGIN_TYPES.includes(flagType as PluginType)) {
    pluginType = flagType as PluginType;
  } else {
    if (flagType) {
      console.log(`Unknown plugin type: ${flagType}\n`);
    }
    pluginType = (await Select.prompt({
      message: "Plugin type",
      options: [
        { name: "Obsidian (local vault integration)", value: "obsidian" },
      ],
    })) as PluginType;
  }

  // Load existing config
  let rawYaml: string;
  try {
    rawYaml = await Deno.readTextFile(configPath);
  } catch {
    console.error(`Config not found at ${configPath}`);
    console.error("Run 'triggerfish dive' to create initial config.");
    Deno.exit(1);
  }

  const parsed = parseYaml(rawYaml) as Record<string, unknown>;
  const plugins = (parsed.plugins ?? {}) as Record<string, unknown>;

  // Check if plugin already exists
  if (plugins[pluginType]) {
    const overwrite = await Confirm.prompt({
      message: `${pluginType} is already configured. Overwrite?`,
      default: false,
    });
    if (!overwrite) {
      console.log("Cancelled.");
      return;
    }
  }

  console.log(`\nConfiguring ${pluginType}...\n`);

  // Prompt for plugin-specific fields
  const pluginConfig = await promptPluginConfig(pluginType);

  // Merge into config
  plugins[pluginType] = pluginConfig;
  parsed.plugins = plugins;

  // Write back (with backup)
  await backupConfig(configPath);
  const yaml = stringifyYaml(parsed);
  const content =
    `# Triggerfish Configuration\n# Generated by triggerfish dive\n\n${yaml}`;
  await Deno.writeTextFile(configPath, content);

  console.log(`\n✓ ${pluginType} plugin added to triggerfish.yaml`);

  await promptDaemonRestart();
}

/**
 * Canonical set of known-secret config field paths and their keychain key names.
 *
 * Used by `migrate-secrets` to detect plaintext values in config fields
 * that should be stored in the keychain.
 */
const KNOWN_SECRET_FIELDS: ReadonlyArray<{
  readonly path: string;
  readonly keychainKey: (parsed: Record<string, unknown>) => string | undefined;
}> = [
  {
    path: "web.search.api_key",
    keychainKey: () => "web:search:apiKey",
  },
  {
    path: "channels.telegram.botToken",
    keychainKey: () => "telegram:botToken",
  },
  {
    path: "channels.discord.botToken",
    keychainKey: () => "discord:botToken",
  },
  {
    path: "channels.slack.botToken",
    keychainKey: () => "slack:botToken",
  },
  {
    path: "channels.slack.appToken",
    keychainKey: () => "slack:appToken",
  },
  {
    path: "channels.slack.signingSecret",
    keychainKey: () => "slack:signingSecret",
  },
  {
    path: "channels.whatsapp.accessToken",
    keychainKey: () => "whatsapp:accessToken",
  },
  {
    path: "channels.whatsapp.webhookVerifyToken",
    keychainKey: () => "whatsapp:webhookVerifyToken",
  },
  {
    path: "channels.email.smtpPassword",
    keychainKey: () => "email:smtpPassword",
  },
  {
    path: "channels.email.imapPassword",
    keychainKey: () => "email:imapPassword",
  },
];

/**
 * Migrate plaintext secrets in triggerfish.yaml to the OS keychain.
 *
 * Detects plaintext values in known secret fields, stores them in
 * the keychain, and rewrites the config with `secret:` references.
 * Creates a timestamped backup before modifying the file.
 */
export async function runConfigMigrateSecrets(): Promise<void> {
  const configPath = resolveConfigPath();

  let raw: string;
  try {
    raw = await Deno.readTextFile(configPath);
  } catch {
    console.error(`Cannot read config: ${configPath}`);
    Deno.exit(1);
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    const p = parseYaml(raw);
    if (typeof p !== "object" || p === null) {
      console.error("Config file did not parse to an object");
      Deno.exit(1);
      return;
    }
    parsed = p as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to parse config: ${message}`);
    Deno.exit(1);
    return;
  }

  // Also detect provider apiKey fields dynamically
  const providers = (
    (parsed.models as Record<string, unknown> | undefined)
      ?.providers
  ) as Record<string, unknown> | undefined;

  const dynamicSecretFields: Array<{
    path: string;
    keychainKey: () => string;
  }> = [];

  if (providers) {
    for (const providerName of Object.keys(providers)) {
      dynamicSecretFields.push({
        path: `models.providers.${providerName}.apiKey`,
        keychainKey: () => `provider:${providerName}:apiKey`,
      });
    }
  }

  const allFields = [...KNOWN_SECRET_FIELDS, ...dynamicSecretFields];

  const store = createKeychain();
  const migrated: Array<{ path: string; keychainKey: string }> = [];
  const alreadyRefs: string[] = [];

  for (const field of allFields) {
    const value = getNestedValue(parsed, field.path);
    if (typeof value !== "string" || value.length === 0) continue;

    if (value.startsWith("secret:")) {
      alreadyRefs.push(field.path);
      continue;
    }

    const keychainKey = field.keychainKey(parsed);
    if (!keychainKey) continue;

    // Store in keychain
    const result = await store.setSecret(keychainKey, value);
    if (!result.ok) {
      console.error(`Failed to store secret for ${field.path}: ${result.error}`);
      Deno.exit(1);
      return;
    }

    // Update parsed config with reference
    setNestedValue(parsed, field.path, `secret:${keychainKey}`);
    migrated.push({ path: field.path, keychainKey });
  }

  if (migrated.length === 0) {
    if (alreadyRefs.length > 0) {
      console.log(`All ${alreadyRefs.length} secret field(s) already use secret: references. Nothing to migrate.`);
    } else {
      console.log("No plaintext secrets found in known fields. Nothing to migrate.");
    }
    return;
  }

  // Create backup before modifying
  await backupConfig(configPath);

  // Write updated config
  const yaml = stringifyYaml(parsed);
  const content =
    `# Triggerfish Configuration\n# Generated by triggerfish dive\n\n${yaml}`;
  await Deno.writeTextFile(configPath, content);

  console.log(`\nMigrated ${migrated.length} secret(s) to OS keychain:\n`);
  for (const { path, keychainKey } of migrated) {
    console.log(`  ${path}  →  secret:${keychainKey}`);
  }
  console.log(`\nBackup saved. Config updated: ${configPath}`);

  // Report any refs already in place
  if (alreadyRefs.length > 0) {
    console.log(`\n${alreadyRefs.length} field(s) already used secret: references (unchanged):`);
    for (const p of alreadyRefs) {
      console.log(`  ${p}`);
    }
  }

  // Show any other secret: refs in the config for awareness
  const allRefs = findSecretRefs(parsed);
  if (allRefs.length > 0) {
    console.log(`\n${allRefs.length} total secret: reference(s) now in config.`);
  }

  console.log();
}

/**
 * Config command dispatcher.
 */
export async function runConfig(
  subcommand: string | undefined,
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  switch (subcommand) {
    case "add-channel":
      await runConfigAddChannel(flags);
      break;
    case "remove-channel":
      await runConfigRemoveChannel(flags);
      break;
    case "add-plugin":
      await runConfigAddPlugin(flags);
      break;
    case "set":
      await runConfigSet(flags);
      break;
    case "get":
      runConfigGet(flags);
      break;
    case "validate":
      runConfigValidate();
      break;
    case "set-secret":
      await runConfigSetSecret(flags);
      break;
    case "get-secret":
      await runConfigGetSecret(flags);
      break;
    case "migrate-secrets":
      await runConfigMigrateSecrets();
      break;
    default:
      console.log(`
CONFIG USAGE:
  triggerfish config set <key> <value>    Set a configuration value
  triggerfish config get <key>            Get a configuration value
  triggerfish config validate             Validate configuration
  triggerfish config add-channel [type]      Add a channel interactively
  triggerfish config remove-channel [type]   Remove a channel
  triggerfish config add-plugin [name]       Add a plugin interactively
  triggerfish config set-secret <key> <value>  Store a secret in OS keychain
  triggerfish config get-secret <key>          Retrieve a secret from OS keychain
  triggerfish config migrate-secrets           Migrate plaintext secrets to keychain

KEYS use dotted paths into triggerfish.yaml:
  web.search.provider              Search provider (brave)
  web.search.api_key               Search API key
  models.primary.provider          Primary provider name
  models.primary.model             Primary model name
  models.providers.<name>.apiKey   Provider API key
  scheduler.trigger.enabled        Enable trigger wakeups
  plugins.obsidian.vault_path      Obsidian vault path
  plugins.obsidian.classification  Vault classification level

CHANNEL TYPES:
  telegram, slack, discord, whatsapp, webchat, email

PLUGIN TYPES:
  obsidian

EXAMPLES:
  triggerfish config set models.primary.model claude-sonnet
  triggerfish config set web.search.provider brave
  triggerfish config set web.search.api_key sk-abc123
  triggerfish config set scheduler.trigger.enabled true
  triggerfish config get models.primary.model
  triggerfish config add-channel telegram
  triggerfish config remove-channel signal
  triggerfish config add-plugin obsidian
  triggerfish config set-secret github-pat ghp_...
  triggerfish config get-secret github-pat
  triggerfish config migrate-secrets
`);
      break;
  }
}
