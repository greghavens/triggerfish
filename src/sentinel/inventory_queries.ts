/** Query explicitly published defensive asset inventory and review evidence. */
import { createHash } from "node:crypto";
import type { SentinelFindingReview } from "./assessment_store.ts";
import {
  type SentinelAssetType,
  sentinelAssetTypes,
} from "./asset_hierarchy.ts";
import { loadSentinelGraph } from "./graph.ts";
import { digestSentinelSnapshot } from "./shared_inventory.ts";

type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;
type Asset = Extract<Snapshot["nodes"][number], { kind: "asset" }>;
type Review = Pick<SentinelFindingReview, "id" | "disposition" | "at">;

interface PageOptions {
  readonly onlyAsset?: string;
  readonly cursor?: string;
  readonly limit?: number;
  /** Additional trusted case or assignment identity for this cursor. */
  readonly scopeBinding?: string;
}

export interface SentinelAssetInventoryOptions extends PageOptions {
  readonly organizationId?: string;
  readonly assetType?: SentinelAssetType;
  readonly parentId?: string;
  readonly alias?: string;
}

export interface SentinelAssetReviewCoverageOptions
  extends SentinelAssetInventoryOptions {
  readonly evidenceRevision: number;
  readonly reviewedAssetIds?: readonly string[];
  readonly evidenceReviewTasks?: readonly {
    readonly evidenceId: string;
    readonly taskId: string;
  }[];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validIdentifier(value: unknown, maxLength = 4096): boolean {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= maxLength && !value.includes("\0");
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function page<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  options: PageOptions,
  scope: unknown,
) {
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30) {
    throw new Error("Invalid Sentinel inventory page size");
  }
  if (
    options.scopeBinding !== undefined &&
    !validIdentifier(options.scopeBinding)
  ) {
    throw new Error("Invalid Sentinel inventory scope binding");
  }
  const scopeDigest = hash(JSON.stringify([scope, options.scopeBinding]));
  const ordered = [...items].sort((a, b) => compareIds(idOf(a), idOf(b)));
  let start = 0;
  if (options.cursor !== undefined) {
    const cursor = options.cursor;
    if (
      typeof cursor !== "string" ||
      !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(cursor) ||
      !cursor.startsWith(scopeDigest + ".")
    ) {
      throw new Error("Invalid or stale Sentinel inventory cursor");
    }
    start = ordered.findIndex((item) => hash(idOf(item)) === cursor.slice(65)) +
      1;
    if (!start) throw new Error("Invalid Sentinel inventory cursor anchor");
  }
  const results = ordered.slice(start, start + limit);
  const nextCursor = start + limit < ordered.length
    ? scopeDigest + "." + hash(idOf(results[results.length - 1]))
    : null;
  return { results, nextCursor };
}

function filterAssets(
  snapshot: Snapshot,
  options: SentinelAssetInventoryOptions,
) {
  const { onlyAsset, organizationId, assetType, parentId, alias } = options;
  for (const value of [onlyAsset, organizationId, parentId, alias]) {
    if (value !== undefined && !validIdentifier(value)) {
      throw new Error("Invalid Sentinel inventory filter");
    }
  }
  if (
    organizationId !== undefined && !validIdentifier(organizationId, 256) ||
    assetType !== undefined && !sentinelAssetTypes.includes(assetType)
  ) {
    throw new Error("Invalid Sentinel inventory filter");
  }
  const assets = snapshot.nodes.filter((node): node is Asset =>
    node.kind === "asset" &&
    (onlyAsset === undefined || node.id === onlyAsset) &&
    (organizationId === undefined ||
      node.organization?.id === organizationId) &&
    (assetType === undefined || node.assetType === assetType) &&
    (parentId === undefined || node.parentId === parentId) &&
    (alias === undefined || node.aliases?.includes(alias) === true)
  );
  return {
    assets,
    filters: [onlyAsset, organizationId, assetType, parentId, alias],
  };
}

/** List exact matching asset records from one canonical published snapshot. */
export function querySentinelAssetInventory(
  input: unknown,
  options: SentinelAssetInventoryOptions = {},
) {
  const snapshot = loadSentinelGraph(input).snapshot();
  const snapshotDigest = digestSentinelSnapshot(snapshot);
  const { assets, filters } = filterAssets(snapshot, options);
  const { results, nextCursor } = page(
    assets,
    (asset) => asset.id,
    options,
    ["assets", snapshotDigest, filters],
  );
  return { snapshotDigest, nextCursor, assets: results };
}

/** Group only explicit asset organization declarations in one snapshot. */
export function querySentinelOrganizations(
  input: unknown,
  options: SentinelAssetInventoryOptions = {},
) {
  const snapshot = loadSentinelGraph(input).snapshot();
  const snapshotDigest = digestSentinelSnapshot(snapshot);
  const { assets, filters } = filterAssets(snapshot, options);
  const organizations = new Map<
    string,
    { id: string; label: string; assetCount: number }
  >();
  for (const { organization } of assets) {
    if (!organization) continue;
    const previous = organizations.get(organization.id);
    if (previous) previous.assetCount++;
    else organizations.set(organization.id, { ...organization, assetCount: 1 });
  }
  const { results, nextCursor } = page(
    [...organizations.values()],
    (organization) => organization.id,
    options,
    ["organizations", snapshotDigest, filters],
  );
  return { snapshotDigest, nextCursor, organizations: results };
}

function addToGroup<T>(groups: Map<string, T[]>, key: string, value: T): void {
  const group = groups.get(key);
  if (group) group.push(value);
  else groups.set(key, [value]);
}

/** List observed evidence and independently verified review markers by exact asset. */
export function querySentinelAssetReviewCoverage(
  input: unknown,
  reviews: readonly SentinelFindingReview[],
  options: SentinelAssetReviewCoverageOptions,
) {
  const { evidenceRevision, reviewedAssetIds = [], evidenceReviewTasks = [] } =
    options;
  if (!Number.isSafeInteger(evidenceRevision) || evidenceRevision < 1) {
    throw new Error("Invalid Sentinel evidence revision");
  }
  const snapshot = loadSentinelGraph(input).snapshot();
  const snapshotDigest = digestSentinelSnapshot(snapshot);
  const { assets, filters } = filterAssets(snapshot, options);
  const latest = new Map<string, Review>();
  for (const { id, findingId, revision, disposition, at } of reviews) {
    if (
      revision !== evidenceRevision || (latest.get(findingId)?.id ?? 0) >= id
    ) continue;
    latest.set(findingId, { id, disposition, at });
  }
  const reviewed = new Set(reviewedAssetIds);
  const tasksByEvidence = new Map<string, string[]>();
  for (const assetId of reviewed) {
    if (!validIdentifier(assetId)) throw new Error("Invalid reviewed asset ID");
  }
  for (const { evidenceId, taskId } of evidenceReviewTasks) {
    if (!validIdentifier(evidenceId) || !validIdentifier(taskId)) {
      throw new Error("Invalid Sentinel evidence review task");
    }
    addToGroup(tasksByEvidence, evidenceId, taskId);
  }
  const assetFindings = new Map<string, string[]>();
  const assetEvidence = new Map<string, string[]>();
  const findingEvidence = new Map<string, string[]>();
  for (const { from, to, relation } of snapshot.edges) {
    if (relation === "affects") addToGroup(assetFindings, to, from);
    if (relation === "observed_on") addToGroup(assetEvidence, to, from);
    if (relation === "supports") addToGroup(findingEvidence, to, from);
  }
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  // Bind continuation to the supplied review overlay before projecting a page.
  const overlayDigest = hash(JSON.stringify([
    [...reviewed].sort(),
    [...latest].sort(([a], [b]) => compareIds(a, b)),
    [...tasksByEvidence].sort(([a], [b]) => compareIds(a, b)).map(
      ([id, taskIds]) => [id, [...new Set(taskIds)].sort()],
    ),
  ]));
  const { results, nextCursor } = page(
    assets,
    (asset) => asset.id,
    options,
    [
      "asset-review-coverage",
      snapshotDigest,
      evidenceRevision,
      filters,
      overlayDigest,
    ],
  );
  const visible = results.map((asset) => {
    const findings = (assetFindings.get(asset.id) ?? []).toSorted().map((
      id,
    ) => ({
      id,
      review: latest.get(id) ?? null,
    }));
    const direct = new Set(assetEvidence.get(asset.id) ?? []);
    const byEvidence = new Map<string, string[]>();
    for (const { id } of findings) {
      for (const evidenceId of findingEvidence.get(id) ?? []) {
        addToGroup(byEvidence, evidenceId, id);
      }
    }
    const evidence = [...new Set([...direct, ...byEvidence.keys()])].sort().map(
      (id) => {
        const node = nodes.get(id);
        const sourceSnapshots = node?.kind === "evidence"
          ? (node.relationshipSources ?? []).flatMap((
            { caseId, snapshotDigest, from, to },
          ) =>
            snapshotDigest === undefined
              ? []
              : [{ caseId, snapshotDigest, from, to }]
          )
          : [];
        return {
          id,
          direct: direct.has(id),
          supportsFindingIds: byEvidence.get(id) ?? [],
          reviewTaskIds: [...new Set(tasksByEvidence.get(id))].sort(),
          sourceSnapshots,
        };
      },
    );
    return { asset, reviewed: reviewed.has(asset.id), findings, evidence };
  });
  return { snapshotDigest, evidenceRevision, nextCursor, assets: visible };
}
