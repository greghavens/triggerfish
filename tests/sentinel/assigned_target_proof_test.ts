import { assertEquals } from "@std/assert";
import { unchangedAssignedTargetEvidence } from "../../src/sentinel/assigned_target_proof.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";

const target = { id: "service", kind: "asset", label: "Service" };
const stable = { id: "stable", kind: "evidence", label: "Stable record" };
const changed = { id: "changed", kind: "evidence", label: "Original record" };
const unlinked = {
  id: "unlinked",
  kind: "evidence",
  label: "Disconnected record",
};
const moved = { id: "moved", kind: "evidence", label: "Moved record" };
const parent = { id: "parent", kind: "asset", label: "Parent" };
const sourceLink = (from: string, to = target.id) => ({
  from,
  to,
  relation: "observed_on",
});
const graph = (nodes: unknown[], edges: unknown[]) =>
  loadSentinelGraph({ version: 1, nodes, edges }).snapshot();

Deno.test("Assigned target proof requires the same exact evidence and direct relationships in both revisions", () => {
  const prior = graph(
    [target, stable, changed, unlinked, moved, parent],
    [sourceLink(stable.id), sourceLink(changed.id), sourceLink(moved.id)],
  );
  const current = graph(
    [
      parent,
      stable,
      target,
      { ...changed, label: "Updated record" },
      unlinked,
      moved,
    ],
    [
      sourceLink(moved.id, parent.id),
      sourceLink(changed.id),
      sourceLink(stable.id),
    ],
  );
  assertEquals(
    unchangedAssignedTargetEvidence(
      prior,
      current,
      target.id,
      [changed.id, stable.id, unlinked.id, stable.id, moved.id, parent.id],
    ),
    [stable.id],
  );
  assertEquals(
    unchangedAssignedTargetEvidence(prior, undefined, target.id, [stable.id]),
    [],
  );
  const changedTarget = graph(
    [{ ...target, aliases: ["new-name"] }, stable],
    [sourceLink(stable.id)],
  );
  assertEquals(
    unchangedAssignedTargetEvidence(prior, changedTarget, target.id, [
      stable.id,
    ]),
    [],
  );
  const aliasReplacement = graph(
    [{ ...target, id: "replacement", aliases: [target.id] }, stable],
    [sourceLink(stable.id, "replacement")],
  );
  assertEquals(
    unchangedAssignedTargetEvidence(prior, aliasReplacement, target.id, [
      stable.id,
    ]),
    [],
  );
});
