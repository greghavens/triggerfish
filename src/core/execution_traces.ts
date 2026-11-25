import type { WorkerBoundary } from "./types/orchestrator.ts";
import {
  assignmentRecoveryKey,
  createAssignmentControlJournal,
} from "./durable_assignment.ts";
/** Shared durable traces for explicitly admitted agent executions. */
/// <reference path="./sqlite_types.d.ts" />

import { dirname, resolve } from "@std/path";
import { createHash } from "node:crypto";
import {
  restoreRunArchiveOnce,
  type RunArchiveRestoreKey,
} from "./run_archive_actions.ts";
import { DatabaseSync } from "node:sqlite";
import {
  type ArchivedOperatorRunLink,
  restoreOperatorRunLinks,
  withOperatorRunLinks,
} from "./operator_runs.ts";
import { executionTraceSourceVisible } from "./team_delivery_trace_source.ts";
import { redactCredentialText } from "./logger/redactor.ts";
import {
  AgentRecoveryStore,
  type FinishedAgentRecoveryRecord,
  installFinishedRecovery,
  installPausedRecovery,
  isPausedBeforeFirstAction,
  type RecoverableState,
} from "./agent_recovery_store.ts";
import {
  canFlowTo,
  CLASSIFICATION_ORDER,
  type ClassificationLevel,
  maxClassification,
} from "./types/classification.ts";
import {
  type ArchivedExecutionChecklist,
  archiveExecutionChecklist,
  createExecutionChecklistStorage,
  ensureExecutionChecklists,
  type ExecutionChecklistScope,
  installExecutionChecklist,
  validExecutionChecklist,
} from "./execution_checklists.ts";
import type { StorageProvider } from "./storage/provider.ts";

export type ExecutionTraceRole = "delegated" | "scheduled" | "owner_chat";
export type ExecutionTraceOutcome = "returned" | "blocked" | "failed";
export type ExecutionTraceTerminalStatus =
  | "completed"
  | "failed"
  | "interrupted";

export interface ExecutionTraceScope {
  readonly role: ExecutionTraceRole;
  readonly runId: string;
  readonly sessionId: string;
  readonly sourceId?: string;
  readonly classification?: ClassificationLevel;
}

export interface ExecutionTraceStep {
  readonly ordinal: number;
  readonly tool: string;
  readonly classification: ClassificationLevel;
  readonly outcome: ExecutionTraceOutcome;
}

/** Canonical, explicitly approved read projection. */
interface ActionsStatusPayload {
  readonly kind: "github_actions_status";
  readonly repo: string;
  readonly repositoryId: number;
  readonly workflow?: string;
  readonly perPage?: number;
  readonly runs: readonly {
    readonly id: number;
    readonly status: string;
    readonly conclusion: string | null;
    readonly created_at?: string;
  }[];
}

export type ExecutionTraceApprovedPayload = ActionsStatusPayload | {
  readonly kind: "github_actions_run_status";
  readonly repo: string;
  readonly repositoryId: number;
  readonly id: number;
  readonly attempt: number;
  readonly status: string;
  readonly conclusion: string | null;
} | {
  readonly kind: "github_repository_status";
  readonly repo: string;
  readonly repositoryId: number;
  readonly visibility: "public" | "internal" | "private";
} | {
  readonly kind: "github_pull_status";
  readonly repo: string;
  readonly repositoryId: number;
  readonly number: number;
  readonly state: "open" | "closed";
  readonly mergeable: boolean | null;
} | {
  readonly kind: "github_release_status";
  readonly repo: string;
  readonly repositoryId: number;
  readonly perPage?: number;
  readonly releases: readonly {
    readonly id: number;
    readonly prerelease: boolean;
    readonly published_at: string;
  }[];
} | {
  readonly kind: "github_branch_protection";
  readonly repo: string;
  readonly repositoryId: number;
  readonly perPage?: number;
  readonly protectedCount: number;
  readonly unprotectedCount: number;
  readonly approvedBranches?: readonly {
    readonly name: string;
    readonly protected: boolean;
  }[];
};

export function executionTracePayloadCall(
  payload: ExecutionTraceApprovedPayload,
) {
  if (payload.kind === "github_actions_run_status") {
    return {
      name: "github_actions",
      args: {
        action: "get_run",
        repo: payload.repo,
        run_id: payload.id,
        attempt: payload.attempt,
      },
    };
  }
  if (payload.kind === "github_branch_protection") {
    return {
      name: "github_repos",
      args: {
        action: "list_branches",
        repo: payload.repo,
        ...(payload.perPage !== undefined && { per_page: payload.perPage }),
      },
    };
  }
  if (payload.kind === "github_release_status") {
    return {
      name: "github_repos",
      args: {
        action: "list_releases",
        repo: payload.repo,
        ...(payload.perPage !== undefined && { per_page: payload.perPage }),
      },
    };
  }
  if (payload.kind === "github_pull_status") {
    return {
      name: "github_pulls",
      args: { action: "get", repo: payload.repo, pr_number: payload.number },
    };
  }
  return payload.kind === "github_repository_status"
    ? { name: "github_repos", args: { action: "get", repo: payload.repo } }
    : {
      name: "github_actions",
      args: {
        action: "list_runs",
        repo: payload.repo,
        ...(payload.workflow !== undefined && { workflow: payload.workflow }),
        ...(payload.perPage !== undefined && { per_page: payload.perPage }),
      },
    };
}

export interface ExecutionTraceRun {
  readonly scope: ExecutionTraceScope;
  readonly classification: ClassificationLevel;
  readonly admittedAt: string;
  readonly status: "running" | ExecutionTraceTerminalStatus;
  readonly finishedAt?: string;
  readonly operatorCancelled?: true;
}

/** Canonical source response used to reapply response policy to a saved projection. */
export function executionTracePayloadResponse(
  payload: ExecutionTraceApprovedPayload,
): string {
  return JSON.stringify(
    payload.kind === "github_actions_status"
      ? { runs: payload.runs, repositoryId: payload.repositoryId }
      : payload.kind === "github_actions_run_status"
      ? {
        id: payload.id,
        repositoryId: payload.repositoryId,
        attempt: payload.attempt,
        status: payload.status,
        conclusion: payload.conclusion,
      }
      : payload.kind === "github_branch_protection"
      ? {
        repositoryId: payload.repositoryId,
        protectedCount: payload.protectedCount,
        unprotectedCount: payload.unprotectedCount,
        ...(payload.approvedBranches &&
          { approvedBranches: payload.approvedBranches }),
      }
      : payload.kind === "github_release_status"
      ? { repositoryId: payload.repositoryId, releases: payload.releases }
      : payload.kind === "github_pull_status"
      ? {
        number: payload.number,
        repositoryId: payload.repositoryId,
        state: payload.state,
        mergeable: payload.mergeable,
      }
      : {
        name: payload.repo,
        repositoryId: payload.repositoryId,
        visibility: payload.visibility,
      },
  );
}

export interface ExecutionTraceReceipt extends ExecutionTraceStep {
  readonly id: string;
  readonly scope: ExecutionTraceScope;
  readonly recordedAt: string;
}

export interface ExecutionTraceArchive {
  readonly run: ExecutionTraceRun;
  readonly finishLevel: number | null;
  readonly entries: readonly {
    readonly step: ExecutionTraceReceipt;
    readonly payload?: ExecutionTraceApprovedPayload;
  }[];
  readonly checklist?: ArchivedExecutionChecklist;
  readonly steering?: readonly ExecutionTraceSteering[];
}

interface ExecutionTraceSteering {
  readonly requestId: string;
  readonly note: string;
  readonly requestedAt: string;
  readonly appliedAt?: string;
}

function validArchivedSteering(
  value: unknown,
): value is ExecutionTraceSteering[] {
  return Array.isArray(value) && value.length <= 8 &&
    new Set(value.map((entry) => entry?.requestId)).size === value.length &&
    value.every((entry) =>
      entry && typeof entry === "object" &&
      Object.keys(entry).every((key) =>
        ["requestId", "note", "requestedAt", "appliedAt"].includes(key)
      ) &&
      typeof entry.requestId === "string" &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry.requestId) &&
      typeof entry.note === "string" && entry.note.trim() &&
      entry.note.length <= 1000 && !entry.note.includes("\0") &&
      redactCredentialText(entry.note) === entry.note &&
      typeof entry.requestedAt === "string" &&
      Number.isFinite(Date.parse(entry.requestedAt)) &&
      (entry.appliedAt === undefined ||
        (typeof entry.appliedAt === "string" &&
          Number.isFinite(Date.parse(entry.appliedAt))))
    );
}

const appId = 0x45545243;
const referencePattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const toolPattern = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const receiptPattern = /^execution-trace:[a-f0-9]{64}$/;
const runCursorPattern = /^execution-trace-run:[a-f0-9]{64}$/;
const maxPage = 50;
const maxArchivedSteps = 1000;
const repoPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
const workflowPattern = /^(?:[1-9][0-9]{0,11}|[a-zA-Z0-9_.-]{1,100}\.ya?ml)$/;
const workflowStatuses = new Set([
  "queued",
  "in_progress",
  "completed",
  "requested",
  "waiting",
  "pending",
]);
const workflowConclusions = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "success",
  "timed_out",
  "startup_failure",
]);

export function normalizePublishedRelease(
  row: { id?: unknown; prerelease?: unknown; published_at?: unknown },
) {
  if (
    !row || !Number.isSafeInteger(row.id) || (row.id as number) < 1 ||
    typeof row.prerelease !== "boolean" ||
    typeof row.published_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(row.published_at) ||
    !Number.isFinite(Date.parse(row.published_at))
  ) return;
  return {
    id: row.id as number,
    prerelease: row.prerelease,
    published_at: row.published_at,
  };
}

export function isApprovedHistoryBranchName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/.test(value) &&
    !value.includes("..") && !value.includes("//");
}

export function normalizeHistoryBranches(
  value: unknown,
  protectedCount: number,
  unprotectedCount: number,
) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return;
  const names = new Set<string>();
  const approved = [];
  for (const entry of value) {
    if (
      !entry || !isApprovedHistoryBranchName(entry.name) ||
      typeof entry.protected !== "boolean" || Object.keys(entry).length !== 2 ||
      names.has(entry.name)
    ) return;
    names.add(entry.name);
    approved.push({ name: entry.name, protected: entry.protected as boolean });
  }
  const count = approved.filter((entry) => entry.protected).length;
  return count <= protectedCount && approved.length - count <= unprotectedCount
    ? approved
    : undefined;
}

export function branchProtectionCountsValid(
  protectedCount: unknown,
  unprotectedCount: unknown,
  limit: number,
) {
  return typeof protectedCount === "number" &&
    Number.isSafeInteger(protectedCount) &&
    protectedCount >= 0 && typeof unprotectedCount === "number" &&
    Number.isSafeInteger(unprotectedCount) && unprotectedCount >= 0 &&
    protectedCount + unprotectedCount <= limit;
}

/** Normalize GitHub's UTC workflow creation timestamp for retained receipts. */
export function normalizeWorkflowRunCreatedAt(
  value: unknown,
): string | undefined {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) return;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return;
  const canonical = new Date(time).toISOString();
  return value === canonical || value === canonical.replace(".000Z", "Z")
    ? canonical
    : undefined;
}

export function normalizeApprovedPayload(
  raw: ExecutionTraceApprovedPayload,
): ExecutionTraceApprovedPayload | undefined {
  if (raw?.kind === "github_actions_run_status") {
    const { kind, repo, repositoryId, id, attempt, status, conclusion } = raw;
    if (
      typeof repo !== "string" || !repoPattern.test(repo) ||
      /\/(?:\.|\.\.)$/.test(repo) ||
      !Number.isSafeInteger(repositoryId) || repositoryId < 1 ||
      !Number.isSafeInteger(id) || id < 1 ||
      !Number.isSafeInteger(attempt) || attempt < 1 ||
      typeof status !== "string" || !/^[a-z_]{1,40}$/.test(status) ||
      (conclusion !== null &&
        (typeof conclusion !== "string" ||
          !/^[a-z_]{1,40}$/.test(conclusion))) ||
      Object.keys(raw).length !== 7
    ) return;
    return { kind, repo, repositoryId, id, attempt, status, conclusion };
  }
  if (raw?.kind === "github_branch_protection") {
    const { repo, repositoryId, perPage, protectedCount, unprotectedCount } =
      raw;
    const approvedBranches = normalizeHistoryBranches(
      raw.approvedBranches,
      protectedCount,
      unprotectedCount,
    );
    if (
      typeof repo !== "string" || !repoPattern.test(repo) ||
      /\/(?:\.|\.\.)$/.test(repo) ||
      !Number.isSafeInteger(repositoryId) || repositoryId < 1 ||
      (perPage !== undefined &&
        (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100)) ||
      !branchProtectionCountsValid(
        protectedCount,
        unprotectedCount,
        perPage ?? 30,
      ) ||
      (raw.approvedBranches !== undefined && !approvedBranches) ||
      Object.keys(raw).some((key) =>
        ![
          "kind",
          "repo",
          "repositoryId",
          "perPage",
          "protectedCount",
          "unprotectedCount",
          "approvedBranches",
        ].includes(key)
      )
    ) return;
    return {
      kind: raw.kind,
      repo,
      repositoryId,
      ...(perPage !== undefined && { perPage }),
      protectedCount,
      unprotectedCount,
      ...(approvedBranches && { approvedBranches }),
    };
  }
  if (raw?.kind === "github_release_status") {
    const { repo, repositoryId, perPage, releases } = raw;
    if (
      typeof repo !== "string" || !repoPattern.test(repo) ||
      /\/(?:\.|\.\.)$/.test(repo) ||
      !Number.isSafeInteger(repositoryId) || repositoryId < 1 ||
      (perPage !== undefined &&
        (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100)) ||
      !Array.isArray(releases) || releases.length > (perPage ?? 10) ||
      Object.keys(raw).some((key) =>
        !["kind", "repo", "repositoryId", "perPage", "releases"].includes(key)
      )
    ) return;
    const normalized = releases.map((row) =>
      row && Object.keys(row).length === 3
        ? normalizePublishedRelease(row)
        : undefined
    );
    if (normalized.some((row) => !row)) return;
    return {
      kind: raw.kind,
      repo,
      repositoryId,
      ...(perPage !== undefined && { perPage }),
      releases: normalized as typeof releases,
    };
  }
  if (raw?.kind === "github_pull_status") {
    const { repo, repositoryId, number, state, mergeable } = raw;
    if (
      typeof repo !== "string" || !repoPattern.test(repo) ||
      /\/(?:\.|\.\.)$/.test(repo) ||
      !Number.isSafeInteger(repositoryId) || repositoryId < 1 ||
      !Number.isSafeInteger(number) || number < 1 ||
      (state !== "open" && state !== "closed") ||
      (mergeable !== null && typeof mergeable !== "boolean") ||
      Object.keys(raw).length !== 6
    ) return;
    return { kind: raw.kind, repo, repositoryId, number, state, mergeable };
  }
  if (raw?.kind === "github_repository_status") {
    const { repo, repositoryId, visibility } = raw;
    if (
      typeof repo !== "string" || !repoPattern.test(repo) ||
      /\/(?:\.|\.\.)$/.test(repo) ||
      !Number.isSafeInteger(repositoryId) || repositoryId < 1 ||
      !["public", "internal", "private"].includes(visibility) ||
      Object.keys(raw).some((key) =>
        !["kind", "repo", "repositoryId", "visibility"].includes(key)
      )
    ) return undefined;
    return { kind: raw.kind, repo, repositoryId, visibility };
  }
  if (
    !raw || typeof raw !== "object" || raw.kind !== "github_actions_status" ||
    typeof raw.repo !== "string" || !repoPattern.test(raw.repo) ||
    /\/(?:\.|\.\.)$/.test(raw.repo) ||
    !Number.isSafeInteger(raw.repositoryId) || raw.repositoryId < 1 ||
    (raw.workflow !== undefined &&
      (typeof raw.workflow !== "string" ||
        !workflowPattern.test(raw.workflow))) ||
    (raw.perPage !== undefined &&
      (!Number.isSafeInteger(raw.perPage) || raw.perPage < 1 ||
        raw.perPage > 100)) ||
    !Array.isArray(raw.runs) || raw.runs.length > 100 ||
    Object.keys(raw).some((key) =>
      !["kind", "repo", "repositoryId", "workflow", "perPage", "runs"].includes(
        key,
      )
    )
  ) return;
  const runs: ActionsStatusPayload["runs"][number][] = [];
  for (const entry of raw.runs) {
    if (
      !entry || typeof entry !== "object" ||
      !Number.isSafeInteger(entry.id) || entry.id < 1 ||
      !workflowStatuses.has(entry.status) ||
      (entry.conclusion !== null &&
        !workflowConclusions.has(entry.conclusion)) ||
      !["id", "status", "conclusion"].every((key) =>
        Object.hasOwn(entry, key)
      ) ||
      Object.keys(entry).some((key) =>
        !["id", "status", "conclusion", "created_at"].includes(key)
      ) ||
      (Object.hasOwn(entry, "created_at") &&
        (!entry.created_at ||
          normalizeWorkflowRunCreatedAt(entry.created_at) !== entry.created_at))
    ) return;
    runs.push({
      id: entry.id,
      status: entry.status,
      conclusion: entry.conclusion,
      ...(entry.created_at && { created_at: entry.created_at }),
    });
  }
  return {
    kind: raw.kind,
    repo: raw.repo,
    repositoryId: raw.repositoryId,
    ...(raw.workflow !== undefined && { workflow: raw.workflow }),
    ...(raw.perPage !== undefined && { perPage: raw.perPage }),
    runs,
  };
}
type Row = NonNullable<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>>;

function roleOf(value: unknown): value is ExecutionTraceRole {
  return value === "delegated" || value === "scheduled" ||
    value === "owner_chat";
}

function levelOf(value: unknown): value is ClassificationLevel {
  return typeof value === "string" &&
    Object.hasOwn(CLASSIFICATION_ORDER, value);
}

function reference(value: unknown): value is string {
  return typeof value === "string" && referencePattern.test(value);
}

function normalizeScope(
  raw: ExecutionTraceScope,
): ExecutionTraceScope | undefined {
  if (!raw || typeof raw !== "object") return;
  const { role, runId, sessionId, sourceId, classification = "INTERNAL" } = raw;
  if (
    !roleOf(role) || !reference(runId) || !reference(sessionId) ||
    (sourceId !== undefined && !reference(sourceId)) ||
    !levelOf(classification) ||
    (role === "owner_chat" && (sourceId === undefined ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sourceId) ||
      runId !== assignmentRecoveryKey(sessionId, sourceId)))
  ) return;
  return {
    role,
    runId,
    sessionId,
    ...(sourceId !== undefined && { sourceId }),
    classification,
  };
}

function normalizeStep(
  raw: ExecutionTraceStep,
): ExecutionTraceStep | undefined {
  if (!raw || typeof raw !== "object") return;
  const { ordinal, tool, classification, outcome } = raw;
  if (
    !Number.isSafeInteger(ordinal) || ordinal < 1 ||
    typeof tool !== "string" || !toolPattern.test(tool) ||
    !levelOf(classification) ||
    (outcome !== "returned" && outcome !== "blocked" && outcome !== "failed")
  ) return;
  return { ordinal, tool, classification, outcome };
}

function hashId(prefix: string, input: unknown) {
  return `${prefix}:${
    createHash("sha256").update(JSON.stringify(input)).digest("hex")
  }`;
}

function privateDatabase(path: string) {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  Deno.mkdirSync(parent, { mode: 0o700, recursive: true });
  const dir = Deno.lstatSync(parent);
  if (!dir.isDirectory || dir.isSymlink || ((dir.mode ?? 0) & 0o022) !== 0) {
    throw new Error(
      "Execution traces require an operator-controlled directory.",
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
    ((info.mode ?? 0) & 0o077) !== 0
  ) {
    throw new Error("Execution traces require a private regular database.");
  }
  return new DatabaseSync(absolute);
}

export function scopedExecutionChecklistStorage(
  path: string,
  scope: ExecutionChecklistScope,
  previous?: Pick<StorageProvider, "get">,
) {
  return createExecutionChecklistStorage(
    () => privateDatabase(path),
    scope,
    previous,
  );
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

function runFor(row: Row): ExecutionTraceRun {
  const classification = Object.keys(CLASSIFICATION_ORDER).find((key) =>
    CLASSIFICATION_ORDER[key as ClassificationLevel] === row.maxLevel
  ) as ClassificationLevel;
  return {
    scope: JSON.parse(String(row.scope)) as ExecutionTraceScope,
    classification,
    admittedAt: new Date(Number(row.admittedAt)).toISOString(),
    status: row.status as ExecutionTraceRun["status"],
    ...(row.operatorCancelled === 1 && { operatorCancelled: true as const }),
    ...(typeof row.finishedAt === "number" && {
      finishedAt: new Date(row.finishedAt).toISOString(),
    }),
  };
}

function receiptFor(
  scope: ExecutionTraceScope,
  row: Row,
): ExecutionTraceReceipt {
  return {
    scope,
    id: String(row.id),
    ordinal: Number(row.ordinal),
    tool: String(row.tool),
    classification: row.classification as ClassificationLevel,
    outcome: row.outcome as ExecutionTraceOutcome,
    recordedAt: new Date(Number(row.recordedAt)).toISOString(),
  };
}

function pageSize(limit: number) {
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= maxPage;
}

/** Run authorization and trusted tool-name selection belong to the caller. */
interface LiveExecutionHandle {
  readonly controller: AbortController;
  readonly ceiling: ClassificationLevel;
}
const liveExecutions = new Map<string, Set<LiveExecutionHandle>>();

function liveExecutionKey(path: string, scope: ExecutionTraceScope) {
  return JSON.stringify([
    resolve(path),
    scope.role,
    scope.runId,
    scope.sessionId,
  ]);
}

/** Register the process-local interrupt handle for an admitted background run. */
export function bindLiveExecution(
  path: string,
  scope: ExecutionTraceScope,
  parentSignal?: AbortSignal,
  ceiling: ClassificationLevel = "PUBLIC",
) {
  const key = liveExecutionKey(path, scope);
  const controller = new AbortController();
  const handle = { controller, ceiling };
  const handles = liveExecutions.get(key) ?? new Set<LiveExecutionHandle>();
  handles.add(handle);
  liveExecutions.set(key, handles);
  return {
    signal: parentSignal
      ? AbortSignal.any([parentSignal, controller.signal])
      : controller.signal,
    get cancelled() {
      return controller.signal.aborted;
    },
    release() {
      handles.delete(handle);
      if (handles.size === 0) liveExecutions.delete(key);
    },
  };
}

export function openExecutionTraces(path: string, now = Date.now) {
  const db = privateDatabase(path);
  try {
    db.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = OFF",
    );
    transaction(db, () => {
      const current = db.prepare("PRAGMA application_id").get()?.application_id;
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (current === appId && version === 4) return;
      const createRuns = (
        table: "execution_trace_runs" | "execution_trace_runs_next",
      ) =>
        db.exec(`
        CREATE TABLE ${table} (
          sequence INTEGER PRIMARY KEY,
          role TEXT NOT NULL CHECK(role IN ('delegated','scheduled','owner_chat')),
          runId TEXT NOT NULL,
          scope TEXT NOT NULL,
          cursor TEXT NOT NULL UNIQUE,
          maxLevel INTEGER NOT NULL,
          admittedAt INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','interrupted')),
          finishedAt INTEGER,
          finishLevel INTEGER,
          operatorCancelled INTEGER NOT NULL DEFAULT 0 CHECK(operatorCancelled IN (0,1)),
          UNIQUE(role,runId)
        );
      `);
      const upgradeOwnerTraces = () => {
        createRuns("execution_trace_runs_next");
        db.exec(`
          INSERT INTO execution_trace_runs_next
          SELECT sequence, role, runId, scope, cursor, maxLevel, admittedAt, status, finishedAt, finishLevel, operatorCancelled
          FROM execution_trace_runs;
          DROP TABLE execution_trace_runs;
          ALTER TABLE execution_trace_runs_next RENAME TO execution_trace_runs;
          PRAGMA user_version = 4;
        `);
        if (db.prepare("PRAGMA foreign_key_check").get()) {
          throw new Error(
            "Execution trace migration would invalidate a saved reference.",
          );
        }
      };
      if (current === appId && version === 3) {
        upgradeOwnerTraces();
        return;
      }
      const upgradeCancellation = () => {
        if (
          !db.prepare("PRAGMA table_info(execution_trace_runs)").all()
            .some(({ name }) => name === "operatorCancelled")
        ) {
          db.exec(`ALTER TABLE execution_trace_runs ADD COLUMN
            operatorCancelled INTEGER NOT NULL DEFAULT 0 CHECK(operatorCancelled IN (0,1))`);
        }
        db.exec("PRAGMA user_version = 3");
      };
      if (current === appId && version === 2) {
        upgradeCancellation();
        upgradeOwnerTraces();
        return;
      }
      const payloadTable = `
        CREATE TABLE execution_trace_approved_payloads (
          stepId TEXT PRIMARY KEY REFERENCES execution_trace_steps(id),
          payload TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version = 2;
      `;
      if (current === appId && version === 1) {
        db.exec(payloadTable);
        upgradeCancellation();
        upgradeOwnerTraces();
        return;
      }
      if (
        current !== 0 || version !== 0 ||
        db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
      ) {
        throw new Error("Invalid execution trace database or version.");
      }
      createRuns("execution_trace_runs");
      db.exec(`
        CREATE TABLE execution_trace_steps (
          runSequence INTEGER NOT NULL REFERENCES execution_trace_runs(sequence),
          ordinal INTEGER NOT NULL,
          id TEXT NOT NULL UNIQUE,
          tool TEXT NOT NULL,
          classification TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('returned','blocked','failed')),
          recordedAt INTEGER NOT NULL,
          PRIMARY KEY(runSequence,ordinal)
        );
        PRAGMA application_id = ${appId};
        ${payloadTable}
      `);
      db.exec("PRAGMA user_version = 4");
    });
    db.exec("PRAGMA foreign_keys = ON");
    ensureExecutionChecklists(db);
  } catch (error) {
    db.close();
    throw error;
  }
  db.function(
    "execution_trace_source_visible",
    { deterministic: true },
    (role, source, owner) =>
      executionTraceSourceVisible(role, source, owner) ? 1 : 0,
  );
  const controls = createAssignmentControlJournal(
    db,
    "execution_trace_controls",
    "execution_trace_runs",
    "sequence",
  );
  const hasControlJournal = () =>
    db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE name = 'execution_trace_controls' AND type = 'table'",
    ).get() !== undefined;
  const readSteering = (role: ExecutionTraceRole, sequence: unknown) =>
    hasControlJournal()
      ? controls.read(role, String(sequence)).steering.map(
        ({ requestId, note, requestedAt, appliedAt }) => ({
          requestId,
          note: note ?? "",
          requestedAt,
          ...(appliedAt && { appliedAt }),
        }),
      )
      : [];
  const run = db.prepare(
    "SELECT * FROM execution_trace_runs WHERE role = ? AND runId = ?",
  );
  const exact = db.prepare(
    "SELECT * FROM execution_trace_steps WHERE runSequence = ? AND ordinal = ?",
  );
  function checkedRun(
    scope: ExecutionTraceScope,
    ceiling?: ClassificationLevel,
  ) {
    const row = run.get(scope.role, scope.runId);
    return row?.scope === JSON.stringify(scope) &&
        (ceiling === undefined ||
          Number(row.maxLevel) <= CLASSIFICATION_ORDER[ceiling])
      ? row
      : undefined;
  }
  const lastOrdinal = db.prepare(
    "SELECT MAX(ordinal) AS ordinal FROM execution_trace_steps WHERE runSequence = ?",
  );
  const readPayload = db.prepare(
    "SELECT payload FROM execution_trace_approved_payloads WHERE stepId = ?",
  );
  const writePayload = db.prepare(
    "INSERT INTO execution_trace_approved_payloads (stepId,payload) VALUES (?,?)",
  );
  function append(
    rawScope: ExecutionTraceScope,
    rawStep: Omit<ExecutionTraceStep, "ordinal">,
    ordinal?: number,
    rawPayload?: ExecutionTraceApprovedPayload,
  ): ExecutionTraceReceipt | undefined {
    const scope = normalizeScope(rawScope);
    const normalized = normalizeStep({ ...rawStep, ordinal: ordinal ?? 1 });
    if (!scope || !normalized) return;
    const payload = rawPayload === undefined
      ? undefined
      : normalizeApprovedPayload(rawPayload);
    if (
      rawPayload !== undefined &&
      (!payload ||
        normalized.tool !== executionTracePayloadCall(payload).name ||
        normalized.outcome !== "returned")
    ) return;
    return transaction(db, () => {
      const admitted = checkedRun(scope);
      if (!admitted) return undefined;
      const last = Number(lastOrdinal.get(admitted.sequence)?.ordinal ?? 0);
      const step = { ...normalized, ordinal: ordinal ?? last + 1 };
      if (!Number.isSafeInteger(step.ordinal)) return undefined;
      const id = hashId(
        "execution-trace",
        payload ? [scope, step, payload] : [scope, step],
      );
      const current = ordinal === undefined
        ? undefined
        : exact.get(admitted.sequence, ordinal);
      if (current) {
        return current.id === id ? receiptFor(scope, current) : undefined;
      }
      if (admitted.status !== "running" || step.ordinal <= last) {
        return undefined;
      }
      const row = db.prepare(`
        INSERT INTO execution_trace_steps VALUES (?,?,?,?,?,?,?) RETURNING *
      `).get(
        admitted.sequence,
        step.ordinal,
        id,
        step.tool,
        step.classification,
        step.outcome,
        now(),
      );
      if (payload) writePayload.run(id, JSON.stringify(payload));
      db.prepare(
        "UPDATE execution_trace_runs SET maxLevel = max(maxLevel, ?) WHERE sequence = ?",
      )
        .run(CLASSIFICATION_ORDER[step.classification], admitted.sequence);
      return receiptFor(scope, row!);
    });
  }
  return {
    /** Publish a completed execution and its selected steps atomically. */
    recordCompletedRun(
      rawScope: ExecutionTraceScope,
      dispatches: readonly {
        step: Omit<ExecutionTraceStep, "ordinal">;
        recordedAt: number;
        payload?: ExecutionTraceApprovedPayload;
      }[],
      admittedAt: number,
      finishClassification: ClassificationLevel,
    ): boolean {
      const scope = normalizeScope(rawScope);
      if (
        !scope || !dispatches.length || dispatches.length > maxArchivedSteps ||
        !levelOf(finishClassification) || !Number.isFinite(admittedAt)
      ) return false;
      const finishedAt = now();
      let classification = maxClassification(
        scope.classification!,
        finishClassification,
      );
      const entries: ExecutionTraceArchive["entries"][number][] = [];
      for (const { step: raw, recordedAt, payload: rawPayload } of dispatches) {
        const step = normalizeStep({ ...raw, ordinal: entries.length + 1 });
        const payload = rawPayload && normalizeApprovedPayload(rawPayload);
        if (
          !step || !Number.isFinite(recordedAt) ||
          recordedAt < admittedAt || recordedAt > finishedAt ||
          (rawPayload !== undefined && (!payload ||
            step.tool !== executionTracePayloadCall(payload).name ||
            step.outcome !== "returned"))
        ) return false;
        classification = maxClassification(classification, step.classification);
        const id = hashId(
          "execution-trace",
          payload ? [scope, step, payload] : [scope, step],
        );
        entries.push({
          step: {
            ...step,
            scope,
            id,
            recordedAt: new Date(recordedAt).toISOString(),
          },
          ...(payload && { payload }),
        });
      }
      return this.restoreSnapshot(
        {
          run: {
            scope,
            classification,
            admittedAt: new Date(admittedAt).toISOString(),
            finishedAt: new Date(finishedAt).toISOString(),
            status: "completed",
          },
          finishLevel: CLASSIFICATION_ORDER[finishClassification],
          entries,
        },
        scope.role,
        scope.runId,
        classification,
      );
    },

    archiveSnapshot(
      role: ExecutionTraceRole,
      runId: string,
      ceiling: ClassificationLevel,
      includeRunning = false,
    ): ExecutionTraceArchive | undefined {
      if (!roleOf(role) || !reference(runId) || !levelOf(ceiling)) return;
      return transaction(db, () => {
        const row = run.get(role, runId);
        if (!row) return;
        const saved = runFor(row);
        if (
          (!includeRunning && saved.status === "running") ||
          !canFlowTo(saved.classification, ceiling)
        ) return;
        const rows = db.prepare(`
          SELECT * FROM execution_trace_steps WHERE runSequence = ?
          ORDER BY ordinal LIMIT ?
        `).all(row.sequence, maxArchivedSteps + 1);
        if (rows.length > maxArchivedSteps) return;
        const entries = rows.map((row) => {
          const step = receiptFor(saved.scope, row);
          const stored = readPayload.get(step.id)?.payload;
          const payload = typeof stored === "string"
            ? normalizeApprovedPayload(JSON.parse(stored))
            : undefined;
          if (stored !== undefined && !payload) {
            throw new Error("Invalid saved execution trace payload");
          }
          return { step, ...(payload && { payload }) };
        });
        const checklist = archiveExecutionChecklist(
          db,
          saved.scope,
          ceiling,
        );
        const steering = readSteering(role, row.sequence);
        if (
          steering.length &&
          (!canFlowTo("INTERNAL", ceiling) || !validArchivedSteering(steering))
        ) return;
        return {
          run: saved,
          finishLevel: typeof row.finishLevel === "number"
            ? row.finishLevel
            : null,
          entries,
          ...(checklist && { checklist }),
          ...(steering.length > 0 && { steering }),
        };
      });
    },

    restoreSnapshot(
      archive: ExecutionTraceArchive,
      role: ExecutionTraceRole,
      runId: string,
      ceiling: ClassificationLevel,
      recovery?: {
        path: string;
        record: RecoverableState | FinishedAgentRecoveryRecord;
        admission?: { path: string; install(db: DatabaseSync): boolean };
        ownerChecklist?: ArchivedExecutionChecklist;
      },
      installKey?: RunArchiveRestoreKey,
      links?: { path: string; records: readonly ArchivedOperatorRunLink[] },
    ): boolean {
      const saved = archive?.run;
      const scope = normalizeScope(saved?.scope);
      const record = recovery?.record;
      const checkpoint = record && "tools" in record ? record : undefined;
      const terminal =
        record && "status" in record && record.status === "finished"
          ? record
          : undefined;
      if (
        !saved || !scope || scope.role !== role || scope.runId !== runId ||
        (links !== undefined && role === "owner_chat") ||
        !levelOf(ceiling) || !levelOf(saved.classification) ||
        !canFlowTo(saved.classification, ceiling) ||
        !canFlowTo(scope.classification!, saved.classification) ||
        (recovery &&
          (record?.key !==
              (scope.role === "owner_chat"
                ? scope.runId
                : assignmentRecoveryKey(scope.sessionId, scope.runId)) ||
            (terminal
              ? (scope.role !== "owner_chat" && scope.role !== "delegated") ||
                saved.status !== "completed"
              : !checkpoint))) ||
        (checkpoint
          ? saved.status !== "running" || saved.finishedAt !== undefined ||
            archive.finishLevel !== null ||
            !checkpoint.tools.every(({ classification }) =>
              canFlowTo(classification, ceiling)
            )
          : !["completed", "failed", "interrupted"].includes(saved.status)) ||
        (saved.operatorCancelled !== undefined &&
          (saved.operatorCancelled !== true ||
            saved.status !== "interrupted")) ||
        !Array.isArray(archive.entries) ||
        archive.entries.length > maxArchivedSteps ||
        (checkpoint !== undefined && isPausedBeforeFirstAction(checkpoint) &&
          (role === "owner_chat" || archive.entries.length > 0)) ||
        (archive.steering !== undefined &&
          (role === "owner_chat" || !canFlowTo("INTERNAL", ceiling) ||
            !validArchivedSteering(archive.steering))) ||
        (archive.checklist !== undefined &&
          (scope.role === "owner_chat" || !validExecutionChecklist(
            archive.checklist,
            scope,
            ceiling,
          ))) ||
        (recovery?.ownerChecklist !== undefined &&
          (scope.role !== "owner_chat" || scope.sourceId === undefined ||
            !validExecutionChecklist(recovery.ownerChecklist, {
              role: scope.role,
              runId: scope.sourceId,
              sessionId: scope.sessionId,
            }, ceiling)))
      ) return false;
      const admittedAt = Date.parse(saved.admittedAt);
      const finishedAt = checkpoint ? null : Date.parse(saved.finishedAt ?? "");
      const level = CLASSIFICATION_ORDER[saved.classification];
      if (
        archive.finishLevel !== null &&
        (!Number.isInteger(archive.finishLevel) ||
          archive.finishLevel < 0 || archive.finishLevel > level)
      ) return false;
      if (
        !Number.isFinite(admittedAt) ||
        (!checkpoint && !Number.isFinite(finishedAt))
      ) {
        return false;
      }
      let last = 0;
      const entries: {
        id: string;
        step: ExecutionTraceStep;
        recordedAt: number;
        payload?: ExecutionTraceApprovedPayload;
      }[] = [];
      for (const entry of archive.entries) {
        const step = normalizeStep(entry?.step);
        if (
          !step || step.ordinal <= last ||
          !canFlowTo(step.classification, saved.classification) ||
          JSON.stringify(normalizeScope(entry.step.scope)) !==
            JSON.stringify(scope)
        ) return false;
        const recordedAt = Date.parse(entry.step.recordedAt);
        if (!Number.isFinite(recordedAt)) return false;
        const payload = entry.payload === undefined
          ? undefined
          : normalizeApprovedPayload(entry.payload);
        if (
          entry.payload !== undefined && (!payload ||
            step.tool !== executionTracePayloadCall(payload).name ||
            step.outcome !== "returned")
        ) return false;
        const id = hashId(
          "execution-trace",
          payload ? [scope, step, payload] : [scope, step],
        );
        if (entry.step.id !== id) return false;
        entries.push({ id, step, recordedAt, payload });
        last = step.ordinal;
      }
      if (recovery) {
        new AgentRecoveryStore(recovery.path).close();
        db.prepare("ATTACH DATABASE ? AS archive_recovery").run(recovery.path);
      }
      let admissionAttached = false;
      try {
        if (recovery?.admission) {
          db.prepare("ATTACH DATABASE ? AS archive_admission").run(
            recovery.admission.path,
          );
          admissionAttached = true;
          if (
            db.prepare("PRAGMA archive_admission.journal_mode").get()
              ?.journal_mode !== "delete"
          ) return false;
        }
        if (
          recovery && (
            db.prepare("PRAGMA main.journal_mode").get()?.journal_mode !==
              "delete" ||
            db.prepare("PRAGMA archive_recovery.journal_mode").get()
                ?.journal_mode !== "delete"
          )
        ) return false;
        const install = () =>
          transaction(
            db,
            () =>
              restoreRunArchiveOnce(db, installKey, () => {
                if (run.get(role, runId)) return false;
                if (
                  (checkpoint &&
                    !installPausedRecovery(
                      db,
                      checkpoint,
                      "archive_recovery",
                      role !== "owner_chat",
                    )) ||
                  (terminal &&
                    !installFinishedRecovery(db, terminal, "archive_recovery"))
                ) return false;
                if (recovery?.admission && !recovery.admission.install(db)) {
                  throw new Error("Scheduler admission identity collision");
                }
                if (links && role !== "owner_chat") {
                  restoreOperatorRunLinks(
                    db,
                    { kind: role, id: runId },
                    links.records,
                  );
                }
                if (archive.checklist) {
                  installExecutionChecklist(db, archive.checklist);
                }
                if (recovery?.ownerChecklist) {
                  installExecutionChecklist(
                    db,
                    recovery.ownerChecklist,
                    "archive_recovery",
                  );
                }
                const row = db.prepare(`
          INSERT INTO execution_trace_runs
          (role,runId,scope,cursor,maxLevel,admittedAt,status,finishedAt,finishLevel,operatorCancelled)
          VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING sequence
        `).get(
                  role,
                  runId,
                  JSON.stringify(scope),
                  hashId("execution-trace-run", scope),
                  level,
                  admittedAt,
                  saved.status,
                  finishedAt,
                  archive.finishLevel,
                  saved.operatorCancelled ? 1 : 0,
                );
                const insert = db.prepare(
                  "INSERT INTO execution_trace_steps VALUES (?,?,?,?,?,?,?)",
                );
                if (archive.steering?.length) {
                  controls.initialize();
                  const taskId = String(row!.sequence);
                  for (const receipt of archive.steering) {
                    const restored = controls.request(
                      {
                        requestId: receipt.requestId,
                        revision: role,
                        taskId,
                        action: "steer",
                        note: receipt.note,
                      },
                      Date.parse(receipt.requestedAt),
                      () => true,
                    );
                    if (
                      !restored?.created ||
                      restored.receipt.steeringId === undefined
                    ) {
                      throw new Error("Steering receipt identity collision");
                    }
                    if (receipt.appliedAt !== undefined) {
                      controls.markSteeringApplied(
                        role,
                        taskId,
                        restored.receipt.steeringId,
                        Date.parse(receipt.appliedAt),
                      );
                    }
                  }
                }
                for (const { id, step, recordedAt, payload } of entries) {
                  insert.run(
                    row!.sequence,
                    step.ordinal,
                    id,
                    step.tool,
                    step.classification,
                    step.outcome,
                    recordedAt,
                  );
                  if (payload) {
                    writePayload.run(id, JSON.stringify(payload));
                  }
                }
                return true;
              }),
          );
        return withOperatorRunLinks(db, links?.path, install);
      } finally {
        if (admissionAttached) db.exec("DETACH DATABASE archive_admission");
        if (recovery) db.exec("DETACH DATABASE archive_recovery");
      }
    },
    admit(raw: ExecutionTraceScope): ExecutionTraceRun | undefined {
      const scope = normalizeScope(raw);
      if (!scope) return;
      const encoded = JSON.stringify(scope);
      return transaction(db, () => {
        const current = run.get(scope.role, scope.runId);
        if (current) {
          return current.scope === encoded ? runFor(current) : undefined;
        }
        const row = db.prepare(`
          INSERT INTO execution_trace_runs (role,runId,scope,cursor,maxLevel,admittedAt)
          VALUES (?,?,?,?,?,?) RETURNING *
        `).get(
          scope.role,
          scope.runId,
          encoded,
          hashId("execution-trace-run", scope),
          CLASSIFICATION_ORDER[scope.classification!],
          now(),
        );
        return runFor(row!);
      });
    },

    append(
      rawScope: ExecutionTraceScope,
      rawStep: ExecutionTraceStep,
      payload?: ExecutionTraceApprovedPayload,
    ): ExecutionTraceReceipt | undefined {
      if (!Number.isSafeInteger(rawStep?.ordinal)) return undefined;
      return append(rawScope, rawStep, rawStep.ordinal, payload);
    },

    appendNext(
      rawScope: ExecutionTraceScope,
      rawStep: Omit<ExecutionTraceStep, "ordinal">,
      payload?: ExecutionTraceApprovedPayload,
    ) {
      return append(rawScope, rawStep, undefined, payload);
    },

    finish(
      rawScope: ExecutionTraceScope,
      status: ExecutionTraceTerminalStatus,
      classification?: ClassificationLevel,
    ): ExecutionTraceRun | undefined {
      const scope = normalizeScope(rawScope);
      if (
        !scope ||
        (status !== "completed" && status !== "failed" &&
          status !== "interrupted") ||
        (classification !== undefined && !levelOf(classification))
      ) return undefined;
      const level = classification === undefined
        ? null
        : CLASSIFICATION_ORDER[classification];
      return transaction(db, () => {
        const admitted = checkedRun(scope);
        if (!admitted) return undefined;
        if (admitted.status !== "running") {
          return admitted.status === status && admitted.finishLevel === level
            ? runFor(admitted)
            : undefined;
        }
        const row = db.prepare(`
          UPDATE execution_trace_runs SET status = ?, finishedAt = ?, finishLevel = ?,
            maxLevel = max(maxLevel, coalesce(?, maxLevel))
          WHERE sequence = ? AND status = 'running' RETURNING *
        `).get(status, now(), level, level, admitted.sequence);
        return row && runFor(row);
      });
    },

    steerRun(
      role: ExecutionTraceRole,
      runId: string,
      ceiling: ClassificationLevel,
      requestId: string,
      note: string,
      allowNew: boolean,
    ) {
      if (
        (role !== "delegated" && role !== "scheduled") || !reference(runId) ||
        !levelOf(ceiling) || !canFlowTo("INTERNAL", ceiling) ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId) ||
        !note.trim() || note.length > 1000 || note.includes("\0") ||
        redactCredentialText(note) !== note
      ) return;
      return transaction(db, () => {
        const current = run.get(role, runId);
        if (
          !current || Number(current.maxLevel) > CLASSIFICATION_ORDER[ceiling]
        ) return;
        controls.initialize();
        return controls.request(
          {
            requestId,
            revision: role,
            taskId: String(current.sequence),
            action: "steer",
            note,
          },
          now(),
          () =>
            allowNew && current.status === "running" &&
              [
                ...(liveExecutions.get(
                  liveExecutionKey(path, runFor(current).scope),
                ) ?? []),
              ]
                .some(({ ceiling, controller }) =>
                  !controller.signal.aborted && canFlowTo("INTERNAL", ceiling)
                )
              ? true
              : undefined,
        )?.receipt;
      });
    },

    workerBoundary(
      scope: ExecutionTraceScope,
      ceiling: ClassificationLevel,
      parent?: WorkerBoundary,
    ): WorkerBoundary {
      const delivered = new Set<number>();
      return async (phase) => {
        const parentDecision = await parent?.(phase);
        if (parentDecision?.stop) return parentDecision;
        const normalized = normalizeScope(scope);
        const current = normalized && checkedRun(normalized);
        if (current?.operatorCancelled === 1) return { stop: true };
        if (
          !current || !canFlowTo("INTERNAL", ceiling) ||
          phase === "before_tool" || !hasControlJournal()
        ) return parentDecision ?? {};
        const taskId = String(current.sequence);
        const instructions = [...parentDecision?.instructions ?? []];
        for (const guidance of controls.read(scope.role, taskId).steering) {
          if (
            guidance.steeringId === undefined || !guidance.note ||
            delivered.has(guidance.steeringId)
          ) continue;
          controls.markSteeringApplied(
            scope.role,
            taskId,
            guidance.steeringId,
            now(),
          );
          delivered.add(guidance.steeringId);
          instructions.push(guidance.note);
        }
        return instructions.length ? { instructions } : {};
      };
    },

    cancelRun(
      role: ExecutionTraceRole,
      runId: string,
      ceiling: ClassificationLevel,
    ) {
      if (!roleOf(role) || !reference(runId) || !levelOf(ceiling)) return;
      const cancelled = transaction(db, () => {
        const current = run.get(role, runId);
        if (
          !current || Number(current.maxLevel) > CLASSIFICATION_ORDER[ceiling]
        ) return;
        if (current.operatorCancelled === 1) return runFor(current);
        if (current.status !== "running") return;
        const changed = db.prepare(`UPDATE execution_trace_runs
          SET status = 'interrupted', finishedAt = ?, operatorCancelled = 1
          WHERE sequence = ? RETURNING *`).get(now(), current.sequence);
        return changed && runFor(changed);
      });
      if (cancelled) {
        for (
          const handle
            of liveExecutions.get(liveExecutionKey(path, cancelled.scope)) ?? []
        ) {
          handle.controller.abort();
        }
      }
      return cancelled;
    },

    readRun(
      role: ExecutionTraceRole,
      runId: string,
      ceiling: ClassificationLevel,
    ) {
      if (!roleOf(role) || !reference(runId) || !levelOf(ceiling)) {
        return undefined;
      }
      const row = run.get(role, runId);
      if (!row) return undefined;
      const info = runFor(row);
      return canFlowTo(info.classification, ceiling) ? info : undefined;
    },

    readControlHistory(
      role: ExecutionTraceRole,
      runId: string,
      ceiling: ClassificationLevel,
    ) {
      if (
        (role !== "delegated" && role !== "scheduled") || !reference(runId) ||
        !levelOf(ceiling) || !canFlowTo("INTERNAL", ceiling)
      ) return;
      return transaction(db, () => {
        const row = run.get(role, runId);
        if (!row || Number(row.maxLevel) > CLASSIFICATION_ORDER[ceiling]) {
          return;
        }
        const stopped = row.operatorCancelled === 1;
        const steering = readSteering(role, row.sequence);
        if (!validArchivedSteering(steering)) return;
        if (!stopped && !steering.length) return;
        return { stopped, steering };
      });
    },

    listRuns({
      role,
      ceiling,
      limit = 20,
      cursor,
      ownerSessionId,
      backgroundOwner,
    }: {
      readonly role?: ExecutionTraceRole;
      readonly ceiling: ClassificationLevel;
      readonly limit?: number;
      readonly cursor?: string;
      /** Trusted owner session, required for owner-chat run discovery. */
      readonly ownerSessionId?: string;
      /** Trusted owner of background executions; null excludes owner-bound runs. */
      readonly backgroundOwner?: string | null;
    }) {
      if (
        (role !== undefined && !roleOf(role)) || !levelOf(ceiling) ||
        !pageSize(limit) ||
        (role === "owner_chat"
          ? !reference(ownerSessionId)
          : ownerSessionId !== undefined)
      ) return undefined;
      let before = Number.MAX_SAFE_INTEGER;
      if (cursor !== undefined) {
        if (typeof cursor !== "string" || !runCursorPattern.test(cursor)) {
          return undefined;
        }
        const found = db.prepare(
          "SELECT * FROM execution_trace_runs WHERE cursor = ?",
        ).get(cursor);
        if (
          !found || (role === undefined
            ? found.role === "owner_chat"
            : role !== found.role) ||
          Number(found.maxLevel) > CLASSIFICATION_ORDER[ceiling] ||
          (backgroundOwner !== undefined &&
            !executionTraceSourceVisible(
              found.role,
              runFor(found).scope.sourceId,
              backgroundOwner,
            )) ||
          (ownerSessionId !== undefined &&
            runFor(found).scope.sessionId !== ownerSessionId)
        ) {
          return undefined;
        }
        before = Number(found.sequence);
      }
      const rows = db.prepare(`
        SELECT * FROM execution_trace_runs
        WHERE (? IS NULL OR role = ?) AND (? IS NOT NULL OR role != 'owner_chat')
          AND (? IS NULL OR json_extract(scope, '$.sessionId') = ?)
          AND (? = 0 OR execution_trace_source_visible(role, json_extract(scope, '$.sourceId'), ?))
          AND maxLevel <= ? AND sequence < ?
        ORDER BY sequence DESC LIMIT ?
      `).all(
        role ?? null,
        role ?? null,
        role ?? null,
        ownerSessionId ?? null,
        ownerSessionId ?? null,
        backgroundOwner === undefined ? 0 : 1,
        backgroundOwner ?? null,
        CLASSIFICATION_ORDER[ceiling],
        before,
        limit + 1,
      );
      const page = rows.slice(0, limit);
      return {
        runs: page.map(runFor),
        nextCursor: rows.length > limit ? String(page.at(-1)!.cursor) : null,
      };
    },

    search({
      query,
      ceiling,
      role,
      runId,
      limit = 10,
      cursor,
      approvedResults = false,
      ownerSessionId,
      backgroundOwner,
    }: {
      readonly query: string;
      readonly ceiling: ClassificationLevel;
      readonly role?: ExecutionTraceRole;
      readonly runId?: string;
      readonly limit?: number;
      readonly cursor?: string;
      readonly approvedResults?: boolean;
      readonly ownerSessionId?: string;
      /** Trusted owner of background executions; null excludes owner-bound runs. */
      readonly backgroundOwner?: string | null;
    }) {
      const queryPattern = approvedResults
        ? /^[A-Za-z0-9_.:/-]{1,128}$/
        : /^[A-Za-z0-9_.:-]{1,128}$/;
      if (
        typeof query !== "string" || !queryPattern.test(query) ||
        !levelOf(ceiling) || !pageSize(limit) ||
        (role !== undefined && !roleOf(role)) ||
        (runId !== undefined && (!role || !reference(runId))) ||
        (role === "owner_chat"
          ? !reference(ownerSessionId)
          : ownerSessionId !== undefined)
      ) return;
      const term = query.toLowerCase();
      const matchStep = approvedResults
        ? "step.outcome = 'returned' AND step.tool IN ('github_actions', 'github_repos', 'github_pulls')"
        : "(instr(lower(step.tool), ?) > 0 OR step.outcome = ?)";
      const matchArgs = approvedResults ? [] : [term, term];
      const filter = hashId("execution-trace-search", [
        role ?? null,
        runId ?? null,
        term,
        ceiling,
        ...(approvedResults ? ["approved-results"] : []),
        ...(ownerSessionId ? ["owner-session", ownerSessionId] : []),
        ...(backgroundOwner !== undefined
          ? ["background-owner", backgroundOwner]
          : []),
      ]);
      return transaction(db, () => {
        if (runId !== undefined) {
          const selected = run.get(role!, runId);
          if (
            !selected ||
            Number(selected.maxLevel) > CLASSIFICATION_ORDER[ceiling] ||
            (backgroundOwner !== undefined &&
              !executionTraceSourceVisible(
                selected.role,
                runFor(selected).scope.sourceId,
                backgroundOwner,
              )) ||
            (ownerSessionId !== undefined &&
              runFor(selected).scope.sessionId !== ownerSessionId)
          ) return;
        }
        let sequence = Number.MAX_SAFE_INTEGER;
        let ordinal = Number.MAX_SAFE_INTEGER;
        if (cursor !== undefined) {
          if (typeof cursor !== "string") return;
          const prefix = filter + ".";
          const receipt = cursor.slice(prefix.length);
          if (!cursor.startsWith(prefix) || !receiptPattern.test(receipt)) {
            return;
          }
          const anchor = db.prepare(`
            SELECT step.runSequence, step.ordinal FROM execution_trace_steps AS step
            JOIN execution_trace_runs AS run ON run.sequence = step.runSequence
            WHERE step.id = ? AND run.maxLevel <= ?
              AND (? IS NULL OR run.role = ?) AND (? IS NOT NULL OR run.role != 'owner_chat')
              AND (? IS NULL OR run.runId = ?)
              AND (? IS NULL OR json_extract(run.scope, '$.sessionId') = ?)
              AND (? = 0 OR execution_trace_source_visible(run.role, json_extract(run.scope, '$.sourceId'), ?))
              AND ${matchStep}
          `).get(
            receipt,
            CLASSIFICATION_ORDER[ceiling],
            role ?? null,
            role ?? null,
            role ?? null,
            runId ?? null,
            runId ?? null,
            ownerSessionId ?? null,
            ownerSessionId ?? null,
            backgroundOwner === undefined ? 0 : 1,
            backgroundOwner ?? null,
            ...matchArgs,
          );
          if (!anchor) return;
          sequence = Number(anchor.runSequence);
          ordinal = Number(anchor.ordinal);
        }
        const rows = db.prepare(`
          SELECT step.*, run.role, run.runId FROM execution_trace_steps AS step
          JOIN execution_trace_runs AS run ON run.sequence = step.runSequence
          WHERE run.maxLevel <= ?
            AND (? IS NULL OR run.role = ?) AND (? IS NOT NULL OR run.role != 'owner_chat')
              AND (? IS NULL OR run.runId = ?)
            AND (? IS NULL OR json_extract(run.scope, '$.sessionId') = ?)
            AND (? = 0 OR execution_trace_source_visible(run.role, json_extract(run.scope, '$.sourceId'), ?))
            AND ${matchStep}
            AND (step.runSequence, step.ordinal) < (?, ?)
          ORDER BY step.runSequence DESC, step.ordinal DESC LIMIT ?
        `).all(
          CLASSIFICATION_ORDER[ceiling],
          role ?? null,
          role ?? null,
          role ?? null,
          runId ?? null,
          runId ?? null,
          ownerSessionId ?? null,
          ownerSessionId ?? null,
          backgroundOwner === undefined ? 0 : 1,
          backgroundOwner ?? null,
          ...matchArgs,
          sequence,
          ordinal,
          limit + 1,
        );
        const matches = rows.slice(0, limit).map((row) => ({
          role: row.role as ExecutionTraceRole,
          runId: String(row.runId),
          id: String(row.id),
          ordinal: Number(row.ordinal),
          tool: String(row.tool),
          classification: row.classification as ClassificationLevel,
          outcome: row.outcome as ExecutionTraceOutcome,
          recordedAt: new Date(Number(row.recordedAt)).toISOString(),
        }));
        return {
          matches,
          nextCursor: rows.length > limit
            ? filter + "." + matches.at(-1)!.id
            : null,
        };
      });
    },

    recent(
      role: ExecutionTraceRole,
      runId: string,
      ceiling: ClassificationLevel,
      limit = 12,
    ) {
      if (
        !roleOf(role) || !reference(runId) || !levelOf(ceiling) ||
        !pageSize(limit)
      ) return;
      return transaction(db, () => {
        const row = run.get(role, runId);
        if (!row || Number(row.maxLevel) > CLASSIFICATION_ORDER[ceiling]) {
          return;
        }
        const selected = runFor(row);
        const steps = db.prepare(`
          SELECT * FROM execution_trace_steps WHERE runSequence = ?
          ORDER BY ordinal DESC LIMIT ?
        `).all(row.sequence, limit).reverse();
        return {
          run: selected,
          steps: steps.map((step) => receiptFor(selected.scope, step)),
        };
      });
    },

    list(rawScope: ExecutionTraceScope, { ceiling, limit = 20, cursor }: {
      readonly ceiling: ClassificationLevel;
      readonly limit?: number;
      readonly cursor?: string;
    }) {
      const scope = normalizeScope(rawScope);
      if (!scope || !levelOf(ceiling) || !pageSize(limit)) return undefined;
      return transaction(db, () => {
        const admitted = checkedRun(scope, ceiling);
        if (!admitted) return undefined;
        let after = 0;
        if (cursor !== undefined) {
          if (typeof cursor !== "string" || !receiptPattern.test(cursor)) {
            return undefined;
          }
          const found = db.prepare(
            "SELECT ordinal FROM execution_trace_steps WHERE runSequence = ? AND id = ?",
          )
            .get(admitted.sequence, cursor);
          if (!found) return undefined;
          after = Number(found.ordinal);
        }
        const rows = db.prepare(`
          SELECT * FROM execution_trace_steps WHERE runSequence = ? AND ordinal > ?
          ORDER BY ordinal LIMIT ?
        `).all(admitted.sequence, after, limit + 1);
        const page = rows.slice(0, limit);
        return {
          steps: page.map((row) => receiptFor(scope, row)),
          nextCursor: rows.length > limit ? String(page.at(-1)!.id) : null,
        };
      });
    },

    inspect(
      rawScope: ExecutionTraceScope,
      ordinal: number,
      ceiling: ClassificationLevel,
    ) {
      const scope = normalizeScope(rawScope);
      if (
        !scope || !Number.isSafeInteger(ordinal) || ordinal < 1 ||
        !levelOf(ceiling)
      ) return undefined;
      return transaction(db, () => {
        const admitted = checkedRun(scope, ceiling);
        const row = admitted && exact.get(admitted.sequence, ordinal);
        return row && receiptFor(scope, row);
      });
    },

    latestApprovedStep(
      rawScope: ExecutionTraceScope,
      ceiling: ClassificationLevel,
    ): ExecutionTraceReceipt | undefined {
      const scope = normalizeScope(rawScope);
      if (!scope || !levelOf(ceiling)) return;
      return transaction(db, () => {
        const admitted = checkedRun(scope, ceiling);
        if (!admitted) return;
        const row = db.prepare(`
          SELECT step.* FROM execution_trace_steps AS step
          JOIN execution_trace_approved_payloads AS approved
            ON approved.stepId = step.id
          WHERE step.runSequence = ? AND step.outcome = 'returned'
          ORDER BY step.ordinal DESC LIMIT 1
        `).get(admitted.sequence);
        return row && receiptFor(scope, row);
      });
    },

    readApprovedPayload(
      rawScope: ExecutionTraceScope,
      ordinal: number,
      ceiling: ClassificationLevel,
    ): ExecutionTraceApprovedPayload | undefined {
      const scope = normalizeScope(rawScope);
      if (
        !scope || !Number.isSafeInteger(ordinal) || ordinal < 1 ||
        !levelOf(ceiling)
      ) return;
      return transaction(db, () => {
        const admitted = checkedRun(scope, ceiling);
        const row = admitted && exact.get(admitted.sequence, ordinal);
        if (
          !row || row.outcome !== "returned"
        ) return;
        const saved = readPayload.get(row.id)?.payload;
        if (typeof saved !== "string" || saved.length > 16_000) return;
        try {
          const payload = normalizeApprovedPayload(JSON.parse(saved));
          const step = normalizeStep({
            ordinal,
            tool: String(row.tool),
            outcome: "returned",
            classification: row.classification as ClassificationLevel,
          });
          if (
            !step || !payload ||
            step.tool !== executionTracePayloadCall(payload).name ||
            !canFlowTo(step.classification, ceiling) ||
            hashId("execution-trace", [scope, step, payload]) !== row.id
          ) return;
          return payload;
        } catch {
          return undefined;
        }
      });
    },

    close: () => db.close(),
  };
}
