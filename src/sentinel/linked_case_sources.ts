/** Reviewed case revisions that may supply already-approved shared receipts. */
import { isSentinelCaseId } from "./cases.ts";

export interface SentinelLinkedWorkerReview {
  readonly taskId: string;
  readonly assetId: string;
  readonly summarySha256: string;
}

export interface SentinelLinkedCaseSource {
  readonly caseId: string;
  readonly revision: number;
  readonly runId: string;
  readonly workerReviews?: readonly SentinelLinkedWorkerReview[];
}

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function parseSentinelLinkedCaseSources(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return;
  const sources: SentinelLinkedCaseSource[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const { caseId, revision, runId, workerReviews } = entry;
    if (
      Object.keys(entry).length !== (workerReviews === undefined ? 3 : 4) ||
      typeof caseId !== "string" ||
      !isSentinelCaseId(caseId) || seen.has(caseId) ||
      typeof revision !== "number" || !Number.isSafeInteger(revision) ||
      revision < 1 || typeof runId !== "string" || !uuid.test(runId)
    ) return;
    const normalized: SentinelLinkedWorkerReview[] = [];
    if (workerReviews !== undefined) {
      if (
        !Array.isArray(workerReviews) || workerReviews.length < 1 ||
        workerReviews.length > 4
      ) return;
      for (const pin of workerReviews) {
        if (!pin || typeof pin !== "object" || Array.isArray(pin)) return;
        const { taskId, assetId, summarySha256 } = pin;
        if (
          Object.keys(pin).length !== 3 ||
          typeof taskId !== "string" ||
          !/^adaptive:[a-f0-9]{64}$/.test(taskId) ||
          typeof assetId !== "string" || !assetId || assetId.length > 256 ||
          typeof summarySha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(summarySha256) ||
          normalized.some((value) => value.taskId === taskId)
        ) return;
        normalized.push({ taskId, assetId, summarySha256 });
      }
    }
    seen.add(caseId);
    sources.push({
      caseId,
      revision,
      runId,
      ...(normalized.length &&
        {
          workerReviews: normalized.sort((a, b) =>
            a.taskId.localeCompare(b.taskId)
          ),
        }),
    });
  }
  return sources.sort((left, right) => left.caseId.localeCompare(right.caseId));
}

export interface SentinelPeerWorkerReviewReference {
  readonly sourceCase: string;
  readonly sourceRunId: string;
  readonly sourceRevision: number;
  readonly sourceTaskId: string;
  readonly sourceAssetId: string;
  readonly asset: string;
  readonly summarySha256: string;
}

export function parseSentinelPeerWorkerReview(
  value: unknown,
): SentinelPeerWorkerReviewReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const {
    sourceCase,
    sourceRunId,
    sourceRevision,
    sourceTaskId,
    sourceAssetId,
    asset,
    summarySha256,
  } = value as Record<string, unknown>;
  if (
    Object.keys(value).length !== 7 || typeof sourceCase !== "string" ||
    !isSentinelCaseId(sourceCase) || typeof sourceRunId !== "string" ||
    !uuid.test(sourceRunId) ||
    typeof sourceRevision !== "number" ||
    !Number.isSafeInteger(sourceRevision) || sourceRevision < 1 ||
    typeof sourceTaskId !== "string" ||
    !/^adaptive:[a-f0-9]{64}$/.test(sourceTaskId) ||
    typeof sourceAssetId !== "string" || !sourceAssetId ||
    sourceAssetId.length > 256 ||
    typeof asset !== "string" || !asset || asset.length > 256 ||
    typeof summarySha256 !== "string" || !/^[a-f0-9]{64}$/.test(summarySha256)
  ) return;
  return {
    sourceCase,
    sourceRunId,
    sourceRevision,
    sourceTaskId,
    sourceAssetId,
    asset,
    summarySha256,
  };
}
