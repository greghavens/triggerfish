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
      "MCP server configuration management. All writes require daemon restart.\n" +
      "Actions: list, add, update, remove, enable, disable, status, lifecycle_status, tools.\n" +
      "- list: list all configured MCP servers from config file\n" +
      "- add: add a new MCP server. Params: server_id (required), command or url (required), args?, classification?, env?\n" +
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
          "The operation: list, add, update, remove, enable, disable, status, lifecycle_status, tools",
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
          "Exact current owner revision from lifecycle_status, required for enable, disable, or remove.",
      },
      command: {
        type: "string",
        description:
          "Executable command for stdio transport (add only). E.g. 'npx', 'node', 'uvx'",
        required: false,
      },
      args: {
        type: "string",
        description:
          "Arguments as space-separated string or JSON array (add only). E.g. '@anthropic/mcp-server-context7' or '[\"--port\", \"3000\"]'",
        required: false,
      },
      url: {
        type: "string",
        description:
          "URL for SSE transport (add only). E.g. 'http://localhost:3000/sse'",
        required: false,
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
      classification: {
        type: "string",
        description:
          "Classification level: PUBLIC, INTERNAL, CONFIDENTIAL, or RESTRICTED (add only, default INTERNAL)",
        required: false,
      },
      env: {
        type: "string",
        description:
          'Environment variables as JSON object (add only). E.g. \'{"API_KEY": "secret:my-key"}\'',
        required: false,
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

Use \`mcp_manage\` to manage MCP server configuration. All writes modify triggerfish.yaml and require a daemon restart.

- \`action: "list"\` — list all configured MCP servers
- \`action: "add", server_id: "...", command: "npx", args: "..."\` — add a stdio server
- \`action: "add", server_id: "...", url: "http://..."\` — add an SSE server
- \`action: "update", server_id: "...", tool_call_timeout_ms: 15000, max_retries: 3\` — update runtime settings for an existing server after owner confirmation
- \`action: "remove", server_id: "..."\` — use the current lifecycle_revision from lifecycle_status and wait for the owner inbox decision before deleting the saved connector entry
- \`action: "enable", server_id: "..."\` — use the current lifecycle_revision from lifecycle_status and wait for the owner inbox decision
- \`action: "disable", server_id: "..."\` — use the current lifecycle_revision from lifecycle_status and wait for the owner inbox decision
- \`action: "status", server_id: "..."\` — show config details for one server
- \`action: "tools", server_id: "..."\` — list tools currently registered for that server in owner chat

**After any write action, call \`daemon_manage(action: "restart")\` to apply changes.**

### Required flow when adding an MCP server

**Step 1:** Ask the user ONLY for classification level (PUBLIC, INTERNAL, CONFIDENTIAL, or RESTRICTED). Do not default silently.

**Step 2:** Immediately call \`secret_save\` for the API key. Do NOT ask the user in chat whether they have a key — just call \`secret_save\` directly. The secure prompt will appear automatically and the user can cancel if no key is needed. NEVER mention API keys, tokens, or secrets in chat messages. The \`secret_save\` tool handles everything securely out-of-band.

**Step 3:** Call \`mcp_manage(action: "add", ...)\` with the classification from step 1 and the secret reference from step 2.

**Step 4:** Call \`daemon_manage(action: "restart", reason: "Added MCP server <id>")\` to activate the new server.

**Example: adding context7**
1. Ask user: "What classification level?" (wait for answer)
2. Call \`secret_save(name: "context7_api_key", hint: "Context7 API key from upstash.com")\`
3. Call \`mcp_manage(action: "add", server_id: "context7", command: "npx", args: "-y @upstash/context7-mcp", classification: "<user's choice>", env: '{"CONTEXT7_API_KEY": "secret:context7_api_key"}')\`
4. Call \`daemon_manage(action: "restart", reason: "Added context7 MCP server")\`
5. Ask user: "Would you like to add anything about this server's capabilities to your SPINE.md?" If yes, use \`spine_manage(action: "append")\` to add it.

**If adding a server that genuinely needs no secrets**, skip step 2 and omit \`env\`.

**CRITICAL:** NEVER use \`read_file\`, \`write_file\`, \`edit_file\`, or \`run_command\` on \`triggerfish.yaml\`. NEVER use \`run_command\` with \`triggerfish config\` CLI commands. NEVER use \`config_manage\` to set MCP config — use \`mcp_manage\` exclusively for MCP servers. Direct file access to triggerfish.yaml is forbidden.`;
