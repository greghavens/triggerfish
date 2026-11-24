import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createHash } from "node:crypto";
import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
  readHistoricalAdaptiveSentinel,
  readSentinelProvenance,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  type AdaptiveVerificationReviewCandidate,
  openSentinelAdaptiveStore,
  sentinelAdaptiveTaskId,
} from "../../src/sentinel/adaptive_store.ts";
import {
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";

Deno.test("A verification source can be attached during an evidence lease without changing the task", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.db");
  const revision = "revision-one";
  const first = {
    kind: "verify_control_coverage",
    nodeId: "finding-a",
  } as const;
  const second = {
    kind: "verify_control_coverage",
    nodeId: "finding-b",
  } as const;
  const firstId = sentinelAdaptiveTaskId(revision, first);
  const secondId = sentinelAdaptiveTaskId(revision, second);
  const target = {
    kind: "review_evidence",
    nodeId: "check",
    prerequisites: [firstId],
    evidenceIds: ["check"],
  } as const;
  const targetId = sentinelAdaptiveTaskId(revision, target);
  const observation = {
    controlVerification: {
      controls: [{ status: "fail", evidenceId: "check" }],
    },
  };
  const sourceObservationDigest = createHash("sha256")
    .update(JSON.stringify(observation)).digest("hex");
  const citation = (sourceId: string): AdaptiveVerificationReviewCandidate => ({
    sourceId,
    targetId,
    evidenceId: "check",
    sourceObservationDigest,
  });
  const store = openSentinelAdaptiveStore(path);
  try {
    store.sync(revision, [first, target, second], null);
    const firstClaim = store.claim(revision);
    assert(firstClaim);
    assertEquals(firstClaim.task.id, firstId);
    assert(
      store.complete({
        taskId: firstId,
        leaseToken: firstClaim.leaseToken,
        observation,
      }),
    );
    store.sync(revision, [], revision, undefined, [], [citation(firstId)]);

    const targetClaim = store.claim(revision);
    assert(targetClaim);
    assertEquals(targetClaim.task.id, targetId);
    const secondClaim = store.claim(revision);
    assert(secondClaim);
    assertEquals(secondClaim.task.id, secondId);
    assert(
      store.complete({
        taskId: secondId,
        leaseToken: secondClaim.leaseToken,
        observation,
      }),
    );

    store.sync(revision, [], revision, undefined, [], [
      { ...citation(secondId), evidenceId: "different-check" },
      { ...citation(secondId), sourceObservationDigest: "0".repeat(64) },
    ]);
    assertEquals(store.verificationReviewSources(revision).length, 1);

    store.sync(revision, [], revision, undefined, [], [
      citation(secondId),
      citation(secondId),
    ]);
    const retained = store.list(revision).find(({ id }) => id === targetId);
    assertEquals(retained, targetClaim.task);
    assert(store.complete({
      taskId: targetId,
      leaseToken: targetClaim.leaseToken,
      observation: { relatedNodeIds: ["check"] },
    }));
    assertEquals(
      store.verificationReviewSources(revision).map(({ sourceId }) => sourceId)
        .sort(),
      [firstId, secondId].sort(),
    );
    assertEquals(
      store.recentActivity(100, revision).filter(({ event }) =>
        event === "evidence_attached"
      ).length,
      2,
    );
    store.sync("revision-two", [], revision, undefined, [], [
      citation(firstId),
    ]);
    assertEquals(store.verificationReviewSources("revision-two"), []);
    assertEquals(store.verificationReviewSources(revision).length, 2);
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("A deduplicated failed check retains both verification workers in live and archived revisions", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "graph.json");
  const secondMitigation = {
    from: "control",
    relation: "mitigates",
    to: "finding-b",
  };
  const snapshot = {
    version: 1,
    nodes: [
      { id: "finding-a", kind: "finding", label: "Finding A", severity: "low" },
      { id: "finding-b", kind: "finding", label: "Finding B", severity: "low" },
      { id: "control", kind: "control", label: "Shared mitigation" },
      {
        id: "check",
        kind: "evidence",
        label: "Failed verification",
        controlVerification: {
          outcome: "fail",
          observedAt: "2000-01-01T00:00:00Z",
          validUntil: "2200-01-01T00:00:00Z",
        },
      },
    ],
    edges: [
      { from: "control", relation: "mitigates", to: "finding-a" },
      secondMitigation,
      { from: "check", relation: "verifies", to: "control" },
    ],
  };
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const current = readAdaptiveSentinel(path, state)!;
    const reviews = current.tasks.filter(({ kind }) =>
      kind === "review_evidence"
    );
    assertEquals(reviews.length, 1);
    const [target] = reviews;
    const verification = current.tasks.filter(({ kind }) =>
      kind === "verify_control_coverage"
    );
    assertEquals(verification.length, 2);
    assertEquals(target.nodeId, "check");
    assertEquals(target.prerequisites.length, 1);
    assertEquals(
      current.verificationReviewSources.map(({ sourceId }) => sourceId).sort(),
      verification.map(({ id }) => id).sort(),
    );
    assert(
      current.verificationReviewSources.every(({ targetId, evidenceId }) =>
        targetId === target.id && evidenceId === "check"
      ),
    );
    assertEquals(target.attempts, 1);
    assertEquals(target.status, "completed");
    const targetRef = `task:adaptive:${target.id}`;
    const sourceRefs = verification.map(({ id }) =>
      `observation:adaptive:${id}`
    )
      .sort();
    const sourceEdges = (revision?: number) => {
      const provenance = readSentinelProvenance(path, revision);
      assert(provenance);
      return provenance.graph.snapshot().edges.filter((
        { from, to, relation },
      ) =>
        to === targetRef && relation === "prompted" &&
        from.startsWith("observation:adaptive:")
      ).map(({ from }) => from).sort();
    };
    assertEquals(sourceEdges(), sourceRefs);

    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...snapshot,
        edges: snapshot.edges.filter((edge) => edge !== secondMitigation),
      }),
    );
    const revised = refreshSentinelAssessment(path);
    assert(revised && revised.revision > state.revision);
    advanceAdaptiveSentinel(path, revised);
    const revisedView = readAdaptiveSentinel(path, revised)!;
    assertEquals(revisedView.verificationReviewSources.length, 1);
    assert(
      !revisedView.verificationReviewSources.some(({ targetId, sourceId }) =>
        targetId === target.id || verification.some(({ id }) => id === sourceId)
      ),
    );
    assertEquals(
      readHistoricalAdaptiveSentinel(path, state.revision)
        ?.verificationReviewSources,
      current.verificationReviewSources,
    );
    assertEquals(sourceEdges(state.revision), sourceRefs);
    assertEquals(sourceEdges(), []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
