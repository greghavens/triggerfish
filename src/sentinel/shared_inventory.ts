/** Read published assets across cases without importing other cases' evidence. */
import { MAX_EDGES, MAX_NODES } from "./assessment.ts";
import { dirname, join, resolve } from "@std/path";
import { createHash } from "node:crypto";
import {
  type SentinelAssetType,
  sentinelAssetTypes,
} from "./asset_hierarchy.ts";
import {
  isSentinelCaseId,
  listSentinelCaseIds,
  resolveSentinelCasePath,
} from "./cases.ts";
import { MAX_SNAPSHOT_BYTES, readSentinelChatSnapshot } from "./chat_mode.ts";
import { assetIdentityIndex, loadSentinelGraph } from "./graph.ts";
import { publishSentinelInput } from "./published_input.ts";
import {
  indexSharedSentinelTopologyEvidence,
  isSharedSentinelRelationship,
  sharedSentinelTopologyEvidenceId,
} from "./shared_topology_work.ts";
import {
  assertOperatorSourceDirectoryInfo,
  assertOperatorSourceSnapshot,
  assertOperatorSourceSnapshotInfo,
  operatorSourceDirectoryExists,
  withSentinelSourceSnapshotLock,
} from "./source_snapshot_lock.ts";

async function* publishedCaseGraphs(
  baseDir: string,
  unavailable: string[],
  signal?: AbortSignal,
  excludedSnapshot?: string,
) {
  for (const caseId of ["main", ...listSentinelCaseIds(baseDir)]) {
    signal?.throwIfAborted();
    try {
      const path = resolveSentinelCasePath(baseDir, caseId);
      if (
        excludedSnapshot !== undefined && resolve(path) === excludedSnapshot
      ) {
        continue;
      }
      const graph = loadSentinelGraph(await readSentinelChatSnapshot(path))
        .snapshot();
      yield { caseId, graph };
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) unavailable.push(caseId);
    }
  }
}

type InventorySource = {
  caseId: string;
  label: string;
  aliases?: readonly string[];
  assetId?: string;
  assetType?: Asset["assetType"];
  parentId?: string;
};

function groupInventoryAliases<T extends InventorySource>(
  records: Map<string, T[]>,
) {
  const keys = new Map<string, Set<string>>();
  for (const [id, sources] of records) {
    for (
      const key of [
        id,
        ...sources.flatMap(({ aliases }) => aliases ?? []),
      ]
    ) {
      const owners = keys.get(key) ?? new Set<string>();
      owners.add(id);
      keys.set(key, owners);
    }
  }

  const candidates = new Map<string, Set<string>>();
  const aliases = new Map<Set<string>, string>();
  for (const [key, owners] of keys) {
    if (owners.size < 2) continue;
    const cases = new Set<string>();
    let ambiguous = false;
    for (const id of owners) {
      for (const { caseId } of records.get(id)!) {
        if (cases.has(caseId)) ambiguous = true;
        cases.add(caseId);
      }
    }
    if (ambiguous) continue;
    aliases.set(owners, key);
    for (const id of owners) {
      const existing = candidates.get(id);
      if (!existing) candidates.set(id, owners);
      else if (
        existing.size !== owners.size ||
        [...existing].some((owner) => !owners.has(owner))
      ) {
        candidates.set(id, new Set());
      }
    }
  }

  for (const [id, owners] of candidates) {
    if (
      owners.size < 2 ||
      [...owners].some((owner) => candidates.get(owner)?.size !== owners.size)
    ) continue;
    // The same alias must be present in a single source for the display ID so
    // its relationship lookup can use that published snapshot as the anchor.
    const commonAlias = aliases.get(owners);
    if (commonAlias === undefined) continue;
    const canonical = [...owners].sort()[0];
    if (id !== canonical) continue;
    const sources = records.get(canonical)!;
    const anchor = sources.findIndex(({ aliases }) =>
      commonAlias === canonical || aliases?.includes(commonAlias)
    );
    if (anchor < 0) continue;
    if (anchor > 0) sources.unshift(...sources.splice(anchor, 1));
    for (const owner of [...owners].sort()) {
      if (owner === canonical) continue;
      sources.push(...records.get(owner)!.map((source) => ({
        ...source,
        assetId: owner,
      })));
      records.delete(owner);
    }
  }
}

function recordInventoryAssets(
  records: Map<string, InventorySource[]>,
  caseId: string,
  assets: readonly Asset[],
) {
  for (const { id, label, aliases, assetType, parentId } of assets) {
    const sources = records.get(id) ?? [];
    sources.push({
      caseId,
      label,
      ...(aliases && { aliases }),
      ...(assetType && { assetType }),
      ...(parentId && { parentId }),
    });
    records.set(id, sources);
  }
}

export async function readSharedSentinelAssets(
  baseDir: string,
  query: string,
  offset: number,
  limit: number,
) {
  const records = new Map<string, InventorySource[]>();
  const unavailable: string[] = [];
  const term = query.trim().toLowerCase();
  for await (
    const { caseId, graph } of publishedCaseGraphs(baseDir, unavailable)
  ) {
    recordInventoryAssets(
      records,
      caseId,
      graph.nodes.filter((node): node is Asset => node.kind === "asset"),
    );
  }
  groupInventoryAliases(records);
  const matches = [...records].filter(([id, sources]) =>
    !term || id.toLowerCase().includes(term) ||
    sources.some(({ label, caseId, aliases, assetId }) =>
      assetId?.toLowerCase().includes(term) ||
      label.toLowerCase().includes(term) || caseId.includes(term) ||
      aliases?.some((alias) => alias.toLowerCase().includes(term))
    )
  ).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const assets = matches.slice(offset, offset + limit).map(([id, sources]) => ({
    id,
    sources,
  }));
  return {
    assets,
    unavailable,
    offset,
    totalAssets: matches.length,
    nextOffset: offset + assets.length < matches.length
      ? offset + assets.length
      : null,
  };
}

export interface SharedSentinelAssetCatalogOptions {
  readonly caseId?: string;
  readonly organizationId?: string;
  readonly assetType?: SentinelAssetType;
  readonly parentId?: string;
  readonly alias?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

type CatalogSource = InventorySource & {
  assetId: string;
  organization?: Asset["organization"];
  snapshotDigest: string;
};

function catalogHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function compareCatalogIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** List asset groups with exact published sources and a manifest-bound cursor. */
export async function readSharedSentinelAssetCatalog(
  baseDir: string,
  options: SharedSentinelAssetCatalogOptions = {},
) {
  const { caseId, organizationId, assetType, parentId, alias, cursor } =
    options;
  const limit = options.limit ?? 20;
  if (caseId !== undefined && !isSentinelCaseId(caseId)) {
    throw new Error("Invalid Sentinel catalog case ID");
  }
  const textFilters = [[organizationId, 256], [parentId, 4096], [
    alias,
    4096,
  ]] as const;
  if (
    textFilters.some(([value, max]) =>
      value !== undefined &&
      (typeof value !== "string" || !value.trim() || value.length > max ||
        value.includes("\0"))
    ) || assetType !== undefined && !sentinelAssetTypes.includes(assetType)
  ) {
    throw new Error("Invalid Sentinel catalog asset filter");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30) {
    throw new Error("Invalid Sentinel catalog page size");
  }
  if (
    cursor !== undefined &&
    (typeof cursor !== "string" || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(cursor))
  ) {
    throw new Error("Invalid Sentinel catalog cursor");
  }
  const records = new Map<string, CatalogSource[]>();
  const unavailable: string[] = [];
  const manifest: [string, string][] = [];
  for await (
    const { caseId, graph } of publishedCaseGraphs(baseDir, unavailable)
  ) {
    const snapshotDigest = digestSentinelSnapshot(graph);
    manifest.push([caseId, snapshotDigest]);
    for (const node of graph.nodes) {
      if (node.kind !== "asset") continue;
      const { id, label, aliases, assetType, parentId, organization } = node;
      const sources = records.get(id) ?? [];
      sources.push({
        caseId,
        assetId: id,
        label,
        snapshotDigest,
        ...(aliases && { aliases }),
        ...(assetType && { assetType }),
        ...(parentId && { parentId }),
        ...(organization && { organization }),
      });
      records.set(id, sources);
    }
  }
  const manifestDigest = catalogHash([
    manifest.sort(([a], [b]) => compareCatalogIds(a, b)),
    unavailable.sort(),
  ]);
  const scope = catalogHash([
    resolve(baseDir),
    manifestDigest,
    caseId,
    organizationId,
    assetType,
    parentId,
    alias,
  ]);
  if (cursor !== undefined && !cursor.startsWith(scope + ".")) {
    throw new Error("Stale Sentinel catalog cursor");
  }
  // Preserve existing alias conflict detection across all published assets.
  groupInventoryAliases(records);
  const matches = [...records].flatMap(([id, sources]) => {
    const exact = sources.filter((source) =>
      (caseId === undefined || source.caseId === caseId) &&
      (organizationId === undefined ||
        source.organization?.id === organizationId) &&
      (assetType === undefined || source.assetType === assetType) &&
      (parentId === undefined || source.parentId === parentId) &&
      (alias === undefined || source.aliases?.includes(alias) === true)
    );
    if (!exact.length) return [];
    const anchor = exact.some((source) => source.assetId === id)
      ? id
      : exact[0].assetId;
    return [{ id: anchor, sources: exact }];
  }).sort((a, b) => compareCatalogIds(a.id, b.id));
  let start = 0;
  if (cursor !== undefined) {
    start = matches.findIndex(({ id }) =>
      catalogHash(id) === cursor.slice(65)
    ) + 1;
    if (!start) throw new Error("Invalid Sentinel catalog cursor anchor");
  }
  const assets = matches.slice(start, start + limit);
  const nextCursor = start + assets.length < matches.length
    ? scope + "." + catalogHash(assets[assets.length - 1].id)
    : null;
  return {
    assets,
    unavailable,
    manifestDigest,
    totalAssets: matches.length,
    nextCursor,
  };
}

export async function readSharedSentinelAssetLinks(
  baseDir: string,
  asset: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
  reference?: Snapshot,
  includeFindings = false,
  provenance?: {
    readonly excludedSnapshot?: string;
    readonly includeSourceDigests?: boolean;
    readonly retainSourceSnapshots?: boolean;
  },
) {
  const localAssets = reference?.nodes.filter((node): node is Asset =>
    node.kind === "asset"
  );
  const records = new Map<
    string,
    Snapshot["edges"][number] & {
      caseIds: string[];
      remapped?: RemappedEndpoint[];
    }
  >();
  const findings: {
    caseId: string;
    assetId: string;
    snapshotDigest: string;
    finding: Finding;
  }[] = [];
  const unavailable: string[] = [];
  const sources = new Map<string, {
    caseId: string;
    assetId: string;
    snapshotDigest: string;
    snapshot: Snapshot;
  }>();
  const visibleFindingSources = new Map<string, {
    caseId: string;
    snapshotDigest: string;
    snapshot: Snapshot;
  }>();
  const excludedSnapshot = provenance?.excludedSnapshot;
  for await (
    const { caseId, sourceAssets, matches, edges, snapshot }
      of resolvedAssetGraphs(
        baseDir,
        unavailable,
        localAssets,
        signal,
        includeFindings
          ? "findings"
          : provenance?.includeSourceDigests
          ? "topology"
          : undefined,
        excludedSnapshot === undefined ? undefined : resolve(excludedSnapshot),
      )
  ) {
    const anchor = matches
      ? sourceAssets.find(({ id }) => matches.get(id) === asset)?.id
      : asset;
    if (anchor === undefined) continue;
    if (includeFindings && snapshot) {
      const findingIds = new Set(
        snapshot.edges.filter(({ relation, to }) =>
          relation === "affects" && to === anchor
        ).map(({ from }) => from),
      );
      let snapshotDigest: string | undefined;
      for (const finding of snapshot.nodes) {
        if (finding.kind === "finding" && findingIds.has(finding.id)) {
          snapshotDigest ??= digestSentinelSnapshot(snapshot);
          if (
            provenance?.retainSourceSnapshots &&
            findings.length >= offset &&
            findings.length < offset + limit &&
            !visibleFindingSources.has(caseId)
          ) {
            visibleFindingSources.set(caseId, {
              caseId,
              snapshotDigest,
              snapshot,
            });
          }
          findings.push({ caseId, assetId: anchor, snapshotDigest, finding });
        }
      }
    }
    for (const edge of edges) {
      if (edge.from !== anchor && edge.to !== anchor) continue;
      if (
        provenance?.includeSourceDigests && snapshot &&
        !sources.has(caseId)
      ) {
        sources.set(caseId, {
          caseId,
          assetId: anchor,
          snapshotDigest: digestSentinelSnapshot(snapshot),
          snapshot,
        });
      }
      const from = matches?.get(edge.from) ?? edge.from;
      const to = matches?.get(edge.to) ?? edge.to;
      const key = JSON.stringify([from, edge.relation, to]);
      const linked = records.get(key) ?? { ...edge, from, to, caseIds: [] };
      linked.caseIds.push(caseId);
      if (from !== edge.from || to !== edge.to) {
        (linked.remapped ??= []).push({ caseId, from: edge.from, to: edge.to });
      }
      records.set(key, linked);
    }
  }
  const keys = [...records.keys()].sort();
  const links = keys.slice(offset, offset + limit).map((key) =>
    records.get(key)!
  );
  const nextOffset = offset + limit < Math.max(keys.length, findings.length)
    ? offset + limit
    : null;
  const pageSources = [...new Set(links.flatMap(({ caseIds }) => caseIds))]
    .flatMap((id) => sources.get(id) ?? []);
  const pageFindings = findings.slice(offset, offset + limit);
  if (
    provenance?.retainSourceSnapshots &&
    (pageSources.length || visibleFindingSources.size)
  ) {
    await withSentinelSourceSnapshotLock(baseDir, true, async () => {
      const retained = new Map(visibleFindingSources);
      for (const source of pageSources) retained.set(source.caseId, source);
      for (const { caseId, snapshotDigest, snapshot } of retained.values()) {
        signal?.throwIfAborted();
        await retainSentinelSourceSnapshot(
          baseDir,
          caseId,
          snapshotDigest,
          snapshot,
        );
      }
    });
  }
  return {
    asset,
    links,
    unavailable,
    offset,
    totalLinks: keys.length,
    ...(provenance?.includeSourceDigests && {
      sourceSnapshots: [...new Map(
        [...pageFindings, ...pageSources].map(
          ({ caseId, assetId, snapshotDigest }) => [
            JSON.stringify([caseId, assetId, snapshotDigest]),
            { caseId, assetId, snapshotDigest },
          ],
        ),
      ).values()],
    }),
    ...(includeFindings && {
      findings: pageFindings,
      totalFindings: findings.length,
    }),
    nextOffset,
  };
}

type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;
type RemappedEndpoint = {
  readonly caseId: string;
  readonly from: string;
  readonly to: string;
};

type SharedTopologyLink = Snapshot["edges"][number] & {
  readonly caseIds: readonly string[];
  readonly remapped?: readonly RemappedEndpoint[];
  readonly sourceDigests?: Readonly<Record<string, string>>;
};

type Asset = Extract<Snapshot["nodes"][number], { kind: "asset" }>;
type Finding = Extract<Snapshot["nodes"][number], { kind: "finding" }>;

function matchCaseAssets(local: readonly Asset[], source: readonly Asset[]) {
  const localIds = new Set(local.map(({ id }) => id));
  const localOwners = assetIdentityIndex(local);
  const sourceOwners = assetIdentityIndex(source);
  const matches = new Map<string, string>();
  const aliasCandidates = new Map<string, string[]>();
  for (const { id, aliases } of source) {
    if (localIds.has(id)) {
      matches.set(id, id);
      continue;
    }
    const candidates = new Set<string>();
    for (const key of [id, ...(aliases ?? [])]) {
      const owner = localOwners.get(key);
      if (owner && sourceOwners.get(key) === id) candidates.add(owner);
    }
    if (candidates.size !== 1) continue;
    const [candidate] = candidates;
    const owners = aliasCandidates.get(candidate) ?? [];
    owners.push(id);
    aliasCandidates.set(candidate, owners);
  }
  for (const [candidate, owners] of aliasCandidates) {
    if (owners.length === 1 && !matches.has(candidate)) {
      matches.set(owners[0], candidate);
    }
  }
  return matches;
}

export function digestSentinelSnapshot(snapshot: Snapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function sentinelSourceSnapshotDirectory(
  baseDir: string,
  quarantined = false,
) {
  return join(
    baseDir,
    "data",
    quarantined
      ? "sentinel-source-snapshots-quarantine"
      : "sentinel-source-snapshots",
  );
}

export function sentinelSourceSnapshotPath(
  baseDir: string,
  caseId: string,
  digest: string,
  quarantined = false,
) {
  if (!isSentinelCaseId(caseId) || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error("Invalid Sentinel source snapshot reference");
  }
  return join(
    sentinelSourceSnapshotDirectory(baseDir, quarantined),
    caseId,
    digest + ".json",
  );
}

export async function readSentinelSourceSnapshotFile(
  path: string,
  digest: string,
): Promise<Snapshot> {
  for (const parent of sourceSnapshotParents(path)) {
    if (!await operatorSourceDirectoryExists(parent)) {
      throw new Deno.errors.NotFound("Sentinel source archive does not exist");
    }
  }
  await assertOperatorSourceSnapshot(path);
  return verifiedSourceSnapshot(await readSentinelChatSnapshot(path), digest);
}

function sourceSnapshotParents(path: string) {
  const directory = dirname(path);
  const root = dirname(directory);
  return [dirname(root), root, directory];
}

function verifiedSourceSnapshot(raw: unknown, digest: string) {
  const graph = loadSentinelGraph(raw).snapshot();
  if (digestSentinelSnapshot(graph) !== digest) {
    throw new Error("Sentinel source snapshot integrity check failed");
  }
  return graph;
}

function readSentinelSourceSnapshotFileSync(path: string, digest: string) {
  for (const parent of sourceSnapshotParents(path)) {
    assertOperatorSourceDirectoryInfo(Deno.lstatSync(parent));
  }
  const info = Deno.lstatSync(path);
  assertOperatorSourceSnapshotInfo(info);
  if (info.size > MAX_SNAPSHOT_BYTES) {
    throw new Error("Sentinel source snapshot exceeds 1 MiB");
  }
  using file = Deno.openSync(path, { read: true });
  const opened = file.statSync();
  assertOperatorSourceSnapshotInfo(opened);
  if (opened.ino !== info.ino || opened.dev !== info.dev) {
    throw new Error("Sentinel source snapshot changed while opening");
  }
  const bytes = new Uint8Array(MAX_SNAPSHOT_BYTES + 1);
  let length = 0;
  while (length < bytes.length) {
    const count = file.readSync(bytes.subarray(length));
    if (count === null) break;
    length += count;
  }
  if (length > MAX_SNAPSHOT_BYTES) {
    throw new Error("Sentinel source snapshot exceeds 1 MiB");
  }
  const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true })
    .decode(bytes.subarray(0, length)));
  return verifiedSourceSnapshot(raw, digest);
}

export const sentinelArchivedTopologyFile = "topology-source-snapshots.json";
export const maxSentinelArchivedTopologyBytes = 16 * 1024 * 1024;

export const sentinelArchivedFindingSourcesFile =
  "finding-source-snapshots.json";

export const sentinelArchivedTraceSourcesFile = "trace-source-snapshots.json";

function readRestoredSourceSnapshot(
  casePath: string,
  caseId: string,
  digest: string,
): Snapshot {
  for (
    const name of [
      sentinelArchivedTopologyFile,
      sentinelArchivedFindingSourcesFile,
      sentinelArchivedTraceSourcesFile,
    ]
  ) {
    const path = join(dirname(casePath), name);
    assertOperatorSourceDirectoryInfo(Deno.lstatSync(dirname(path)));
    let info;
    try {
      info = Deno.lstatSync(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    assertOperatorSourceSnapshotInfo(info);
    if (info.size > maxSentinelArchivedTopologyBytes) {
      throw new Error("Invalid restored source bundle");
    }
    using file = Deno.openSync(path);
    const opened = file.statSync();
    assertOperatorSourceSnapshotInfo(opened);
    if (opened.ino !== info.ino || opened.dev !== info.dev) {
      throw new Error("Invalid restored source bundle");
    }
    const contents = new Uint8Array(info.size);
    for (let offset = 0; offset < contents.length;) {
      const read = file.readSync(contents.subarray(offset));
      if (read === null) throw new Error("Invalid restored source bundle");
      offset += read;
    }
    const entries = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(contents),
    );
    const entry = Array.isArray(entries) &&
      entries.find((item) => item?.caseId === caseId && item.digest === digest);
    if (entry) return verifiedSourceSnapshot(entry.snapshot, digest);
  }
  throw new Deno.errors.NotFound(
    "The restored case does not contain the source snapshot",
  );
}

export async function readArchivedSentinelSnapshot(
  baseDir: string,
  caseId: string,
  digest: string,
  restoredCasePath?: string,
): Promise<Snapshot> {
  const archived = sentinelSourceSnapshotPath(baseDir, caseId, digest);
  const quarantined = sentinelSourceSnapshotPath(baseDir, caseId, digest, true);
  try {
    return await readSentinelSourceSnapshotFile(archived, digest);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  try {
    return await readSentinelSourceSnapshotFile(quarantined, digest);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    try {
      return await readSentinelSourceSnapshotFile(archived, digest);
    } catch (missing) {
      if (!restoredCasePath || !(missing instanceof Deno.errors.NotFound)) {
        throw missing;
      }
      return readRestoredSourceSnapshot(restoredCasePath, caseId, digest);
    }
  }
}

/** Reconstruct only a relationship cited by an already-selected case graph. */
export async function readSharedSentinelTopologySource(
  baseDir: string,
  assignedGraph: Snapshot,
  evidenceId: string,
  sourceCase: string,
  restoredCasePath?: string,
) {
  const cited = indexSharedSentinelTopologyEvidence(assignedGraph).get(
    evidenceId,
  );
  if (!cited) return undefined;
  const evidence = assignedGraph.nodes.find(
    (node): node is Extract<Snapshot["nodes"][number], { kind: "evidence" }> =>
      node.kind === "evidence" && node.id === evidenceId,
  );
  const source = evidence?.relationshipSources?.find(({ caseId }) =>
    caseId === sourceCase
  );
  if (!source?.snapshotDigest) return undefined;

  const { caseId, snapshotDigest, from, to } = source;
  const archived = await readArchivedSentinelSnapshot(
    baseDir,
    caseId,
    snapshotDigest,
    restoredCasePath,
  );
  const relationship = { from, to, relation: cited.relation };
  if (
    !archived.edges.some((edge) =>
      edge.from === from && edge.to === to && edge.relation === cited.relation
    )
  ) return undefined;

  const endpointIds = new Set([from, to]);
  const endpoints = archived.nodes.flatMap((node) =>
    node.kind === "asset" && endpointIds.has(node.id)
      ? [{
        id: node.id,
        label: node.label.slice(0, 256),
        ...(node.assetType && { assetType: node.assetType }),
      }]
      : []
  );
  return {
    evidenceId,
    localRelationship: {
      from: cited.from,
      to: cited.to,
      relation: cited.relation,
    },
    archivedSource: { caseId, snapshotDigest, relationship, endpoints },
  };
}

export interface SharedSentinelFindingReference {
  readonly caseId: string;
  readonly snapshotDigest: string;
  readonly assetId: string;
  readonly findingId: string;
}

function reportedFindingExists(
  graph: Snapshot,
  { assetId, findingId }: SharedSentinelFindingReference,
) {
  // The graph loader has already validated both endpoint kinds.
  return graph.edges.some(({ from, to, relation }) =>
    from === findingId && to === assetId && relation === "affects"
  );
}

/** Resolve only the exact published or archived graph that reported a finding. */
export async function readSharedSentinelFindingSource(
  baseDir: string,
  reference: SharedSentinelFindingReference,
) {
  const { caseId, snapshotDigest } = reference;
  let graph: Snapshot;
  let published = false;
  try {
    graph = await readArchivedSentinelSnapshot(baseDir, caseId, snapshotDigest);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    try {
      const path = resolveSentinelCasePath(baseDir, caseId);
      await assertOperatorSourceSnapshot(path);
      graph = loadSentinelGraph(await readSentinelChatSnapshot(path))
        .snapshot();
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) {
        return { status: "source_unavailable" as const };
      }
      throw cause;
    }
    if (digestSentinelSnapshot(graph) !== snapshotDigest) {
      return { status: "source_changed" as const };
    }
    published = true;
  }

  if (!reportedFindingExists(graph, reference)) {
    return { status: "finding_unavailable" as const };
  }
  return { status: "available" as const, graph, published };
}

export interface PinnedSentinelSharedFindingReference
  extends SharedSentinelFindingReference {
  readonly localAssetId: string;
}

function matchPinnedFindingAssets(
  localAssets: readonly Asset[],
  archived: Snapshot,
) {
  return matchCaseAssets(
    localAssets,
    archived.nodes.filter((node): node is Asset => node.kind === "asset"),
  );
}

const MAX_CARRYOVER_FINDING_ARCHIVES = 32;

export type PinnedSentinelSharedFindingVerification =
  | "valid"
  | "invalid"
  | "deferred";

/**
 * Read up to 32 uncached archives per batch. Callers resume deferred tuples
 * with a new batch and retain completed tuple outcomes separately.
 */
export function createPinnedSentinelSharedFindingVerifier(
  baseDir: string,
  assigned: Snapshot,
  localCaseId: string,
  restoredCasePath?: string,
) {
  const localAssets = assigned.nodes.filter((node): node is Asset =>
    node.kind === "asset"
  );
  const localIds = new Set(localAssets.map(({ id }) => id));
  const archives = new Map<string, Set<string> | undefined>();
  let remaining = MAX_CARRYOVER_FINDING_ARCHIVES;
  const verify = (
    reference: PinnedSentinelSharedFindingReference,
  ): PinnedSentinelSharedFindingVerification => {
    const { caseId, snapshotDigest, localAssetId, assetId, findingId } =
      reference;
    if (caseId === localCaseId || !localIds.has(localAssetId)) return "invalid";
    const key = JSON.stringify([caseId, snapshotDigest]);
    let matchesInArchive = archives.get(key);
    if (archives.has(key)) {
      archives.delete(key);
    } else {
      if (remaining === 0) return "deferred";
      remaining--;
      try {
        const archived = sentinelSourceSnapshotPath(
          baseDir,
          caseId,
          snapshotDigest,
        );
        const quarantined = sentinelSourceSnapshotPath(
          baseDir,
          caseId,
          snapshotDigest,
          true,
        );
        let source: Snapshot | undefined;
        for (const path of [archived, quarantined, archived]) {
          try {
            source = readSentinelSourceSnapshotFileSync(path, snapshotDigest);
            break;
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
        }
        if (!source && restoredCasePath) {
          source = readRestoredSourceSnapshot(
            restoredCasePath,
            caseId,
            snapshotDigest,
          );
        }
        if (source) {
          const matches = matchPinnedFindingAssets(localAssets, source);
          matchesInArchive = new Set(
            source.edges.flatMap(({ from, to, relation }) => {
              const local = relation === "affects"
                ? matches.get(to)
                : undefined;
              return local ? [JSON.stringify([local, to, from])] : [];
            }),
          );
        }
      } catch {
        // Corrupt, unsafe, or unreadable input cannot authorize carryover.
      }
    }
    archives.set(key, matchesInArchive);
    if (archives.size > MAX_CARRYOVER_FINDING_ARCHIVES) {
      archives.delete(archives.keys().next().value!);
    }
    return matchesInArchive?.has(
        JSON.stringify([localAssetId, assetId, findingId]),
      )
      ? "valid"
      : "invalid";
  };
  return {
    verify,
    nextBatch() {
      remaining = MAX_CARRYOVER_FINDING_ARCHIVES;
    },
  };
}

/** Verify a trusted citation against the worker's assigned graph and retained source. */
export async function readPinnedSentinelSharedFindingSource(
  baseDir: string,
  assigned: Snapshot,
  reference: PinnedSentinelSharedFindingReference,
  localCaseId?: string,
  restoredCasePath?: string,
): Promise<Snapshot | undefined> {
  if (reference.caseId === localCaseId) return undefined;
  const localAssets = assigned.nodes.filter((node): node is Asset =>
    node.kind === "asset"
  );
  if (!localAssets.some(({ id }) => id === reference.localAssetId)) {
    return undefined;
  }
  let archived: Snapshot;
  try {
    archived = await readArchivedSentinelSnapshot(
      baseDir,
      reference.caseId,
      reference.snapshotDigest,
      restoredCasePath,
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  if (!reportedFindingExists(archived, reference)) return undefined;
  if (
    matchPinnedFindingAssets(localAssets, archived).get(reference.assetId) !==
      reference.localAssetId
  ) return undefined;
  return archived;
}

export async function retainSentinelSourceSnapshot(
  baseDir: string,
  caseId: string,
  digest: string,
  snapshot: Snapshot,
) {
  if (digestSentinelSnapshot(snapshot) !== digest) {
    throw new Error("Sentinel source snapshot digest mismatch");
  }
  try {
    await readArchivedSentinelSnapshot(baseDir, caseId, digest);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    await publishSentinelInput(
      sentinelSourceSnapshotPath(baseDir, caseId, digest),
      snapshot,
    );
  }
}

async function* resolvedAssetGraphs(
  baseDir: string,
  unavailable: string[],
  localAssets?: readonly Asset[],
  signal?: AbortSignal,
  includeSnapshot?: "topology" | "findings",
  excludedSnapshot?: string,
) {
  const inventory = new Map<string, InventorySource[]>();
  const published: {
    caseId: string;
    assets: Asset[];
    edges: Snapshot["edges"];
    snapshot?: Snapshot;
  }[] = [];
  for await (
    const { caseId, graph } of publishedCaseGraphs(
      baseDir,
      unavailable,
      signal,
      excludedSnapshot,
    )
  ) {
    const assets = graph.nodes.filter((node): node is Asset =>
      node.kind === "asset"
    );
    const ids = new Set(assets.map(({ id }) => id));
    if (localAssets) recordInventoryAssets(inventory, caseId, assets);
    // An export can include the case's synchronized overlay. Retain that
    // graph for exact source inspection, but do not count its inherited
    // relationships as new corroboration from the intermediate case.
    const inheritedKeys = new Set(
      [
        ...indexSharedSentinelTopologyEvidence(graph, {
          allowLegacySources: true,
        }).values(),
      ].map(({ from, to, relation }) => JSON.stringify([from, relation, to])),
    );
    const edges = graph.edges.filter(({ from, to, relation }) =>
      ids.has(from) && ids.has(to) &&
      (!inheritedKeys.size ||
        !inheritedKeys.has(JSON.stringify([from, relation, to])))
    );
    if (!edges.length && includeSnapshot !== "findings") continue;
    if (localAssets) {
      published.push({
        caseId,
        assets,
        edges,
        snapshot: includeSnapshot ? graph : undefined,
      });
    } else {
      yield {
        caseId,
        sourceAssets: assets,
        matches: undefined,
        edges,
        snapshot: includeSnapshot ? graph : undefined,
      };
    }
  }
  groupInventoryAliases(inventory);
  const known = new Map<string, string>();
  const localIds = new Set(localAssets?.map(({ id }) => id));
  for (const [id, sources] of inventory) {
    const ids = new Set([
      id,
      ...sources.flatMap(({ assetId }) => assetId ? [assetId] : []),
    ]);
    const local = [...ids].filter((id) => localIds.has(id));
    if (local.length !== 1) continue;
    for (const id of ids) known.set(id, local[0]);
  }
  for (const { caseId, assets: sourceAssets, edges, snapshot } of published) {
    signal?.throwIfAborted();
    const matches = localAssets && matchCaseAssets(localAssets, sourceAssets);
    if (matches) {
      const occupied = new Set(matches.values());
      for (const { id } of sourceAssets) {
        const target = known.get(id);
        if (target && !occupied.has(target) && !matches.has(id)) {
          matches.set(id, target);
          occupied.add(target);
        }
      }
    }
    yield { caseId, sourceAssets, matches, edges, snapshot };
  }
}

export async function collectSharedSentinelTopology(
  baseDir: string,
  caseId: string,
  localPath: string,
  signal?: AbortSignal,
  retainSnapshots = false,
) {
  const local = loadSentinelGraph(await readSentinelChatSnapshot(localPath))
    .snapshot();
  const localAssets = local.nodes.filter((node): node is Asset =>
    node.kind === "asset"
  );
  const links = new Map<
    string,
    Snapshot["edges"][number] & {
      caseIds: string[];
      remapped?: RemappedEndpoint[];
      sourceDigests?: Record<string, string>;
    }
  >();
  const unavailable: string[] = [];
  const archives: { caseId: string; digest: string; snapshot: Snapshot }[] = [];
  for await (
    const source of resolvedAssetGraphs(
      baseDir,
      unavailable,
      localAssets,
      signal,
      "topology",
    )
  ) {
    if (source.caseId === caseId) continue;
    let digest: string | undefined;
    for (const edge of source.edges) {
      // Shared relationship previews can show case-local hierarchy. Do not
      // import another case's parent declarations into the local overlay.
      if (!isSharedSentinelRelationship(edge.relation)) continue;
      const from = source.matches?.get(edge.from);
      const to = source.matches?.get(edge.to);
      if (!from || !to) continue;
      const key = JSON.stringify([from, edge.relation, to]);
      const existing = links.get(key) ??
        { from, to, relation: edge.relation, caseIds: [] };
      existing.caseIds.push(source.caseId);
      if (source.snapshot) {
        digest ??= digestSentinelSnapshot(source.snapshot);
        (existing.sourceDigests ??= {})[source.caseId] = digest;
      }
      if (from !== edge.from || to !== edge.to) {
        (existing.remapped ??= []).push({
          caseId: source.caseId,
          from: edge.from,
          to: edge.to,
        });
      }
      links.set(key, existing);
    }
    if (retainSnapshots && digest && source.snapshot) {
      archives.push({
        caseId: source.caseId,
        digest,
        snapshot: source.snapshot,
      });
    }
  }
  if (unavailable.length) {
    throw new Error("One or more published inventory sources are unavailable.");
  }
  const result = [...links.keys()].sort().map((key) => links.get(key)!);
  const preview = applySharedSentinelTopology(local, result);
  if (preview.nodes.length > MAX_NODES || preview.edges.length > MAX_EDGES) {
    throw new Error(
      "Shared asset relationships exceed the Sentinel assessment graph limit.",
    );
  }
  for (const { caseId, digest, snapshot } of archives) {
    signal?.throwIfAborted();
    await retainSentinelSourceSnapshot(baseDir, caseId, digest, snapshot);
  }
  return result;
}

/** Attach source records only to relationships whose endpoints still exist in the case. */
export function applySharedSentinelTopology(
  raw: unknown,
  topology: unknown,
): Snapshot {
  const local = loadSentinelGraph(raw).snapshot();
  if (!Array.isArray(topology)) {
    throw new Error("Invalid Sentinel shared topology");
  }
  const assets = new Set(
    local.nodes.filter(({ kind }) => kind === "asset").map(({ id }) => id),
  );
  const localIds = new Set(local.nodes.map(({ id }) => id));
  const edgeKeys = new Set(
    local.edges.map(({ from, relation, to }) =>
      JSON.stringify([from, relation, to])
    ),
  );
  const applied = new Set<string>();
  for (const link of topology as SharedTopologyLink[]) {
    const { from, to, relation, caseIds, remapped, sourceDigests } = link;
    if (!assets.has(from) || !assets.has(to)) continue;
    if (
      !isSharedSentinelRelationship(relation) ||
      !Array.isArray(caseIds) || !caseIds.length ||
      !caseIds.every(isSentinelCaseId)
    ) {
      throw new Error("Invalid Sentinel shared asset relationship");
    }
    const key = JSON.stringify([from, relation, to]);
    if (applied.has(key)) continue;
    applied.add(key);
    const id = sharedSentinelTopologyEvidenceId(from, relation, to);
    if (localIds.has(id)) {
      throw new Error(
        "Shared topology evidence ID conflicts with published inventory",
      );
    }
    localIds.add(id);
    const remappedSources = remapped?.filter((source) =>
      source && caseIds.includes(source.caseId) &&
      typeof source.from === "string" && typeof source.to === "string"
    ) ?? [];
    const sourceIds = remappedSources.map((source) =>
      `${source.caseId}: ${source.from.slice(0, 128)} → ${
        source.to.slice(0, 128)
      }`
    );
    const original = new Map(
      remappedSources.map((source) => [source.caseId, source]),
    );
    const relationshipSources = [...new Set(caseIds)].map((caseId) => {
      const source = original.get(caseId);
      const digest = sourceDigests?.[caseId];
      return {
        caseId,
        from: source?.from ?? from,
        to: source?.to ?? to,
        ...(typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest) && {
          snapshotDigest: digest,
        }),
      };
    });
    local.nodes.push({
      id,
      kind: "evidence",
      relationshipSources,
      label: `Shared asset relationship ${from.slice(0, 128)} ${relation} ${
        to.slice(0, 128)
      } reported by ${caseIds.join(", ")}${
        sourceIds.length ? ` (source IDs: ${sourceIds.join("; ")})` : ""
      }`,
    });
    if (!edgeKeys.has(key)) {
      local.edges.push({ from, to, relation });
    }
    for (const endpoint of new Set([from, to])) {
      local.edges.push({ from: id, to: endpoint, relation: "observed_on" });
    }
  }
  return local;
}
