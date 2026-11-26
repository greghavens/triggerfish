/** Reauthorize exact published peer coverage without granting a new source. */
import { isDeepStrictEqual } from "node:util";
import {
  readSentinelAssessmentRevision,
  readSentinelLinkedSourcesForRevision,
  readSentinelOperatingConstraints,
  readSentinelRunIdForRevision,
} from "../sentinel/assessment_store.ts";
import {
  locateSentinelCase,
  resolveSentinelCasePath,
} from "../sentinel/cases.ts";
import { sentinelOperatingConstraintsAllow } from "../sentinel/operating_constraints.ts";
import {
  readSentinelPeerCoverageReceipt,
  type SentinelPeerCoverageReceipt,
} from "../sentinel/peer_coverage.ts";
import {
  readPinnedSentinelSharedFindingSource,
} from "../sentinel/shared_inventory.ts";
import { readLinkedFindingProof } from "./sentinel_linked_findings.ts";

export async function reopenSentinelPeerCoverage(
  path: string,
  revision: number,
  selector: SentinelPeerCoverageReceipt["selector"],
  expected?: SentinelPeerCoverageReceipt,
) {
  const location = locateSentinelCase(path);
  const runId = readSentinelRunIdForRevision(path, revision);
  const selected = readSentinelLinkedSourcesForRevision(path, revision);
  const graph = readSentinelAssessmentRevision(path, revision)?.result
    .sharedGraph.snapshot;
  if (
    !location || !runId || !selected || !graph ||
    selector.sourceCase === location.caseId
  ) return;
  const localAllows = () => {
    const current = readSentinelOperatingConstraints(path, runId);
    return current?.membership &&
      current.constraints.allowedAssetIds?.includes(selector.asset) &&
      sentinelOperatingConstraintsAllow(
        current.constraints,
        { kind: "review_evidence", nodeId: selector.asset },
        graph,
      );
  };
  if (!localAllows()) return;
  const {
    sourceCase: caseId,
    sourceAsset: assetId,
    finding: findingId,
    snapshotDigest,
  } = selector;
  const currentProof = () =>
    readLinkedFindingProof(
      location.baseDir,
      selected,
      caseId,
      assetId,
      findingId,
    );
  const proof = currentProof();
  const source = proof?.publication.finding.workerFindingSource;
  if (!proof || !source || proof.execution) return;
  const originPath = resolveSentinelCasePath(location.baseDir, caseId);
  const origin = readSentinelAssessmentRevision(originPath, source.revision)
    ?.result.sharedGraph.snapshot;
  const sourceAllows = () =>
    sentinelOperatingConstraintsAllow(
      readSentinelOperatingConstraints(originPath, source.runId)?.constraints,
      { kind: "review_evidence", nodeId: assetId },
      origin,
    );
  if (!origin || !sourceAllows()) return;
  try {
    if (
      !await readPinnedSentinelSharedFindingSource(
        location.baseDir,
        graph,
        {
          caseId,
          assetId,
          findingId,
          snapshotDigest,
          localAssetId: selector.asset,
        },
        location.caseId,
        path,
      )
    ) return;
    const receipt = readSentinelPeerCoverageReceipt({
      selector,
      source,
    });
    if (
      receipt && localAllows() && sourceAllows() &&
      isDeepStrictEqual(currentProof(), proof) &&
      (!expected || isDeepStrictEqual(expected, receipt))
    ) return receipt;
  } catch {
    return;
  }
}
