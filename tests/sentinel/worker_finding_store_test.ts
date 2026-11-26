import { assertEquals, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import {
  hasSentinelWorkerFindingJournal,
  openSentinelWorkerFindingStore,
  readSentinelWorkerFindingReport,
  readSentinelWorkerFindingWriteReceipt,
  type SentinelWorkerFindingInput,
} from "../../src/sentinel/worker_finding_store.ts";

const initial: SentinelWorkerFindingInput = {
  caseId: "main",
  runId: "run-a",
  evidenceRevision: 1,
  taskId: "task-a",
  targetId: "service",
  graphFindingId: "finding",
  controlId: "control",
  evidenceId: "verification-a",
  snapshotDigest: "a".repeat(64),
  requestId: "request-a",
  evaluatedAt: "2026-11-25T12:00:00.000Z",
  observedAt: "2026-11-24T12:00:00.000Z",
  validUntil: "2026-12-01T12:00:00.000Z",
  title: "Control verification failed",
  summary: "Published verification recorded a failure.",
};

function fixture() {
  const base = Deno.makeTempDirSync();
  const path = resolveSentinelCasePath(base);
  Deno.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return { base, path };
}

Deno.test("worker findings are immutable and deduplicated across store handles and restart", () => {
  const { base, path } = fixture();
  try {
    assertEquals(
      readSentinelWorkerFindingWriteReceipt(path, initial, initial.requestId),
      undefined,
    );
    assertEquals(hasSentinelWorkerFindingJournal(path), false);
    const store = openSentinelWorkerFindingStore(path, () => 1000);
    const other = openSentinelWorkerFindingStore(path, () => 2000);
    const original = store.recordFinding(initial);
    try {
      assertEquals(other.recordFinding(initial), original);
      assertEquals(
        other.recordFinding({
          ...initial,
          requestId: "request-other",
          evaluatedAt: "2026-11-26T12:00:00.000Z",
        }),
        original,
      );
      assertThrows(
        () =>
          other.recordFinding({
            ...initial,
            requestId: "request-other",
            summary: "Conflicting replacement",
          }),
        Error,
        "Conflicting Sentinel worker finding request",
      );
      assertThrows(
        () =>
          store.recordFinding({
            ...initial,
            caseId: "peer",
          }),
        Error,
        "different case",
      );
      assertThrows(
        () =>
          store.recordFinding({
            ...initial,
            evaluatedAt: initial.validUntil,
          }),
        Error,
        "receipt scope",
      );
    } finally {
      other.close();
      store.close();
    }
    const reopened = openSentinelWorkerFindingStore(path);
    try {
      assertEquals(reopened.readFinding(original.id), original);
      assertEquals(
        readSentinelWorkerFindingWriteReceipt(path, initial, initial.requestId),
        original,
      );
      assertEquals(
        readSentinelWorkerFindingWriteReceipt(path, initial, "request-other"),
        original,
      );
      assertEquals(
        readSentinelWorkerFindingWriteReceipt(path, initial, "uncommitted"),
        undefined,
      );
      for (
        const wrongScope of [
          { caseId: "peer" },
          { runId: "run-b" },
          { taskId: "task-b" },
          { targetId: "other" },
          { evidenceRevision: 2 },
        ]
      ) {
        assertEquals(
          readSentinelWorkerFindingWriteReceipt(path, {
            ...initial,
            ...wrongScope,
          }, initial.requestId),
          undefined,
        );
      }
      assertEquals(reopened.list(1), [original]);
      assertEquals(reopened.list(2), []);
      assertEquals(reopened.list(), [original]);
    } finally {
      reopened.close();
    }
  } finally {
    Deno.removeSync(base, { recursive: true });
  }
});

Deno.test("worker rechecks retain fresh exact scope and original finding independently", () => {
  const { base, path } = fixture();
  const store = openSentinelWorkerFindingStore(path);
  try {
    const original = store.recordFinding(initial);
    const recheck = {
      ...initial,
      findingId: original.id,
      requestId: "request-b",
      taskId: "task-b",
      evidenceRevision: 2,
      snapshotDigest: "b".repeat(64),
      evidenceId: "verification-b",
      evaluatedAt: "2026-11-27T12:00:00.000Z",
      observedAt: "2026-11-26T12:00:00.000Z",
      outcome: "pass" as const,
    };
    for (
      const mismatched of [
        { graphFindingId: "other" },
        { controlId: "other" },
        { targetId: "other" },
        { runId: "run-b" },
        { taskId: initial.taskId },
        { observedAt: initial.observedAt },
        {
          snapshotDigest: initial.snapshotDigest,
          evidenceId: initial.evidenceId,
        },
        { findingId: "worker-finding:" + "c".repeat(64) },
      ]
    ) {
      assertThrows(
        () => store.recordRecheck({ ...recheck, ...mismatched }),
        Error,
        "source is out of scope",
      );
    }
    const result = store.recordRecheck(recheck);
    assertEquals(
      readSentinelWorkerFindingWriteReceipt(path, recheck, recheck.requestId),
      result,
    );
    assertEquals(
      readSentinelWorkerFindingWriteReceipt(path, initial, recheck.requestId),
      undefined,
    );
    assertEquals(store.recordRecheck(recheck), result);
    assertThrows(
      () =>
        store.recordRecheck({
          ...recheck,
          requestId: "divergent",
          summary: "Other conclusion",
        }),
      Error,
      "already recorded a verified result",
    );
    assertEquals(
      store.recordRecheck({ ...recheck, requestId: "identical" }),
      result,
    );

    assertEquals(store.read(result.id), result);
    assertEquals(store.readFinding(result.id), undefined);
    assertEquals(store.readFinding(original.id), original);
    assertEquals(store.list(2), [result]);
    assertEquals(store.list(), [result, original]);
  } finally {
    store.close();
    Deno.removeSync(base, { recursive: true });
  }
});

Deno.test("finding report amendments use atomic versions and preserve exact historical evidence", () => {
  const { base, path } = fixture();
  const first = openSentinelWorkerFindingStore(path);
  const second = openSentinelWorkerFindingStore(path);
  try {
    const original = first.recordFinding(initial);
    const version2 = {
      caseId: original.caseId,
      runId: original.runId,
      evidenceRevision: 2,
      taskId: "amending-task",
      targetId: original.targetId,
      requestId: "amendment-1",
      findingId: original.id,
      expectedVersion: 1,
      title: "Clarify affected service",
      summary: "The initial evidence applies to the selected service.",
    };
    assertThrows(
      () =>
        second.updateFindingReport({
          ...version2,
          targetId: "different-service",
        }),
      Error,
      "out of scope",
    );
    assertThrows(
      () =>
        second.updateFindingReport({
          ...version2,
          runId: "replacement-run",
        }),
      Error,
      "out of scope",
    );
    const firstEdit = first.updateFindingReport(version2);
    assertEquals(
      readSentinelWorkerFindingWriteReceipt(path, version2, version2.requestId),
      firstEdit,
    );
    assertEquals(
      readSentinelWorkerFindingWriteReceipt(path, initial, version2.requestId),
      undefined,
    );
    assertEquals(firstEdit.version, 2);
    assertThrows(
      () =>
        second.updateFindingReport({
          ...version2,
          requestId: "amendment-racer",
          title: "Concurrent edit",
        }),
      Error,
      "Stale",
    );
    assertThrows(
      () =>
        first.updateFindingReport({
          ...version2,
          requestId: initial.requestId,
        }),
      Error,
      "Conflicting",
    );
    assertThrows(
      () =>
        second.updateFindingReport({
          ...version2,
          expectedVersion: 2,
          requestId: "stale-revision",
          evidenceRevision: 1,
        }),
      Error,
      "Stale",
    );
    const secondEdit = second.updateFindingReport({
      ...version2,
      requestId: "amendment-2",
      evidenceRevision: 3,
      expectedVersion: 2,
      title: "Clarify scope again",
    });
    assertEquals(secondEdit.version, 3);
    assertEquals(first.updateFindingReport(version2), firstEdit);
    assertEquals(first.readFinding(original.id), original);
    assertEquals(first.list(), [original]);
    assertEquals(first.readFindingReport(original.id, 1), {
      finding: original,
      version: 1,
      title: original.title,
      summary: original.summary,
      amendments: [],
    });
    assertEquals(first.readFindingReport(original.id)?.amendments, [
      firstEdit,
      secondEdit,
    ]);
    const exportAt2 = readSentinelWorkerFindingReport(path, 2);
    assertEquals(exportAt2?.findings, [original]);
    assertEquals(exportAt2?.amendments, [firstEdit]);
    assertEquals(exportAt2?.reports[0].version, 2);
    assertEquals(exportAt2?.reports[0].title, version2.title);
  } finally {
    second.close();
    first.close();
    Deno.removeSync(base, { recursive: true });
  }
});

Deno.test("version one journal receipts survive the amendment schema migration", () => {
  const { base, path } = fixture();
  try {
    const previous = openSentinelWorkerFindingStore(path);
    const original = previous.recordFinding(initial);
    previous.close();
    const db = new DatabaseSync(
      join(dirname(path), "sentinel-worker-findings.db"),
    );
    try {
      db.exec(`
        DROP INDEX receipts_report_version;
        ALTER TABLE receipts DROP COLUMN reportVersion;
        PRAGMA user_version = 1;
      `);
      assertEquals(
        readSentinelWorkerFindingWriteReceipt(path, initial, initial.requestId),
        original,
      );
      assertEquals(db.prepare("PRAGMA user_version").get()?.user_version, 1);
    } finally {
      db.close();
    }
    const migrated = openSentinelWorkerFindingStore(path);
    try {
      assertEquals(migrated.readFinding(original.id), original);
      assertEquals(migrated.recordFinding(initial), original);
      assertEquals(migrated.readFindingReport(original.id)?.version, 1);
      assertEquals(migrated.listAmendments(1), []);
    } finally {
      migrated.close();
    }
  } finally {
    Deno.removeSync(base, { recursive: true });
  }
});
