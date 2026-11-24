export type SentinelPathDirection = "both" | "outgoing" | "incoming";

/** Collect a bounded set of equally short paths through recorded relationships. */
export function alternateSentinelRelationshipPaths<
  N extends { readonly id: string },
  E extends {
    readonly from: string;
    readonly to: string;
    readonly relation: string;
  },
>(
  nodes: ReadonlyMap<string, N>,
  adjacency: ReadonlyMap<string, readonly E[]>,
  from: string,
  to: string,
  maxDepth: number,
  direction: SentinelPathDirection,
  relation: string | undefined,
  limit: number,
) {
  if (!nodes.has(from) || !nodes.has(to)) {
    throw new Error("Unknown Sentinel path endpoint");
  }
  if (
    !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 16 ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 10
  ) {
    throw new Error(
      "Sentinel alternate paths require depth 0 to 16 and limit 1 to 10",
    );
  }
  const allowed = relation === undefined
    ? undefined
    : new Set(relation.split(","));
  const distances = new Map([[from, 0]]);
  const predecessors = new Map<string, { id: string; edge: E }[]>();
  const queue = [from];
  for (const id of queue) {
    const distance = distances.get(id)!;
    if (distance >= maxDepth || distance >= (distances.get(to) ?? Infinity)) {
      break;
    }
    for (const edge of adjacency.get(id) ?? []) {
      if (allowed && !allowed.has(edge.relation)) continue;
      const next = edge.from === id
        ? direction === "incoming" ? undefined : edge.to
        : direction === "outgoing"
        ? undefined
        : edge.from;
      if (next === undefined) continue;
      if (!distances.has(next)) {
        distances.set(next, distance + 1);
        queue.push(next);
      }
      if (distances.get(next) !== distance + 1) continue;
      const entries = predecessors.get(next) ?? [];
      entries.push({ id, edge });
      predecessors.set(next, entries);
    }
  }

  const paths: { nodes: N[]; edges: E[] }[] = [];
  const visitedNodes: N[] = [];
  const visitedEdges: E[] = [];
  function visit(id: string) {
    visitedNodes.push(nodes.get(id)!);
    if (id === from) {
      paths.push({
        nodes: visitedNodes.map((node) => ({ ...node })).reverse(),
        edges: visitedEdges.map((edge) => ({ ...edge })).reverse(),
      });
    } else {
      for (const previous of predecessors.get(id) ?? []) {
        visitedEdges.push(previous.edge);
        visit(previous.id);
        visitedEdges.pop();
        if (paths.length > limit) break;
      }
    }
    visitedNodes.pop();
  }
  if (distances.has(to)) visit(to);
  return { paths: paths.slice(0, limit), truncated: paths.length > limit };
}
