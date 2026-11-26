import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import {
  type AdaptiveOperatorAssignmentIntentInput,
  openSentinelAdaptiveStore,
  sentinelAdaptiveTaskId,
} from "../../src/sentinel/adaptive_store.ts";

const revision = "fixture-revision-one";
const goal = { id: "operator-run", label: "Check the case evidence" };
const assignment = {
  kind: "trace",
  nodeId: "operator-target",
  depth: 1,
} as const;
const id = sentinelAdaptiveTaskId(revision, assignment);
const reason = "Operator assigned this defensive review.";

function intent(
  requestId = crypto.randomUUID(),
): AdaptiveOperatorAssignmentIntentInput {
  return {
    requestId,
    runId: goal.id,
    evidenceRevision: 1,
    adaptiveRevision: revision,
    task: assignment,
    reason,
  };
}

Deno.test("Operator assignment intent atomically pins the task, run and evidence with restart-safe retries", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.db");
  let clock = 2000;
  const request = intent();
  let store = openSentinelAdaptiveStore(path, () => clock);
  try {
    assertEquals(store.recordOperatorAssignmentIntent(request), undefined);
    store.sync(revision, [], null, { number: 1, goal });
    assertEquals(
      store.recordOperatorAssignmentIntent({ ...request, runId: "other-run" }),
      undefined,
    );
    const receipt = store.recordOperatorAssignmentIntent(request);
    assertEquals(receipt, {
      requestId: request.requestId,
      runId: goal.id,
      evidenceRevision: 1,
      adaptiveRevision: revision,
      taskId: id,
      ...assignment,
      disposition: "enqueued",
      recordedAt: new Date(clock).toISOString(),
    });
    assertEquals(
      store.list(revision).map(({ id, reason, status }) => ({
        id,
        reason,
        status,
      })),
      [
        { id, reason, status: "queued" },
      ],
    );
    assertEquals(store.notes(revision).length, 1);
    assertEquals(
      store.recordOperatorAssignmentIntent({
        ...request,
        takeOverQueued: true,
      }),
      receipt,
    );
    assertEquals(
      store.recordOperatorAssignmentIntent({
        ...request,
        task: { ...assignment, depth: 2 },
      }),
      undefined,
    );
    const existing = store.recordOperatorAssignmentIntent(intent());
    assertEquals(existing?.disposition, "existing");
    assertEquals(store.notes(revision).length, 1);
    assertEquals(store.list(revision).length, 1);

    clock += 1000;
    store.sync("fixture-revision-two", [], revision, { number: 2, goal });
    store.close();
    store = openSentinelAdaptiveStore(path, () => clock);
    assertEquals(
      store.readOperatorAssignmentIntent(request.requestId.toUpperCase()),
      receipt,
    );
    assertEquals(store.recordOperatorAssignmentIntent(request), receipt);
    assertEquals(store.recordOperatorAssignmentIntent(intent()), undefined);
    assertEquals(store.list("fixture-revision-two"), []);
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Operator takeover and queued insertion roll back together when intent persistence fails", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.db");
  const store = openSentinelAdaptiveStore(path);
  try {
    store.sync(
      revision,
      [{ ...assignment, reason: "Generated request" }],
      null,
      { number: 1, goal },
    );
    assert(store.recordOperatorAssignmentIntent(intent()));
    const failTakeover = { ...intent(), takeOverQueued: true };
    const failInsertion = {
      ...intent(),
      task: { ...assignment, nodeId: "new-target" },
    };
    const db = new DatabaseSync(path);
    try {
      db.exec(`
        CREATE TRIGGER deny_fixture_request BEFORE INSERT ON adaptive_operator_assignment_intents
        WHEN NEW.requestId IN ('${failTakeover.requestId}', '${failInsertion.requestId}')
        BEGIN SELECT RAISE(ABORT, 'fixture abort'); END;
      `);
    } finally {
      db.close();
    }
    assertThrows(
      () => store.recordOperatorAssignmentIntent(failTakeover),
      Error,
      "fixture abort",
    );
    assertThrows(
      () => store.recordOperatorAssignmentIntent(failInsertion),
      Error,
      "fixture abort",
    );
    assertEquals(
      store.readOperatorAssignmentIntent(failTakeover.requestId),
      undefined,
    );
    assertEquals(
      store.readOperatorAssignmentIntent(failInsertion.requestId),
      undefined,
    );
    assertEquals(
      store.list(revision).map(({ id, reason }) => ({ id, reason })),
      [{
        id,
        reason: "Generated request",
      }],
    );
    assertEquals(store.notes(revision), []);
    assert(
      !store.history(revision).some(({ event }) =>
        event === "operator_assigned"
      ),
    );

    const takeover = store.recordOperatorAssignmentIntent({
      ...intent(),
      takeOverQueued: true,
    });
    assertEquals(takeover?.disposition, "adopted");
    assertEquals(store.list(revision)[0]?.reason, reason);
    assertEquals(store.notes(revision).length, 1);
    assertEquals(
      store.history(revision).filter(({ event }) =>
        event === "operator_assigned"
      ).length,
      1,
    );
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Queued operator rank carries only with the retained assignment", async () => {
  const directory = await Deno.makeTempDir();
  const store = openSentinelAdaptiveStore(join(directory, "adaptive.db"));
  try {
    store.sync(revision, [], null, { number: 1, goal });
    assertEquals(
      store.recordOperatorAssignmentIntent({ ...intent(), priorityRank: 9 })
        ?.priorityRank,
      9,
    );
    const next = "fixture-revision-two";
    const ordinary = { ...assignment, nodeId: "ordinary-target" };
    store.sync(
      next,
      [ordinary, { ...assignment, carriedFrom: id }],
      revision,
      { number: 2, goal },
    );
    assertEquals(
      store.list(next).map(({ operatorPriority }) => operatorPriority),
      [
        undefined,
        9,
      ],
    );
    assertEquals(
      store.claim(next)?.task.id,
      sentinelAdaptiveTaskId(next, assignment),
    );
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
});
