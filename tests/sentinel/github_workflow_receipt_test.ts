import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import { buildSentinelProvenance } from "../../src/sentinel/provenance.ts";
import { runSentinelAssessment } from "../../src/sentinel/assessment.ts";
import type { SentinelGitHubWorkflowReadReceipt } from "../../src/sentinel/assessment_store.ts";
import type { AgentTurnCheckpoint } from "../../src/core/types/orchestrator.ts";
import { createHash } from "node:crypto";

Deno.test("GitHub workflow proof persists only for the exact committed case review and projects into planning and provenance", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  const revision = "evidence:4";
  const goal = { id: "review", label: "Review control evidence" };
  const receipt: SentinelGitHubWorkflowReadReceipt = {
    repository: "example/defensive-controls",
    workflowId: 14,
    connectorId: "github",
    observedAt: "2026-01-01T00:00:00.000Z",
    evidenceRevision: 4,
    resultSha256: "a".repeat(64),
    runs: [{ id: 501, status: "completed", conclusion: "failure" }],
  };
  try {
    const store = openSentinelAdaptiveStore(path);
    try {
      const [task] = store.sync(
        revision,
        [{ kind: "trace", nodeId: "app", reason: "fixture" }],
        null,
        { number: 4, goal },
      );
      const work = store.claim(revision)!;
      store.complete({
        taskId: task.id,
        leaseToken: work.leaseToken,
        observation: { relatedNodeIds: ["app"] },
      });
      const before = store.plannerObservations(revision);
      assertEquals(before[0].githubWorkflowReads, undefined);
      const review = store.claimModelReview(revision, "fixture")!;
      const extra = {
        ...receipt,
        token: "not a persisted field",
        runs: [{
          ...receipt.runs[0],
          logs: "raw logs are not a persisted field",
        }],
      };
      const succeeded = {
        tool: "sentinel_live_workflow_status",
        outcome: "returned" as const,
      };
      assert(store.finishModelReview(revision, task.id, review.token, {
        note: "Reviewed workflow status.",
        steps: [
          { ...succeeded, githubWorkflowRead: extra },
          {
            ...succeeded,
            githubWorkflowRead: { ...receipt, evidenceRevision: 3 },
          },
          {
            ...succeeded,
            githubWorkflowRead: { ...receipt, resultSha256: "invalid" },
          },
          { ...succeeded, outcome: "error", githubWorkflowRead: receipt },
          { ...succeeded, tool: "sentinel_trace", githubWorkflowRead: receipt },
        ],
      }));
      const after = store.plannerObservations(revision);
      assertEquals(after[0].githubWorkflowReads, [receipt]);
      assertEquals(after[0].relatedNodeIds, before[0].relatedNodeIds);
      assertEquals(after[0].observation, before[0].observation);
    } finally {
      store.close();
    }
    const reopened = openSentinelAdaptiveStore(path);
    try {
      assertEquals(
        reopened.plannerObservations(revision)[0].githubWorkflowReads,
        [receipt],
      );
      const reviews = reopened.modelReviewNotes(revision);
      assertEquals(
        reviews[0].steps.map(({ githubWorkflowRead }) => githubWorkflowRead),
        [
          receipt,
          undefined,
          undefined,
          undefined,
          undefined,
        ],
      );
      const result = runSentinelAssessment({
        snapshot: { version: 1, nodes: [], edges: [] },
      });
      const graph = buildSentinelProvenance(result, {
        evidenceRevision: 4,
        goal,
        tasks: reopened.list(revision),
        modelReviews: reviews,
      }).snapshot();
      const [node] = graph.nodes.filter((node) => "githubWorkflowRead" in node);
      assert(node && "githubWorkflowRead" in node);
      assertEquals(node.githubWorkflowRead, receipt);
      assert(graph.edges.some(
        ({ from, to, relation }) =>
          from === `observation:adaptive:review:${reviews[0].taskId}` &&
          to === node.id && relation === "references",
      ));
    } finally {
      reopened.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("A leased workflow result is staged once and replayed across a renewed review lease", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  const revision = "evidence:4";
  let time = 1_000;
  const now = () => time;
  const goal = { id: "review", label: "Review control evidence" };
  const receipt: SentinelGitHubWorkflowReadReceipt = {
    repository: "example/defensive-controls",
    workflowId: 14,
    connectorId: "github",
    observedAt: "2026-01-01T00:00:00.000Z",
    evidenceRevision: 4,
    resultSha256: "a".repeat(64),
    runs: [{ id: 501, status: "completed", conclusion: "failure" }],
  };
  const prompt = "Review workflow evidence for the assigned asset.";
  const promptSha256 = createHash("sha256").update(prompt).digest("hex");
  const checkpoint: AgentTurnCheckpoint = {
    history: [
      { role: "user", content: prompt },
      {
        role: "assistant",
        content: " ",
        tool_calls: [{
          id: "sentinel-workflow-status",
          type: "function",
          function: { name: "sentinel_live_workflow_status", arguments: "{}" },
        }],
      },
      {
        role: "tool",
        tool_call_id: "sentinel-workflow-status",
        content: JSON.stringify({ targetId: "app", ...receipt }),
      },
    ],
    completedIterations: 1,
    tokenUsage: { inputTokens: 12, outputTokens: 4 },
    nudgeCount: 0,
    eosRetries: 0,
    toolCallCounts: [["sentinel_live_workflow_status:{}", 1]],
  };
  try {
    const first = openSentinelAdaptiveStore(path, now);
    let taskId: string;
    let token: string;
    try {
      const [task] = first.sync(
        revision,
        [{
          kind: "trace",
          nodeId: "app",
          reason: "fixture",
        }],
        null,
        { number: 4, goal },
      );
      taskId = task.id;
      const work = first.claim(revision)!;
      first.complete({ taskId, leaseToken: work.leaseToken, observation: {} });
      const review = first.claimModelReview(revision, "fixture")!;
      token = review.token;
      assertEquals(
        first.recordLeasedGitHubWorkflowResult(
          revision,
          taskId,
          "wrong",
          4,
          receipt,
        ),
        undefined,
      );
      assertEquals(
        first.recordLeasedGitHubWorkflowResult(revision, taskId, token, 3, {
          ...receipt,
          evidenceRevision: 3,
        }),
        undefined,
      );
      assertEquals(
        first.recordLeasedGitHubWorkflowResult(
          revision,
          taskId,
          token,
          4,
          receipt,
        ),
        receipt,
      );
      const [user, assistant, tool] = checkpoint.history;
      for (
        const invalid of [
          [user, assistant],
          [user, assistant, { ...tool, tool_call_id: "different" }],
          [user, assistant, { ...tool, content: "arbitrary tool result" }],
          [user, {
            ...assistant,
            tool_calls: [{
              id: "sentinel-workflow-status",
              function: { name: "execute", arguments: "{}" },
            }],
          }, tool],
        ]
      ) {
        assertEquals(
          first.recordLeasedWorkerCheckpoint(
            revision,
            taskId,
            token,
            4,
            promptSha256,
            { ...checkpoint, history: invalid },
          ),
          false,
        );
      }
      assertEquals(
        first.recordLeasedWorkerCheckpoint(
          revision,
          taskId,
          token,
          4,
          "b".repeat(64),
          checkpoint,
        ),
        false,
      );
      assert(
        first.recordLeasedWorkerCheckpoint(
          revision,
          taskId,
          token,
          4,
          promptSha256,
          checkpoint,
        ),
      );
      assertEquals(
        first.recordLeasedGitHubWorkflowResult(revision, taskId, token, 4, {
          ...receipt,
          observedAt: "2026-01-02T00:00:00.000Z",
        }),
        receipt,
      );
      assertEquals(
        first.plannerObservations(revision)[0].githubWorkflowReads,
        undefined,
      );
    } finally {
      first.close();
    }

    const reopened = openSentinelAdaptiveStore(path, now);
    try {
      time += 60_000;
      assertEquals(
        reopened.readLeasedGitHubWorkflowResult(revision, taskId, token, 4),
        undefined,
      );
      const resumed = reopened.claimModelReview(revision, "fixture")!;
      assert(resumed.token !== token);
      assertEquals(
        reopened.readLeasedWorkerCheckpoint(
          revision,
          taskId,
          token,
          4,
          promptSha256,
        ),
        undefined,
      );
      assertEquals(
        reopened.readLeasedWorkerCheckpoint(
          revision,
          taskId,
          resumed.token,
          4,
          "b".repeat(64),
        ),
        undefined,
      );
      assertEquals(
        reopened.readLeasedWorkerCheckpoint(
          revision,
          taskId,
          resumed.token,
          4,
          promptSha256,
        ),
        checkpoint,
      );
      assertEquals(
        reopened.readLeasedGitHubWorkflowResult(
          revision,
          taskId,
          resumed.token,
          4,
        ),
        receipt,
      );
      assert(reopened.finishModelReview(revision, taskId, resumed.token, {
        note: "Reviewed staged result.",
        steps: [{
          tool: "sentinel_live_workflow_status",
          outcome: "returned",
          githubWorkflowRead: receipt,
        }],
      }));
      assertEquals(
        reopened.readLeasedGitHubWorkflowResult(
          revision,
          taskId,
          resumed.token,
          4,
        ),
        undefined,
      );
      assertEquals(
        reopened.readLeasedWorkerCheckpoint(
          revision,
          taskId,
          resumed.token,
          4,
          promptSha256,
        ),
        undefined,
      );
      assertEquals(
        reopened.plannerObservations(revision)[0].githubWorkflowReads,
        [receipt],
      );
    } finally {
      reopened.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Intermediate workflow observations survive the publisher lease and are private to exact target peers", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  const revision = "evidence:4";
  let time = 1_000;
  const now = () => time;
  const goal = { id: "review", label: "Review workflow evidence" };
  const receipt: SentinelGitHubWorkflowReadReceipt = {
    repository: "example/defensive-controls",
    workflowId: 14,
    connectorId: "github",
    observedAt: "2026-01-01T00:00:00.000Z",
    evidenceRevision: 4,
    resultSha256: "a".repeat(64),
    runs: [{ id: 501, status: "completed", conclusion: "failure" }],
  };
  try {
    const store = openSentinelAdaptiveStore(path, now);
    let publishedId: string;
    let publisherId: string;
    let peerId: string;
    let staleToken: string;
    try {
      const [publisher, peer, other] = store.sync(
        revision,
        [
          { kind: "trace", nodeId: "target", reason: "fixture" },
          { kind: "impact", nodeId: "target", reason: "fixture" },
          { kind: "trace", nodeId: "different", reason: "fixture" },
        ],
        null,
        { number: 4, goal },
      );
      publisherId = publisher.id;
      peerId = peer.id;
      for (let i = 0; i < 3; i++) {
        const lease = store.claim(revision)!;
        store.complete({
          taskId: lease.task.id,
          leaseToken: lease.leaseToken,
          observation: {},
        });
      }
      const review = (id: string) =>
        store.claimModelReview(revision, "fixture", (task) => task.id === id)!;
      const owner = review(publisher.id);
      const peerLease = review(peer.id);
      staleToken = peerLease.token;
      const unrelated = review(other.id);
      assertEquals(
        store.commitLeasedWorkflowObservation(
          revision,
          publisher.id,
          owner.token,
          4,
          3,
        ),
        undefined,
      );
      assertEquals(
        store.recordLeasedGitHubWorkflowResult(
          revision,
          publisher.id,
          owner.token,
          4,
          receipt,
        ),
        receipt,
      );
      assertEquals(store.workflowObservations(revision), []);
      assertEquals(
        store.commitLeasedWorkflowObservation(
          revision,
          publisher.id,
          owner.token,
          4,
          -1,
        ),
        undefined,
      );
      const published = store.commitLeasedWorkflowObservation(
        revision,
        publisher.id,
        owner.token,
        4,
        3,
      )!;
      publishedId = published.id;
      assertEquals(published, {
        id: publishedId,
        taskId: publisher.id,
        targetId: "target",
        evidenceRevision: 4,
        stepIndex: 3,
        receipt,
      });
      assertEquals(
        store.commitLeasedWorkflowObservation(
          revision,
          publisher.id,
          owner.token,
          4,
          3,
        ),
        published,
      );
      assertEquals(
        store.commitLeasedWorkflowObservation(
          revision,
          publisher.id,
          owner.token,
          4,
          4,
        ),
        undefined,
      );
      assertEquals(store.modelReviewNotes(revision), []);
      assertEquals(
        store.activeModelReviewTask(revision, publisher.id, owner.token)?.id,
        publisher.id,
      );
      assertEquals(
        store.listLeasedWorkflowObservations(
          revision,
          publisher.id,
          owner.token,
          4,
        ),
        [],
      );
      assertEquals(
        store.listLeasedWorkflowObservations(
          revision,
          other.id,
          unrelated.token,
          4,
        ),
        [],
      );
      assertEquals(
        store.readLeasedWorkflowObservation(
          revision,
          other.id,
          unrelated.token,
          4,
          publishedId,
        ),
        undefined,
      );
      assertEquals(
        store.listLeasedWorkflowObservations(
          revision,
          peer.id,
          peerLease.token,
          4,
        ),
        [published],
      );
      assertEquals(
        store.listLeasedWorkflowObservations(
          revision,
          peer.id,
          peerLease.token,
          4,
          1,
          1,
        ),
        [],
      );
      assertEquals(
        store.readLeasedWorkflowObservation(
          revision,
          peer.id,
          peerLease.token,
          4,
          publishedId,
        ),
        published,
      );
      assertEquals(
        store.readLeasedWorkflowObservation(
          revision,
          peer.id,
          peerLease.token,
          3,
          publishedId,
        ),
        undefined,
      );
    } finally {
      store.close();
    }

    const reopened = openSentinelAdaptiveStore(path, now);
    try {
      time += 60_000;
      assertEquals(
        reopened.readLeasedWorkflowObservation(
          revision,
          peerId,
          staleToken,
          4,
          publishedId,
        ),
        undefined,
      );
      const renewed = reopened.claimModelReview(
        revision,
        "fixture",
        (task) => task.id === peerId,
      )!;
      assertEquals(
        reopened.readLeasedWorkflowObservation(
          revision,
          peerId,
          renewed.token,
          4,
          publishedId,
        )?.id,
        publishedId,
      );
      assertEquals(
        reopened.history(revision).filter(({ taskId, event }) =>
          taskId === publisherId && event === "workflow_observation_committed"
        ).length,
        1,
      );
      reopened.sync("evidence:5", [], revision, { number: 5, goal });
      assertEquals(
        reopened.readLeasedWorkflowObservation(
          revision,
          peerId,
          renewed.token,
          4,
          publishedId,
        ),
        undefined,
      );
      assertEquals(reopened.workflowObservations("evidence:5"), []);
      assertEquals(reopened.workflowObservations(revision)[0].id, publishedId);
      assertEquals(
        reopened.workflowObservationById("evidence:5", publishedId),
        undefined,
      );
      assertEquals(
        reopened.workflowObservationById(revision, publishedId)?.id,
        publishedId,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
