import { assert, assertEquals, assertExists } from "@std/assert";
import { dirname } from "@std/path";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { openSentinelEvidenceDigests } from "../../src/sentinel/evidence_digests.ts";

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
