import { withCommittedRecoveryEvidence } from "./committed_recovery_evidence.ts";
import {
  sleepResult,
  sleepSeconds,
  sleepToolName,
  waitUntil,
} from "./sleep_deadline.ts";
import type { SavedSourceAuthorization } from "./types/orchestrator.ts";
import { isDeepStrictEqual } from "node:util";
import { assignmentRecoveryKey } from "./durable_assignment.ts";
import type { ExecutionTraceApprovedPayload } from "./execution_traces.ts";
/** Execute an agent turn with an explicit persistence policy and durable batch boundary. */
import {
  AgentRecoveryStore,
  lockAgentRecovery,
  type PendingRecoveryCall,
  type RecoveryToolReceipt,
} from "./agent_recovery_store.ts";
import { computeContentHash } from "./session/lineage_serde.ts";
import {
  canFlowTo,
  type ClassificationLevel,
  maxClassification,
} from "./types/classification.ts";
import type {
  AgentTurnCheckpoint,
  Orchestrator,
  ProcessMessageOptions,
} from "./types/orchestrator.ts";

interface Call {
  readonly name: string;
  readonly id?: string;
  readonly args: Record<string, unknown>;
  readonly malformed?: true;
}

export interface AgentRecoveryPolicy {
  readonly version: string;
  projectCall(call: Call): Record<string, unknown> | undefined;
  /** Opt in only for operations whose repetition cannot change external state. */
  isReplaySafeRead?(call: Call): boolean;
  projectResult(call: Call, text: string): string | undefined;
  /** Opt in only for calls with an exact, externally verifiable operation identity. */
  canReconcile?(call: Call): boolean;
  authorizeDispatch?(
    call: Call,
    approvedRuleId?: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  /** Check current authority and read the outcome of the original operation without dispatching it. */
  reconcile?(
    operation: PendingRecoveryCall & {
      readonly executionId: string;
      readonly batch: number;
    },
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  resultResourceId?(projected: string): number | undefined;
  managedObservationGrantDigest?: string;
  projectTracePayload?(
    call: Call,
    projected: string,
  ): ExecutionTraceApprovedPayload | undefined;
  /** Recheck the approved operation, destination, and current authorization. */
  authorize(
    receipt: RecoveryToolReceipt,
    sourceAuthorization?: SavedSourceAuthorization,
  ): Promise<boolean>;
  /** Revalidate the current admission before exposing a committed typed result. */
  authorizeCommittedEvidence?(): Promise<boolean>;
  authorizeSavedProjection?(
    receipt: RecoveryToolReceipt,
    projection: string,
  ): boolean;
  readonly classification: () => ClassificationLevel;
}

interface RecoveryControl {
  readonly resumeOnly?: boolean;
  readonly resumePaused?: boolean;
}

export type AgentRecoveryExecutor = (
  executionId: string,
  orchestrator: Pick<Orchestrator, "executeAgentTurn">,
  options: ProcessMessageOptions,
  control?: RecoveryControl,
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

function withRecoverableSleep(base: AgentRecoveryPolicy): AgentRecoveryPolicy {
  return {
    ...base,
    projectCall(call) {
      if (call.name !== sleepToolName) return base.projectCall(call);
      const seconds = sleepSeconds(call.args);
      return seconds === undefined ? undefined : { seconds };
    },
    projectResult(call, text) {
      if (call.name !== sleepToolName) return base.projectResult(call, text);
      const seconds = sleepSeconds(call.args);
      return seconds !== undefined && text === sleepResult(seconds)
        ? text
        : undefined;
    },
    isReplaySafeRead: base.isReplaySafeRead &&
      ((call) => call.name !== sleepToolName && base.isReplaySafeRead!(call)),
    canReconcile: (call) =>
      call.name === sleepToolName || base.canReconcile?.(call) === true,
    authorizeDispatch: (call, rule, signal) =>
      call.name === sleepToolName
        ? Promise.resolve(!signal?.aborted)
        : base.authorizeDispatch?.(call, rule, signal) ?? Promise.resolve(true),
    authorize: (receipt, authorization) =>
      receipt.name === sleepToolName
        ? Promise.resolve(sleepSeconds(receipt.args) !== undefined)
        : base.authorize(receipt, authorization),
    projectTracePayload: base.projectTracePayload &&
      ((call, text) =>
        call.name === sleepToolName
          ? undefined
          : base.projectTracePayload?.(call, text)),
  };
}

function pendingSleep(call: PendingRecoveryCall | undefined) {
  if (!call || call.name !== sleepToolName) return;
  const { deadline, ...args } = call.args;
  const seconds = sleepSeconds(args);
  if (
    seconds === undefined || typeof deadline !== "number" ||
    !Number.isSafeInteger(deadline) || deadline < 0 ||
    deadline - Date.now() > seconds * 1000
  ) return;
  return {
    call: { ...call, id: "recovered-sleep", args },
    deadline,
    text: sleepResult(seconds),
  };
}

/**
 * Recover the same admitted execution. A pending batch requires reconciliation
 * unless every operation was marked replay-safe before dispatch.
 */
export async function runRecoverableAgentTurn(
  path: string,
  executionId: string,
  basePolicy: AgentRecoveryPolicy,
  orchestrator: Pick<Orchestrator, "executeAgentTurn">,
  options: ProcessMessageOptions,
  control?: RecoveryControl,
): ReturnType<Orchestrator["executeAgentTurn"]> {
  if (typeof options.message !== "string") {
    return {
      ok: false,
      error: "Recoverable executions require a text request.",
    };
  }
  const policy = withRecoverableSleep(basePolicy);
  const message = options.message;
  const key = assignmentRecoveryKey(options.session.id, executionId);
  using lock = lockAgentRecovery(path, key);
  if (!lock) {
    return { ok: false, error: "This recovery execution is already active." };
  }
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
    let admission = control?.resumeOnly || control?.resumePaused
      ? store.read(key)
      : store.begin(key, binding);
    if (!admission || admission.binding !== binding) {
      return { ok: false, error: "The recovery execution scope changed." };
    }
    if (
      admission.status === "pending" &&
      (policy.isReplaySafeRead || policy.reconcile) &&
      !control?.resumePaused &&
      (!control?.resumeOnly || admission.checkpoint) &&
      store.resetRetryableBatch(key, binding)
    ) {
      admission = store.read(key)!;
    }
    if (
      admission.status === "pending" && policy.reconcile &&
      !options.signal?.aborted
    ) {
      const batch = admission.pendingBatch;
      const pending = store.pendingCall(key, batch);
      if (pending && pending.name !== sleepToolName) {
        const call = {
          ...pending,
          id: "reconciled",
          args: { ...pending.args },
        };
        if (
          canFlowTo(pending.classification, options.targetClassification) &&
          policy.canReconcile?.(call) &&
          isDeepStrictEqual(policy.projectCall(call), pending.args)
        ) {
          const outcome = await policy.reconcile({
            ...pending,
            executionId,
            batch,
          }, options.signal)
            .catch(() => undefined);
          const text = outcome === undefined
            ? undefined
            : policy.projectResult(call, outcome);
          if (text !== undefined && !options.signal?.aborted) {
            const prior = admission.checkpoint;
            const receipt: RecoveryToolReceipt = {
              name: pending.name,
              args: pending.args,
              ...(pending.approvedRuleId &&
                { approvedRuleId: pending.approvedRuleId }),
              callId: `${batch}:0`,
              classification: maxClassification(
                pending.classification,
                policy.classification(),
              ),
              resultSha256: await computeContentHash(text),
              resourceId: policy.resultResourceId?.(text),
            };
            const projected = safeCheckpoint(
              {
                history: [],
                completedIterations: batch,
                tokenUsage: prior?.tokenUsage ??
                  { inputTokens: 0, outputTokens: 0 },
                nudgeCount: prior?.nudgeCount ?? 0,
                eosRetries: prior?.eosRetries ?? 0,
                toolCallCounts: [],
              },
              prior,
              [{ call, args: call.args, text }],
            );
            if (
              !options.signal?.aborted &&
              store.commitBatch(key, binding, batch, projected, [
                ...admission.tools,
                receipt,
              ])
            ) {
              admission = store.read(key)!;
            }
          }
        }
      }
    }
    const sleeping = admission.status === "pending"
      ? pendingSleep(store.pendingCall(key, admission.pendingBatch))
      : undefined;
    if (admission.status === "pending" && !sleeping) {
      return {
        ok: false,
        error:
          "A prior tool batch has an uncertain outcome. Reconcile the action before retrying.",
      };
    }
    if (admission.status === "finished") {
      return { ok: false, error: "This execution already finished." };
    }
    if (admission.status === "paused" && !control?.resumePaused) {
      return { ok: false, error: "This recovery execution is paused." };
    }
    if (control?.resumePaused && admission.status !== "paused") {
      return {
        ok: false,
        error: "This recovery execution has no paused checkpoint.",
      };
    }
    const pausedBeforeFirstAction = admission.status === "paused" &&
      admission.committedBatch === 0 && !admission.checkpoint;
    if (
      control?.resumeOnly && !admission.checkpoint && !sleeping &&
      !pausedBeforeFirstAction
    ) {
      return {
        ok: false,
        error: "This admitted execution has no saved continuation.",
      };
    }

    let checkpoint = admission.checkpoint;
    let committedBatch = admission.committedBatch;
    const receipts = [...admission.tools];
    let pendingSleepBatch: number | undefined;
    if (sleeping && admission.status === "pending") {
      pendingSleepBatch = admission.pendingBatch;
      const { call, text } = sleeping;
      checkpoint = safeCheckpoint(
        {
          history: [],
          completedIterations: pendingSleepBatch,
          tokenUsage: checkpoint?.tokenUsage ??
            { inputTokens: 0, outputTokens: 0 },
          nudgeCount: checkpoint?.nudgeCount ?? 0,
          eosRetries: checkpoint?.eosRetries ?? 0,
          toolCallCounts: [],
        },
        checkpoint,
        [{ call, args: call.args, text }],
      );
      receipts.push({
        name: call.name,
        args: call.args,
        ...(call.approvedRuleId && { approvedRuleId: call.approvedRuleId }),
        callId: `${pendingSleepBatch}:0`,
        classification: call.classification,
        resultSha256: await computeContentHash(text),
      });
    }
    let resumeClassification = options.session.taint;
    for (const receipt of receipts) {
      if (!canFlowTo(receipt.classification, options.targetClassification)) {
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
    let guardedDispatch = false;
    let emittedRestoredResults = false;
    let exchanges: {
      call: Call;
      args?: Record<string, unknown>;
      text?: string;
      recordedAt?: number;
      approvedRuleId?: string;
      reconciliationRequired?: boolean;
    }[] = [];
    if (admission.status === "paused" && !store.resumePaused(key, binding)) {
      return { ok: false, error: "The paused recovery checkpoint changed." };
    }
    let finished = false;
    try {
      const scope = {
        executionId,
        sessionId: options.session.id,
        key,
        binding,
        ceiling: options.targetClassification,
        signal: options.signal,
        store,
        policy,
      };
      const turn: ProcessMessageOptions = {
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
          async authorizeResumeSources(
            signal?: AbortSignal,
            sourceAuthorization?: SavedSourceAuthorization,
          ) {
            const projections = (
              basePolicy.authorizeSavedProjection ||
              (options.onRestoredToolResult && policy.projectTracePayload)
            ) && new Map(
              checkpoint?.history.flatMap(({ role, tool_call_id, content }) =>
                role === "tool" && typeof tool_call_id === "string" &&
                  typeof content === "string"
                  ? [[tool_call_id, content] as const]
                  : []
              ),
            );
            const authorized: {
              payload: ExecutionTraceApprovedPayload;
              receipt: RecoveryToolReceipt;
              recordedAt: number;
            }[] = [];
            for (const receipt of receipts) {
              const saved = projections &&
                projections.get(`recovery_${receipt.callId.replace(":", "_")}`);
              const wait = receipt.name === sleepToolName
                ? sleepSeconds(receipt.args)
                : undefined;
              if (
                signal?.aborted ||
                (wait !== undefined &&
                  await computeContentHash(sleepResult(wait)) !==
                    receipt.resultSha256) ||
                (receipt.name !== sleepToolName &&
                  basePolicy.authorizeSavedProjection &&
                  (saved === undefined ||
                    !basePolicy.authorizeSavedProjection(receipt, saved))) ||
                !await policy.authorize(receipt, sourceAuthorization)
              ) {
                return false;
              }
              if (
                !emittedRestoredResults && options.onRestoredToolResult &&
                policy.projectTracePayload && saved !== undefined &&
                receipt.recordedAt !== undefined && saved !== WITHHELD &&
                !saved.startsWith("Error:") &&
                await computeContentHash(saved) === receipt.resultSha256
              ) {
                let payload: ExecutionTraceApprovedPayload | undefined;
                try {
                  payload = policy.projectTracePayload({
                    name: receipt.name,
                    args: { ...receipt.args },
                  }, saved);
                } catch {
                  // Trace projection is optional for an authorized restoration.
                }
                if (payload) {
                  authorized.push({
                    payload,
                    receipt,
                    recordedAt: receipt.recordedAt,
                  });
                }
              }
            }
            if (sleeping && pendingSleepBatch !== undefined) {
              const batch = pendingSleepBatch;
              if (
                !checkpoint || !sourceAuthorization ||
                !await waitUntil(sleeping.deadline, signal) ||
                !await sourceAuthorization.authorizeSavedResponse(
                  sleepToolName,
                  sleeping.text,
                  sleeping.call.classification,
                ) || signal?.aborted ||
                !store.commitBatch(key, binding, batch, checkpoint, receipts)
              ) {
                return false;
              }
              committedBatch = batch;
              pendingSleepBatch = undefined;
              if (store.read(key)?.status === "paused") return false;
            }
            if (signal?.aborted) return false;
            if (!emittedRestoredResults) {
              emittedRestoredResults = true;
              for (const { payload, receipt, recordedAt } of authorized) {
                try {
                  options.onRestoredToolResult?.({
                    tool: receipt.name,
                    classification: receipt.classification,
                    outcome: "returned",
                    approvedPayload: payload,
                  }, recordedAt);
                } catch {
                  // A trace observer cannot invalidate an authorized result.
                }
              }
            }
            return true;
          },
          resumeToolCalls: receipts.map((
            { name, args, callId, resultSha256 },
          ) => ({
            name,
            id: callId,
            args: { ...args },
            resultReceipt: {
              toolCallId: `recovery_${callId.replace(":", "_")}`,
              sha256: resultSha256,
            },
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
          const guarded = projected.some(({ call, args }) =>
            call.name === sleepToolName ||
            (!!policy.reconcile && args &&
              policy.canReconcile?.({ ...call, args }))
          );
          if (guarded && projected.length !== 1) {
            throw new Error(
              "Reconcilable operations require a standalone tool batch.",
            );
          }
          const retryReads = calls.length > 0 &&
            calls.every((call) => policy.isReplaySafeRead?.(call) === true);
          if (
            !store.beginBatch(
              key,
              binding,
              batch,
              committedBatch,
              retryReads && !guarded,
              guarded,
            )
          ) {
            throw new Error(
              store.read(key)?.status === "paused"
                ? "The execution was paused before dispatch."
                : "Execution no longer owns the tool batch.",
            );
          }
          activeBatch = batch;
          guardedDispatch = guarded;
          exchanges = projected;
          return Promise.resolve();
        },
        toolPersistence: {
          acceptsSavedApproval(call, ruleId) {
            return receipts.some((receipt) =>
              receipt.callId === call.id && receipt.name === call.name &&
              receipt.approvedRuleId === ruleId &&
              isDeepStrictEqual(receipt.args, call.args)
            );
          },
          async beforeAuthorizedDispatch(call, approvedRuleId) {
            if (!guardedDispatch) return;
            if (activeBatch === undefined || exchanges.length !== 1) {
              throw new Error("The authorized tool batch is unavailable.");
            }
            const [single] = exchanges;
            if (
              !single.args || single.call.name !== call.name ||
              single.call.id !== call.id
            ) {
              throw new Error(
                "The approved tool call no longer matches the batch.",
              );
            }
            const projected = policy.projectCall(call);
            if (!isDeepStrictEqual(single.args, projected)) {
              throw new Error(
                "The approved tool request changed before dispatch.",
              );
            }
            const approved = { ...call, args: single.args };
            if (
              !policy.canReconcile?.(approved) ||
              policy.isReplaySafeRead?.(approved)
            ) {
              throw new Error(
                "The tool reconciliation policy changed before dispatch.",
              );
            }
            if (
              policy.authorizeDispatch &&
              !await policy.authorizeDispatch(
                approved,
                approvedRuleId,
                options.signal,
              )
            ) {
              throw new Error(
                "The exact recovery operation is not authorized.",
              );
            }
            const batch = activeBatch;
            const args = single.args;
            return () => {
              options.signal?.throwIfAborted();
              const seconds = call.name === sleepToolName
                ? sleepSeconds(args)
                : undefined;
              const pendingArgs = seconds === undefined
                ? args
                : { ...args, deadline: Date.now() + seconds * 1000 };
              if (
                !store.recordAuthorizedCall(key, binding, batch, {
                  name: call.name,
                  classification: policy.classification(),
                  args: pendingArgs,
                  ...(approvedRuleId && { approvedRuleId }),
                })
              ) {
                throw new Error(
                  "The approved recovery operation could not be recorded.",
                );
              }
              single.approvedRuleId = approvedRuleId;
              single.reconciliationRequired = true;
            };
          },
          projectTracePayload: policy.projectTracePayload,
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
            if (exchange) {
              exchange.text = projected ?? WITHHELD;
              if (projected !== undefined) exchange.recordedAt = Date.now();
            }
            return projected;
          },
        },
        async onToolBatchCheckpoint(batch) {
          if (activeBatch !== batch.completedIterations) {
            throw new Error("Tool batch no longer matches execution.");
          }
          for (const [index, exchange] of exchanges.entries()) {
            if (
              exchange.reconciliationRequired &&
              (exchange.text === undefined || exchange.text === WITHHELD)
            ) {
              throw new Error("The operation has no approved outcome receipt.");
            }
            const resourceId = exchange.text && exchange.text !== WITHHELD
              ? policy.resultResourceId?.(exchange.text)
              : undefined;
            receipts.push({
              ...(resourceId !== undefined && { resourceId }),
              ...(exchange.approvedRuleId && exchange.text !== undefined &&
                exchange.text !== WITHHELD &&
                { approvedRuleId: exchange.approvedRuleId }),
              name: exchange.args ? exchange.call.name : "unapproved_tool",
              args: exchange.args ?? {},
              callId: `${activeBatch}:${index}`,
              classification: policy.classification(),
              resultSha256: await computeContentHash(exchange.text ?? WITHHELD),
              ...(exchange.recordedAt !== undefined &&
                { recordedAt: exchange.recordedAt }),
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
          if (store.read(key)?.status === "paused") {
            throw new Error(
              "The execution paused at its committed checkpoint.",
            );
          }
        },
      };
      const result = await withCommittedRecoveryEvidence(
        scope,
        () => orchestrator.executeAgentTurn(turn),
      );
      if (result.ok && !store.finish(key, binding, committedBatch)) {
        return {
          ok: false,
          error: store.read(key)?.status === "paused"
            ? "The execution is paused."
            : "The execution outcome could not be confirmed.",
        };
      }
      finished = result.ok;
      return result;
    } finally {
      if (admission.status === "paused" && !finished) {
        store.pause(key, pausedBeforeFirstAction);
      }
    }
  } finally {
    store.close();
  }
}
