/** Case-local journal for trusted, evidence-backed worker receipts. */
/// <reference path="../core/sqlite_types.d.ts" />

import { dirname, join, resolve } from "@std/path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isSentinelCaseId, locateSentinelCase } from "./cases.ts";
import { assertOperatorSourceDirectoryInfo } from "./source_snapshot_lock.ts";

export interface SentinelWorkerFindingReceiptScope {
  readonly caseId: string;
  readonly runId: string;
  readonly evidenceRevision: number;
  readonly taskId: string;
  readonly targetId: string;
  readonly graphFindingId: string;
  readonly controlId: string;
  readonly evidenceId: string;
  readonly snapshotDigest: string;
  readonly evaluatedAt: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly requestId: string;
}

export interface SentinelWorkerFindingInput
  extends SentinelWorkerFindingReceiptScope {
  readonly title: string;
  readonly summary: string;
}

export const sentinelWorkerRecheckOutcomes = [
  "pass",
  "fail",
] as const;

export interface SentinelWorkerFindingRecheckInput
  extends SentinelWorkerFindingReceiptScope {
  readonly findingId: string;
  readonly outcome: typeof sentinelWorkerRecheckOutcomes[number];
  readonly summary: string;
}

type Receipt = {
  readonly id: string;
  readonly recordedAt: string;
};

export type SentinelWorkerFindingRecord =
  & SentinelWorkerFindingInput
  & Receipt
  & {
    readonly kind: "finding";
  };
export type SentinelWorkerFindingRecheckRecord =
  & SentinelWorkerFindingRecheckInput
  & Receipt
  & {
    readonly kind: "recheck";
  };
export type SentinelWorkerFindingJournalRecord =
  | SentinelWorkerFindingRecord
  | SentinelWorkerFindingRecheckRecord;

export interface SentinelWorkerFindingReportUpdate {
  readonly caseId: string;
  readonly runId: string;
  readonly evidenceRevision: number;
  readonly taskId: string;
  readonly targetId: string;
  readonly requestId: string;
  readonly findingId: string;
  readonly expectedVersion: number;
  readonly evidenceVersion?: string;
  readonly title: string;
  readonly summary: string;
}

export type SentinelWorkerFindingReportAmendment =
  & SentinelWorkerFindingReportUpdate
  & Receipt
  & {
    readonly kind: "report_amendment";
    readonly version: number;
  };

type FindingWriteReceipt =
  | SentinelWorkerFindingJournalRecord
  | SentinelWorkerFindingReportAmendment;

type FindingWriteScope = Pick<
  SentinelWorkerFindingReceiptScope,
  "caseId" | "runId" | "evidenceRevision" | "taskId" | "targetId"
>;

const APPLICATION_ID = 0x53574644;
const VERSION = 2;
const MAX_RECEIPTS = 4096;
const MAX_REQUESTS = 8192;
const digestPattern = /^[a-f0-9]{64}$/;
const findingPattern = /^worker-finding:[a-f0-9]{64}$/;
const receiptPattern = /^worker-(?:finding|recheck):[a-f0-9]{64}$/;

export function hasSentinelWorkerFindingJournal(snapshotPath: string): boolean {
  try {
    Deno.lstatSync(join(dirname(snapshotPath), "sentinel-worker-findings.db"));
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= max && !value.includes("\0");
}

function canonicalTime(value: unknown): number {
  if (typeof value !== "string" || value.length !== 24) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : NaN;
}

function normalizeScope(scope: SentinelWorkerFindingReceiptScope) {
  const {
    caseId,
    runId,
    evidenceRevision,
    taskId,
    targetId,
    graphFindingId,
    controlId,
    evidenceId,
    snapshotDigest,
    evaluatedAt,
    observedAt,
    validUntil,
    requestId,
  } = scope;
  if (
    !isSentinelCaseId(caseId) || !bounded(runId, 128) ||
    !Number.isSafeInteger(evidenceRevision) || evidenceRevision < 1 ||
    !bounded(taskId, 256) || !bounded(targetId, 4096) ||
    !bounded(graphFindingId, 4096) || !bounded(controlId, 4096) ||
    !bounded(evidenceId, 4096) || !bounded(requestId, 128) ||
    typeof snapshotDigest !== "string" || !digestPattern.test(snapshotDigest) ||
    !(canonicalTime(observedAt) <= canonicalTime(evaluatedAt)) ||
    !(canonicalTime(evaluatedAt) < canonicalTime(validUntil))
  ) {
    throw new Error("Invalid Sentinel worker finding receipt scope");
  }
  return {
    caseId,
    runId,
    evidenceRevision,
    taskId,
    targetId,
    graphFindingId,
    controlId,
    evidenceId,
    snapshotDigest,
    evaluatedAt,
    observedAt,
    validUntil,
    requestId,
  };
}

function normalizeFinding(raw: SentinelWorkerFindingInput) {
  if (!bounded(raw.title, 256) || !bounded(raw.summary, 4096)) {
    throw new Error("Invalid Sentinel worker finding text");
  }
  return {
    ...normalizeScope(raw),
    title: raw.title,
    summary: raw.summary,
    kind: "finding" as const,
  };
}

function normalizeRecheck(raw: SentinelWorkerFindingRecheckInput) {
  if (
    !bounded(raw.summary, 4096) ||
    typeof raw.findingId !== "string" || !findingPattern.test(raw.findingId) ||
    !sentinelWorkerRecheckOutcomes.includes(raw.outcome)
  ) {
    throw new Error("Invalid Sentinel worker remediation recheck");
  }
  return {
    ...normalizeScope(raw),
    findingId: raw.findingId,
    outcome: raw.outcome,
    summary: raw.summary,
    kind: "recheck" as const,
  };
}

function normalizeAmendment(raw: SentinelWorkerFindingReportUpdate) {
  const {
    caseId,
    runId,
    evidenceRevision,
    taskId,
    targetId,
    requestId,
    findingId,
    expectedVersion,
    evidenceVersion,
    title,
    summary,
  } = raw;
  if (
    !isSentinelCaseId(caseId) || !bounded(runId, 128) ||
    !Number.isSafeInteger(evidenceRevision) || evidenceRevision < 1 ||
    !bounded(taskId, 256) || !bounded(targetId, 4096) ||
    !bounded(requestId, 128) || typeof findingId !== "string" ||
    !findingPattern.test(findingId) ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
    expectedVersion >= MAX_RECEIPTS ||
    (evidenceVersion !== undefined &&
      (typeof evidenceVersion !== "string" ||
        !/^[a-f0-9]{64}$/.test(evidenceVersion))) ||
    !bounded(title, 256) || !bounded(summary, 4096)
  ) throw new Error("Invalid Sentinel worker finding report amendment");
  return {
    caseId,
    runId,
    evidenceRevision,
    taskId,
    targetId,
    requestId,
    findingId,
    expectedVersion,
    ...(evidenceVersion !== undefined && { evidenceVersion }),
    title,
    summary,
  };
}

function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function openDatabase(snapshotPath: string, readOnly: boolean) {
  const parent = dirname(resolve(snapshotPath));
  assertOperatorSourceDirectoryInfo(Deno.lstatSync(parent));
  const path = join(parent, "sentinel-worker-findings.db");
  if (!readOnly) {
    try {
      Deno.openSync(path, { write: true, createNew: true, mode: 0o600 })
        .close();
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
  }
  const info = Deno.lstatSync(path);
  if (
    !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
    (info.mode !== null && (info.mode & 0o077) !== 0)
  ) {
    throw new Error(
      "Sentinel worker finding journal requires a private regular file",
    );
  }
  return new DatabaseSync(path, { readOnly });
}

type Row = NonNullable<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>>;
type FindingInput = ReturnType<typeof normalizeFinding>;
type RecheckInput = ReturnType<typeof normalizeRecheck>;
type JournalInput = FindingInput | RecheckInput;

function findingReceiptId(input: JournalInput): string {
  const { requestId: _requestId, evaluatedAt: _evaluatedAt, ...content } =
    input;
  return `worker-${input.kind}:${
    createHash("sha256").update(JSON.stringify(content)).digest("hex")
  }`;
}

function amendmentReceiptId(input: SentinelWorkerFindingReportUpdate): string {
  const { requestId: _requestId, ...content } = input;
  return `worker-finding-amendment:${
    createHash("sha256").update(JSON.stringify(content)).digest("hex")
  }`;
}

function decode(row: Row): SentinelWorkerFindingJournalRecord {
  const input = JSON.parse(String(row.input)) as JournalInput;
  return {
    ...(input.kind === "finding"
      ? normalizeFinding(input)
      : normalizeRecheck(input)),
    id: String(row.id),
    recordedAt: new Date(Number(row.recordedAt)).toISOString(),
  };
}

function decodeAmendment(row: Row): SentinelWorkerFindingReportAmendment {
  return {
    ...normalizeAmendment(JSON.parse(String(row.input))),
    id: String(row.id),
    recordedAt: new Date(Number(row.recordedAt)).toISOString(),
    kind: "report_amendment",
    version: Number(row.reportVersion),
  };
}

/** The broker supplies verified scope and holds its current-lease gate across each write. */
export function openSentinelWorkerFindingStore(
  snapshotPath: string,
  now = Date.now,
) {
  const caseBinding = locateSentinelCase(snapshotPath)?.caseId;
  const db = openDatabase(snapshotPath, false);
  try {
    db.exec(
      "PRAGMA busy_timeout = 1500; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF",
    );
    transaction(db, () => {
      const applicationId = db.prepare("PRAGMA application_id").get()
        ?.application_id;
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (applicationId === APPLICATION_ID && version === VERSION) return;
      if (applicationId === APPLICATION_ID && version === 1) {
        db.exec(`
          ALTER TABLE receipts ADD COLUMN reportVersion INTEGER;
          CREATE UNIQUE INDEX receipts_report_version ON receipts(findingId, reportVersion)
            WHERE reportVersion IS NOT NULL;
          PRAGMA user_version = ${VERSION};
        `);
        return;
      }
      if (
        applicationId !== 0 || version !== 0 ||
        db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
      ) throw new Error("Invalid Sentinel worker finding journal or version");
      db.exec(`
        CREATE TABLE receipts (
          id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL,
          findingId TEXT REFERENCES receipts(id),
          input TEXT NOT NULL,
          recordedAt INTEGER NOT NULL,
          reportVersion INTEGER
        );
        CREATE INDEX receipts_revision ON receipts(revision);
        CREATE INDEX receipts_finding ON receipts(findingId);
        CREATE UNIQUE INDEX receipts_report_version ON receipts(findingId, reportVersion)
          WHERE reportVersion IS NOT NULL;
        CREATE TABLE requests (
          requestId TEXT PRIMARY KEY,
          receiptId TEXT NOT NULL REFERENCES receipts(id)
        );
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = ${VERSION};
      `);
    });
  } catch (error) {
    db.close();
    throw error;
  }
  const lookup = db.prepare("SELECT * FROM receipts WHERE id = ?");

  function read(id: string): SentinelWorkerFindingJournalRecord | undefined {
    if (!receiptPattern.test(id)) {
      throw new Error("Invalid Sentinel worker finding receipt ID");
    }
    const row = lookup.get(id);
    return row && decode(row);
  }

  function write<T extends JournalInput>(
    input: T,
    onCommit?: (record: T & Receipt) => void,
  ): T & Receipt {
    if (caseBinding !== undefined && input.caseId !== caseBinding) {
      throw new Error(
        "Sentinel worker finding receipt belongs to a different case",
      );
    }
    const { requestId } = input;
    const id = findingReceiptId(input);
    let inserted = false;
    const record = transaction(db, () => {
      const request = db.prepare(
        "SELECT receiptId FROM requests WHERE requestId = ?",
      ).get(requestId);
      if (request && request.receiptId !== id) {
        throw new Error("Conflicting Sentinel worker finding request ID");
      }
      const existing = lookup.get(id);
      if (
        !request &&
        Number(db.prepare("SELECT COUNT(*) AS n FROM requests").get()?.n) >=
          MAX_REQUESTS
      ) {
        throw new Error("Sentinel worker finding request limit reached");
      }
      if (!existing) {
        if (
          Number(db.prepare("SELECT COUNT(*) AS n FROM receipts").get()?.n) >=
            MAX_RECEIPTS
        ) {
          throw new Error("Sentinel worker finding receipt limit reached");
        }
        if (input.kind === "recheck") {
          const original = read(input.findingId);
          if (
            original?.kind !== "finding" || original.caseId !== input.caseId ||
            original.runId !== input.runId ||
            original.targetId !== input.targetId ||
            original.graphFindingId !== input.graphFindingId ||
            original.controlId !== input.controlId ||
            original.taskId === input.taskId ||
            original.evidenceRevision > input.evidenceRevision ||
            original.observedAt >= input.observedAt ||
            (original.snapshotDigest === input.snapshotDigest &&
              original.evidenceId === input.evidenceId)
          ) {
            throw new Error(
              "Sentinel remediation recheck source is out of scope",
            );
          }
        }
        const recordedAt = now();
        const record = {
          ...input,
          id,
          recordedAt: new Date(recordedAt).toISOString(),
        };
        db.prepare(
          "INSERT INTO receipts (id, revision, findingId, input, recordedAt) VALUES (?, ?, ?, ?, ?)",
        ).run(
          id,
          input.evidenceRevision,
          input.kind === "recheck" ? input.findingId : null,
          JSON.stringify(input),
          recordedAt,
        );
        db.prepare("INSERT INTO requests VALUES (?, ?)").run(requestId, id);
        inserted = true;
        return record;
      }
      if (!request) {
        db.prepare("INSERT INTO requests VALUES (?, ?)").run(requestId, id);
      }
      const prior = decode(existing);
      return {
        ...input,
        id,
        requestId: prior.requestId,
        evaluatedAt: prior.evaluatedAt,
        recordedAt: prior.recordedAt,
      };
    });
    if (inserted) onCommit?.(record);
    return record;
  }

  function readFinding(id: string): SentinelWorkerFindingRecord | undefined {
    const receipt = read(id);
    return receipt?.kind === "finding" ? receipt : undefined;
  }

  function updateFindingReport(
    raw: SentinelWorkerFindingReportUpdate,
    evidenceIsCurrent?: () => boolean,
  ) {
    const input = normalizeAmendment(raw);
    const { requestId } = input;
    const id = amendmentReceiptId(input);
    return transaction(db, () => {
      const original = readFinding(input.findingId);
      if (
        original?.caseId !== input.caseId || original.runId !== input.runId ||
        original.targetId !== input.targetId ||
        original.evidenceRevision > input.evidenceRevision
      ) {
        throw new Error(
          "Sentinel worker finding amendment source is out of scope",
        );
      }
      const request = db.prepare(
        "SELECT receiptId FROM requests WHERE requestId = ?",
      ).get(requestId);
      if (request && request.receiptId !== id) {
        throw new Error("Conflicting Sentinel worker finding request ID");
      }
      if (
        !request &&
        Number(db.prepare("SELECT COUNT(*) AS n FROM requests").get()?.n) >=
          MAX_REQUESTS
      ) throw new Error("Sentinel worker finding request limit reached");
      const existing = lookup.get(id);
      if (existing) {
        if (!request) {
          db.prepare("INSERT INTO requests VALUES (?, ?)").run(requestId, id);
        }
        return decodeAmendment(existing);
      }
      const previous = db.prepare(
        "SELECT * FROM receipts WHERE findingId = ? AND reportVersion IS NOT NULL ORDER BY reportVersion DESC LIMIT 1",
      ).get(input.findingId);
      const version = previous ? Number(previous.reportVersion) : 1;
      if (
        evidenceIsCurrent?.() === false || version !== input.expectedVersion ||
        (previous && Number(previous.revision) > input.evidenceRevision)
      ) {
        throw new Error(
          "Stale Sentinel worker finding report version or evidence revision",
        );
      }
      if (
        Number(db.prepare("SELECT COUNT(*) AS n FROM receipts").get()?.n) >=
          MAX_RECEIPTS
      ) throw new Error("Sentinel worker finding receipt limit reached");
      const recordedAt = now();
      const amendment: SentinelWorkerFindingReportAmendment = {
        ...input,
        id,
        recordedAt: new Date(recordedAt).toISOString(),
        kind: "report_amendment",
        version: version + 1,
      };
      db.prepare("INSERT INTO receipts VALUES (?, ?, ?, ?, ?, ?)").run(
        id,
        input.evidenceRevision,
        input.findingId,
        JSON.stringify(input),
        recordedAt,
        version + 1,
      );
      db.prepare("INSERT INTO requests VALUES (?, ?)").run(requestId, id);
      return amendment;
    });
  }

  function readFindingReport(
    findingId: string,
    revision = Number.MAX_SAFE_INTEGER,
  ) {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error("Invalid Sentinel worker finding evidence revision");
    }
    if (!findingPattern.test(findingId)) return undefined;
    const finding = readFinding(findingId);
    if (!finding || finding.evidenceRevision > revision) return undefined;
    const amendments = db.prepare(
      "SELECT * FROM receipts WHERE findingId = ? AND revision <= ? AND reportVersion IS NOT NULL ORDER BY reportVersion",
    ).all(findingId, revision).map(decodeAmendment);
    const latest = amendments.at(-1);
    return {
      finding,
      version: latest?.version ?? 1,
      title: latest?.title ?? finding.title,
      summary: latest?.summary ?? finding.summary,
      amendments,
    };
  }

  /** Page immutable report receipts without loading their complete history. */
  function listFindingReportVersions(
    scope: {
      caseId: string;
      runId: string;
      findingId: string;
      revision: number;
    },
    limit: number,
    cursor?: string,
  ) {
    const { caseId, runId, findingId, revision } = scope;
    if (
      !Number.isSafeInteger(revision) || revision < 1 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 10
    ) return;
    const finding = readFinding(findingId);
    if (
      !finding || finding.caseId !== caseId || finding.runId !== runId ||
      finding.evidenceRevision > revision
    ) return;
    const versionReceipt = (version: number) =>
      version === 1 ? findingId : db.prepare(
        "SELECT id FROM receipts WHERE findingId = ? AND revision <= ? AND reportVersion = ?",
      ).get(findingId, revision, version)?.id;
    const cursorFor = (anchor: number, before: number) => {
      const anchorReceipt = versionReceipt(anchor);
      const boundaryReceipt = versionReceipt(before);
      if (
        typeof anchorReceipt !== "string" || typeof boundaryReceipt !== "string"
      ) return;
      const digest = createHash("sha256").update(JSON.stringify([
        caseId,
        runId,
        findingId,
        revision,
        anchor,
        before,
        anchorReceipt,
        boundaryReceipt,
      ])).digest("hex");
      return `finding-report:${anchor}.${before}.${digest}`;
    };
    let anchor: number;
    let before: number;
    if (cursor !== undefined) {
      const match =
        /^finding-report:([1-9][0-9]{0,8})\.([2-9]|[1-9][0-9]{1,8})\.[a-f0-9]{64}$/
          .exec(cursor);
      if (!match) return;
      anchor = Number(match[1]);
      before = Number(match[2]);
      if (before > anchor || cursorFor(anchor, before) !== cursor) return;
    } else {
      const latest = db.prepare(
        "SELECT reportVersion FROM receipts WHERE findingId = ? AND revision <= ? AND reportVersion IS NOT NULL ORDER BY reportVersion DESC LIMIT 1",
      ).get(findingId, revision);
      anchor = Number(latest?.reportVersion ?? 1);
      before = anchor + 1;
    }
    const amendments = db.prepare(
      "SELECT * FROM receipts WHERE findingId = ? AND revision <= ? AND reportVersion < ? ORDER BY reportVersion DESC LIMIT ?",
    ).all(findingId, revision, before, limit + 1).map(decodeAmendment);
    if (
      amendments.some((item) =>
        item.caseId !== caseId || item.runId !== runId ||
        item.targetId !== finding.targetId
      )
    ) return;
    const selected:
      (SentinelWorkerFindingRecord | SentinelWorkerFindingReportAmendment)[] =
        amendments.slice(0, limit);
    if (selected.length < limit) selected.push(finding);
    const versions = selected.map((item) => ({
      version: item.kind === "finding" ? 1 : item.version,
      sourceReceiptId: item.id,
      evidenceRevision: item.evidenceRevision,
      taskId: item.taskId,
      authority: item.kind === "report_amendment" && item.taskId === "operator"
        ? "operator" as const
        : "worker" as const,
      recordedAt: item.recordedAt,
      ...(item.kind === "finding"
        ? { evidenceId: item.evidenceId }
        : item.evidenceVersion
        ? { evidenceVersion: item.evidenceVersion }
        : {}),
    }));
    const lastVersion = versions.at(-1)!.version;
    return {
      findingId,
      latestVersion: anchor,
      versions,
      nextCursor: lastVersion > 1
        ? cursorFor(anchor, lastVersion) ?? null
        : null,
    };
  }

  return {
    recordFinding(
      input: SentinelWorkerFindingInput,
      onCommit?: (record: SentinelWorkerFindingRecord) => void,
    ): SentinelWorkerFindingRecord {
      return write(normalizeFinding(input), onCommit);
    },
    recordRecheck(
      input: SentinelWorkerFindingRecheckInput,
      onCommit?: (record: SentinelWorkerFindingRecheckRecord) => void,
    ): SentinelWorkerFindingRecheckRecord {
      return write(normalizeRecheck(input), onCommit);
    },
    read,
    readFinding,
    updateFindingReport,
    readFindingReport,
    listFindingReportVersions,
    listFindingIds(
      caseId: string,
      runId: string,
      revision: number,
      limit: number,
    ) {
      return db.prepare(
        `SELECT id FROM receipts
         WHERE revision <= ? AND findingId IS NULL AND reportVersion IS NULL
           AND json_extract(input, '$.caseId') = ?
           AND json_extract(input, '$.runId') = ?
         ORDER BY rowid DESC LIMIT ?`,
      ).all(revision, caseId, runId, limit).map(({ id }) => String(id));
    },
    listFindingRechecks(findingId: string, revision: number) {
      return db.prepare(
        "SELECT * FROM receipts WHERE findingId = ? AND revision <= ? AND reportVersion IS NULL ORDER BY rowid DESC",
      ).all(findingId, revision).map(decode).filter(
        (entry): entry is SentinelWorkerFindingRecheckRecord =>
          entry.kind === "recheck",
      );
    },
    listAmendments(revision: number): SentinelWorkerFindingReportAmendment[] {
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new Error("Invalid Sentinel worker finding evidence revision");
      }
      return db.prepare(
        "SELECT * FROM receipts WHERE revision = ? AND reportVersion IS NOT NULL ORDER BY rowid DESC",
      ).all(revision).map(decodeAmendment);
    },
    list(evidenceRevision?: number): SentinelWorkerFindingJournalRecord[] {
      if (
        evidenceRevision !== undefined &&
        (!Number.isSafeInteger(evidenceRevision) || evidenceRevision < 1)
      ) throw new Error("Invalid Sentinel worker finding evidence revision");
      const rows = evidenceRevision === undefined
        ? db.prepare(
          "SELECT * FROM receipts WHERE reportVersion IS NULL ORDER BY rowid DESC",
        ).all()
        : db.prepare(
          "SELECT * FROM receipts WHERE revision = ? AND reportVersion IS NULL ORDER BY rowid DESC",
        ).all(evidenceRevision);
      return rows.map(decode);
    },
    close(): void {
      db.close();
    },
  };
}

/** Reopen a committed write by request within a caller-authorized assignment. */
export function readSentinelWorkerFindingWriteReceipt(
  path: string,
  scope: FindingWriteScope,
  requestId: string,
): FindingWriteReceipt | undefined {
  return readScopedFindingWrite(path, scope, requestId, "request");
}

/** Reopen the receipt cited by a committed worker trace step. */
export function readSentinelWorkerFindingTraceReceipt(
  path: string,
  scope: FindingWriteScope,
  id: string,
): FindingWriteReceipt | undefined {
  return readScopedFindingWrite(path, scope, id, "receipt");
}

function readScopedFindingWrite(
  path: string,
  scope: FindingWriteScope,
  identifier: string,
  lookup: "request" | "receipt",
): FindingWriteReceipt | undefined {
  if (
    !bounded(identifier, 128) ||
    locateSentinelCase(path)?.caseId !== scope.caseId ||
    !hasSentinelWorkerFindingJournal(path)
  ) return;
  const db = openDatabase(path, true);
  try {
    db.exec("PRAGMA busy_timeout = 1500; PRAGMA trusted_schema = OFF");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (
      db.prepare("PRAGMA application_id").get()?.application_id !==
        APPLICATION_ID ||
      (version !== 1 && version !== VERSION)
    ) return;
    const row = lookup === "receipt"
      ? db.prepare("SELECT * FROM receipts WHERE id = ?").get(identifier)
      : db.prepare(`
      SELECT receipt.* FROM requests AS request
      JOIN receipts AS receipt ON receipt.id = request.receiptId
      WHERE request.requestId = ?
    `).get(identifier);
    if (!row || row.revision !== scope.evidenceRevision) return;
    const amendment = row.reportVersion != null;
    const receipt = amendment ? decodeAmendment(row) : decode(row);
    const { id, caseId, runId, taskId, targetId, evidenceRevision } = receipt;
    if (
      caseId !== scope.caseId || runId !== scope.runId ||
      taskId !== scope.taskId ||
      targetId !== scope.targetId || evidenceRevision !== scope.evidenceRevision
    ) return;
    if (receipt.kind === "report_amendment") {
      if (
        receipt.version !== receipt.expectedVersion + 1 ||
        row.findingId !== receipt.findingId ||
        id !== amendmentReceiptId(normalizeAmendment(receipt))
      ) return;
    } else {
      if (
        row.findingId !==
          (receipt.kind === "recheck" ? receipt.findingId : null) ||
        id !==
          findingReceiptId(
            receipt.kind === "finding"
              ? normalizeFinding(receipt)
              : normalizeRecheck(receipt),
          )
      ) return;
    }
    return receipt;
  } finally {
    db.close();
  }
}

/** Read immutable finding and recheck records without opening a journal writer. */
export function readSentinelCaseFindingReceipts(
  path: string,
  ids: readonly string[],
) {
  const records = new Map<string, SentinelWorkerFindingJournalRecord>();
  if (!ids.length || !hasSentinelWorkerFindingJournal(path)) return records;
  const db = openDatabase(path, true);
  try {
    db.exec("PRAGMA busy_timeout = 1500; PRAGMA trusted_schema = OFF");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (
      db.prepare("PRAGMA application_id").get()?.application_id !==
        APPLICATION_ID ||
      (version !== 1 && version !== VERSION)
    ) return records;
    const lookup = db.prepare("SELECT * FROM receipts WHERE id = ?");
    for (const id of ids) {
      if (!receiptPattern.test(id)) continue;
      const row = lookup.get(id);
      if (!row || row.reportVersion != null) continue;
      const record = decode(row);
      const normalized = record.kind === "finding"
        ? normalizeFinding(record)
        : normalizeRecheck(record);
      if (
        id === findingReceiptId(normalized) &&
        row.revision === record.evidenceRevision
      ) {
        records.set(id, record);
      }
    }
    return records;
  } finally {
    db.close();
  }
}

/** Resolve exact committed rechecks and their original finding in one run. */
export function readSentinelRemediationReceipts(
  path: string,
  scope: {
    caseId: string;
    runId: string;
    evidenceRevision: number;
    snapshotDigest: string;
  },
  ids: readonly string[],
): SentinelWorkerFindingRecheckRecord[] {
  const rechecks = [...readSentinelCaseFindingReceipts(path, ids).values()]
    .filter((receipt): receipt is SentinelWorkerFindingRecheckRecord =>
      receipt.kind === "recheck" && receipt.caseId === scope.caseId &&
      receipt.runId === scope.runId &&
      receipt.evidenceRevision === scope.evidenceRevision &&
      receipt.snapshotDigest === scope.snapshotDigest
    );
  const originals = readSentinelCaseFindingReceipts(
    path,
    [...new Set(rechecks.map(({ findingId }) => findingId))],
  );
  return rechecks.filter((receipt) => {
    const original = originals.get(receipt.findingId);
    return original?.kind === "finding" && original.caseId === receipt.caseId &&
      original.runId === receipt.runId &&
      original.targetId === receipt.targetId &&
      original.evidenceRevision <= receipt.evidenceRevision &&
      original.graphFindingId === receipt.graphFindingId &&
      original.controlId === receipt.controlId &&
      original.taskId !== receipt.taskId &&
      original.observedAt < receipt.observedAt &&
      (original.snapshotDigest !== receipt.snapshotDigest ||
        original.evidenceId !== receipt.evidenceId);
  });
}

export function readSentinelWorkerFindingHistory(
  path: string,
  revision?: number,
) {
  if (!hasSentinelWorkerFindingJournal(path)) return [];
  const store = openSentinelWorkerFindingStore(path);
  try {
    return store.list(revision);
  } finally {
    store.close();
  }
}

/** Keep original receipts and include the report state as of this evidence revision. */
export function readSentinelWorkerFindingReport(
  path: string,
  revision: number,
) {
  if (!hasSentinelWorkerFindingJournal(path)) return undefined;
  const store = openSentinelWorkerFindingStore(path);
  try {
    const current = store.list(revision);
    const amendments = store.listAmendments(revision);
    if (!current.length && !amendments.length) return undefined;
    const findings = new Map<string, SentinelWorkerFindingRecord>();
    const rechecks = [];
    for (const record of current) {
      if (record.kind === "finding") findings.set(record.id, record);
      else {
        rechecks.push(record);
        const original = store.readFinding(record.findingId);
        if (original) findings.set(original.id, original);
      }
    }
    for (const amendment of amendments) {
      const original = store.readFinding(amendment.findingId);
      if (original) findings.set(original.id, original);
    }
    const reports = [...findings.keys()].flatMap((id) => {
      const report = store.readFindingReport(id, revision);
      return report ? [report] : [];
    });
    return { findings: [...findings.values()], rechecks, amendments, reports };
  } finally {
    store.close();
  }
}
