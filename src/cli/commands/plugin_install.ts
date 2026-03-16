/**
 * Plugin install, update, and publish subcommands.
 *
 * @module
 */

import type { PluginCommandDeps } from "./plugin.ts";

/** Install a plugin from The Reef. */
export async function installPluginFromReef(
  flags: Readonly<Record<string, boolean | string>>,
  deps: PluginCommandDeps,
): Promise<void> {
  const name = flags.plugin_name as string | undefined;
  if (!name) {
    console.error("Usage: triggerfish plugin install <name>");
    Deno.exit(1);
  }
  const pluginsDir = deps.resolvePluginsDir();
  await Deno.mkdir(pluginsDir, { recursive: true });
  const registry = deps.createRegistry();
  const result = await registry.install(name, pluginsDir);
  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    Deno.exit(1);
  }
  console.log(result.value);
  console.log(
    "\nTo activate, add the following to your triggerfish.yaml:",
  );
  console.log(`  plugins:`);
  console.log(`    ${name}:`);
  console.log(`      enabled: true`);
  console.log(
    "\nThen restart Triggerfish, or use the plugin_install tool at runtime.",
  );
}

/** Check for plugin updates. */
export async function upgradePluginFromReef(
  flags: Readonly<Record<string, boolean | string>>,
  deps: PluginCommandDeps,
): Promise<void> {
  const specificName = flags.plugin_name as string | undefined;
  const pluginsDir = deps.resolvePluginsDir();

  // Discover installed plugins
  const installed: { name: string; version?: string }[] = [];
  try {
    for await (const entry of Deno.readDir(pluginsDir)) {
      if (!entry.isDirectory) continue;
      if (specificName && entry.name !== specificName) continue;
      try {
        const mod = await import(`${pluginsDir}/${entry.name}/mod.ts`);
        installed.push({
          name: entry.name,
          version: mod.manifest?.version,
        });
      } catch {
        installed.push({ name: entry.name });
      }
    }
  } catch {
    console.log("No plugins directory found.");
    return;
  }

  if (installed.length === 0) {
    console.log(
      specificName
        ? `Plugin "${specificName}" is not installed.`
        : "No plugins installed.",
    );
    return;
  }

  const registry = deps.createRegistry();
  const result = await registry.checkUpdates(installed);
  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    Deno.exit(1);
  }
  if (result.value.length === 0) {
    console.log("All plugins are up to date.");
    return;
  }
  console.log(`Updates available for: ${result.value.join(", ")}`);
  console.log(
    'Run "triggerfish plugin install <name>" to update a specific plugin.',
  );
}

/** Validate and prepare a plugin for Reef publishing. */
export async function publishPluginToReef(
  flags: Readonly<Record<string, boolean | string>>,
  deps: PluginCommandDeps,
): Promise<void> {
  const pluginDir = flags.plugin_path as string | undefined;
  if (!pluginDir) {
    console.error("Usage: triggerfish plugin publish <path-to-plugin-dir>");
    Deno.exit(1);
  }
  const registry = deps.createRegistry();
  const result = await registry.publish(pluginDir);
  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    Deno.exit(1);
  }
  console.log("\nPlugin validated and prepared for publishing.");
  console.log(`Files generated at: ${result.value}`);
  console.log("\nTo submit to The Reef:");
  console.log("  1. Fork https://github.com/greghavens/reef-registry");
  console.log(
    `  2. Copy the contents of ${result.value}/plugins/ to your fork`,
  );
  console.log("  3. Push your changes and open a Pull Request");
}
