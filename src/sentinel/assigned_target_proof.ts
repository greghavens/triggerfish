/** Check whether a pinned assigned-target evidence read still describes another revision. */
import { isDeepStrictEqual } from "node:util";
import type { loadSentinelGraph } from "./graph.ts";

type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;

function indexTargetLinks(graph: Snapshot, targetId: string) {
  const links = new Map<string, string[]>();
  for (const { from, to, relation } of graph.edges) {
    if (from !== targetId && to !== targetId) continue;
    const neighbor = from === targetId ? to : from;
    let relationships = links.get(neighbor);
    if (!relationships) links.set(neighbor, relationships = []);
    relationships.push(JSON.stringify([from, relation, to]));
  }
  for (const relationships of links.values()) relationships.sort();
  return links;
}

export function unchangedAssignedTargetEvidence(
  prior: Snapshot | undefined,
  current: Snapshot | undefined,
  targetId: string,
  evidenceIds: readonly string[],
): string[] {
  if (!prior || !current || !evidenceIds.length) return [];
  const before = new Map(prior.nodes.map((node) => [node.id, node]));
  const after = new Map(current.nodes.map((node) => [node.id, node]));
  const target = before.get(targetId);
  if (!target || !isDeepStrictEqual(target, after.get(targetId))) return [];
  const oldLinks = indexTargetLinks(prior, targetId);
  const newLinks = indexTargetLinks(current, targetId);
  return [...new Set(evidenceIds)].filter((id) => {
    if (id === targetId) return false;
    const evidence = before.get(id);
    const links = oldLinks.get(id);
    return evidence?.kind === "evidence" &&
      isDeepStrictEqual(evidence, after.get(id)) &&
      !!links?.length && isDeepStrictEqual(links, newLinks.get(id));
  });
}
