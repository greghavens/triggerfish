/** Case-local immutable references from verified finding reports to saved traffic. */
/// <reference path="../core/sqlite_types.d.ts" />

import { dirname, join, resolve } from "@std/path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { redactCredentialText } from "../core/logger/redactor.ts";
import { locateSentinelCase } from "./cases.ts";
import {
  composeFindingTrafficLinks,
  decodeSentinelTrafficComposition,
  MAX_TRAFFIC_COMPOSITION_JOURNAL_BYTES,
  MAX_TRAFFIC_COMPOSITION_LINKS,
  parseSentinelTrafficComposition,
  type SentinelTrafficCompositionChange,
  type SentinelTrafficCompositionReceipt,
  trafficCompositionReceiptId,
  trafficCompositionTable,
} from "./finding_traffic_composition.ts";
import { assertOperatorSourceDirectoryInfo } from "./source_snapshot_lock.ts";
import {
  type SentinelTrafficSource,
  sentinelTrafficSources,
} from "./traffic_receipts.ts";

const journalName = "sentinel-finding-traffic-links.db";
const applicationId = 0x5346544c;
const maxLinks = MAX_TRAFFIC_COMPOSITION_LINKS;
const maxRequestAliases = 8192;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const finding = /^worker-finding:[a-f0-9]{64}$/;
const recheck = /^worker-recheck:[a-f0-9]{64}$/;
const assignment = /^adaptive:[a-f0-9]{64}$/;

export type SentinelFindingTrafficAuthority =
  | { readonly kind: "assignment"; readonly taskId: string }
  | { readonly kind: "operator" };

export const sentinelTrafficEvidenceRoles = [
  "baseline",
  "proof",
  "verification",
  "supporting",
] as const;
type TrafficEvidenceRole = typeof sentinelTrafficEvidenceRoles[number];

export function sentinelTrafficEvidenceAnnotation(
  { evidenceRole, evidenceNote }: Readonly<Record<string, unknown>>,
) {
  if (
    (evidenceRole !== undefined &&
      !sentinelTrafficEvidenceRoles.includes(
        evidenceRole as TrafficEvidenceRole,
      )) ||
    (evidenceNote !== undefined &&
      (typeof evidenceNote !== "string" || !evidenceNote.trim() ||
        evidenceNote.length > 500 || evidenceNote.includes("\0") ||
        redactCredentialText(evidenceNote) !== evidenceNote))
  ) return;
  return {
    ...(evidenceRole !== undefined &&
      { evidenceRole: evidenceRole as TrafficEvidenceRole }),
    ...(typeof evidenceNote === "string" && { evidenceNote }),
  };
}

export interface SentinelFindingTrafficLinkInput {
  readonly caseId: string;
  readonly evidenceRevision: number;
  readonly assetId: string;
  readonly findingId: string;
  readonly recheckId?: string;
  readonly reportVersion: number;
  readonly trafficId: string;
  readonly trafficSource: SentinelTrafficSource;
  readonly trafficDigest: string;
  readonly evidenceRole?: TrafficEvidenceRole;
  readonly evidenceNote?: string;
  readonly sourceHint?: { readonly id: number; readonly runId: string };
  readonly authority: SentinelFindingTrafficAuthority;
  readonly sourceStep?: { readonly stepIndex: number; readonly sha256: string };
  readonly requestId: string;
}

export interface SentinelFindingTrafficLink
  extends SentinelFindingTrafficLinkInput {
  readonly id: string;
  readonly recordedAt: string;
}

export interface SentinelFindingTrafficAnnotationChange {
  readonly linkId: string;
  readonly reportVersion: number;
  readonly evidenceVersion: string;
  readonly requestId: string;
  readonly evidenceRole?: TrafficEvidenceRole;
  readonly evidenceNote?: string;
}

export interface SentinelFindingTrafficAnnotation
  extends SentinelFindingTrafficAnnotationChange {
  readonly id: string;
  readonly recordedAt: string;
}

const annotationTable = "traffic_link_annotations";
const linkIdPattern = /^finding-traffic-link:[a-f0-9]{64}$/;

export function parseSentinelFindingTrafficAnnotationChange(
  input: Readonly<Record<string, unknown>>,
): SentinelFindingTrafficAnnotationChange | undefined {
  const { linkId, reportVersion, evidenceVersion, requestId } = input;
  const annotation = sentinelTrafficEvidenceAnnotation(input);
  if (
    typeof linkId !== "string" || !linkIdPattern.test(linkId) ||
    typeof reportVersion !== "number" || !positive(reportVersion) ||
    typeof evidenceVersion !== "string" || !digest.test(evidenceVersion) ||
    typeof requestId !== "string" || !uuid.test(requestId) ||
    !annotation || !Object.keys(annotation).length
  ) return;
  return {
    linkId,
    reportVersion,
    evidenceVersion,
    requestId: requestId.toLowerCase(),
    ...annotation,
  };
}

function annotationId(serialized: string): string {
  return "finding-traffic-annotation:" +
    createHash("sha256").update(serialized).digest("hex");
}

/** Verify a retained amendment, including its canonical redacted payload and digest. */
export function decodeSentinelTrafficLinkAnnotation(
  raw: Readonly<Record<string, unknown>>,
): SentinelFindingTrafficAnnotation {
  const input = parseSentinelFindingTrafficAnnotationChange(
    JSON.parse(String(raw.input)),
  );
  const serialized = JSON.stringify(input);
  if (
    !input || raw.input !== serialized || input.linkId !== raw.link_id ||
    input.requestId !== raw.request_id || annotationId(serialized) !== raw.id ||
    typeof raw.recorded_at !== "number" ||
    !Number.isSafeInteger(raw.recorded_at)
  ) throw new Error("Invalid Sentinel traffic annotation receipt");
  return {
    ...input,
    id: String(raw.id),
    recordedAt: new Date(raw.recorded_at).toISOString(),
  };
}

export const MAX_FINDING_TRAFFIC_BATCH = 4;
const batchTable = "traffic_link_batches";
const batchRejected = new Error("Sentinel traffic batch could not commit");

export interface SentinelFindingTrafficLinkFilter {
  readonly id?: string;
  readonly findingId?: string;
  readonly recheckId?: string;
  readonly assetId?: string;
  readonly evidenceRevision?: number;
  readonly limit?: number;
  readonly offset?: number;
  readonly includeWithdrawn?: boolean;
}

function exactText(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 4096 &&
    !value.includes("\0");
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function normalize(
  input: SentinelFindingTrafficLinkInput,
  expectedCase: string,
): SentinelFindingTrafficLinkInput {
  const {
    caseId,
    evidenceRevision,
    assetId,
    findingId,
    recheckId,
    reportVersion,
    trafficId,
    trafficSource,
    trafficDigest,
    sourceHint,
    sourceStep,
    authority,
    requestId,
  } = input;
  const annotation = sentinelTrafficEvidenceAnnotation({ ...input });
  if (
    !annotation || caseId !== expectedCase || !positive(evidenceRevision) ||
    !positive(reportVersion) || !exactText(assetId) || !exactText(trafficId) ||
    typeof findingId !== "string" || !finding.test(findingId) ||
    recheckId !== undefined &&
      (typeof recheckId !== "string" || !recheck.test(recheckId)) ||
    !sentinelTrafficSources.includes(trafficSource) ||
    typeof trafficDigest !== "string" || !digest.test(trafficDigest) ||
    typeof requestId !== "string" || !uuid.test(requestId) ||
    !authority || (sourceStep !== undefined &&
      (authority.kind !== "assignment" || !sourceStep ||
        Object.keys(sourceStep).length !== 2 ||
        !Number.isSafeInteger(sourceStep.stepIndex) ||
        sourceStep.stepIndex < 0 ||
        sourceStep.stepIndex >= 16 || typeof sourceStep.sha256 !== "string" ||
        !digest.test(sourceStep.sha256))) ||
    (sourceHint !== undefined &&
      (authority.kind !== "assignment" || !sourceHint ||
        Object.keys(sourceHint).length !== 2 || !positive(sourceHint.id) ||
        typeof sourceHint.runId !== "string" ||
        !uuid.test(sourceHint.runId))) ||
    (authority.kind !== "operator" &&
      (authority.kind !== "assignment" ||
        typeof authority.taskId !== "string" ||
        !assignment.test(authority.taskId)))
  ) throw new Error("Invalid Sentinel finding traffic link scope");
  return {
    caseId,
    evidenceRevision,
    assetId,
    findingId,
    ...(recheckId !== undefined && { recheckId }),
    reportVersion,
    trafficId,
    trafficSource,
    trafficDigest,
    ...annotation,
    ...(sourceHint !== undefined &&
      { sourceHint: { id: sourceHint.id, runId: sourceHint.runId } }),
    ...(sourceStep !== undefined && {
      sourceStep: {
        stepIndex: sourceStep.stepIndex,
        sha256: sourceStep.sha256,
      },
    }),
    authority: authority.kind === "assignment"
      ? { kind: "assignment", taskId: authority.taskId }
      : { kind: "operator" },
    requestId: requestId.toLowerCase(),
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

function linkContent(input: SentinelFindingTrafficLinkInput): string {
  const { requestId: _requestId, ...fields } = input;
  return JSON.stringify(fields);
}

function createRequestAliases(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE traffic_link_request_aliases (
      request_id TEXT PRIMARY KEY,
      link_id TEXT NOT NULL REFERENCES traffic_links(id)
    ) STRICT;
    PRAGMA user_version = 2;
  `);
}

function hasTable(db: DatabaseSync, table: string): boolean {
  return db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
  ).get(table) !== undefined;
}

function trafficEvidenceVersion(
  revision: number,
  findingId: string,
  ids: readonly string[],
  annotationIds: readonly string[],
  compositionIds: readonly string[] = [],
) {
  return createHash("sha256").update(JSON.stringify([
    revision,
    findingId,
    ids,
    ...(annotationIds.length ? [annotationIds] : []),
    ...(compositionIds.length ? [{ compositionIds }] : []),
  ])).digest("hex");
}

function initialize(db: DatabaseSync, readOnly: boolean) {
  const validate = () => {
    const app = db.prepare("PRAGMA application_id").get()?.application_id;
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (app === applicationId && version === 2) return;
    if (app === applicationId && version === 1) {
      if (!readOnly) createRequestAliases(db);
      return;
    }
    if (
      readOnly || app !== 0 || version !== 0 ||
      db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
    ) throw new Error("Invalid Sentinel finding traffic journal");
    db.exec(`
      CREATE TABLE traffic_links (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL,
        finding_id TEXT NOT NULL,
        input TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX traffic_links_revision ON traffic_links(revision);
      CREATE INDEX traffic_links_finding ON traffic_links(finding_id, revision);
      PRAGMA application_id = ${applicationId};`);
    createRequestAliases(db);
  };
  if (readOnly) validate();
  else transaction(db, validate);
}

function prepareTrafficBatch(
  caseId: string,
  requestId: string,
  runId: string,
  inputs: readonly SentinelFindingTrafficLinkInput[],
) {
  if (
    !uuid.test(requestId) || !uuid.test(runId) ||
    inputs.length < 2 || inputs.length > MAX_FINDING_TRAFFIC_BATCH
  ) return;
  const canonical = inputs.map((input) => normalize(input, caseId));
  const {
    findingId,
    assetId,
    evidenceRevision,
    recheckId,
    reportVersion,
    authority,
  } = canonical[0];
  if (
    canonical.some((input) =>
      input.findingId !== findingId ||
      input.assetId !== assetId ||
      input.evidenceRevision !== evidenceRevision ||
      input.recheckId !== recheckId ||
      input.reportVersion !== reportVersion ||
      input.authority.kind !== authority.kind ||
      (authority.kind === "assignment" &&
        (input.authority.kind !== "assignment" ||
          input.authority.taskId !== authority.taskId || !input.sourceStep ||
          recheckId !== undefined || input.sourceHint !== undefined))
    ) ||
    new Set(canonical.map(({ trafficId }) => trafficId)).size !==
      canonical.length
  ) return;
  const binding = createHash("sha256").update(
    JSON.stringify([runId, canonical]),
  ).digest("hex");
  return { canonical, binding, saved: undefined };
}

function sameBatchSource(
  link: SentinelFindingTrafficLink,
  expected: SentinelFindingTrafficLinkInput,
) {
  return link.authority.kind === "assignment" &&
    expected.authority.kind === "assignment" &&
    link.authority.taskId === expected.authority.taskId &&
    link.requestId === expected.requestId &&
    link.sourceStep?.stepIndex === expected.sourceStep?.stepIndex &&
    link.sourceStep?.sha256 === expected.sourceStep?.sha256;
}

function identifier(serialized: string) {
  return "finding-traffic-link:" +
    createHash("sha256").update(serialized).digest("hex");
}
/** Validate an archived or live immutable attachment before using its references. */
export function decodeSentinelFindingTrafficLink(
  row: Readonly<Record<string, unknown>>,
  caseId: string,
): SentinelFindingTrafficLink {
  const input = normalize(JSON.parse(String(row.input)), caseId);
  const id = identifier(JSON.stringify(input));
  if (
    id !== row.id || input.requestId !== row.request_id ||
    input.evidenceRevision !== row.revision ||
    input.findingId !== row.finding_id ||
    typeof row.recorded_at !== "number" ||
    !Number.isSafeInteger(row.recorded_at)
  ) {
    throw new Error("Invalid Sentinel finding traffic receipt");
  }
  return {
    ...input,
    id,
    recordedAt: new Date(Number(row.recorded_at)).toISOString(),
  };
}

function openLinks(snapshotPath: string, readOnly: boolean, now: () => number) {
  const snapshot = resolve(snapshotPath);
  const caseId = locateSentinelCase(snapshot)?.caseId;
  if (!caseId) {
    throw new Error("Sentinel traffic links require an exact case path");
  }
  const parent = dirname(snapshot);
  assertOperatorSourceDirectoryInfo(Deno.lstatSync(parent));
  const path = join(parent, journalName);
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
  ) throw new Error("Sentinel traffic links require a private regular journal");
  const db = new DatabaseSync(path, { readOnly });
  try {
    db.exec(
      "PRAGMA busy_timeout = 1500; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF",
    );
    initialize(db, readOnly);
  } catch (error) {
    db.close();
    throw error;
  }

  const decode = (row: Readonly<Record<string, unknown>>) =>
    decodeSentinelFindingTrafficLink(row, caseId!);

  function annotationsForLink(
    linkId: string,
  ): SentinelFindingTrafficAnnotation[] {
    if (!hasTable(db, annotationTable)) return [];
    return db.prepare(
      "SELECT * FROM traffic_link_annotations WHERE link_id = ? ORDER BY rowid LIMIT 17",
    ).all(linkId).map(decodeSentinelTrafficLinkAnnotation);
  }

  function exportAnnotations(
    revision: number,
  ): SentinelFindingTrafficAnnotation[] {
    if (!hasTable(db, annotationTable)) return [];
    const rows = db.prepare(
      `SELECT annotation.* FROM traffic_link_annotations AS annotation
      WHERE link_id IN (SELECT id FROM traffic_links WHERE revision = ?)
      ORDER BY annotation.rowid LIMIT ?`,
    ).all(revision, maxLinks + 1);
    if (rows.length > maxLinks) {
      throw new Error("Invalid Sentinel traffic annotation journal size");
    }
    return rows.map(decodeSentinelTrafficLinkAnnotation);
  }

  function compositionEdits(
    revision: number,
    findingId?: string,
  ): SentinelTrafficCompositionReceipt[] {
    if (!hasTable(db, trafficCompositionTable)) return [];
    const rows = db.prepare(`SELECT * FROM traffic_link_composition
      WHERE revision = ? AND (? IS NULL OR finding_id = ?)
      ORDER BY sequence LIMIT ?`).all(
      revision,
      findingId ?? null,
      findingId ?? null,
      maxLinks + 1,
    );
    if (rows.length > maxLinks) {
      throw new Error("Invalid Sentinel traffic composition journal size");
    }
    return rows.map(decodeSentinelTrafficComposition);
  }

  function activeCompositionIds(
    revision: number,
    findingId: string,
    assetId?: string,
  ) {
    const ids = db.prepare(
      `SELECT id FROM traffic_links WHERE revision = ? AND finding_id = ?
      AND (? IS NULL OR json_extract(input, '$.assetId') = ?) ORDER BY rowid DESC`,
    )
      .all(revision, findingId, assetId ?? null, assetId ?? null)
      .map(({ id }) => String(id));
    return composeFindingTrafficLinks(
      ids,
      compositionEdits(revision, findingId),
    );
  }

  function evidenceVersion(
    revision: number,
    findingId: string,
    assetId?: string,
  ) {
    const matching = `FROM traffic_links
      WHERE revision = ? AND finding_id = ?
        AND (? IS NULL OR json_extract(input, '$.assetId') = ?)`;
    const params = [
      revision,
      findingId,
      assetId ?? null,
      assetId ?? null,
    ] as const;
    const ids = db.prepare(`SELECT id ${matching} ORDER BY id`).all(...params)
      .map(({ id }) => String(id));
    const edits = hasTable(db, annotationTable)
      ? db.prepare(`SELECT id FROM traffic_link_annotations
          WHERE link_id IN (SELECT id ${matching}) ORDER BY id`).all(...params)
        .map(({ id }) => String(id))
      : [];
    const changes = compositionEdits(revision, findingId);
    const idsInScope = new Set(ids);
    const scopedChanges = assetId === undefined
      ? changes
      : changes.filter((change) =>
        change.operation === "withdraw"
          ? idsInScope.has(change.linkId)
          : change.linkIds.some((id) => idsInScope.has(id))
      );
    return {
      digest: trafficEvidenceVersion(
        revision,
        findingId,
        ids,
        edits,
        scopedChanges.map(({ id }) => id),
      ),
      count: composeFindingTrafficLinks(ids, scopedChanges).length,
    };
  }

  /** Apply one normalized link inside the caller's transaction. */
  function recordOne(
    raw: SentinelFindingTrafficLinkInput,
    verifyNew: (input: SentinelFindingTrafficLinkInput) => boolean,
  ): SentinelFindingTrafficLink | undefined {
    if (readOnly) {
      throw new Error("The Sentinel traffic journal is read-only");
    }
    const input = normalize(raw, caseId!);
    const serialized = JSON.stringify(input);
    const id = identifier(serialized);
    const existing = db.prepare(
      "SELECT * FROM traffic_links WHERE request_id = ?",
    ).get(input.requestId);
    if (existing) return existing.id === id ? decode(existing) : undefined;
    const alias = db.prepare(`
          SELECT links.* FROM traffic_link_request_aliases AS aliases
          JOIN traffic_links AS links ON links.id = aliases.link_id
          WHERE aliases.request_id = ?
        `).get(input.requestId);
    const content = linkContent(input);
    if (alias) {
      const prior = decode(alias);
      const { id: _id, recordedAt: _at, ...priorInput } = prior;
      return linkContent(priorInput) === content ? prior : undefined;
    }
    if (verifyNew(input) !== true) return undefined;
    const equivalent = db.prepare(`
          SELECT * FROM traffic_links
          WHERE finding_id = ? AND revision = ?
            AND json_remove(input, '$.requestId') = ?
          ORDER BY rowid LIMIT 1
        `).get(input.findingId, input.evidenceRevision, content);
    if (equivalent) {
      const count = Number(
        db.prepare(
          "SELECT count(*) AS count FROM traffic_link_request_aliases",
        ).get()?.count,
      );
      if (count >= maxRequestAliases) {
        throw new Error("Sentinel traffic link request limit reached");
      }
      db.prepare("INSERT INTO traffic_link_request_aliases VALUES (?, ?)")
        .run(input.requestId, equivalent.id);
      return decode(equivalent);
    }
    const count = Number(
      db.prepare(
        "SELECT COUNT(*) AS count FROM traffic_links",
      ).get()?.count,
    );
    if (count >= maxLinks) {
      throw new Error("Sentinel traffic link limit reached");
    }
    const time = now();
    if (!Number.isSafeInteger(time)) {
      throw new Error("Invalid traffic link clock");
    }
    const recordedAt = new Date(time).toISOString();
    db.prepare(`INSERT INTO traffic_links
          (id,request_id,revision,finding_id,input,recorded_at) VALUES (?,?,?,?,?,?)`)
      .run(
        id,
        input.requestId,
        input.evidenceRevision,
        input.findingId,
        serialized,
        time,
      );
    return { ...input, id, recordedAt };
  }

  function inspectBatch(
    requestId: string,
    runId: string,
    inputs: readonly SentinelFindingTrafficLinkInput[],
  ) {
    const prepared = prepareTrafficBatch(caseId!, requestId, runId, inputs);
    if (!prepared) return;
    const { canonical, binding } = prepared;
    const { findingId, assetId, evidenceRevision, recheckId } = canonical[0];
    const prior = hasTable(db, batchTable)
      ? db.prepare(
        "SELECT * FROM traffic_link_batches WHERE request_id = ?",
      ).get(requestId)
      : undefined;
    if (!prior) return { canonical, binding, saved: undefined };
    if (
      prior.binding !== binding || prior.revision !== evidenceRevision ||
      prior.finding_id !== findingId || prior.run_id !== runId
    ) return;
    const ids = JSON.parse(String(prior.link_ids));
    if (
      !Array.isArray(ids) || ids.length !== canonical.length ||
      new Set(ids).size !== ids.length ||
      !ids.every((id) => typeof id === "string" && linkIdPattern.test(id))
    ) return;
    const lookup = db.prepare("SELECT * FROM traffic_links WHERE id = ?");
    const saved = [];
    for (const [index, id] of ids.entries()) {
      const row = lookup.get(id);
      const link = row && decode(row);
      const expected = canonical[index];
      if (
        !link || link.findingId !== findingId || link.assetId !== assetId ||
        link.evidenceRevision !== evidenceRevision ||
        link.recheckId !== recheckId ||
        link.trafficId !== expected.trafficId ||
        link.trafficDigest !== expected.trafficDigest ||
        link.trafficSource !== expected.trafficSource ||
        (expected.sourceStep && !sameBatchSource(link, expected))
      ) return;
      saved.push(link);
    }
    return { canonical, binding, saved };
  }

  function readAssignmentBatch(
    scope: {
      caseId: string;
      runId: string;
      evidenceRevision: number;
      taskId: string;
      assetId: string;
    },
    requestId: string,
  ) {
    if (
      scope.caseId !== caseId || !uuid.test(requestId) ||
      !hasTable(db, batchTable)
    ) return;
    const batch = db.prepare(
      "SELECT * FROM traffic_link_batches WHERE request_id = ?",
    ).get(requestId);
    if (
      batch?.run_id !== scope.runId ||
      batch.revision !== scope.evidenceRevision
    ) return;
    const ids = JSON.parse(String(batch.link_ids));
    if (
      !Array.isArray(ids) || ids.length < 2 ||
      ids.length > MAX_FINDING_TRAFFIC_BATCH ||
      !ids.every((id) => typeof id === "string" && linkIdPattern.test(id)) ||
      new Set(ids).size !== ids.length
    ) return;
    const lookup = db.prepare("SELECT * FROM traffic_links WHERE id = ?");
    const links = [];
    for (const id of ids) {
      const row = lookup.get(id);
      const link = row && decode(row);
      if (
        !link || link.authority.kind !== "assignment" ||
        link.authority.taskId !== scope.taskId || !link.sourceStep ||
        link.assetId !== scope.assetId || link.findingId !== batch.finding_id ||
        link.evidenceRevision !== scope.evidenceRevision
      ) return;
      links.push(link);
    }
    const prepared = prepareTrafficBatch(
      scope.caseId,
      requestId,
      scope.runId,
      links,
    );
    return prepared?.binding === batch.binding
      ? { id: `finding-traffic-batch:${batch.binding}`, links }
      : undefined;
  }

  function recordBatch(
    requestId: string,
    runId: string,
    inputs: readonly SentinelFindingTrafficLinkInput[],
    verifyNew: (input: SentinelFindingTrafficLinkInput) => boolean,
  ) {
    try {
      return transaction(db, () => {
        const preview = inspectBatch(requestId, runId, inputs);
        if (!preview || preview.saved) return preview?.saved;
        const links = [];
        const existing = db.prepare(
          `SELECT * FROM traffic_links WHERE finding_id = ?
          AND revision = ? AND json_extract(input, '$.trafficId') = ?
          AND json_extract(input, '$.recheckId') IS ? ORDER BY rowid LIMIT 1`,
        );
        for (const input of preview.canonical) {
          if (!verifyNew(input)) throw batchRejected;
          const row = existing.get(
            input.findingId,
            input.evidenceRevision,
            input.trafficId,
            input.recheckId ?? null,
          );
          const link = row ? decode(row) : recordOne(input, verifyNew);
          if (
            !link || link.assetId !== input.assetId ||
            link.trafficDigest !== input.trafficDigest ||
            link.trafficSource !== input.trafficSource ||
            (input.sourceStep && !sameBatchSource(link, input))
          ) throw batchRejected;
          links.push(link);
        }
        db.exec(`CREATE TABLE IF NOT EXISTS traffic_link_batches (
          request_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL, revision INTEGER NOT NULL, finding_id TEXT NOT NULL,
          binding TEXT NOT NULL, link_ids TEXT NOT NULL
        ) STRICT`);
        if (
          Number(
            db.prepare("SELECT count(*) AS count FROM traffic_link_batches")
              .get()?.count,
          ) >= maxLinks
        ) throw batchRejected;
        const { evidenceRevision, findingId } = preview.canonical[0];
        db.prepare("INSERT INTO traffic_link_batches VALUES (?,?,?,?,?,?)").run(
          requestId,
          runId,
          evidenceRevision,
          findingId,
          preview.binding,
          JSON.stringify(links.map(({ id }) => id)),
        );
        return links;
      });
    } catch (error) {
      if (error === batchRejected) return;
      throw error;
    }
  }

  return {
    activeCompositionIds,
    compositionEdits,
    compositionRequest(requestId: string) {
      if (!hasTable(db, trafficCompositionTable)) return;
      const row = db.prepare(
        "SELECT * FROM traffic_link_composition WHERE request_id = ?",
      ).get(requestId);
      return row && decodeSentinelTrafficComposition(row);
    },
    compositionReceipt(revision: number, findingId: string, id: string) {
      if (!hasTable(db, trafficCompositionTable)) return;
      const row = db.prepare(
        "SELECT * FROM traffic_link_composition WHERE revision = ? AND finding_id = ? AND id = ?",
      )
        .get(revision, findingId, id);
      return row && decodeSentinelTrafficComposition(row);
    },
    reviewComposition(raw: SentinelTrafficCompositionChange, commit: boolean) {
      const input = parseSentinelTrafficComposition(raw);
      if (!input || input.caseId !== caseId) return;
      return transaction(db, () => {
        const serialized = JSON.stringify(input);
        if (hasTable(db, trafficCompositionTable)) {
          const retry = db.prepare(
            "SELECT * FROM traffic_link_composition WHERE request_id = ?",
          ).get(input.requestId);
          if (retry) {
            return retry.input === serialized
              ? {
                saved: true,
                amendment: decodeSentinelTrafficComposition(retry),
              }
              : undefined;
          }
          const budget = db.prepare(
            "SELECT count(*) AS count, sum(length(input)) AS bytes FROM traffic_link_composition",
          ).get();
          if (
            Number(budget?.count) >= maxLinks ||
            Number(budget?.bytes ?? 0) + serialized.length >
              MAX_TRAFFIC_COMPOSITION_JOURNAL_BYTES
          ) return;
        }
        const { evidenceRevision: revision, findingId } = input;
        const active = activeCompositionIds(revision, findingId);
        const activeSet = new Set(active);
        if (
          input.evidenceVersion !==
            evidenceVersion(revision, findingId).digest ||
          (input.operation === "withdraw"
            ? !activeSet.has(input.linkId)
            : input.linkIds.length !== active.length ||
              input.linkIds.some((id) => !activeSet.has(id)))
        ) return;
        if (!commit) return { saved: false, amendment: undefined };
        const id = trafficCompositionReceiptId(serialized);
        const time = now();
        db.exec(`CREATE TABLE IF NOT EXISTS traffic_link_composition (
          sequence INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE, request_id TEXT NOT NULL UNIQUE,
          revision INTEGER NOT NULL, finding_id TEXT NOT NULL,
          input TEXT NOT NULL, recorded_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS traffic_link_composition_scope ON traffic_link_composition(revision, finding_id);`);
        db.prepare(`INSERT INTO traffic_link_composition
          (id, request_id, revision, finding_id, input, recorded_at) VALUES (?,?,?,?,?,?)`)
          .run(id, input.requestId, revision, findingId, serialized, time);
        return {
          saved: true,
          amendment: { ...input, id, recordedAt: new Date(time).toISOString() },
        };
      });
    },
    annotationsForLink,
    evidenceVersion,
    exportAnnotations,
    reviewAnnotation(
      link: SentinelFindingTrafficLink,
      change: SentinelFindingTrafficAnnotationChange,
      commit: boolean,
    ) {
      const input = parseSentinelFindingTrafficAnnotationChange({ ...change });
      if (!input) return;
      return transaction(db, () => {
        const row = db.prepare("SELECT * FROM traffic_links WHERE id = ?").get(
          input.linkId,
        );
        if (!row || JSON.stringify(decode(row)) !== JSON.stringify(link)) {
          return;
        }
        const serialized = JSON.stringify(input);
        if (hasTable(db, annotationTable)) {
          const retry = db.prepare(
            "SELECT link_id, input FROM traffic_link_annotations WHERE request_id = ?",
          ).get(input.requestId);
          if (retry) {
            const amendment =
              retry.link_id === link.id && retry.input === serialized
                ? annotationsForLink(link.id).find(({ requestId }) =>
                  requestId === input.requestId
                )
                : undefined;
            return amendment && { saved: true, amendment };
          }
          const count = Number(
            db.prepare("SELECT count(*) AS count FROM traffic_link_annotations")
              .get()?.count,
          );
          if (count >= maxLinks || annotationsForLink(link.id).length >= 16) {
            return;
          }
        }
        if (
          input.evidenceVersion !==
            evidenceVersion(link.evidenceRevision, link.findingId).digest
        ) return;
        if (!commit) return { saved: false, amendment: undefined };
        const id = annotationId(serialized);
        const time = now();
        db.exec(`CREATE TABLE IF NOT EXISTS traffic_link_annotations (
          id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
          link_id TEXT NOT NULL REFERENCES traffic_links(id),
          input TEXT NOT NULL, recorded_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS traffic_link_annotations_link ON traffic_link_annotations(link_id);`);
        db.prepare("INSERT INTO traffic_link_annotations VALUES (?,?,?,?,?)")
          .run(id, input.requestId, input.linkId, serialized, time);
        return {
          saved: true,
          amendment: { ...input, id, recordedAt: new Date(time).toISOString() },
        };
      });
    },
    readAssignmentRequest(
      scope: {
        readonly caseId: string;
        readonly assetId: string;
        readonly evidenceRevision: number;
        readonly taskId: string;
      },
      requestId: string,
    ): SentinelFindingTrafficLink | undefined {
      if (
        scope.caseId !== caseId || !exactText(scope.assetId) ||
        !positive(scope.evidenceRevision) || !assignment.test(scope.taskId) ||
        typeof requestId !== "string" || !uuid.test(requestId)
      ) return;
      const canonical = requestId.toLowerCase();
      const direct = db.prepare(
        "SELECT * FROM traffic_links WHERE request_id = ? AND revision = ?",
      ).get(canonical, scope.evidenceRevision);
      const row = direct ??
        (db.prepare("PRAGMA user_version").get()?.user_version === 2
          ? db.prepare(`
          SELECT links.* FROM traffic_link_request_aliases AS aliases
          JOIN traffic_links AS links ON links.id = aliases.link_id
          WHERE aliases.request_id = ? AND links.revision = ?
        `).get(canonical, scope.evidenceRevision)
          : undefined);
      if (!row) return;
      const link = decode(row);
      if (
        link.assetId === scope.assetId &&
        link.authority.kind === "assignment" &&
        link.authority.taskId === scope.taskId
      ) return link;
    },

    inspectBatch,
    recordBatch,
    readAssignmentBatch,
    /** The caller must gate case and lease for every request, including retries. */
    record(
      raw: SentinelFindingTrafficLinkInput,
      verifyNew: (input: SentinelFindingTrafficLinkInput) => boolean,
    ) {
      return transaction(db, () => recordOne(raw, verifyNew));
    },
    list(filter: SentinelFindingTrafficLinkFilter = {}) {
      const {
        id,
        findingId,
        recheckId,
        assetId,
        evidenceRevision,
        limit = 20,
        offset = 0,
        includeWithdrawn = false,
      } = filter;
      if (
        id !== undefined &&
          (typeof id !== "string" ||
            !/^finding-traffic-link:[a-f0-9]{64}$/.test(id)) ||
        findingId !== undefined &&
          (typeof findingId !== "string" || !finding.test(findingId)) ||
        recheckId !== undefined &&
          (findingId === undefined || typeof recheckId !== "string" ||
            !recheck.test(recheckId)) ||
        assetId !== undefined && !exactText(assetId) ||
        evidenceRevision !== undefined && !positive(evidenceRevision) ||
        !positive(limit) || limit > 100 ||
        !Number.isSafeInteger(offset) || offset < 0
      ) throw new Error("Invalid Sentinel finding traffic link filter");
      const compose = !includeWithdrawn &&
        hasTable(db, trafficCompositionTable);
      const rows = db.prepare(`SELECT * FROM traffic_links
        WHERE (? IS NULL OR finding_id = ?) AND (? IS NULL OR revision = ?)
          AND (? IS NULL OR json_extract(input, '$.assetId') = ?)
          AND (? IS NULL OR id = ?)
          AND (? IS NULL OR json_extract(input, '$.recheckId') = ?)
        ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(
        findingId ?? null,
        findingId ?? null,
        evidenceRevision ?? null,
        evidenceRevision ?? null,
        assetId ?? null,
        assetId ?? null,
        id ?? null,
        id ?? null,
        recheckId ?? null,
        recheckId ?? null,
        compose ? maxLinks + 1 : limit,
        compose ? 0 : offset,
      );
      if (!compose) return rows.map(decode);
      if (rows.length > maxLinks) {
        throw new Error("Invalid Sentinel traffic link journal size");
      }
      const byRevision = Map.groupBy(rows, ({ revision }) => Number(revision));
      const active = new Set<string>();
      const exactOrder = new Map<string, number>();
      for (const [revision, entries] of byRevision) {
        const edits = Map.groupBy(
          compositionEdits(revision, findingId),
          (item) => item.findingId,
        );
        for (
          const [finding, group] of Map.groupBy(
            entries,
            ({ finding_id }) => String(finding_id),
          )
        ) {
          const ids = composeFindingTrafficLinks(
            group.map(({ id }) => String(id)),
            edits.get(finding) ?? [],
          );
          for (const [index, id] of ids.entries()) {
            active.add(id);
            if (findingId !== undefined && evidenceRevision !== undefined) {
              exactOrder.set(id, index);
            }
          }
        }
      }
      const selected = rows.filter(({ id }) => active.has(String(id)));
      if (exactOrder.size) {
        selected.sort((left, right) =>
          exactOrder.get(String(left.id))! - exactOrder.get(String(right.id))!
        );
      }
      return selected.slice(offset, offset + limit).map(decode);
    },
    exportRevision(
      evidenceRevision: number,
    ): readonly SentinelFindingTrafficLink[] {
      const rows = db.prepare(`SELECT * FROM traffic_links
        WHERE revision = ? ORDER BY rowid DESC LIMIT ?`).all(
        evidenceRevision,
        maxLinks + 1,
      );
      if (rows.length > maxLinks) {
        throw new Error("Invalid Sentinel traffic link journal size");
      }
      return rows.map(decode);
    },
    close() {
      db.close();
    },
  };
}

/** Open the writable journal for an authenticated broker operating in the case lock. */
export function openSentinelFindingTrafficLinks(
  snapshotPath: string,
  now = Date.now,
) {
  return openLinks(snapshotPath, false, now);
}

/** Read a case's retained links without creating an empty journal. */
export function listSentinelFindingTrafficLinks(
  snapshotPath: string,
  filter?: SentinelFindingTrafficLinkFilter,
) {
  return readFindingTrafficLinks(snapshotPath, (links) => links.list(filter)) ??
    [];
}

/** Resolve a committed attachment without invoking the handler or reopening traffic. */
/** Preview exact metadata and replay without creating or migrating an empty journal. */
export function previewSentinelFindingTrafficBatch(
  snapshotPath: string,
  requestId: string,
  runId: string,
  inputs: readonly SentinelFindingTrafficLinkInput[],
) {
  const existing = readFindingTrafficLinks(snapshotPath, (links) => ({
    result: links.inspectBatch(requestId, runId, inputs),
  }));
  if (existing) return existing.result;
  const caseId = locateSentinelCase(snapshotPath)?.caseId;
  return caseId
    ? prepareTrafficBatch(caseId, requestId, runId, inputs)
    : undefined;
}

export function readSentinelFindingTrafficWriteReceipt(
  snapshotPath: string,
  scope: Parameters<ReturnType<typeof openLinks>["readAssignmentRequest"]>[0],
  requestId: string,
): SentinelFindingTrafficLink | undefined {
  return readFindingTrafficLinks(
    snapshotPath,
    (links) => links.readAssignmentRequest(scope, requestId),
  );
}

/** Reopen an exact committed attachment batch for its original leased assignment. */
export function readSentinelFindingTrafficAssignmentBatch(
  snapshotPath: string,
  scope: Parameters<ReturnType<typeof openLinks>["readAssignmentBatch"]>[0],
  requestId: string,
) {
  return readFindingTrafficLinks(
    snapshotPath,
    (links) => links.readAssignmentBatch(scope, requestId),
  );
}

/** Export the complete retained receipt set for an exact evidence revision. */
export function exportSentinelFindingTrafficLinks(
  snapshotPath: string,
  evidenceRevision: number,
) {
  if (!positive(evidenceRevision)) {
    throw new Error("Invalid Sentinel traffic link evidence revision");
  }
  return readFindingTrafficLinks(
    snapshotPath,
    (links) => links.exportRevision(evidenceRevision),
  ) ?? [];
}

/** Bind the complete attachment set for a finding at a saved revision. */
export function sentinelFindingTrafficEvidenceVersion(
  snapshotPath: string,
  revision: number,
  findingId: string,
  assetId?: string,
) {
  return readFindingTrafficLinks(
    snapshotPath,
    (links) => links.evidenceVersion(revision, findingId, assetId),
  ) ??
    { digest: trafficEvidenceVersion(revision, findingId, [], []), count: 0 };
}

export function readSentinelTrafficCompositionReceipt(
  snapshotPath: string,
  revision: number,
  findingId: string,
  id: string,
) {
  return readFindingTrafficLinks(
    snapshotPath,
    (links) => links.compositionReceipt(revision, findingId, id),
  );
}

export function readSentinelTrafficCompositionHistory(
  snapshotPath: string,
  revision: number,
  findingId?: string,
) {
  return readFindingTrafficLinks(
    snapshotPath,
    (links) => links.compositionEdits(revision, findingId),
  ) ?? [];
}

export function exportSentinelTrafficLinkAnnotations(
  snapshotPath: string,
  revision: number,
) {
  return readFindingTrafficLinks(
    snapshotPath,
    (links) => links.exportAnnotations(revision),
  ) ?? [];
}

export function readSentinelTrafficLinkAnnotations(
  snapshotPath: string,
  linkIds: readonly string[],
) {
  if (!linkIds.length) return [];
  return readFindingTrafficLinks(
    snapshotPath,
    (links) => linkIds.flatMap(links.annotationsForLink),
  ) ?? [];
}

function readFindingTrafficLinks<T>(
  snapshotPath: string,
  read: (links: ReturnType<typeof openLinks>) => T,
): T | undefined {
  let links;
  try {
    links = openLinks(snapshotPath, true, Date.now);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  try {
    return read(links);
  } finally {
    links.close();
  }
}
