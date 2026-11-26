/** Canonical, bounded repository visibility evidence for one Sentinel assignment. */
import {
  type ExecutionTraceApprovedPayload,
  isApprovedHistoryBranchName,
} from "../core/execution_traces.ts";
import { redactCredentialText } from "../core/logger/redactor.ts";
export const SENTINEL_LIVE_REPOSITORY_VISIBILITY =
  "sentinel_live_repository_visibility";
export const SENTINEL_LIVE_BRANCH_PROTECTION =
  "sentinel_live_branch_protection";
export const SENTINEL_SAVED_REPOSITORY_VISIBILITY =
  "sentinel_saved_repository_visibility";

export function isSentinelLiveRepositoryRead(tool: string) {
  return tool === SENTINEL_LIVE_REPOSITORY_VISIBILITY ||
    tool === SENTINEL_LIVE_BRANCH_PROTECTION;
}

export function nativeRepositoryVisibilityEvidenceId(taskId: string) {
  return /^adaptive:[a-f0-9]{64}$/.test(taskId)
    ? "repository-visibility:" + taskId.slice("adaptive:".length)
    : undefined;
}

export interface SentinelRepositoryVisibilityRecheckBinding {
  readonly repository: string;
  readonly repositoryId: number;
  readonly originalSha256: string;
  readonly branch?: string;
}

export function repositoryVisibilityRecheckBinding(
  value: unknown,
): SentinelRepositoryVisibilityRecheckBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { repository, repositoryId, originalSha256, branch } = value as Record<
    string,
    unknown
  >;
  if (
    Object.keys(value).length !== (branch === undefined ? 3 : 4) ||
    (branch !== undefined &&
      (!isApprovedHistoryBranchName(branch) ||
        redactCredentialText(branch) !== branch)) ||
    typeof repository !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/.test(
      repository,
    ) ||
    typeof repositoryId !== "number" || !Number.isSafeInteger(repositoryId) ||
    repositoryId < 1 ||
    typeof originalSha256 !== "string" || !/^[a-f0-9]{64}$/.test(originalSha256)
  ) return;
  return {
    repository,
    repositoryId,
    originalSha256,
    ...(branch && { branch }),
  };
}

export interface SentinelRepositoryVisibilityReference {
  readonly taskId: string;
  readonly sourceStepIndex: number;
  readonly resultSha256: string;
  readonly verdictId?: string;
}

export function repositoryVisibilityReference(
  value: unknown,
): SentinelRepositoryVisibilityReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { taskId, sourceStepIndex, resultSha256, verdictId } = value as Record<
    string,
    unknown
  >;
  if (
    Object.keys(value).length !== (verdictId === undefined ? 3 : 4) ||
    typeof taskId !== "string" || !/^adaptive:[a-f0-9]{64}$/.test(taskId) ||
    typeof sourceStepIndex !== "number" ||
    !Number.isSafeInteger(sourceStepIndex) ||
    sourceStepIndex < 0 || sourceStepIndex >= 16 ||
    typeof resultSha256 !== "string" || !/^[a-f0-9]{64}$/.test(resultSha256) ||
    (verdictId !== undefined &&
      (typeof verdictId !== "string" ||
        !/^worker-recheck:[a-f0-9]{64}$/.test(verdictId)))
  ) return;
  return {
    taskId,
    sourceStepIndex,
    resultSha256,
    ...(verdictId && { verdictId }),
  };
}

export interface SentinelRepositoryVisibilityReceipt {
  readonly repository: string;
  readonly repositoryId: number;
  readonly visibility: "public" | "internal" | "private";
  readonly observedAt: string;
  readonly evidenceRevision: number;
  readonly credentialRef: string;
  readonly branch?: string;
  readonly protected?: boolean;
}

export function repositoryVisibilityReceipt(
  value: unknown,
): SentinelRepositoryVisibilityReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const {
    repository,
    repositoryId,
    visibility,
    observedAt,
    evidenceRevision,
    credentialRef,
    branch,
    protected: enabled,
  } = value as Record<string, unknown>;
  if (
    Object.keys(value).length !== (branch === undefined ? 6 : 8) ||
    (branch === undefined
      ? enabled !== undefined
      : !isApprovedHistoryBranchName(branch) ||
        redactCredentialText(branch) !== branch ||
        typeof enabled !== "boolean") ||
    typeof repository !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/.test(
      repository,
    ) ||
    typeof repositoryId !== "number" || !Number.isSafeInteger(repositoryId) ||
    repositoryId < 1 ||
    (visibility !== "public" && visibility !== "internal" &&
      visibility !== "private") ||
    typeof observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt) ||
    !Number.isFinite(Date.parse(observedAt)) ||
    new Date(observedAt).toISOString() !== observedAt ||
    typeof evidenceRevision !== "number" ||
    !Number.isSafeInteger(evidenceRevision) || evidenceRevision < 1 ||
    typeof credentialRef !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(credentialRef)
  ) return;
  return {
    repository,
    repositoryId,
    visibility,
    observedAt,
    evidenceRevision,
    credentialRef,
    ...(typeof branch === "string" &&
      { branch, protected: enabled as boolean }),
  };
}

export function repositoryControlOutcome(
  receipt: Pick<
    SentinelRepositoryVisibilityReceipt,
    "visibility" | "branch" | "protected"
  >,
) {
  return (receipt.branch ? receipt.protected : receipt.visibility === "private")
    ? "pass" as const
    : "fail" as const;
}

export function matchesRepositoryControlSource(
  payload: ExecutionTraceApprovedPayload | undefined,
  scope: Pick<
    SentinelRepositoryVisibilityReceipt,
    "repository" | "repositoryId" | "branch"
  >,
) {
  return payload?.repo.toLowerCase() === scope.repository &&
    payload.repositoryId === scope.repositoryId &&
    (scope.branch
      ? payload.kind === "github_branch_protection" &&
        payload.approvedBranches?.some(({ name, protected: enabled }) =>
            name === scope.branch && !enabled
          ) === true
      : payload.kind === "github_repository_status" &&
        payload.visibility !== "private");
}

export function projectRepositoryVisibility(
  receipt: SentinelRepositoryVisibilityReceipt,
  taskId: string,
  targetId: string,
) {
  const { credentialRef: _, ...projection } = receipt;
  return {
    _classification: "INTERNAL" as const,
    taskId,
    targetId,
    ...projection,
  };
}
