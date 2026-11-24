import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import { buildSentinelProvenance } from "../../src/sentinel/provenance.ts";
import { runSentinelAssessment } from "../../src/sentinel/assessment.ts";
import type { SentinelGitHubWorkflowReadReceipt } from "../../src/sentinel/assessment_store.ts";

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
