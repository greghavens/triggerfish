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
