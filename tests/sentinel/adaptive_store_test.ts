import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import {
  openSentinelAdaptiveStore,
  querySentinelWorkerObservations,
  readAdaptiveAssetSnapshotCitations,
  sentinelAdaptiveTaskId,
} from "../../src/sentinel/adaptive_store.ts";

Deno.test("Adaptive tasks persist independently of a process and only run after dependencies", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  const revision = "evidence:1";
  const root = { kind: "verify_control_coverage" as const };
  const rootId = sentinelAdaptiveTaskId(revision, root);
  const review = {
    kind: "review_finding" as const,
    nodeId: "db-finding",
    prerequisites: [rootId],
    evidenceIds: ["record:2", "record:1", "record:1"],
    reason: "Review a documented defense gap",
  };

  try {
    const store = openSentinelAdaptiveStore(path);
    try {
      assertEquals(
        store.sync(revision, [root, review, review], null).length,
        2,
      );
      const claimed = store.claim(revision);
      assert(claimed);
      assertEquals(claimed.task.kind, root.kind);
      assertEquals(store.claim(revision), null);
      store.complete({
        taskId: rootId,
        leaseToken: claimed.leaseToken,
        observation: { affected: ["db-finding"] },
        note: "Coverage gap confirmed",
      });
      store.addNote(revision, "Analyst note", rootId);
    } finally {
      store.close();
    }

    const restarted = openSentinelAdaptiveStore(path);
    try {
      assertEquals(restarted.activeRevision(), revision);
      const tasks = restarted.list();
      assertEquals(tasks[0].status, "completed");
      assertEquals(tasks[0].observation, { affected: ["db-finding"] });
      assertEquals(tasks[1].evidenceIds, ["record:1", "record:2"]);
      assertEquals(restarted.notes()[0].taskId, rootId);
      assertEquals(restarted.history()[0].note, "Coverage gap confirmed");
      const claimed = restarted.claim(revision);
      assert(claimed);
      assertEquals(claimed.task.nodeId, "db-finding");
    } finally {
      restarted.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Adaptive expired leases are recovered and reject a former worker completion", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  let time = 0;
  const store = openSentinelAdaptiveStore(path, () => time);
  const peer = openSentinelAdaptiveStore(path, () => time);
  try {
    store.sync("e1", [{ kind: "coverage" }]);
    const initial = store.claim("e1", 1)!;
    assert(initial);
    assertEquals(peer.claim("e1"), null);
    time = 1000;
    const retry = peer.claim("e1", 1)!;
    assert(retry);
    assertEquals(retry.task.attempts, 2);
    assertNotEquals(initial.leaseToken, retry.leaseToken);
    assertThrows(
      () =>
        store.complete({
          taskId: initial.task.id,
          leaseToken: initial.leaseToken,
          observation: {},
        }),
      Error,
      "lease",
    );
    peer.fail({
      taskId: retry.task.id,
      leaseToken: retry.leaseToken,
      note: "Retry test",
      retry: true,
    });
    const final = store.claim("e1", 1)!;
    assertEquals(final.task.attempts, 3);
    time = 2000;
    assertEquals(peer.claim("e1", 1), null);
    assertEquals(peer.list()[0].status, "failed");
    assertEquals(peer.history().map((event) => event.event), [
      "lease_expired",
      "claimed",
      "retry_queued",
      "claimed",
      "lease_expired",
      "claimed",
      "queued",
    ]);
  } finally {
    peer.close();
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Adaptive revision updates roll back on invalid dependencies and supersede stale leases", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  const store = openSentinelAdaptiveStore(path);
  try {
    const root = { kind: "coverage" as const };
    const [first] = store.sync("e1", [root]);
    const claimed = store.claim("e1")!;
    assertThrows(
      () => store.sync("e2", [{ ...root, prerequisites: [first.id] }]),
      Error,
      "same evidence revision",
    );
    assertEquals(store.activeRevision(), "e1");
    assertEquals(store.list()[0].status, "running");
    assertThrows(
      () => store.sync("e2", [root], "other"),
      Error,
      "revision changed",
    );
    store.sync("e2", [root], "e1");
    assertEquals(store.list("e1")[0].status, "superseded");
    assertEquals(store.claim("e1"), null);
    assertThrows(
      () =>
        store.complete({
          taskId: first.id,
          leaseToken: claimed.leaseToken,
          observation: {},
        }),
      Error,
      "lease",
    );
    assertNotEquals(store.list()[0].id, first.id);
    assertThrows(
      () => store.sync("e3", [{ kind: "trace" }]),
      Error,
      "exact target",
    );
    assertThrows(
      () => store.sync("e3", JSON.parse('[{"kind":"arbitrary"}]')),
      Error,
      "Unsupported",
    );
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Operator retry preserves attempt history and the lease limit", async () => {
  const directory = await Deno.makeTempDir();
  const store = openSentinelAdaptiveStore(join(directory, "adaptive.sqlite"));
  try {
    const revision = "retry-revision";
    const [task] = store.sync(revision, [{ kind: "trace", nodeId: "web" }]);
    assertEquals(store.retryFailed(revision, task.id), false);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const claim = store.claim(revision);
      assert(claim);
      assertEquals(claim.task.attempts, attempt);
      assertEquals(store.retryFailed(revision, task.id), false);
      store.fail({
        taskId: task.id,
        leaseToken: claim.leaseToken,
        note: "Fixture failure",
      });
      assertEquals(store.retryFailed("stale", task.id), false);
      assertEquals(store.retryFailed(revision, task.id), attempt < 3);
    }
    assertEquals(store.claim(revision), null);
    assertEquals(
      store.history(revision).filter(({ event }) => event === "retry_queued")
        .map(({ attempt }) => attempt),
      [2, 1],
    );
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Operator priority chooses the next eligible task while preserving dependencies", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  const store = openSentinelAdaptiveStore(path);
  try {
    const revision = "priority-revision";
    const root = { kind: "trace" as const, nodeId: "root" };
    const rootId = sentinelAdaptiveTaskId(revision, root);
    const [, next, child] = store.sync(revision, [
      root,
      { kind: "trace", nodeId: "independent" },
      { kind: "trace", nodeId: "dependent", prerequisites: [rootId] },
    ]);
    assertEquals(store.prioritize("stale", next.id), false);
    assert(store.prioritize(revision, next.id));
    assert(store.prioritize(revision, child.id));
    const worker = openSentinelAdaptiveStore(path);
    try {
      const independent = worker.claim(revision);
      assertEquals(independent?.task.id, next.id);
      assertEquals(store.prioritize(revision, next.id), false);
      const dependency = worker.claim(revision);
      assert(dependency);
      assertEquals(dependency.task.id, rootId);
      assertEquals(worker.claim(revision), null);
      worker.complete({
        taskId: rootId,
        leaseToken: dependency.leaseToken,
        observation: {},
      });
      assertEquals(worker.claim(revision)?.task.id, child.id);
    } finally {
      worker.close();
    }
    assertEquals(
      store.history(revision).filter(({ event }) => event === "prioritized")
        .map(({ taskId }) => taskId),
      [child.id, next.id],
    );
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Queued cancellation preserves history, cascades, and survives revision reactivation", async () => {
  const directory = await Deno.makeTempDir();
  const store = openSentinelAdaptiveStore(join(directory, "adaptive.sqlite"));
  try {
    const revision = "cancel-revision";
    const root = { kind: "trace" as const, nodeId: "root" };
    const rootId = sentinelAdaptiveTaskId(revision, root);
    const child = {
      kind: "trace" as const,
      nodeId: "child",
      prerequisites: [rootId],
    };
    const childId = sentinelAdaptiveTaskId(revision, child);
    const [, , grandchild, independent] = store.sync(revision, [
      root,
      child,
      { kind: "trace", nodeId: "grandchild", prerequisites: [childId] },
      { kind: "trace", nodeId: "independent" },
    ]);
    assertEquals(store.cancelQueued("stale", rootId), false);
    assert(store.cancelQueued(revision, rootId));
    assertEquals(store.cancelQueued(revision, rootId), false);
    store.sync("another-revision", []);
    store.sync(revision, [root, child]);
    assertEquals(store.list(revision).map(({ status }) => status), [
      "cancelled",
      "cancelled",
      "cancelled",
      "queued",
    ]);
    assertEquals(store.claim(revision)?.task.id, independent.id);
    assertEquals(store.cancelQueued(revision, independent.id), false);
    assertEquals(
      store.history(revision).filter(({ event }) => event === "cancelled").map((
        { taskId },
      ) => taskId),
      [grandchild.id, childId, rootId],
    );
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Retrying a failed prerequisite restores a blocked chain without running it early", async () => {
  const directory = await Deno.makeTempDir();
  const store = openSentinelAdaptiveStore(join(directory, "adaptive.sqlite"));
  try {
    const revision = "blocked-chain";
    const first = { kind: "trace" as const, nodeId: "asset-a" };
    const firstId = sentinelAdaptiveTaskId(revision, first);
    const second = {
      kind: "trace" as const,
      nodeId: "asset-b",
      prerequisites: [firstId],
    };
    const third = {
      kind: "trace" as const,
      nodeId: "asset-c",
      prerequisites: [sentinelAdaptiveTaskId(revision, second)],
    };
    store.sync(revision, [first, second, third], null);
    const claim = store.claim(revision);
    assert(claim);
    assertEquals(claim.task.id, firstId);
    store.fail({
      taskId: firstId,
      leaseToken: claim.leaseToken,
      note: "Fixture failure",
    });
    assertEquals(store.claim(revision), null);
    assert(store.retryFailed(revision, firstId));
    for (const nodeId of ["asset-a", "asset-b", "asset-c"]) {
      const ready = store.claim(revision);
      assert(ready);
      assertEquals(ready.task.nodeId, nodeId);
      store.complete({
        taskId: ready.task.id,
        leaseToken: ready.leaseToken,
        observation: {},
      });
    }
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Carryover preserves unclaimed operator priorities in their original order", async () => {
  const directory = await Deno.makeTempDir();
  const store = openSentinelAdaptiveStore(join(directory, "adaptive.sqlite"));
  try {
    const first = "priority-before";
    const second = "priority-after";
    const requests = ["one", "two", "three"].map((nodeId) => ({
      kind: "trace" as const,
      nodeId,
    }));
    const [one, two, three] = store.sync(first, requests, null);
    assert(store.prioritize(first, three.id));
    assert(store.prioritize(first, two.id));
    assert(store.prioritize(first, one.id));
    const claimed = store.claim(first);
    assertEquals(claimed?.task.id, one.id);
    store.sync(
      second,
      requests.map((task) => ({
        ...task,
        carriedFrom: sentinelAdaptiveTaskId(first, task),
      })),
      first,
    );
    const carriedPriority = store.history(second).filter(({ event }) =>
      event === "prioritized"
    );
    assertEquals(carriedPriority.map(({ taskId }) => taskId), [
      sentinelAdaptiveTaskId(second, requests[1]),
      sentinelAdaptiveTaskId(second, requests[2]),
    ]);
    assertEquals(
      store.list(second).filter((task) => task.prioritized).map((task) =>
        task.nodeId
      ),
      ["two", "three"],
    );
    const carriedThird = sentinelAdaptiveTaskId(second, requests[2]);
    assert(store.prioritize(second, carriedThird, false));
    assertEquals(store.prioritize(second, carriedThird, false), false);
    assertEquals(
      store.list(second).find(({ id }) => id === carriedThird)?.status,
      "queued",
    );
    assertEquals(store.history(second)[0].event, "priority_withdrawn");
    assertEquals(store.claim(second)?.task.nodeId, "two");
    assertEquals(
      store.list(second).filter((task) => task.prioritized).map((task) =>
        task.nodeId
      ),
      [],
    );
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Model planning claims and cooldown survive reopening the case store", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  let time = 1000;
  const first = openSentinelAdaptiveStore(path, () => time);
  assertEquals(first.claimModelPlan("first"), 1);
  first.close();
  const reopened = openSentinelAdaptiveStore(path, () => time);
  try {
    assertEquals(reopened.modelPlanStatus("first"), {
      attempt: 1,
      status: "running",
    });
    assertEquals(reopened.claimModelPlan("first"), "cooldown");
    assertEquals(reopened.claimModelPlan("second"), "cooldown");
    time += 30_000;
    assertEquals(reopened.modelPlanStatus("first"), {
      attempt: 1,
      status: "retry_pending",
    });
    time += 30_000;
    assertEquals(reopened.claimModelPlan("first"), 2);
    reopened.completeModelPlan("first", 1);
    const abandoned = reopened.modelPlanHistory("first").find(({ attempt }) =>
      attempt === 1
    );
    assertEquals(abandoned?.outcome, "interrupted");
    assertEquals(abandoned?.finished, new Date(time).toISOString());
    assertEquals(reopened.modelPlanStatus("first"), {
      attempt: 2,
      status: "running",
    });
    reopened.completeModelPlan("first", 2, false);
    assertEquals(
      reopened.modelPlanHistory("first").map(({ attempt, outcome }) => ({
        attempt,
        outcome,
      })),
      [
        { attempt: 1, outcome: "interrupted" },
        { attempt: 2, outcome: "interrupted" },
      ],
    );
    assertEquals(reopened.modelPlanStatus("first"), {
      attempt: 2,
      status: "exhausted",
    });
    assertEquals(reopened.claimModelPlan("first"), "already_claimed");
    time += 60_000;
    assertEquals(reopened.claimModelPlan("second"), 1);
    reopened.completeModelPlan("second", 1);
    time += 60_000;
    assertEquals(reopened.claimModelPlan("second"), "already_claimed");
  } finally {
    reopened.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Model reviews have independent durable leases and reject stale results", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  let time = 1_000;
  const reason = "Model review fixture";
  const revision = "revision";
  let store = openSentinelAdaptiveStore(path, () => time);
  try {
    store.sync(
      revision,
      ["first", "second"].map((nodeId) => ({
        kind: "trace" as const,
        nodeId,
        reason,
      })),
    );
    for (let index = 0; index < 2; index++) {
      const claim = store.claim(revision)!;
      store.complete({
        taskId: claim.task.id,
        leaseToken: claim.leaseToken,
        observation: {},
      });
    }
    const first = store.claimModelReview(revision, reason)!;
    assertEquals(first.task.nodeId, "first");
    const second = store.claimModelReview(revision, reason)!;
    assertEquals(second.task.nodeId, "second");
    const reviewStatus = (id: string) =>
      store.modelReviewStates(revision).find((item) => item.taskId === id)
        ?.status;
    assertEquals(reviewStatus(first.task.id), "running");
    assert(store.finishModelReview(revision, second.task.id, second.token, {
      note: "Second task reviewed",
      steps: [],
    }));
    assertEquals(store.claimModelReview(revision, reason), null);
    assertEquals(reviewStatus(second.task.id), "completed");
    store.close();
    store = openSentinelAdaptiveStore(path, () => time);
    time += 45_000;
    assertEquals(reviewStatus(first.task.id), "retry_pending");
    assertEquals(
      store.finishModelReview(revision, first.task.id, first.token, {
        note: "Expired result",
        steps: [],
      }),
      false,
    );
    const retry = store.claimModelReview(revision, reason)!;
    assertEquals(retry.task.id, first.task.id);
    time += 60_000;
    store.sync(revision, []);
    assertEquals(reviewStatus(first.task.id), "exhausted");
    assertEquals(store.claimModelReview(revision, reason), null);
    assertEquals(store.notes(revision).map(({ note }) => note), [
      "Second task reviewed",
    ]);
    assertEquals(
      store.history(revision).filter(({ event, taskId }) =>
        taskId === first.task.id && event === "model_review_claimed"
      ).map(({ attempt }) => attempt),
      [2, 1],
    );
    assertEquals(
      store.history(revision).filter(({ event, taskId }) =>
        taskId === first.task.id && event === "model_review_lease_expired"
      ).map(({ attempt }) => attempt),
      [2, 1],
    );
    assertEquals(store.retryModelReview("stale", first.task.id), false);
    assertEquals(store.retryModelReview(revision, second.task.id), false);
    assert(store.retryModelReview(revision, first.task.id));
    assertEquals(store.retryModelReview(revision, first.task.id), false);
    assertEquals(reviewStatus(first.task.id), "retry_pending");
    const operatorRetry = store.claimModelReview(revision, reason)!;
    assertEquals(operatorRetry.task.id, first.task.id);
    assert(
      store.finishModelReview(
        revision,
        first.task.id,
        operatorRetry.token,
        "failed",
      ),
    );
    time += 60_000;
    assertEquals(store.claimModelReview(revision, reason), null);
    assertEquals(store.retryModelReview(revision, first.task.id), false);
    assertEquals(
      store.list(revision).find(({ id }) => id === first.task.id)?.attempts,
      1,
    );
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Model queue rankings respect operator priorities and prerequisite readiness", async () => {
  const directory = await Deno.makeTempDir();
  const revision = "evidence:1";
  try {
    const store = openSentinelAdaptiveStore(join(directory, "adaptive.sqlite"));
    try {
      const plannerRound = { identity: revision, attempt: 1 };
      const [operator, prerequisite, blocked, ready] = store.sync(revision, [
        { kind: "trace", nodeId: "operator" },
        { kind: "trace", nodeId: "prerequisite", plannerRound },
        {
          kind: "trace",
          nodeId: "blocked",
          plannerRound,
          prerequisites: [
            sentinelAdaptiveTaskId(revision, {
              kind: "trace",
              nodeId: "prerequisite",
            }),
          ],
        },
        { kind: "trace", nodeId: "ready", plannerRound },
      ]);
      assertEquals(
        store.refreshPlannerPriorities(revision, [
          blocked.id,
          ready.id,
          operator.id,
        ]),
        2,
      );
      assert(store.prioritize(revision, operator.id));
      assertEquals(store.claim(revision)?.task.id, operator.id);
      assertEquals(store.claim(revision)?.task.id, ready.id);
      assertEquals(store.claim(revision)?.task.id, prerequisite.id);
      assertEquals(store.claim(revision), null);
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Retirement recommendations hold only queued model tasks without active dependents", async () => {
  const directory = await Deno.makeTempDir();
  const revision = "evidence:1";
  try {
    const store = openSentinelAdaptiveStore(join(directory, "adaptive.sqlite"));
    try {
      const plannerRound = { identity: revision, attempt: 1 };
      const [held, prerequisite, operator] = store.sync(revision, [
        { kind: "trace", nodeId: "held", plannerRound },
        { kind: "trace", nodeId: "prerequisite", plannerRound },
        {
          kind: "trace",
          nodeId: "operator",
          prerequisites: [
            sentinelAdaptiveTaskId(revision, {
              kind: "trace",
              nodeId: "prerequisite",
            }),
          ],
        },
      ]);
      store.refreshRetirementRecommendations(
        revision,
        [held, prerequisite, operator].map(({ id }) => ({
          id,
          reason: "Superseded by newer evidence.",
        })),
      );
      assertEquals(
        store.list().map(({ retirementReason }) => retirementReason),
        [
          "Superseded by newer evidence.",
          undefined,
          undefined,
        ],
      );
      assertEquals(store.claim(revision)?.task.id, prerequisite.id);
      assertEquals(store.claim(revision), null);
      assert(store.prioritize(revision, held.id));
      assertEquals(store.claim(revision)?.task.id, held.id);
      assert(
        store.history().some(({ event }) => event === "retirement_dismissed"),
      );
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Operators can approve a queued dependency proposal without bypassing prerequisites", async () => {
  const directory = await Deno.makeTempDir();
  const revision = "evidence:1";
  try {
    const store = openSentinelAdaptiveStore(join(directory, "adaptive.sqlite"));
    try {
      const [target, source] = store.sync(revision, [
        {
          kind: "trace",
          nodeId: "app",
          plannerRound: { identity: revision, attempt: 1 },
        },
        { kind: "trace", nodeId: "source" },
      ]);
      assert(
        !store.recommendDependencyChanges(revision, [{
          id: target.id,
          prerequisites: [target.id],
          reason: "Invalid loop",
        }]),
      );
      assert(store.recommendDependencyChanges(revision, [{
        id: target.id,
        prerequisites: [source.id],
        reason: "Review the source first.",
      }]));
      const proposal = store.list()[0].dependencyRecommendation;
      assert(proposal);
      assertEquals(store.list()[0].prerequisites, []);
      assert(
        !store.resolveDependencyChange(
          revision,
          target.id,
          "old-proposal",
          true,
        ),
      );
      assert(
        store.resolveDependencyChange(revision, target.id, proposal.id, true),
      );
      assertEquals(store.list()[0].prerequisites, [source.id]);
      assertEquals(store.claim(revision)?.task.id, source.id);
      assertEquals(store.claim(revision), null);
      assert(
        store.history().some(({ event }) =>
          event === "dependency_change_applied"
        ),
      );
      const db = new DatabaseSync(join(directory, "adaptive.sqlite"));
      try {
        db.prepare(
          "UPDATE adaptive_events SET note = ? WHERE event = 'dependency_change_applied'",
        ).run(JSON.stringify({
          note: "Keep the original rationale.",
          dependencyApproval: {
            _classification: "INTERNAL",
            proposalId: proposal.id,
            planningIdentity: null,
            runId: "fixture-run",
            evidenceRevision: 1,
            adaptiveRevision: revision,
            changes: target.id,
            affected: [{ taskId: source.id, prerequisites: [target.id] }],
          },
        }));
      } finally {
        db.close();
      }
      assertEquals(
        store.readDependencyApproval(revision, target.id, proposal.id),
        undefined,
      );
      const malformed = store.history().find(({ event }) =>
        event === "dependency_change_applied"
      );
      assertEquals(malformed?.note, "Keep the original rationale.");
      assertEquals(malformed?.dependencyApproval, undefined);
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Coordinated dependency replacements validate and apply as one graph update", async () => {
  const directory = await Deno.makeTempDir();
  const revision = "evidence:1";
  try {
    const store = openSentinelAdaptiveStore(join(directory, "adaptive.sqlite"));
    try {
      const plannerRound = { identity: revision, attempt: 1 };
      const first = { kind: "trace" as const, nodeId: "first", plannerRound };
      const firstId = sentinelAdaptiveTaskId(revision, first);
      const downstream = {
        kind: "trace" as const,
        nodeId: "downstream",
        prerequisites: [firstId],
      };
      const downstreamId = sentinelAdaptiveTaskId(revision, downstream);
      const [, second, , tail] = store.sync(revision, [
        first,
        {
          kind: "trace",
          nodeId: "second",
          plannerRound,
          prerequisites: [firstId],
        },
        downstream,
        { kind: "trace", nodeId: "tail", prerequisites: [downstreamId] },
      ]);
      assert(
        !store.recommendDependencyChanges(revision, [{
          id: firstId,
          prerequisites: [second.id],
          reason: "Cycle.",
        }]),
      );
      assert(store.recommendDependencyChanges(revision, [
        {
          id: firstId,
          prerequisites: [second.id],
          reason: "Run the source review first.",
        },
        {
          id: second.id,
          prerequisites: [],
          reason: "The source review is independent.",
        },
      ]));
      const proposals = store.list().map(({ dependencyRecommendation }) =>
        dependencyRecommendation
      );
      assertEquals(proposals[0]?.id, proposals[1]?.id);
      assertEquals(proposals[0]?.size, 2);
      assert(proposals[2]?.affectedOnly && proposals[3]?.affectedOnly);
      assertEquals(store.claim(revision), null);
      assert(
        store.resolveDependencyChange(
          revision,
          second.id,
          proposals[0]!.id,
          true,
        ),
      );
      assertEquals(store.list().map(({ prerequisites }) => prerequisites), [
        [
          second.id,
        ],
        [],
        [firstId],
        [downstreamId],
      ]);
      for (const id of [second.id, firstId, downstreamId, tail.id]) {
        const claim = store.claim(revision);
        assert(claim);
        assertEquals(claim.task.id, id);
        assertEquals(store.claim(revision), null);
        assert(
          store.complete({
            taskId: id,
            leaseToken: claim.leaseToken,
            observation: {},
          }),
        );
      }
      assertEquals(store.claim(revision), null);
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("A reviewed plan adds new work and links it as a prerequisite atomically", async () => {
  const directory = await Deno.makeTempDir();
  const revision = "evidence:1";
  try {
    const store = openSentinelAdaptiveStore(join(directory, "adaptive.sqlite"));
    try {
      const plannerRound = { identity: revision, attempt: 1 };
      const [target] = store.sync(revision, [{
        kind: "trace",
        nodeId: "app",
        plannerRound,
      }]);
      const addition = {
        kind: "trace" as const,
        nodeId: "source",
        plannerRound,
      };
      const newId = sentinelAdaptiveTaskId(revision, addition);
      assert(store.recommendDependencyChanges(revision, [{
        id: target.id,
        prerequisites: [newId],
        reason: "Review the new source first.",
      }], [addition]));
      assertEquals(store.list().length, 1);
      const proposal = store.list()[0].dependencyRecommendation!;
      assertEquals(proposal.additions?.[0].id, newId);
      assertEquals(store.claim(revision), null);
      assert(
        store.resolveDependencyChange(revision, target.id, proposal.id, true),
      );
      assertEquals(store.list()[0].prerequisites, [newId]);
      assertEquals(store.claim(revision)?.task.id, newId);
      assertEquals(store.claim(revision), null);
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Queue directives in a coordinated plan take effect only on approval", async () => {
  const directory = await Deno.makeTempDir();
  const revision = "evidence:1";
  try {
    const store = openSentinelAdaptiveStore(join(directory, "adaptive.sqlite"));
    try {
      const plannerRound = { identity: revision, attempt: 1 };
      const [target, prioritized, retired, source] = store.sync(
        revision,
        ["target", "prioritized", "retired", "source"].map((nodeId) => ({
          kind: "trace" as const,
          nodeId,
          plannerRound,
        })),
      );
      const changes = [{
        id: target.id,
        prerequisites: [source.id],
        reason: "Review the source first.",
      }];
      const queue = {
        priorities: [prioritized.id],
        retirements: [{ id: retired.id, reason: "This review is redundant." }],
      };
      assert(store.recommendDependencyChanges(revision, changes, [], queue));
      const pending = store.list();
      assertEquals(pending[1].plannerPriority, undefined);
      assertEquals(pending[2].retirementReason, undefined);
      assertEquals(
        pending[2].dependencyRecommendation?.id,
        pending[0].dependencyRecommendation?.id,
      );
      assert(
        store.resolveDependencyChange(
          revision,
          retired.id,
          pending[2].dependencyRecommendation!.id,
          false,
        ),
      );
      assert(store.list().every((task) => !task.dependencyRecommendation));
      assert(store.recommendDependencyChanges(revision, changes, [], queue));
      const id = store.list()[0].dependencyRecommendation!.id;
      assert(store.resolveDependencyChange(revision, prioritized.id, id, true));
      const applied = store.list();
      assertEquals(applied[0].prerequisites, [source.id]);
      assertEquals(applied[1].plannerPriority, 1);
      assertEquals(applied[2].retirementReason, "This review is redundant.");
      assert(applied.every((task) => !task.dependencyRecommendation));
      assertEquals(store.claim(revision)?.task.id, prioritized.id);
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("A newer hint invalidates an entire pending plan and rejects stale staging", async () => {
  const directory = await Deno.makeTempDir();
  const revision = "evidence:1";
  try {
    const path = join(directory, "adaptive.sqlite");
    const store = openSentinelAdaptiveStore(path);
    const writer = openSentinelAdaptiveStore(path);
    try {
      const plannerRound = { identity: revision, attempt: 1 };
      const [target, priority, source] = store.sync(revision, [
        { kind: "trace", nodeId: "target", plannerRound },
        { kind: "trace", nodeId: "priority", plannerRound },
        { kind: "trace", nodeId: "source" },
      ]);
      const changes = [{
        id: target.id,
        prerequisites: [source.id],
        reason: "Check the source first.",
      }];
      const queue = { priorities: [priority.id] };
      assert(
        store.recommendDependencyChanges(revision, changes, [], queue, null),
      );
      const pending = store.list()[0].dependencyRecommendation!;
      const current = Number(
        writer.addCaseHint("Verify another source.", 1).lastInsertRowid,
      );
      assert(
        !store.resolveDependencyChange(revision, target.id, pending.id, true),
      );
      assert(
        !store.recommendDependencyChanges(revision, changes, [], queue, null),
      );
      assert(store.list().every((task) => !task.dependencyRecommendation));
      assertEquals(
        store.history().filter(({ event }) =>
          event === "plan_proposal_superseded"
        ).length,
        2,
      );
      assert(
        store.recommendDependencyChanges(revision, changes, [], queue, current),
      );
    } finally {
      writer.close();
      store.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Standalone model queue updates are atomic with the latest case hint", async () => {
  const directory = await Deno.makeTempDir();
  const revision = "evidence:1";
  try {
    const path = join(directory, "adaptive.sqlite");
    const store = openSentinelAdaptiveStore(path);
    const writer = openSentinelAdaptiveStore(path);
    try {
      const plannerRound = { identity: revision, attempt: 1 };
      const [preferred, obsolete] = store.sync(revision, [
        { kind: "trace", nodeId: "preferred", plannerRound },
        { kind: "trace", nodeId: "obsolete", plannerRound },
      ]);
      const hint = Number(
        writer.addCaseHint("Use the current evidence.", 1).lastInsertRowid,
      );
      const next = { kind: "trace" as const, nodeId: "next", plannerRound };
      const queue = {
        priorities: [preferred.id],
        retirements: [{
          id: obsolete.id,
          reason: "Superseded by a newer source.",
        }],
      };
      assertEquals(store.applyModelPlan(revision, null, [next], queue), null);
      assertEquals(store.list().length, 2);
      assertEquals(store.list()[0].plannerPriority, undefined);
      assertEquals(store.list()[1].retirementReason, undefined);
      assertEquals(store.notes(), []);
      assertEquals(store.applyModelPlan(revision, hint, [next], queue), 1);
      assertEquals(store.list().length, 3);
      assertEquals(store.list()[0].plannerPriority, 1);
      assertEquals(
        store.list()[1].retirementReason,
        "Superseded by a newer source.",
      );
      assertEquals(store.notes().length, 1);
    } finally {
      writer.close();
      store.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Interrupted workers release their leases and cannot save stale observations", async () => {
  const directory = await Deno.makeTempDir();
  const revision = "evidence:1";
  try {
    const store = openSentinelAdaptiveStore(join(directory, "adaptive.sqlite"));
    try {
      store.sync(revision, [{ kind: "trace", nodeId: "app" }]);
      const original = store.claim(revision)!;
      const stale = {
        taskId: original.task.id,
        leaseToken: original.leaseToken,
      };
      assert(store.interrupt(stale, false));
      const resumed = store.claim(revision)!;
      assertNotEquals(resumed.leaseToken, original.leaseToken);
      assert(!store.interrupt(stale, true));
      assertThrows(() =>
        store.complete({ ...stale, observation: { stale: true } })
      );
      assert(
        store.interrupt({
          taskId: resumed.task.id,
          leaseToken: resumed.leaseToken,
        }, true),
      );
      assertEquals(store.list()[0].status, "queued");
      store.sync("evidence:2", [], revision);
      assertEquals(store.list(revision)[0].status, "superseded");
      assertEquals(store.list(revision)[0].observation, undefined);
      assertEquals(store.claim(revision), null);
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Operator notes on a model-planned incident are not model reviews", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = join(directory, "adaptive.sqlite");
    let now = 1_000;
    const store = openSentinelAdaptiveStore(path, () => now);
    try {
      const revision = "evidence:incident";
      const [task] = store.sync(revision, [{
        kind: "review_incident",
        nodeId: "incident",
        reason: "Model planner",
      }]);
      store.addNote(revision, "Operator assignment record.", task.id);
      const lease = store.claim(revision)!;
      store.complete({
        taskId: task.id,
        leaseToken: lease.leaseToken,
        observation: { asset: "app" },
      });
      assertEquals(store.modelReviewNotes(revision), []);
      const claim = store.claimModelReview(revision, "Model planner")!;
      assertEquals(claim.task.id, task.id);
      now++;
      assert(store.finishModelReview(revision, task.id, claim.token, {
        note: "Review checked the saved alerts.",
        steps: [],
      }));
      now++;
      store.addNote(revision, "Later operator note.", task.id);
      assertEquals(
        store.modelReviewNotes(revision).map(({ summary }) => summary),
        ["Review checked the saved alerts."],
      );
      assertEquals(store.claimModelReview(revision, "Model planner"), null);

      // Older stores can record completion before the explicit note link exists.
      const legacy = new DatabaseSync(path);
      try {
        legacy.exec("UPDATE adaptive_model_reviews SET noteId = NULL");
      } finally {
        legacy.close();
      }
      assertEquals(
        store.modelReviewNotes(revision).map(({ summary }) => summary),
        ["Review checked the saved alerts."],
      );
      assertEquals(store.claimModelReview(revision, "Model planner"), null);
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Committed observation discovery is paginated and pinned to the saved revision", () => {
  const directory = Deno.makeTempDirSync();
  const path = join(directory, "adaptive.sqlite");
  const store = openSentinelAdaptiveStore(path);
  try {
    const revision = "evidence:one";
    store.sync(
      revision,
      Array.from({ length: 6 }, (_, index) => ({
        kind: "trace" as const,
        nodeId: `service-${index}`,
      })),
      null,
      { number: 1, goal: { id: "scope", label: "Review inventory" } },
    );
    for (let index = 0; index < 6; index++) {
      const lease = store.claim(revision)!;
      store.complete({
        taskId: lease.task.id,
        leaseToken: lease.leaseToken,
        observation: { details: "Trusted service evidence", index },
      });
    }
    const first = querySentinelWorkerObservations(path, 1, {
      query: "SERVICE EVIDENCE",
      offset: 0,
    });
    assert(first && typeof first === "object");
    assertEquals(first.observations.length, 5);
    assertEquals(first.nextOffset, 5);
    const last = querySentinelWorkerObservations(path, 1, {
      query: "service evidence",
      offset: 5,
    });
    assert(last && typeof last === "object");
    assertEquals(last.observations.length, 1);
    assertEquals(last.nextOffset, null);
    const task = String(last.observations[0].id);
    const json = querySentinelWorkerObservations(path, 1, { task });
    assertEquals(json, '{"details":"Trusted service evidence","index":0}');
    assertEquals(querySentinelWorkerObservations(path, 2, { task }), undefined);
  } finally {
    store.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("Archived asset lookup matches the exact source consulted by a completed review", () => {
  const directory = Deno.makeTempDirSync();
  const path = join(directory, "adaptive.sqlite");
  const store = openSentinelAdaptiveStore(path);
  const digest = "a".repeat(64);
  const source = { caseId: "inventory", digest, asset: "database" };
  try {
    store.sync(
      "evidence:one",
      [{ kind: "trace", nodeId: "database", reason: "fixture" }],
      null,
      { number: 1, goal: { id: "scope", label: "Review inventory" } },
    );
    const lease = store.claim("evidence:one")!;
    store.complete({
      taskId: lease.task.id,
      leaseToken: lease.leaseToken,
      observation: {},
    });
    const review = store.claimModelReview("evidence:one", "fixture")!;
    assert(
      store.finishModelReview("evidence:one", review.task.id, review.token, {
        note: "Reviewed dependency evidence",
        steps: [
          {
            tool: "sentinel_shared_asset_links",
            outcome: "returned",
            sourceSnapshots: [{
              caseId: source.caseId,
              snapshotDigest: digest,
              assetId: source.asset,
            }],
          },
          {
            tool: "sentinel_shared_asset_links",
            outcome: "error",
            sourceSnapshots: [{
              caseId: source.caseId,
              snapshotDigest: digest,
              assetId: "unavailable",
            }],
          },
        ],
      }),
    );
    assertEquals(readAdaptiveAssetSnapshotCitations(path, source, 5), [{
      revision: 1,
      focusId: `observation:adaptive:review:${review.task.id}`,
    }]);
    for (
      const mismatch of [{ caseId: "unrelated" }, { digest: "b".repeat(64) }, {
        asset: "unavailable",
      }]
    ) {
      assertEquals(
        readAdaptiveAssetSnapshotCitations(path, { ...source, ...mismatch }, 5),
        [],
      );
    }
  } finally {
    store.close();
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("Incident provenance waits for an active impact lease to commit", async () => {
  const directory = await Deno.makeTempDir();
  const store = openSentinelAdaptiveStore(join(directory, "adaptive.sqlite"));
  try {
    const revision = "evidence:1";
    const incident = `incident:${"a".repeat(64)}`;
    const source = { kind: "review_incident" as const, nodeId: incident };
    const sourceId = sentinelAdaptiveTaskId(revision, source);
    const target = {
      kind: "impact" as const,
      nodeId: "server",
      prerequisites: [sourceId],
    };
    const targetId = sentinelAdaptiveTaskId(revision, target);
    store.sync(revision, [source, target]);
    const observed = store.claim(revision)!;
    assertEquals(observed.task.id, sourceId);
    assert(
      store.complete({
        taskId: sourceId,
        leaseToken: observed.leaseToken,
        observation: { id: incident, asset: "server" },
      }),
    );
    const running = store.claim(revision)!;
    assertEquals(running.task.id, targetId);
    const sources = [{ targetId, sourceId }];
    const during = store.sync(revision, [], revision, undefined, sources)
      .find(({ id }) => id === targetId)!;
    assertEquals(during.status, "running");
    assertEquals(during.evidenceIds, []);
    assert(
      store.complete({
        taskId: targetId,
        leaseToken: running.leaseToken,
        observation: { summary: "Completed impact" },
      }),
    );
    const after = store.sync(revision, [], revision, undefined, sources)
      .find(({ id }) => id === targetId)!;
    assertEquals(after.evidenceIds, [incident]);
    assertEquals(after.prerequisites, [sourceId]);
    assertEquals(after.observation, { summary: "Completed impact" });
    assertEquals(after.attempts, 1);
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});
