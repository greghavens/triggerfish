/**
 * CLI config command — dispatcher and re-exports.
 *
 * Routes `triggerfish config <subcommand>` to the appropriate handler.
 * CRUD operations live in config_crud.ts, YAML path utilities in yaml_paths.ts,
 * channel/plugin prompts and secrets in their own modules.
 * @module
 */

import {
  applyConfigValue,
  auditConfigFile,
  fetchConfigValue,
} from "./config_crud.ts";

// ─── Re-exports (preserve public API) ──────────────────────────

export {
  CHANNEL_TYPES,
  PLUGIN_TYPES,
  readNestedYamlValue,
  writeNestedYamlValue,
} from "./yaml_paths.ts";

export {
  applyConfigValue,
  auditConfigFile,
  fetchConfigValue,
  promptDaemonRestart,
  runConfigGet,
  runConfigSet,
  runConfigValidate,
} from "./config_crud.ts";

export {
  promptChannelConfig,
  promptPluginConfig,
} from "./prompts/channel_prompts.ts";
export {
  registerChannel,
  registerPlugin,
  runConfigAddChannel,
  runConfigAddPlugin,
  runConfigRemoveChannel,
  unregisterChannel,
} from "./channels.ts";
export {
  migrateSecretsToKeychain,
  retrieveSecret,
  runConfigGetSecret,
  runConfigMigrateSecrets,
  runConfigSetSecret,
  storeSecret,
} from "./secrets.ts";

// ─── Usage text ─────────────────────────────────────────────────

const CONFIG_USAGE = `
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
`;

// ─── Dispatch helpers ───────────────────────────────────────────

/** Dispatch channel-related config subcommands. */
async function dispatchChannelSubcommand(
  subcommand: string,
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  switch (subcommand) {
    case "add-channel": {
      const { registerChannel } = await import("./channels.ts");
      await registerChannel(flags);
      break;
    }
    case "remove-channel": {
      const { unregisterChannel } = await import("./channels.ts");
      await unregisterChannel(flags);
      break;
    }
    case "add-plugin": {
      const { registerPlugin } = await import("./channels.ts");
      await registerPlugin(flags);
      break;
    }
  }
}

/** Dispatch secret-related config subcommands. */
async function dispatchSecretSubcommand(
  subcommand: string,
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  switch (subcommand) {
    case "set-secret": {
      const { storeSecret } = await import("./secrets.ts");
      await storeSecret(flags);
      break;
    }
    case "get-secret": {
      const { retrieveSecret } = await import("./secrets.ts");
      await retrieveSecret(flags);
      break;
    }
    case "migrate-secrets": {
      const { migrateSecretsToKeychain } = await import("./secrets.ts");
      await migrateSecretsToKeychain();
      break;
    }
  }
}

// ─── Dispatcher ─────────────────────────────────────────────────

const CHANNEL_SUBCOMMANDS = new Set([
  "add-channel",
  "remove-channel",
  "add-plugin",
]);
const SECRET_SUBCOMMANDS = new Set([
  "set-secret",
  "get-secret",
  "migrate-secrets",
]);

/**
 * Config command dispatcher.
 */
export async function dispatchConfigCommand(
  subcommand: string | undefined,
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  if (subcommand && CHANNEL_SUBCOMMANDS.has(subcommand)) {
    await dispatchChannelSubcommand(subcommand, flags);
  } else if (subcommand && SECRET_SUBCOMMANDS.has(subcommand)) {
    await dispatchSecretSubcommand(subcommand, flags);
  } else if (subcommand === "set") {
    await applyConfigValue(flags);
  } else if (subcommand === "get") {
    fetchConfigValue(flags);
  } else if (subcommand === "validate") {
    auditConfigFile();
  } else {
    console.log(CONFIG_USAGE);
  }
}

/** @deprecated Use dispatchConfigCommand instead */
export const runConfig = dispatchConfigCommand;
