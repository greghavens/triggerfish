/**
 * Core type definitions for the dynamic plugin loader system.
 *
 * Plugins are external tool providers loaded from `~/.triggerfish/plugins/`
 * at startup. Each plugin exports a manifest, tool definitions, and an
 * executor factory from its `mod.ts` entry point.
 *
 * @module
 */

import type { ClassificationLevel } from "../core/types/classification.ts";
import type { ToolDefinition } from "../core/types/tool.ts";

/**
 * Plugin tool executor signature.
 *
 * Matches the gateway's PluginToolExecutor type: returns the tool result
 * string if the tool name matches, or null to pass to the next executor.
 */
export type PluginToolExecutor = (
  name: string,
  input: Record<string, unknown>,
) => Promise<string | null>;

/** Legacy sandbox requests are recognized but cannot execute in-process. */
export type PluginTrustLevel = "sandboxed" | "trusted";

/** User-controlled permission to execute plugin code with process privileges. */
export interface PluginTrustGrant {
  readonly enabled?: boolean;
  readonly trust?: PluginTrustLevel;
}

/** Plugin manifest declaring identity, capabilities, and security properties. */
export interface PluginManifest {
  /** Unique plugin name (alphanumeric + hyphens). */
  readonly name: string;
  /** Semantic version string. */
  readonly version: string;
  /** Human-readable description. */
  readonly description: string;
  /** Classification level for all tools provided by this plugin. */
  readonly classification: ClassificationLevel;
  /** Requested trust level. Must be granted by user config to take effect. */
  readonly trust: PluginTrustLevel;
  /** Declared network needs; trusted in-process execution does not enforce this list. */
  readonly declaredEndpoints: readonly string[];
}

/**
 * Context provided to plugin executor factories at initialization.
 *
 * Gives the plugin access to session state and logging without
 * exposing internal system APIs.
 */
export interface PluginContext {
  /** Plugin name for logging and namespacing. */
  readonly pluginName: string;
  /** Get the current session taint level. */
  readonly getSessionTaint: () => ClassificationLevel;
  /** Escalate session taint to a higher classification. */
  readonly escalateTaint: (level: ClassificationLevel) => void;
  /** Structured logger scoped to the plugin. */
  readonly log: PluginLogger;
  /** Plugin-specific settings from triggerfish.yaml. */
  readonly config: Readonly<Record<string, unknown>>;
}

/** Minimal structured logger interface for plugins. */
export interface PluginLogger {
  readonly debug: (msg: string, ctx?: Record<string, unknown>) => void;
  readonly info: (msg: string, ctx?: Record<string, unknown>) => void;
  readonly warn: (msg: string, ctx?: Record<string, unknown>) => void;
  readonly error: (msg: string, ctx?: Record<string, unknown>) => void;
}

/**
 * Shape of a plugin's mod.ts exports.
 *
 * Every plugin must export these members from its entry point.
 */
export interface PluginExports {
  /** Plugin identity and security properties. */
  readonly manifest: PluginManifest;
  /** Tool definitions this plugin provides. */
  readonly toolDefinitions: readonly ToolDefinition[];
  /** Factory function that creates the plugin's tool executor. */
  readonly createExecutor: (
    context: PluginContext,
  ) => PluginToolExecutor | Promise<PluginToolExecutor>;
  /** Optional system prompt section injected into the agent context. */
  readonly systemPrompt?: string;
}

/** A validated plugin loaded from disk but not yet initialized. */
export interface LoadedPlugin {
  /** Validated exports from the plugin module. */
  readonly exports: PluginExports;
  /** Absolute path to the plugin's mod.ts file. */
  readonly sourcePath: string;
}

/** A fully initialized plugin with executor and namespaced tools. */
export interface RegisteredPlugin {
  /** Original loaded plugin data. */
  readonly loaded: LoadedPlugin;
  /** Initialized executor for handling tool calls. */
  readonly executor: PluginToolExecutor;
  /** Tool definitions with namespaced names (`plugin_<name>_<tool>`). */
  readonly namespacedTools: readonly ToolDefinition[];
  /** Terminates the plugin's sandbox worker. Absent for trusted plugins. */
  readonly dispose?: () => void;
}
