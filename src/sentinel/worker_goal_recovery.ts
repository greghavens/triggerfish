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
