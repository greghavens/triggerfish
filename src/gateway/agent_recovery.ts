/** Execute an agent turn with an explicit persistence policy and durable batch boundary. */
import {
  AgentRecoveryStore,
  type RecoveryToolReceipt,
} from "../core/agent_recovery_store.ts";
import { computeContentHash } from "../core/session/lineage_serde.ts";
import {
  canFlowTo,
  type ClassificationLevel,
  maxClassification,
} from "../core/types/classification.ts";
import type {
  AgentTurnCheckpoint,
  Orchestrator,
  ProcessMessageOptions,
} from "../core/types/orchestrator.ts";

interface Call {
  readonly name: string;
  readonly id?: string;
  readonly args: Record<string, unknown>;
  readonly malformed?: true;
}

export interface AgentRecoveryPolicy {
  readonly version: string;
  projectCall(call: Call): Record<string, unknown> | undefined;
  projectResult(call: Call, text: string): string | undefined;
  /** Recheck the approved operation, destination, and current authorization. */
  authorize(receipt: RecoveryToolReceipt): Promise<boolean>;
  readonly classification: () => ClassificationLevel;
}

export type AgentRecoveryExecutor = (
  executionId: string,
  orchestrator: Pick<Orchestrator, "executeAgentTurn">,
  options: ProcessMessageOptions,
  control?: { readonly resumeOnly?: boolean },
) => ReturnType<Orchestrator["executeAgentTurn"]>;

const USER_MESSAGE = "[Original request supplied again at resume]";
const WITHHELD = "[Tool result unavailable in this recovery policy]";

function safeCheckpoint(
  batch: AgentTurnCheckpoint,
  prior: AgentTurnCheckpoint | undefined,
  exchanges: readonly {
    call: Call;
    args?: Record<string, unknown>;
    text?: string;
  }[],
): AgentTurnCheckpoint {
  const history = [
    ...prior?.history ?? [{ role: "user", content: USER_MESSAGE }],
  ];
  const paired = exchanges.every(({ call }) => typeof call.id === "string");
  const toolId = (index: number) =>
    `recovery_${batch.completedIterations}_${index}`;
  history.push({
    role: "assistant",
    content: " ",
    ...(paired && {
      tool_calls: exchanges.map(({ call, args }, index) => ({
        type: "function",
        id: toolId(index),
        function: {
          name: args ? call.name : "unapproved_tool",
          arguments: JSON.stringify(args ?? {}),
        },
      })),
    }),
  });
  if (paired) {
    for (const [index, { text }] of exchanges.entries()) {
      history.push({
        role: "tool",
        tool_call_id: toolId(index),
        content: text ?? WITHHELD,
      });
    }
  } else {
    history.push({
      role: "user",
      content: exchanges.map(({ call, args, text }) =>
        `[TOOL_RESULT name="${args ? call.name : "unapproved_tool"}"]\n${
          text ?? WITHHELD
        }\n[/TOOL_RESULT]`
      ).join("\n\n"),
    });
  }
  return {
    ...batch,
    history,
    // The raw loop keys contain serialized tool arguments.
    toolCallCounts: [],
  };
}

/**
 * Recover the same admitted execution. A pending batch has an uncertain
 * outcome and requires reconciliation before any tool can be retried.
 */
export async function runRecoverableAgentTurn(
  path: string,
  executionId: string,
  policy: AgentRecoveryPolicy,
  orchestrator: Pick<Orchestrator, "executeAgentTurn">,
  options: ProcessMessageOptions,
  control?: { readonly resumeOnly?: boolean },
): ReturnType<Orchestrator["executeAgentTurn"]> {
  if (typeof options.message !== "string") {
    return {
      ok: false,
      error: "Recoverable executions require a text request.",
    };
  }
  const message = options.message;
  const key = await computeContentHash(
    JSON.stringify([options.session.id, executionId]),
  );
  const binding = await computeContentHash(JSON.stringify([
    options.session.id,
    options.session.userId,
    options.session.channelId,
    options.targetClassification,
    policy.version,
    message,
  ]));
  const store = new AgentRecoveryStore(path);
  try {
    const admission = control?.resumeOnly
      ? store.read(key)
      : store.begin(key, binding);
    if (!admission || admission.binding !== binding) {
      return { ok: false, error: "The recovery execution scope changed." };
    }
    if (admission.status === "pending") {
      return {
        ok: false,
        error:
          "A prior tool batch has an uncertain outcome. Reconcile the action before retrying.",
      };
    }
    if (admission.status === "finished") {
      return { ok: false, error: "This execution already finished." };
    }
    if (control?.resumeOnly && !admission.checkpoint) {
      return {
        ok: false,
        error: "This admitted execution has no saved continuation.",
      };
    }

    let checkpoint = admission.checkpoint;
    let committedBatch = admission.committedBatch;
    const receipts = [...admission.tools];
    let resumeClassification = options.session.taint;
    for (const receipt of receipts) {
      const allowed = canFlowTo(
        receipt.classification,
        options.targetClassification,
      ) && await policy.authorize(receipt).catch(() => false);
      if (!allowed) {
        return {
          ok: false,
          error: "A saved tool result is no longer authorized.",
        };
      }
      resumeClassification = maxClassification(
        resumeClassification,
        receipt.classification,
      );
    }

    let activeBatch: number | undefined;
    let exchanges: {
      call: Call;
      args?: Record<string, unknown>;
      text?: string;
    }[] = [];
    const result = await orchestrator.executeAgentTurn({
      ...options,
      resume: checkpoint && {
        ...checkpoint,
        history: [
          { role: "user", content: message },
          ...checkpoint.history.slice(1),
        ],
      },
      ...(checkpoint && {
        resumeClassification,
        resumeToolCalls: receipts.map(({ name, args }) => ({
          name,
          args: { ...args },
        })),
      }),
      beforeToolBatch: (batch, calls) => {
        const projected = calls.map((call) => ({
          call,
          args: call.malformed ? undefined : policy.projectCall(call),
        }));
        if (projected.some(({ args }) => !args)) {
          throw new Error("A tool is outside the recovery policy.");
        }
        if (!store.beginBatch(key, binding, batch, committedBatch)) {
          throw new Error("Execution no longer owns the tool batch.");
        }
        activeBatch = batch;
        exchanges = projected;
        return Promise.resolve();
      },
      toolPersistence: {
        projectCall: (call) =>
          call.malformed ? undefined : policy.projectCall(call),
        projectResult(call, { text, blocked }) {
          const exchange = exchanges.find((entry) =>
            entry.text === undefined && entry.call.name === call.name &&
            entry.call.id === call.id
          );
          const projected = !blocked && exchange?.args !== undefined
            ? policy.projectResult(call, text)
            : undefined;
          if (exchange) exchange.text = projected ?? WITHHELD;
          return projected;
        },
      },
      async onToolBatchCheckpoint(batch) {
        if (activeBatch !== batch.completedIterations) {
          throw new Error("Tool batch no longer matches execution.");
        }
        for (const [index, exchange] of exchanges.entries()) {
          receipts.push({
            name: exchange.args ? exchange.call.name : "unapproved_tool",
            args: exchange.args ?? {},
            callId: `${activeBatch}:${index}`,
            classification: policy.classification(),
            resultSha256: await computeContentHash(exchange.text ?? WITHHELD),
          });
        }
        const projected = safeCheckpoint(batch, checkpoint, exchanges);
        if (
          !store.commitBatch(key, binding, activeBatch, projected, receipts)
        ) {
          throw new Error("Tool batch could not be committed.");
        }
        checkpoint = projected;
        committedBatch = activeBatch;
      },
    });
    if (result.ok && !store.finish(key, binding, committedBatch)) {
      return {
        ok: false,
        error: "The execution outcome could not be confirmed.",
      };
    }
    return result;
  } finally {
    store.close();
  }
}
