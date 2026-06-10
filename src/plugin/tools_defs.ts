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
      "Install and activate a plugin at runtime. Accepts either a name (loads from ~/.triggerfish/plugins/<name>/mod.ts) or a path to a directory containing mod.ts. The directory must live under ~/.triggerfish/plugins/ — paths outside the plugins root are rejected. The plugin is security-scanned, validated, and loaded as sandboxed by default. No config entry is required — place a plugin under the plugins root and immediately load it.",
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
