import {
  isSentinelLiveRepositoryRead,
  SENTINEL_SAVED_REPOSITORY_VISIBILITY,
} from "./github_repository_visibility.ts";
import {
  isWorkerNarrativeId,
  readWorkerNarrativeReceipt,
  SENTINEL_WORKER_NARRATIVE_COMMIT,
  SENTINEL_WORKER_NARRATIVE_READ,
} from "./worker_narratives.ts";
import {
  SENTINEL_TRAFFIC_BLOB,
  sentinelTrafficBlobArgs,
} from "./traffic_recovery.ts";
import {
  parseSentinelInventoryAssetIds,
  parseSentinelInventoryText,
  sentinelAssetCoverageGaps,
  validSentinelCoverageTime,
} from "./inventory_queries.ts";
import { createHash } from "node:crypto";
import { isSentinelCaseId } from "./cases.ts";
import { isSentinelGraphFactCursor } from "./worker_graph_facts.ts";
import { redactCredentialText } from "../core/logger/redactor.ts";
/** Canonical arguments retained for request-bound Sentinel goal proposals. */
import { normalizeSentinelFormalGoals } from "./formal_goals.ts";

export const SENTINEL_GOAL_PROPOSE = "sentinel_propose_goal";

export function sentinelGoalProposalArguments(value: unknown) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 5
  ) return;
  const { goalId, title, criterion, evidenceId, requestId } = value as Record<
    string,
    unknown
  >;
  if (
    typeof requestId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId)
  ) return;
  try {
    const [goal] = normalizeSentinelFormalGoals([{
      id: goalId,
      title,
      policy: "operator",
      criteria: [{
        id: "evidence",
        source: "graph_evidence",
        reference: evidenceId,
        description: criterion,
      }],
    }]);
    return {
      goalId: goal.id,
      title: goal.title,
      criterion: goal.criteria[0].description,
      evidenceId: goal.criteria[0].reference,
      requestId: requestId.toLowerCase(),
    };
  } catch {
    return undefined;
  }
}

export const SENTINEL_GOAL_PROVE = "sentinel_prove_goal";

export function sentinelGoalProofArguments(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const {
    goalId,
    criterionId,
    evidenceId,
    source = "graph_evidence",
    requestId,
  } = value as Record<string, unknown>;
  if (
    Object.keys(value).some((key) =>
      !["goalId", "criterionId", "evidenceId", "source", "requestId"].includes(
        key,
      )
    ) ||
    typeof goalId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(goalId) ||
    typeof criterionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(criterionId) ||
    typeof evidenceId !== "string" || !evidenceId.trim() ||
    evidenceId.length > 4096 || evidenceId.includes("\0") ||
    (source !== "graph_evidence" && source !== "graph_fact" &&
      source !== "adaptive_task" && source !== "finding_recheck") ||
    typeof requestId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId)
  ) return;
  return {
    goalId,
    criterionId,
    evidenceId,
    source,
    requestId: requestId.toLowerCase(),
  };
}

export const SENTINEL_GOAL_GRAPH_FACT_READ = "sentinel_graph_facts";
export const SENTINEL_WORKER_TRACE_SEARCH = "sentinel_worker_trace_search";
export const SENTINEL_INTERMEDIATE_WORKFLOW_READ =
  "sentinel_intermediate_workflow_observation";
export const SENTINEL_SHARED_DISCOVERY_READ =
  "sentinel_shared_asset_discoveries";
export const SENTINEL_PRIOR_ASSIGNED_EVIDENCE_READ =
  "sentinel_prior_assigned_evidence";
export const SENTINEL_PINNED_TOPOLOGY_READ = "sentinel_shared_topology_source";
export const SENTINEL_PINNED_FINDING_READ = "sentinel_shared_finding_source";

export function isSentinelPinnedSourceRead(tool: unknown) {
  return tool === SENTINEL_PINNED_TOPOLOGY_READ ||
    tool === SENTINEL_PINNED_FINDING_READ;
}

export function parseSentinelPinnedFindingRead(args: Record<string, unknown>) {
  const { asset, sourceCase, sourceAsset, finding, snapshotDigest } = args;
  const validId = (id: unknown): id is string =>
    typeof id === "string" &&
    id.length > 0 && id.length <= 4096 && !id.includes("\0") &&
    redactCredentialText(id) === id;
  if (
    Object.keys(args).length !== 5 || !validId(asset) ||
    !validId(sourceAsset) ||
    !validId(finding) || typeof sourceCase !== "string" ||
    !isSentinelCaseId(sourceCase) ||
    typeof snapshotDigest !== "string" || !/^[a-f0-9]{64}$/.test(snapshotDigest)
  ) return;
  return { asset, sourceCase, sourceAsset, finding, snapshotDigest };
}

export const SENTINEL_SAVED_WORKFLOW_READ = "sentinel_saved_workflow_receipt";

export function isSentinelAssignedPrerequisiteRead(tool: unknown) {
  return tool === SENTINEL_SAVED_WORKFLOW_READ ||
    tool === SENTINEL_PRIOR_ASSIGNED_EVIDENCE_READ;
}

export const SENTINEL_CASE_HINTS_READ = "sentinel_case_hints";

export function sentinelCaseHintsReadArgs(args: Record<string, unknown>) {
  const { before, limit, assignedTraffic } = args;
  if (
    Object.keys(args).some((key) =>
      !["before", "limit", "assignedTraffic"].includes(key)
    ) ||
    (assignedTraffic !== undefined && assignedTraffic !== true) ||
    (before !== undefined &&
      (typeof before !== "number" || !Number.isSafeInteger(before) ||
        before < 1)) ||
    (limit !== undefined &&
      (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
        limit > 5))
  ) return;
  return {
    ...(before !== undefined && { before }),
    ...(limit !== undefined && { limit }),
    ...(assignedTraffic === true && { assignedTraffic: true as const }),
  };
}

export const SENTINEL_GOAL_STATE_READ = "sentinel_goal_state";

export function sentinelGoalStateReadArgs(args: Record<string, unknown>) {
  const { offset, limit } = args;
  if (
    Object.keys(args).some((key) => key !== "offset" && key !== "limit") ||
    (offset !== undefined &&
      (typeof offset !== "number" || !Number.isSafeInteger(offset) ||
        offset < 0 || offset > 32)) ||
    (limit !== undefined &&
      (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
        limit > 10))
  ) return;
  return {
    ...(offset !== undefined && { offset }),
    ...(limit !== undefined && { limit }),
  };
}

function provenancePageArgs(
  { revision, offset, limit }: Record<string, unknown>,
) {
  if (
    (revision !== undefined &&
      (typeof revision !== "number" || !Number.isSafeInteger(revision) ||
        revision < 1)) ||
    (offset !== undefined &&
      (typeof offset !== "number" || !Number.isSafeInteger(offset) ||
        offset < 0)) ||
    (limit !== undefined &&
      (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
        limit > 30))
  ) return;
  return {
    ...(revision !== undefined && { revision }),
    ...(offset !== undefined && { offset }),
    ...(limit !== undefined && { limit }),
  };
}

export const SENTINEL_SHARED_ASSET_LINKS_READ = "sentinel_shared_asset_links";

export function sentinelSharedAssetLinksArgs(args: Record<string, unknown>) {
  const { asset, offset, limit, includeFindings, sourceCase } = args;
  if (
    typeof asset !== "string" || !asset.trim() || asset.length > 4096 ||
    (offset !== undefined &&
      (typeof offset !== "number" || !Number.isSafeInteger(offset) ||
        offset < 0)) ||
    (limit !== undefined &&
      (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
        limit > 20)) ||
    (includeFindings !== undefined && typeof includeFindings !== "boolean") ||
    (sourceCase !== undefined && (typeof sourceCase !== "string" ||
      !isSentinelCaseId(sourceCase))) ||
    Object.keys(args).some((key) =>
      !["asset", "offset", "limit", "includeFindings", "sourceCase"].includes(
        key,
      )
    )
  ) return;
  return {
    asset,
    ...(offset !== undefined && { offset }),
    ...(limit !== undefined && { limit }),
    ...(includeFindings !== undefined && { includeFindings }),
    ...(typeof sourceCase === "string" && { sourceCase }),
  };
}

export const SENTINEL_INCIDENT_ALERTS_READ = "sentinel_incident_alerts";

export function sentinelIncidentAlertsArgs(args: Record<string, unknown>) {
  const { incidentId, revision, offset, limit } = args;
  if (
    typeof incidentId !== "string" ||
    !/^incident:[a-f0-9]{64}$/.test(incidentId) ||
    (revision !== undefined &&
      (typeof revision !== "number" || !Number.isSafeInteger(revision) ||
        revision < 1)) ||
    (offset !== undefined &&
      (typeof offset !== "number" || !Number.isSafeInteger(offset) ||
        offset < 0)) ||
    (limit !== undefined &&
      (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
        limit > 10)) ||
    Object.keys(args).some((key) =>
      !["incidentId", "revision", "offset", "limit"].includes(key)
    )
  ) return;
  return {
    incidentId,
    ...(revision !== undefined && { revision }),
    ...(offset !== undefined && { offset }),
    ...(limit !== undefined && { limit }),
  };
}

export const SENTINEL_DEFENSE_READ = "sentinel_defense";

export function sentinelDefenseReadArgs(args: Record<string, unknown>) {
  const { behavior, upstreamCheck, alertId } = args;
  const offset = args.offset === undefined ? 0 : args.offset;
  const limit = args.limit === undefined ? 10 : args.limit;
  if (
    (behavior !== undefined && typeof behavior !== "string") ||
    (upstreamCheck !== undefined &&
      (typeof upstreamCheck !== "string" || behavior !== undefined)) ||
    (upstreamCheck === undefined &&
      (args.offset !== undefined || args.limit !== undefined)) ||
    (alertId !== undefined &&
      (typeof alertId !== "string" ||
        !/^case-alert:[a-f0-9]{64}$/.test(alertId) ||
        behavior !== undefined || args.offset !== undefined ||
        args.limit !== undefined)) ||
    typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 ||
    typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
    limit > 30 ||
    Object.keys(args).some((key) =>
      !["behavior", "upstreamCheck", "alertId", "offset", "limit"].includes(key)
    )
  ) return;
  return {
    ...(behavior !== undefined && { behavior }),
    ...(upstreamCheck !== undefined && { upstreamCheck }),
    ...(alertId !== undefined && { alertId }),
    ...(args.offset !== undefined && { offset }),
    ...(args.limit !== undefined && { limit }),
  };
}

import {
  parseSentinelAssetQuery,
  type SentinelAssetQuery,
} from "./asset_properties.ts";

export const SENTINEL_CASE_INVENTORY_READ = "sentinel_case_inventory";

export function sentinelCheckpointInventoryArgs(args: Record<string, unknown>) {
  const { view, limit, coverageGap, asOf } = args;
  const batch = args.assetIds !== undefined
    ? parseSentinelInventoryAssetIds(args.assetIds)
    : undefined;
  const text = args.assetText === undefined
    ? undefined
    : parseSentinelInventoryText(args.assetText);
  const assetQuery = parseSentinelAssetQuery(args.assetQuery);
  const organizationText = args.organizationText === undefined
    ? undefined
    : parseSentinelInventoryText(args.organizationText);
  const gap = sentinelAssetCoverageGaps.find((entry) => entry === coverageGap);
  const selectors = [
    "assetId",
    "organizationId",
    "assetType",
    "parentId",
    "alias",
    "cursor",
  ] as const;
  if (
    (view !== "assets" && view !== "organizations" && view !== "coverage") ||
    (args.organizationText !== undefined &&
      (!organizationText || view !== "organizations")) ||
    (args.includeMembers !== undefined &&
      (args.includeMembers !== true || view !== "organizations" ||
        typeof args.organizationId !== "string" ||
        !args.organizationId.trim())) ||
    (args.assetQuery !== undefined &&
      (!assetQuery || view !== "assets" || args.assetIds !== undefined)) ||
    (args.assetText !== undefined &&
      (!text || view !== "assets" ||
        args.assetId !== undefined || args.assetIds !== undefined)) ||
    (args.assetIds !== undefined &&
      (!batch || view !== "assets" ||
        selectors.some((key) =>
          key !== "cursor" && args[key] !== undefined
        ))) ||
    (view === "coverage" && (args.cursor !== undefined ||
      (coverageGap !== undefined && !gap) ||
      !validSentinelCoverageTime(gap, asOf))) ||
    (view !== "coverage" &&
      (coverageGap !== undefined || asOf !== undefined)) ||
    (limit !== undefined && (typeof limit !== "number" ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 10)) ||
    Object.keys(args).some((key) =>
      key !== "view" && key !== "limit" && key !== "coverageGap" &&
      key !== "asOf" && key !== "assetIds" && key !== "assetText" &&
      key !== "organizationText" && key !== "includeMembers" &&
      key !== "assetQuery" &&
      !selectors.some((selector) => selector === key)
    )
  ) return;
  const retained: Partial<Record<(typeof selectors)[number], string>> = {};
  for (const key of selectors) {
    const value = args[key];
    if (value === undefined) continue;
    if (
      typeof value !== "string" || !value.length ||
      value.length > (key === "cursor" ? 1800 : 800) ||
      redactCredentialText(value) !== value
    ) return;
    retained[key] = value;
  }
  return {
    view,
    ...retained,
    ...(batch && { assetIds: batch }),
    ...(text !== undefined && { assetText: text }),
    ...(assetQuery && { assetQuery }),
    ...(organizationText !== undefined && { organizationText }),
    ...(args.includeMembers === true && { includeMembers: true as const }),
    ...(limit !== undefined && { limit }),
    ...(gap && { coverageGap: gap }),
    ...(typeof asOf === "string" && { asOf }),
  };
}

export const SENTINEL_REPORT_READ = "sentinel_report";
export const SENTINEL_COVERAGE_READ = "sentinel_coverage";
export function isSentinelInventoryFindingRead(tool: unknown) {
  return tool === SENTINEL_REPORT_READ || tool === SENTINEL_COVERAGE_READ;
}

export function sentinelInventoryFindingPageArgs(
  args: Record<string, unknown>,
) {
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 10;
  if (
    Object.keys(args).some((key) => key !== "offset" && key !== "limit") ||
    typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 ||
    typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
    limit > 30
  ) return;
  return {
    ...(args.offset !== undefined && { offset }),
    ...(args.limit !== undefined && { limit }),
  };
}

export const SENTINEL_TRACE_READ = "sentinel_trace";
export const SENTINEL_IMPACT_READ = "sentinel_impact";

export function isSentinelInventoryNeighborhoodRead(tool: unknown) {
  return tool === SENTINEL_TRACE_READ || tool === SENTINEL_IMPACT_READ;
}

export function sentinelInventoryNeighborhoodArgs(
  args: Record<string, unknown>,
) {
  const { node } = args;
  const depth = args.depth ?? 2;
  if (
    typeof node !== "string" || !node.trim() || node.length > 1024 ||
    typeof depth !== "number" || !Number.isSafeInteger(depth) || depth < 0 ||
    depth > 10 ||
    Object.keys(args).some((key) => key !== "node" && key !== "depth")
  ) return;
  return { node, ...(args.depth !== undefined && { depth }) };
}

export const SENTINEL_PATH_READ = "sentinel_path";

export function isSentinelArchivedInventoryRead(
  tool: unknown,
  args: { readonly graph?: unknown },
) {
  return isSentinelInventoryNeighborhoodRead(tool) ||
    isSentinelInventoryFindingRead(tool) ||
    (tool === SENTINEL_PATH_READ && args.graph !== "provenance");
}

export function parseSavedPlannerProvenancePath(
  text: string,
  args: {
    graph?: unknown;
    from?: unknown;
    to?: unknown;
    depth?: number;
    limit?: number;
  },
  revision?: number,
): boolean {
  if (
    args.graph !== "provenance" || text.length > 7000 ||
    redactCredentialText(text) !== text ||
    /"(?:githubWorkflowRead|resultSnapshot|sharedAssetLinksPage)"\s*:/.test(
      text,
    )
  ) return false;
  try {
    const page = JSON.parse(text);
    if (
      !Number.isSafeInteger(page?.revision) || page.revision < 1 ||
      (revision !== undefined && page.revision !== revision)
    ) return false;
    const validPath = (
      path: { nodes?: { id?: unknown }[]; edges?: unknown[] },
    ) =>
      Array.isArray(path?.nodes) && Array.isArray(path?.edges) &&
      path.nodes.length === path.edges.length + 1 &&
      path.edges.length <= (args.depth ?? 2) &&
      path.nodes[0]?.id === args.from && path.nodes.at(-1)?.id === args.to;
    return args.limit === undefined
      ? Object.keys(page).length === 2 &&
        (page.path === null || validPath(page.path))
      : Object.keys(page).length === 3 && typeof page.truncated === "boolean" &&
        Array.isArray(page.paths) && page.paths.length <= args.limit &&
        page.paths.every(validPath);
  } catch {
    return false;
  }
}

function sentinelCheckpointPathArgs(args: Record<string, unknown>) {
  const { from, to, depth, direction, graph, revision, relation, limit } = args;
  const endpoint = (id: unknown): id is string =>
    typeof id === "string" &&
    id.trim().length > 0 && id.length <= 4096 &&
    redactCredentialText(id) === id;
  if (
    (graph !== undefined && graph !== "provenance" && graph !== "inventory") ||
    !endpoint(from) || !endpoint(to) ||
    Object.keys(args).some((key) =>
      ![
        "graph",
        "from",
        "to",
        "depth",
        "direction",
        "revision",
        "relation",
        "limit",
      ].includes(key)
    ) ||
    (depth !== undefined &&
      (typeof depth !== "number" || !Number.isSafeInteger(depth) || depth < 0 ||
        depth > 10)) ||
    (direction !== undefined && direction !== "both" &&
      direction !== "incoming" && direction !== "outgoing") ||
    (relation !== undefined &&
      (typeof relation !== "string" ||
        !/^[a-z_]{1,40}(?:,[a-z_]{1,40}){0,15}$/.test(relation))) ||
    (revision !== undefined &&
      (graph !== "provenance" || typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        revision < 1)) ||
    (limit !== undefined &&
      (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
        limit > 10))
  ) return;
  return {
    ...(graph !== undefined && { graph }),
    from,
    to,
    ...(depth !== undefined && { depth }),
    ...(direction !== undefined && { direction }),
    ...(revision !== undefined && { revision }),
    ...(relation !== undefined && { relation }),
    ...(limit !== undefined && { limit }),
  };
}

export const SENTINEL_PROVENANCE_SEARCH = "sentinel_provenance_search";
export function sentinelProvenanceSearchArgs(args: Record<string, unknown>) {
  const { query, kind, origin } = args;
  const page = provenancePageArgs(args);
  if (
    Object.keys(args).some((key) =>
      !["query", "kind", "origin", "revision", "offset", "limit"].includes(key)
    ) ||
    (query !== undefined &&
      (typeof query !== "string" || query.length > 256)) ||
    (kind !== undefined &&
      (typeof kind !== "string" ||
        ![
          "asset",
          "finding",
          "control",
          "evidence",
          "goal",
          "task",
          "observation",
        ].includes(kind))) ||
    (origin !== undefined &&
      (typeof origin !== "string" ||
        !["imported", "assessment", "adaptive"].includes(origin))) ||
    !page
  ) return;
  return {
    ...(query !== undefined && { query }),
    ...(kind !== undefined && { kind }),
    ...(origin !== undefined && { origin }),
    ...page,
  };
}

export const SENTINEL_PROVENANCE_NODE_READ = "sentinel_provenance_node";

export function sentinelProvenanceNodeArgs(args: Record<string, unknown>) {
  const { node } = args;
  if (
    typeof node !== "string" || !node.trim() || node.length > 4096 ||
    Object.keys(args).some((key) =>
      !["node", "revision", "offset", "limit"].includes(key)
    )
  ) return;
  const page = provenancePageArgs(args);
  return page && { node, ...page };
}

export const SENTINEL_ASSIGNED_EXECUTION_EVIDENCE =
  "sentinel_assigned_execution_evidence";
export const SENTINEL_SHARED_WORKER_REVIEW = "sentinel_shared_worker_review";
export const SENTINEL_GOAL_TASK_READ = "sentinel_worker_observation";
export function isSentinelGoalReceiptRead(tool: unknown) {
  return tool === SENTINEL_GOAL_GRAPH_FACT_READ ||
    tool === SENTINEL_GOAL_RECHECK_READ ||
    isSentinelAssignedPrerequisiteRead(tool) ||
    isRepeatableSentinelReceiptRead(tool);
}

export function isRepeatableSentinelReceiptRead(tool: unknown) {
  return (typeof tool === "string" && isSentinelLiveRepositoryRead(tool)) ||
    tool === SENTINEL_SAVED_REPOSITORY_VISIBILITY ||
    tool === SENTINEL_WORKER_NARRATIVE_READ ||
    tool === SENTINEL_WORKER_NARRATIVE_COMMIT ||
    tool === SENTINEL_SHARED_WORKER_REVIEW ||
    tool === SENTINEL_TRAFFIC_BLOB ||
    tool === SENTINEL_CASE_INVENTORY_READ ||
    tool === SENTINEL_ASSIGNED_EXECUTION_EVIDENCE ||
    tool === SENTINEL_SHARED_ASSET_LINKS_READ ||
    tool === SENTINEL_INCIDENT_ALERTS_READ ||
    tool === SENTINEL_DEFENSE_READ ||
    isSentinelInventoryFindingRead(tool) ||
    isSentinelInventoryNeighborhoodRead(tool) ||
    tool === SENTINEL_PATH_READ || tool === SENTINEL_PROVENANCE_SEARCH ||
    tool === SENTINEL_PROVENANCE_NODE_READ ||
    tool === SENTINEL_CASE_HINTS_READ ||
    tool === SENTINEL_GOAL_STATE_READ ||
    tool === SENTINEL_GOAL_RECHECK_READ ||
    tool === SENTINEL_GOAL_GRAPH_FACT_READ ||
    tool === SENTINEL_GOAL_TASK_READ ||
    tool === SENTINEL_WORKER_TRACE_SEARCH ||
    tool === SENTINEL_INTERMEDIATE_WORKFLOW_READ ||
    tool === SENTINEL_SHARED_DISCOVERY_READ || isSentinelPinnedSourceRead(tool);
}

export function isSentinelRetainedReadReceipt(tool: unknown, args: unknown) {
  return (tool === SENTINEL_CASE_INVENTORY_READ &&
    (args as { view?: unknown } | undefined)?.view === "coverage") ||
    tool === SENTINEL_ASSIGNED_EXECUTION_EVIDENCE ||
    tool === SENTINEL_SHARED_ASSET_LINKS_READ ||
    tool === SENTINEL_INCIDENT_ALERTS_READ ||
    tool === SENTINEL_DEFENSE_READ ||
    isSentinelInventoryFindingRead(tool) ||
    isSentinelInventoryNeighborhoodRead(tool) ||
    tool === SENTINEL_PATH_READ || tool === SENTINEL_PROVENANCE_SEARCH ||
    tool === SENTINEL_PROVENANCE_NODE_READ ||
    tool === SENTINEL_CASE_HINTS_READ ||
    tool === SENTINEL_GOAL_STATE_READ ||
    tool === SENTINEL_GOAL_RECHECK_READ ||
    tool === SENTINEL_WORKER_TRACE_SEARCH ||
    isSentinelPinnedSourceRead(tool) ||
    isSentinelAssignedPrerequisiteRead(tool) ||
    tool === SENTINEL_SHARED_DISCOVERY_READ ||
    ((tool === SENTINEL_INTERMEDIATE_WORKFLOW_READ ||
      tool === SENTINEL_GOAL_GRAPH_FACT_READ) &&
      !!args &&
      typeof args === "object" && !("id" in args)) ||
    (tool === SENTINEL_GOAL_TASK_READ && !!args && typeof args === "object" &&
      "query" in args);
}

export const SENTINEL_GOAL_RECHECK_READ = "sentinel_worker_findings";

export type SentinelWorkerTraceSearchArgs = {
  readonly liveProgress?: true;
  readonly task?: string;
  readonly query?: string;
  readonly stepIndices?: readonly number[];
  readonly revision?: number;
  readonly offset?: number;
  readonly limit?: number;
};

export function sentinelWorkerTraceSearchArgs(
  args: Record<string, unknown>,
): SentinelWorkerTraceSearchArgs | undefined {
  const { query, task, stepIndices, revision, offset, limit, liveProgress } =
    args;
  if (
    Object.keys(args).some((key) =>
      ![
        "query",
        "task",
        "stepIndices",
        "revision",
        "offset",
        "limit",
        "liveProgress",
      ].includes(
        key,
      )
    ) ||
    (liveProgress !== undefined && liveProgress !== true) ||
    (query !== undefined && (typeof query !== "string" ||
      !/^[a-zA-Z0-9 ._:-]{0,128}$/.test(query) ||
      redactCredentialText(query) !== query)) ||
    (task !== undefined &&
      (typeof task !== "string" || !/^adaptive:[a-f0-9]{64}$/.test(task))) ||
    (stepIndices !== undefined && (!task || query !== undefined ||
      !Array.isArray(stepIndices) || !stepIndices.length ||
      stepIndices.length > 30 ||
      stepIndices.some((index) =>
        !Number.isSafeInteger(index) || index < 0
      ))) ||
    (revision !== undefined &&
      (typeof revision !== "number" || !Number.isSafeInteger(revision) ||
        revision < 1)) ||
    (offset !== undefined &&
      (typeof offset !== "number" || !Number.isSafeInteger(offset) ||
        offset < 0)) ||
    (limit !== undefined &&
      (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
        limit > 30))
  ) return;
  return {
    ...(liveProgress === true && { liveProgress: true }),
    ...(query !== undefined && { query }),
    ...(task !== undefined && { task }),
    ...(stepIndices !== undefined && { stepIndices }),
    ...(revision !== undefined && { revision }),
    ...(offset !== undefined && { offset }),
    ...(limit !== undefined && { limit }),
  };
}

type GoalReceiptReadArguments =
  & {
    revision?: number;
    offset?: number;
    limit?: number;
    beforeReceiptId?: string;
    cursor?: string;
    before?: number;
    assignedTraffic?: true;
    liveProgress?: true;
    after?: string;
    incidentId?: string;
    behavior?: string;
    upstreamCheck?: string;
    node?: string;
    graph?: string;
    from?: string;
    to?: string;
    depth?: number;
    direction?: string;
    relation?: string;
    kind?: string;
    origin?: string;
    evidenceId?: string;
    trafficDigest?: string;
    summary?: string;
    confidence?: "observed" | "inferred";
    digest?: string;
    payloadPart?: string;
    byteLength?: number;
    sourceCase?: string;
    taskId?: string;
    recheckId?: string;
    asset?: string;
    includeFindings?: boolean;
    sourceAsset?: string;
    finding?: string;
    snapshotDigest?: string;
    view?: string;
    coverageGap?: string;
    asOf?: string;
    assetId?: string;
    assetIds?: readonly string[];
    assetText?: string;
    assetQuery?: SentinelAssetQuery;
    organizationText?: string;
    includeMembers?: true;
    organizationId?: string;
    assetType?: string;
    parentId?: string;
    alias?: string;
  }
  & (
    | (SentinelWorkerTraceSearchArgs & { id?: never; receiptId?: never })
    | { id: string; task?: never; receiptId?: never; query?: never }
    | {
      task: string;
      revision?: number;
      offset?: number;
      id?: never;
      receiptId?: never;
      query?: never;
    }
    | {
      receiptId: string;
      revision?: number;
      id?: never;
      task?: never;
      query?: never;
    }
    | {
      query: string;
      revision?: number;
      offset?: number;
      id?: never;
      task?: never;
      receiptId?: never;
    }
  );

export function sentinelIntermediateWorkflowReadArgs(
  args: Record<string, unknown>,
  maximumOffset: number,
):
  | { id: string; offset?: never; limit?: never }
  | { id?: never; offset?: number; limit?: number }
  | undefined {
  const { id, offset, limit } = args;
  if (id !== undefined) {
    return Object.keys(args).length === 1 && typeof id === "string" &&
        /^workflow-observation:[a-f0-9]{64}$/.test(id)
      ? { id }
      : undefined;
  }
  if (
    Object.keys(args).some((key) => key !== "offset" && key !== "limit") ||
    (offset !== undefined &&
      (typeof offset !== "number" || !Number.isSafeInteger(offset) ||
        offset < 0 || offset > maximumOffset)) ||
    (limit !== undefined &&
      (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
        limit > 10))
  ) return;
  return {
    ...(offset !== undefined && { offset }),
    ...(limit !== undefined && { limit }),
  };
}

export function readSentinelGraphOverviewProjection(
  value: unknown,
  selectedRevision?: number,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const {
    revision,
    nodeCount,
    edgeCount,
    unresolvedReferenceCount,
    nodesByKind,
    edgesByRelation,
  } = value as Record<string, unknown>;
  const count = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const counts = (values: unknown, total: number) => {
    if (!values || typeof values !== "object" || Array.isArray(values)) return;
    const entries = Object.entries(values);
    if (
      entries.length > 64 ||
      entries.some(([key, n]) =>
        !/^[a-z][a-z_]{0,47}$/.test(key) || !count(n)
      ) ||
      entries.reduce((sum, [, n]) => sum + n, 0) !== total
    ) return;
    return Object.fromEntries(entries) as Record<string, number>;
  };
  if (
    Object.keys(value).length !== 6 || !count(revision) || revision < 1 ||
    (selectedRevision !== undefined && revision !== selectedRevision) ||
    !count(nodeCount) || !count(edgeCount) || !count(unresolvedReferenceCount)
  ) return;
  const nodes = counts(nodesByKind, nodeCount);
  const edges = counts(edgesByRelation, edgeCount);
  if (nodes && edges) {
    return {
      revision,
      nodeCount,
      edgeCount,
      unresolvedReferenceCount,
      nodesByKind: nodes,
      edgesByRelation: edges,
    };
  }
}

/** A literal lookup against structured fact fields, suitable for saved selectors. */
export function normalizeSentinelGraphFactQuery(
  value: unknown,
): string | undefined {
  if (typeof value !== "string" || value.length > 128) return;
  const query = value.trim();
  if (
    !query || !/^[A-Za-z0-9 ._:/-]+$/.test(query) ||
    redactCredentialText(query) !== query
  ) return;
  return query.toLowerCase();
}

export function sentinelGoalReceiptReadArguments(
  tool: string,
  value: unknown,
): GoalReceiptReadArguments | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const args = value as Record<string, unknown>;
  if (isSentinelLiveRepositoryRead(tool)) {
    return Object.keys(args).length === 0 ? {} : undefined;
  }
  if (tool === SENTINEL_SAVED_REPOSITORY_VISIBILITY) {
    const { taskId, asset, recheckId } = args;
    return Object.keys(args).length === (recheckId === undefined ? 2 : 3) &&
        typeof taskId === "string" && /^adaptive:[a-f0-9]{64}$/.test(taskId) &&
        typeof asset === "string" && asset.length > 0 && asset.length <= 256 &&
        redactCredentialText(asset) === asset &&
        (recheckId === undefined ||
          typeof recheckId === "string" &&
            /^worker-recheck:[a-f0-9]{64}$/.test(recheckId))
      ? { taskId, asset, ...(recheckId && { recheckId }) }
      : undefined;
  }
  if (tool === SENTINEL_WORKER_NARRATIVE_READ) {
    return Object.keys(args).length === 1 && isWorkerNarrativeId(args.id)
      ? { id: args.id }
      : undefined;
  }
  if (tool === SENTINEL_WORKER_NARRATIVE_COMMIT) {
    if (Object.hasOwn(args, "sourceSha256")) return;
    const receipt = readWorkerNarrativeReceipt({
      ...args,
      sourceSha256: "0".repeat(64),
    });
    if (receipt) {
      const { summary, confidence, evidenceId, trafficDigest, upstreamCheck } =
        receipt;
      return {
        summary,
        confidence,
        evidenceId,
        ...(trafficDigest && { trafficDigest }),
        ...(upstreamCheck && { upstreamCheck }),
      };
    }
    return;
  }
  if (tool === SENTINEL_SHARED_WORKER_REVIEW) {
    const { sourceCase, taskId, asset } = args;
    if (
      Object.keys(args).length !== 3 ||
      !isSentinelCaseId(sourceCase) ||
      typeof taskId !== "string" || !/^adaptive:[a-f0-9]{64}$/.test(taskId) ||
      typeof asset !== "string" || !asset ||
      asset.length > 256 ||
      redactCredentialText(asset) !== asset
    ) return;
    return { sourceCase, taskId, asset };
  }
  if (tool === SENTINEL_TRAFFIC_BLOB) return sentinelTrafficBlobArgs(args);
  if (tool === SENTINEL_CASE_INVENTORY_READ) {
    return sentinelCheckpointInventoryArgs(args);
  }
  if (tool === "sentinel_graph_overview") {
    const { revision } = args;
    if (
      Object.keys(args).every((key) => key === "revision") &&
      (revision === undefined || (typeof revision === "number" &&
        Number.isSafeInteger(revision) && revision >= 1))
    ) return revision === undefined ? {} : { revision };
    return;
  }
  if (
    tool === SENTINEL_ASSIGNED_EXECUTION_EVIDENCE ||
    tool === "sentinel_case_execution_evidence"
  ) {
    const { node } = args;
    return Object.keys(args).length === 1 && typeof node === "string" &&
        /^(?:execution-evidence|native-workflow-evidence):[a-f0-9]{64}$/.test(
          node,
        )
      ? { node }
      : undefined;
  }
  if (tool === SENTINEL_SHARED_ASSET_LINKS_READ) {
    const parsed = sentinelSharedAssetLinksArgs(args);
    return parsed && redactCredentialText(parsed.asset) === parsed.asset
      ? parsed
      : undefined;
  }
  if (tool === SENTINEL_INCIDENT_ALERTS_READ) {
    return sentinelIncidentAlertsArgs(args);
  }
  if (tool === SENTINEL_DEFENSE_READ) {
    const parsed = sentinelDefenseReadArgs(args);
    const selector = parsed?.behavior ?? parsed?.upstreamCheck;
    return parsed &&
        (selector === undefined || /^[a-z0-9_]{1,128}$/.test(selector))
      ? parsed
      : undefined;
  }
  if (isSentinelInventoryFindingRead(tool)) {
    return sentinelInventoryFindingPageArgs(args);
  }
  if (isSentinelInventoryNeighborhoodRead(tool)) {
    const parsed = sentinelInventoryNeighborhoodArgs(args);
    return parsed && redactCredentialText(parsed.node) === parsed.node
      ? parsed
      : undefined;
  }
  if (tool === SENTINEL_PATH_READ) return sentinelCheckpointPathArgs(args);
  if (tool === SENTINEL_PROVENANCE_SEARCH) {
    const parsed = sentinelProvenanceSearchArgs(args);
    return parsed && (parsed.query === undefined ||
        /^[a-zA-Z0-9 ._:-]{0,128}$/.test(parsed.query) &&
          redactCredentialText(parsed.query) === parsed.query)
      ? parsed
      : undefined;
  }
  if (tool === SENTINEL_PROVENANCE_NODE_READ) {
    const parsed = sentinelProvenanceNodeArgs(args);
    return parsed && redactCredentialText(parsed.node) === parsed.node
      ? parsed
      : undefined;
  }
  if (tool === SENTINEL_CASE_HINTS_READ) return sentinelCaseHintsReadArgs(args);
  if (tool === SENTINEL_GOAL_STATE_READ) return sentinelGoalStateReadArgs(args);
  if (tool === SENTINEL_PINNED_FINDING_READ) {
    const read = parseSentinelPinnedFindingRead(args);
    return read;
  }
  if (tool === SENTINEL_PINNED_TOPOLOGY_READ) {
    const { evidenceId, sourceCase } = args;
    if (
      Object.keys(args).length === 2 && typeof evidenceId === "string" &&
      /^shared-topology:[a-f0-9]{64}$/.test(evidenceId) &&
      typeof sourceCase === "string" && isSentinelCaseId(sourceCase)
    ) return { evidenceId, sourceCase };
    return;
  }
  if (
    isSentinelAssignedPrerequisiteRead(tool) &&
    Object.keys(args).length === 0
  ) return {};
  if (
    tool === SENTINEL_SHARED_DISCOVERY_READ && Object.keys(args).length === 0
  ) return {};
  if (
    tool === SENTINEL_SHARED_DISCOVERY_READ && Object.keys(args).length === 1 &&
    typeof args.id === "string" &&
    /^asset-discovery:[a-f0-9]{64}$/.test(args.id)
  ) {
    return { id: args.id };
  }
  if (
    tool === SENTINEL_SHARED_DISCOVERY_READ && Object.keys(args).length === 1 &&
    typeof args.after === "string" &&
    /^asset-discovery:[a-f0-9]{64}$/.test(args.after)
  ) return { after: args.after };
  if (tool === SENTINEL_WORKER_TRACE_SEARCH) {
    return sentinelWorkerTraceSearchArgs(args);
  }
  if (tool === SENTINEL_INTERMEDIATE_WORKFLOW_READ) {
    return sentinelIntermediateWorkflowReadArgs(args, Number.MAX_SAFE_INTEGER);
  }
  if (tool === SENTINEL_GOAL_GRAPH_FACT_READ) {
    const { offset, query, cursor } = args;
    const phrase = normalizeSentinelGraphFactQuery(query);
    if (
      Object.keys(args).every((key) =>
        key === "offset" || key === "query" || key === "cursor"
      ) &&
      (cursor === undefined ||
        (isSentinelGraphFactCursor(cursor) && offset === undefined)) &&
      (offset === undefined || (typeof offset === "number" &&
        Number.isSafeInteger(offset) && offset >= 0)) &&
      (query === undefined || phrase !== undefined)
    ) {
      return {
        ...(offset !== undefined && { offset }),
        ...(phrase && { query: phrase }),
        ...(typeof cursor === "string" && { cursor }),
      };
    }
  }
  if (
    tool === SENTINEL_GOAL_GRAPH_FACT_READ && Object.keys(args).length === 1 &&
    typeof args.id === "string" &&
    /^worker-graph-fact:[a-f0-9]{64}$/.test(args.id)
  ) return { id: args.id };
  if (
    tool === SENTINEL_GOAL_TASK_READ &&
    Object.keys(args).every((key) =>
      ["task", "revision", "offset"].includes(key)
    ) &&
    typeof args.task === "string" &&
    /^adaptive:[a-f0-9]{64}$/.test(args.task) &&
    (args.offset === undefined || typeof args.offset === "number" &&
        Number.isSafeInteger(args.offset) && args.offset >= 0) &&
    (args.revision === undefined || typeof args.revision === "number" &&
        Number.isSafeInteger(args.revision) && args.revision > 0)
  ) {
    return {
      task: args.task,
      ...(args.revision !== undefined && { revision: args.revision }),
      ...(args.offset !== undefined && { offset: args.offset }),
    };
  }
  if (
    tool === SENTINEL_GOAL_TASK_READ &&
    Object.keys(args).every((key) =>
      ["query", "revision", "offset"].includes(key)
    ) &&
    typeof args.query === "string" &&
    /^[a-zA-Z0-9 ._-]{1,128}$/.test(args.query) &&
    redactCredentialText(args.query) === args.query &&
    (args.offset === undefined || typeof args.offset === "number" &&
        Number.isSafeInteger(args.offset) && args.offset >= 0) &&
    (args.revision === undefined || typeof args.revision === "number" &&
        Number.isSafeInteger(args.revision) && args.revision > 0)
  ) {
    return {
      query: args.query,
      ...(args.revision !== undefined && { revision: args.revision }),
      ...(args.offset !== undefined && { offset: args.offset }),
    };
  }
  if (
    tool === SENTINEL_GOAL_RECHECK_READ &&
    Object.keys(args).every((key) =>
      ["revision", "limit", "beforeReceiptId"].includes(key)
    )
  ) {
    const { revision, limit, beforeReceiptId } = args;
    if (
      (revision === undefined ||
        typeof revision === "number" && Number.isSafeInteger(revision) &&
          revision > 0) &&
      (limit === undefined ||
        typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 &&
          limit <= 10) &&
      (beforeReceiptId === undefined ||
        typeof beforeReceiptId === "string" &&
          /^worker-(?:finding|recheck):[a-f0-9]{64}$/.test(beforeReceiptId))
    ) {
      return {
        ...(revision !== undefined && { revision }),
        ...(limit !== undefined && { limit }),
        ...(beforeReceiptId !== undefined && { beforeReceiptId }),
      };
    }
  }
  if (
    tool === SENTINEL_GOAL_RECHECK_READ &&
    Object.keys(args).every((key) =>
      key === "receiptId" || key === "revision"
    ) &&
    typeof args.receiptId === "string" &&
    /^worker-(?:finding|recheck):[a-f0-9]{64}$/.test(args.receiptId) &&
    (args.revision === undefined || typeof args.revision === "number" &&
        Number.isSafeInteger(args.revision) && args.revision > 0)
  ) {
    return {
      receiptId: args.receiptId,
      ...(args.revision !== undefined && { revision: args.revision }),
    };
  }
}

export function sentinelIntermediateWorkflowPageReference(value: unknown) {
  if (!value || typeof value !== "object") return;
  const { args, ids, nextOffset, sha256 } = value as Record<string, unknown>;
  if (!args || typeof args !== "object" || Array.isArray(args)) return;
  const parsed = sentinelIntermediateWorkflowReadArgs(
    args as Record<string, unknown>,
    Number.MAX_SAFE_INTEGER,
  );
  if (!parsed || parsed.id !== undefined) return;
  const limit = parsed.limit ?? 5;
  const offset = parsed.offset ?? 0;
  if (
    !Array.isArray(ids) || ids.length > limit ||
    new Set(ids).size !== ids.length ||
    !ids.every((id) =>
      typeof id === "string" && /^workflow-observation:[a-f0-9]{64}$/.test(id)
    ) ||
    (nextOffset !== null &&
      (ids.length !== limit || !Number.isSafeInteger(nextOffset) ||
        nextOffset !== offset + limit)) ||
    typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)
  ) return;
  return {
    args: parsed,
    ids: ids as string[],
    nextOffset: nextOffset as number | null,
    sha256,
  };
}

export function readSentinelDiscoveryPage(value: unknown) {
  if (!value || typeof value !== "object") return;
  const { discoveries, truncated, nextAfter } = value as Record<
    string,
    unknown
  >;
  if (
    !Array.isArray(discoveries) || discoveries.length > 10 ||
    typeof truncated !== "boolean" ||
    (nextAfter !== undefined
      ? !truncated || discoveries.length !== 5 ||
        nextAfter !== discoveries.at(-1)?.id ||
        Object.keys(value).length !== 3
      : (truncated && discoveries.length !== 10) ||
        Object.keys(value).length !== 2)
  ) return;
  const rows: { id: string; kind: string; sourceCaseId: string }[] = [];
  for (const entry of discoveries) {
    if (
      typeof entry?.id !== "string" ||
      !/^asset-discovery:[a-f0-9]{64}$/.test(entry.id) ||
      rows.some(({ id }) => id === entry.id) ||
      !["asset", "alias", "relationship"].includes(entry.kind) ||
      typeof entry.sourceCaseId !== "string" ||
      !isSentinelCaseId(entry.sourceCaseId) ||
      Object.keys(entry).length !== 3
    ) return;
    rows.push({
      id: entry.id,
      kind: entry.kind,
      sourceCaseId: entry.sourceCaseId,
    });
  }
  return {
    discoveries: rows,
    truncated,
    ...(typeof nextAfter === "string" && { nextAfter }),
  };
}

export function readSentinelDiscoveryPageReference(value: unknown) {
  if (!value || typeof value !== "object") return;
  const { result, after, sha256 } = value as Record<string, unknown>;
  const page = readSentinelDiscoveryPage(result);
  if (
    !page ||
    (after !== undefined &&
      (typeof after !== "string" ||
        !/^asset-discovery:[a-f0-9]{64}$/.test(after))) ||
    typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)
  ) return;
  return { result: page, ...(typeof after === "string" && { after }), sha256 };
}

export function readSentinelTaskObservationPageReference(value: unknown) {
  if (!value || typeof value !== "object") return;
  const { task, offset, sha256 } = value as Record<string, unknown>;
  if (
    typeof task !== "string" || !/^adaptive:[a-f0-9]{64}$/.test(task) ||
    typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 ||
    typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)
  ) return;
  return { task, offset, sha256 };
}

export function readSentinelFindingPageReference(value: unknown) {
  if (!value || typeof value !== "object") return;
  const { args, ids, nextBeforeReceiptId, empty, sha256 } = value as Record<
    string,
    unknown
  >;
  const call = sentinelGoalReceiptReadArguments(
    SENTINEL_GOAL_RECHECK_READ,
    args,
  );
  if (!call || call.receiptId !== undefined) return;
  if (
    !Array.isArray(ids) || ids.length > (call.limit ?? 5) ||
    new Set(ids).size !== ids.length ||
    !ids.every((id) =>
      typeof id === "string" &&
      /^worker-(?:finding|recheck):[a-f0-9]{64}$/.test(id) &&
      id !== call.beforeReceiptId
    ) ||
    (nextBeforeReceiptId !== null &&
      (!ids.length || nextBeforeReceiptId !== ids.at(-1))) ||
    typeof empty !== "boolean" ||
    (empty && (ids.length || call.beforeReceiptId)) ||
    typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)
  ) return;
  return {
    args: call,
    ids: ids as string[],
    nextBeforeReceiptId: nextBeforeReceiptId as string | null,
    empty,
    sha256,
  };
}

export function readSentinelGoalStateProjection(value: unknown) {
  if (!value || typeof value !== "object") return;
  const { status, flags } = value as Record<string, unknown>;
  if (
    (status !== "open" && status !== "awaiting_confirmation" &&
      status !== "completed") ||
    !Array.isArray(flags) || flags.length > 10 ||
    !flags.every((flag) => typeof flag === "boolean")
  ) return;
  return { status, flags: flags as boolean[] };
}

export function readSentinelObservationSearchReference(value: unknown) {
  if (!value || typeof value !== "object") return;
  const { args, ids, nextOffset, sha256 } = value as Record<string, unknown>;
  const call = sentinelGoalReceiptReadArguments(SENTINEL_GOAL_TASK_READ, args);
  if (!call || typeof call.query !== "string") return;
  if (
    !Array.isArray(ids) || ids.length > 5 || new Set(ids).size !== ids.length ||
    !ids.every((id) =>
      typeof id === "string" && /^adaptive:[a-f0-9]{64}$/.test(id)
    ) ||
    (nextOffset !== null &&
      (ids.length !== 5 || !Number.isSafeInteger(nextOffset) ||
        nextOffset !== (call.offset ?? 0) + 5)) ||
    typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)
  ) return;
  return {
    args: call,
    ids: ids as string[],
    nextOffset: nextOffset as number | null,
    sha256,
  };
}

export function readSentinelWorkerTracePageReference(value: unknown) {
  if (!value || typeof value !== "object") return;
  const { args, rows, totalSteps, nextOffset, sha256 } = value as Record<
    string,
    unknown
  >;
  if (!args || typeof args !== "object" || Array.isArray(args)) return;
  const call = sentinelWorkerTraceSearchArgs(args as Record<string, unknown>);
  if (
    !call || !Array.isArray(rows) || rows.length > (call.limit ?? 10) ||
    typeof totalSteps !== "number" || !Number.isSafeInteger(totalSteps) ||
    totalSteps < 0 ||
    typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)
  ) return;
  const end = (call.offset ?? 0) + rows.length;
  if (
    !Number.isSafeInteger(end) ||
    nextOffset !== (end < totalSteps ? end : null) ||
    (rows.length ? end > totalSteps : end < totalSteps)
  ) return;
  const keys: { taskId: string; index: number }[] = [];
  for (const row of rows) {
    if (
      typeof row?.taskId !== "string" ||
      !/^adaptive:[a-f0-9]{64}$/.test(row.taskId) ||
      !Number.isSafeInteger(row.index) || row.index < 0 ||
      keys.some(({ taskId, index }) =>
        taskId === row.taskId && index === row.index
      )
    ) return;
    keys.push({ taskId: row.taskId, index: row.index });
  }
  return { args: call, rows: keys, totalSteps, nextOffset, sha256 };
}

export function readSentinelProvenanceSearchReference(value: unknown) {
  if (!value || typeof value !== "object") return;
  const { args, ids, totalNodes, nextOffset, sha256 } = value as Record<
    string,
    unknown
  >;
  if (!args || typeof args !== "object" || Array.isArray(args)) return;
  const call = sentinelGoalReceiptReadArguments(
    SENTINEL_PROVENANCE_SEARCH,
    args,
  );
  if (
    !call || !Array.isArray(ids) || ids.length > (call.limit ?? 10) ||
    new Set(ids).size !== ids.length ||
    !ids.every((id) =>
      typeof id === "string" && id.length > 0 && id.length <= 4096 &&
      !id.includes("\0") && redactCredentialText(id) === id
    ) ||
    typeof totalNodes !== "number" || !Number.isSafeInteger(totalNodes) ||
    totalNodes < 0 ||
    typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)
  ) return;
  const end = (call.offset ?? 0) + ids.length;
  if (
    !Number.isSafeInteger(end) ||
    nextOffset !== (end < totalNodes ? end : null) ||
    (ids.length ? end > totalNodes : end < totalNodes)
  ) return;
  return { args: call, ids: ids as string[], totalNodes, nextOffset, sha256 };
}

export function readSentinelProvenanceNodeReference(value: unknown) {
  if (!value || typeof value !== "object") return;
  const { args, connections, totalConnections, nextOffset, sha256 } =
    value as Record<string, unknown>;
  const call = sentinelGoalReceiptReadArguments(
    SENTINEL_PROVENANCE_NODE_READ,
    args,
  );
  if (
    !call?.node || !Array.isArray(connections) ||
    connections.length > (call.limit ?? 10) ||
    new Set(connections).size !== connections.length ||
    !connections.every((hash) =>
      typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)
    ) ||
    typeof totalConnections !== "number" ||
    !Number.isSafeInteger(totalConnections) ||
    totalConnections < 0 || typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(sha256)
  ) return;
  const end = (call.offset ?? 0) + connections.length;
  if (
    !Number.isSafeInteger(end) ||
    nextOffset !== (end < totalConnections ? end : null) ||
    (connections.length ? end > totalConnections : end < totalConnections)
  ) return;
  return {
    args: { ...call, node: call.node },
    connections: connections as string[],
    totalConnections,
    nextOffset,
    sha256,
  };
}

/** Verify the approved node page against its exact request and connection fingerprints. */
export function readSavedSentinelProvenanceNode(
  text: unknown,
  page: NonNullable<ReturnType<typeof readSentinelProvenanceNodeReference>>,
  revision?: number,
): string | undefined {
  if (
    typeof text !== "string" || text.length > 7000 ||
    redactCredentialText(text) !== text ||
    /"(?:githubWorkflowRead|resultSnapshot|sharedAssetLinksPage)"\s*:/.test(
      text,
    ) ||
    createHash("sha256").update(text).digest("hex") !== page.sha256
  ) return;
  try {
    const result = JSON.parse(text);
    if (
      !Number.isSafeInteger(result?.revision) || result.revision < 1 ||
      (revision !== undefined && result.revision !== revision) ||
      (page.args.revision !== undefined &&
        result.revision !== page.args.revision) ||
      Object.keys(result).length !== 6 || result.node?.id !== page.args.node ||
      result.offset !== (page.args.offset ?? 0) ||
      result.totalConnections !== page.totalConnections ||
      result.nextOffset !== page.nextOffset ||
      !Array.isArray(result.connections) ||
      result.connections.length !== page.connections.length ||
      result.connections.some((connection: unknown, index: number) =>
        createHash("sha256").update(JSON.stringify(connection)).digest(
          "hex",
        ) !== page.connections[index]
      )
    ) return;
    return text;
  } catch {
    return;
  }
}

/** Verify the exact bounded search projection against its retained receipt. */
export function readSavedSentinelProvenanceSearch(
  text: unknown,
  page: NonNullable<ReturnType<typeof readSentinelProvenanceSearchReference>>,
  revision?: number,
): string | undefined {
  if (
    typeof text !== "string" || text.length > 7000 ||
    redactCredentialText(text) !== text ||
    createHash("sha256").update(text).digest("hex") !== page.sha256
  ) return;
  try {
    const result = JSON.parse(text);
    if (
      !Number.isSafeInteger(result?.revision) || result.revision < 1 ||
      (revision !== undefined && result.revision !== revision) ||
      (page.args.revision !== undefined &&
        result.revision !== page.args.revision) ||
      Object.keys(result).length !== 5 ||
      result.totalNodes !== page.totalNodes ||
      result.offset !== (page.args.offset ?? 0) ||
      result.nextOffset !== page.nextOffset ||
      !Array.isArray(result.nodes) || result.nodes.length !== page.ids.length ||
      !result.nodes.every((node: Record<string, unknown>, index: number) =>
        node && Object.keys(node).length === 4 && node.id === page.ids[index] &&
        typeof node.label === "string" && node.label.length <= 256 &&
        typeof node.kind === "string" && typeof node.origin === "string" &&
        (page.args.kind === undefined || node.kind === page.args.kind) &&
        (page.args.origin === undefined || node.origin === page.args.origin)
      )
    ) return;
    return text;
  } catch {
    return;
  }
}
