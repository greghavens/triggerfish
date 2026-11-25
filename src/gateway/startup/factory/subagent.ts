/**
 * Subagent factory builder.
 *
 * Wraps an OrchestratorFactory to spawn isolated agents that process
 * a task prompt and return the agent's text response.
 * @module
 */

import type { Workspace } from "../../../exec/workspace_types.ts";
import {
  type ExecutionTraceScope,
  type ExecutionTraceTerminalStatus,
  openExecutionTraces,
} from "../../../core/execution_traces.ts";
import { createLogger } from "../../../core/logger/logger.ts";
import type { ToolDispatchOutcome } from "../../../core/types/orchestrator.ts";
import type { OrchestratorFactory } from "../../../scheduler/service_types.ts";
import {
  delegatedSubagentIdentity,
  type DelegatedSubagentRecovery,
} from "./delegated_agent_recovery.ts";

const log = createLogger("delegated-execution");

/** Options for building a subagent factory. */
export interface SubagentFactoryOptions {
  /** Maximum agent loop iterations per subagent. Defaults to global MAX_TOOL_ITERATIONS. */
  readonly maxIterations?: number;
  /**
   * Parent workspace to reuse for subagent sessions.
   * When provided, the subagent shares the parent's workspace and sandbox
   * boundary instead of creating a fresh isolated workspace.
   */
  readonly workspace?: Workspace;
  /** Private operator metadata store for delegated tool dispatch receipts. */
  readonly executionTracePath?: string;
}

/** Per-call spawn options that override factory defaults. */
export interface SubagentSpawnOptions {
  /** Override the factory-level maxIterations for this specific spawn. */
  readonly maxIterations?: number;
  /** Internal execution anchor and authorized runner, never parsed from model arguments. */
  readonly recovery?: DelegatedSubagentRecovery;
  readonly signal?: AbortSignal;
}

/**
 * Build a subagent factory that uses OrchestratorFactory to spawn isolated agents.
 *
 * Each call creates a fresh orchestrator + session and processes the task prompt,
 * returning the agent's text response.
 *
 * The returned function accepts an optional third argument to override factory
 * defaults on a per-call basis (e.g. adaptive iteration budget for explore).
 */
export function buildSubagentFactory(
  orchFactory: OrchestratorFactory,
  opts?: SubagentFactoryOptions,
): (
  task: string,
  tools?: string,
  spawnOpts?: SubagentSpawnOptions,
) => Promise<string> {
  return async (
    task: string,
    _tools?: string,
    spawnOpts?: SubagentSpawnOptions,
  ): Promise<string> => {
    const maxIterations = spawnOpts?.maxIterations ?? opts?.maxIterations;
    const recovery = spawnOpts?.recovery;
    const identity = recovery && await delegatedSubagentIdentity(
      recovery.parentSessionId,
      recovery.executionId,
    );
    const { orchestrator, session, getSessionTaint } = await orchFactory.create(
      identity?.channelId ?? "subagent",
      {
        delegatedKind: "subagent",
        maxIterations,
        workspace: opts?.workspace,
        ...(identity && { recoverySessionId: identity.sessionId }),
        ...(recovery?.targetClassification !== undefined && {
          ceiling: recovery.targetClassification,
        }),
      },
    );
    if (identity && identity.sessionId !== session.id) {
      return "Sub-agent error: Trusted recovery session could not be restored.";
    }
    const trace = opts?.executionTracePath
      ? openExecutionTraces(opts.executionTracePath)
      : undefined;
    const traceScope: ExecutionTraceScope = {
      role: "delegated",
      runId: identity?.executionId ?? crypto.randomUUID(),
      sessionId: session.id,
      ...(recovery && { sourceId: recovery.parentSessionId }),
    };
    let admitted = false;
    let terminal: ExecutionTraceTerminalStatus | undefined;
    try {
      if (trace && !trace.admit(traceScope)) {
        return "Sub-agent error: The execution trace identity could not be admitted.";
      }
      admitted = trace !== undefined;
      const options = {
        session,
        message: task,
        targetClassification: recovery?.targetClassification ?? session.taint,
        signal: spawnOpts?.signal,
        ...(trace && {
          onToolDispatchOutcome: (entry: ToolDispatchOutcome) => {
            trace.appendNext(traceScope, entry, entry.approvedPayload);
          },
        }),
      };
      const result = recovery && identity
        ? await recovery.run(identity.executionId, orchestrator, options)
        : await orchestrator.executeAgentTurn(options);
      if (result.ok) terminal = "completed";
      if (!result.ok) return `Sub-agent error: ${result.error}`;
      return result.value.response;
    } finally {
      if (trace) {
        try {
          if (!recovery) {
            terminal ??= spawnOpts?.signal?.aborted ? "interrupted" : "failed";
          }
          if (admitted && terminal) {
            trace.finish(traceScope, terminal, getSessionTaint());
          }
        } catch {
          log.warn("Could not finalize delegated execution trace");
        } finally {
          trace.close();
        }
      }
    }
  };
}
