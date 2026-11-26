import { isDeepStrictEqual } from "node:util";
import { readSentinelAssessmentRevision } from "./assessment_store.ts";
import { buildSentinelProvenance } from "./provenance.ts";
import type { readSentinelProvenanceNodeReference } from "./worker_goal_recovery.ts";

/** Check the whole saved page against the independent retained local graph. */
export function matchesPortableSentinelProvenanceNode(
  path: string,
  runId: string,
  revision: number,
  page: NonNullable<ReturnType<typeof readSentinelProvenanceNodeReference>>,
  text: string,
): boolean {
  const state = readSentinelAssessmentRevision(path, revision);
  if (state?.plan?.runId !== runId || !state.result) return false;
  const { node, offset = 0, limit = 10 } = page.args;
  const record = buildSentinelProvenance(state.result).inspect(node);
  if (
    record?.node.origin !== "imported" ||
    record.node.kind === "finding" ||
    record.connections.length !== page.totalConnections
  ) return false;
  return isDeepStrictEqual(JSON.parse(text), {
    revision,
    node: record.node,
    offset,
    totalConnections: record.connections.length,
    nextOffset: page.nextOffset,
    connections: record.connections.slice(offset, offset + limit),
  });
}
