/**
 * MCP server management tool definition.
 *
 * Provides an owner tool for managing MCP server configuration. Writes
 * persist in the configuration and take effect on restart.
 *
 * @module
 */

import type { ToolDefinition } from "../../../core/types/tool.ts";

/** Build the mcp_manage tool definition. */
function buildMcpManageDef(): ToolDefinition {
  return {
    name: "mcp_manage",
    description:
      "MCP server configuration management. Changes to running connectors apply after daemon restart.\n" +
      "Actions: list, creation_status, add, update, remove, enable, disable, status, lifecycle_status, tools.\n" +
      "- list: list all configured MCP servers from config file\n" +
      "- creation_status: review redacted metadata for the operator-provided proposal with this server_id\n" +
      "- add: request owner inbox approval to save that exact proposal as a disabled connector. Params: server_id and lifecycle_revision from creation_status\n" +
      "- update: change an existing server's tool-call timeout or retry limit with owner confirmation. Params: server_id, tool_call_timeout_ms?, max_retries?\n" +
      "- remove: request owner inbox approval to delete one configured MCP server entry. Params: server_id and lifecycle_revision from lifecycle_status\n" +
      "- enable: request owner inbox approval to enable a configured MCP server. Params: server_id and lifecycle_revision from lifecycle_status\n" +
      "- disable: request owner inbox approval to disable a configured MCP server. Params: server_id and lifecycle_revision from lifecycle_status\n" +
      "- status: show config details for one server. Params: server_id (required)\n" +
      "- lifecycle_status: read enabled state and an exact owner revision without revealing transport or credentials. Params: server_id (required)\n" +
      "- tools: list currently registered tools for one connected server in the owner session. Params: server_id (required)",
    parameters: {
      action: {
        type: "string",
        description:
          "The operation: list, creation_status, add, update, remove, enable, disable, status, lifecycle_status, tools",
        required: true,
      },
      server_id: {
        type: "string",
        description: "Server identifier (required for all actions except list)",
        required: false,
      },
      lifecycle_revision: {
        type: "string",
        description:
          "Exact owner revision from creation_status for add or lifecycle_status for enable, disable, or remove.",
      },
      tool_call_timeout_ms: {
        type: "integer",
        description:
          "Tool call timeout from 1000 to 60000 milliseconds (update only).",
      },
      max_retries: {
        type: "integer",
        description: "Maximum connection attempts from 1 to 10 (update only).",
      },
    },
  };
}

/** Get the MCP management tool definitions. */
export function getMcpManageToolDefinitions(): readonly ToolDefinition[] {
  return [buildMcpManageDef()];
}

/** System prompt section explaining mcp_manage to the LLM. */
export const MCP_MANAGE_SYSTEM_PROMPT = `## MCP Server Management

Use \`mcp_manage\` to review saved connector configuration and current tool
registrations.

For a new connector, the operator prepares \`mcp-proposals/<server_id>.yaml\`
beside the daemon configuration file using their normal configuration editor.
The proposal is one connector entry with an explicit classification, one
command or URL, and optional arguments or named credential references where
supported. Use \`creation_status\` to get its opaque review revision, then
call \`add\` with that revision. The owner approval inbox authorizes the
exact proposal. The saved connector starts disabled. A separate \`enable\`
decision is required before it can connect after restart.

For \`enable\`, \`disable\`, and \`remove\`, read the saved connector's
current revision with \`lifecycle_status\` and use it in the approval request.
Use \`update\` to request owner-confirmed timeout or retry changes. When a
successful write returns \`restart_needed: true\`, use \`daemon_manage(action: "restart")\` to apply it.

Use \`list\` or \`status\` for saved settings and \`tools\` for registered
tool names. Do not pass connector commands, destinations, or credentials
as model tool arguments. The protected daemon configuration and
operator proposal files are managed by the operator and scoped MCP actions.`;
