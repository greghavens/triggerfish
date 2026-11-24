/** Merge independently valid Sentinel graph snapshots into a canonical union. */
import { loadSentinelGraph } from "./graph.ts";

type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;
type Node = Snapshot["nodes"][number];
type Edge = Snapshot["edges"][number];

function lexicalOrder(left: string, right: string): number {
  if (left < right) return -1;
  return left === right ? 0 : 1;
}

export function mergeSentinelSnapshots(
  rawSnapshots: readonly unknown[],
): Snapshot {
  const nodes = new Map<string, { node: Node; source: number }>();
  const edges = new Map<string, Edge>();

  for (const [index, raw] of rawSnapshots.entries()) {
    const source = index + 1;
    let snapshot: Snapshot;
    try {
      snapshot = loadSentinelGraph(raw).snapshot();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Invalid graph";
      throw new Error(`Invalid Sentinel snapshot ${source}: ${message}`, {
        cause,
      });
    }

    for (const node of snapshot.nodes) {
      const prior = nodes.get(node.id);
      if (!prior) {
        nodes.set(node.id, { node, source });
        continue;
      }
      // The graph loader projects each node into a canonical representation.
      if (JSON.stringify(prior.node) !== JSON.stringify(node)) {
        throw new Error(
          `Conflicting Sentinel node ${
            JSON.stringify(node.id)
          } in snapshots ${prior.source} and ${source}`,
        );
      }
    }

    for (const edge of snapshot.edges) {
      edges.set(JSON.stringify([edge.from, edge.relation, edge.to]), edge);
    }
  }

  return {
    version: 1,
    nodes: [...nodes.values()].map(({ node }) => node)
      .sort((left, right) => lexicalOrder(left.id, right.id)),
    edges: [...edges.values()].sort((left, right) =>
      lexicalOrder(left.from, right.from) ||
      lexicalOrder(left.relation, right.relation) ||
      lexicalOrder(left.to, right.to)
    ),
  };
}
