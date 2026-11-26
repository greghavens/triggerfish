/** Canonical, bounded repository visibility evidence for one Sentinel assignment. */
export const SENTINEL_LIVE_REPOSITORY_VISIBILITY =
  "sentinel_live_repository_visibility";
export const SENTINEL_SAVED_REPOSITORY_VISIBILITY =
  "sentinel_saved_repository_visibility";

export interface SentinelRepositoryVisibilityReference {
  readonly taskId: string;
  readonly sourceStepIndex: number;
  readonly resultSha256: string;
}

export function repositoryVisibilityReference(
  value: unknown,
): SentinelRepositoryVisibilityReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { taskId, sourceStepIndex, resultSha256 } = value as Record<
    string,
    unknown
  >;
  if (
    Object.keys(value).length !== 3 ||
    typeof taskId !== "string" || !/^adaptive:[a-f0-9]{64}$/.test(taskId) ||
    typeof sourceStepIndex !== "number" ||
    !Number.isSafeInteger(sourceStepIndex) ||
    sourceStepIndex < 0 || sourceStepIndex >= 16 ||
    typeof resultSha256 !== "string" || !/^[a-f0-9]{64}$/.test(resultSha256)
  ) return;
  return { taskId, sourceStepIndex, resultSha256 };
}

export interface SentinelRepositoryVisibilityReceipt {
  readonly repository: string;
  readonly repositoryId: number;
  readonly visibility: "public" | "internal" | "private";
  readonly observedAt: string;
  readonly evidenceRevision: number;
  readonly credentialRef: string;
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
  } = value as Record<string, unknown>;
  if (
    Object.keys(value).length !== 6 ||
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
  };
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
