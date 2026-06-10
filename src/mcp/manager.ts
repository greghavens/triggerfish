/**
 * MCP Server Manager — lifecycle management for configured MCP servers.
 *
 * Factory for McpServerManager that owns the full lifecycle: env resolution,
 * transport creation, connection, initialization, tool discovery, and
 * disconnection. Implementation details are split across:
 *
 * - `manager_env.ts` — env var resolution and server adapter
 * - `manager_connection.ts` — connection, disconnect, and status notification
 * - `manager_retry.ts` — health polling, retry loops, and server startup
 * - `manager_types.ts` — types and interfaces
 *
 * @module
 */

import { createLogger } from "../core/logger/mod.ts";
import type { McpServerManager } from "./manager_types.ts";
import {
  buildMcpManagerState,
  connectAllMcpServers,
  disconnectAllMcpServers,
} from "./manager_connection.ts";
import {
  launchMcpServerRetryLoop,
  startAllMcpServers,
} from "./manager_retry.ts";
import { notifyMcpStatusListeners } from "./manager_connection.ts";

// ─── Barrel re-exports ───────────────────────────────────────────────────────

export { createMcpServerAdapter, resolveEnvVars } from "./manager_env.ts";
export {
  DEFAULT_ALLOWED_MCP_COMMANDS,
  enforceCommandAllowlist,
  validateMcpServerUrl,
} from "./manager_connection.ts";

export type {
  ConnectedMcpServer,
  McpServerConfig,
  McpServerManager,
  McpServerState,
  McpServerStatus,
} from "./manager_types.ts";

// ─── Manager factory ─────────────────────────────────────────────────────────

/**
 * Create an McpServerManager instance.
 *
 * Owns the full lifecycle: env resolution, transport creation, connection,
 * initialization, tool discovery, and disconnection.
 */
export function createMcpServerManager(): McpServerManager {
  const mcpLog = createLogger("mcp");
  const state = buildMcpManagerState();

  return {
    async connectAll(configs, secretStore?) {
      const ctx = { secretStore, mcpLog, state };
      state.connected = await connectAllMcpServers(configs, ctx);
      return state.connected;
    },
    disconnectAll: () => disconnectAllMcpServers(state),
    getConnected: () => state.connected,
    startAll: (configs, secretStore?) =>
      startAllMcpServers(configs, { secretStore, mcpLog, state }),
    getStatus: () => Array.from(state.statusMap.values()),
    getConfiguredCount: () => state.configuredCount,
    onStatusChange(cb) {
      state.statusListeners.add(cb);
      return () => state.statusListeners.delete(cb);
    },
    addServer(config, secretStore?) {
      state.configuredCount++;
      if (!config.command && !config.url) {
        mcpLog.warn(`MCP server '${config.id}': no command or url — skipping`, {
          operation: "addServer",
          serverId: config.id,
        });
        state.statusMap.set(config.id, {
          id: config.id,
          config,
          state: "failed",
          lastError: "no command or url configured",
        });
        notifyMcpStatusListeners(state);
        return;
      }
      mcpLog.info(`MCP server '${config.id}' added at runtime`, {
        operation: "addServer",
        serverId: config.id,
      });
      launchMcpServerRetryLoop(config, { secretStore, mcpLog, state });
    },
    async removeServer(id) {
      const status = state.statusMap.get(id);
      if (!status) {
        mcpLog.warn(`MCP server '${id}' not found for removal`, {
          operation: "removeServer",
          serverId: id,
        });
        return;
      }
      if (status.server) {
        try {
          await status.server.transport.disconnect();
        } catch (err: unknown) {
          mcpLog.warn(
            `MCP server '${id}': transport disconnect failed during removal`,
            {
              operation: "removeServer",
              serverId: id,
              err,
            },
          );
        }
      }
      state.statusMap.delete(id);
      state.configuredCount = Math.max(0, state.configuredCount - 1);
      notifyMcpStatusListeners(state);
      mcpLog.info(`MCP server '${id}' removed`, {
        operation: "removeServer",
        serverId: id,
      });
    },
    reconnectServer(id, secretStore?) {
      const status = state.statusMap.get(id);
      if (!status) {
        mcpLog.warn(`MCP server '${id}' not found for reconnect`, {
          operation: "reconnectServer",
          serverId: id,
        });
        return;
      }
      // Mark as disconnected so health poll exits, then re-launch retry loop
      state.statusMap.set(id, {
        ...status,
        state: "disconnected",
        server: undefined,
      });
      notifyMcpStatusListeners(state);
      mcpLog.info(`MCP server '${id}' reconnect initiated`, {
        operation: "reconnectServer",
        serverId: id,
      });
      launchMcpServerRetryLoop(status.config, { secretStore, mcpLog, state });
    },
  };
}
