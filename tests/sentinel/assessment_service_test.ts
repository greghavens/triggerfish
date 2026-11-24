import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  advanceAdaptiveSentinel,
  createSentinelWorkerPool,
  readAdaptiveSentinel,
  setSentinelWorkerLimit,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { startSentinelAssessmentCoordinator } from "../../src/gateway/sentinel_assessment_service.ts";
import {
  adaptiveRevision,
  planSentinelTasks,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import { sentinelAlertsPath } from "../../src/sentinel/paths.ts";
import {
  readSentinelAssessment,
  readSentinelNotificationState,
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";

async function makeCase() {
  const dir = await Deno.makeTempDir();
  const snapshotPath = dir + "/sentinel.json";
  await Deno.writeTextFile(
    snapshotPath,
    JSON.stringify({
      version: 1,
      nodes: [{
        id: "F-1",
        kind: "finding",
        label: "Omit raw labels",
        severity: "high",
      }],
      edges: [],
    }),
  );
  const state = startSentinelAssessment(snapshotPath);
  return { dir, snapshotPath, state };
}

Deno.test("Sentinel background assessment saves bounded isolated review separately from facts", async () => {
  const { dir, snapshotPath, state } = await makeCase();
  const finished = Promise.withResolvers<void>();
  const problems: unknown[] = [];
  let acceptedPrompt: string | undefined;
  let selectedRevision: number | undefined;
  const service = startSentinelAssessmentCoordinator({
    snapshotPath,
    onError: (error) => problems.push(error),
    createWorker: (selected) => ({
      execute(content, send, _signal, trace) {
        trace?.({ tool: "sentinel_trace", target: "F-1", outcome: "returned" });
        selectedRevision = selected.revision;
        acceptedPrompt = typeof content === "string" ? content : "";
        send({
          type: "response",
          text: "Investigate the missing evidence.",
          taint: "INTERNAL",
        });
        return Promise.resolve();
      },
      clear: () => finished.resolve(),
    }),
  });
  try {
    await finished.promise;
    const current = readSentinelAssessment(snapshotPath);
    assertEquals(selectedRevision, state.revision);
    assertStringIncludes(acceptedPrompt ?? "", "F-1");
    assert(!(acceptedPrompt ?? "").includes("Omit raw labels"));
    assertEquals(current?.result, state.result);
    assertEquals(current?.reviews, [{
      task: "coverage",
      analysis: "Investigate the missing evidence.",
      steps: [{ tool: "sentinel_trace", target: "F-1", outcome: "returned" }],
    }]);
    assertEquals(problems, []);
  } finally {
    service.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Stopping Sentinel background assessment cancels in-flight model reviews", async () => {
  const { dir, snapshotPath } = await makeCase();
  const started = Promise.withResolvers<AbortSignal | undefined>();
  const interrupted = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let reservations = 0;
  const service = startSentinelAssessmentCoordinator({
    snapshotPath,
    reserveWorker() {
      reservations++;
      return () => released.resolve();
    },
    createWorker: () => ({
      execute(_content, _send, signal) {
        started.resolve(signal);
        return new Promise<void>(() => {});
      },
      clear: () => interrupted.resolve(),
    }),
  });
  try {
    const signal = await started.promise;
    assert(service.hasInFlightWork());
    service.stop();
    assert(signal?.aborted);
    await interrupted.promise;
    await released.promise;
    assertEquals(reservations, 1);
    assertEquals(readSentinelAssessment(snapshotPath)?.reviews, []);
  } finally {
    service.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Sentinel worker reservations enforce case limits inside the shared cap", async () => {
  const directory = await Deno.makeTempDir();
  try {
    await Deno.mkdir(directory + "/named");
    const main = directory + "/sentinel.json";
    const named = directory + "/named/sentinel.json";
    const reserve = createSentinelWorkerPool(2);
    setSentinelWorkerLimit(main, 1);
    setSentinelWorkerLimit(named, 1);
    const first = reserve(main);
    assert(first);
    assertEquals(reserve(main), undefined);
    const second = reserve(named);
    assert(second);
    assertEquals(reserve(named), undefined);
    setSentinelWorkerLimit(main, null);
    second();
    const third = reserve(main);
    assert(third);
    second();
    assertEquals(reserve(named), undefined);
    first();
    third();
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("A waiting Sentinel case gets the next shared slot before the completing case refills", async () => {
  const directory = await Deno.makeTempDir();
  const main = directory + "/sentinel.json";
  const named = directory + "/named/sentinel.json";
  try {
    const reserve = createSentinelWorkerPool(2);
    const first = reserve(main);
    const second = reserve(main);
    assert(first && second);
    assertEquals(reserve(named), undefined);
    first();

    assertEquals(reserve(main), undefined);
    const waitingPeer = reserve(named);
    assert(waitingPeer);
    waitingPeer();

    assertEquals(reserve(named), undefined);
    const refilled = reserve(main);
    assert(refilled);
    second();
    refilled();
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("A cancelled or expired Sentinel waiter releases its turn", async () => {
  const directory = await Deno.makeTempDir();
  const main = directory + "/sentinel.json";
  const named = directory + "/named/sentinel.json";
  let current = 0;
  try {
    const reserve = createSentinelWorkerPool(1, () => current);
    const first = reserve(main);
    assert(first);
    assertEquals(reserve(named), undefined);
    first();
    assertEquals(reserve(main), undefined);
    reserve.cancelWait(named);
    const next = reserve(main);
    assert(next);

    assertEquals(reserve(named), undefined);
    current += 30_000;
    next();
    const afterExpiry = reserve(main);
    assert(afterExpiry);
    afterExpiry();
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("A fresh assessment coordinator completes work from an expired lease", async () => {
  const { dir, snapshotPath, state } = await makeCase();
  const revision = adaptiveRevision(state);
  const store = openSentinelAdaptiveStore(
    dir + "/sentinel-adaptive.db",
    () => Date.now() - 61_000,
  );
  const original = (() => {
    try {
      const findingReview = planSentinelTasks(state, []).find(({ nodeId }) =>
        nodeId === "F-1"
      );
      assert(findingReview);
      store.sync(revision, [findingReview]);
      return store.claim(revision, 60);
    } finally {
      store.close();
    }
  })();
  const tick = Promise.withResolvers<void>();
  const service = startSentinelAssessmentCoordinator({
    snapshotPath,
    advanceAdaptive(current) {
      advanceAdaptiveSentinel(snapshotPath, current);
      tick.resolve();
    },
    onError: tick.reject,
  });
  try {
    assert(original);
    await tick.promise;
    const current = readSentinelAssessment(snapshotPath);
    assert(current?.active);
    assertEquals(current.revision, state.revision);
    const adaptive = readAdaptiveSentinel(snapshotPath, current);
    const task = adaptive?.tasks.find(({ id }) => id === original.task.id);
    assertEquals(task?.status, "completed");
    assertEquals(task?.attempts, 2);
    assertEquals(task?.nodeId, original.task.nodeId);
    assertEquals(task?.evidenceIds, original.task.evidenceIds);
    assert(
      adaptive?.history.some(({ taskId, event }) =>
        taskId === original.task.id && event === "lease_expired"
      ),
    );
  } finally {
    service.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Sentinel advances after notification failure and skips unchanged revisions after restart", async () => {
  const { dir, snapshotPath } = await makeCase();
  let notifications = 0;
  const error = new Error("Fixture channel failure");
  const reported = Promise.withResolvers<unknown>();
  try {
    const snapshot = {
      version: 1,
      nodes: [{ id: "fixture-asset", kind: "asset", label: "Fixture" }],
      edges: [],
    };
    await Deno.writeTextFile(snapshotPath, JSON.stringify(snapshot));
    const observedAt = "2026-11-24T12:00:00.000Z";
    await Deno.writeTextFile(
      sentinelAlertsPath(snapshotPath),
      JSON.stringify(
        ["security_sensor_alert", "authorization_denial_burst"].map(
          (type) => ({
            type,
            severity: "medium",
            asset: "fixture-asset",
            subject: "Fixture signal",
            observedAt,
            evidenceIds: [type],
          }),
        ),
      ),
    );
    const manual = refreshSentinelAssessment(snapshotPath)!;
    assertEquals(
      readSentinelNotificationState(snapshotPath).latest?.state,
      "pending",
    );
    for (const expected of [1, 1]) {
      const tick = Promise.withResolvers<void>();
      const service = startSentinelAssessmentCoordinator({
        snapshotPath,
        notifyIncidentIncrease() {
          notifications++;
          throw error;
        },
        advanceAdaptive: () => tick.resolve(),
        onError(failure) {
          if (failure === error) reported.resolve(failure);
          else tick.reject(failure);
        },
      });
      try {
        await tick.promise;
        assertEquals(await reported.promise, error);
        assertEquals(notifications, expected);
        const receipt = readSentinelNotificationState(snapshotPath).latest;
        assertEquals(receipt?.state, "failed");
        assertEquals(receipt?.revision, manual.revision);
      } finally {
        service.stop();
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
