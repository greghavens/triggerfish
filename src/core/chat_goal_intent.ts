/** Identify model requests that mutate the owner chat goal registration. */
export function chatGoalMutation(
  name: string,
  args: Readonly<Record<string, unknown>>,
): "register" | "revise" | undefined {
  return name === "goal_report" &&
      (args.action === "register" || args.action === "revise")
    ? args.action
    : undefined;
}

export interface ChatGoalApprovalReview {
  readonly action: "register" | "revise";
  readonly requestId: string;
  readonly expectedRequestId?: string;
  readonly criterionCount: number;
}

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** Validate the small review projection without retaining goal or criterion text. */
export function parseChatGoalApprovalReview(
  value: unknown,
): ChatGoalApprovalReview | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { action, requestId, expectedRequestId, criterionCount } =
    value as Record<string, unknown>;
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
