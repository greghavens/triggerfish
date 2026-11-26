import { dirname, join } from "@std/path";
import { openSentinelAdaptiveStore } from "../sentinel/adaptive_store.ts";
import {
  readSentinelAssessmentRevision,
  readSentinelOperatingConstraints,
  readSentinelRunIdForRevision,
} from "../sentinel/assessment_store.ts";
import { sentinelOperatingConstraintsAllow } from "../sentinel/operating_constraints.ts";

/** Resolve worker evidence recipients independently of model-supplied selectors. */
export function readSentinelWorkerEvidenceScope(
  path: string,
  revision: number,
  assignmentId?: string,
) {
  const runId = readSentinelRunIdForRevision(path, revision);
  const snapshot = readSentinelAssessmentRevision(path, revision)?.result
    .sharedGraph.snapshot;
  if (!runId || !snapshot) return;
  const db = join(dirname(path), "sentinel-adaptive.db");
  try {
    Deno.lstatSync(db);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  const store = openSentinelAdaptiveStore(db);
  try {
    const mapping = store.forEvidence(revision);
    if (!mapping || mapping.goal.id !== runId) return;
    const tasks = store.list(mapping.revision);
    const asset = assignmentId &&
      tasks.find(({ id }) => id === assignmentId)?.nodeId;
    if (assignmentId && !asset) return;
    const controls = readSentinelOperatingConstraints(path, runId)?.constraints;
    return {
      runId,
      allowedTaskIds: tasks.filter(({ nodeId }) =>
        (!asset || asset === nodeId) &&
        sentinelOperatingConstraintsAllow(
          controls,
          { kind: "review_evidence", nodeId },
          snapshot,
        )
      ).map(({ id }) => id),
    };
  } finally {
    store.close();
  }
}
