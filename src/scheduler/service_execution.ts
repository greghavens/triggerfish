/** Bind trusted scheduled occurrences to durable isolated agent turns. */
import { createHash } from "node:crypto";
import type { SessionId } from "../core/types/session.ts";
import type {
  OrchestratorCreateOptions,
  SchedulerExecutionIdentity,
  SchedulerServiceConfig,
} from "./service_types.ts";

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
  if (!config.recoverTurn || !execution) return await run();
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
  if (!recoverTurn || !execution) return bundle;
  return {
    ...bundle,
    orchestrator: {
      ...bundle.orchestrator,
      executeAgentTurn: (options) =>
        recoverTurn(execution, bundle.orchestrator, options),
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
