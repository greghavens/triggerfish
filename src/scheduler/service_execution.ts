/** Bind trusted scheduled occurrences to durable isolated agent turns. */
import { createHash } from "node:crypto";
import {
  type ExecutionTraceScope,
  openExecutionTraces,
} from "../core/execution_traces.ts";
import { createLogger } from "../core/logger/logger.ts";
import type { SessionId } from "../core/types/session.ts";
import type { ToolDispatchOutcome } from "../core/types/orchestrator.ts";
import type {
  OrchestratorCreateOptions,
  SchedulerExecutionIdentity,
  SchedulerServiceConfig,
} from "./service_types.ts";

const log = createLogger("scheduler");

export function schedulerExecutionIdentity(
  kind: SchedulerExecutionIdentity["kind"],
  sourceId: string,
  occurrence: string | number,
): SchedulerExecutionIdentity {
  const digest = createHash("sha256")
    .update(JSON.stringify([kind, sourceId, occurrence])).digest("hex");
  return { kind, sourceId, id: `scheduler-${kind}-${digest}` };
}

function recoverySessionId(execution: SchedulerExecutionIdentity): SessionId {
  const bytes = createHash("sha256").update(`scheduler-session:${execution.id}`)
    .digest("hex");
  const variant = ((Number.parseInt(bytes[16], 16) & 3) | 8).toString(16);
  return `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-8${
    bytes.slice(13, 16)
  }-${variant}${bytes.slice(17, 20)}-${bytes.slice(20, 32)}` as SessionId;
}

const active = new WeakMap<SchedulerServiceConfig, Set<string>>();

/** Claim the runtime occurrence before creating any durable session resources. */
export async function runSchedulerOccurrence(
  config: SchedulerServiceConfig,
  execution: SchedulerExecutionIdentity | undefined,
  run: () => Promise<void>,
): Promise<void> {
  if ((!config.recoverTurn && !config.executionTracePath) || !execution) {
    return await run();
  }
  let running = active.get(config);
  if (!running) {
    running = new Set();
    active.set(config, running);
  }
  if (running.has(execution.id)) return;
  running.add(execution.id);
  try {
    await run();
  } finally {
    running.delete(execution.id);
  }
}

export function createScheduledSession(
  config: SchedulerServiceConfig,
  defaultChannel: string,
  options: OrchestratorCreateOptions,
  execution?: SchedulerExecutionIdentity,
): ReturnType<SchedulerServiceConfig["orchestratorFactory"]["create"]> {
  if (!config.recoverTurn || !execution) {
    return config.orchestratorFactory.create(defaultChannel, options);
  }
  return config.orchestratorFactory.create(execution.id, {
    ...options,
    recoverySessionId: recoverySessionId(execution),
  });
}

type AgentBundle = Awaited<
  ReturnType<SchedulerServiceConfig["orchestratorFactory"]["create"]>
>;

export function bindScheduledAgent(
  config: SchedulerServiceConfig,
  bundle: AgentBundle,
  execution?: SchedulerExecutionIdentity,
): AgentBundle {
  const recoverTurn = config.recoverTurn;
  const tracePath = config.executionTracePath;
  if (!execution || !recoverTurn && !tracePath) return bundle;
  return {
    ...bundle,
    orchestrator: {
      ...bundle.orchestrator,
      async executeAgentTurn(options) {
        const scope: ExecutionTraceScope = {
          role: "scheduled",
          runId: execution.id,
          sessionId: bundle.session.id,
          sourceId: execution.sourceId,
          classification: options.targetClassification,
        };
        let journal: ReturnType<typeof openExecutionTraces> | undefined;
        try {
          if (tracePath && options.session.id === bundle.session.id) {
            try {
              journal = openExecutionTraces(tracePath);
              if (!journal.admit(scope)) {
                journal.close();
                journal = undefined;
              }
            } catch {
              journal?.close();
              journal = undefined;
              log.warn("Scheduled execution trace could not be admitted.");
            }
          }
          const traced = journal
            ? {
              ...options,
              onToolDispatchOutcome(entry: ToolDispatchOutcome) {
                try {
                  journal?.appendNext(scope, entry, entry.approvedPayload);
                } catch {
                  log.warn("Scheduled tool receipt could not be recorded.");
                }
                options.onToolDispatchOutcome?.(entry);
              },
            }
            : options;
          const result = await (recoverTurn
            ? recoverTurn(execution, bundle.orchestrator, traced)
            : bundle.orchestrator.executeAgentTurn(traced));
          if (result.ok || !recoverTurn) {
            try {
              journal?.finish(
                scope,
                result.ok ? "completed" : "failed",
                bundle.getSessionTaint(),
              );
            } catch {
              log.warn(
                "Scheduled execution trace outcome could not be recorded.",
              );
            }
          }
          return result;
        } catch (error) {
          if (!recoverTurn) {
            try {
              journal?.finish(scope, "failed", bundle.getSessionTaint());
            } catch {
              log.warn(
                "Scheduled execution trace outcome could not be recorded.",
              );
            }
          }
          throw error;
        } finally {
          journal?.close();
        }
      },
    },
  };
}

export async function createScheduledAgent(
  config: SchedulerServiceConfig,
  defaultChannel: string,
  options: OrchestratorCreateOptions,
  execution?: SchedulerExecutionIdentity,
): Promise<AgentBundle> {
  return bindScheduledAgent(
    config,
    await createScheduledSession(config, defaultChannel, options, execution),
    execution,
  );
}
