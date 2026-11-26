/**
 * MCP server management executor.
 *
 * Handles configuration changes and live tool discovery for
 * the mcp_manage tool. All operations are config-file-only — writes
 * modify triggerfish.yaml and require a daemon restart to take effect.
 *
 * @module
 */

import { createHmac, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ToolExecutionContext } from "../../../core/types/tool.ts";
import {
  type ClassificationLevel,
  maxClassification,
} from "../../../core/types/classification.ts";
import { readConfigYaml, writeConfigYaml } from "../../../core/config_io.ts";
import { createLogger } from "../../../core/logger/mod.ts";
import { parseMcpLifecycleIntent } from "../../../core/mcp_lifecycle_intent.ts";

import {
  type McpConnectorProposal,
  readMcpConnectorProposal,
} from "./mcp_connector_proposal.ts";
import {
  parseRetainedInventoryEndpoint,
  retainedInventoryConnectorId,
} from "../../../mcp/retained_inventory.ts";
import type { SecretStore } from "../../../core/secrets/backends/secret_store.ts";

const log = createLogger("mcp-manage");
const serverIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Context required by the mcp_manage executor. */
export interface McpManageContext {
  readonly configPath: string;
  readonly listCredentialNames?: SecretStore["listSecrets"];
  readonly getConfirmPrompt?: () => (message: string) => Promise<boolean>;
  readonly withdrawConnectorTools?: (id: string) => Promise<void>;
  readonly prepareToolRefresh?: (
    id: string,
    saved: Record<string, unknown>,
  ) => Promise<
    ((authorize: () => Promise<boolean>) => Promise<boolean>) | undefined
  >;
  readonly getConnectorTools?: (id: string) => {
    readonly classification?: ClassificationLevel;
    readonly tools: readonly string[];
  } | undefined;
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
      transport: cfg.api_key_ref !== undefined
        ? "streamable_http"
        : cfg.command
        ? "stdio"
        : "sse",
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

async function credentialsExist(
  ctx: McpManageContext,
  credentialNames: McpConnectorProposal["credentialNames"],
): Promise<boolean> {
  if (credentialNames.length === 0) return true;
  const current = await ctx.listCredentialNames?.();
  if (!current?.ok) return false;
  const names = new Set(current.value);
  return credentialNames.every((name) => names.has(name));
}

function proposalDestination(
  config: Record<string, unknown>,
  id: string,
  replace: boolean,
): boolean {
  const servers = configServers(config);
  const exists = Object.hasOwn(servers, id);
  return replace ? exists && servers[id]?.enabled === false : !exists;
}

/** Save one exact operator proposal as disabled after owner approval. */
async function executeProposal(
  ctx: McpManageContext,
  input: Record<string, unknown>,
  revisionFor: LifecycleRevision,
  dispatch?: ToolExecutionContext,
): Promise<string> {
  const intent = parseMcpLifecycleIntent("mcp_manage", input);
  const owner = dispatch?.isCurrentInteractiveOwner;
  const request = dispatch?.toolApprovalRequestId;
  if (
    !intent || (intent.action !== "add" && intent.action !== "replace") ||
    !owner?.() || !request
  ) {
    return "Error: MCP creation or replacement requires a reviewed operator proposal and owner inbox approval. Read its revision with creation_status.";
  }
  const replace = intent.action === "replace";
  const config = readConfigYaml(ctx.configPath);
  const proposal = readMcpConnectorProposal(ctx.configPath, intent.connectorId);
  if (
    !config.ok || !proposal ||
    !proposalDestination(config.value, intent.connectorId, replace) ||
    revisionFor(config.value, intent.connectorId, proposal.source) !==
      intent.revision
  ) {
    return "Error: The MCP proposal or saved configuration changed before the approved action.";
  }
  if (!await credentialsExist(ctx, proposal.credentialNames) || !owner()) {
    return "Error: Required operator credential references are unavailable.";
  }

  const updated = structuredClone(config.value);
  const servers = configServers(updated);
  const mcp = updated.mcp as Record<string, unknown> | undefined;
  if ((mcp?.servers ?? updated.mcp_servers) == null) {
    updated.mcp = { ...mcp, servers };
  }
  servers[intent.connectorId] = proposal.entry;
  const written = await writeConfigYaml(ctx.configPath, updated, () => {
    const latest = readConfigYaml(ctx.configPath);
    const current = readMcpConnectorProposal(
      ctx.configPath,
      intent.connectorId,
    );
    return owner() && latest.ok && current !== undefined &&
      revisionFor(latest.value, intent.connectorId, current.source) ===
        intent.revision;
  });
  if (!written.ok) return `Error: ${written.error}`;
  log.info("MCP operator proposal saved as a disabled connector", {
    operation: "mcpManageProposal",
    action: intent.action,
    serverId: intent.connectorId,
    approvalRequestId: request,
  });
  return JSON.stringify({
    success: true,
    server_id: intent.connectorId,
    ...(replace ? { replaced: true } : { created: true }),
    enabled: false,
    approval_request_id: request,
    restart_needed: replace,
    _classification: "INTERNAL",
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

type LifecycleRevision = (
  config: Record<string, unknown>,
  serverId: string,
  proposalSource?: string,
) => string;

/** Apply an approved lifecycle action to exactly the reviewed saved connector. */
async function executeLifecycle(
  ctx: McpManageContext,
  input: Record<string, unknown>,
  revisionFor: LifecycleRevision,
  dispatch?: ToolExecutionContext,
): Promise<string> {
  const intent = parseMcpLifecycleIntent("mcp_manage", input);
  const owner = dispatch?.isCurrentInteractiveOwner;
  const request = dispatch?.toolApprovalRequestId;
  if (!intent || !owner?.() || !request) {
    return "Error: Connector lifecycle changes require the current revision and owner inbox approval.";
  }
  const config = readConfigYaml(ctx.configPath);
  if (!config.ok) {
    return "Error: The approved connector configuration is unavailable.";
  }
  const servers = configServers(config.value);
  const cfg = Object.hasOwn(servers, intent.connectorId)
    ? servers[intent.connectorId]
    : undefined;
  if (
    !cfg || typeof cfg !== "object" || Array.isArray(cfg) ||
    revisionFor(config.value, intent.connectorId) !== intent.revision
  ) {
    return "Error: The connector configuration changed before the approved lifecycle action.";
  }
  const remove = intent.action === "remove";
  const enable = intent.action === "enable";
  if (enable && cfg.api_key_ref !== undefined) {
    const retained = parseRetainedInventoryEndpoint(
      intent.connectorId,
      cfg.url,
      cfg.api_key_ref,
      cfg.classification,
    );
    if (
      !retained || !await credentialsExist(ctx, [retained.secretName]) ||
      !owner()
    ) {
      return "Error: Required operator credential references are unavailable.";
    }
  }
  const changed = remove || (cfg.enabled !== false) !== enable;
  if (changed) {
    const updated = structuredClone(config.value);
    const servers = configServers(updated);
    if (remove) delete servers[intent.connectorId];
    else servers[intent.connectorId] = { ...cfg, enabled: enable };
    const written = await writeConfigYaml(ctx.configPath, updated, () => {
      const current = readConfigYaml(ctx.configPath);
      return owner() && current.ok &&
        revisionFor(current.value, intent.connectorId) === intent.revision;
    });
    if (!written.ok) return `Error: ${written.error}`;
    log.info("MCP connector lifecycle action saved", {
      operation: "mcpManageLifecycle",
      serverId: intent.connectorId,
      action: intent.action,
      approvalRequestId: request,
    });
  }

  if (!enable) await ctx.withdrawConnectorTools?.(intent.connectorId);
  return JSON.stringify({
    success: true,
    server_id: intent.connectorId,
    ...(remove ? { removed: true } : { enabled: enable }),
    changed,
    approval_request_id: request,
    restart_needed: changed,
    _classification: "INTERNAL",
  });
}

/** Handle the status action — reads config for a single server. */
function executeStatus(
  ctx: McpManageContext,
  serverId: string,
): string {
  const config = readConfigYaml(ctx.configPath);
  const servers = config.ok ? configServers(config.value) : {};
  const cfg = Object.hasOwn(servers, serverId) ? servers[serverId] : undefined;
  const retained = serverId === retainedInventoryConnectorId;
  if (!cfg) {
    if (retained) {
      return JSON.stringify({
        id: serverId,
        exists: false,
        configured: false,
        enabled: false,
        reachable: false,
        tools: [],
        _classification: "INTERNAL",
      });
    }
    return JSON.stringify({
      error: `MCP server '${serverId}' not found in config.`,
      available: Object.keys(servers),
    });
  }
  const live = retained ? ctx.getConnectorTools?.(serverId) : undefined;
  return JSON.stringify({
    id: serverId,
    ...(retained && {
      exists: true,
      configured: cfg.api_key_ref === undefined
        ? typeof cfg.command === "string" || typeof cfg.url === "string"
        : !!parseRetainedInventoryEndpoint(
          serverId,
          cfg.url,
          cfg.api_key_ref,
          cfg.classification,
        ),
      reachable: cfg.enabled !== false && live !== undefined,
      tools: cfg.enabled !== false ? live?.tools ?? [] : [],
      _classification: maxClassification(
        live?.classification ?? "INTERNAL",
        "INTERNAL",
      ),
    }),
    classification: cfg.classification ?? "INTERNAL",
    transport: cfg.api_key_ref !== undefined
      ? "streamable_http"
      : cfg.command
      ? "stdio"
      : "sse",
    command: cfg.command,
    url: cfg.url,
    args: cfg.args,
    enabled: cfg.enabled !== false,
    tool_call_timeout_ms: cfg.tool_call_timeout_ms,
    max_retries: cfg.max_retries,
    env_keys: cfg.env ? Object.keys(cfg.env as Record<string, unknown>) : [],
  });
}

async function executeCreationStatus(
  ctx: McpManageContext,
  input: Record<string, unknown>,
  revisionFor: LifecycleRevision,
  dispatch?: ToolExecutionContext,
): Promise<string> {
  const id = input.server_id;
  if (
    !dispatch?.isCurrentInteractiveOwner?.() ||
    typeof id !== "string" || !serverIdPattern.test(id) ||
    Object.keys(input).some((key) => key !== "action" && key !== "server_id")
  ) {
    return "Error: Select one exact operator proposal in the active owner session.";
  }
  const config = readConfigYaml(ctx.configPath);
  const proposal = readMcpConnectorProposal(ctx.configPath, id);
  if (!config.ok || !proposal) {
    return "Error: The operator proposal or destination is unavailable.";
  }
  const replace = Object.hasOwn(configServers(config.value), id);
  if (!proposalDestination(config.value, id, replace)) {
    return "Error: Disable the configured connector before reviewing its replacement.";
  }
  if (
    !await credentialsExist(ctx, proposal.credentialNames) ||
    !dispatch.isCurrentInteractiveOwner?.()
  ) {
    return "Error: Required operator credential references are unavailable.";
  }
  return JSON.stringify({
    server_id: id,
    transport: proposal.transport,
    classification: proposal.classification,
    enabled: false,
    ...(replace && { proposal_action: "replace" }),
    lifecycle_revision: revisionFor(config.value, id, proposal.source),
    _classification: "INTERNAL",
  });
}

/** Return a review token without exposing the configured transport or credentials. */
function executeLifecycleStatus(
  ctx: McpManageContext,
  input: Record<string, unknown>,
  revisionFor: LifecycleRevision,
  dispatch?: ToolExecutionContext,
): string {
  const id = input.server_id;
  if (
    !dispatch?.isCurrentInteractiveOwner?.() ||
    typeof id !== "string" || !serverIdPattern.test(id) ||
    Object.keys(input).some((key) => key !== "action" && key !== "server_id")
  ) return "Error: Select one exact connector in the active owner session.";
  const config = readConfigYaml(ctx.configPath);
  if (!config.ok) return "Error: The connector configuration is unavailable.";
  const servers = configServers(config.value);
  const cfg = Object.hasOwn(servers, id) ? servers[id] : undefined;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    return "Error: The connector configuration is unavailable.";
  }
  return JSON.stringify({
    server_id: id,
    enabled: cfg.enabled !== false,
    lifecycle_revision: revisionFor(config.value, id),
    _classification: "INTERNAL",
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

async function executeToolRefresh(
  ctx: McpManageContext,
  input: Record<string, unknown>,
  revisionFor: LifecycleRevision,
  dispatch?: ToolExecutionContext,
): Promise<string> {
  const owner = dispatch?.isCurrentInteractiveOwner;
  const reauthorize = dispatch?.reauthorizeOwnerApproval;
  const { server_id: id } = input;
  if (
    !owner?.() || !reauthorize || !ctx.getConfirmPrompt ||
    typeof id !== "string" || !serverIdPattern.test(id) ||
    Object.keys(input).some((key) => key !== "action" && key !== "server_id")
  ) {
    return "Error: Catalog refresh requires one exact connector and active owner review.";
  }
  const readSelection = () => {
    const saved = readConfigYaml(ctx.configPath);
    if (!saved.ok) return;
    const servers = configServers(saved.value);
    const connector = Object.hasOwn(servers, id) ? servers[id] : undefined;
    if (
      !connector || typeof connector !== "object" || Array.isArray(connector) ||
      connector.enabled === false
    ) return;
    return { connector, revision: revisionFor(saved.value, id) };
  };
  const before = readSelection();
  const refresh = before &&
    await ctx.prepareToolRefresh?.(id, before.connector);
  if (!before || !refresh) {
    return "Error: The selected classified connector is unavailable.";
  }
  if (
    !await ctx.getConfirmPrompt()(
      `Refresh tool availability for configured connector '${id}'? This checks its tool catalog and keeps existing grants.`,
    )
  ) return "The owner declined the connector catalog refresh.";
  const isCurrent = () =>
    owner() && readSelection()?.revision === before.revision;
  const authorize = async () =>
    isCurrent() && await reauthorize() && isCurrent();
  if (!await refresh(authorize)) {
    return "Error: The connector catalog could not refresh under current authorization.";
  }
  return executeTools(ctx, { action: "tools", server_id: id }, owner);
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
  const key = randomBytes(32);
  const revisionFor: LifecycleRevision = (config, serverId, proposalSource) =>
    createHmac("sha256", key).update(
      JSON.stringify([serverId, config, proposalSource]),
    ).digest("hex");
  return async (
    name: string,
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string | null> => {
    if (name !== "mcp_manage") return null;

    const action = input.action as string | undefined;
    if (!action) {
      return "Error: mcp_manage requires an 'action' parameter (list, add, replace, update, remove, enable, disable, status, creation_status, lifecycle_status, tools, refresh_tools).";
    }

    const serverId = input.server_id as string | undefined;
    if (action !== "list" && (!serverId || serverId.length === 0)) {
      return `Error: mcp_manage(${action}) requires a 'server_id' parameter.`;
    }

    switch (action) {
      case "list":
        return executeList(ctx);
      case "add":
      case "replace":
        return await executeProposal(ctx, input, revisionFor, context);
      case "creation_status":
        return await executeCreationStatus(ctx, input, revisionFor, context);
      case "update":
        return await executeUpdate(
          ctx,
          input,
          context?.isCurrentInteractiveOwner,
        );
      case "remove":
      case "enable":
      case "disable":
        return await executeLifecycle(ctx, input, revisionFor, context);
      case "status":
        return executeStatus(ctx, serverId!);
      case "lifecycle_status":
        return executeLifecycleStatus(ctx, input, revisionFor, context);
      case "refresh_tools":
        return await executeToolRefresh(ctx, input, revisionFor, context);
      case "tools":
        return executeTools(
          ctx,
          input,
          context?.isCurrentInteractiveOwner,
        );
      default:
        return `Error: Unknown action "${action}". Valid actions: list, add, replace, update, remove, enable, disable, status, creation_status, lifecycle_status, tools, refresh_tools.`;
    }
  };
}
