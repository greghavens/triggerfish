import { redactCredentialText } from "../core/logger/redactor.ts";
/** Canonical arguments retained for request-bound Sentinel goal proposals. */
import { normalizeSentinelFormalGoals } from "./formal_goals.ts";

export const SENTINEL_GOAL_PROPOSE = "sentinel_propose_goal";

export function sentinelGoalProposalArguments(value: unknown) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 5
  ) return;
  const { goalId, title, criterion, evidenceId, requestId } = value as Record<
    string,
    unknown
  >;
  if (
    typeof requestId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId)
  ) return;
  try {
    const [goal] = normalizeSentinelFormalGoals([{
      id: goalId,
      title,
      policy: "operator",
      criteria: [{
        id: "evidence",
        source: "graph_evidence",
        reference: evidenceId,
        description: criterion,
      }],
    }]);
    return {
      goalId: goal.id,
      title: goal.title,
      criterion: goal.criteria[0].description,
      evidenceId: goal.criteria[0].reference,
      requestId: requestId.toLowerCase(),
    };
  } catch {
    return undefined;
  }
}

export const SENTINEL_GOAL_PROVE = "sentinel_prove_goal";

export function sentinelGoalProofArguments(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const {
    goalId,
    criterionId,
    evidenceId,
    source = "graph_evidence",
    requestId,
  } = value as Record<string, unknown>;
  if (
    Object.keys(value).some((key) =>
      !["goalId", "criterionId", "evidenceId", "source", "requestId"].includes(
        key,
      )
    ) ||
    typeof goalId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(goalId) ||
    typeof criterionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(criterionId) ||
    typeof evidenceId !== "string" || !evidenceId.trim() ||
    evidenceId.length > 4096 || evidenceId.includes("\0") ||
    (source !== "graph_evidence" && source !== "graph_fact" &&
      source !== "adaptive_task" && source !== "finding_recheck") ||
    typeof requestId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId)
  ) return;
  return {
    goalId,
    criterionId,
    evidenceId,
    source,
    requestId: requestId.toLowerCase(),
  };
}

export const SENTINEL_GOAL_GRAPH_FACT_READ = "sentinel_graph_facts";
export const SENTINEL_WORKER_TRACE_SEARCH = "sentinel_worker_trace_search";
export const SENTINEL_GOAL_TASK_READ = "sentinel_worker_observation";
export function isSentinelGoalReceiptRead(tool: unknown) {
  return tool === SENTINEL_GOAL_GRAPH_FACT_READ ||
    tool === SENTINEL_GOAL_RECHECK_READ ||
    isRepeatableSentinelReceiptRead(tool);
}

export function isRepeatableSentinelReceiptRead(tool: unknown) {
  return tool === SENTINEL_GOAL_TASK_READ ||
    tool === SENTINEL_WORKER_TRACE_SEARCH;
}

export function isSentinelWorkerSearchReceipt(tool: unknown, args: unknown) {
  return tool === SENTINEL_WORKER_TRACE_SEARCH ||
    (tool === SENTINEL_GOAL_TASK_READ && !!args && typeof args === "object" &&
      "query" in args);
}

export const SENTINEL_GOAL_RECHECK_READ = "sentinel_worker_findings";

export type SentinelWorkerTraceSearchArgs = {
  readonly task?: string;
  readonly query?: string;
  readonly stepIndices?: readonly number[];
  readonly revision?: number;
  readonly offset?: number;
  readonly limit?: number;
};

export function sentinelWorkerTraceSearchArgs(
  args: Record<string, unknown>,
): SentinelWorkerTraceSearchArgs | undefined {
  const { query, task, stepIndices, revision, offset, limit } = args;
  if (
    Object.keys(args).some((key) =>
      !["query", "task", "stepIndices", "revision", "offset", "limit"].includes(
        key,
      )
    ) ||
    (query !== undefined && (typeof query !== "string" ||
      !/^[a-zA-Z0-9 ._:-]{0,128}$/.test(query) ||
      redactCredentialText(query) !== query)) ||
    (task !== undefined &&
      (typeof task !== "string" || !/^adaptive:[a-f0-9]{64}$/.test(task))) ||
    (stepIndices !== undefined && (!task || query !== undefined ||
      !Array.isArray(stepIndices) || !stepIndices.length ||
      stepIndices.length > 30 ||
      stepIndices.some((index) =>
        !Number.isSafeInteger(index) || index < 0
      ))) ||
    (revision !== undefined &&
      (typeof revision !== "number" || !Number.isSafeInteger(revision) ||
        revision < 1)) ||
    (offset !== undefined &&
      (typeof offset !== "number" || !Number.isSafeInteger(offset) ||
        offset < 0)) ||
    (limit !== undefined &&
      (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
        limit > 30))
  ) return;
  return {
    ...(query !== undefined && { query }),
    ...(task !== undefined && { task }),
    ...(stepIndices !== undefined && { stepIndices }),
    ...(revision !== undefined && { revision }),
    ...(offset !== undefined && { offset }),
    ...(limit !== undefined && { limit }),
  };
}

type GoalReceiptReadArguments =
  & { revision?: number; offset?: number }
  & (
    | (SentinelWorkerTraceSearchArgs & { id?: never; receiptId?: never })
    | { id: string; task?: never; receiptId?: never; query?: never }
    | {
      task: string;
      revision?: number;
      offset?: number;
      id?: never;
      receiptId?: never;
      query?: never;
    }
    | {
      receiptId: string;
      revision?: number;
      id?: never;
      task?: never;
      query?: never;
    }
    | {
      query: string;
      revision?: number;
      offset?: number;
      id?: never;
      task?: never;
      receiptId?: never;
    }
  );

export function sentinelGoalReceiptReadArguments(
  tool: string,
  value: unknown,
): GoalReceiptReadArguments | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const args = value as Record<string, unknown>;
  if (tool === SENTINEL_WORKER_TRACE_SEARCH) {
    return sentinelWorkerTraceSearchArgs(args);
  }
  if (
    tool === SENTINEL_GOAL_GRAPH_FACT_READ && Object.keys(args).length === 1 &&
    typeof args.id === "string" &&
    /^worker-graph-fact:[a-f0-9]{64}$/.test(args.id)
  ) return { id: args.id };
  if (
    tool === SENTINEL_GOAL_TASK_READ &&
    Object.keys(args).every((key) =>
      ["task", "revision", "offset"].includes(key)
    ) &&
    typeof args.task === "string" &&
    /^adaptive:[a-f0-9]{64}$/.test(args.task) &&
    (args.offset === undefined || typeof args.offset === "number" &&
        Number.isSafeInteger(args.offset) && args.offset >= 0) &&
    (args.revision === undefined || typeof args.revision === "number" &&
        Number.isSafeInteger(args.revision) && args.revision > 0)
  ) {
    return {
      task: args.task,
      ...(args.revision !== undefined && { revision: args.revision }),
      ...(args.offset !== undefined && { offset: args.offset }),
    };
  }
  if (
    tool === SENTINEL_GOAL_TASK_READ &&
    Object.keys(args).every((key) =>
      ["query", "revision", "offset"].includes(key)
    ) &&
    typeof args.query === "string" &&
    /^[a-zA-Z0-9 ._-]{1,128}$/.test(args.query) &&
    redactCredentialText(args.query) === args.query &&
    (args.offset === undefined || typeof args.offset === "number" &&
        Number.isSafeInteger(args.offset) && args.offset >= 0) &&
    (args.revision === undefined || typeof args.revision === "number" &&
        Number.isSafeInteger(args.revision) && args.revision > 0)
  ) {
    return {
      query: args.query,
      ...(args.revision !== undefined && { revision: args.revision }),
      ...(args.offset !== undefined && { offset: args.offset }),
    };
  }
  if (
    tool === SENTINEL_GOAL_RECHECK_READ &&
    Object.keys(args).every((key) =>
      key === "receiptId" || key === "revision"
    ) &&
    typeof args.receiptId === "string" &&
    /^worker-recheck:[a-f0-9]{64}$/.test(args.receiptId) &&
    (args.revision === undefined || typeof args.revision === "number" &&
        Number.isSafeInteger(args.revision) && args.revision > 0)
  ) {
    return {
      receiptId: args.receiptId,
      ...(args.revision !== undefined && { revision: args.revision }),
    };
  }
}
