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
export const SENTINEL_GOAL_RECHECK_READ = "sentinel_worker_findings";

export function sentinelGoalReceiptReadArguments(tool: string, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const args = value as Record<string, unknown>;
  if (
    tool === SENTINEL_GOAL_GRAPH_FACT_READ && Object.keys(args).length === 1 &&
    typeof args.id === "string" &&
    /^worker-graph-fact:[a-f0-9]{64}$/.test(args.id)
  ) return { id: args.id };
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
