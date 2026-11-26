import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import {
  advanceAdaptiveSentinel,
  controlSentinelTask,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { SENTINEL_WORKER_NARRATIVE_COMMIT } from "../../src/sentinel/worker_narratives.ts";

Deno.test("Sentinel reconciles a committed worker observation when the process exits before progress", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  const database = join(dirname(path), "sentinel-adaptive.db");
  const process = new URL(
    "../sentinel/fixtures/worker_narrative_process.ts",
    import.meta.url,
  );
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { kind: "asset", id: "app", label: "Assigned application" },
          {
            kind: "evidence",
            id: "retained-check",
            label: "Saved inventory check",
          },
        ],
        edges: [{ from: "retained-check", to: "app", relation: "observed_on" }],
      }),
    );
    const state = startSentinelAssessment(path);
    const revision = adaptiveRevision(state);
    advanceAdaptiveSentinel(path, state);
    const seed = openSentinelAdaptiveStore(database);
    let taskId: string;
    try {
      const task = seed.sync(revision, [{
        kind: "trace",
        nodeId: "app",
        depth: 7,
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision).find((item) => item.kind === "trace" && item.depth === 7);
      assert(task);
      taskId = task.id;
    } finally {
      seed.close();
    }
    advanceAdaptiveSentinel(path, state);
    const run = (phase: string, clock?: number) =>
      new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          process.pathname,
          baseDir,
          taskId,
          phase,
          clock === undefined ? "" : String(clock),
        ],
        signal: AbortSignal.timeout(20_000),
        stdout: "piped",
        stderr: "piped",
      }).output();
    const reviewState = () => {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        const event = db.prepare(
          `SELECT event FROM adaptive_events WHERE taskId = ?
          AND event IN ('model_mutation_pending', 'model_mutation_settled')
          ORDER BY rowid DESC LIMIT 1`,
        ).get(taskId)?.event;
        const checkpoint = db.prepare(
          "SELECT checkpoint FROM adaptive_worker_checkpoints WHERE taskId = ?",
        ).get(taskId)?.checkpoint;
        const progress = db.prepare(
          "SELECT steps FROM adaptive_worker_progress WHERE taskId = ?",
        ).get(taskId)?.steps;
        const available = Number(
          db.prepare(
            "SELECT availableAt FROM adaptive_model_reviews WHERE taskId = ?",
          ).get(taskId)?.availableAt,
        );
        const receipt = db.prepare(
          "SELECT id, receipt FROM adaptive_worker_narratives WHERE taskId = ?",
        ).get(taskId);
        const count = db.prepare(`SELECT count(*) AS count FROM adaptive_events
          WHERE taskId = ? AND event = 'worker_narrative_committed'`).get(
          taskId,
        )?.count;
        return { event, checkpoint, progress, available, receipt, count };
      } finally {
        db.close();
      }
    };
    const audit = new TextDecoder();
    const interrupted = await run("interrupt");
    assertEquals(interrupted.code, 73, audit.decode(interrupted.stderr));
    const pending = reviewState();
    assertEquals(pending.event, "model_mutation_pending");
    assertEquals(pending.count, 1);
    assertEquals(typeof pending.receipt?.id, "string");
    assertStringIncludes(String(pending.progress), "sentinel_assigned_target");
    assert(
      !String(pending.progress).includes(SENTINEL_WORKER_NARRATIVE_COMMIT),
    );
    assertEquals(JSON.parse(String(pending.checkpoint)).completedIterations, 1);
    const denied = await run("deny", pending.available + 1);
    assertEquals(denied.code, 0, audit.decode(denied.stderr));
    await assertRejects(
      () => Deno.stat(join(baseDir, "resumed-narrative")),
      Deno.errors.NotFound,
    );
    const recovered = reviewState();
    assertEquals(recovered.event, "model_mutation_settled");
    assertEquals(recovered.count, 1);
    assertEquals(recovered.receipt, pending.receipt);
    assertStringIncludes(
      String(recovered.checkpoint),
      "sentinel-worker-narrative:",
    );
    assert(
      !String(recovered.checkpoint).includes(
        "Reviewed the saved inventory observation.",
      ),
    );
    controlSentinelTask(path, revision, taskId, "retry_model_review");
    const resumed = await run("resume", recovered.available + 1);
    assertEquals(resumed.code, 0, audit.decode(resumed.stderr));
    const result = JSON.parse(
      await Deno.readTextFile(join(baseDir, "resumed-narrative")),
    );
    assertEquals(result.id, pending.receipt?.id);
    assertEquals(result.receipt, JSON.parse(String(pending.receipt?.receipt)));
    assertEquals(reviewState().count, 1);
    const final = readAdaptiveSentinel(path, state, "revision")?.modelReviews
      .find((item) => item.taskId === taskId);
    assertEquals(final?.steps.map(({ tool }) => tool), [
      "sentinel_assigned_target",
      SENTINEL_WORKER_NARRATIVE_COMMIT,
    ]);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
