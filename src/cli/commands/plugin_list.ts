/**
 * Plugin list, search, and scan subcommands.
 *
 * @module
 */

import type { PluginCommandDeps } from "./plugin.ts";

/** Search The Reef for plugins. */
export async function searchPluginReef(
  flags: Readonly<Record<string, boolean | string>>,
  deps: PluginCommandDeps,
): Promise<void> {
  const query = flags.query as string | undefined;
  if (!query) {
    console.error("Usage: triggerfish plugin search <query>");
    Deno.exit(1);
  }
  const registry = deps.createRegistry();
  const result = await registry.search(query);
  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    Deno.exit(1);
  }
  if (result.value.length === 0) {
    console.log(`No plugins found matching "${query}".`);
    return;
  }
  console.log(`\nFound ${result.value.length} plugin(s):\n`);
  for (const plugin of result.value) {
    console.log(`  ${plugin.name}@${plugin.version}`);
    console.log(`    ${plugin.description}`);
    console.log(
      `    Classification: ${plugin.classification}  Trust: ${plugin.trust}`,
    );
    if (plugin.tags.length > 0) {
      console.log(`    Tags: ${plugin.tags.join(", ")}`);
    }
    console.log();
  }
}

/** Scan a local plugin for security issues. */
export async function scanPluginManifest(
  flags: Readonly<Record<string, boolean | string>>,
  deps: PluginCommandDeps,
): Promise<void> {
  const pluginDir = flags.plugin_path as string | undefined;
  if (!pluginDir) {
    console.error("Usage: triggerfish plugin scan <path-to-plugin-dir>");
    Deno.exit(1);
  }
  const result = await deps.scanDirectory(pluginDir);
  console.log(`\nScanned ${result.scannedFiles.length} file(s).`);
  if (result.ok) {
    console.log("Security scan passed.");
    if (result.warnings.length > 0) {
      console.log(`\nWarnings (non-blocking):`);
      for (const w of result.warnings) {
        console.log(`  - ${w}`);
      }
    }
  } else {
    console.error("Security scan FAILED.");
    for (const w of result.warnings) {
      console.error(`  - ${w}`);
    }
    Deno.exit(1);
  }
}

/** List locally installed plugins. */
export async function listInstalledPlugins(
  deps: PluginCommandDeps,
): Promise<void> {
  const pluginsDir = deps.resolvePluginsDir();
  const plugins: {
    name: string;
    version?: string;
    classification?: string;
    trust?: string;
  }[] = [];

  try {
    for await (const entry of Deno.readDir(pluginsDir)) {
      if (!entry.isDirectory) continue;
      try {
        const mod = await import(`${pluginsDir}/${entry.name}/mod.ts`);
        if (mod.manifest) {
          plugins.push({
            name: entry.name,
            version: mod.manifest.version,
            classification: mod.manifest.classification,
            trust: mod.manifest.trust,
          });
        } else {
          plugins.push({ name: entry.name });
        }
      } catch {
        plugins.push({ name: entry.name });
      }
    }
  } catch {
    console.log("No plugins directory found (~/.triggerfish/plugins/).");
    console.log(
      "\nSearch The Reef with: triggerfish plugin search <query>",
    );
    return;
  }

  if (plugins.length === 0) {
    console.log("No plugins installed.");
    return;
  }

  console.log(`${plugins.length} plugin(s):\n`);
  for (const p of plugins) {
    const version = p.version ? `@${p.version}` : "";
    console.log(`  ${p.name}${version}`);
    if (p.classification) {
      console.log(
        `    Classification: ${p.classification}  Trust: ${
          p.trust ?? "unknown"
        }`,
      );
    }
  }
}
