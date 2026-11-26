/** Shared owner run controls and immutable scoped evidence links. */
/// <reference path="./sqlite_types.d.ts" />

import { dirname, resolve } from "@std/path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  CLASSIFICATION_ORDER,
  type ClassificationLevel,
} from "./types/classification.ts";

export type OperatorRunKind =
  | "sentinel"
  | "workflow"
  | "delegated"
  | "scheduled";

function validRunKind(kind: unknown): kind is OperatorRunKind {
  return kind === "sentinel" || kind === "workflow" ||
    kind === "delegated" || kind === "scheduled";
}

export interface OperatorRunRef {
  readonly kind: OperatorRunKind;
  readonly id: string;
  readonly revision?: number;
}

export interface OperatorRunEvidenceRef {
  readonly source: string;
  readonly reference: string;
}

export interface OperatorRunSummary {
  readonly ref: OperatorRunRef;
  readonly label: string;
  readonly status: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly evidence?: readonly OperatorRunEvidenceRef[];
  readonly classification?: ClassificationLevel;
  readonly details?: Readonly<Record<string, unknown>>;
}

export const operatorRunMutations = [
  "start",
  "pause",
  "resume",
  "stop",
  "cancel",
  "steer",
  "hint",
] as const;
export type OperatorRunMutation = typeof operatorRunMutations[number];
export type OperatorRunAction =
  | "list"
  | "inspect"
  | "link"
  | OperatorRunMutation;
type MaybePromise<T> = T | Promise<T>;

export interface OperatorRunMutationContext {
  readonly requestId?: string;
  readonly note?: string;
  readonly taskId?: string;
  readonly expectedRunId?: string;
}

export interface OperatorRunProvider {
  list(): MaybePromise<readonly OperatorRunSummary[]>;
  inspect(ref: OperatorRunRef): MaybePromise<OperatorRunSummary | undefined>;
  readonly mutations?: Partial<
    Record<
      OperatorRunMutation,
      (
        ref: OperatorRunRef,
        context?: OperatorRunMutationContext,
      ) => MaybePromise<OperatorRunSummary | undefined>
    >
  >;
}

export interface OperatorRunBatchTarget {
  readonly ref: OperatorRunRef;
  readonly runId?: string;
}

export interface OperatorRunBatchItem extends OperatorRunBatchTarget {
  readonly status:
    | "approved"
    | "pending"
    | "applied"
    | "observed"
    | "unchanged"
    | "unavailable"
    | "stale";
  readonly resultRef?: OperatorRunRef;
}

export interface OperatorRunBatchRequest {
  readonly scope: string;
  readonly operatorId: string;
  readonly requestId: string;
  readonly action: "pause" | "resume";
  readonly targets: readonly OperatorRunBatchTarget[];
}

export interface OperatorRunBatchReceipt extends OperatorRunBatchRequest {
  readonly approvedAt: string;
  readonly items: readonly OperatorRunBatchItem[];
}

export interface OperatorRunLinkInput {
  readonly scope: string;
  readonly operatorId: string;
  readonly requestId: string;
  readonly origin?: "spawn";
  readonly left: OperatorRunRef;
  readonly right: OperatorRunRef;
}

export interface OperatorRunLink extends OperatorRunLinkInput {
  readonly id: string;
  readonly linkedAt: string;
}

export interface ArchivedOperatorRunLink {
  readonly link: OperatorRunLink;
  readonly requests: readonly { operatorId: string; requestId: string }[];
}

const MAX_LINKS = 4096;
const MAX_REQUESTS = 8192;
const MAX_LIST = 100;

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= max &&
    !Array.from(value).some((char) =>
      char.charCodeAt(0) < 32 || char === "\x7f"
    );
}

function canonicalRef(ref: OperatorRunRef): OperatorRunRef {
  if (
    !ref || !validRunKind(ref.kind) ||
    !bounded(ref.id, 256) ||
    (ref.revision !== undefined &&
      ((ref.kind === "delegated" || ref.kind === "scheduled") ||
        !Number.isSafeInteger(ref.revision) || ref.revision < 1))
  ) throw new Error("Invalid operator run reference");
  return {
    kind: ref.kind,
    id: ref.id,
    ...(ref.revision !== undefined && { revision: ref.revision }),
  };
}

function refKey(ref: OperatorRunRef): string {
  return JSON.stringify([ref.kind, ref.id, ref.revision ?? null]);
}

function canonicalDetails(details: Readonly<Record<string, unknown>>) {
  let budget = 16384;
  function visit(value: unknown, depth: number): unknown {
    if (--budget < 0 || depth > 6) {
      throw new Error("Operator run details limit exceeded");
    }
    if (
      value === null || typeof value === "boolean" || Number.isFinite(value)
    ) return value;
    if (typeof value === "string") {
      budget -= value.length;
      if (budget < 0 || value.length > 4096) {
        throw new Error("Operator run details limit exceeded");
      }
      return value;
    }
    if (Array.isArray(value) && value.length <= 128) {
      return value.map((entry) => visit(entry, depth + 1));
    }
    if (
      value &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null)
    ) {
      const entries = Object.entries(value);
      if (entries.length <= 128) {
        return Object.fromEntries(entries.map(([key, entry]) => {
          if (!bounded(key, 128)) {
            throw new Error("Invalid operator run detail key");
          }
          budget -= key.length;
          return [key, visit(entry, depth + 1)];
        }));
      }
    }
    throw new Error("Invalid operator run detail");
  }
  if (!details || Array.isArray(details) || typeof details !== "object") {
    throw new Error("Invalid operator run details");
  }
  return visit(details, 0) as Readonly<Record<string, unknown>>;
}

function canonicalSummary(
  summary: OperatorRunSummary,
  kind: OperatorRunKind,
): OperatorRunSummary {
  const ref = canonicalRef(summary.ref);
  if (
    ref.kind !== kind || !bounded(summary.label, 256) ||
    !bounded(summary.status, 80)
  ) {
    throw new Error("Invalid operator run summary");
  }
  const {
    label,
    status,
    startedAt,
    completedAt,
    evidence,
    details,
    classification,
  } = summary;
  if (
    classification !== undefined &&
    !Object.hasOwn(CLASSIFICATION_ORDER, classification)
  ) {
    throw new Error("Invalid operator run classification");
  }
  for (const value of [startedAt, completedAt]) {
    if (
      value !== undefined &&
      (!bounded(value, 40) || !Number.isFinite(Date.parse(value)))
    ) {
      throw new Error("Invalid operator run summary timestamp");
    }
  }
  if (
    evidence !== undefined && (!Array.isArray(evidence) || evidence.length > 32)
  ) {
    throw new Error("Invalid operator run evidence references");
  }
  return {
    ref,
    label,
    status,
    ...(classification !== undefined && { classification }),
    ...(details !== undefined && { details: canonicalDetails(details) }),
    ...(startedAt !== undefined && { startedAt }),
    ...(completedAt !== undefined && { completedAt }),
    ...(evidence !== undefined && {
      evidence: evidence.map(({ source, reference }) => {
        if (!bounded(source, 128) || !bounded(reference, 512)) {
          throw new Error("Invalid operator run evidence reference");
        }
        return { source, reference };
      }),
    }),
  };
}

function canonicalLink(input: OperatorRunLinkInput): OperatorRunLinkInput {
  const { scope, operatorId, requestId, origin } = input;
  if (
    !bounded(scope, 512) || !bounded(operatorId, 256) ||
    !bounded(requestId, 128) || (origin !== undefined && origin !== "spawn")
  ) {
    throw new Error("Invalid operator run link scope");
  }
  const left = canonicalRef(input.left);
  const right = canonicalRef(input.right);
  if (left.kind === right.kind && left.id === right.id) {
    throw new Error("An operator run link requires two distinct runs");
  }
  const ordered = refKey(left) < refKey(right);
  return {
    scope,
    operatorId,
    requestId,
    ...(origin && { origin }),
    left: ordered ? left : right,
    right: ordered ? right : left,
  };
}

function openPrivateDatabase(path: string): DatabaseSync {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  Deno.mkdirSync(parent, { mode: 0o700, recursive: true });
  const directory = Deno.lstatSync(parent);
  if (
    !directory.isDirectory || directory.isSymlink ||
    (directory.mode !== null && (directory.mode & 0o022) !== 0)
  ) {
    throw new Error(
      "Operator run links require an operator-controlled directory",
    );
  }
  try {
    Deno.openSync(absolute, { createNew: true, write: true, mode: 0o600 })
      .close();
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  const info = Deno.lstatSync(absolute);
  if (
    !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
    (info.mode !== null && (info.mode & 0o077) !== 0)
  ) {
    throw new Error(
      "Operator run links require a private regular database file",
    );
  }
  return new DatabaseSync(absolute);
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

type Row = NonNullable<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>>;

function decode(row: Row): OperatorRunLink {
  return {
    id: String(row.id),
    ...canonicalLink(JSON.parse(String(row.record))),
    linkedAt: new Date(Number(row.linkedAt)).toISOString(),
  };
}

/** Attach the private link journal for a cross-database rollback transaction. */
export function withOperatorRunLinks<T>(
  db: DatabaseSync,
  path: string | undefined,
  operation: () => T,
): T {
  if (!path) return operation();
  db.prepare("ATTACH DATABASE ? AS run_links").run(path);
  try {
    if (
      db.prepare("PRAGMA main.journal_mode").get()?.journal_mode !== "delete" ||
      db.prepare("PRAGMA run_links.journal_mode").get()?.journal_mode !==
        "delete"
    ) {
      throw new Error("Linked run admission requires rollback journals");
    }
    return operation();
  } finally {
    db.exec("DETACH DATABASE run_links");
  }
}

/** Persist one approved link inside the caller's transaction. */
export function recordOperatorRunLink(
  db: DatabaseSync,
  raw: OperatorRunLinkInput,
  schema: "main" | "run_links",
  now = Date.now,
): OperatorRunLink {
  const input = canonicalLink(raw);
  const { scope, operatorId, requestId, left, right } = input;
  const leftRef = refKey(left);
  const rightRef = refKey(right);
  const id = "run-link:" + createHash("sha256")
    .update(JSON.stringify([scope, leftRef, rightRef])).digest("hex");
  const existingRequest = db.prepare(
    `SELECT linkId FROM ${schema}.link_requests WHERE scope = ? AND operatorId = ? AND requestId = ?`,
  ).get(scope, operatorId, requestId);
  if (existingRequest && existingRequest.linkId !== id) {
    throw new Error("Conflicting operator run link request ID");
  }
  const existing = db.prepare(`SELECT * FROM ${schema}.links WHERE id = ?`).get(
    id,
  );
  if (!existingRequest) {
    if (
      Number(
        db.prepare(`SELECT COUNT(*) AS n FROM ${schema}.link_requests`).get()
          ?.n,
      ) >= MAX_REQUESTS
    ) {
      throw new Error("Operator run link request limit reached");
    }
    if (!existing) {
      if (
        Number(
          db.prepare(`SELECT COUNT(*) AS n FROM ${schema}.links`).get()?.n,
        ) >=
          MAX_LINKS
      ) {
        throw new Error("Operator run link limit reached");
      }
      const linkedAt = now();
      db.prepare(`INSERT INTO ${schema}.links VALUES (?, ?, ?, ?, ?, ?)`).run(
        id,
        scope,
        leftRef,
        rightRef,
        JSON.stringify(input),
        linkedAt,
      );
    }
    db.prepare(`INSERT INTO ${schema}.link_requests VALUES (?, ?, ?, ?)`).run(
      scope,
      operatorId,
      requestId,
      id,
    );
  }
  return decode(
    existing ??
      db.prepare(`SELECT * FROM ${schema}.links WHERE id = ?`).get(id)!,
  );
}

/** Restore only edges incident to the archived run inside the caller's transaction. */
export function restoreOperatorRunLinks(
  db: DatabaseSync,
  ref: OperatorRunRef,
  archived: readonly ArchivedOperatorRunLink[],
  schema: "main" | "run_links" = "run_links",
) {
  if (!Array.isArray(archived) || archived.length > MAX_LINKS) {
    throw new Error("Invalid archived run links");
  }
  const key = refKey(canonicalRef(ref));
  for (const { link, requests } of [...archived].reverse()) {
    const at = Date.parse(link.linkedAt);
    if (
      link.scope !== "workspace-operator" ||
      (refKey(link.left) !== key && refKey(link.right) !== key) ||
      !Number.isFinite(at) || !Array.isArray(requests) ||
      requests.length > MAX_REQUESTS
    ) throw new Error("Invalid archived run link");
    const restored = recordOperatorRunLink(db, link, schema, () => at);
    if (JSON.stringify(restored) !== JSON.stringify(link)) {
      throw new Error("Archived run link collision");
    }
    for (const { operatorId, requestId } of requests) {
      recordOperatorRunLink(
        db,
        { ...link, operatorId, requestId },
        schema,
      );
    }
  }
}

/** Durable link journal. Callers must check link approval and both runs' access. */
export function openOperatorRunLinkStore(path: string, now = Date.now) {
  const db = openPrivateDatabase(path);
  const applicationId = 0x4f52554e;
  try {
    db.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON",
    );
    transaction(db, () => {
      const current = db.prepare("PRAGMA application_id").get()?.application_id;
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (current === applicationId && version === 1) return;
      if (
        current !== 0 || version !== 0 ||
        db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
      ) {
        throw new Error("Invalid operator run link database or version");
      }
      db.exec(`
        CREATE TABLE links (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          leftRef TEXT NOT NULL,
          rightRef TEXT NOT NULL,
          record TEXT NOT NULL,
          linkedAt INTEGER NOT NULL
        );
        CREATE INDEX links_by_scope ON links(scope);
        CREATE TABLE link_requests (
          scope TEXT NOT NULL,
          operatorId TEXT NOT NULL,
          requestId TEXT NOT NULL,
          linkId TEXT NOT NULL REFERENCES links(id),
          PRIMARY KEY (scope, operatorId, requestId)
        );
        PRAGMA application_id = ${applicationId};
        PRAGMA user_version = 1;
      `);
    });
  } catch (error) {
    db.close();
    throw error;
  }
  function readBatch(
    request: OperatorRunBatchRequest,
  ): OperatorRunBatchReceipt | undefined {
    if (
      !db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'run_control_batches'",
      ).get()
    ) return;
    const row = db.prepare(
      "SELECT record FROM run_control_batches WHERE scope = ? AND operatorId = ? AND requestId = ?",
    ).get(request.scope, request.operatorId, request.requestId);
    if (!row) return;
    const saved = JSON.parse(String(row.record)) as OperatorRunBatchReceipt;
    if (
      saved.action !== request.action ||
      JSON.stringify(saved.targets) !== JSON.stringify(request.targets)
    ) {
      throw new Error("Conflicting operator run control batch request");
    }
    return saved;
  }
  return {
    readBatch,
    approveBatch(
      request: OperatorRunBatchRequest,
      items: readonly OperatorRunBatchItem[],
    ) {
      return transaction(db, () => {
        const prior = readBatch(request);
        if (prior) return prior;
        db.exec(`CREATE TABLE IF NOT EXISTS run_control_batches (
          scope TEXT NOT NULL, operatorId TEXT NOT NULL, requestId TEXT NOT NULL, record TEXT NOT NULL,
          PRIMARY KEY (scope, operatorId, requestId)
        ) STRICT`);
        if (
          Number(
            db.prepare("SELECT COUNT(*) AS count FROM run_control_batches")
              .get()?.count,
          ) >= MAX_REQUESTS
        ) {
          throw new Error("Operator run control batch limit reached");
        }
        const receipt = {
          ...request,
          approvedAt: new Date(now()).toISOString(),
          items,
        };
        db.prepare("INSERT INTO run_control_batches VALUES (?, ?, ?, ?)").run(
          request.scope,
          request.operatorId,
          request.requestId,
          JSON.stringify(receipt),
        );
        return receipt;
      });
    },
    updateBatchItem(
      request: OperatorRunBatchRequest,
      index: number,
      expected: "approved" | "pending",
      status: "pending" | "applied" | "observed" | "stale",
      resultRef?: OperatorRunRef,
    ) {
      return transaction(db, () => {
        const prior = readBatch(request);
        if (!prior || prior.items[index]?.status !== expected) return false;
        const items = prior.items.map((item, i) =>
          i === index
            ? { ...item, status, ...(resultRef && { resultRef }) }
            : item
        );
        return Number(
          db.prepare(
            "UPDATE run_control_batches SET record = ? WHERE scope = ? AND operatorId = ? AND requestId = ?",
          ).run(
            JSON.stringify({ ...prior, items }),
            request.scope,
            request.operatorId,
            request.requestId,
          ).changes,
        ) === 1;
      });
    },
    record(raw: OperatorRunLinkInput): OperatorRunLink {
      return transaction(db, () => recordOperatorRunLink(db, raw, "main", now));
    },
    list(scope: string, ref?: OperatorRunRef): readonly OperatorRunLink[] {
      if (!bounded(scope, 512)) {
        throw new Error("Invalid operator run link scope");
      }
      const key = ref === undefined ? undefined : refKey(canonicalRef(ref));
      const rows = key === undefined
        ? db.prepare("SELECT * FROM links WHERE scope = ? ORDER BY rowid DESC")
          .all(scope)
        : db.prepare(
          "SELECT * FROM links WHERE scope = ? AND (leftRef = ? OR rightRef = ?) ORDER BY rowid DESC",
        )
          .all(scope, key, key);
      return rows.map(decode);
    },
    installWithArchive(
      groups: readonly {
        ref: OperatorRunRef;
        links: readonly ArchivedOperatorRunLink[];
      }[],
      install: () => void,
    ) {
      transaction(db, () => {
        for (const { ref, links } of groups) {
          restoreOperatorRunLinks(db, ref, links, "main");
        }
        install();
      });
    },
    archive(
      scope: string,
      ref: OperatorRunRef,
    ): readonly ArchivedOperatorRunLink[] {
      const key = refKey(canonicalRef(ref));
      return transaction(db, () =>
        db.prepare(
          "SELECT * FROM links WHERE scope = ? AND (leftRef = ? OR rightRef = ?) ORDER BY rowid DESC",
        ).all(scope, key, key).map((row) => {
          const link = decode(row);
          const requests = db.prepare(
            "SELECT operatorId, requestId FROM link_requests WHERE scope = ? AND linkId = ? ORDER BY rowid",
          ).all(scope, link.id).map(({ operatorId, requestId }) => ({
            operatorId: String(operatorId),
            requestId: String(requestId),
          }));
          return { link, requests };
        }));
    },
    readRequest(scope: string, operatorId: string, requestId: string) {
      if (
        !bounded(scope, 512) || !bounded(operatorId, 256) ||
        !bounded(requestId, 128)
      ) {
        throw new Error("Invalid operator run link scope");
      }
      const row = db.prepare(`
        SELECT links.* FROM link_requests JOIN links ON links.id = link_requests.linkId
        WHERE link_requests.scope = ? AND link_requests.operatorId = ? AND link_requests.requestId = ?
      `).get(scope, operatorId, requestId);
      return row && decode(row);
    },
    close(): void {
      db.close();
    },
  };
}

export interface OperatorRunControllerOptions {
  readonly scope: string;
  readonly operatorId: string;
  readonly providers: Partial<Record<OperatorRunKind, OperatorRunProvider>>;
  readonly authorize: (
    action: OperatorRunAction,
    ref: OperatorRunRef,
  ) => MaybePromise<boolean>;
  readonly links?: ReturnType<typeof openOperatorRunLinkStore>;
  readonly approveLink?: (input: OperatorRunLinkInput) => MaybePromise<boolean>;
}

/** Keep direct provider authorization independent from any stored cross-run link. */
export class OperatorRunController {
  constructor(private readonly options: OperatorRunControllerOptions) {
    if (!bounded(options.scope, 512) || !bounded(options.operatorId, 256)) {
      throw new Error("Invalid operator run controller scope");
    }
  }

  async list(kind?: OperatorRunKind): Promise<readonly OperatorRunSummary[]> {
    if (kind !== undefined && !validRunKind(kind)) {
      throw new Error("Invalid operator run kind");
    }
    const selected: readonly OperatorRunKind[] = kind
      ? [kind]
      : ["sentinel", "workflow"];
    const results: OperatorRunSummary[] = [];
    for (const key of selected) {
      const summaries = await this.options.providers[key]?.list() ?? [];
      for (const summary of summaries.slice(0, MAX_LIST)) {
        const ref = canonicalRef(summary.ref);
        if (ref.kind !== key || !await this.options.authorize("list", ref)) {
          continue;
        }
        results.push(canonicalSummary(summary, key));
      }
    }
    return results.slice(0, MAX_LIST);
  }

  async inspect(raw: OperatorRunRef): Promise<OperatorRunSummary | undefined> {
    const ref = canonicalRef(raw);
    if (!await this.options.authorize("inspect", ref)) return undefined;
    const summary = await this.options.providers[ref.kind]?.inspect(ref);
    if (!summary) return undefined;
    const canonical = canonicalSummary(summary, ref.kind);
    if (
      canonical.ref.id !== ref.id ||
      (ref.revision !== undefined && ref.revision !== canonical.ref.revision)
    ) throw new Error("Operator run provider returned a different run");
    if (
      refKey(ref) !== refKey(canonical.ref) &&
      !await this.options.authorize("inspect", canonical.ref)
    ) return undefined;
    return canonical;
  }

  async mutate(
    action: OperatorRunMutation,
    raw: OperatorRunRef,
    context?: OperatorRunMutationContext,
  ): Promise<OperatorRunSummary | undefined> {
    if (!operatorRunMutations.includes(action)) {
      throw new Error("Invalid operator run mutation");
    }
    const ref = canonicalRef(raw);
    if (!await this.options.authorize(action, ref)) return undefined;
    const mutate = this.options.providers[ref.kind]?.mutations?.[action];
    if (!mutate) return undefined;
    const { requestId, note, taskId, expectedRunId } = context ?? {};
    if (
      (requestId !== undefined && !bounded(requestId, 128)) ||
      (note !== undefined && !bounded(note, 4096)) ||
      (taskId !== undefined && !bounded(taskId, 256)) ||
      (expectedRunId !== undefined && !bounded(expectedRunId, 128))
    ) throw new Error("Invalid operator run mutation context");
    // Starts target a configured plan ID. All other actions target an existing run.
    const exact = action === "start" ? ref : (await this.inspect(ref))?.ref;
    if (
      !exact ||
      (refKey(exact) !== refKey(ref) &&
        !await this.options.authorize(action, exact))
    ) return undefined;
    const result = await mutate(
      exact,
      context === undefined ? undefined : {
        requestId,
        note,
        taskId,
        ...(expectedRunId !== undefined && { expectedRunId }),
      },
    );
    if (!result) return undefined;
    const canonical = canonicalSummary(result, ref.kind);
    if (action !== "start" && canonical.ref.id !== ref.id) {
      throw new Error("Operator run mutation returned a different run");
    }
    return await this.options.authorize("inspect", canonical.ref)
      ? canonical
      : undefined;
  }

  async link(
    request: Pick<OperatorRunLinkInput, "requestId" | "left" | "right">,
  ): Promise<OperatorRunLink | undefined> {
    const { scope, operatorId, links, approveLink } = this.options;
    if (!links || !approveLink) return undefined;
    const requested = canonicalLink({ ...request, scope, operatorId });
    const [left, right] = await Promise.all([
      this.inspect(requested.left),
      this.inspect(requested.right),
    ]);
    if (!left || !right) return undefined;
    const input = canonicalLink({
      ...requested,
      left: left.ref,
      right: right.ref,
    });
    if (
      !await this.options.authorize("link", input.left) ||
      !await this.options.authorize("link", input.right)
    ) return undefined;
    const prior = links.readRequest(scope, operatorId, input.requestId);
    if (prior) {
      if (
        refKey(prior.left) !== refKey(input.left) ||
        refKey(prior.right) !== refKey(input.right)
      ) {
        throw new Error("Conflicting operator run link request ID");
      }
      return prior;
    }
    if (!await approveLink(input)) return undefined;
    if (
      !await this.options.authorize("link", input.left) ||
      !await this.options.authorize("link", input.right) ||
      !await this.inspect(input.left) || !await this.inspect(input.right)
    ) return undefined;
    return links.record(input);
  }

  async listLinks(ref?: OperatorRunRef): Promise<readonly OperatorRunLink[]> {
    if (!this.options.links) return [];
    const exact = ref === undefined
      ? undefined
      : (await this.inspect(ref))?.ref;
    if (ref !== undefined && exact === undefined) return [];
    const visible: OperatorRunLink[] = [];
    for (const link of this.options.links.list(this.options.scope, exact)) {
      if (
        await this.options.authorize("link", link.left) &&
        await this.options.authorize("link", link.right) &&
        await this.inspect(link.left) && await this.inspect(link.right)
      ) visible.push(link);
      if (visible.length >= MAX_LIST) break;
    }
    return visible;
  }
}
