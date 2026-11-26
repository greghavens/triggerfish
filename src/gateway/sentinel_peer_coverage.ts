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
  digestSentinelSnapshot,
  indexArchivedSentinelAssetSource,
  readPinnedSentinelSharedFindingSource,
  retainSentinelSourceSnapshot,
} from "../sentinel/shared_inventory.ts";
import {
  applySentinelWorkerFindingPublications,
  readSentinelWorkerFindingPublications,
} from "../sentinel/worker_finding_publications.ts";
import { withSentinelSourceSnapshotLock } from "../sentinel/source_snapshot_lock.ts";
import { readLinkedFindingProof } from "./sentinel_linked_findings.ts";

export async function reopenSentinelSelectedFinding(
  path: string,
  revision: number,
  selector: SentinelPeerCoverageReceipt["selector"],
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
  if (!proof || !source) return;
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
  const isCurrent = () =>
    readSentinelRunIdForRevision(path, revision) === runId &&
    isDeepStrictEqual(
      readSentinelAssessmentRevision(path, revision)?.result.sharedGraph
        .snapshot,
      graph,
    ) &&
    isDeepStrictEqual(
      readSentinelLinkedSourcesForRevision(path, revision),
      selected,
    ) &&
    !!localAllows() && sourceAllows() &&
    isDeepStrictEqual(currentProof(), proof);
  try {
    const retained = await readPinnedSentinelSharedFindingSource(
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
    );
    if (
      retained && isCurrent()
    ) return { graph: retained, source, execution: proof.execution, isCurrent };
  } catch {
    return;
  }
}

/** Build exact selectors from one reviewed source. Unmatched assets reveal no findings. */
export function listSentinelSelectedFindingCandidates(
  path: string,
  revision: number,
  sourceCase: string,
  asset: string,
  query: string,
) {
  const location = locateSentinelCase(path);
  const selected = readSentinelLinkedSourcesForRevision(path, revision)
    ?.find(({ caseId }) => caseId === sourceCase);
  const local = readSentinelAssessmentRevision(path, revision)?.result
    .sharedGraph.snapshot;
  const runId = readSentinelRunIdForRevision(path, revision);
  const scope = runId && readSentinelOperatingConstraints(path, runId);
  if (
    !location || !selected || !local || !scope || !scope.membership ||
    !scope.constraints.allowedAssetIds?.includes(asset) ||
    !sentinelOperatingConstraintsAllow(scope.constraints, {
      kind: "review_evidence",
      nodeId: asset,
    }, local)
  ) return;
  const sourcePath = resolveSentinelCasePath(location.baseDir, sourceCase);
  if (
    readSentinelRunIdForRevision(sourcePath, selected.revision) !==
      selected.runId
  ) return;
  const source = readSentinelAssessmentRevision(sourcePath, selected.revision)
    ?.result.sharedGraph.snapshot;
  if (!source) return;
  const matching = readSentinelWorkerFindingPublications(sourcePath, sourceCase)
    .filter(({ finding, targetId, withdrawal }) =>
      !withdrawal &&
      finding.workerFindingSource?.revision === selected.revision &&
      finding.workerFindingSource.runId === selected.runId &&
      (!query || finding.label.toLocaleLowerCase().includes(query)) &&
      !!indexArchivedSentinelAssetSource(local, source, asset, targetId)
    );
  // Bound permission checks even when an approved source has many publications.
  if (matching.length > 12) return;
  const current = () =>
    readSentinelRunIdForRevision(path, revision) === runId &&
    isDeepStrictEqual(
      readSentinelAssessmentRevision(path, revision)?.result.sharedGraph
        .snapshot,
      local,
    ) &&
    isDeepStrictEqual(readSentinelOperatingConstraints(path, runId), scope) &&
    isDeepStrictEqual(
      readSentinelLinkedSourcesForRevision(path, revision)
        ?.find(({ caseId }) => caseId === sourceCase),
      selected,
    );
  return {
    selected,
    current,
    candidates: matching.toSorted((a, b) =>
      a.finding.id.localeCompare(b.finding.id)
    ),
    async retain(visible: ReadonlySet<string>, permitted: () => boolean) {
      const graph = applySentinelWorkerFindingPublications(
        source,
        matching.filter(({ finding }) => visible.has(finding.id)),
      );
      const digest = digestSentinelSnapshot(graph);
      if (
        visible.size && !await withSentinelSourceSnapshotLock(
          location.baseDir,
          true,
          async () => {
            if (!permitted()) return false;
            await retainSentinelSourceSnapshot(
              location.baseDir,
              sourceCase,
              digest,
              graph,
            );
            return permitted();
          },
        )
      ) return;
      return digest;
    },
  };
}

type LinkedFindingExecution = NonNullable<
  NonNullable<ReturnType<typeof readLinkedFindingProof>>["execution"]
>;

export async function reopenSentinelPeerCoverage(
  path: string,
  revision: number,
  selector: SentinelPeerCoverageReceipt["selector"],
  expected?: SentinelPeerCoverageReceipt,
  authorizeExecution?: (
    source: LinkedFindingExecution,
    current: () => boolean,
  ) => Promise<boolean>,
) {
  const exact = await reopenSentinelSelectedFinding(path, revision, selector);
  if (!exact) return;
  const receipt = readSentinelPeerCoverageReceipt({
    selector,
    source: exact.source,
  });
  if (!receipt || (expected && !isDeepStrictEqual(expected, receipt))) return;
  if (
    exact.execution && (!authorizeExecution ||
      !await authorizeExecution(exact.execution, exact.isCurrent) ||
      !exact.isCurrent())
  ) return;
  return receipt;
}
