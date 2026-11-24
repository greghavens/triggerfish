import { assert, assertEquals, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import {
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import {
  openSentinelAdaptiveStore,
  SentinelAdaptiveQueueChanged,
  sentinelAdaptiveTaskId,
} from "../../src/sentinel/adaptive_store.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import {
  digestSentinelSnapshot,
  sentinelSourceSnapshotPath,
} from "../../src/sentinel/shared_inventory.ts";
import { sentinelSnapshotPath } from "../../src/sentinel/paths.ts";

Deno.test("Rollover rejects a stale queue snapshot after another coordinator approves prerequisites", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  const origin = "evidence:1";
  const destination = "evidence:2";
  const primary = openSentinelAdaptiveStore(path);
  const concurrent = openSentinelAdaptiveStore(path);
  try {
    const plannerRound = { identity: origin, attempt: 1 };
    const [parent, child] = primary.sync(origin, [
      { kind: "trace", nodeId: "parent", plannerRound },
      { kind: "trace", nodeId: "child", plannerRound },
    ]);
    const expected = primary.taskQueueWatermark();
    assert(concurrent.recommendDependencyChanges(origin, [{
      id: child.id,
      prerequisites: [parent.id],
      reason: "Complete the parent before the child.",
    }]));
    const proposal = concurrent.list(origin).find(({ id }) => id === child.id)!
      .dependencyRecommendation!;
    assert(
      concurrent.resolveDependencyChange(origin, child.id, proposal.id, true),
    );
    const queued = [
      {
        kind: "trace" as const,
        nodeId: "parent",
        carriedFrom: parent.id,
        plannerRound,
      },
      {
        kind: "trace" as const,
        nodeId: "child",
        carriedFrom: child.id,
        plannerRound,
      },
    ];
    assertThrows(
      () =>
        primary.sync(destination, queued, origin, undefined, [], [], expected),
      SentinelAdaptiveQueueChanged,
    );
    assertEquals(primary.activeRevision(), origin);
    assertEquals(primary.list(destination), []);
    assertEquals(
      primary.list(origin).find(({ id }) => id === child.id)?.prerequisites,
      [parent.id],
    );

    const remapped = sentinelAdaptiveTaskId(destination, queued[0]);
    const approvedQueue = primary.taskQueueWatermark();
    assert(
      concurrent.assignQueuedTask(origin, child.id, "Operator assignment"),
    );
    assertThrows(
      () =>
        primary.sync(
          destination,
          [queued[0], { ...queued[1], prerequisites: [remapped] }],
          origin,
          undefined,
          [],
          [],
          approvedQueue,
        ),
      SentinelAdaptiveQueueChanged,
    );
    assertEquals(
      primary.list(origin).find(({ id }) => id === child.id)?.reason,
      "Operator assignment",
    );
    assertEquals(primary.list(destination), []);
    const current = primary.sync(
      destination,
      [
        queued[0],
        {
          ...queued[1],
          prerequisites: [remapped],
          reason: "Operator assignment",
        },
      ],
      origin,
      undefined,
      [],
      [],
      primary.taskQueueWatermark(),
    );
    assertEquals(
      current.find(({ nodeId }) => nodeId === "child")?.prerequisites,
      [remapped],
    );
  } finally {
    concurrent.close();
    primary.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Evidence rollover restarts pending model work with approved prerequisites and exact citations", async () => {
  const directory = await Deno.makeTempDir();
  const path = sentinelSnapshotPath(directory);
  const database = join(dirname(path), "sentinel-adaptive.db");
  const inventory = {
    version: 1,
    nodes: [
      "parent",
      "child",
      "pending-proposal-alt",
      "gone",
      "blocked",
      "retired",
    ]
      .map((id) => ({ id, label: id, kind: "asset" })),
    edges: [],
  };
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(inventory));
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const reporting = loadSentinelGraph({
      version: 1,
      nodes: [
        {
          id: "remote-child",
          label: "Remote child",
          aliases: ["child"],
          kind: "asset",
        },
        {
          id: "finding",
          label: "Reported finding",
          kind: "finding",
          severity: "high",
        },
      ],
      edges: [{ from: "finding", to: "remote-child", relation: "affects" }],
    }).snapshot();
    const digest = digestSentinelSnapshot(reporting);
    const archive = sentinelSourceSnapshotPath(directory, "peer", digest);
    await Deno.mkdir(dirname(archive), { recursive: true });
    await Deno.writeTextFile(archive, JSON.stringify(reporting), {
      mode: 0o600,
    });
    const citation = {
      localAssetId: "child",
      sourceCaseId: "peer",
      sourceAssetId: "remote-child",
      sourceFindingId: "finding",
      snapshotDigest: digest,
    };
    const modelTask = (nodeId: string) => ({
      kind: "trace" as const,
      nodeId,
      reason: MODEL_ASSIGNMENT_REASON,
      plannerRound: { identity: revision, attempt: 1 },
    });
    const parent = modelTask("parent");
    const child = modelTask("child");
    const parentId = sentinelAdaptiveTaskId(revision, parent);
    const childId = sentinelAdaptiveTaskId(revision, child);
    const gone = modelTask("gone");
    const blocked = modelTask("blocked");
    const retired = modelTask("retired");
    const store = openSentinelAdaptiveStore(database);
    try {
      assertEquals(
        store.applyModelPlan(revision, null, [
          parent,
          {
            ...child,
            plannerRound: {
              ...child.plannerRound,
              peerFindingCitations: [citation, {
                ...citation,
                sourceFindingId: "absent",
              }],
            },
          },
          gone,
          {
            ...blocked,
            prerequisites: [sentinelAdaptiveTaskId(revision, gone)],
          },
          retired,
        ], {
          retirements: [{
            id: sentinelAdaptiveTaskId(revision, retired),
            reason: "Retirement needs operator review.",
          }],
        }),
        5,
      );
      assert(store.recommendDependencyChanges(revision, [{
        id: childId,
        prerequisites: [parentId],
        reason: "The parent must complete first.",
      }]));
      const approved = store.list(revision).find(({ id }) => id === childId)!
        .dependencyRecommendation!;
      assert(
        store.resolveDependencyChange(revision, childId, approved.id, true),
      );
      const alternate = modelTask("pending-proposal-alt");
      assert(store.recommendDependencyChanges(revision, [{
        id: childId,
        prerequisites: [sentinelAdaptiveTaskId(revision, alternate)],
        reason: "A separate pending proposal.",
      }], [alternate]));
      const pending = store.list(revision).find(({ id }) => id === childId)!
        .dependencyRecommendation!;
      assert(store.prioritize(revision, parentId));
      const oldLease = store.claim(revision)!;
      assertEquals(oldLease.task.id, parentId);

      await Deno.writeTextFile(
        path,
        JSON.stringify({
          ...inventory,
          nodes: inventory.nodes.filter(({ id }) => id !== "gone"),
        }),
      );
      const next = refreshSentinelAssessment(path)!;
      assert(next.revision > state.revision);
      advanceAdaptiveSentinel(path, next);
      const saved = readAdaptiveSentinel(path, next)!;
      const newParent = saved.tasks.find(({ nodeId }) => nodeId === "parent")!;
      const newChild = saved.tasks.find(({ nodeId }) => nodeId === "child")!;
      assertEquals(newChild.prerequisites, [newParent.id]);
      assertEquals(newChild.dependencyRecommendation, undefined);
      assertEquals(newChild.plannerRound?.peerFindingCitations, [citation]);
      assertEquals(newParent.attempts, 1);
      assertEquals(newChild.attempts, 1);
      assertEquals(newParent.status, "completed");
      assertEquals(newChild.status, "completed");
      assert(
        !saved.tasks.some(({ nodeId }) =>
          ["gone", "blocked", "retired", "pending-proposal-alt"].includes(
            nodeId ?? "",
          )
        ),
      );
      const claims = store.history(saved.revision).filter(({ event, taskId }) =>
        event === "claimed" &&
        (taskId === newParent.id || taskId === newChild.id)
      );
      assertEquals(claims.toReversed().map(({ taskId }) => taskId), [
        newParent.id,
        newChild.id,
      ]);
      assertThrows(() =>
        store.complete({
          taskId: oldLease.task.id,
          leaseToken: oldLease.leaseToken,
          observation: { summary: "stale lease" },
        })
      );
      assertEquals(
        store.resolveDependencyChange(revision, childId, pending.id, true),
        false,
      );
      assertEquals(
        store.history(revision).filter(({ event }) =>
          event === "assignment_unavailable"
        ).map(({ taskId }) => taskId).sort(),
        [gone, blocked, retired].map((task) =>
          sentinelAdaptiveTaskId(revision, task)
        ).sort(),
      );
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Operator recovery distinguishes recorded unavailability from cancellation and ordinary supersession", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  const origin = "evidence:1";
  const destination = "evidence:2";
  const goal = { id: "case-review", label: "Review case inventory" };
  try {
    const first = openSentinelAdaptiveStore(path);
    let taskIds: string[];
    try {
      const tasks = first.sync(
        origin,
        ["unavailable", "cancelled", "ordinary"].map((nodeId) => ({
          kind: "trace",
          nodeId,
        })),
        null,
        { number: 1, goal },
      );
      taskIds = tasks.map(({ id }) => id);
      assert(first.cancelQueued(origin, taskIds[1]));
      first.sync(destination, [], origin, {
        number: 2,
        goal,
        unavailableAssignments: [taskIds[0]],
      });
    } finally {
      first.close();
    }

    const reopened = openSentinelAdaptiveStore(path);
    try {
      assertEquals(taskIds.map((id) => reopened.wasAssignmentUnavailable(id)), [
        true,
        false,
        false,
      ]);
      const [sameTarget] = reopened.sync(destination, [{
        kind: "trace",
        nodeId: "unavailable",
      }], destination);
      assertEquals(reopened.wasAssignmentUnavailable(sameTarget.id), false);
    } finally {
      reopened.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
