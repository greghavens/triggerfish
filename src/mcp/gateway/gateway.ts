/**
 * MCP Gateway — secure proxy between agent and MCP servers.
 *
 * Intercepts all tool calls and responses, enforcing policy checks via hooks.
 * Servers must be in CLASSIFIED state before tool calls are permitted.
 * UNTRUSTED and BLOCKED servers are always rejected.
 *
 * When a lineageStore is provided, tool responses create lineage records and
 * the result includes session taint and lineage tracking metadata.
 *
 * @module
 */

import type {
  ClassificationLevel,
  Result,
} from "../../core/types/classification.ts";
import { maxClassification } from "../../core/types/classification.ts";
import type { SessionState } from "../../core/types/session.ts";
import type { HookResult, HookRunner } from "../../core/policy/hooks/hooks.ts";
import { createLogger } from "../../core/logger/logger.ts";
import type { McpToolResult } from "../client/protocol.ts";
import type { ServerStatus } from "./classifier.ts";
import type { LineageStore } from "../../core/session/lineage.ts";

const log = createLogger("mcp-gateway");

/** Interface for an MCP server that can execute tool calls. */
export interface McpServer {
  /** Call a tool by name with arguments. */
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Result<McpServerToolResult, string>>;
}

/** Result from an MCP server tool call. */
export interface McpServerToolResult {
  readonly content: string;
  readonly classification: ClassificationLevel;
  readonly entries?: readonly {
    readonly name: string;
    readonly size: number;
    readonly isDirectory: boolean;
  }[];
}

/** Server classification entry registered with the gateway. */
export interface ServerClassification {
  readonly uri: string;
  readonly name: string;
  readonly status: ServerStatus;
  readonly classification?: ClassificationLevel;
}

/** Options for calling a tool through the gateway. */
export interface GatewayCallOptions {
  readonly serverUri: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly session: SessionState;
  /** Optional MCP server to call directly (bypasses transport layer). */
  readonly mcpServer?: McpServer;
}

/** Options for creating an MCP gateway. */
export interface GatewayOptions {
  readonly hookRunner: HookRunner;
  /** Mock tool response for testing without a real MCP server. */
  readonly mockToolResponse?: McpToolResult;
  /** Lineage store for recording data provenance on tool responses. Required. */
  readonly lineageStore: LineageStore;
}

/** Enhanced tool result with taint and lineage tracking. */
export interface GatewayToolResult extends McpToolResult {
  /** Session taint level after this tool call. */
  readonly sessionTaint?: ClassificationLevel;
  /** Lineage record ID created for this tool response. */
  readonly lineageId?: string;
}

/** MCP Gateway interface for secure tool invocation. */
export interface McpGateway {
  /** Register an MCP server with its classification state. */
  registerServer(server: ServerClassification): void;
  /** Call a tool on a registered MCP server, subject to policy enforcement. */
  callTool(
    options: GatewayCallOptions,
  ): Promise<Result<GatewayToolResult, string>>;
}

/** Fire MCP_TOOL_CALL hook for an unregistered server. */
async function fireUnknownServerHook(
  hookRunner: HookRunner,
  session: SessionState,
  serverUri: string,
  toolName: string,
): Promise<HookResult> {
  return await hookRunner.evaluateHook("MCP_TOOL_CALL", {
    session,
    input: {
      server_uri: serverUri,
      tool_name: toolName,
      server_status: "UNKNOWN",
    },
  });
}

/** Fire MCP_TOOL_CALL hook for a registered server. */
async function fireToolCallHook(
  hookRunner: HookRunner,
  session: SessionState,
  server: ServerClassification,
  toolName: string,
): Promise<HookResult> {
  return await hookRunner.evaluateHook("MCP_TOOL_CALL", {
    session,
    input: {
      server_uri: server.uri,
      tool_name: toolName,
      server_status: server.status,
      server_classification: server.classification,
    },
  });
}

/** Build the policy rejection for a blocked MCP tool call, logging at WARN. */
function rejectBlockedMcpToolCall(opts: {
  readonly hookResult: HookResult;
  readonly session: SessionState;
  readonly toolName: string;
  readonly serverUri: string;
  readonly serverStatus: string;
  readonly serverClassification?: ClassificationLevel;
}): Result<never, string> {
  log.warn("MCP tool call blocked by MCP_TOOL_CALL hook", {
    operation: "callTool",
    serverUri: opts.serverUri,
    serverStatus: opts.serverStatus,
    serverClassification: opts.serverClassification,
    toolName: opts.toolName,
    sessionId: opts.session.id,
    sessionTaint: opts.session.taint,
    ruleId: opts.hookResult.ruleId,
    action: opts.hookResult.action,
    message: opts.hookResult.message,
  });
  return {
    ok: false,
    error: `MCP tool call blocked by policy: ${
      opts.hookResult.message ?? opts.hookResult.ruleId ?? "MCP_TOOL_CALL rule"
    }`,
  };
}

/** Reject calls to servers with UNTRUSTED or BLOCKED status. */
function rejectDisallowedServerStatus(
  server: ServerClassification,
): Result<never, string> | null {
  if (server.status === "UNTRUSTED") {
    return { ok: false, error: `Server is UNTRUSTED: ${server.name}` };
  }
  if (server.status === "BLOCKED") {
    return { ok: false, error: `Server is BLOCKED: ${server.name}` };
  }
  return null;
}

/** Build a GatewayToolResult from a successful MCP server response. */
function buildGatewayToolResult(
  serverResult: McpServerToolResult,
  session: SessionState,
): GatewayToolResult {
  const sessionTaint = maxClassification(
    session.taint,
    serverResult.classification,
  );
  return {
    content: [{ type: "text", text: serverResult.content }],
    sessionTaint,
  };
}

/** Record data lineage for a tool response and attach the lineage ID. */
async function recordToolResponseLineage(
  lineageStore: LineageStore,
  serverResult: McpServerToolResult,
  server: ServerClassification,
  session: SessionState,
  toolName: string,
  baseResult: GatewayToolResult,
): Promise<GatewayToolResult> {
  const lineageRecord = await lineageStore.create({
    content: serverResult.content,
    origin: {
      source_type: "mcp_server",
      source_name: server.name,
      accessed_at: new Date().toISOString(),
      accessed_by: session.userId as string,
      access_method: toolName,
    },
    classification: {
      level: serverResult.classification,
      reason: `Data from ${server.name} (${server.classification})`,
    },
    sessionId: session.id,
  });
  return { ...baseResult, lineageId: lineageRecord.lineage_id };
}

/** Execute a tool call through the provided MCP server. */
async function executeMcpServerToolCall(
  mcpServer: McpServer,
  callOptions: GatewayCallOptions,
  server: ServerClassification,
  lineageStore: LineageStore | undefined,
): Promise<Result<GatewayToolResult, string>> {
  const toolResult = await mcpServer.callTool(
    callOptions.toolName,
    callOptions.arguments,
  );
  if (!toolResult.ok) {
    return { ok: false, error: toolResult.error };
  }

  const baseResult = buildGatewayToolResult(
    toolResult.value,
    callOptions.session,
  );

  if (lineageStore) {
    const enrichedResult = await recordToolResponseLineage(
      lineageStore,
      toolResult.value,
      server,
      callOptions.session,
      callOptions.toolName,
      baseResult,
    );
    return { ok: true, value: enrichedResult };
  }

  return { ok: true, value: baseResult };
}

/**
 * Create an MCP Gateway that enforces policy on all tool calls.
 *
 * The gateway sits between the agent and MCP servers, intercepting all
 * tool calls and responses. It fires the MCP_TOOL_CALL hook and rejects the
 * call when the hook denies it (so operator-authored MCP_TOOL_CALL BLOCK
 * rules take effect), and always rejects UNTRUSTED or BLOCKED servers.
 *
 * When a lineageStore is provided and a tool call succeeds, the gateway
 * creates a lineage record and returns the session taint and lineage ID.
 *
 * @param options - Hook runner, optional mock response, and optional lineage store
 * @returns An McpGateway instance
 */
export function createMcpGateway(options: GatewayOptions): McpGateway {
  const { hookRunner, mockToolResponse, lineageStore } = options;
  const servers = new Map<string, ServerClassification>();

  return {
    registerServer(server: ServerClassification): void {
      servers.set(server.uri, server);
    },

    async callTool(
      callOptions: GatewayCallOptions,
    ): Promise<Result<GatewayToolResult, string>> {
      const { serverUri, toolName, session, mcpServer } = callOptions;
      const server = servers.get(serverUri);

      if (!server) {
        const unknownResult = await fireUnknownServerHook(
          hookRunner,
          session,
          serverUri,
          toolName,
        );
        if (!unknownResult.allowed) {
          // Already rejected below; record the policy denial for the audit.
          log.warn("MCP tool call to unknown server denied by hook", {
            operation: "callTool",
            serverUri,
            toolName,
            sessionId: session.id,
            sessionTaint: session.taint,
            ruleId: unknownResult.ruleId,
          });
        }
        return { ok: false, error: `Server not registered: ${serverUri}` };
      }

      const hookResult = await fireToolCallHook(
        hookRunner,
        session,
        server,
        toolName,
      );
      if (!hookResult.allowed) {
        return rejectBlockedMcpToolCall({
          hookResult,
          session,
          toolName,
          serverUri: server.uri,
          serverStatus: server.status,
          serverClassification: server.classification,
        });
      }

      const rejection = rejectDisallowedServerStatus(server);
      if (rejection) {
        return rejection;
      }

      if (mcpServer) {
        return executeMcpServerToolCall(
          mcpServer,
          callOptions,
          server,
          lineageStore,
        );
      }

      if (mockToolResponse) {
        return { ok: true, value: mockToolResponse };
      }

      return {
        ok: false,
        error: `No MCP client available for server: ${server.name}`,
      };
    },
  };
}
