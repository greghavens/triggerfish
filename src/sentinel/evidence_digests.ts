/** Immutable bounded evidence member projections for exact saved Sentinel scopes. */
/// <reference path="../core/sqlite_types.d.ts" />

import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { redactCredentialText } from "../core/logger/redactor.ts";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "@std/path";
import { isSentinelCaseId } from "./cases.ts";
import { assertOperatorSourceDirectoryInfo } from "./source_snapshot_lock.ts";

export interface SentinelEvidenceDigestScope {
  readonly caseId: string;
  readonly runId: string;
  readonly evidenceRevision: number;
}

export interface SentinelEvidenceDigestMember {
  readonly id: string;
  readonly kind:
    | "asset"
    | "finding"
    | "control"
    | "evidence"
    | "goal"
    | "task"
    | "observation";
  readonly label: string;
  readonly status?: string;
}

export interface SentinelEvidenceDigest {
  readonly id: string;
  readonly scope: SentinelEvidenceDigestScope;
  readonly memberCount: number;
  readonly createdAt: string;
}

export const MAX_SENTINEL_EVIDENCE_DIGEST_MEMBERS = 256;
export const MAX_SENTINEL_EVIDENCE_DIGEST_BYTES = 128 * 1024;
export const MAX_SENTINEL_EVIDENCE_DIGEST_PAGE = 30;
export const MAX_SENTINEL_EVIDENCE_DIGEST_MEMBER_ID = 1024;
export const MAX_SENTINEL_EVIDENCE_DIGEST_MEMBER_LABEL = 512;
export const MAX_SENTINEL_EVIDENCE_DIGEST_MEMBER_STATUS = 80;
const appId = 0x53454447;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digestPattern = /^sentinel-digest:[a-f0-9]{64}$/;
const kinds = new Set([
  "asset",
  "finding",
  "control",
  "evidence",
  "goal",
  "task",
  "observation",
]);
type Row = NonNullable<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>>;

function scopeFor(
  raw: SentinelEvidenceDigestScope,
): SentinelEvidenceDigestScope | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { caseId, runId, evidenceRevision } = raw;
  if (
    !isSentinelCaseId(caseId) || typeof runId !== "string" ||
    !uuid.test(runId) ||
    !Number.isSafeInteger(evidenceRevision) || evidenceRevision < 1
  ) return undefined;
  return { caseId, runId, evidenceRevision };
}

function checkedText(value: unknown, limit: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= limit &&
    [...value].every((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && (code < 127 || code >= 160);
    });
}

export function normalizeSentinelEvidenceDigestMembers(raw: unknown) {
  if (
    !Array.isArray(raw) || !raw.length ||
    raw.length > MAX_SENTINEL_EVIDENCE_DIGEST_MEMBERS
  ) return undefined;
  const members: SentinelEvidenceDigestMember[] = [];
  const ids = new Set<string>();
  for (const member of raw) {
    if (!member || typeof member !== "object" || Array.isArray(member)) {
      return undefined;
    }
    const { id, kind, label, status } = member as SentinelEvidenceDigestMember;
    if (
      !checkedText(id, MAX_SENTINEL_EVIDENCE_DIGEST_MEMBER_ID) ||
      ids.has(id) || !kinds.has(kind) ||
      !checkedText(label, MAX_SENTINEL_EVIDENCE_DIGEST_MEMBER_LABEL) ||
      (status !== undefined &&
        !checkedText(status, MAX_SENTINEL_EVIDENCE_DIGEST_MEMBER_STATUS))
    ) return undefined;
    ids.add(id);
    members.push({ id, kind, label, ...(status !== undefined && { status }) });
  }
  members.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return new TextEncoder().encode(JSON.stringify(members)).byteLength <=
      MAX_SENTINEL_EVIDENCE_DIGEST_BYTES
    ? members
    : undefined;
}

function idFor(
  scope: SentinelEvidenceDigestScope,
  members: readonly SentinelEvidenceDigestMember[],
) {
  return "sentinel-digest:" +
    createHash("sha256").update(JSON.stringify([1, scope, members])).digest(
      "hex",
    );
}

function privateDatabase(baseDir: string) {
  const parent = join(resolve(baseDir), "data");
  Deno.mkdirSync(parent, { mode: 0o700, recursive: true });
  assertOperatorSourceDirectoryInfo(Deno.lstatSync(parent));
  const path = join(parent, "sentinel-evidence-digests.db");
  try {
    Deno.openSync(path, { createNew: true, write: true, mode: 0o600 }).close();
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  const info = Deno.lstatSync(path);
  if (
    !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
    ((info.mode ?? 0) & 0o077) !== 0
  ) {
    throw new Error(
      "Sentinel evidence digests require a private regular database.",
    );
  }
  return new DatabaseSync(path);
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function summary(
  scope: SentinelEvidenceDigestScope,
  row: Row,
): SentinelEvidenceDigest {
  return {
    id: String(row.id),
    scope,
    memberCount: Number(row.memberCount),
    createdAt: new Date(Number(row.createdAt)).toISOString(),
  };
}

function validLimit(limit: number) {
  return Number.isSafeInteger(limit) && limit >= 1 &&
    limit <= MAX_SENTINEL_EVIDENCE_DIGEST_PAGE;
}

/** Caller supplies exact saved members from an authorized Sentinel case revision. */
export function openSentinelEvidenceDigests(baseDir: string, now = Date.now) {
  const db = privateDatabase(baseDir);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF");
    transaction(db, () => {
      const id = db.prepare("PRAGMA application_id").get()?.application_id;
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (id === appId && version === 1) return;
      if (
        id !== 0 || version !== 0 ||
        db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
      ) {
        throw new Error(
          "Invalid Sentinel evidence digest database or version.",
        );
      }
      db.exec(`
        CREATE TABLE evidence_digests (
          sequence INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          caseId TEXT NOT NULL,
          runId TEXT NOT NULL,
          evidenceRevision INTEGER NOT NULL,
          memberCount INTEGER NOT NULL,
          members TEXT NOT NULL,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX evidence_digest_scope ON evidence_digests(caseId, runId, evidenceRevision, sequence DESC);
        PRAGMA application_id = ${appId};
        PRAGMA user_version = 1;
      `);
    });
  } catch (error) {
    db.close();
    throw error;
  }
  const scopeParams = (
    { caseId, runId, evidenceRevision }: SentinelEvidenceDigestScope,
  ) => [caseId, runId, evidenceRevision];
  const scoped = db.prepare(`
    SELECT * FROM evidence_digests WHERE caseId = ? AND runId = ? AND evidenceRevision = ? AND id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO evidence_digests (id,caseId,runId,evidenceRevision,memberCount,members,createdAt)
    VALUES (?,?,?,?,?,?,?) RETURNING *
  `);
  function write(
    scope: SentinelEvidenceDigestScope,
    members: readonly SentinelEvidenceDigestMember[],
  ) {
    const id = idFor(scope, members);
    const encoded = JSON.stringify(members);
    const existing = scoped.get(...scopeParams(scope), id);
    if (existing) {
      return existing.members === encoded
        ? summary(scope, existing)
        : undefined;
    }
    const row = insert.get(
      id,
      ...scopeParams(scope),
      members.length,
      encoded,
      now(),
    );
    return summary(scope, row!);
  }

  return {
    record(
      rawScope: SentinelEvidenceDigestScope,
      input: { readonly members: readonly SentinelEvidenceDigestMember[] },
    ) {
      const scope = scopeFor(rawScope);
      const members = normalizeSentinelEvidenceDigestMembers(input?.members);
      if (!scope || !members) return undefined;
      return transaction(db, () => write(scope, members));
    },

    recordBatch(
      rawScope: SentinelEvidenceDigestScope,
      groups: readonly (readonly SentinelEvidenceDigestMember[])[],
    ) {
      const scope = scopeFor(rawScope);
      if (!scope || groups.length > 100) return [];
      const normalized = groups.map(normalizeSentinelEvidenceDigestMembers);
      if (normalized.some((members) => !members)) return [];
      return transaction(db, () =>
        normalized.map((members) => {
          const digest = write(scope, members!);
          if (!digest) throw new Error("Conflicting Sentinel digest");
          return digest;
        }));
    },

    exportScope(
      rawScope: SentinelEvidenceDigestScope,
      maximum: number,
      exclude: readonly string[] = [],
    ) {
      const scope = scopeFor(rawScope);
      if (!scope) throw new Error("Invalid Sentinel digest archive scope.");
      const where = `WHERE caseId = ? AND runId = ? AND evidenceRevision = ?
        AND id NOT IN (SELECT value FROM json_each(?))`;
      const params = [...scopeParams(scope), JSON.stringify(exclude)];
      const size = db.prepare(`
        SELECT sum(length(CAST(members AS BLOB))) AS bytes FROM evidence_digests ${where}
      `).get(...params);
      if (Number(size?.bytes ?? 0) > maxCatalogBytes) {
        throw new Error(
          "Archived Sentinel digest catalog exceeds its size limit.",
        );
      }
      const rows = db.prepare(`
        SELECT * FROM evidence_digests ${where}
        ORDER BY sequence DESC LIMIT ?
      `).all(...params, maximum + 1);
      if (rows.length > maximum) {
        throw new Error("Sentinel digest archive has too many entries.");
      }
      return rows.map((row) =>
        checkedCatalogEntry({
          digest: summary(scope, row),
          members: JSON.parse(String(row.members)),
        })
      );
    },

    list(
      rawScope: SentinelEvidenceDigestScope,
      limit = 10,
      cursor?: string,
      exclude: readonly string[] = [],
    ) {
      const scope = scopeFor(rawScope);
      if (!scope || !validLimit(limit)) return undefined;
      const params = scopeParams(scope);
      let after = Number.MAX_SAFE_INTEGER;
      if (cursor !== undefined) {
        if (typeof cursor !== "string" || !digestPattern.test(cursor)) {
          return undefined;
        }
        const row = scoped.get(...params, cursor);
        if (!row) return undefined;
        after = Number(row.sequence);
      }
      const all = db.prepare(`
        SELECT id, memberCount, createdAt FROM evidence_digests
        WHERE caseId = ? AND runId = ? AND evidenceRevision = ? AND sequence < ?
          AND id NOT IN (SELECT value FROM json_each(?))
        ORDER BY sequence DESC LIMIT ?
      `).all(...params, after, JSON.stringify(exclude), limit + 1);
      const rows = all.slice(0, limit);
      return {
        digests: rows.map((row) => summary(scope, row)),
        nextCursor: all.length > limit ? String(rows.at(-1)!.id) : null,
      };
    },

    expand(
      rawScope: SentinelEvidenceDigestScope,
      digestId: string,
      limit = 10,
      cursor?: string,
    ) {
      const scope = scopeFor(rawScope);
      if (
        !scope || typeof digestId !== "string" ||
        !digestPattern.test(digestId) ||
        !validLimit(limit)
      ) return undefined;
      let offset = 0;
      if (cursor !== undefined) {
        if (typeof cursor !== "string" || !cursor.startsWith(`${digestId}:`)) {
          return undefined;
        }
        const index = cursor.slice(digestId.length + 1);
        if (!/^[1-9][0-9]{0,2}$/.test(index)) return undefined;
        offset = Number(index);
      }
      const row = scoped.get(...scopeParams(scope), digestId);
      if (!row) return undefined;
      const members = normalizeSentinelEvidenceDigestMembers(
        JSON.parse(String(row.members)),
      );
      if (
        !members || idFor(scope, members) !== digestId ||
        Number(row.memberCount) !== members.length || offset >= members.length
      ) return undefined;
      const page = members.slice(offset, offset + limit);
      const next = offset + page.length;
      return {
        digest: summary(scope, row),
        members: page,
        nextCursor: next < members.length ? `${digestId}:${next}` : null,
      };
    },

    close: () => db.close(),
  };
}

export const sentinelArchivedDigestFile = "sentinel-archived-digests.json";
const maxCatalogBytes = 16 * 1024 * 1024;
const maxCatalogEntries = 4096;

function checkedCatalogEntry(raw: unknown) {
  const entry = raw as { digest: SentinelEvidenceDigest; members: unknown };
  const digest = entry?.digest;
  const scope = scopeFor(digest?.scope);
  const members = normalizeSentinelEvidenceDigestMembers(entry?.members);
  if (
    !scope || !members || digest.id !== idFor(scope, members) ||
    digest.memberCount !== members.length ||
    typeof digest.createdAt !== "string" ||
    !Number.isFinite(Date.parse(digest.createdAt)) ||
    new Date(digest.createdAt).toISOString() !== digest.createdAt ||
    !isDeepStrictEqual(entry, {
      digest: {
        id: digest.id,
        scope,
        memberCount: members.length,
        createdAt: digest.createdAt,
      },
      members,
    }) || redactCredentialText(JSON.stringify(entry)) !== JSON.stringify(entry)
  ) throw new Error("Invalid archived Sentinel evidence digest.");
  return { digest: { ...digest, scope }, members };
}

export function readSentinelArchivedDigestCatalog(
  file: string,
  identity: { caseId: string; runId?: string },
  revisions?: readonly number[],
) {
  let info: Deno.FileInfo;
  try {
    info = Deno.lstatSync(file);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  if (
    !info.isFile || info.isSymlink || info.size > maxCatalogBytes ||
    (info.mode !== null && (info.mode & 0o077) !== 0)
  ) {
    throw new Error("Invalid archived Sentinel digest catalog file.");
  }
  const value = JSON.parse(Deno.readTextFileSync(file));
  if (!Array.isArray(value) || value.length > maxCatalogEntries) {
    throw new Error("Invalid archived Sentinel digest catalog.");
  }
  const entries = value.map(checkedCatalogEntry);
  if (
    new Set(entries.map(({ digest }) => digest.id)).size !== entries.length ||
    entries.some(({ digest: { scope } }) =>
      scope.caseId !== identity.caseId ||
      (identity.runId !== undefined && scope.runId !== identity.runId) ||
      (revisions && !revisions.includes(scope.evidenceRevision))
    )
  ) {
    throw new Error(
      "Archived Sentinel digest catalog contains an invalid scope.",
    );
  }
  return entries;
}

export function stageSentinelArchivedDigestCatalog(
  baseDir: string,
  casePath: string,
  directory: string,
  identity: { caseId: string; runId: string },
  revisions: readonly number[],
) {
  const archived = readSentinelArchivedDigestCatalog(
    join(dirname(casePath), sentinelArchivedDigestFile),
    { caseId: identity.caseId },
  ).filter(({ digest: { scope } }) =>
    scope.runId === identity.runId && revisions.includes(scope.evidenceRevision)
  );
  const entries = new Map(archived.map((entry) => [entry.digest.id, entry]));
  const live = [];
  try {
    Deno.lstatSync(join(baseDir, "data", "sentinel-evidence-digests.db"));
    const store = openSentinelEvidenceDigests(baseDir);
    const archivedIds = [...entries.keys()];
    try {
      for (const evidenceRevision of revisions) {
        for (
          const entry of store.exportScope(
            { ...identity, evidenceRevision },
            maxCatalogEntries - entries.size - live.length,
            archivedIds,
          )
        ) {
          live.push(entry);
        }
      }
    } finally {
      store.close();
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (!live.length && !archived.length) return;
  const text = JSON.stringify([...live, ...archived]);
  if (new TextEncoder().encode(text).length > maxCatalogBytes) {
    throw new Error("Archived Sentinel digest catalog exceeds its size limit.");
  }
  const sourcePath = join(directory, sentinelArchivedDigestFile);
  Deno.writeTextFileSync(sourcePath, text, { mode: 0o600, createNew: true });
  return { name: sentinelArchivedDigestFile, sourcePath };
}

export function expandArchivedSentinelEvidenceDigest(
  entry: ReturnType<typeof checkedCatalogEntry>,
  limit: number,
  cursor?: string,
) {
  const { digest, members } = entry;
  const suffix = cursor?.slice(digest.id.length + 1);
  if (
    cursor !== undefined && (!cursor.startsWith(digest.id + ":") ||
      !suffix || !/^[1-9][0-9]{0,2}$/.test(suffix))
  ) return;
  const offset = Number(suffix ?? 0);
  if (offset >= members.length) return;
  const page = members.slice(offset, offset + limit);
  const next = offset + page.length;
  return {
    digest,
    members: page,
    nextCursor: next < members.length ? `${digest.id}:${next}` : null,
  };
}

/** Preserve compact reopenable references outside the planner's inline inventory. */
export function recordSentinelColdInventoryDigests(
  baseDir: string,
  scope: SentinelEvidenceDigestScope,
  nodes: readonly {
    readonly id: string;
    readonly kind: "asset" | "finding" | "evidence" | "control";
    readonly label: string;
  }[],
  inlineIds: ReadonlySet<string>,
) {
  const members = nodes.flatMap(({ id, kind, label }) =>
    inlineIds.has(id) ? [] : normalizeSentinelEvidenceDigestMembers([{
      id: `${kind}:${id}`,
      kind,
      label: label.replace(/\s+/g, " ").trim().slice(0, 240),
    }]) ?? []
  );
  return recordSentinelColdDigests(baseDir, scope, members);
}

export function recordSentinelColdDigests(
  baseDir: string,
  scope: SentinelEvidenceDigestScope,
  references: readonly SentinelEvidenceDigestMember[],
) {
  if (!references.length) return [];
  const members = references.toSorted((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  const store = openSentinelEvidenceDigests(baseDir);
  try {
    const groups: SentinelEvidenceDigestMember[][] = [];
    for (let start = 0; start < members.length; start += 64) {
      groups.push(members.slice(start, start + 64));
    }
    return store.recordBatch(scope, groups);
  } finally {
    store.close();
  }
}

/** Validate a bounded digest result before retaining it in a planner journal. */
export function readSentinelPlannerDigestResult(
  tool: string,
  args: Record<string, unknown>,
  text: string,
  scope?: SentinelEvidenceDigestScope,
) {
  const expand = tool === "sentinel_expand_evidence_digest";
  if (
    (!expand && tool !== "sentinel_list_evidence_digests") ||
    !args || typeof args !== "object" || Array.isArray(args) ||
    typeof text !== "string" || text.length > 7000 ||
    redactCredentialText(text) !== text
  ) return;
  const { revision, digestId, cursor, limit = 3 } = args;
  if (
    Object.keys(args).some((key) =>
      !["revision", "cursor", "limit", ...(expand ? ["digestId"] : [])]
        .includes(key)
    ) || typeof revision !== "number" || !Number.isSafeInteger(revision) ||
    revision < 1 ||
    typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
    limit > 10 ||
    (expand &&
      (typeof digestId !== "string" || !digestPattern.test(digestId))) ||
    (cursor !== undefined && (typeof cursor !== "string" ||
      (expand
        ? !cursor.startsWith(`${digestId}:`) ||
          !/^[1-9][0-9]{0,2}$/.test(cursor.slice(String(digestId).length + 1))
        : !digestPattern.test(cursor))))
  ) return;
  try {
    const value = JSON.parse(text);
    const { run, page } = value;
    if (
      Object.keys(value).length !== 4 || value._classification !== "INTERNAL" ||
      value.evidenceRevision !== revision || run?.kind !== "sentinel" ||
      !isSentinelCaseId(run?.id) || run.revision !== revision ||
      Object.keys(run).length !== 3 || !page ||
      (scope &&
        (scope.caseId !== run.id || scope.evidenceRevision !== revision))
    ) return;
    const summaryMatches = (summary: SentinelEvidenceDigest) => {
      const binding = scopeFor(summary?.scope);
      return binding && binding.caseId === run.id &&
        binding.evidenceRevision === revision &&
        (!scope || scope.runId === binding.runId) &&
        Object.keys(summary.scope).length === 3 &&
        Object.keys(summary).length === 4 &&
        typeof summary.id === "string" && digestPattern.test(summary.id) &&
        Number.isSafeInteger(summary.memberCount) && summary.memberCount > 0 &&
        summary.memberCount <= MAX_SENTINEL_EVIDENCE_DIGEST_MEMBERS &&
        typeof summary.createdAt === "string" &&
        Number.isFinite(Date.parse(summary.createdAt));
    };
    if (expand) {
      const members = normalizeSentinelEvidenceDigestMembers(page.members);
      const start = typeof cursor === "string"
        ? Number(cursor.slice(String(digestId).length + 1))
        : 0;
      if (
        !summaryMatches(page.digest) || page.digest.id !== digestId ||
        !members ||
        !isDeepStrictEqual(members, page.members) || members.length > limit ||
        members.length !== Math.min(limit, page.digest.memberCount - start) ||
        page.nextCursor !==
          (start + members.length < page.digest.memberCount
            ? `${digestId}:${start + members.length}`
            : null) ||
        Object.keys(page).length !== 3
      ) return;
    } else if (
      Object.keys(page).length !== 2 || !Array.isArray(page.digests) ||
      page.digests.length > limit || !page.digests.every(summaryMatches) ||
      (page.nextCursor !== null &&
        (page.digests.length !== limit ||
          page.nextCursor !== page.digests.at(-1)?.id))
    ) return;
    return {
      revision,
      ...(digestId !== undefined && { digestId }),
      ...(args.limit !== undefined && { limit }),
      ...(cursor !== undefined && { cursor }),
    };
  } catch {
    return;
  }
}
