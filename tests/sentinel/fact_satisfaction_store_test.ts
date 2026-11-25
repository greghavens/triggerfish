import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createHash } from "node:crypto";
import {
  openSentinelAdaptiveStore,
  sentinelAdaptiveTaskId,
} from "../../src/sentinel/adaptive_store.ts";

Deno.test("Equivalent pinned trace facts satisfy only the exact eligible queue head", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  const revision = "evidence:1";
  const evidence = "evidence:exact";
  const reason = "model fixture";
  const review = { kind: "review_evidence" as const, nodeId: evidence };
  const trace = { kind: "trace" as const, nodeId: evidence, depth: 1 };
  const defaultTrace = { kind: "trace" as const, nodeId: evidence };
  const work = { kind: "trace" as const, nodeId: "pending" };
  const workId = sentinelAdaptiveTaskId(revision, work);
  const observation = {
    relatedNodeIds: [evidence],
    trace: {
      nodes: [{
        id: evidence,
        kind: "evidence",
        label: "Recorded fact",
        distance: 0,
      }],
      edges: [],
      nodeCount: 1,
      edgeCount: 0,
      truncated: false,
    },
  };
  try {
    const store = openSentinelAdaptiveStore(path);
    try {
      const [source, prerequisite, wrongDepth, target] = store.sync(revision, [
        review,
        work,
        defaultTrace,
        { ...trace, reason, prerequisites: [workId] },
      ]);
      const sourceLease = store.claim(revision)!;
      assertEquals(sourceLease.task.id, source.id);
      const correctDigest = createHash("sha256").update(
        JSON.stringify(observation),
      ).digest("hex");
      const proof = {
        taskId: target.id,
        sourceTaskId: source.id,
        sourceObservationSha256: correctDigest,
      };
      assert(!store.satisfyQueuedTaskFromFact(revision, proof));
      store.complete({
        taskId: source.id,
        leaseToken: sourceLease.leaseToken,
        observation,
      });
      assert(
        !store.satisfyQueuedTaskFromFact(
          revision,
          proof,
          new Set([prerequisite.id, wrongDepth.id]),
        ),
      );
      const otherLease = store.claim(revision)!;
      assertEquals(otherLease.task.id, prerequisite.id);
      store.complete({
        taskId: prerequisite.id,
        leaseToken: otherLease.leaseToken,
        observation: {},
      });
      assertEquals(store.peekNextClaimable(revision)?.id, wrongDepth.id);
      assert(
        !store.satisfyQueuedTaskFromFact(revision, {
          ...proof,
          taskId: wrongDepth.id,
        }),
      );
      assert(!store.satisfyQueuedTaskFromFact(revision, proof));
      const excluded = new Set([wrongDepth.id]);
      assertEquals(store.peekNextClaimable(revision, excluded)?.id, target.id);
      assert(
        !store.satisfyQueuedTaskFromFact(revision, {
          ...proof,
          sourceObservationSha256: "a".repeat(64),
        }, excluded),
      );
      assert(store.satisfyQueuedTaskFromFact(revision, proof, excluded));
      assert(!store.satisfyQueuedTaskFromFact(revision, proof, excluded));
      assertEquals(store.claimModelReview(revision, reason), null);
    } finally {
      store.close();
    }

    const reopened = openSentinelAdaptiveStore(path);
    try {
      const target = reopened.list(revision).find(({ id }) =>
        id === sentinelAdaptiveTaskId(revision, trace)
      )!;
      assertEquals(target.status, "completed");
      assertEquals(target.attempts, 0);
      assertEquals(target.prerequisites, [workId]);
      assertEquals(target.observation, observation);
      assertEquals(target.factSatisfaction, {
        sourceTaskId: sentinelAdaptiveTaskId(revision, review),
        sourceObservationSha256: createHash("sha256").update(
          JSON.stringify(observation),
        ).digest("hex"),
      });
      assertEquals(
        reopened.history(revision).filter(({ taskId }) => taskId === target.id)
          .map(({ event }) => event),
        [
          "fact_satisfied",
          "queued",
        ],
      );
    } finally {
      reopened.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
