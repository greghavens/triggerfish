/**
 * MCP server wiring for gateway startup.
 *
 * Connects MCP servers from config, creates the policy gateway and
 * executor, and installs a status-change callback that keeps tool
 * classifications, chat sessions, and Tidepool hosts in sync.
 *
 * @module
 */

import type { ConfiguredMcpServer } from "../../../core/config_types.ts";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { HookRunner } from "../../../core/policy/hooks/hooks.ts";
import type { SessionState } from "../../../core/types/session.ts";
import type { SecretStore } from "../../../core/secrets/keychain/keychain.ts";
import type { LineageStore } from "../../../core/session/lineage_types.ts";
import type { ChatSession } from "../../chat.ts";
import type { GatewayServer } from "../../server/server.ts";
import type { A2UIHost } from "../../../tools/tidepool/host/mod.ts";
import { parseClassification } from "../../../core/types/classification.ts";
import {
  buildMcpSystemPrompt,
  buildMcpToolClassifications,
  createMcpExecutor,
  createMcpGateway,
  createMcpServerManager,
  getMcpToolDefinitions,
} from "../../../mcp/mod.ts";
import type { McpServerConfig, McpServerManager } from "../../../mcp/mod.ts";
import { createLogger } from "../../../core/logger/mod.ts";
import type { ToolDefinition } from "../../../core/types/tool.ts";

const log = createLogger("startup-mcp");

/** Late-bound references for broadcasting MCP status to UI surfaces. */
export interface McpBroadcastRefs {
  chatSession: ChatSession | null;
  gatewayServer: GatewayServer | null;
  tidepoolHost: A2UIHost | null;
}

/** Return value from wireMcpServers. */
export interface McpWiringResult {
  /** The MCP server manager (for getConnected/getConfiguredCount). */
  readonly manager: McpServerManager;
  /** Tool executor for MCP tools (null-returning if tool doesn't match). */
  readonly executor:
    | ((name: string, input: Record<string, unknown>) => Promise<string | null>)
    | undefined;
  /** Live getter for MCP tool definitions (for getExtraTools). */
  readonly getToolDefinitions: () => readonly ToolDefinition[];
  /** Live getter for MCP system prompt section (for getExtraSystemPromptSections). */
  readonly getSystemPrompt: () => string | null;
}

function validMcpSetting(
  value: number | undefined,
  min: number,
  max: number,
): number | undefined {
  return typeof value === "number" && Number.isInteger(value) &&
      value >= min && value <= max
    ? value
    : undefined;
}

/**
 * Wire MCP servers from config.
 *
 * Starts background connection loops (non-blocking) and installs a
 * status-change callback that updates tool classifications, registers
 * servers with the policy gateway, and broadcasts status to UI surfaces.
 *
 * @param mcpServersConfig - Raw config map from triggerfish.yaml `mcp_servers`
 * @param hookRunner - Policy hook runner for the MCP gateway
 * @param getSession - Live session getter for the MCP executor
 * @param toolClassifications - Mutable map to inject MCP prefixes into (all classifications)
 * @param integrationClassifications - Mutable map for integration-only write-down checks
 * @param broadcastRefs - Late-bound refs for UI status broadcasting
 * @param keychain - Secret store for MCP server env var resolution
 * @returns MCP wiring result with manager, executor, and live getters
 */
export function wireMcpServers(
  mcpServersConfig: Readonly<Record<string, ConfiguredMcpServer>>,
  hookRunner: HookRunner,
  getSession: () => SessionState,
  toolClassifications: Map<string, ClassificationLevel>,
  integrationClassifications: Map<string, ClassificationLevel>,
  broadcastRefs: McpBroadcastRefs,
  keychain: SecretStore,
  lineageStore: LineageStore,
): McpWiringResult {
  const mcpManager = createMcpServerManager();

  const mcpConfigs: McpServerConfig[] = [];
  for (const [id, serverCfg] of Object.entries(mcpServersConfig)) {
    let classification: ClassificationLevel | undefined;
    if (serverCfg.classification) {
      const parsed = parseClassification(serverCfg.classification);
      if (parsed.ok) classification = parsed.value;
    }
    mcpConfigs.push({
      id,
      command: serverCfg.command,
      args: serverCfg.args,
      env: serverCfg.env,
      url: serverCfg.url,
      classification,
      enabled: serverCfg.enabled,
      toolCallTimeoutMs: validMcpSetting(
        serverCfg.tool_call_timeout_ms,
        1_000,
        60_000,
      ),
      maxRetries: validMcpSetting(serverCfg.max_retries, 1, 10),
    });
  }

  // Create MCP gateway for policy enforcement
  const mcpGateway = createMcpGateway({ hookRunner, lineageStore });

  // Create MCP executor with live getter
  const executor = createMcpExecutor({
    gateway: mcpGateway,
    getServers: () => mcpManager.getConnected(),
    getSession,
  });

  // Install status-change callback
  mcpManager.onStatusChange((statuses) => {
    // Re-register all currently connected servers with the gateway
    for (const status of statuses) {
      if (status.state === "connected" && status.server) {
        mcpGateway.registerServer({
          uri: `mcp://${status.server.id}`,
          name: status.server.id,
          status: status.server.classification ? "CLASSIFIED" : "UNTRUSTED",
          classification: status.server.classification,
        });
      }
    }

    // Rebuild MCP tool classifications into both maps
    const connectedServers = statuses
      .filter((s) => s.state === "connected" && s.server !== undefined)
      .map((s) => s.server!);
    const mcpClassifications = buildMcpToolClassifications(connectedServers);
    for (const key of [...toolClassifications.keys()]) {
      if (key.startsWith("mcp_")) {
        toolClassifications.delete(key);
      }
    }
    for (const key of [...integrationClassifications.keys()]) {
      if (key.startsWith("mcp_")) {
        integrationClassifications.delete(key);
      }
    }
    for (const [prefix, level] of mcpClassifications) {
      toolClassifications.set(prefix, level);
      integrationClassifications.set(prefix, level);
    }

    // Broadcast MCP status to all UI surfaces
    const mcpConnected = statuses.filter((s) => s.state === "connected").length;
    const mcpConfigured = mcpManager.getConfiguredCount();
    if (broadcastRefs.chatSession !== null) {
      broadcastRefs.chatSession.setMcpStatus?.(mcpConnected, mcpConfigured);
    }
    if (broadcastRefs.gatewayServer !== null) {
      broadcastRefs.gatewayServer.broadcastChatEvent({
        type: "mcp_status",
        connected: mcpConnected,
        configured: mcpConfigured,
      });
    }
    if (broadcastRefs.tidepoolHost !== null) {
      broadcastRefs.tidepoolHost.broadcastMcpStatus(
        mcpConnected,
        mcpConfigured,
      );
    }
  });

  // Start background connection loops
  log.info("Starting MCP server connection loops (background)...");
  mcpManager.startAll(mcpConfigs, keychain);

  return {
    manager: mcpManager,
    executor,
    getToolDefinitions: () =>
      getMcpToolDefinitions(
        mcpManager.getConnected(),
      ) as readonly ToolDefinition[],
    getSystemPrompt: () => buildMcpSystemPrompt(mcpManager.getConnected()),
  };
}
