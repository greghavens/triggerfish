import { assert, assertEquals, assertExists } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { openSentinelEvidenceDigests } from "../../src/sentinel/evidence_digests.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";

interface PlannerInput {
  readonly inventory: readonly { id: string; kind: string }[];
  readonly coldDigests: readonly { id: string; memberCount: number }[];
}

Deno.test("adaptive planner archives omitted inventory in exact evidence digests and records the presented IDs", async () => {
  const directory = await Deno.makeTempDir();
  const caseId = "cold-inventory";
  const path = resolveSentinelCasePath(directory, caseId);
  const evidence = Array.from({ length: 44 }, (_, index) => ({
    id: `record-${String(index).padStart(2, "0")}`,
    kind: "evidence",
    label: `Committed evidence ${index}`,
  }));
  let calls = 0;
  const received = Promise.withResolvers<PlannerInput>();
  const makePlanner = () =>
    createSentinelModelPlanner(path, (_state, taskId) => ({
      execute(content, send) {
        assertEquals(taskId, undefined);
        calls++;
        const prompt = String(content);
        received.resolve(
          JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)),
        );
        send({ type: "response", text: "[]", taint: "INTERNAL" });
        return Promise.resolve();
      },
      clear() {},
    }));
  const first = makePlanner();
  const reopened = makePlanner();
  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "service", kind: "asset", label: "Assigned service" },
          ...evidence,
        ],
        edges: [],
      }),
      { mode: 0o600 },
    );
    const state = startSentinelAssessment(path);
    assertExists(state.plan.runId);
    const scope = {
      caseId,
      runId: state.plan.runId,
      evidenceRevision: state.revision,
    };
    advanceAdaptiveSentinel(path, state);
    first.advance(state);
    const timeout = setTimeout(
      () => received.reject(new Error("Planner did not dispatch")),
      2000,
    );
    const prompt = await received.promise.finally(() => clearTimeout(timeout));
    assert(prompt.inventory.length <= 30);
    assert(prompt.coldDigests.length >= 1);
    const inline = new Set(prompt.inventory.map(({ id }) => id));
    const omitted = evidence.filter(({ id }) => !inline.has(id)).map(({ id }) =>
      "evidence:" + id
    ).sort();
    assert(omitted.length >= 14);
    const digests = openSentinelEvidenceDigests(directory);
    try {
      const refs: string[] = [];
      for (const digest of prompt.coldDigests) {
        const page = digests.expand(scope, digest.id, 30);
        assertExists(page);
        const members = [...page.members];
        let cursor = page.nextCursor;
        while (cursor) {
          const next = digests.expand(scope, digest.id, 30, cursor);
          assertExists(next);
          members.push(...next.members);
          cursor = next.nextCursor;
        }
        assertEquals(members.length, digest.memberCount);
        refs.push(
          ...members.filter(({ kind }) => kind === "evidence").map(({ id }) =>
            id
          ),
        );
      }
      assertEquals(refs.sort(), omitted);
      assertEquals(
        digests.list(scope)?.digests.map(({ id }) => id).sort(),
        prompt.coldDigests.map(({ id }) => id).sort(),
      );
    } finally {
      digests.close();
    }
    const deadline = Date.now() + 2000;
    while (
      readAdaptiveSentinel(path, state)?.modelPlanner?.status !==
        "no_new_assignments" && Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const latest = readAdaptiveSentinel(path, state);
    assertEquals(latest?.modelPlanner?.status, "no_new_assignments");
    assertEquals(
      latest?.modelPlannerHistory.at(-1)?.inputManifest?.coldDigestIds,
      prompt.coldDigests.map(({ id }) => id),
    );
    first.stop();
    reopened.advance(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(calls, 1);
    const journal = openSentinelEvidenceDigests(directory);
    try {
      assertEquals(
        journal.list(scope)?.digests.length,
        prompt.coldDigests.length,
      );
    } finally {
      journal.close();
    }
  } finally {
    first.stop();
    reopened.stop();
    await Deno.remove(directory, { recursive: true });
  }
});

interface HistoryPlannerInput extends PlannerInput {
  readonly coldHistoryDigests: readonly { id: string; memberCount: number }[];
  readonly currentInvestigations: readonly { id: string }[];
  readonly workerObservations: readonly {
    taskId: string;
    observation?: unknown;
    reviewSummary?: string;
  }[];
}

Deno.test("planner history digests retain omitted completed assignments and both observation kinds", async () => {
  const directory = await Deno.makeTempDir();
  const caseId = "cold-committed-history";
  const path = resolveSentinelCasePath(directory, caseId);
  const count = 44;
  const assets = Array.from({ length: count }, (_, index) => ({
    id: `asset-${String(index).padStart(2, "0")}`,
    kind: "asset",
    label: `Committed application ${index}`,
  }));
  const received = Promise.withResolvers<HistoryPlannerInput>();
  const planner = createSentinelModelPlanner(path, (_state, taskId) => ({
    execute(content, send) {
      assertEquals(taskId, undefined);
      const prompt = String(content);
      received.resolve(JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)));
      send({ type: "response", text: "[]", taint: "INTERNAL" });
      return Promise.resolve();
    },
    clear() {},
  }));
  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({ version: 1, nodes: assets, edges: [] }),
      { mode: 0o600 },
    );
    const state = startSentinelAssessment(path);
    assertExists(state.plan.runId);
    const scope = {
      caseId,
      runId: state.plan.runId,
      evidenceRevision: state.revision,
    };
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    const completed = new Set<string>();
    const incomplete = new Set<string>();
    try {
      store.sync(
        revision,
        assets.map(({ id }) => ({
          kind: "trace",
          nodeId: id,
          reason: MODEL_ASSIGNMENT_REASON,
        })),
        null,
        {
          number: state.revision,
          goal: {
            id: state.plan.runId,
            label: "Investigate prioritized defensive findings",
          },
        },
      );
      for (let index = 0; index < count - 2; index++) {
        const next = store.claim(revision);
        assertExists(next);
        const { id, nodeId } = next.task;
        assert(store.complete({
          taskId: id,
          leaseToken: next.leaseToken,
          observation: {
            relatedNodeIds: [nodeId],
            summary: `Committed worker result ${index} ` +
              "details ".repeat(30),
          },
        }));
        const review = store.claimModelReview(
          revision,
          MODEL_ASSIGNMENT_REASON,
          (task) => task.id === id,
        );
        assertExists(review);
        assert(store.finishModelReview(revision, id, review.token, {
          note: `Committed model review ${index} ` + "analysis ".repeat(40),
          steps: [],
        }));
        completed.add(id);
      }
      const running = store.claim(revision);
      assertExists(running);
      const pending = store.list(revision).filter(({ status }) =>
        status === "queued" || status === "running"
      );
      assertEquals(pending.map(({ status }) => status).sort(), [
        "queued",
        "running",
      ]);
      for (const { id } of pending) incomplete.add(id);
    } finally {
      store.close();
    }
    planner.advance(state);
    const timer = setTimeout(
      () => received.reject(new Error("Planner did not dispatch with history")),
      2000,
    );
    const prompt = await received.promise.finally(() => clearTimeout(timer));
    assert(prompt.coldHistoryDigests.length > 0);
    const journal = openSentinelEvidenceDigests(directory);
    const cold = new Set<string>();
    try {
      for (const { id, memberCount } of prompt.coldHistoryDigests) {
        let seen = 0;
        let cursor: string | undefined;
        do {
          const page = journal.expand(scope, id, 12, cursor);
          assertExists(page);
          for (const item of page.members) {
            assert(!cold.has(item.id));
            cold.add(item.id);
            seen++;
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        assertEquals(seen, memberCount);
      }
    } finally {
      journal.close();
    }
    const taskIds = new Set(prompt.currentInvestigations.map(({ id }) => id));
    const inline = new Map(
      prompt.workerObservations.map((record) => [record.taskId, record]),
    );
    assert(
      [...completed].some((id) =>
        !taskIds.has(id) && cold.has(`task:adaptive:${id}`)
      ),
    );
    assert(
      [...completed].some((id) =>
        !inline.get(id)?.observation && cold.has(`observation:adaptive:${id}`)
      ),
    );
    assert(
      [...completed].some((id) =>
        !inline.get(id)?.reviewSummary &&
        cold.has(`observation:adaptive:review:${id}`)
      ),
    );
    for (const id of incomplete) {
      assert(!cold.has(`task:adaptive:${id}`));
      assert(!cold.has(`observation:adaptive:${id}`));
      assert(!cold.has(`observation:adaptive:review:${id}`));
    }
    const deadline = Date.now() + 2000;
    const lastAttempt = () =>
      readAdaptiveSentinel(path, state)?.modelPlannerHistory.at(-1);
    while (!lastAttempt()?.finished && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const latest = lastAttempt();
    assertEquals(latest?.outcome, "no_new_assignments");
    assertEquals(
      latest?.inputManifest?.coldDigestIds?.toSorted(),
      [...(prompt.coldDigests ?? []), ...prompt.coldHistoryDigests].map((
        { id },
      ) => id).sort(),
    );
  } finally {
    planner.stop();
    await Deno.remove(directory, { recursive: true });
  }
});
