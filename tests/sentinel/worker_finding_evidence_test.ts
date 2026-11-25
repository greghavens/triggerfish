import { assert, assertEquals } from "@std/assert";
import {
  readWorkerFindingRechecks,
  verifyWorkerFindingRecheck,
} from "../../src/sentinel/worker_finding_evidence.ts";

const scope = {
  caseId: "main",
  evidenceRevision: 12,
  evaluatedAt: "2026-06-03T00:00:00Z",
};
const claim = {
  findingId: "finding",
  assetId: "asset-a",
  controlId: "a-control",
  evidenceId: "current-a",
};

function check(
  id: string,
  outcome: "pass" | "fail",
  observedAt = "2026-06-02T00:00:00Z",
  validUntil = "2026-06-04T00:00:00Z",
) {
  return {
    id,
    kind: "evidence",
    label: id,
    controlVerification: { outcome, observedAt, validUntil },
  };
}

function sample() {
  return {
    version: 1,
    nodes: [
      { id: "finding", kind: "finding", label: "Finding", severity: "high" },
      {
        id: "other-finding",
        kind: "finding",
        label: "Other finding",
        severity: "high",
      },
      {
        id: "asset-a",
        kind: "asset",
        label: "Affected A",
        aliases: ["alias-a"],
      },
      { id: "asset-b", kind: "asset", label: "Affected B" },
      { id: "a-control", kind: "control", label: "First control" },
      { id: "b-control", kind: "control", label: "Second control" },
      { id: "other-control", kind: "control", label: "Disjoint control" },
      check("current-a", "fail"),
      check("prior-a", "pass", "2026-06-01T00:00:00Z"),
      check("current-b", "pass", "2026-06-03T00:00:00Z"),
      check("current-second", "pass"),
      check("unscoped", "pass", "2026-06-03T00:00:00Z"),
      check("future", "pass", "2026-06-04T00:00:00Z", "2026-06-06T00:00:00Z"),
    ],
    edges: [
      { from: "finding", to: "asset-a", relation: "affects" },
      { from: "finding", to: "asset-b", relation: "affects" },
      { from: "other-finding", to: "asset-a", relation: "affects" },
      { from: "a-control", to: "finding", relation: "mitigates" },
      { from: "b-control", to: "finding", relation: "mitigates" },
      { from: "other-control", to: "other-finding", relation: "mitigates" },
      ...["current-a", "prior-a", "current-b", "unscoped", "future"].map((
        from,
      ) => ({ from, to: "a-control", relation: "verifies" })),
      { from: "current-second", to: "b-control", relation: "verifies" },
      ...["current-a", "prior-a", "future", "current-second"].map((from) => ({
        from,
        to: "asset-a",
        relation: "observed_on",
      })),
      { from: "current-b", to: "asset-b", relation: "observed_on" },
    ],
  };
}

Deno.test("Worker recheck issues an exact asset-scoped receipt from the retained snapshot", () => {
  const snapshot = sample();
  const verified = verifyWorkerFindingRecheck(snapshot, scope, claim);
  assert(verified);
  assertEquals(verified, {
    ...claim,
    caseId: "main",
    evidenceRevision: 12,
    evaluatedAt: "2026-06-03T00:00:00.000Z",
    snapshotDigest: verified.snapshotDigest,
    outcome: "fail",
    observedAt: "2026-06-02T00:00:00.000Z",
    validUntil: "2026-06-04T00:00:00.000Z",
  });
  assert(/^[0-9a-f]{64}$/.test(verified.snapshotDigest));
  for (
    const changes of [
      { assetId: "alias-a" },
      { assetId: "asset-b" },
      { findingId: "other-finding" },
      { controlId: "other-control" },
      { evidenceId: "prior-a" },
      { evidenceId: "unscoped" },
      { evidenceId: "future" },
    ]
  ) {
    assertEquals(
      verifyWorkerFindingRecheck(snapshot, scope, { ...claim, ...changes }),
      undefined,
    );
  }
  const other = verifyWorkerFindingRecheck(snapshot, scope, {
    ...claim,
    assetId: "asset-b",
    evidenceId: "current-b",
  });
  assertEquals(other?.outcome, "pass");
  assertEquals(other?.snapshotDigest, verified.snapshotDigest);
});

Deno.test("Worker recheck never falls back from an expired new check or favors a tied pass", () => {
  const snapshot = sample();
  snapshot.nodes.push(check("same-time-pass", "pass"));
  snapshot.edges.push(
    { from: "same-time-pass", to: "a-control", relation: "verifies" },
    { from: "same-time-pass", to: "asset-a", relation: "observed_on" },
  );
  assertEquals(
    verifyWorkerFindingRecheck(snapshot, scope, {
      ...claim,
      evidenceId: "same-time-pass",
    }),
    undefined,
  );
  assertEquals(
    verifyWorkerFindingRecheck(snapshot, {
      ...scope,
      evaluatedAt: "2026-06-06T00:00:00Z",
    }, claim),
    undefined,
  );
  assertEquals(
    verifyWorkerFindingRecheck(
      snapshot,
      { ...scope, evidenceRevision: 0 },
      claim,
    ),
    undefined,
  );
});

Deno.test("Worker recheck page keeps control order and rejects altered snapshot continuations", () => {
  const snapshot = sample();
  const first = readWorkerFindingRechecks(snapshot, scope, {
    ...claim,
    limit: 1,
  });
  assert(first);
  assertEquals(first.receipts.map(({ controlId }) => controlId), ["a-control"]);
  assertEquals(first.nextControlId, "a-control");
  const continuation = {
    ...claim,
    limit: 1,
    afterControlId: "a-control",
    snapshotDigest: first.snapshotDigest,
  };
  const next = readWorkerFindingRechecks(snapshot, scope, continuation);
  assert(next);
  assertEquals(next.receipts.map(({ controlId }) => controlId), ["b-control"]);
  assertEquals(next.nextControlId, null);
  snapshot.nodes.push({ id: "new", kind: "asset", label: "Unaffected" });
  assertEquals(
    readWorkerFindingRechecks(snapshot, scope, continuation),
    undefined,
  );
});
