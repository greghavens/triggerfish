/**
 * MCP Server Manager types and interfaces.
 *
 * Defines McpServerConfig, ConnectedMcpServer, McpServerManager, and
 * related status types. Separated from the manager implementation in
 * `manager.ts` for lighter type-only imports.
 *
 * @module
 */

import type { ClassificationLevel } from "../core/types/classification.ts";
import type { SecretStore } from "../core/secrets/keychain/keychain.ts";
import type { McpClient, McpToolDefinition } from "./client/protocol.ts";
import type { McpServer } from "./gateway/gateway.ts";
import type { Transport } from "./client/transport.ts";

/** Parsed configuration for a single MCP server. */
export interface McpServerConfig {
  readonly id: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly classification?: ClassificationLevel;
  readonly enabled?: boolean;
  /**
   * Additional commands permitted beyond the built-in allowlist.
   * Built-in: npx, node, python3, python, deno, uvx.
   */
  readonly allowedCommands?: readonly string[];
  /**
   * Tool call timeout in milliseconds. Default: 60000.
   * Passed to createMcpClient() as the protocol-level request timeout.
   */
  readonly toolCallTimeoutMs?: number;
  /**
   * Maximum reconnection attempts before marking server permanently FAILED.
   * Default: 10. Set to 1 to allow a single attempt with no retries.
   */
  readonly maxRetries?: number;
  /**
   * Classification ceiling — tool results cannot be classified above this level.
   * Prevents a misconfigured server from escalating session taint.
   */
  readonly classificationCeiling?: ClassificationLevel;
}

/** A connected MCP server with its tools and metadata. */
export interface ConnectedMcpServer {
  readonly id: string;
  readonly classification: ClassificationLevel | undefined;
  readonly tools: readonly McpToolDefinition[];
  readonly server: McpServer;
  readonly client: McpClient;
  readonly transport: Transport;
}

/** Connection state for a configured MCP server. */
export type McpServerState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed";

/** Full status of a configured MCP server (connected or not). */
export interface McpServerStatus {
  readonly id: string;
  readonly config: McpServerConfig;
  readonly state: McpServerState;
  /** Only present when state is "connected". */
  readonly server?: ConnectedMcpServer;
  readonly lastError?: string;
}

/** Manager interface for MCP server lifecycle. */
export interface McpServerManager {
  /** Connect to all configured servers. Graceful degradation on failure. */
  connectAll(
    configs: readonly McpServerConfig[],
    secretStore?: SecretStore,
  ): Promise<readonly ConnectedMcpServer[]>;
  /** Disconnect all connected servers. */
  disconnectAll(): Promise<void>;
  /** Get currently connected servers. */
  getConnected(): readonly ConnectedMcpServer[];
  /**
   * Start background connection loops for all configured servers. Non-blocking.
   * Servers that fail to connect are retried with exponential backoff.
   */
  startAll(
    configs: readonly McpServerConfig[],
    secretStore?: SecretStore,
  ): void;
  /** Get full status (connected + disconnected) for all configured servers. */
  getStatus(): readonly McpServerStatus[];
  /** Get count of configured (non-disabled) servers. */
  getConfiguredCount(): number;
  /**
   * Register a callback invoked whenever connection state changes.
   * Returns an unsubscribe function.
   */
  onStatusChange(cb: (status: readonly McpServerStatus[]) => void): () => void;
  /** Add a server at runtime and start its background connection loop. */
  addServer(config: McpServerConfig, secretStore?: SecretStore): void;
  /** Disconnect and remove a server by ID. */
  removeServer(id: string): Promise<void>;
  /** Capture a classified connection for an owner-reviewed catalog refresh. */
  prepareToolRefresh(id: string):
    | ((authorize: () => Promise<boolean>) => Promise<boolean>)
    | undefined;
  /** Disconnect and reconnect a server by ID. */
  reconnectServer(id: string, secretStore?: SecretStore): void;
}
