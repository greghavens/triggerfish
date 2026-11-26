/** Exact saved inventory reads for an authorized Sentinel operator run. */
import type { OperatorRunRef } from "../core/operator_runs.ts";
import {
  canFlowTo,
  type ClassificationLevel,
} from "../core/types/classification.ts";
import { sentinelAssetTypes } from "../sentinel/asset_hierarchy.ts";
import {
  readSentinelAssessmentRevision,
  readSentinelFindingReviews,
  readSentinelInventoryCoverageForRevision,
  readSentinelOperatingConstraintsForRevision,
} from "../sentinel/assessment_store.ts";
import { verifySentinelCaseMembership } from "../sentinel/case_membership.ts";
import {
  isSentinelCaseId,
  listSentinelCaseIds,
  resolveSentinelCasePath,
} from "../sentinel/cases.ts";
import {
  parseSentinelInventoryAssetIds,
  parseSentinelInventoryText,
  querySentinelAssetInventory,
  querySentinelAssetReviewCoverage,
  querySentinelOrganizations,
  sentinelAssetCoverageGaps,
  type SentinelAssetInventoryOptions,
  validSentinelCoverageTime,
} from "../sentinel/inventory_queries.ts";
import { readHistoricalAdaptiveSentinel } from "./sentinel_adaptive_runtime.ts";

const textFilters = [
  "assetId",
  "organizationId",
  "assetType",
  "parentId",
  "alias",
  "cursor",
] as const;
const queryFields = new Set([
  "view",
  "assetIds",
  "assetText",
  "scope",
  "limit",
  "coverageGap",
  "asOf",
  ...textFilters,
]);

function optionsFor(
  args: Record<string, unknown>,
  path: string,
  revision: number,
): SentinelAssetInventoryOptions | undefined {
  const { assetType, limit = 10 } = args;
  const batch = args.assetIds !== undefined
    ? parseSentinelInventoryAssetIds(args.assetIds)
    : undefined;
  const exactType = sentinelAssetTypes.find((value) => value === assetType);
  const text = args.assetText === undefined
    ? undefined
    : parseSentinelInventoryText(args.assetText);
  if (
    Object.keys(args).some((key) => !queryFields.has(key)) ||
    textFilters.some((key) =>
      args[key] !== undefined && typeof args[key] !== "string"
    ) ||
    typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
    limit > 30 ||
    (assetType !== undefined && !exactType) ||
    (args.assetText !== undefined &&
      (!text || (args.view !== undefined && args.view !== "assets") ||
        args.assetId !== undefined || args.assetIds !== undefined)) ||
    (args.assetIds !== undefined &&
      (!batch || (args.view !== undefined && args.view !== "assets") ||
        textFilters.some((key) => key !== "cursor" && args[key] !== undefined)))
  ) return undefined;
  return {
    onlyAsset: args.assetId as string | undefined,
    ...(batch && { exactAssetIds: batch }),
    ...(text !== undefined && { assetText: text }),
    organizationId: args.organizationId as string | undefined,
    assetType: exactType,
    parentId: args.parentId as string | undefined,
    alias: args.alias as string | undefined,
    cursor: args.cursor as string | undefined,
    limit,
    scopeBinding: JSON.stringify([path, revision]),
  };
}

export function readOperatorSentinelInventory(
  baseDir: string,
  ref: OperatorRunRef,
  args: Record<string, unknown>,
  ceiling: ClassificationLevel = "INTERNAL",
) {
  const { id: caseId, revision } = ref;
  const { view = "assets", scope: readScope = "case" } = args;
  if (
    ref.kind !== "sentinel" || !canFlowTo("INTERNAL", ceiling) ||
    !isSentinelCaseId(caseId) ||
    typeof revision !== "number" || !Number.isSafeInteger(revision) ||
    revision < 1 ||
    (view !== "assets" && view !== "organizations" && view !== "coverage") ||
    (readScope !== "case" && readScope !== "membership")
  ) return undefined;
  const coverageGap = sentinelAssetCoverageGaps.find((gap) =>
    gap === args.coverageGap
  );
  if (
    (args.coverageGap !== undefined && (view !== "coverage" || !coverageGap)) ||
    !validSentinelCoverageTime(coverageGap, args.asOf)
  ) {
    return undefined;
  }
  try {
    if (caseId !== "main" && !listSentinelCaseIds(baseDir).includes(caseId)) {
      return undefined;
    }
    const path = resolveSentinelCasePath(baseDir, caseId);
    const file = Deno.lstatSync(path);
    if (!file.isFile || file.isSymlink || (file.nlink ?? 1) !== 1) {
      return undefined;
    }
    let options = optionsFor(args, path, revision);
    if (!options) return undefined;
    const saved = readSentinelAssessmentRevision(path, revision);
    const snapshot = saved?.result.sharedGraph.snapshot;
    if (!snapshot) return undefined;
    let membership;
    if (readScope === "membership") {
      const record = readSentinelOperatingConstraintsForRevision(
        path,
        revision,
      );
      const proof = record?.membership;
      const allowed = record?.constraints.allowedAssetIds;
      const source = proof?.evidenceRevision === revision
        ? snapshot
        : proof
        ? readSentinelAssessmentRevision(path, proof.evidenceRevision)?.result
          .sharedGraph.snapshot
        : undefined;
      if (
        !record || !proof || !allowed || !source ||
        proof.evidenceRevision !== record.evidenceRevision ||
        proof.evidenceRevision > revision ||
        !verifySentinelCaseMembership(source, proof, {
          caseId,
          evidenceRevision: proof.evidenceRevision,
        }) ||
        JSON.stringify(allowed) !== JSON.stringify(proof.assetIds)
      ) return undefined;
      membership = {
        runId: record.runId,
        version: record.version,
        digest: record.digest,
        sourceEvidenceRevision: proof.evidenceRevision,
        sourceSnapshotDigest: proof.snapshotDigest,
      };
      options = {
        ...options,
        scopeBinding: JSON.stringify([path, revision, membership]),
        allowedAssetIds: proof.assetIds,
      };
    }
    const scope = {
      caseId,
      evidenceRevision: revision,
      scope: readScope,
      ...(membership && { membership }),
      _classification: "INTERNAL" as const,
    };
    if (view === "assets") {
      return {
        ...scope,
        view: "assets" as const,
        ...querySentinelAssetInventory(snapshot, options),
      };
    }
    if (view === "organizations") {
      return {
        ...scope,
        view: "organizations" as const,
        ...querySentinelOrganizations(snapshot, options),
      };
    }
    if (readSentinelInventoryCoverageForRevision(path, revision) === false) {
      return { ...scope, view: "coverage" as const, enabled: false as const };
    }
    const adaptive = readHistoricalAdaptiveSentinel(path, revision);
    const completed = new Set(
      adaptive?.modelReviews.map(({ taskId }) => taskId),
    );
    const reviewed = (adaptive?.tasks ?? []).filter((task) =>
      task.status === "completed" && task.nodeId !== undefined &&
      completed.has(task.id)
    );
    const assets = new Set(
      snapshot.nodes.flatMap(({ id, kind }) => kind === "asset" ? [id] : []),
    );
    return {
      ...scope,
      view: "coverage" as const,
      ...querySentinelAssetReviewCoverage(
        snapshot,
        readSentinelFindingReviews(path, revision),
        {
          ...options,
          evidenceRevision: revision,
          coverageGap,
          asOf: args.asOf as string | undefined,
          reviewedAssetIds: reviewed.flatMap(({ nodeId }) =>
            nodeId && assets.has(nodeId) ? [nodeId] : []
          ),
          evidenceReviewTasks: reviewed.flatMap(({ kind, nodeId, id }) =>
            kind === "review_evidence" && nodeId
              ? [{ evidenceId: nodeId, taskId: id }]
              : []
          ),
        },
      ),
    };
  } catch {
    return undefined;
  }
}
