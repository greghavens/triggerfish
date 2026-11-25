import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  recordSentinelOperatingConstraints,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import type { SentinelOperatingConstraints } from "../../src/sentinel/operating_constraints.ts";

const graph = {
  version: 1,
  nodes: [
    { id: "app", kind: "asset", label: "Application" },
    { id: "outside", kind: "asset", label: "Out-of-scope service" },
  ],
  edges: [],
};

async function until(predicate: () => boolean) {
  const end = Date.now() + 2500;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert(predicate(), "Timed out waiting for the exact runtime state");
}

function update(
  path: string,
  state: ReturnType<typeof startSentinelAssessment>,
  expectedVersion: number,
  constraints: SentinelOperatingConstraints,
) {
  const record = recordSentinelOperatingConstraints(path, {
    runId: state.plan.runId!,
    evidenceRevision: state.revision,
    expectedVersion,
    requestId: crypto.randomUUID(),
    operatorScope: "owner",
    constraints,
  });
  assertExists(record);
  return record;
}

Deno.test("live planner supersedes its stale response and starts a constraint-bound round", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  const release = Promise.withResolvers<void>();
  const attempts: { prompt: string; signal: AbortSignal }[] = [];
  const planner = createSentinelModelPlanner(path, (_state, taskId) => ({
    async execute(content, send, signal) {
      assertEquals(taskId, undefined);
      assertExists(signal);
      attempts.push({ prompt: String(content), signal });
      if (attempts.length === 1) await release.promise;
      send({
        type: "response",
        text: JSON.stringify([{
          kind: "trace",
          nodeId: "outside",
          reason: "Review the outside service",
        }]),
        taint: "INTERNAL",
      });
    },
    clear() {},
  }));
  try {
    await Deno.writeTextFile(path, JSON.stringify(graph));
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    planner.advance(state);
    await until(() => attempts.length === 1);
    const receipt = update(path, state, 0, {
      deniedKinds: [],
      allowedAssetIds: ["app"],
      note: "Check only the application.",
    });
    planner.advance(state);
    assert(attempts[0].signal.aborted);
    release.resolve();
    await until(() =>
      readAdaptiveSentinel(path, state)?.modelPlannerHistory.some((
        { outcome },
      ) => outcome === "superseded") === true
    );
    planner.advance(state);
    await until(() =>
      readAdaptiveSentinel(path, state)?.modelPlanner?.status ===
        "proposal_rejected"
    );
    const projection = readAdaptiveSentinel(path, state);
    assertExists(projection);
    assertEquals(attempts.length, 2);
    assertStringIncludes(attempts[1].prompt, receipt.digest);
    assertStringIncludes(attempts[1].prompt, '"allowedAssetIds":["app"]');
    assertEquals(
      projection.modelPlannerHistory.at(-1)?.inputManifest
        ?.operatingConstraints,
      {
        version: receipt.version,
        digest: receipt.digest,
      },
    );
    assert(!projection.tasks.some((task) => task.nodeId === "outside"));
  } finally {
    release.resolve();
    planner.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("running worker applies the leased constraints and retains earlier steps on a scope change", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  const release = Promise.withResolvers<void>();
  let workerPrompt = "";
  let gateStopped: boolean | undefined;
  let finished = false;
  const step = {
    tool: "sentinel_trace",
    target: "app",
    outcome: "returned" as const,
  };
  const planner = createSentinelModelPlanner(path, (_state, taskId) => ({
    async execute(content, send, _signal, record, _digests, options) {
      if (!taskId) return;
      workerPrompt = String(content);
      record?.(step);
      await release.promise;
      gateStopped = (await options?.workerBoundary?.("before_tool"))?.stop;
      send({
        type: "response",
        text: JSON.stringify({
          review: "Late review",
          followUps: [{ kind: "trace", nodeId: "outside" }],
        }),
        taint: "INTERNAL",
      });
    },
    clear() {
      if (workerPrompt) finished = true;
    },
  }));
  try {
    await Deno.writeTextFile(path, JSON.stringify(graph));
    const state = startSentinelAssessment(path);
    const first = update(path, state, 0, {
      deniedKinds: [],
      allowedAssetIds: ["app"],
    });
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(join(dir, "sentinel-adaptive.db"));
    try {
      const [task] = store.sync(
        revision,
        [{
          kind: "trace",
          nodeId: "app",
          reason: MODEL_ASSIGNMENT_REASON,
        }],
        null,
        {
          number: state.revision,
          goal: {
            id: state.plan.runId!,
            label: "Investigate prioritized defensive findings",
          },
        },
      );
      const deterministic = store.claim(revision);
      assertExists(deterministic);
      assert(
        store.complete({
          taskId: task.id,
          leaseToken: deterministic.leaseToken,
          observation: {},
        }),
      );
      planner.advance(state);
      await until(() =>
        store.modelReviewProgress(revision, task.id).length === 1
      );
      assertStringIncludes(workerPrompt, first.digest);
      assertStringIncludes(workerPrompt, '"allowedAssetIds":["app"]');
      update(path, state, first.version, {
        deniedKinds: ["trace"],
        allowedAssetIds: ["app"],
      });
      release.resolve();
      await until(() => finished);
      assertEquals(gateStopped, true);
      assertEquals(store.modelReviewProgress(revision, task.id), [step]);
      assertEquals(store.modelReviewNotes(revision), []);
      assert(!store.list(revision).some((item) => item.nodeId === "outside"));
    } finally {
      store.close();
    }
  } finally {
    release.resolve();
    planner.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
