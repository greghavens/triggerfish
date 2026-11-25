import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  formatSentinelWorkerSteering,
  openSentinelAdaptiveStore,
  workerSteeringCheckpointIds,
} from "../../src/sentinel/adaptive_store.ts";
import type { AgentTurnCheckpoint } from "../../src/core/types/orchestrator.ts";
import { createHash } from "node:crypto";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  requestSentinelWorkerControl,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";

Deno.test("Running worker steering and stop are exact, durable and retain only interim progress", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  const revision = "evidence:2";
  const nextRevision = "evidence:3";
  const steerId = crypto.randomUUID();
  const stopId = crypto.randomUUID();
  const reason = "model fixture";
  const progress = [{
    tool: "sentinel_trace",
    target: "app",
    outcome: "returned" as const,
  }];
  const goal = { id: "scope", label: "Defensive review" };
  try {
    const store = openSentinelAdaptiveStore(path);
    try {
      const [task, other] = store.sync(
        revision,
        [
          { kind: "trace", nodeId: "app", reason },
          { kind: "trace", nodeId: "other" },
        ],
        null,
        { number: 2, goal },
      );
      const lease = store.claim(revision)!;
      assertEquals(lease.task.id, task.id);
      store.complete({
        taskId: task.id,
        leaseToken: lease.leaseToken,
        observation: {},
      });
      assertEquals(
        store.requestModelReviewControl(
          revision,
          task.id,
          steerId,
          "steer",
          "Focus",
        ),
        undefined,
      );
      const review = store.claimModelReview(revision, reason)!;
      assertEquals(review.task.id, task.id);
      const steer = store.requestModelReviewControl(
        revision,
        task.id,
        steerId,
        "steer",
        "Focus on saved evidence.",
      )!;
      assertEquals(
        store.requestModelReviewControl(
          revision,
          task.id,
          steerId,
          "steer",
          steer.note,
        ),
        steer,
      );
      assertEquals(
        store.requestModelReviewControl(
          revision,
          task.id,
          steerId,
          "steer",
          "Replacement",
        ),
        undefined,
      );
      assertEquals(
        store.requestModelReviewControl(
          revision,
          other.id,
          steerId,
          "steer",
          steer.note,
        ),
        undefined,
      );
      assert(
        !store.markModelReviewSteeringApplied(
          revision,
          task.id,
          "stale",
          steer.steeringId!,
        ),
      );
      assert(
        store.markModelReviewSteeringApplied(
          revision,
          task.id,
          review.token,
          steer.steeringId!,
        ),
      );
      assert(
        store.recordModelReviewProgress(
          revision,
          task.id,
          review.token,
          progress,
        ),
      );
      assert(
        !store.recordModelReviewProgress(revision, task.id, review.token, []),
      );
      const stop = store.requestModelReviewControl(
        revision,
        task.id,
        stopId,
        "stop",
      )!;
      assertEquals(
        store.activeModelReviewTask(revision, task.id, review.token),
        undefined,
      );
      assert(
        !store.markModelReviewSteeringApplied(
          revision,
          task.id,
          review.token,
          steer.steeringId!,
        ),
      );
      assertEquals(
        store.requestModelReviewControl(revision, task.id, stopId, "stop"),
        stop,
      );
      const state = store.modelReviewStates(revision)[0];
      assertEquals(state.status, "stopped");
      assertEquals(state.progressSteps, progress);
      assert(state.lastSteering?.appliedAt);
      assert(store.finishModelReview(revision, task.id, review.token, {
        note: "Late completion should never commit",
        steps: progress,
        followUps: [{ kind: "trace", nodeId: "never-enqueue" }],
      }));
      assertEquals(store.modelReviewNotes(revision), []);
      assertEquals(
        store.list(revision).some(({ nodeId }) => nodeId === "never-enqueue"),
        false,
      );
      assertEquals(store.claimModelReview(revision, reason), null);
      assert(!store.retryModelReview(revision, task.id));
      store.sync(nextRevision, [], revision, { number: 3, goal });

      const restarted = openSentinelAdaptiveStore(path);
      try {
        assertEquals(
          restarted.requestModelReviewControl(
            revision,
            task.id,
            stopId,
            "stop",
            undefined,
            false,
          ),
          stop,
        );
        assertEquals(
          restarted.requestModelReviewControl(
            nextRevision,
            task.id,
            stopId,
            "stop",
          ),
          undefined,
        );
        assertEquals(restarted.modelReviewStates(revision)[0], state);
      } finally {
        restarted.close();
      }
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Running adaptive review sees exact operator steering and stops at the next boundary", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "sentinel.json");
  const database = join(directory, "sentinel-adaptive.db");
  const reached = Promise.withResolvers<void>();
  const steer = Promise.withResolvers<void>();
  const steered = Promise.withResolvers<void>();
  const stop = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const trace = {
    tool: "sentinel_trace",
    target: "app",
    outcome: "returned" as const,
  };
  let instructions: readonly string[] | undefined;
  let blocked = false;
  const planner = createSentinelModelPlanner(path, (_state, taskId) => ({
    async execute(_content, send, _signal, record, _digests, options) {
      if (!taskId) return;
      record?.(trace);
      reached.resolve();
      await steer.promise;
      instructions = (await options?.workerBoundary?.("before_action"))
        ?.instructions;
      steered.resolve();
      await stop.promise;
      blocked = (await options?.workerBoundary?.("before_tool"))?.stop === true;
      send({
        type: "response",
        text: "Late model response.",
        taint: "INTERNAL",
      });
    },
    clear() {
      if (taskId) closed.resolve();
    },
  }));
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{ id: "app", kind: "asset", label: "Application" }],
        edges: [],
      }),
    );
    const state = startSentinelAssessment(path);
    const revision = adaptiveRevision(state);
    advanceAdaptiveSentinel(path, state);
    const store = openSentinelAdaptiveStore(database);
    try {
      const [task] = store.sync(revision, [{
        kind: "trace",
        nodeId: "app",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      advanceAdaptiveSentinel(path, state);
      planner.advance(state);
      await Promise.race([
        reached.promise,
        new Promise<never>((_, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Worker did not start")),
            2_000,
          );
          void reached.promise.then(() => clearTimeout(timeout));
        }),
      ]);
      const control = requestSentinelWorkerControl(
        path,
        revision,
        task.id,
        crypto.randomUUID(),
        "steer",
        "Inspect the exact local record.",
      );
      assert(control?.steeringId);
      steer.resolve();
      await steered.promise;
      assertEquals(instructions, [
        formatSentinelWorkerSteering(
          control.steeringId,
          "Inspect the exact local record.",
        ),
      ]);
      assert(
        requestSentinelWorkerControl(
          path,
          revision,
          task.id,
          crypto.randomUUID(),
          "stop",
        ),
      );
      stop.resolve();
      await closed.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert(blocked);
      assertEquals(store.modelReviewStates(revision)[0].status, "stopped");
      assertEquals(store.modelReviewStates(revision)[0].progressSteps, [trace]);
      assertEquals(store.modelReviewNotes(revision), []);
    } finally {
      store.close();
    }
  } finally {
    steer.resolve();
    stop.resolve();
    planner.stop();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Saved worker checkpoints retain only exact steering already in their history", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  let time = 1_000;
  const store = openSentinelAdaptiveStore(path, () => time);
  const revision = "evidence:1";
  const role = "fixture";
  try {
    const [task] = store.sync(
      revision,
      [{ kind: "trace", nodeId: "app", reason: role }],
      null,
      {
        number: 1,
        goal: { id: "review", label: "Review saved controls" },
      },
    );
    const deterministic = store.claim(revision)!;
    store.complete({
      taskId: task.id,
      leaseToken: deterministic.leaseToken,
      observation: {},
    });
    const review = store.claimModelReview(revision, role)!;
    const first = store.requestModelReviewControl(
      revision,
      task.id,
      crypto.randomUUID(),
      "steer",
      "Inspect the exact record.",
    )!;
    assert(
      store.markModelReviewSteeringApplied(
        revision,
        task.id,
        review.token,
        first.steeringId!,
      ),
    );
    const receipt = {
      repository: "owner/controls",
      workflowId: 1,
      connectorId: "github-actions",
      observedAt: "2026-01-01T00:00:00.000Z",
      evidenceRevision: 1,
      resultSha256: "a".repeat(64),
      runs: [{ id: 2, status: "completed", conclusion: "success" }],
    };
    assert(
      store.recordLeasedGitHubWorkflowResult(
        revision,
        task.id,
        review.token,
        1,
        receipt,
      ),
    );
    const prompt = "Inspect the assigned record.";
    const digest = createHash("sha256").update(prompt).digest("hex");
    const checkpoint: AgentTurnCheckpoint = {
      history: [
        { role: "user", content: prompt },
        {
          role: "user",
          content: "Operator guidance for this assignment:\n" +
            formatSentinelWorkerSteering(first.steeringId!, first.note!),
        },
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "workflow",
            function: {
              name: "sentinel_live_workflow_status",
              arguments: "{}",
            },
          }],
        },
        {
          role: "tool",
          content: JSON.stringify({ targetId: "app", ...receipt }),
          tool_call_id: "workflow",
        },
      ],
      completedIterations: 2,
      tokenUsage: { inputTokens: 2, outputTokens: 1 },
      nudgeCount: 0,
      eosRetries: 0,
      toolCallCounts: [["sentinel_live_workflow_status:{}", 1]],
    };
    assert(
      !store.recordLeasedWorkerCheckpoint(
        revision,
        task.id,
        review.token,
        1,
        digest,
        {
          ...checkpoint,
          history: [
            checkpoint.history[0],
            {
              role: "user",
              content:
                "Operator guidance for this assignment:\nUnverified guidance",
            },
            ...checkpoint.history.slice(2),
          ],
        },
      ),
    );
    assert(
      store.recordLeasedWorkerCheckpoint(
        revision,
        task.id,
        review.token,
        1,
        digest,
        checkpoint,
      ),
    );
    const absent = store.requestModelReviewControl(
      revision,
      task.id,
      crypto.randomUUID(),
      "steer",
      "Inspect the ownership.",
    )!;
    assert(
      store.markModelReviewSteeringApplied(
        revision,
        task.id,
        review.token,
        absent.steeringId!,
      ),
    );
    time += 60_000;
    const next = store.claimModelReview(revision, role)!;
    const reopened = store.readLeasedWorkerCheckpoint(
      revision,
      task.id,
      next.token,
      1,
      digest,
    )!;
    assertEquals(reopened, {
      ...checkpoint,
      history: [
        ...checkpoint.history.slice(0, 2),
        {
          role: "assistant",
          content: " ",
          tool_calls: [{
            id: "sentinel-workflow-status",
            type: "function",
            function: {
              name: "sentinel_live_workflow_status",
              arguments: "{}",
            },
          }],
        },
        {
          role: "tool",
          content: JSON.stringify({ targetId: "app", ...receipt }),
          tool_call_id: "sentinel-workflow-status",
        },
      ],
    });
    assertEquals(
      workerSteeringCheckpointIds(
        reopened.history,
        store.modelReviewControls(revision, task.id).steering,
      ),
      [first.steeringId],
    );
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});
