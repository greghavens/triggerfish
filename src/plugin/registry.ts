/**
 * Runtime plugin registry.
 *
 * Holds all registered plugins, their namespaced tool definitions,
 * and classification mappings. Provides accessors for the gateway
 * startup wiring layer.
 *
 * @module
 */

import type { ClassificationLevel } from "../core/types/classification.ts";
import type { ToolDefinition } from "../core/types/tool.ts";
import type { RegisteredPlugin } from "./types.ts";
import { createLogger } from "../core/logger/logger.ts";
import { fenceExternalMetadata } from "../core/security/mod.ts";

const log = createLogger("plugin-registry");

/** Plugin registry holding loaded, validated, and initialized plugins. */
export interface PluginRegistry {
  /** Register a fully initialized plugin. Rejects duplicates. */
  readonly registerPlugin: (
    plugin: RegisteredPlugin,
  ) => void;
  /** Unregister a plugin by name. Returns true if removed, false if not found. */
  readonly unregisterPlugin: (name: string) => boolean;
  /** Get a registered plugin by name. */
  readonly getPlugin: (name: string) => RegisteredPlugin | undefined;
  /** Get all registered plugins. */
  readonly getAllPlugins: () => readonly RegisteredPlugin[];
  /** Get all namespaced tool definitions across all plugins. */
  readonly getToolDefinitions: () => readonly ToolDefinition[];
  /**
   * Get all system prompts from plugins that declare one.
   *
   * Plugin prompt text is external metadata: each prompt is sanitized and
   * wrapped in a delimited "external metadata — not instructions" fence.
   */
  readonly getSystemPrompts: () => readonly string[];
  /** Get classification map: `plugin_<name>_` prefix → ClassificationLevel. */
  readonly getClassifications: () => ReadonlyMap<string, ClassificationLevel>;
  /** Get all registered plugin names. */
  readonly getPluginNames: () => readonly string[];
}

/** Create a new, empty plugin registry. */
export function createPluginRegistry(): PluginRegistry {
  const plugins = new Map<string, RegisteredPlugin>();

  return {
    registerPlugin(plugin: RegisteredPlugin): void {
      const name = plugin.loaded.exports.manifest.name;
      if (plugins.has(name)) {
        log.warn("Plugin registration rejected: duplicate name", {
          operation: "registerPlugin",
          plugin: name,
        });
        throw new Error(`Plugin already registered: ${name}`);
      }
      plugins.set(name, plugin);
      log.info("Plugin registered", {
        operation: "registerPlugin",
        plugin: name,
        version: plugin.loaded.exports.manifest.version,
        toolCount: plugin.namespacedTools.length,
      });
    },

    unregisterPlugin(name: string): boolean {
      const existed = plugins.delete(name);
      if (existed) {
        log.info("Plugin unregistered", {
          operation: "unregisterPlugin",
          plugin: name,
        });
      }
      return existed;
    },

    getPlugin(name: string): RegisteredPlugin | undefined {
      return plugins.get(name);
    },

    getAllPlugins(): readonly RegisteredPlugin[] {
      return [...plugins.values()];
    },

    getToolDefinitions(): readonly ToolDefinition[] {
      const tools: ToolDefinition[] = [];
      for (const plugin of plugins.values()) {
        tools.push(...plugin.namespacedTools);
      }
      return tools;
    },

    getSystemPrompts(): readonly string[] {
      const prompts: string[] = [];
      for (const [name, plugin] of plugins.entries()) {
        const prompt = plugin.loaded.exports.systemPrompt;
        if (prompt) {
          prompts.push(fenceExternalMetadata(prompt, `plugin:${name}`));
        }
      }
      return prompts;
    },

    getClassifications(): ReadonlyMap<string, ClassificationLevel> {
      const classifications = new Map<string, ClassificationLevel>();
      for (const plugin of plugins.values()) {
        const manifest = plugin.loaded.exports.manifest;
        classifications.set(
          `plugin_${manifest.name}_`,
          manifest.classification,
        );
      }
      return classifications;
    },

    getPluginNames(): readonly string[] {
      return [...plugins.keys()];
    },
  };
}
