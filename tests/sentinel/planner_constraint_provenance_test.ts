import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  type AdaptivePlannerInputManifest,
  openSentinelAdaptiveStore,
} from "../../src/sentinel/adaptive_store.ts";
import { runSentinelAssessment } from "../../src/sentinel/assessment.ts";
import { buildSentinelProvenance } from "../../src/sentinel/provenance.ts";

const legacy: AdaptivePlannerInputManifest = {
  promptSha256: "a".repeat(64),
  hintIds: [],
  findingReviewIds: [],
  incidentReviewIds: [],
  incidentCandidateIds: [],
  investigationIds: [],
  inventoryNodeIds: [],
  workerObservations: [],
};

Deno.test("planner history retains exact operating constraint proof and legacy inputs", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.db");
  const now = 1000;
  const state = "a".repeat(64);
  const proof = { version: 2, digest: "b".repeat(64) };
  const constrained =
    `${state}:hint:9007199254740991:review:0123456789abcdef:goal:0123456789abcdef:constraints:${proof.version}:${
      proof.digest.slice(0, 16)
    }:obs:0123456789abcdef`;
  const activation = { operatingConstraintKey: "d".repeat(64) };
  try {
    const store = openSentinelAdaptiveStore(path, () => now);
    try {
      assertEquals(store.claimModelPlan(state), 1);
      assert(store.recordModelPlanInputManifest(state, 1, legacy));
      store.completeModelPlan(state, 1, "no_new_assignments");
      assertEquals(store.claimModelPlan(constrained, activation), 1);
      for (
        const operatingConstraints of [
          { version: 0, digest: proof.digest },
          { version: proof.version, digest: "not-a-sha256" },
        ]
      ) {
        assertThrows(
          () =>
            store.recordModelPlanInputManifest(constrained, 1, {
              ...legacy,
              operatingConstraints,
            }),
          Error,
          "constraint proof",
        );
      }
      assert(store.recordModelPlanInputManifest(constrained, 1, {
        ...legacy,
        operatingConstraints: proof,
      }));
      assertEquals(
        store.recordModelPlanInputManifest(constrained, 1, {
          ...legacy,
          operatingConstraints: { ...proof, version: 3 },
        }),
        false,
      );
      store.completeModelPlan(constrained, 1, "no_new_assignments");
    } finally {
      store.close();
    }
    const reopened = openSentinelAdaptiveStore(path, () => now);
    try {
      assertEquals(
        reopened.claimModelPlan(constrained.replace(/def$/, "dee"), activation),
        "cooldown",
      );
      assertEquals(
        reopened.modelPlanHistory(state, true).map((
          { identity, inputManifest },
        ) => ({ identity, inputManifest })),
        [
          { identity: state, inputManifest: legacy },
          {
            identity: constrained,
            inputManifest: { ...legacy, operatingConstraints: proof },
          },
        ],
      );
      assertEquals(
        reopened.modelPlanHistory(state).map(({ identity }) => identity),
        [state],
      );
    } finally {
      reopened.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("completed reviews retain their exact constraint proof independently of older notes", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.db");
  const proof = { version: 3, digest: "c".repeat(64) };
  const revision = "fixture-review-revision";
  const reason = "Fixture model review";
  try {
    const store = openSentinelAdaptiveStore(path);
    try {
      store.sync(
        revision,
        ["before", "after"].map((nodeId) => ({
          kind: "trace" as const,
          nodeId,
          reason,
        })),
      );
      for (let index = 0; index < 2; index++) {
        const claim = store.claim(revision);
        assert(claim);
        assert(store.complete({
          taskId: claim.task.id,
          leaseToken: claim.leaseToken,
          observation: {},
        }));
      }
      const before = store.claimModelReview(revision, reason);
      assert(before);
      assert(store.finishModelReview(revision, before.task.id, before.token, {
        note: "Review before constraints were supplied.",
        steps: [],
      }));
      const after = store.claimModelReview(revision, reason);
      assert(after);
      const review = {
        note: "Review restricted by the current operating constraints.",
        steps: [],
      };
      assertThrows(
        () =>
          store.finishModelReview(revision, after.task.id, after.token, {
            ...review,
            operatingConstraints: { ...proof, version: 0 },
          }),
        Error,
        "constraint proof",
      );
      assertEquals(store.modelReviewNotes(revision).length, 1);
      assert(store.finishModelReview(revision, after.task.id, after.token, {
        ...review,
        operatingConstraints: proof,
      }));
    } finally {
      store.close();
    }
    const reopened = openSentinelAdaptiveStore(path);
    try {
      assertEquals(
        reopened.modelReviewNotes(revision).map((
          { operatingConstraints, steps },
        ) => ({
          operatingConstraints,
          steps,
        })),
        [
          { operatingConstraints: undefined, steps: [] },
          { operatingConstraints: proof, steps: [] },
        ],
      );
      const result = runSentinelAssessment({
        snapshot: {
          version: 1,
          nodes: ["before", "after"].map((id) => ({
            id,
            label: id,
            kind: "asset",
          })),
          edges: [],
        },
        alerts: [],
      });
      const projected = buildSentinelProvenance(result, {
        goal: { id: "fixture", label: "Fixture goal" },
        tasks: reopened.list(revision),
        modelReviews: reopened.modelReviewNotes(revision),
      }).snapshot().nodes.flatMap((node) =>
        "modelReview" in node && node.modelReview ? [node.modelReview] : []
      );
      assertEquals(
        projected.filter(({ operatingConstraints }) => operatingConstraints)
          .map(
            ({ operatingConstraints }) => operatingConstraints,
          ),
        [proof],
      );
    } finally {
      reopened.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
