/** Verify a reported discovery against exact evidence in an assigned graph. */
import { assetIdentityIndex, type loadSentinelGraph } from "./graph.ts";
import {
  normalizeSentinelAssetDiscoveryClaim,
  type SentinelAssetDiscoveryClaim,
} from "./asset_discovery_store.ts";

type Graph = ReturnType<typeof loadSentinelGraph>;
type Snapshot = ReturnType<Graph["snapshot"]>;
type Asset = Extract<Snapshot["nodes"][number], { kind: "asset" }>;
type Relationship = "depends_on" | "resolved_to" | "uses_hostname";

function readClaim(
  discovery: unknown,
): SentinelAssetDiscoveryClaim | undefined {
  try {
    const claim = normalizeSentinelAssetDiscoveryClaim(discovery);
    return Object.keys(discovery as object).length === Object.keys(claim).length
      ? claim
      : undefined;
  } catch {
    return undefined;
  }
}

function assetsOf(snapshot: Snapshot): readonly Asset[] {
  return snapshot.nodes.filter((node) => node.kind === "asset");
}

function compatibleRelation(
  source: Asset,
  target: Asset,
  relation: Relationship,
) {
  if (relation === "depends_on") return true;
  const hostname = relation === "resolved_to" ? source : target;
  const opposite = relation === "resolved_to" ? target : source;
  return (!hostname.assetType || hostname.assetType === "root_domain" ||
    hostname.assetType === "subdomain") &&
    (!opposite.assetType ||
      (relation === "resolved_to"
        ? opposite.assetType === "ip"
        : ["service", "application", "endpoint"].includes(opposite.assetType)));
}

function verifyClaim(
  source: Snapshot,
  claim: SentinelAssetDiscoveryClaim,
): boolean {
  const evidence = source.nodes.find((node) => node.id === claim.evidenceId);
  if (
    evidence?.kind !== "evidence" || evidence.relationshipSources?.length ||
    evidence.id.startsWith("shared-topology:")
  ) return false;
  const observed = new Set(
    source.edges.filter(
      ({ from, relation }) =>
        from === evidence.id && relation === "observed_on",
    ).map(({ to }) => to),
  );
  if (!observed.has(claim.assetId)) return false;
  if (claim.kind === "asset") return true;
  const assets = assetsOf(source);
  const asset = assets.find(({ id }) => id === claim.assetId);
  if (!asset) return false;
  if (claim.kind === "alias") {
    return asset.aliases?.includes(claim.alias) === true &&
      assetIdentityIndex(assets).get(claim.alias) === claim.assetId;
  }
  const target = assets.find(({ id }) => id === claim.to);
  return !!target && observed.has(claim.to) &&
    compatibleRelation(asset, target, claim.relation) &&
    source.edges.some(({ from, to, relation }) =>
      from === claim.assetId && to === claim.to && relation === claim.relation
    );
}

export function verifySentinelAssetDiscovery(
  source: Graph,
  discovery: unknown,
): SentinelAssetDiscoveryClaim | undefined {
  const claim = readClaim(discovery);
  return claim && verifyClaim(source.snapshot(), claim) ? claim : undefined;
}

function compatibleAssets(left: Asset, right: Asset) {
  return !left.assetType || !right.assetType ||
    left.assetType === right.assetType;
}

/** Prefer exact IDs and require every alias-based match to be one-to-one. */
function destinationMatches(
  source: readonly Asset[],
  destination: readonly Asset[],
) {
  const matches = new Map<string, string>();
  const localAssets = new Map(destination.map((asset) => [asset.id, asset]));
  const localOwners = assetIdentityIndex(destination);
  const sourceOwners = assetIdentityIndex(source);
  const aliasCandidates = new Map<string, string[]>();
  const singleDestination = new Set<string>();
  const exactIds = new Set<string>();
  for (const asset of source) {
    const exact = localAssets.get(asset.id);
    if (exact) {
      exactIds.add(exact.id);
      if (compatibleAssets(asset, exact)) matches.set(asset.id, exact.id);
      continue;
    }
    const candidates = new Set<string>();
    for (const key of [asset.id, ...(asset.aliases ?? [])]) {
      const other = localOwners.get(key);
      if (other && sourceOwners.get(key) === asset.id) candidates.add(other);
    }
    if (candidates.size === 1) singleDestination.add(asset.id);
    for (const id of candidates) {
      const owners = aliasCandidates.get(id) ?? [];
      owners.push(asset.id);
      aliasCandidates.set(id, owners);
    }
  }
  const reported = new Map(source.map((asset) => [asset.id, asset]));
  for (const [id, owners] of aliasCandidates) {
    if (
      owners.length === 1 && singleDestination.has(owners[0]) &&
      !exactIds.has(id) &&
      compatibleAssets(reported.get(owners[0])!, localAssets.get(id)!)
    ) matches.set(owners[0], id);
  }
  return matches;
}

export function matchSentinelAssetDiscoveryDestination(
  source: Graph,
  destination: Graph,
  discovery: unknown,
): {
  readonly claim: SentinelAssetDiscoveryClaim;
  readonly assetId: string;
  readonly to?: string;
} | undefined {
  const claim = readClaim(discovery);
  const sourceSnapshot = source.snapshot();
  if (!claim || !verifyClaim(sourceSnapshot, claim)) return undefined;
  const local = assetsOf(destination.snapshot());
  const matches = destinationMatches(assetsOf(sourceSnapshot), local);
  const assetId = matches.get(claim.assetId);
  if (!assetId) return undefined;
  if (claim.kind !== "relationship") return { claim, assetId };
  const to = matches.get(claim.to);
  if (!to || to === assetId) return undefined;
  const localAssets = new Map(local.map((asset) => [asset.id, asset]));
  return compatibleRelation(
      localAssets.get(assetId)!,
      localAssets.get(to)!,
      claim.relation,
    )
    ? { claim, assetId, to }
    : undefined;
}
