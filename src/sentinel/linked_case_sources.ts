/** Reviewed case revisions that may supply already-approved shared receipts. */
import { isSentinelCaseId } from "./cases.ts";

export interface SentinelLinkedCaseSource {
  readonly caseId: string;
  readonly revision: number;
  readonly runId: string;
}

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function parseSentinelLinkedCaseSources(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return;
  const sources: SentinelLinkedCaseSource[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const { caseId, revision, runId } = entry;
    if (
      Object.keys(entry).length !== 3 || typeof caseId !== "string" ||
      !isSentinelCaseId(caseId) || seen.has(caseId) ||
      typeof revision !== "number" || !Number.isSafeInteger(revision) ||
      revision < 1 || typeof runId !== "string" || !uuid.test(runId)
    ) return;
    seen.add(caseId);
    sources.push({ caseId, revision, runId });
  }
  return sources.sort((left, right) => left.caseId.localeCompare(right.caseId));
}
