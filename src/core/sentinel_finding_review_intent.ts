import { redactCredentialText } from "./logger/redactor.ts";

export const sentinelPlannerFindingToolName = "sentinel_request_finding_review";

export function parseSentinelFindingReview(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const input = raw as Record<string, unknown>;
  const {
    requestId,
    targetId,
    graphFindingId,
    controlId,
    evidenceId,
    title,
    summary,
  } = input;
  const text = (value: unknown, limit: number): value is string =>
    typeof value === "string" && !!value && value === value.trim() &&
    value.length <= limit && !/[\p{Cc}\p{Cf}]/u.test(value) &&
    redactCredentialText(value) === value;
  if (
    Object.keys(input).length !== 7 ||
    typeof requestId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId) ||
    !text(targetId, 256) || !text(graphFindingId, 256) ||
    !text(controlId, 256) ||
    !text(evidenceId, 256) || !text(title, 160) || !text(summary, 600)
  ) return;
  return {
    requestId,
    targetId,
    graphFindingId,
    controlId,
    evidenceId,
    title,
    summary,
  };
}

export type SentinelFindingReview = NonNullable<
  ReturnType<typeof parseSentinelFindingReview>
>;
