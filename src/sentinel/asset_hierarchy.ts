/** Validate operator-declared inventory hierarchy without inferring remote assets. */

export const sentinelAssetTypes = [
  "root_domain",
  "subdomain",
  "ip",
  "service",
  "application",
  "endpoint",
] as const;

export type SentinelAssetType = typeof sentinelAssetTypes[number];

const parentTypes: Readonly<
  Record<SentinelAssetType, readonly SentinelAssetType[]>
> = {
  root_domain: [],
  subdomain: ["root_domain", "subdomain"],
  ip: [],
  service: ["root_domain", "subdomain", "ip"],
  application: ["service"],
  endpoint: ["service", "application"],
};

interface Asset {
  readonly id: string;
  readonly assetType?: SentinelAssetType;
  readonly parentId?: string;
}

/** Resolve exact parent IDs and reject missing, incompatible, or cyclic references. */
export function deriveSentinelAssetParents(assets: readonly Asset[]) {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const parents = new Map<string, string>();
  for (const { id, assetType, parentId } of assets) {
    if (parentId === undefined) continue;
    const parent = byId.get(parentId);
    if (!parent) {
      throw new Error("Sentinel asset parent must be an exact asset ID");
    }
    if (
      !assetType || !parent.assetType ||
      !parentTypes[assetType].includes(parent.assetType)
    ) {
      throw new Error("Incompatible Sentinel asset hierarchy types");
    }
    parents.set(id, parentId);
  }

  const checked = new Set<string>();
  for (const id of parents.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined && !checked.has(current)) {
      if (visited.has(current)) {
        throw new Error("Cyclic Sentinel asset hierarchy");
      }
      visited.add(current);
      current = parents.get(current);
    }
    for (const entry of visited) checked.add(entry);
  }

  return new Map([...parents].sort(([a], [b]) => a < b ? -1 : a === b ? 0 : 1));
}
