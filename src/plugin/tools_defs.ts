/**
 * Plugin management tool definitions.
 *
 * Constant array of ToolDefinition objects describing the plugin_list,
 * plugin_install, plugin_reload, and plugin_scan tools available to the agent.
 *
 * @module
 */

import type { ToolDefinition } from "../core/types/tool.ts";

/** Tool definitions for plugin management. */
export const PLUGIN_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "plugin_list",
    description:
      "List all registered plugins with their status, version, classification, trust level, and source path.",
    parameters: {},
  },
  {
    name: "plugin_install",
    description:
      "Activate an explicitly enabled and trusted plugin from ~/.triggerfish/plugins/<name>/mod.ts. An optional path must match that directory. Requires enabled: true and trust: trusted in the user's plugin configuration. Plugins execute with process permissions; sandboxed execution is unavailable. The plugin is scanned and validated before activation.",
    parameters: {
      name: {
        type: "string",
        description:
          "Plugin name. If path is not provided, loads from ~/.triggerfish/plugins/<name>/mod.ts",
        required: true,
      },
      path: {
        type: "string",
        description:
          "Absolute path to the plugin directory containing mod.ts. Must be inside ~/.triggerfish/plugins/ (paths outside the plugins root are rejected). Overrides the default <plugins root>/<name> directory.",
      },
    },
  },
  {
    name: "plugin_reload",
    description:
      "Reload a currently registered plugin by unregistering and re-importing its module from its original source path. Use after modifying plugin source code.",
    parameters: {
      name: {
        type: "string",
        description: "Name of the plugin to reload",
        required: true,
      },
    },
  },
  {
    name: "plugin_scan",
    description:
      "Run the security scanner on a plugin directory before installing. Returns warnings about dangerous patterns (eval, prompt injection, subprocess calls, etc.). Use this to validate a plugin you just built before calling plugin_install.",
    parameters: {
      path: {
        type: "string",
        description: "Absolute path to the plugin directory containing mod.ts",
        required: true,
      },
    },
  },
];
