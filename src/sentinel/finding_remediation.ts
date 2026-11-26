/** Project a retained control-check verdict independently of analyst disposition. */
import { repositoryControlOutcome } from "./github_repository_visibility.ts";
import { dirname, join } from "@std/path";
import { isDeepStrictEqual } from "node:util";
import {
  readAdaptiveRepositoryVisibility,
  readSentinelDedicatedRecheckSettlements,
} from "./adaptive_store.ts";
import {
  readSentinelAssessmentRevision,
  readSentinelOperatingConstraintsForRevision,
  readSentinelRunIdForRevision,
} from "./assessment_store.ts";
import { locateSentinelCase } from "./cases.ts";
import { sentinelOperatingConstraintsAllow } from "./operating_constraints.ts";
import {
  verifyWorkerFindingRecheck,
  withRepositoryVisibilityVerification,
} from "./worker_finding_evidence.ts";
import { digestSentinelSnapshot } from "./shared_inventory.ts";
import type {
  SentinelWorkerFindingRecheckRecord,
  SentinelWorkerFindingRecord,
} from "./worker_finding_store.ts";

export function createSentinelFindingRemediationReader(
  path: string,
  caseId: string,
  revision: number,
  runId: string | undefined,
  exactNativeRead = false,
) {
  const unknown = { status: "unknown", asOfRevision: revision } as const;
  type Revision = ReturnType<typeof readSentinelAssessmentRevision>;
  const cache = new Map<number, Revision>();
  function read(number: number) {
    if (!cache.has(number)) {
      cache.set(
        number,
        readSentinelRunIdForRevision(path, number) === runId
          ? readSentinelAssessmentRevision(path, number)
          : undefined,
      );
    }
    return cache.get(number);
  }
  const settlements = new Map<
    number,
    ReturnType<typeof readSentinelDedicatedRecheckSettlements>
  >();
  const settled = (receipt: SentinelWorkerFindingRecheckRecord) => {
    const number = receipt.evidenceRevision;
    if (!settlements.has(number)) {
      settlements.set(
        number,
        readSentinelDedicatedRecheckSettlements(
          join(dirname(path), "sentinel-adaptive.db"),
          receipt.runId,
          number,
        ),
      );
    }
    const assignment = settlements.get(number)?.get(receipt.taskId);
    return !assignment || (assignment.completed &&
      assignment.findingId === receipt.findingId &&
      assignment.evidenceId === receipt.evidenceId);
  };
  const scoped = runId && locateSentinelCase(path)?.caseId === caseId;
  const constraints = scoped
    ? readSentinelOperatingConstraintsForRevision(path, revision)?.constraints
    : undefined;
  return (
    original: SentinelWorkerFindingRecord,
    rechecks: readonly SentinelWorkerFindingRecheckRecord[],
  ) => {
    if (
      !scoped || !runId || original.caseId !== caseId ||
      original.runId !== runId ||
      original.evidenceRevision > revision
    ) return { value: unknown };
    const latest =
      rechecks.filter((receipt) =>
        receipt.findingId === original.id && receipt.caseId === caseId &&
        receipt.runId === runId && receipt.targetId === original.targetId &&
        receipt.graphFindingId === original.graphFindingId &&
        receipt.controlId === original.controlId &&
        receipt.evidenceRevision >= original.evidenceRevision &&
        receipt.evidenceRevision <= revision && settled(receipt)
      ).toSorted((a, b) =>
        b.observedAt.localeCompare(a.observedAt) ||
        b.evidenceRevision - a.evidenceRevision ||
        b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id)
      )[0];
    if (!latest) return { value: unknown };
    if (latest.nativeRepositoryVisibility && !exactNativeRead) {
      return { value: unknown };
    }
    const selected = read(revision);
    const snapshot = selected?.result.sharedGraph.snapshot;
    const origin = read(latest.evidenceRevision)?.result.sharedGraph.snapshot;
    if (
      !snapshot || !origin ||
      !sentinelOperatingConstraintsAllow(
        constraints,
        { kind: "review_evidence", nodeId: original.targetId },
        snapshot,
      )
    ) return { value: unknown };
    const claim = {
      findingId: original.graphFindingId,
      assetId: original.targetId,
      controlId: original.controlId,
      evidenceId: latest.evidenceId,
    };
    // A verifier already authorized and committed this branch-specific receipt.
    // Recheck the exact evidence and graph lineage, independent of other branches.
    const exact = ({ id }: { id: string }) => id === latest.evidenceId;
    const initialGraph = read(original.evidenceRevision)?.result.sharedGraph
      .snapshot;
    if (!initialGraph) return { value: unknown };
    const initial = verifyWorkerFindingRecheck(
      initialGraph,
      {
        caseId,
        evidenceRevision: original.evidenceRevision,
        evaluatedAt: original.evaluatedAt,
      },
      { ...claim, evidenceId: original.evidenceId },
      ({ id }) => id === original.evidenceId,
    );
    if (
      initial?.outcome !== "fail" ||
      initial.snapshotDigest !== original.snapshotDigest ||
      initial.observedAt !== original.observedAt ||
      initial.validUntil !== original.validUntil
    ) {
      return { value: unknown };
    }
    const native = latest.nativeRepositoryVisibility;
    const observation = native && readAdaptiveRepositoryVisibility(
      join(dirname(path), "sentinel-adaptive.db"),
      runId,
      latest.evidenceRevision,
      latest.taskId,
      latest.targetId,
      true,
    );
    if (
      native &&
      (!observation || !isDeepStrictEqual(observation.reference, native) ||
        observation.receipt.observedAt !== latest.observedAt ||
        repositoryControlOutcome(observation.receipt) !== latest.outcome ||
        latest.observedAt <= original.observedAt ||
        Date.parse(latest.validUntil) - Date.parse(latest.observedAt) !==
          Date.parse(original.validUntil) - Date.parse(original.observedAt))
    ) {
      return { value: unknown };
    }
    const projected = (graph: typeof origin) =>
      native
        ? withRepositoryVisibilityVerification(
          graph,
          latest.evidenceId,
          latest.targetId,
          latest.controlId,
          {
            outcome: latest.outcome,
            observedAt: latest.observedAt,
            validUntil: latest.validUntil,
          },
        )
        : graph;
    const selectedTime = selected.result.controlEvaluationAt ??
      selected.updatedAt;
    const captured = verifyWorkerFindingRecheck(
      projected(origin),
      {
        caseId,
        evidenceRevision: latest.evidenceRevision,
        evaluatedAt: latest.evaluatedAt,
      },
      claim,
      exact,
    );
    const visible = verifyWorkerFindingRecheck(
      projected(snapshot),
      {
        caseId,
        evidenceRevision: revision,
        evaluatedAt: native && latest.evaluatedAt > selectedTime
          ? latest.evaluatedAt
          : selectedTime,
      },
      claim,
      exact,
    );
    if (
      !captured ||
      (native ? digestSentinelSnapshot(origin) : captured.snapshotDigest) !==
        latest.snapshotDigest ||
      captured.outcome !== latest.outcome ||
      captured.observedAt !== latest.observedAt ||
      captured.validUntil !== latest.validUntil ||
      visible?.outcome !== latest.outcome ||
      visible.observedAt !== latest.observedAt ||
      visible.validUntil !== latest.validUntil
    ) return { value: unknown };
    const sources = [
      {
        revision: original.evidenceRevision,
        evidenceId: original.evidenceId,
        outcome: "fail" as const,
        snapshot: initialGraph,
      },
      {
        revision: latest.evidenceRevision,
        evidenceId: latest.evidenceId,
        outcome: latest.outcome,
        snapshot: origin,
      },
    ].flatMap(({ snapshot, ...source }) => {
      const node = snapshot.nodes.find(({ id }) => id === source.evidenceId);
      return node?.kind === "evidence" &&
          (node.executionSource || node.nativeWorkflowSource)
        ? [{ ...source, node }]
        : [];
    });
    return {
      value: {
        status: latest.outcome,
        asOfRevision: revision,
        recheckId: latest.id,
        evidenceRevision: latest.evidenceRevision,
        evidenceId: latest.evidenceId,
        observedAt: latest.observedAt,
        validUntil: latest.validUntil,
      },
      sources,
      nativeSource: native ? latest : undefined,
    };
  };
}
