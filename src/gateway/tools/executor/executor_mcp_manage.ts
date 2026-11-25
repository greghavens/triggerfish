/**
 * MCP server management executor.
 *
 * Handles configuration changes and live tool discovery for
 * the mcp_manage tool. All operations are config-file-only — writes
 * modify triggerfish.yaml and require a daemon restart to take effect.
 *
 * @module
 */

import { isDeepStrictEqual } from "node:util";
import type { ToolExecutionContext } from "../../../core/types/tool.ts";
import {
  type ClassificationLevel,
  maxClassification,
  parseClassification,
} from "../../../core/types/classification.ts";
import {
  deleteConfigValue,
  readConfigYaml,
  writeConfigValue,
  writeConfigYaml,
} from "../../../core/config_io.ts";
import { createLogger } from "../../../core/logger/mod.ts";

const log = createLogger("mcp-manage");
const serverIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Context required by the mcp_manage executor. */
export interface McpManageContext {
  readonly configPath: string;
  readonly getConfirmPrompt?: () => (message: string) => Promise<boolean>;
  readonly getConnectorTools?: (id: string) => {
    readonly classification?: ClassificationLevel;
    readonly tools: readonly string[];
  } | undefined;
}

/** Parse args string into a string array. */
function parseArgs(raw: unknown): readonly string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch (_err: unknown) {
      // Not valid JSON array — fall through to space-split
    }
  }
  return trimmed.split(/\s+/);
}

/** Parse env JSON string into a record. */
function parseEnv(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, string>;
    }
  } catch (_err: unknown) {
    // Not valid JSON — return undefined
  }
  return undefined;
}

function configServers(
  config: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const mcp = config.mcp as Record<string, unknown> | undefined;
  return (mcp?.servers ?? config.mcp_servers ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
}

/** Read MCP server entries from the config YAML. */
function readConfigServers(
  configPath: string,
): Record<string, Record<string, unknown>> {
  const configResult = readConfigYaml(configPath);
  return configResult.ok ? configServers(configResult.value) : {};
}

/** Handle the list action — reads from config file. */
function executeList(ctx: McpManageContext): string {
  const configServers = readConfigServers(ctx.configPath);
  const serverIds = Object.keys(configServers);

  if (serverIds.length === 0) {
    return JSON.stringify({
      servers: [],
      message: "No MCP servers configured.",
    });
  }

  const servers = serverIds.map((id) => {
    const cfg = configServers[id];
    return {
      id,
      classification: cfg.classification ?? "INTERNAL",
      transport: cfg.command ? "stdio" : "sse",
      command: cfg.command,
      url: cfg.url,
      args: cfg.args,
      enabled: cfg.enabled !== false,
      env_keys: cfg.env ? Object.keys(cfg.env as Record<string, unknown>) : [],
    };
  });

  return JSON.stringify({
    servers,
    total: servers.length,
  });
}

/** Handle the add action — writes to config file. */
async function executeAdd(
  ctx: McpManageContext,
  input: Record<string, unknown>,
): Promise<string> {
  const serverId = input.server_id as string;
  const command = input.command as string | undefined;
  const url = input.url as string | undefined;

  if (!command && !url) {
    return "Error: mcp_manage(add) requires either 'command' (stdio) or 'url' (SSE).";
  }

  const classRaw = (input.classification as string) ?? "INTERNAL";
  const classResult = parseClassification(classRaw);
  if (!classResult.ok) return `Error: ${classResult.error}`;

  const args = parseArgs(input.args);
  const env = parseEnv(input.env);

  const configData: Record<string, unknown> = {
    ...(command ? { command } : {}),
    ...(args.length > 0 ? { args: [...args] } : {}),
    ...(url ? { url } : {}),
    classification: classResult.value,
    enabled: true,
    ...(env ? { env } : {}),
  };

  const writeResult = await writeConfigValue(
    ctx.configPath,
    `mcp.servers.${serverId}`,
    configData,
  );
  if (!writeResult.ok) return `Error: ${writeResult.error}`;

  log.info("MCP server added via mcp_manage", {
    operation: "mcpManageAdd",
    serverId,
    transport: command ? "stdio" : "sse",
  });

  return JSON.stringify({
    success: true,
    server_id: serverId,
    message:
      `MCP server '${serverId}' saved to config. Use daemon_manage(action: "restart") to activate.`,
    restart_needed: true,
  });
}

/** Update runtime settings on exactly one existing server after owner approval. */
async function executeUpdate(
  ctx: McpManageContext,
  input: Record<string, unknown>,
  isCurrentOwner: ToolExecutionContext["isCurrentInteractiveOwner"],
): Promise<string> {
  if (!isCurrentOwner?.() || !ctx.getConfirmPrompt) {
    return "Error: MCP configuration updates require the active owner session.";
  }
  const { server_id: serverId, tool_call_timeout_ms, max_retries } = input;
  if (
    typeof serverId !== "string" ||
    !serverIdPattern.test(serverId) ||
    Object.keys(input).some((key) =>
      !["action", "server_id", "tool_call_timeout_ms", "max_retries"].includes(
        key,
      )
    ) ||
    (tool_call_timeout_ms === undefined && max_retries === undefined)
  ) {
    return "Error: Specify an existing MCP server and only timeout or retry settings.";
  }
  if (
    tool_call_timeout_ms !== undefined &&
    (typeof tool_call_timeout_ms !== "number" ||
      !Number.isInteger(tool_call_timeout_ms) || tool_call_timeout_ms < 1_000 ||
      tool_call_timeout_ms > 60_000)
  ) return "Error: tool_call_timeout_ms must be an integer from 1000 to 60000.";
  if (
    max_retries !== undefined &&
    (typeof max_retries !== "number" || !Number.isInteger(max_retries) ||
      max_retries < 1 || max_retries > 10)
  ) return "Error: max_retries must be an integer from 1 to 10.";

  const before = readConfigYaml(ctx.configPath);
  if (!before.ok) return "Error: MCP configuration could not be read.";
  const servers = configServers(before.value);
  const server = Object.hasOwn(servers, serverId)
    ? servers[serverId]
    : undefined;
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    return "Error: The selected MCP server is unavailable.";
  }
  const changes = {
    ...(tool_call_timeout_ms !== undefined && { tool_call_timeout_ms }),
    ...(max_retries !== undefined && { max_retries }),
  };
  const config = structuredClone(before.value);
  const updated = { ...server, ...changes };
  if (isDeepStrictEqual(server, updated)) {
    return JSON.stringify({
      success: true,
      changed: false,
      server_id: serverId,
      restart_needed: false,
      _classification: "INTERNAL",
    });
  }
  configServers(config)[serverId] = updated;
  const details = Object.entries(changes).map(([key, value]) =>
    `${key} = ${value}`
  ).join(", ");
  const approved = await ctx.getConfirmPrompt()(
    `Update MCP server '${serverId}' with ${details}? Changes apply on daemon restart.`,
  );
  if (!approved) return "MCP configuration update cancelled by the owner.";
  const isUnchanged = () => {
    const current = readConfigYaml(ctx.configPath);
    return isCurrentOwner() && current.ok &&
      isDeepStrictEqual(current.value, before.value);
  };
  if (!isUnchanged()) {
    return "Error: The configuration or owner session changed before the approved update.";
  }
  const write = await writeConfigYaml(ctx.configPath, config, isUnchanged);
  if (!write.ok) return `Error: ${write.error}`;
  log.info("MCP server runtime settings updated via mcp_manage", {
    operation: "mcpManageUpdate",
    serverId,
    fields: Object.keys(changes),
  });
  return JSON.stringify({
    success: true,
    changed: true,
    server_id: serverId,
    ...changes,
    restart_needed: true,
    _classification: "INTERNAL",
  });
}

/** Handle the remove action — deletes from config file. */
async function executeRemove(
  ctx: McpManageContext,
  serverId: string,
): Promise<string> {
  await deleteConfigValue(ctx.configPath, `mcp.servers.${serverId}`);

  log.info("MCP server removed via mcp_manage", {
    operation: "mcpManageRemove",
    serverId,
  });

  return JSON.stringify({
    success: true,
    server_id: serverId,
    message:
      `MCP server '${serverId}' removed. Use daemon_manage(action: "restart") to apply.`,
    restart_needed: true,
  });
}

/** Handle enable/disable actions — toggles enabled flag in config. */
async function executeToggleEnabled(
  ctx: McpManageContext,
  serverId: string,
  enable: boolean,
): Promise<string> {
  // Check both config paths for the server
  const configServers = readConfigServers(ctx.configPath);
  if (!configServers[serverId]) {
    return JSON.stringify({
      error: `MCP server '${serverId}' not found in config.`,
      available: Object.keys(configServers),
    });
  }

  const path = `mcp.servers.${serverId}.enabled`;

  const writeResult = await writeConfigValue(ctx.configPath, path, enable);
  if (!writeResult.ok) return `Error: ${writeResult.error}`;

  const action = enable ? "enabled" : "disabled";
  log.info(`MCP server ${action} via mcp_manage`, {
    operation: `mcpManage${enable ? "Enable" : "Disable"}`,
    serverId,
  });

  return JSON.stringify({
    success: true,
    server_id: serverId,
    message:
      `MCP server '${serverId}' ${action}. Use daemon_manage(action: "restart") to apply.`,
    restart_needed: true,
  });
}

/** Handle the status action — reads config for a single server. */
function executeStatus(
  ctx: McpManageContext,
  serverId: string,
): string {
  const configServers = readConfigServers(ctx.configPath);
  const cfg = configServers[serverId];
  if (!cfg) {
    return JSON.stringify({
      error: `MCP server '${serverId}' not found in config.`,
      available: Object.keys(configServers),
    });
  }
  return JSON.stringify({
    id: serverId,
    classification: cfg.classification ?? "INTERNAL",
    transport: cfg.command ? "stdio" : "sse",
    command: cfg.command,
    url: cfg.url,
    args: cfg.args,
    enabled: cfg.enabled !== false,
    tool_call_timeout_ms: cfg.tool_call_timeout_ms,
    max_retries: cfg.max_retries,
    env_keys: cfg.env ? Object.keys(cfg.env as Record<string, unknown>) : [],
  });
}

/** Project the names currently registered for the exact owner-visible connector. */
function executeTools(
  ctx: McpManageContext,
  input: Record<string, unknown>,
  isCurrentOwner: ToolExecutionContext["isCurrentInteractiveOwner"],
): string {
  if (!isCurrentOwner?.()) {
    return "Error: Connector tool discovery requires the active owner session.";
  }
  const { server_id: id } = input;
  if (
    typeof id !== "string" || !serverIdPattern.test(id) ||
    Object.keys(input).some((key) => key !== "action" && key !== "server_id")
  ) return "Error: Select exactly one MCP server.";
  const live = ctx.getConnectorTools?.(id);
  if (!live && !Object.hasOwn(readConfigServers(ctx.configPath), id)) {
    return "Error: The selected MCP server is unavailable.";
  }
  return JSON.stringify({
    server_id: id,
    role: "owner",
    connected: live !== undefined,
    tools: live?.tools ?? [],
    _classification: maxClassification(
      live?.classification ?? "INTERNAL",
      "INTERNAL",
    ),
  });
}

/**
 * Create a SubsystemExecutor for mcp_manage.
 *
 * Returns null for non-matching tool names so the dispatch chain
 * continues to the next executor.
 */
export function createMcpManageExecutor(
  ctx: McpManageContext,
): (
  name: string,
  input: Record<string, unknown>,
  context?: ToolExecutionContext,
) => Promise<string | null> {
  return async (
    name: string,
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string | null> => {
    if (name !== "mcp_manage") return null;

    const action = input.action as string | undefined;
    if (!action) {
      return "Error: mcp_manage requires an 'action' parameter (list, add, update, remove, enable, disable, status, tools).";
    }

    const serverId = input.server_id as string | undefined;
    if (action !== "list" && (!serverId || serverId.length === 0)) {
      return `Error: mcp_manage(${action}) requires a 'server_id' parameter.`;
    }

    switch (action) {
      case "list":
        return executeList(ctx);
      case "add":
        return await executeAdd(ctx, input);
      case "update":
        return await executeUpdate(
          ctx,
          input,
          context?.isCurrentInteractiveOwner,
        );
      case "remove":
        return await executeRemove(ctx, serverId!);
      case "enable":
        return await executeToggleEnabled(ctx, serverId!, true);
      case "disable":
        return await executeToggleEnabled(ctx, serverId!, false);
      case "status":
        return executeStatus(ctx, serverId!);
      case "tools":
        return executeTools(
          ctx,
          input,
          context?.isCurrentInteractiveOwner,
        );
      default:
        return `Error: Unknown action "${action}". Valid actions: list, add, update, remove, enable, disable, status, tools.`;
    }
  };
}
