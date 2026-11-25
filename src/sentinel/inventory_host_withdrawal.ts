/** Compute an exact host withdrawal against a supplied inventory snapshot. */
import { isIP } from "node:net";
import { loadSentinelGraph } from "./graph.ts";
import { digestSentinelSnapshot } from "./shared_inventory.ts";

/** Canonical exact DNS name or IP address. URLs, wildcards and ports are invalid. */
export function normalizeSentinelWithdrawalHost(
  raw: unknown,
): string | undefined {
  if (typeof raw !== "string" || raw.length > 254) return;
  const ip = isIP(raw);
  if (ip === 4) return raw;
  if (ip === 6) return new URL(`http://[${raw}]/`).hostname.slice(1, -1);
  if (!/^[a-zA-Z0-9.-]+$/.test(raw)) return;
  const host = raw.toLowerCase().replace(/\.$/, "");
  if (
    host.length > 253 || !/[a-z]/.test(host) ||
    !host.split(".").every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
    )
  ) return;
  return host;
}

/** Resolve the host by declared identities and preserve independent observations. */
export function proposeSentinelInventoryHostWithdrawal(
  value: unknown,
  rawHost: unknown,
) {
  const host = normalizeSentinelWithdrawalHost(rawHost);
  if (!host) return;
  const previous = loadSentinelGraph(value).snapshot();
  const owners = previous.nodes.filter((node) =>
    node.kind === "asset" &&
    [node.id, ...(node.aliases ?? [])].some((identity) =>
      normalizeSentinelWithdrawalHost(identity) === host
    )
  );
  if (owners.length !== 1) return;
  const assetId = owners[0].id;
  const detachedChildIds: string[] = [];
  const nodes = previous.nodes.filter((node) => node.id !== assetId).map(
    (node) => {
      if (node.kind !== "asset" || node.parentId !== assetId) return node;
      detachedChildIds.push(node.id);
      const { parentId: _removedParent, ...detached } = node;
      return detached;
    },
  );
  const edges = previous.edges.filter(({ from, to }) =>
    from !== assetId && to !== assetId
  );
  const snapshot = loadSentinelGraph({ ...previous, nodes, edges }).snapshot();
  return {
    host,
    assetId,
    previousDigest: digestSentinelSnapshot(previous),
    nextDigest: digestSentinelSnapshot(snapshot),
    snapshot,
    removedEdges: previous.edges.length - edges.length,
    detachedChildIds: detachedChildIds.sort(),
  };
}
