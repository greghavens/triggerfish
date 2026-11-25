import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import {
  listSentinelPlannerGraphFacts,
  listSentinelWorkerGraphFacts,
  openSentinelWorkerGraphFacts,
  readSentinelWorkerGraphFact,
  type SentinelWorkerGraphFactInput,
} from "../../src/sentinel/worker_graph_facts.ts";

const targetId = "application";
const scope = {
  caseId: "main",
  runId: "5b46153d-0fc4-47ad-bb91-93b0a454d079",
  evidenceRevision: 4,
  targetId,
};
const first: SentinelWorkerGraphFactInput = {
  ...scope,
  taskId: `adaptive:${"1".repeat(64)}`,
  snapshotDigest: "2".repeat(64),
  resultSha256: "3".repeat(64),
  relationship: {
    from: "local-evidence",
    to: targetId,
    relation: "observed_on",
  },
  sourceStepIndex: 1,
  requestId: "e6f067bf-6732-4f2d-ad13-fc37fd6eb01e",
};

Deno.test("Worker graph facts survive reopen with exact scope, source and request identity", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = resolveSentinelCasePath(directory);
    const peer = resolveSentinelCasePath(directory, "peer");
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.mkdir(dirname(peer), { recursive: true });
    const journalPath = join(dirname(path), "sentinel-worker-graph-facts.db");
    assertEquals(listSentinelWorkerGraphFacts(path, scope), {
      facts: [],
      nextOffset: null,
    });
    await assertRejects(() => Deno.lstat(journalPath), Deno.errors.NotFound);

    let now = 1000;
    const writer = openSentinelWorkerGraphFacts(path, () => now);
    const secondWriter = openSentinelWorkerGraphFacts(path, () => now);
    try {
      let checks = 0;
      const allowed = (input: SentinelWorkerGraphFactInput) => {
        checks++;
        return input.snapshotDigest === first.snapshotDigest &&
          input.targetId === targetId;
      };
      const recorded = writer.record(first, allowed);
      assert(recorded);
      assertMatch(recorded.id, /^worker-graph-fact:[a-f0-9]{64}$/);
      assertEquals(recorded, {
        ...first,
        id: recorded.id,
        kind: "graph_relationship",
        sourceTool: "sentinel_assigned_target",
        recordedAt: new Date(now).toISOString(),
      });
      now += 1000;
      assertEquals(
        secondWriter.record({
          ...first,
          requestId: first.requestId.toUpperCase(),
        }, () => false),
        recorded,
      );
      assertEquals(
        secondWriter.record({ ...first, sourceStepIndex: 2 }, allowed),
        undefined,
      );
      assertEquals(checks, 1);

      const second = secondWriter.record({
        ...first,
        taskId: `adaptive:${"4".repeat(64)}`,
        sourceStepIndex: 2,
        requestId: crypto.randomUUID(),
      }, allowed);
      assert(second && second.id !== recorded.id);
      assertEquals(checks, 2);
      const otherTarget = secondWriter.record({
        ...first,
        targetId: "other-application",
        relationship: { ...first.relationship, to: "other-application" },
        requestId: crypto.randomUUID(),
      }, () => true);
      assert(otherTarget);
      assert(secondWriter.record({
        ...first,
        evidenceRevision: 5,
        requestId: crypto.randomUUID(),
      }, () => true));
      assertEquals(listSentinelPlannerGraphFacts(path, scope), [
        otherTarget,
        second,
        recorded,
      ]);
      assertEquals(listSentinelPlannerGraphFacts(path, scope, 1), [
        otherTarget,
      ]);
      assertEquals(
        listSentinelPlannerGraphFacts(path, { ...scope, caseId: "peer" }),
        [],
      );
      assertEquals(
        listSentinelPlannerGraphFacts(path, {
          ...scope,
          runId: crypto.randomUUID(),
        }),
        [],
      );
      assertEquals(
        readSentinelWorkerGraphFact(path, scope, recorded.id),
        recorded,
      );
      assertEquals(
        readSentinelWorkerGraphFact(
          path,
          { ...scope, taskId: first.taskId },
          second.id,
        ),
        undefined,
      );
      assertEquals(
        readSentinelWorkerGraphFact(
          path,
          { ...scope, evidenceRevision: 5 },
          recorded.id,
        ),
        undefined,
      );
      assertEquals(
        readSentinelWorkerGraphFact(path, {
          ...scope,
          targetId: "foreign-asset",
        }, recorded.id),
        undefined,
      );
      assertEquals(
        readSentinelWorkerGraphFact(path, {
          ...scope,
          runId: crypto.randomUUID(),
        }, recorded.id),
        undefined,
      );
      assertEquals(
        readSentinelWorkerGraphFact(
          path,
          { ...scope, caseId: "peer" },
          recorded.id,
        ),
        undefined,
      );
      assertEquals(
        readSentinelWorkerGraphFact(
          peer,
          { ...scope, caseId: "peer" },
          recorded.id,
        ),
        undefined,
      );
      assertEquals(listSentinelWorkerGraphFacts(path, scope, { limit: 1 }), {
        facts: [second],
        nextOffset: 1,
      });
      assertEquals(listSentinelWorkerGraphFacts(path, scope, { offset: 1 }), {
        facts: [recorded],
        nextOffset: null,
      });
      assertEquals(
        listSentinelWorkerGraphFacts(path, { ...scope, taskId: first.taskId }, {
          limit: 1,
        }),
        {
          facts: [recorded],
          nextOffset: null,
        },
      );
    } finally {
      secondWriter.close();
      writer.close();
    }
    const reopened = openSentinelWorkerGraphFacts(path);
    try {
      assertEquals(reopened.list(scope).facts.length, 2);
      assertEquals(
        reopened.record(first, () => false)?.recordedAt,
        new Date(1000).toISOString(),
      );
    } finally {
      reopened.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Worker graph fact journal validates safe typed fields and rolls back declined proof", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = resolveSentinelCasePath(directory);
    await Deno.mkdir(dirname(path), { recursive: true });
    const store = openSentinelWorkerGraphFacts(path);
    try {
      assertEquals(store.record(first, () => false), undefined);
      assertThrows(
        () =>
          store.record(first, () => {
            throw new Error("Failed authority");
          }),
        Error,
        "Failed authority",
      );
      assertEquals(store.list(scope).facts, []);
      for (
        const changes of [
          { caseId: "other" },
          { evidenceRevision: 0 },
          { sourceStepIndex: 16 },
          { taskId: "invalid" },
          { resultSha256: "raw text" },
          { snapshotDigest: "raw snapshot" },
          { relationship: { ...first.relationship, relation: "executes" } },
          { relationship: { ...first.relationship, to: "unassigned-target" } },
        ]
      ) {
        assertThrows(() =>
          store.record(
            { ...first, ...changes } as SentinelWorkerGraphFactInput,
            () => true,
          )
        );
      }
      const extra = {
        ...first,
        rawProviderResponse: "not retained",
        instructions: "not retained",
      };
      const saved = store.record(extra, () => true);
      assert(saved);
      assert(!Object.hasOwn(saved, "rawProviderResponse"));
      assert(!Object.hasOwn(saved, "instructions"));
      assertEquals(store.list(scope).facts, [saved]);
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
