/**
 * Implements the Model Context Protocol client with initialization, tool invocation, and resource listing.
 *
 * @module
 */

import type { Transport } from "./transport.ts";
import type {
  JsonRpcNotification,
  JsonRpcResponse,
} from "./protocol_jsonrpc.ts";
import { formatRequest, parseMessage } from "./protocol_jsonrpc.ts";

// ─── Barrel re-exports from protocol_jsonrpc.ts ─────────────────

export type {
  JsonRpcError,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./protocol_jsonrpc.ts";

export {
  formatRequest,
  formatResponse,
  MCP_ERROR_CODES,
  parseMessage,
} from "./protocol_jsonrpc.ts";

// --- MCP Types ---

/** Server information returned from MCP initialization. */
export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

/** MCP server capabilities. */
export interface McpCapabilities {
  readonly tools?: Record<string, unknown>;
  readonly resources?: Record<string, unknown>;
  readonly prompts?: Record<string, unknown>;
}

/** Result of MCP initialization handshake. */
export interface McpInitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: McpCapabilities;
  readonly serverInfo: McpServerInfo;
}

/** MCP tool definition. */
export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** MCP tool content item. */
export interface McpToolContent {
  readonly type: string;
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
}

/** MCP tool call result. */
export interface McpToolResult {
  readonly content: readonly McpToolContent[];
  readonly isError?: boolean;
}

/** MCP resource definition. */
export interface McpResource {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

// --- MCP Client ---

/** MCP Client interface for interacting with MCP servers. */
export interface McpClient {
  /** Perform the MCP initialization handshake. */
  initialize(): Promise<McpInitializeResult>;
  /** List available tools from the MCP server. */
  listTools(): Promise<readonly McpToolDefinition[]>;
  /** Call a tool on the MCP server. */
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  /** List available resources from the MCP server. */
  listResources(): Promise<readonly McpResource[]>;
}

/**
 * Create an MCP client that communicates via the given transport.
 *
 * @param transport - The transport layer to use for communication
 * @param timeoutMs - Timeout for requests in milliseconds (default 30000)
 */
export function createMcpClient(
  transport: Transport,
  timeoutMs = 30000,
  signal?: AbortSignal,
  protocolVersion = "2024-11-05",
): McpClient {
  const pendingRequests = new Map<
    number,
    {
      resolve: (value: JsonRpcResponse) => void;
      reject: (reason: Error) => void;
    }
  >();

  // Register message handler to dispatch responses to pending requests
  transport.onMessage((msg: string) => {
    const response = parseMessage(msg);
    if (response.id !== undefined) {
      const pending = pendingRequests.get(response.id);
      if (pending) {
        pendingRequests.delete(response.id);
        pending.resolve(response);
      }
    }
  });

  /**
   * Send a JSON-RPC request and wait for the matching response.
   */
  async function sendRequest(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    signal?.throwIfAborted();
    const request = formatRequest(method, params);
    const response = Promise.withResolvers<JsonRpcResponse>();
    pendingRequests.set(request.id, response);
    const timer = setTimeout(() => {
      response.reject(
        new Error(`MCP request timed out after ${timeoutMs}ms: ${method}`),
      );
    }, timeoutMs);
    const abort = () => response.reject(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const [, result] = await Promise.all([
        transport.send(JSON.stringify(request)),
        response.promise,
      ]);
      return result;
    } finally {
      clearTimeout(timer);
      pendingRequests.delete(request.id);
      signal?.removeEventListener("abort", abort);
    }
  }

  return {
    async initialize(): Promise<McpInitializeResult> {
      await transport.connect(signal);

      const response = await sendRequest("initialize", {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "triggerfish", version: "0.1.0" },
      });

      if (response.error) {
        throw new Error(
          `MCP initialization failed: ${response.error.message}`,
        );
      }

      // Send the required "initialized" notification to complete the handshake.
      const notification: JsonRpcNotification = {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      };
      signal?.throwIfAborted();
      await transport.send(JSON.stringify(notification));

      return response.result as McpInitializeResult;
    },

    async listTools(): Promise<readonly McpToolDefinition[]> {
      const response = await sendRequest("tools/list", {});

      if (response.error) {
        throw new Error(`tools/list failed: ${response.error.message}`);
      }

      const result = response.result as { tools: McpToolDefinition[] };
      return result.tools;
    },

    async callTool(
      name: string,
      args: Record<string, unknown>,
    ): Promise<McpToolResult> {
      const response = await sendRequest("tools/call", {
        name,
        arguments: args,
      });

      if (response.error) {
        throw new Error(`tools/call failed: ${response.error.message}`);
      }

      return response.result as McpToolResult;
    },

    async listResources(): Promise<readonly McpResource[]> {
      const response = await sendRequest("resources/list", {});

      if (response.error) {
        throw new Error(`resources/list failed: ${response.error.message}`);
      }

      const result = response.result as { resources: McpResource[] };
      return result.resources;
    },
  };
}
