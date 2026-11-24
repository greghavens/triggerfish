import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  type AdaptivePlannerInputManifest,
  openSentinelAdaptiveStore,
  readAdaptiveSourceSnapshotReferences,
  sentinelAdaptiveTaskId,
} from "../../src/sentinel/adaptive_store.ts";

const storedScope = "evidence:1";
const firstTask = sentinelAdaptiveTaskId(storedScope, { kind: "coverage" });
const secondTask = sentinelAdaptiveTaskId(storedScope, {
  kind: "trace",
  nodeId: "asset",
});
const includedIncident = `incident:${"a".repeat(64)}`;
const omittedIncident = `incident:${"b".repeat(64)}`;
const manifest: AdaptivePlannerInputManifest = {
  promptSha256: "c".repeat(64),
  hintIds: [3],
  findingReviewIds: [8],
  incidentReviewIds: [],
  incidentCandidateIds: [includedIncident],
  investigationIds: [secondTask],
  inventoryNodeIds: ["asset"],
  workerObservations: [
    {
      taskId: firstTask,
      workerResult: false,
      modelReviewSummary: true,
      modelReviewRelatedNodeIds: ["case-evidence:1", "Case-evidence:2"],
      priorAssignedTargetCitations: [{
        sourceTaskId: secondTask,
        evidenceRevision: 1,
        targetId: "case-evidence:1",
        stepIndex: 2,
      }],
    },
    { taskId: secondTask, workerResult: true, modelReviewSummary: false },
  ],
  upstreamCheckIds: ["observed-check"],
};

Deno.test("Planner manifests survive restart and keep exact per-attempt delivered input", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  let time = 1000;
  const now = () => time;
  const identity = "evidence:1:obs:123";

  try {
    const first = openSentinelAdaptiveStore(path, now);
    try {
      assertEquals(
        first.recordModelPlanInputManifest(identity, 1, manifest),
        false,
      );
      assertEquals(
        first.claimModelPlan(identity, {
          hintIds: [3, 2, 1],
          findingReviewIds: [8, 7],
          incidentReviewIds: [6],
          incidentCandidateIds: [includedIncident, omittedIncident],
        }),
        1,
      );
      const input = {
        ...manifest,
        rawPrompt: "Sensitive prompt content is discarded",
      };
      assert(first.recordModelPlanInputManifest(identity, 1, input));
      assert(first.recordModelPlanInputManifest(identity, 1, manifest));
      assertEquals(
        first.recordModelPlanInputManifest(identity, 1, {
          ...manifest,
          promptSha256: "d".repeat(64),
        }),
        false,
      );
    } finally {
      first.close();
    }

    const reopened = openSentinelAdaptiveStore(path, now);
    try {
      const initial = reopened.modelPlanHistory(identity)[0];
      assertEquals(initial.inputManifest, manifest);
      assertEquals(initial.hintIds, [3]);
      assertEquals(initial.findingReviewIds, [8]);
      assertEquals(initial.incidentReviewIds, []);
      assertEquals(initial.incidentCandidateIds, [includedIncident]);
      assert(!JSON.stringify(initial).includes("Sensitive prompt content"));
      time += 60_000;
      assertEquals(reopened.claimModelPlan(identity), 2);
      assertEquals(
        reopened.recordModelPlanInputManifest(identity, 1, manifest),
        false,
      );
      assertEquals(
        reopened.modelPlanHistory(identity)[1].inputManifest,
        undefined,
      );
      assert(reopened.recordModelPlanInputManifest(identity, 2, manifest));
      reopened.completeModelPlan(identity, 2, "no_new_assignments");
      assertEquals(
        reopened.recordModelPlanInputManifest(identity, 2, manifest),
        false,
      );
      assertEquals(
        reopened.modelPlanHistory(identity).map((
          { outcome, inputManifest },
        ) => ({
          outcome,
          inputManifest,
        })),
        [
          { outcome: "interrupted", inputManifest: manifest },
          { outcome: "no_new_assignments", inputManifest: manifest },
        ],
      );
    } finally {
      reopened.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Planner manifests omit undispatched attempts and reject malformed context", async () => {
  const directory = await Deno.makeTempDir();
  let time = 1000;
  const store = openSentinelAdaptiveStore(
    join(directory, "adaptive.sqlite"),
    () => time,
  );
  try {
    assertEquals(store.claimModelPlan("undispatched", { hintIds: [3, 2] }), 1);
    assertThrows(
      () =>
        store.recordModelPlanInputManifest("undispatched", 1, {
          ...manifest,
          promptSha256: "invalid",
        }),
      Error,
      "prompt digest",
    );
    assertThrows(
      () =>
        store.recordModelPlanInputManifest("undispatched", 1, {
          ...manifest,
          workerObservations: [
            manifest.workerObservations[0],
            manifest.workerObservations[0],
          ],
        }),
      Error,
      "manifest list",
    );
    for (
      const ids of [
        ["duplicate", "duplicate"],
        ["malformed\x00suffix"],
        Array.from({ length: 51 }, (_, index) => `evidence:${index}`),
      ]
    ) {
      assertThrows(() =>
        store.recordModelPlanInputManifest("undispatched", 1, {
          ...manifest,
          workerObservations: [{
            ...manifest.workerObservations[0],
            modelReviewRelatedNodeIds: ids,
          }],
        })
      );
    }
    store.completeModelPlan("undispatched", 1, "superseded");
    assertEquals(
      store.recordModelPlanInputManifest("undispatched", 1, manifest),
      false,
    );
    assertEquals(
      store.modelPlanHistory("undispatched")[0].inputManifest,
      undefined,
    );
    assertEquals(store.modelPlanHistory("undispatched")[0].hintIds, [3, 2]);
    time += 60_000;
    assertEquals(store.claimModelPlan("expired"), 1);
    time += 30_000;
    assertEquals(
      store.recordModelPlanInputManifest("expired", 1, manifest),
      false,
    );
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Planner citation anchors retain exact saved IDs beyond the worker preview", async () => {
  const directory = await Deno.makeTempDir();
  const store = openSentinelAdaptiveStore(join(directory, "adaptive.sqlite"));
  const anchors = Array.from(
    { length: 50 },
    (_, index) => index === 24 ? "endpoint:deep" : `endpoint:${index}`,
  );
  try {
    const [source] = store.sync(storedScope, [{
      kind: "trace",
      nodeId: "asset",
    }]);
    const lease = store.claim(storedScope)!;
    assertEquals(lease.task.id, source.id);
    assert(store.complete({
      taskId: source.id,
      leaseToken: lease.leaseToken,
      observation: {
        relatedNodeIds: [
          ...anchors.slice(0, 16),
          "endpoint:nul\x00suffix",
          "",
          " ",
          42,
          { id: "endpoint:object" },
          "x".repeat(4097),
          anchors[0],
          ...anchors.slice(16),
          "endpoint:past-limit",
        ],
      },
    }));
    store.sync(
      storedScope,
      Array.from({ length: 5 }, (_, index) => ({
        kind: "trace",
        nodeId: `newer:${index}`,
      })),
    );
    for (let index = 0; index < 5; index++) {
      const newer = store.claim(storedScope)!;
      assert(store.complete({
        taskId: newer.task.id,
        leaseToken: newer.leaseToken,
        observation: { relatedNodeIds: "endpoint:not-an-array" },
      }));
    }

    const observations = store.plannerObservations(storedScope);
    const persisted = observations.find((item) => item.taskId === source.id)!;
    assertEquals(observations.length, 6);
    assertEquals(persisted.observation, undefined);
    assertEquals(persisted.relatedNodeIds, anchors);
    assertEquals(observations[0].relatedNodeIds, []);
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Planner read receipts require a dispatched lease and survive restart in call order", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  const identity = "evidence:1:obs:reads";
  let now = 1_000;
  const returned = {
    tool: "sentinel_worker_observation",
    outcome: "returned" as const,
    target: secondTask,
    resultSha256: "f".repeat(64),
    sourceSnapshots: [{
      caseId: "peer",
      assetId: "endpoint:deep",
      snapshotDigest: "a".repeat(64),
    }],
  };
  const error = { tool: "sentinel_trace", outcome: "error" as const };
  try {
    const first = openSentinelAdaptiveStore(path, () => now);
    try {
      assertEquals(first.claimModelPlan(identity), 1);
      assertEquals(first.recordModelPlanRead(identity, 1, returned), false);
      assert(first.recordModelPlanInputManifest(identity, 1, manifest));
      assertThrows(() =>
        first.recordModelPlanRead(identity, 1, {
          ...returned,
          sourceSnapshots: [{
            ...returned.sourceSnapshots[0],
            caseId: "../raw",
          }],
        })
      );
      const extra = { ...returned, query: "ignore raw query" };
      assert(first.recordModelPlanRead(identity, 1, extra));
      assert(first.recordModelPlanRead(identity, 1, {
        ...error,
        target: "unauthorized target",
      }));
      for (let index = 2; index < 32; index++) {
        assert(first.recordModelPlanRead(identity, 1, error));
      }
      assertEquals(first.recordModelPlanRead(identity, 1, returned), false);
      now += 60_000;
      assertEquals(first.recordModelPlanRead(identity, 1, returned), false);
    } finally {
      first.close();
    }

    const reopened = openSentinelAdaptiveStore(path, () => now);
    try {
      assertEquals(reopened.claimModelPlan(identity), 2);
      assert(reopened.recordModelPlanInputManifest(identity, 2, manifest));
      assertEquals(reopened.recordModelPlanRead(identity, 1, returned), false);
      assert(reopened.recordModelPlanRead(identity, 2, error));
      reopened.completeModelPlan(identity, 2, true);
      assertEquals(reopened.recordModelPlanRead(identity, 2, returned), false);
      assertEquals(
        reopened.modelPlanHistory(identity).map(({ reads }) => reads),
        [[returned, ...Array.from({ length: 31 }, () => error)], [error]],
      );
      assertEquals(readAdaptiveSourceSnapshotReferences(path), [{
        caseId: "peer",
        digest: returned.sourceSnapshots[0].snapshotDigest,
      }]);
    } finally {
      reopened.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Peer finding citations bind to the exact asset and expire on revision carryover", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  const asset = { kind: "trace" as const, nodeId: "local-app" };
  const nextScope = "evidence:2";
  const citation = {
    localAssetId: "local-app",
    sourceCaseId: "peer",
    sourceAssetId: "remote-app",
    sourceFindingId: "finding-a",
    snapshotDigest: "e".repeat(64),
  };
  const nextCitation = { ...citation, snapshotDigest: "f".repeat(64) };
  try {
    const store = openSentinelAdaptiveStore(path);
    try {
      const plannerRound = {
        identity: storedScope,
        attempt: 1,
        peerFindingCitations: [citation],
      };
      const request = { ...asset, plannerRound };
      assertThrows(() =>
        store.sync(storedScope, [{ ...request, nodeId: "other-app" }])
      );
      assertThrows(() =>
        store.sync(storedScope, [{
          ...request,
          plannerRound: {
            ...plannerRound,
            peerFindingCitations: [citation, citation],
          },
        }])
      );
      const [task] = store.sync(storedScope, [request]);
      assertEquals(task.plannerRound?.peerFindingCitations, [citation]);
      const next = { ...plannerRound, peerFindingCitations: [nextCitation] };
      assertEquals(
        store.applyModelPlan(storedScope, null, [{
          ...asset,
          plannerRound: next,
        }], {}),
        1,
      );
      assertEquals(
        store.applyModelPlan(storedScope, null, [{
          ...asset,
          plannerRound: next,
        }], {}),
        0,
      );
      const [carried] = store.sync(nextScope, [{
        ...request,
        carriedFrom: task.id,
      }], storedScope);
      assertEquals(carried.plannerRound?.peerFindingCitations, undefined);
      assertEquals(
        store.applyModelPlan(nextScope, null, [{
          ...asset,
          plannerRound: { ...next, identity: nextScope },
        }], {}),
        1,
      );
    } finally {
      store.close();
    }
    const reopened = openSentinelAdaptiveStore(path);
    try {
      assertEquals(
        reopened.list(storedScope)[0].plannerRound?.peerFindingCitations,
        [
          citation,
          nextCitation,
        ],
      );
      assertEquals(
        reopened.list(nextScope)[0].plannerRound?.peerFindingCitations,
        [
          nextCitation,
        ],
      );
      assertEquals(readAdaptiveSourceSnapshotReferences(path), [
        { caseId: "peer", digest: citation.snapshotDigest },
        { caseId: "peer", digest: nextCitation.snapshotDigest },
      ]);
    } finally {
      reopened.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Revision carryover accepts only an explicitly revalidated subset of the exact prior task citations", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  const store = openSentinelAdaptiveStore(path);
  try {
    const nextScope = "evidence:2";
    const asset = { kind: "impact" as const, nodeId: "local-app", depth: 3 };
    const citation = {
      localAssetId: asset.nodeId,
      sourceCaseId: "peer",
      sourceAssetId: "remote-app",
      sourceFindingId: "finding-a",
      snapshotDigest: "e".repeat(64),
    };
    const second = { ...citation, sourceFindingId: "finding-b" };
    const plannerRound = {
      identity: storedScope,
      attempt: 1,
      peerFindingCitations: [citation, second],
    };
    const request = { ...asset, plannerRound };
    const [prior] = store.sync(storedScope, [request]);
    const carry = {
      ...request,
      carriedFrom: prior.id,
      revalidatedPeerFindingCitations: [second],
    };
    assertThrows(() =>
      store.sync(nextScope, [{
        ...carry,
        carriedFrom: undefined,
      }], storedScope)
    );
    assertThrows(() =>
      store.sync(nextScope, [{
        ...carry,
        depth: 2,
      }], storedScope)
    );
    const fabricated = { ...second, snapshotDigest: "d".repeat(64) };
    assertThrows(() =>
      store.sync(nextScope, [{
        ...carry,
        revalidatedPeerFindingCitations: [second, fabricated],
      }], storedScope)
    );
    assertEquals(store.activeRevision(), storedScope);
    const [current] = store.sync(nextScope, [carry], storedScope);
    assertEquals(current.plannerRound?.peerFindingCitations, [second]);
    assertEquals(current.revalidatedPeerFindingCitations, undefined);
    assertEquals(store.sync(nextScope, [carry], nextScope), [current]);
    assertThrows(() =>
      store.sync(nextScope, [{
        ...carry,
        revalidatedPeerFindingCitations: [fabricated],
      }], nextScope)
    );
    assertEquals(
      store.list(storedScope)[0].plannerRound?.peerFindingCitations,
      [
        citation,
        second,
      ],
    );
    assertEquals(store.list(nextScope)[0].plannerRound?.peerFindingCitations, [
      second,
    ]);
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Peer verification cache survives restart and expires only at a transition boundary", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  const destination = "evidence:2";
  const replacement = "evidence:3";
  const exact = {
    localAssetId: "assigned",
    sourceCaseId: "peer",
    sourceAssetId: "reported",
    sourceFindingId: "finding-a",
    snapshotDigest: "a".repeat(64),
  };
  const first = { citation: exact, verified: true };
  const second = {
    citation: { ...exact, sourceFindingId: "finding-b" },
    verified: false,
  };
  try {
    const store = openSentinelAdaptiveStore(path);
    try {
      store.sync(storedScope, []);
      store.recordPeerFindingVerifications(destination, [first, second]);
      assertEquals(store.peerFindingVerifications(storedScope), []);
      store.sync(storedScope, [], storedScope);
      assertEquals(store.peerFindingVerifications(destination), [
        first,
        second,
      ]);
    } finally {
      store.close();
    }

    const reopened = openSentinelAdaptiveStore(path);
    try {
      assertEquals(reopened.peerFindingVerifications(destination), [
        first,
        second,
      ]);
      assertEquals(readAdaptiveSourceSnapshotReferences(path), []);
      assertThrows(() =>
        reopened.sync(destination, [{
          kind: "trace",
          nodeId: "assigned",
          carriedFrom: secondTask,
        }], storedScope)
      );
      assertEquals(reopened.peerFindingVerifications(destination), [
        first,
        second,
      ]);
      reopened.recordPeerFindingVerifications(replacement, [second]);
      assertEquals(reopened.peerFindingVerifications(destination), []);
      assertEquals(reopened.peerFindingVerifications(replacement), [second]);
      reopened.sync(replacement, [], storedScope);
      assertEquals(reopened.peerFindingVerifications(replacement), []);
      reopened.recordPeerFindingVerifications(replacement, [first]);
      assertEquals(reopened.peerFindingVerifications(replacement), []);
      reopened.recordPeerFindingVerifications(replacement, [first], true);
      assertEquals(reopened.peerFindingVerifications(replacement), [first]);
      reopened.sync(replacement, [], replacement);
      assertEquals(reopened.peerFindingVerifications(replacement), []);
    } finally {
      reopened.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Planner evidence IDs are projected from exact committed assigned-target receipts only", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  const store = openSentinelAdaptiveStore(path);
  try {
    const [task] = store.sync(storedScope, [{
      kind: "trace",
      nodeId: "exact-asset",
      reason: "fixture",
    }]);
    const lease = store.claim(storedScope)!;
    store.complete({
      taskId: task.id,
      leaseToken: lease.leaseToken,
      observation: { relatedNodeIds: ["deterministic-only"] },
    });
    assertEquals(
      store.plannerObservations(storedScope)[0].modelReviewRelatedNodeIds,
      undefined,
    );
    const review = store.claimModelReview(storedScope, "fixture")!;
    const good = {
      tool: "sentinel_assigned_target",
      target: task.nodeId,
      outcome: "returned" as const,
      assignedTarget: {
        targetId: task.nodeId!,
        linkedNodeIds: ["delivered-evidence"],
      },
    };
    assert(store.finishModelReview(storedScope, task.id, review.token, {
      note: "Mentioned in summary, not in a receipt: summary-only.",
      steps: [
        good,
        {
          ...good,
          tool: "sentinel_trace",
          assignedTarget: {
            ...good.assignedTarget,
            linkedNodeIds: ["other-tool"],
          },
        },
        {
          ...good,
          outcome: "error",
          assignedTarget: {
            ...good.assignedTarget,
            linkedNodeIds: ["failed-call"],
          },
        },
        {
          ...good,
          assignedTarget: {
            targetId: "other-target",
            linkedNodeIds: ["wrong-asset"],
          },
        },
        {
          ...good,
          assignedTarget: {
            ...good.assignedTarget,
            linkedNodeIds: ["malformed\x00id"],
          },
        },
        { ...good, assignedTarget: undefined },
      ],
    }));

    const [observed] = store.plannerObservations(storedScope);
    assertEquals(observed.relatedNodeIds, ["deterministic-only"]);
    assertEquals(observed.modelReviewRelatedNodeIds, ["delivered-evidence"]);
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Revalidated assigned-target citations preserve the exact archived review step and case goal", async () => {
  const directory = await Deno.makeTempDir();
  const store = openSentinelAdaptiveStore(join(directory, "adaptive.sqlite"));
  const origin = "evidence:1";
  const destination = "evidence:2";
  const third = "evidence:3";
  const goal = { id: "case-goal", label: "Review case evidence" };
  const scope = (number: number) => ({ number, goal });
  try {
    const [source] = store.sync(
      origin,
      [{
        kind: "trace",
        nodeId: "source-asset",
        reason: "fixture",
      }],
      null,
      scope(1),
    );
    const lease = store.claim(origin)!;
    store.complete({
      taskId: source.id,
      leaseToken: lease.leaseToken,
      observation: {},
    });
    const review = store.claimModelReview(origin, "fixture")!;
    const receipt = {
      tool: "sentinel_assigned_target",
      target: "source-asset",
      assignedTarget: {
        targetId: "source-asset",
        linkedNodeIds: ["evidence:exact"],
      },
    };
    assert(store.finishModelReview(origin, source.id, review.token, {
      note: "Saved review.",
      steps: [
        { ...receipt, outcome: "error" },
        { ...receipt, target: "wrong-source", outcome: "returned" },
        { ...receipt, outcome: "returned" },
      ],
    }));
    const followUp = {
      kind: "review_evidence" as const,
      nodeId: "evidence:exact",
    };
    const childId = sentinelAdaptiveTaskId(origin, followUp);
    assertEquals(
      store.applyModelPlan(origin, null, [{
        ...followUp,
        prerequisites: [source.id],
        reviewedFrom: source.id,
        plannerRound: {
          identity: origin,
          attempt: 1,
          sourceKind: "model_review",
        },
      }], {}),
      1,
    );
    const [original] = store.priorAssignedTargetCitationCandidates(childId, 2);
    assertEquals(original, {
      citation: {
        sourceTaskId: source.id,
        evidenceRevision: 1,
        targetId: "evidence:exact",
        stepIndex: 2,
      },
      sourceTargetId: "source-asset",
    });
    const carry = {
      ...followUp,
      carriedFrom: childId,
      plannerRound: { identity: origin, attempt: 1 },
      revalidatedAssignedTargetCitations: [original.citation],
    };
    assertThrows(() =>
      store.sync(
        destination,
        [{
          ...carry,
          revalidatedAssignedTargetCitations: [{
            ...original.citation,
            stepIndex: 1,
          }],
        }],
        origin,
        scope(2),
      )
    );
    assertThrows(() =>
      store.sync(destination, [carry], origin, {
        number: 2,
        goal: { ...goal, id: "different-goal" },
      })
    );
    assertEquals(store.activeRevision(), origin);
    const [retained] = store.sync(destination, [carry], origin, scope(2));
    assertEquals(retained.plannerRound?.priorAssignedTargetCitations, [
      original.citation,
    ]);
    assertEquals(retained.revalidatedAssignedTargetCitations, undefined);
    assertEquals(retained.reviewedFrom, undefined);
    assertEquals(store.plannerObservations(destination), []);
    const carrierLink = {
      carrierTaskId: retained.id,
      citation: original.citation,
    };
    const followOn = {
      kind: "trace" as const,
      nodeId: followUp.nodeId,
      prerequisites: [retained.id],
      plannerRound: { identity: destination, attempt: 1 },
      carriedAssignedTargetCitations: [carrierLink],
    };
    assertThrows(() => store.applyModelPlan(destination, null, [followOn], {}));
    const retainedLease = store.claim(destination)!;
    store.complete({
      taskId: retained.id,
      leaseToken: retainedLease.leaseToken,
      observation: { relatedNodeIds: ["deterministic"] },
    });
    const [observation] = store.plannerObservations(destination);
    assertEquals(observation.priorAssignedTargetCitations, [original.citation]);
    assertEquals(observation.relatedNodeIds, ["deterministic"]);
    assertEquals(observation.modelReviewRelatedNodeIds, undefined);
    assertEquals(store.priorAssignedTargetCitationCandidates(retained.id, 3), [
      original,
    ]);
    assertThrows(() =>
      store.applyModelPlan(destination, null, [{
        ...followOn,
        prerequisites: [],
      }], {})
    );
    assertThrows(() =>
      store.applyModelPlan(destination, null, [{
        ...followOn,
        carriedAssignedTargetCitations: [{
          ...carrierLink,
          citation: { ...original.citation, stepIndex: 1 },
        }],
      }], {})
    );
    assertEquals(store.applyModelPlan(destination, null, [followOn], {}), 1);
    const added = store.list(destination).find(({ kind }) => kind === "trace")!;
    assertEquals(added.plannerRound?.priorAssignedTargetCitations, [
      original.citation,
    ]);
    assertEquals(added.plannerRound?.carriedAssignedTargetCitations, [
      carrierLink,
    ]);
    assert(
      !store.recommendDependencyChanges(destination, [{
        id: added.id,
        prerequisites: [],
        reason: "Would drop the exact carrier.",
      }]),
    );
    const existing = { ...followOn, depth: 3 };
    assertEquals(
      store.applyModelPlan(destination, null, [{
        ...existing,
        carriedAssignedTargetCitations: undefined,
      }], {}),
      1,
    );
    assertEquals(store.applyModelPlan(destination, null, [existing], {}), 1);
    assertEquals(store.applyModelPlan(destination, null, [existing], {}), 0);
    assertEquals(
      store.list(destination).find(({ depth }) => depth === 3)
        ?.plannerRound?.priorAssignedTargetCitations,
      [original.citation],
    );
    const [again] = store.sync(
      third,
      [{ ...carry, carriedFrom: retained.id }],
      destination,
      scope(3),
    );
    assertEquals(again.plannerRound?.priorAssignedTargetCitations, [
      original.citation,
    ]);
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});
