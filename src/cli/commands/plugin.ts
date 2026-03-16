/**
 * CLI plugin command — manage plugins from The Reef and local directory.
 *
 * Provides search, install, update, publish, and list subcommands
 * for interacting with the plugin Reef registry and the local
 * `~/.triggerfish/plugins/` directory.
 *
 * Dependencies are injected from the CLI wiring layer to avoid
 * importing gateway/ from a non-startup CLI command file.
 *
 * @module
 */

import type { PluginReefRegistry } from "../../plugin/reef.ts";

import {
  listInstalledPlugins,
  scanPluginManifest,
  searchPluginReef,
} from "./plugin_list.ts";
import {
  installPluginFromReef,
  publishPluginToReef,
  upgradePluginFromReef,
} from "./plugin_install.ts";

export {
  installPluginFromReef,
  listInstalledPlugins,
  publishPluginToReef,
  scanPluginManifest,
  searchPluginReef,
  upgradePluginFromReef,
};

/** Result of a plugin security scan (matches PluginScanResult from plugin/scanner.ts). */
export interface PluginScanSummary {
  readonly ok: boolean;
  readonly warnings: readonly string[];
  readonly scannedFiles: readonly string[];
}

/** Dependencies injected by the CLI wiring layer. */
export interface PluginCommandDeps {
  /** Factory to create a plugin Reef registry client. */
  readonly createRegistry: () => PluginReefRegistry;
  /** Resolve the plugins directory path. */
  readonly resolvePluginsDir: () => string;
  /** Scan a plugin directory for security issues. Injected to avoid cli/ importing plugin/ directly. */
  readonly scanDirectory: (dir: string) => Promise<PluginScanSummary>;
}

/** Print plugin subcommand usage help. */
export function printPluginUsage(): void {
  console.log("Usage: triggerfish plugin <subcommand>");
  console.log("\nSubcommands:");
  console.log(
    "  search <query>           Search The Reef for plugins",
  );
  console.log(
    "  install <name>           Install a plugin from The Reef",
  );
  console.log(
    "  update [name]            Check for plugin updates",
  );
  console.log(
    "  publish <dir>            Validate and prepare a plugin for publishing",
  );
  console.log(
    "  scan <dir>               Run security scan on a local plugin",
  );
  console.log(
    "  list                     List locally installed plugins",
  );
}

/**
 * Dispatch plugin subcommands from the CLI.
 *
 * Routes to search, install, update, publish, scan, or list handlers
 * based on the parsed subcommand.
 */
export async function dispatchPluginCommand(
  subcommand: string | undefined,
  flags: Readonly<Record<string, boolean | string>>,
  deps: PluginCommandDeps,
): Promise<void> {
  switch (subcommand) {
    case "search":
      await searchPluginReef(flags, deps);
      break;
    case "install":
      await installPluginFromReef(flags, deps);
      break;
    case "update":
      await upgradePluginFromReef(flags, deps);
      break;
    case "publish":
      await publishPluginToReef(flags, deps);
      break;
    case "scan":
      await scanPluginManifest(flags, deps);
      break;
    case "list":
      await listInstalledPlugins(deps);
      break;
    default:
      printPluginUsage();
      break;
  }
}

/** @deprecated Use dispatchPluginCommand instead */
export const runPlugin = dispatchPluginCommand;
