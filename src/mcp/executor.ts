/**
 * MCP Executor — tool dispatch and definition conversion for MCP servers.
 *
 * Tool naming convention: `mcp_<serverId>_<toolName>` prevents collision
 * with the 15+ existing built-in tool subsystems.
 *
 * @module
 */

import type { ClassificationLevel } from "../core/types/classification.ts";
import type { SessionState } from "../core/types/session.ts";
import { createLogger } from "../core/logger/logger.ts";
import {
  fenceExternalMetadata,
  scanTextForPromptInjection,
  stripInvisibleCharacters,
} from "../core/security/mod.ts";
import type { McpGateway } from "./gateway/gateway.ts";
import type { ConnectedMcpServer } from "./manager.ts";

const log = createLogger("mcp-executor");

/** Parameter definition for a tool. */
interface ToolParameterDef {
  readonly type: string;
  readonly description: string;
  readonly required?: boolean;
  readonly items?: Readonly<Record<string, unknown>>;
  readonly enum?: readonly string[];
}

/** Tool definition matching the agent orchestrator's ToolDefinition shape. */
export interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, ToolParameterDef>>;
}

/**
 * Encode a namespaced MCP tool name.
 *
 * @param serverId - The MCP server identifier
 * @param toolName - The tool's original name on the MCP server
 * @returns Namespaced tool name: `mcp_<serverId>_<toolName>`
 */
export function encodeMcpToolName(serverId: string, toolName: string): string {
  return `mcp_${serverId}_${toolName}`;
}

/**
 * Decode a namespaced MCP tool name back to server ID and tool name.
 *
 * Uses longest-match-first to handle overlapping server ID prefixes.
 *
 * @param fullName - The namespaced tool name
 * @param serverIds - Available server IDs to match against
 * @returns Decoded `{serverId, toolName}` or null if not an MCP tool
 */
export function decodeMcpToolName(
  fullName: string,
  serverIds: readonly string[],
): { serverId: string; toolName: string } | null {
  if (!fullName.startsWith("mcp_")) return null;

  const rest = fullName.slice(4); // strip "mcp_"

  // Sort server IDs by length descending for longest-match-first
  const sorted = [...serverIds].sort((a, b) => b.length - a.length);

  for (const id of sorted) {
    const prefix = `${id}_`;
    if (rest.startsWith(prefix)) {
      return {
        serverId: id,
        toolName: rest.slice(prefix.length),
      };
    }
  }

  return null;
}

/** Options for creating an MCP executor. */
export interface McpExecutorOptions {
  readonly gateway: McpGateway;
  /**
   * Live getter for currently connected servers.
   * Called on every tool invocation so newly connected servers are picked up.
   */
  readonly getServers: () => readonly ConnectedMcpServer[];
  readonly getSession: () => SessionState;
}

/**
 * Create an MCP tool executor function.
 *
 * Returns a standard dispatch function `(name, input) => Promise<string | null>`
 * that returns null for non-MCP tools and the tool result text for MCP tools.
 * Uses a live getter for the server list so tools from newly connected servers
 * are available without restarting the session.
 */
export function createMcpExecutor(
  options: McpExecutorOptions,
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  const { gateway, getServers, getSession } = options;

  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    // Resolve the live server list on each invocation
    const servers = getServers();
    const serverIds = servers.map((s) => s.id);
    const serverMap = new Map(servers.map((s) => [s.id, s]));

    const decoded = decodeMcpToolName(name, serverIds);
    if (!decoded) return null;

    const server = serverMap.get(decoded.serverId);
    if (!server) return `Error: MCP server '${decoded.serverId}' not found`;
    if (!server.tools.some(({ name }) => name === decoded.toolName)) {
      return "Error: The selected MCP tool is not registered.";
    }

    const serverUri = `mcp://${decoded.serverId}`;
    const result = await gateway.callTool({
      serverUri,
      toolName: decoded.toolName,
      arguments: input,
      session: getSession(),
      mcpServer: server.server,
    });

    if (!result.ok) return `Error: ${result.error}`;

    // Extract text from the gateway result content
    const parts: string[] = [];
    for (const item of result.value.content) {
      if (item.text) parts.push(item.text);
    }
    return parts.join("\n") || "(no output)";
  };
}

/**
 * Sanitize an MCP tool description before it reaches the LLM.
 *
 * Strips control/zero-width characters, then runs the deterministic
 * prompt-injection scan. A flagged description is withheld entirely
 * (replaced with a fixed placeholder) and the denial logged at WARN.
 */
function sanitizeMcpToolDescription(opts: {
  readonly serverId: string;
  readonly toolName: string;
  readonly description: string;
}): string {
  const stripped = stripInvisibleCharacters(opts.description);
  const warnings = scanTextForPromptInjection(stripped);
  if (warnings.length > 0) {
    log.warn("MCP tool description failed prompt-injection scan; withheld", {
      operation: "sanitizeMcpToolDescription",
      serverId: opts.serverId,
      toolName: opts.toolName,
      warnings,
    });
    return "[tool description withheld: failed prompt-injection scan]";
  }
  return stripped;
}

/**
 * Convert MCP server tools to ToolDefinition format.
 *
 * Maps each server's McpToolDefinition[] to the agent's ToolDefinition format
 * with namespaced names (`mcp_<serverId>_<toolName>`). Descriptions are
 * external metadata: they are sanitized and injection-scanned first.
 */
export function getMcpToolDefinitions(
  servers: readonly ConnectedMcpServer[],
  connectorId?: string,
): readonly McpToolDef[] {
  const defs: McpToolDef[] = [];
  const serverIds = servers.map(({ id }) => id);

  for (const server of servers) {
    if (connectorId !== undefined && server.id !== connectorId) continue;
    for (const tool of server.tools) {
      const name = encodeMcpToolName(server.id, tool.name);
      if (decodeMcpToolName(name, serverIds)?.serverId !== server.id) continue;
      // Convert JSON Schema inputSchema to the parameter format
      const parameters: Record<string, ToolParameterDef> = {};
      const schema = tool.inputSchema;
      const properties = (schema.properties ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      const required = (schema.required ?? []) as readonly string[];

      for (const [propName, propSchema] of Object.entries(properties)) {
        parameters[propName] = {
          type: (propSchema.type as string) ?? "string",
          description: (propSchema.description as string) ?? "",
          required: required.includes(propName),
          ...(propSchema.items
            ? {
              items: propSchema.items as Readonly<Record<string, unknown>>,
            }
            : {}),
          ...(propSchema.enum
            ? { enum: propSchema.enum as readonly string[] }
            : {}),
        };
      }

      defs.push({
        name,
        description: `[${server.id}] ${
          sanitizeMcpToolDescription({
            serverId: server.id,
            toolName: tool.name,
            description: tool.description,
          })
        }`,
        parameters,
      });
    }
  }

  return defs;
}

/**
 * Build a classification map for MCP tool prefixes.
 *
 * Maps `mcp_<serverId>_` prefixes to their configured classification levels.
 * Tools from servers without a classification are NOT added (default deny).
 */
export function buildMcpToolClassifications(
  servers: readonly ConnectedMcpServer[],
): Map<string, ClassificationLevel> {
  const m = new Map<string, ClassificationLevel>();
  for (const server of servers.toSorted((a, b) => b.id.length - a.id.length)) {
    if (server.classification) {
      m.set(`mcp_${server.id}_`, server.classification);
    }
  }
  return m;
}

/** Render one server's tool listing with sanitized descriptions. */
function renderMcpServerListing(
  server: ConnectedMcpServer,
  serverIds: readonly string[],
): string[] {
  const classification = server.classification ?? "UNCLASSIFIED";
  const lines = [`### ${server.id} (${classification})`];
  for (const tool of server.tools) {
    const fullName = encodeMcpToolName(server.id, tool.name);
    if (decodeMcpToolName(fullName, serverIds)?.serverId !== server.id) {
      continue;
    }
    const description = sanitizeMcpToolDescription({
      serverId: server.id,
      toolName: tool.name,
      description: tool.description,
    });
    lines.push(`- **${fullName}**: ${description}`);
  }
  if (lines.length === 1) lines.push("No tools available.");
  lines.push("");
  return lines;
}

/**
 * Build a system prompt section describing available MCP servers and tools.
 *
 * Server/tool metadata comes from outside the trust boundary, so the listing
 * is sanitized, injection-scanned, and wrapped in a delimited
 * "external metadata — not instructions" fence.
 *
 * Returns empty string when no servers are connected.
 */
export function buildMcpSystemPrompt(
  servers: readonly ConnectedMcpServer[],
): string {
  if (servers.length === 0) return "";

  const serverIds = servers.map(({ id }) => id);
  const listing = servers.flatMap((server) =>
    renderMcpServerListing(server, serverIds)
  );

  return [
    "## MCP Servers",
    "",
    "The following external MCP servers are available. Their tools are prefixed with `mcp_<server>_`.",
    "",
    fenceExternalMetadata(listing.join("\n"), "mcp-tool-descriptions"),
  ].join("\n");
}
