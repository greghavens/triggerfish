import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  createOperatorWorkflowRuns,
  type OperatorWorkflowPlan,
} from "../../src/gateway/operator_workflow_runs.ts";
import { createWorkflowRunRegistry } from "../../src/workflow/registry.ts";

async function waitFor(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() >= end) {
      throw new Error("The fixture workflow did not reach the expected state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

Deno.test("Operator workflow adapter starts only admitted plans and controls an exact visible registry run", async () => {
  const registry = createWorkflowRunRegistry();
  const unrelated = crypto.randomUUID();
  registry.registerRun({
    runId: unrelated,
    workflowName: "unrelated",
    taint: "PUBLIC",
  });
  const configured = {
    id: "local-review",
    classification: "INTERNAL" as const,
    steps: [{ id: "settle", waitSeconds: 0.1 }, { id: "record" }],
  };
  const adapter = createOperatorWorkflowRuns(registry, [configured]);
  configured.steps[1].id = "late-config-change";
  assertEquals(adapter.listPlans("PUBLIC"), []);
  assertEquals(adapter.listPlans(), [{
    id: "local-review",
    classification: "INTERNAL",
    stepCount: 2,
  }]);
  assertEquals(adapter.list(), []);
  assertEquals(adapter.inspect(unrelated), undefined);
  assertEquals(adapter.pause(unrelated), undefined);
  assertEquals(adapter.resume(unrelated), undefined);
  assertEquals(adapter.start("unrelated"), undefined);
  assertEquals(adapter.start("local-review", "PUBLIC"), undefined);
  const admitted = adapter.start("local-review");
  assert(admitted);
  try {
    assertEquals(adapter.list("PUBLIC"), []);
    assertEquals(adapter.inspect(admitted.runId, "PUBLIC"), undefined);
    assertEquals(adapter.pause(admitted.runId, "PUBLIC"), undefined);
    assertEquals(adapter.pause(admitted.runId)?.status, "paused");
    await waitFor(() =>
      adapter.inspect(admitted.runId)?.steps[0].status === "completed"
    );
    assertEquals(adapter.inspect(admitted.runId)?.steps[1].status, "pending");
    assertEquals(adapter.inspect(admitted.runId)?.status, "paused");
    assertEquals(adapter.resume(admitted.runId, "PUBLIC"), undefined);
    assertEquals(adapter.resume(admitted.runId)?.status, "running");
    await waitFor(() =>
      adapter.inspect(admitted.runId)?.status === "completed"
    );
    const terminal = adapter.inspect(admitted.runId);
    assert(terminal?.completedAt);
    assertEquals(terminal.steps, [
      { id: "settle", status: "completed" },
      { id: "record", status: "completed" },
    ]);
    assertEquals(registry.getActiveRun(admitted.runId), null);
    assertEquals(adapter.pause(admitted.runId), undefined);
    assertEquals(adapter.resume(admitted.runId), undefined);
    assertEquals(adapter.list().map(({ runId }) => runId), [admitted.runId]);
  } finally {
    if (registry.getActiveRun(admitted.runId)) {
      registry.stopRun(admitted.runId);
      await waitFor(() => registry.getActiveRun(admitted.runId) === null);
    }
    registry.completeRun(unrelated, { status: "cancelled" });
  }
});

Deno.test("Operator workflow configuration excludes arbitrary steps, duplicate IDs and unbounded delays", () => {
  const registry = createWorkflowRunRegistry();
  const base = { id: "fixture", classification: "PUBLIC" as const };
  for (
    const steps of [
      [{ id: "inject", call: "fixture_tool" }],
      [{ id: "inject", run: { shell: "fixture" } }],
      [{ id: "inject", then: "inject" }],
      [{ id: "delay", waitSeconds: 31 }],
      [{ id: "same" }, { id: "same" }],
      [],
    ]
  ) {
    assertThrows(() =>
      createOperatorWorkflowRuns(
        registry,
        [{ ...base, steps }] as OperatorWorkflowPlan[],
      )
    );
  }
  assertThrows(() =>
    createOperatorWorkflowRuns(registry, [
      { ...base, steps: [{ id: "one" }] },
      { ...base, steps: [{ id: "two" }] },
    ])
  );
  assertEquals(registry.listActiveRuns(), []);
});

Deno.test("Operator workflow journal reopens safe history and never replays an admitted request", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "workflow.db");
  const plan = {
    id: "review",
    classification: "INTERNAL" as const,
    steps: [{ id: "pause-point", waitSeconds: 0.1 }, { id: "reviewed" }],
  };
  const other = {
    id: "other",
    classification: "PUBLIC" as const,
    steps: [{ id: "other-step" }],
  };
  const plans = [plan, other];
  const requestId = "a".repeat(64);
  const registry = createWorkflowRunRegistry();
  const first = createOperatorWorkflowRuns(registry, plans, path);
  const started = first.start("review", "INTERNAL", requestId);
  assert(started);
  try {
    assertEquals(first.pause(started.runId)?.status, "paused");
    const newRegistry = createWorkflowRunRegistry();
    const restarted = createOperatorWorkflowRuns(newRegistry, plans, path);
    assertEquals(restarted.inspect(started.runId, "PUBLIC"), undefined);
    assertEquals(restarted.inspect(started.runId)?.status, "interrupted");
    assertEquals(restarted.pause(started.runId), undefined);
    assertEquals(restarted.resume(started.runId), undefined);
    assertEquals(
      restarted.start("review", "INTERNAL", requestId.toUpperCase())?.runId,
      started.runId,
    );
    assertEquals(restarted.start("other", "INTERNAL", requestId), undefined);
    assertEquals(newRegistry.listActiveRuns(), []);
    const altered = createOperatorWorkflowRuns(newRegistry, [
      { ...plan, steps: [{ id: "replaced" }] },
      other,
    ], path);
    assertEquals(altered.inspect(started.runId), undefined);
    assertEquals(altered.start("review", "INTERNAL", requestId), undefined);
    assertEquals(first.resume(started.runId)?.status, "running");
    await waitFor(() => first.inspect(started.runId)?.status === "completed");
    const completed = restarted.inspect(started.runId);
    assertEquals(completed?.status, "completed");
    assert(completed?.completedAt);
    assertEquals(
      completed.steps.every(({ status }) => status === "completed"),
      true,
    );
    assertEquals(restarted.list().map(({ runId }) => runId), [started.runId]);
    assertEquals(restarted.start("review", "INTERNAL", requestId), completed);
    assertEquals(newRegistry.listActiveRuns(), []);
  } finally {
    if (registry.getActiveRun(started.runId)) {
      registry.stopRun(started.runId);
      await waitFor(() => registry.getActiveRun(started.runId) === null);
    }
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Workflow traces page exact durable lifecycle and step events across restart", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "workflow.db");
  const plan = {
    id: "traceable-review",
    classification: "INTERNAL" as const,
    steps: [{ id: "pause-point", waitSeconds: 0.15 }, { id: "reviewed" }],
  };
  const registry = createWorkflowRunRegistry();
  const live = createOperatorWorkflowRuns(registry, [plan], path);
  const first = live.start(plan.id);
  assert(first);
  try {
    await waitFor(() =>
      live.inspect(first.runId)?.steps[0].status === "running"
    );
    assertEquals(live.pause(first.runId)?.status, "paused");
    const page = live.traces(first.runId, "INTERNAL", { limit: 2 });
    assert(page?.nextCursor);
    assertEquals(page.events.map(({ sequence, event }) => [sequence, event]), [
      [1, "admitted"],
      [2, "started"],
    ]);
    const reopened = createOperatorWorkflowRuns(createWorkflowRunRegistry(), [
      plan,
    ], path);
    assertEquals(reopened.traces(first.runId, "PUBLIC"), undefined);
    assertEquals(reopened.traces(crypto.randomUUID()), undefined);
    const paused = reopened.traces(first.runId, "INTERNAL", {
      cursor: page.nextCursor,
      limit: 2,
    });
    assertEquals(
      paused?.events.map(({ sequence, event }) => [sequence, event]),
      [
        [3, "step_started"],
        [4, "paused"],
      ],
    );
    const changedPlan = createOperatorWorkflowRuns(
      createWorkflowRunRegistry(),
      [
        { ...plan, steps: [{ id: "replacement" }] },
      ],
      path,
    );
    assertEquals(changedPlan.traces(first.runId), undefined);
    await waitFor(() =>
      live.inspect(first.runId)?.steps[0].status === "completed"
    );
    assertEquals(live.resume(first.runId)?.status, "running");
    await waitFor(() => live.inspect(first.runId)?.status === "completed");
    const settled = reopened.traces(first.runId, "INTERNAL", {
      cursor: page.nextCursor,
    });
    assert(settled);
    assertEquals(
      settled.events.map((entry) => [
        entry.sequence,
        entry.event,
        "stepId" in entry ? entry.stepId : undefined,
      ]),
      [
        [3, "step_started", "pause-point"],
        [4, "paused", undefined],
        [5, "step_completed", "pause-point"],
        [6, "resumed", undefined],
        [7, "step_started", "reviewed"],
        [8, "step_completed", "reviewed"],
        [9, "completed", undefined],
      ],
    );
    assertEquals(settled.nextCursor, null);
    const exact = reopened.traces(first.runId, "INTERNAL", { sequence: 8 });
    assertEquals(exact?.events, [settled.events[5]]);
    assertEquals(exact?.nextCursor, null);
    assertEquals(
      reopened.traces(first.runId, "INTERNAL", { sequence: 10 }),
      undefined,
    );
    assertEquals(
      reopened.traces(first.runId, "INTERNAL", {
        sequence: 8,
        cursor: page.nextCursor,
      }),
      undefined,
    );
    assertEquals(settled.controlLimitReached, false);
    assert(
      settled.events.every((event) =>
        Object.keys(event).every((key) =>
          ["sequence", "event", "stepId", "at"].includes(key)
        )
      ),
    );
    const second = live.start(plan.id);
    assert(second);
    try {
      assertEquals(
        live.traces(second.runId, "INTERNAL", { cursor: page.nextCursor }),
        undefined,
      );
      assertEquals(
        live.traces(first.runId, "INTERNAL", {
          cursor: page.nextCursor.replace(/\.2$/, ".999"),
        }),
        undefined,
      );
    } finally {
      if (registry.getActiveRun(second.runId)) registry.stopRun(second.runId);
      await waitFor(() => registry.getActiveRun(second.runId) === null);
    }
    assertEquals(
      reopened.traces(second.runId)?.events.at(-1)?.event,
      "cancelled",
    );
  } finally {
    if (registry.getActiveRun(first.runId)) registry.stopRun(first.runId);
    await waitFor(() => registry.getActiveRun(first.runId) === null);
    await Deno.remove(directory, { recursive: true });
  }
});
