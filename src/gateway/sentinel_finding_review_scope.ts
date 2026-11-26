/** Exact review subject scope for an operator-recorded graph finding. */
import {
  readSentinelAssessmentRevision,
  readSentinelLatestRunRevision,
  readSentinelOperatingConstraints,
  readSentinelRunIdForRevision,
} from "../sentinel/assessment_store.ts";
import { readSentinelFindingReceiptScope } from "./sentinel_worker_findings.ts";

export function readSentinelGraphFindingReviewScope(
  path: string,
  revision: number,
  findingId: string,
) {
  const runId = readSentinelRunIdForRevision(path, revision);
  const latestRevision = runId && readSentinelLatestRunRevision(path, runId);
  if (!runId || !latestRevision) return;
  const affected = (number: number) => {
    const snapshot = readSentinelAssessmentRevision(path, number)?.result
      .sharedGraph.snapshot;
    const scope = readSentinelFindingReceiptScope(path, number);
    if (
      !snapshot || scope?.runId !== runId ||
      !snapshot.nodes.some(({ id, kind }) =>
        id === findingId && kind === "finding"
      ) ||
      !scope.allows(findingId, "review_finding")
    ) return;
    const assetIds = new Set(
      snapshot.edges.flatMap(({ from, to, relation }) =>
        from === findingId && relation === "affects" ? [to] : []
      ),
    );
    if (
      !assetIds.size ||
      ![...assetIds].every((asset) =>
        snapshot.nodes.some(({ id, kind }) =>
          id === asset && kind === "asset"
        ) &&
        scope.allows(asset)
      )
    ) return;
    return [...assetIds].sort();
  };
  const assetIds = affected(revision);
  const currentAssets = latestRevision === revision
    ? assetIds
    : affected(latestRevision);
  if (
    !assetIds || !currentAssets || assetIds.length !== currentAssets.length ||
    assetIds.some((id, index) => id !== currentAssets[index])
  ) return;
  const saved = readSentinelOperatingConstraints(path, runId, revision);
  const current = readSentinelOperatingConstraints(path, runId);
  return {
    runId,
    latestRevision,
    assetIds,
    savedDigest: saved?.digest,
    currentDigest: current?.digest,
    currentVersion: current?.version,
  };
}
