/** Link captured HTTP origins to hostnames observed by passive DNS collectors. */
import type { loadSentinelGraph } from "./graph.ts";

type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;

export function enrichSentinelNetworkAssets(
  snapshot: Snapshot,
  maxEdges: number,
): Snapshot {
  const capacity = maxEdges - snapshot.edges.length;
  if (capacity <= 0) return snapshot;

  const dnsAnswers = new Set(
    snapshot.edges.filter(({ relation }) => relation === "resolved_to").map((
      { from },
    ) => from),
  );
  const capturedOrigins = new Set(
    snapshot.edges.filter(({ from, relation }) =>
      relation === "observed_on" && from.startsWith("har:evidence:")
    ).map(({ to }) => to),
  );
  const dnsNames = new Map<string, string[]>();
  for (const node of snapshot.nodes) {
    if (
      node.kind !== "asset" || !node.id.startsWith("dns:name:") ||
      !dnsAnswers.has(node.id)
    ) continue;
    const names = dnsNames.get(node.label) ?? [];
    names.push(node.id);
    dnsNames.set(node.label, names);
  }

  const links: Snapshot["edges"] = [];
  const existing = new Set(
    snapshot.edges.filter(({ relation }) => relation === "uses_hostname").map((
      { from, to },
    ) => JSON.stringify([from, to])),
  );
  for (const node of snapshot.nodes) {
    if (
      node.kind !== "asset" || !node.id.startsWith("har:asset:") ||
      !capturedOrigins.has(node.id)
    ) continue;
    const origin = URL.parse(node.label);
    if (
      !origin ||
      (origin.protocol !== "http:" && origin.protocol !== "https:") ||
      origin.origin !== node.label
    ) continue;
    const name = origin.hostname.replace(/\.$/, "");
    for (const hostname of dnsNames.get(name) ?? []) {
      if (existing.has(JSON.stringify([node.id, hostname]))) continue;
      links.push({ from: node.id, to: hostname, relation: "uses_hostname" });
      if (links.length >= capacity) {
        return { ...snapshot, edges: [...snapshot.edges, ...links] };
      }
    }
  }
  return links.length
    ? { ...snapshot, edges: [...snapshot.edges, ...links] }
    : snapshot;
}
