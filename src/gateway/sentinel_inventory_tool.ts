/** Root-dispatched, case-scoped asset and review coverage queries. */
import type { ToolDefinition } from "../core/types/tool.ts";
import {
  readSentinelAssessment,
  readSentinelFindingReviews,
} from "../sentinel/assessment_store.ts";
import { readSentinelChatSnapshot } from "../sentinel/chat_mode.ts";
import { loadSentinelGraph } from "../sentinel/graph.ts";
import {
  querySentinelAssetInventory,
  querySentinelAssetReviewCoverage,
  querySentinelOrganizations,
  sentinelAssetCoverageGaps,
  type SentinelAssetInventoryOptions,
} from "../sentinel/inventory_queries.ts";
import { locateSentinelCase } from "../sentinel/cases.ts";
import type { SentinelAgentOptions } from "./sentinel_agent.ts";
import {
  readAdaptiveSentinel,
  readAssignedSentinelModelReview,
} from "./sentinel_adaptive_runtime.ts";

type InventoryScope = Pick<
  SentinelAgentOptions,
  | "snapshotPath"
  | "assessmentRevision"
  | "snapshotOverride"
  | "assignedTaskId"
  | "assignedTaskLeaseToken"
>;

export const sentinelInventoryTool: ToolDefinition = {
  name: "sentinel_case_inventory",
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
    cursor: {
      type: "string",
      description: "Opaque cursor from the same case, revision and filters",
    },
    limit: { type: "integer", description: "Page size from 1 to 10" },
  },
};

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
  if (
    Object.keys(args).some((key) =>
      !["view", "cursor", "limit", "coverageGap", ...filters].includes(key)
    ) ||
    typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
    limit > 10 || cursor !== undefined &&
      (typeof cursor !== "string" || !cursor.length || cursor.length > 1800) ||
    filters.some((key) =>
      args[key] !== undefined && (typeof args[key] !== "string" ||
        args[key].length === 0 || args[key].length > 800)
    ) ||
    assignedAsset && args.assetId !== undefined &&
      args.assetId !== assignedAsset
  ) throw new Error("Invalid or out-of-scope inventory query.");
  return {
    onlyAsset: assignedAsset ?? args.assetId,
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

export async function executeSentinelInventoryTool(
  options: InventoryScope,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  allowedAssetIds?: readonly string[],
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
      args.coverageGap !== undefined && (view !== "coverage" || !coverageGap)
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
    const page = {
      ...queryOptions(args, assetId),
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
          reviewedAssetIds: reviewedAssets(options, state),
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
