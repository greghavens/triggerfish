/** Root-dispatched, case-scoped asset and review coverage queries. */
import type { ToolDefinition } from "../core/types/tool.ts";
import {
  readSentinelAssessment,
  readSentinelAssessmentRevision,
  readSentinelDecisions,
  readSentinelFindingReviews,
  readSentinelInventoryCoverageForRevision,
  sentinelFindingDispositions,
} from "../sentinel/assessment_store.ts";
import { readSentinelChatSnapshot } from "../sentinel/chat_mode.ts";
import { loadSentinelGraph } from "../sentinel/graph.ts";
import {
  parseSentinelInventoryAssetIds,
  querySentinelAssetInventory,
  querySentinelAssetReviewCoverage,
  querySentinelOrganizations,
  readSentinelPlannerCoverageResult,
  sentinelAssetCoverageGaps,
  type SentinelAssetInventoryOptions,
  validSentinelCoverageTime,
} from "../sentinel/inventory_queries.ts";
import { digestSentinelSnapshot } from "../sentinel/shared_inventory.ts";
import type { SentinelPeerCoverageReceipt } from "../sentinel/peer_coverage.ts";
import { locateSentinelCase } from "../sentinel/cases.ts";
import type { SentinelAgentOptions } from "./sentinel_agent.ts";
import {
  readAdaptiveSentinel,
  readAssignedSentinelModelReview,
} from "./sentinel_adaptive_runtime.ts";

import {
  SENTINEL_CASE_INVENTORY_READ,
  sentinelCheckpointInventoryArgs,
} from "../sentinel/worker_goal_recovery.ts";

type InventoryScope = Pick<
  SentinelAgentOptions,
  | "snapshotPath"
  | "assessmentRevision"
  | "snapshotOverride"
  | "assignedTaskId"
  | "assignedTaskLeaseToken"
  | "plannerExecutionEvidenceRunId"
>;

export const sentinelInventoryTool: ToolDefinition = {
  name: SENTINEL_CASE_INVENTORY_READ,
  description:
    "Page through the selected case's assets, declared organizations, or exact saved review and evidence coverage. Leased workers can query only their assigned asset.",
  parameters: {
    view: {
      type: "string",
      description: "Inventory result type",
      enum: ["assets", "organizations", "coverage"],
      required: true,
    },
    assetId: { type: "string", description: "Exact asset ID" },
    assetIds: {
      type: "array",
      items: { type: "string" },
      description:
        "Up to twenty exact asset IDs for the asset view. Omit other asset filters. A leased worker may name only its assigned asset.",
    },
    organizationId: { type: "string", description: "Exact organization ID" },
    assetType: { type: "string", description: "Exact typed asset property" },
    parentId: { type: "string", description: "Exact parent asset ID" },
    alias: { type: "string", description: "Exact asset alias" },
    coverageGap: {
      type: "string",
      enum: sentinelAssetCoverageGaps,
      description:
        "For coverage only, filter assets missing a saved worker review, linked evidence, or either.",
    },
    asOf: {
      type: "string",
      description:
        "UTC instant for missing_current_verification, with milliseconds",
    },
    cursor: {
      type: "string",
      description: "Opaque cursor from the same case, revision and filters",
    },
    limit: { type: "integer", description: "Page size from 1 to 10" },
  },
};

export function sentinelInventoryToolForScope(
  options: InventoryScope,
): ToolDefinition {
  if (
    readSentinelInventoryCoverageForRevision(
      options.snapshotPath,
      options.assessmentRevision,
    ) !== false
  ) {
    return options.plannerExecutionEvidenceRunId
      ? {
        ...sentinelInventoryTool,
        parameters: {
          ...sentinelInventoryTool.parameters,
          linkedFinding: {
            type: "object",
            description:
              "Exact authorized peer finding returned earlier for this local member. Only for evidence coverage. Supply asset, sourceCase, sourceAsset, finding and snapshotDigest.",
          },
        },
      }
      : sentinelInventoryTool;
  }
  const { coverageGap: _gap, asOf: _asOf, ...parameters } =
    sentinelInventoryTool.parameters;
  return {
    ...sentinelInventoryTool,
    description:
      "Page through the selected case's assets or declared organizations. Leased workers can query only their assigned asset.",
    parameters: {
      ...parameters,
      view: {
        ...sentinelInventoryTool.parameters.view,
        enum: ["assets", "organizations"],
      },
    },
  };
}

const filters = [
  "assetId",
  "organizationId",
  "assetType",
  "parentId",
  "alias",
] as const;

function queryOptions(
  args: Record<string, unknown>,
  assignedAsset: string | undefined,
) {
  const limit = args.limit ?? 5;
  const cursor = args.cursor;
  const batch = args.assetIds !== undefined
    ? parseSentinelInventoryAssetIds(args.assetIds)
    : undefined;
  if (
    Object.keys(args).some((key) =>
      ![
        "view",
        "cursor",
        "limit",
        "coverageGap",
        "asOf",
        "assetIds",
        ...filters,
      ].includes(
        key,
      )
    ) ||
    typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
    limit > 10 || cursor !== undefined &&
      (typeof cursor !== "string" || !cursor.length || cursor.length > 1800) ||
    filters.some((key) =>
      args[key] !== undefined && (typeof args[key] !== "string" ||
        args[key].length === 0 || args[key].length > 800)
    ) ||
    (args.assetIds !== undefined &&
      (!batch || args.view !== "assets" ||
        filters.some((key) => args[key] !== undefined) ||
        (assignedAsset !== undefined &&
          (batch.length !== 1 || batch[0] !== assignedAsset)))) ||
    assignedAsset && args.assetId !== undefined &&
      args.assetId !== assignedAsset
  ) throw new Error("Invalid or out-of-scope inventory query.");
  return {
    onlyAsset: batch ? undefined : assignedAsset ?? args.assetId,
    ...(batch && { exactAssetIds: batch }),
    organizationId: args.organizationId,
    assetType: args.assetType,
    parentId: args.parentId,
    alias: args.alias,
    cursor,
    limit,
  } as SentinelAssetInventoryOptions;
}

function leasedAsset(options: InventoryScope) {
  const {
    assessmentRevision,
    assignedTaskId,
    assignedTaskLeaseToken,
    snapshotPath,
  } = options;
  if (
    assessmentRevision === undefined || !assignedTaskId ||
    !assignedTaskLeaseToken
  ) {
    return undefined;
  }
  return readAssignedSentinelModelReview(
    snapshotPath,
    assessmentRevision,
    assignedTaskId,
    assignedTaskLeaseToken,
  )?.nodeId;
}

function reviewedAssets(
  options: InventoryScope,
  state: NonNullable<ReturnType<typeof readSentinelAssessment>>,
) {
  const adaptive = readAdaptiveSentinel(
    options.snapshotPath,
    state,
    "revision",
  );
  const completed = new Set(adaptive?.modelReviews.map(({ taskId }) => taskId));
  return (adaptive?.tasks ?? []).flatMap(({ id, nodeId }) =>
    nodeId && completed.has(id) ? [nodeId] : []
  );
}

/** Rebuild only inventory projections that depend exclusively on pinned evidence. */
export function reopenSentinelAssignedInventory(
  path: string,
  revision: number,
  assignmentId: string,
  assetId: string,
  args: Record<string, unknown>,
) {
  const selector = sentinelCheckpointInventoryArgs(args);
  if (!selector || selector.view === "coverage") return;
  const state = readSentinelAssessmentRevision(path, revision);
  const snapshot = state?.result?.sharedGraph.snapshot;
  const caseId = locateSentinelCase(path)?.caseId;
  if (
    !snapshot || !caseId ||
    !snapshot.nodes.some(({ id, kind }) => id === assetId && kind === "asset")
  ) return;
  let query: SentinelAssetInventoryOptions;
  try {
    query = queryOptions(selector, assetId);
  } catch {
    return;
  }
  const page = {
    ...query,
    scopeBinding: JSON.stringify([path, revision, assignmentId]),
  };
  const result = selector.view === "organizations"
    ? querySentinelOrganizations(snapshot, page)
    : querySentinelAssetInventory(snapshot, page);
  const output = JSON.stringify({
    ...result,
    caseId,
    evidenceRevision: revision,
    _classification: "INTERNAL",
  });
  if (output.length <= 6000) return output;
}

/** Verify the retained single-asset page against its exact historical decisions. */
export function validateSavedAssignedCoverage(
  path: string,
  revision: number,
  assignmentId: string,
  assetId: string,
  args: Record<string, unknown>,
  saved: string,
) {
  const selector = sentinelCheckpointInventoryArgs(args);
  if (
    selector?.view !== "coverage" ||
    readSentinelInventoryCoverageForRevision(path, revision) === false
  ) return false;
  const snapshot = readSentinelAssessmentRevision(path, revision)?.result
    .sharedGraph.snapshot;
  const caseId = locateSentinelCase(path)?.caseId;
  if (
    !snapshot || !caseId ||
    !snapshot.nodes.some(({ id, kind }) => kind === "asset" && id === assetId)
  ) return false;
  const parsed = readSentinelPlannerCoverageResult(selector, saved, {
    caseId,
    evidenceRevision: revision,
    snapshotDigest: digestSentinelSnapshot(snapshot),
  });
  if (!parsed || parsed.assetIds.some((id) => id !== assetId)) return false;
  try {
    const page = JSON.parse(saved);
    if (page.nextCursor !== null || page.assets.length > 1) return false;
    const row = page.assets[0];
    const reviewIds = new Set<number>(
      (row?.findings ?? []).flatMap((
        { review }: { review?: { id?: number } },
      ) => Number.isSafeInteger(review?.id) ? [review!.id!] : []),
    );
    const reviews = readSentinelDecisions(path, "finding", [...reviewIds])
      .flatMap(
        (
          {
            id,
            revision: sourceRevision,
            subjectId,
            disposition,
            note,
            at,
            retained,
          },
        ) => {
          const status = sentinelFindingDispositions.find((candidate) =>
            candidate === disposition
          );
          return retained && sourceRevision === revision && status
            ? [{
              id,
              revision,
              findingId: subjectId,
              disposition: status,
              note,
              at,
            }]
            : [];
        },
      );
    if (reviews.length !== reviewIds.size) return false;
    // The returned review flag is part of the original post-policy digest.
    // Empty filter results carry no flag; one of the two projections must match.
    return (row ? [row.reviewed] : [false, true]).some((reviewed) => {
      const result = querySentinelAssetReviewCoverage(snapshot, reviews, {
        ...queryOptions(selector, assetId),
        scopeBinding: JSON.stringify([path, revision, assignmentId]),
        evidenceRevision: revision,
        coverageGap: selector.coverageGap,
        asOf: selector.asOf,
        reviewedAssetIds: reviewed ? [assetId] : [],
      });
      return JSON.stringify({
        ...result,
        caseId,
        evidenceRevision: revision,
        _classification: "INTERNAL",
      }) === saved;
    });
  } catch {
    return false;
  }
}

export async function executeSentinelInventoryTool(
  options: InventoryScope,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  allowedAssetIds?: readonly string[],
  peerCoverage?: SentinelPeerCoverageReceipt,
): Promise<string> {
  try {
    const { view } = args;
    if (view !== "assets" && view !== "organizations" && view !== "coverage") {
      return "Error: Choose assets, organizations, or coverage.";
    }
    const coverageGap = sentinelAssetCoverageGaps.find((gap) =>
      gap === args.coverageGap
    );
    if (
      (args.coverageGap !== undefined &&
        (view !== "coverage" || !coverageGap)) ||
      !validSentinelCoverageTime(coverageGap, args.asOf)
    ) {
      return "Error: Select a supported gap filter for coverage.";
    }
    const path = options.snapshotPath;
    const assigned = options.assignedTaskId !== undefined;
    const assetId = assigned ? leasedAsset(options) : undefined;
    if (assigned && !assetId) {
      return "Error: No current Sentinel asset assignment authorizes that query.";
    }

    const state = options.snapshotOverride !== undefined &&
        options.assessmentRevision === undefined
      ? undefined
      : readSentinelAssessment(path);
    if (
      options.assessmentRevision !== undefined &&
      (state?.revision !== options.assessmentRevision || !state.result)
    ) {
      return "Error: The requested Sentinel evidence revision is stale.";
    }
    if (view === "coverage" && !state?.result) {
      return "Error: Review coverage requires a saved case revision.";
    }
    const snapshot = state?.result?.sharedGraph.snapshot ??
      options.snapshotOverride ?? await readSentinelChatSnapshot(path);
    const graph = loadSentinelGraph(snapshot).snapshot();
    if (signal?.aborted || assigned && leasedAsset(options) !== assetId) {
      return "Error: The inventory assignment is no longer active.";
    }
    if (
      assetId &&
      !graph.nodes.some(({ id, kind }) => id === assetId && kind === "asset")
    ) {
      return "Error: This inventory query requires a directly assigned asset.";
    }
    const query = queryOptions(args, assetId);
    if (view === "coverage" && state?.plan.inventoryCoverageEnabled === false) {
      return "Error: Inventory coverage is disabled for this Sentinel assessment.";
    }
    const page = {
      ...query,
      allowedAssetIds,
      scopeBinding: JSON.stringify([
        path,
        state?.revision ?? null,
        options.assignedTaskId ?? null,
      ]),
    };
    const caseId = locateSentinelCase(path)?.caseId ?? null;
    const result = view === "coverage" && state
      ? querySentinelAssetReviewCoverage(
        graph,
        readSentinelFindingReviews(path, state.revision),
        {
          ...page,
          evidenceRevision: state.revision,
          coverageGap,
          asOf: args.asOf as string | undefined,
          reviewedAssetIds: reviewedAssets(options, state),
          peerCoverage,
        },
      )
      : view === "organizations"
      ? querySentinelOrganizations(graph, page)
      : querySentinelAssetInventory(graph, page);
    if (
      signal?.aborted || assigned && leasedAsset(options) !== assetId ||
      options.assessmentRevision !== undefined &&
        readSentinelAssessment(path)?.revision !== options.assessmentRevision
    ) {
      return "Error: The inventory evidence scope changed.";
    }
    const output = JSON.stringify({
      ...result,
      caseId,
      evidenceRevision: state?.revision ?? null,
      _classification: "INTERNAL",
    });
    return output.length <= 6000
      ? output
      : "Error: Reduce the inventory page size or use an exact asset filter.";
  } catch {
    return "Error: The inventory query, cursor, or source scope is unavailable.";
  }
}
