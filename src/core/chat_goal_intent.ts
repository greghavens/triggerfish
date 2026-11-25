/** Identify model requests that mutate the owner chat goal registration or decision. */
export function chatGoalMutation(
  name: string,
  args: Readonly<Record<string, unknown>>,
): "register" | "revise" | "confirm" | undefined {
  if (name === "managed_goal_state" && args.action === "confirm") {
    return "confirm";
  }
  return name === "goal_report" &&
      (args.action === "register" || args.action === "revise" ||
        args.action === "confirm")
    ? args.action
    : undefined;
}

interface ChatGoalRegistrationReview {
  readonly action: "register" | "revise";
  readonly requestId: string;
  readonly expectedRequestId?: string;
  readonly criterionCount: number;
}

export type ChatGoalApprovalReview = ChatGoalRegistrationReview | {
  readonly action: "confirm";
  readonly requestId: string;
  readonly decisionSha256: string;
} | {
  readonly action: "confirm";
  readonly role: "scheduler" | "delegated";
  readonly scope: string;
  readonly decisionSha256: string;
};

const decisionDigest = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** Validate the small review projection without retaining goal or criterion text. */
export function parseChatGoalApprovalReview(
  value: unknown,
  tool = "goal_report",
): ChatGoalApprovalReview | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const {
    action,
    requestId,
    expectedRequestId,
    criterionCount,
    decisionSha256,
    role,
    scope,
  } = value as Record<string, unknown>;
  if (tool === "managed_goal_state") {
    return action === "confirm" &&
        (role === "scheduler" || role === "delegated") &&
        typeof scope === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(scope) &&
        typeof decisionSha256 === "string" &&
        decisionDigest.test(decisionSha256) &&
        Object.keys(value).length === 4
      ? { action, role, scope, decisionSha256 }
      : undefined;
  }
  if (tool !== "goal_report") return;
  if (action === "confirm") {
    return typeof requestId === "string" &&
        (requestId === "legacy" || uuid.test(requestId)) &&
        typeof decisionSha256 === "string" &&
        decisionDigest.test(decisionSha256) &&
        Object.keys(value).length === 3
      ? { action, requestId, decisionSha256 }
      : undefined;
  }
  if (
    (action !== "register" && action !== "revise") ||
    typeof requestId !== "string" || !uuid.test(requestId) ||
    (action === "revise"
      ? typeof expectedRequestId !== "string" ||
        (expectedRequestId !== "legacy" && !uuid.test(expectedRequestId)) ||
        expectedRequestId === requestId
      : expectedRequestId !== undefined) ||
    typeof criterionCount !== "number" ||
    !Number.isSafeInteger(criterionCount) ||
    criterionCount < 1 || criterionCount > 128 ||
    Object.keys(value).length !== (expectedRequestId === undefined ? 3 : 4)
  ) return;
  return {
    action,
    requestId,
    criterionCount,
    ...(typeof expectedRequestId === "string" && { expectedRequestId }),
  };
}
