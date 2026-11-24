/** Identify exact, digest-backed shared topology evidence for local investigations. */

import { createHash } from "node:crypto";
import type { loadSentinelGraph } from "./graph.ts";

type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;
type SharedRelationship = "depends_on" | "resolved_to" | "uses_hostname";

interface SharedTopologyEvidence {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly relation: SharedRelationship;
}

export function isSharedSentinelRelationship(
  relation: string,
): relation is SharedRelationship {
  return relation === "depends_on" || relation === "resolved_to" ||
    relation === "uses_hostname";
}

export function sharedSentinelTopologyEvidenceId(
  from: string,
  relation: SharedRelationship,
  to: string,
): string {
  return `shared-topology:${
    createHash("sha256").update(JSON.stringify([from, relation, to])).digest(
      "hex",
    )
  }`;
}

function endpointKey(endpoints: Iterable<string>): string {
  return JSON.stringify([...new Set(endpoints)].sort());
}

/**
 * Match the evidence ID and observed endpoints to one actual directed edge.
 * Legacy records can identify inherited relationships, without becoming
 * digest-backed inputs to new investigations.
 */
export function indexSharedSentinelTopologyEvidence(
  snapshot: Snapshot,
  options: { readonly allowLegacySources?: boolean } = {},
): ReadonlyMap<string, SharedTopologyEvidence> {
  const reported = new Map(
    snapshot.nodes.flatMap((node) =>
      node.kind === "evidence" &&
        /^shared-topology:[a-f0-9]{64}$/.test(node.id) &&
        node.relationshipSources?.some(({ snapshotDigest }) =>
          options.allowLegacySources || snapshotDigest !== undefined
        )
        ? [[node.id, new Set<string>()] as const]
        : []
    ),
  );
  const reviews = new Map<string, SharedTopologyEvidence>();
  if (!reported.size) return reviews;

  for (const { from, to, relation } of snapshot.edges) {
    if (relation === "observed_on") reported.get(from)?.add(to);
  }

  const observed = new Map(
    [...reported].flatMap(([id, endpoints]) =>
      endpoints.size === 1 || endpoints.size === 2
        ? [[id, endpointKey(endpoints)] as const]
        : []
    ),
  );
  const pairs = new Set(observed.values());
  for (const { from, to, relation } of snapshot.edges) {
    if (!isSharedSentinelRelationship(relation)) continue;
    const endpoints = endpointKey([from, to]);
    if (!pairs.has(endpoints)) continue;
    const id = sharedSentinelTopologyEvidenceId(from, relation, to);
    if (observed.get(id) === endpoints) {
      reviews.set(id, { id, from, to, relation });
    }
  }
  return reviews;
}
