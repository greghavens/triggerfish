/** Durable, fail-closed state for trusted agent continuation adapters. */
/// <reference path="./sqlite_types.d.ts" />

import {
  restoreRunArchiveOnce,
  type RunArchiveRestoreKey,
} from "./run_archive_actions.ts";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "@std/path";
import {
  CLASSIFICATION_ORDER,
  type ClassificationLevel,
} from "./types/classification.ts";
import type { AgentTurnCheckpoint } from "./types/orchestrator.ts";

export interface RecoveryToolReceipt {
  readonly name: string;
  /** Trusted deterministic batch/index identity, independent of provider IDs. */
  readonly callId: string;
  /** Already projected through the adapter's explicit allowlist. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly classification: ClassificationLevel;
  readonly resultSha256: string;
  readonly resourceId?: number;
}

interface RecoveryState {
  readonly key: string;
  readonly binding: string;
  readonly committedBatch: number;
}

export interface RecoverableState extends RecoveryState {
  readonly checkpoint?: AgentTurnCheckpoint;
  readonly tools: readonly RecoveryToolReceipt[];
}

export type AgentRecoveryRecord =
  | (RecoverableState & { readonly status: "ready" | "paused" })
  | (RecoverableState & {
    readonly status: "pending";
    readonly pendingBatch: number;
  })
  | (RecoveryState & { readonly status: "finished" });

const APPLICATION_ID = 0x41524356;
const VERSION = 1;
const MAX_CHECKPOINT_BYTES = 256 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_TOOLS = 128;
const MAX_BATCH = 1000;
const digestPattern = /^[a-f0-9]{64}$/;

function validateKey(key: string): string {
  if (
    typeof key !== "string" || !key.trim() || key.length > 256 ||
    key.includes("\x00")
  ) {
    throw new Error("Invalid agent recovery execution key");
  }
  return key;
}

function validateBinding(binding: string): string {
  if (typeof binding !== "string" || !digestPattern.test(binding)) {
    throw new Error("Invalid agent recovery binding digest");
  }
  return binding;
}

function validBatch(batch: number): boolean {
  return Number.isSafeInteger(batch) && batch >= 1 && batch <= MAX_BATCH;
}

class InvalidRecoveryProjection extends Error {}

/** Reject lossy JSON encoding, exotic objects, hidden fields and excessive nesting. */
function normalizedJson(
  value: unknown,
  nodes: { left: number },
  depth = 0,
): unknown {
  if (--nodes.left < 0 || depth > 12) throw new InvalidRecoveryProjection();
  if (
    value === null || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= MAX_CHECKPOINT_BYTES)
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1024 || Object.keys(value).length !== value.length) {
      throw new InvalidRecoveryProjection();
    }
    return Array.from(value, (item) => normalizedJson(item, nodes, depth + 1));
  }
  if (
    typeof value !== "object" || value === null ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length
  ) throw new InvalidRecoveryProjection();
  return Object.fromEntries(
    Object.entries(Object.getOwnPropertyDescriptors(value)).map(
      ([key, descriptor]) => {
        if (
          !key || key.length > 256 || key.includes("\x00") ||
          key === "__proto__" || key === "constructor" || key === "prototype" ||
          !descriptor.enumerable || !Object.hasOwn(descriptor, "value")
        ) throw new InvalidRecoveryProjection();
        return [key, normalizedJson(descriptor.value, nodes, depth + 1)];
      },
    ),
  );
}

function normalizedCheckpoint(
  checkpoint: AgentTurnCheckpoint,
  batch: number,
): string | undefined {
  const counter = (count: unknown) =>
    typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
  if (
    !checkpoint || checkpoint.completedIterations !== batch ||
    !Array.isArray(checkpoint.history) || checkpoint.history.length < 2 ||
    checkpoint.history.length > 256 ||
    checkpoint.history[0]?.role !== "user" ||
    !Array.isArray(checkpoint.toolCallCounts) ||
    checkpoint.toolCallCounts.length > MAX_TOOLS ||
    !counter(checkpoint.tokenUsage?.inputTokens) ||
    !counter(checkpoint.tokenUsage?.outputTokens) ||
    !counter(checkpoint.nudgeCount) || !counter(checkpoint.eosRetries)
  ) return;
  const countKeys = new Set<string>();
  const toolCallCounts = Array.from(
    checkpoint.toolCallCounts,
    (count: readonly [string, number]) => {
      if (
        !Array.isArray(count) || count.length !== 2 ||
        typeof count[0] !== "string" || !count[0] || count[0].length > 4096 ||
        !counter(count[1]) || countKeys.has(count[0])
      ) throw new InvalidRecoveryProjection();
      countKeys.add(count[0]);
      return [count[0], count[1]];
    },
  );
  const history = Array.from(
    checkpoint.history,
    (entry: AgentTurnCheckpoint["history"][number]) => {
      if (
        !entry || !["user", "assistant", "tool"].includes(entry.role) ||
        typeof entry.content !== "string" ||
        (entry.tool_calls !== undefined &&
          (!Array.isArray(entry.tool_calls) || entry.role !== "assistant")) ||
        (entry.tool_call_id !== undefined &&
          (entry.role !== "tool" || typeof entry.tool_call_id !== "string")) ||
        (entry.reasoning !== undefined &&
          (entry.role !== "assistant" ||
            typeof entry.reasoning !== "string")) ||
        (entry.reasoningBlocks !== undefined &&
          (entry.role !== "assistant" || !Array.isArray(entry.reasoningBlocks)))
      ) throw new InvalidRecoveryProjection();
      return {
        role: entry.role,
        content: entry.content,
        ...(entry.tool_calls !== undefined && { tool_calls: entry.tool_calls }),
        ...(entry.tool_call_id !== undefined &&
          { tool_call_id: entry.tool_call_id }),
        ...(entry.reasoning !== undefined && { reasoning: entry.reasoning }),
        ...(entry.reasoningBlocks !== undefined &&
          { reasoningBlocks: entry.reasoningBlocks }),
      };
    },
  );
  const encoded = JSON.stringify(normalizedJson({
    history,
    completedIterations: batch,
    tokenUsage: {
      inputTokens: checkpoint.tokenUsage.inputTokens,
      outputTokens: checkpoint.tokenUsage.outputTokens,
    },
    nudgeCount: checkpoint.nudgeCount,
    eosRetries: checkpoint.eosRetries,
    toolCallCounts,
  }, { left: 10_000 }));
  return new TextEncoder().encode(encoded).length <= MAX_CHECKPOINT_BYTES
    ? encoded
    : undefined;
}

function normalizedReceipts(receipts: readonly RecoveryToolReceipt[]) {
  if (
    !Array.isArray(receipts) || !receipts.length || receipts.length > MAX_TOOLS
  ) {
    throw new InvalidRecoveryProjection();
  }
  const ids = new Set<string>();
  const normalized = Array.from(receipts, (receipt: RecoveryToolReceipt) => {
    if (
      !receipt || typeof receipt.name !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.name) ||
      typeof receipt.callId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(receipt.callId) ||
      ids.has(receipt.callId) ||
      !Object.hasOwn(CLASSIFICATION_ORDER, receipt.classification) ||
      typeof receipt.resultSha256 !== "string" ||
      !digestPattern.test(receipt.resultSha256) ||
      (receipt.resourceId !== undefined &&
        (!Number.isSafeInteger(receipt.resourceId) ||
          receipt.resourceId < 1)) ||
      typeof receipt.args !== "object" || !receipt.args ||
      Array.isArray(receipt.args)
    ) throw new InvalidRecoveryProjection();
    ids.add(receipt.callId);
    return {
      name: receipt.name,
      callId: receipt.callId,
      args: normalizedJson(receipt.args, { left: 512 }),
      classification: receipt.classification,
      resultSha256: receipt.resultSha256,
      ...(receipt.resourceId !== undefined &&
        { resourceId: receipt.resourceId }),
    };
  });
  const encoded = JSON.stringify(normalized);
  if (new TextEncoder().encode(encoded).length > MAX_RECEIPT_BYTES) {
    throw new InvalidRecoveryProjection();
  }
  return { normalized, encoded };
}

function privateRecoveryFile(path: string): string {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  Deno.mkdirSync(parent, { mode: 0o700, recursive: true });
  const directory = Deno.lstatSync(parent);
  if (
    !directory.isDirectory || directory.isSymlink ||
    (directory.mode !== null && (directory.mode & 0o022) !== 0)
  ) {
    throw new Error("Agent recovery requires an operator-controlled directory");
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
    throw new Error("Agent recovery requires a private regular database file");
  }
  return absolute;
}

/** Hold exclusive ownership of one execution across async model and tool work. */
export function lockAgentRecovery(
  path: string,
  key: string,
): Deno.FsFile | undefined {
  if (!digestPattern.test(key)) return;
  const file = Deno.openSync(
    privateRecoveryFile(resolve(dirname(path), "agent-recovery-locks", key)),
    { write: true },
  );
  let locked = false;
  try {
    locked = file.tryLockSync(true);
    if (locked) return file;
  } finally {
    if (!locked) file.close();
  }
}

/** Install in the caller's transaction, including an attached recovery journal. */
export function installPausedRecovery(
  db: DatabaseSync,
  record: RecoverableState,
  schema: "main" | "archive_recovery" = "main",
): boolean {
  const { key, binding, committedBatch, checkpoint, tools } = record;
  if (
    !digestPattern.test(key) || !validBatch(committedBatch) ||
    !checkpoint || !Array.isArray(tools) || tools.length === 0
  ) return false;
  try {
    const encoded = normalizedCheckpoint(checkpoint, committedBatch);
    if (!encoded) return false;
    const receipts = normalizedReceipts(tools);
    const inserted = db.prepare(`
      INSERT INTO ${schema}.recoveries
        (key, binding, status, committedBatch, checkpoint, tools)
      VALUES (?, ?, 'ready', ?, ?, ?) ON CONFLICT(key) DO NOTHING
    `).run(
      key,
      validateBinding(binding),
      committedBatch,
      encoded,
      receipts.encoded,
    );
    if (inserted.changes !== 1) return false;
    db.prepare(`INSERT INTO ${schema}.recovery_pauses (key) VALUES (?)`).run(
      key,
    );
    return true;
  } catch (error) {
    if (error instanceof InvalidRecoveryProjection) return false;
    throw error;
  }
}

export class AgentRecoveryStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(privateRecoveryFile(path));
    try {
      this.#db.exec(
        "PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON;",
      );
      this.#transaction(() => {
        const applicationId = this.#db.prepare("PRAGMA application_id").get()
          ?.application_id;
        const version = this.#db.prepare("PRAGMA user_version").get()
          ?.user_version;
        if (applicationId === APPLICATION_ID && version === VERSION) {
          this.#createPauseTable();
          return;
        }
        if (
          applicationId !== 0 || version !== 0 ||
          this.#db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
        ) {
          throw new Error("Invalid agent recovery database or version");
        }
        this.#db.exec(`
          CREATE TABLE recoveries (
            key TEXT PRIMARY KEY,
            binding TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('ready', 'pending', 'finished')),
            committedBatch INTEGER NOT NULL DEFAULT 0,
            pendingBatch INTEGER,
            checkpoint TEXT,
            tools TEXT
          );
          PRAGMA application_id = ${APPLICATION_ID};
          PRAGMA user_version = ${VERSION};
        `);
        this.#createPauseTable();
      });
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #createPauseTable() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS recovery_pauses (
        key TEXT PRIMARY KEY REFERENCES recoveries(key)
      )
    `);
  }

  #transaction<T>(action: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  read(key: string): AgentRecoveryRecord | undefined {
    const row = this.#db.prepare(`
      SELECT recoveries.*, recovery_pauses.key IS NOT NULL AS paused
      FROM recoveries LEFT JOIN recovery_pauses USING (key)
      WHERE recoveries.key = ?
    `).get(
      validateKey(key),
    );
    if (!row) return;
    const state = {
      key: String(row.key),
      binding: String(row.binding),
      committedBatch: Number(row.committedBatch),
    };
    if (row.status === "finished") return { ...state, status: "finished" };
    const recoverable = {
      ...state,
      ...(typeof row.checkpoint === "string" && {
        checkpoint: JSON.parse(row.checkpoint) as AgentTurnCheckpoint,
      }),
      tools: typeof row.tools === "string"
        ? JSON.parse(row.tools) as RecoveryToolReceipt[]
        : [],
    };
    return row.status === "pending"
      ? {
        ...recoverable,
        status: "pending",
        pendingBatch: Number(row.pendingBatch),
      }
      : { ...recoverable, status: row.paused ? "paused" : "ready" };
  }

  pause(key: string): boolean {
    return this.#db.prepare(`
      INSERT OR IGNORE INTO recovery_pauses (key)
      SELECT key FROM recoveries WHERE key = ? AND status = 'ready'
        AND checkpoint IS NOT NULL
    `).run(validateKey(key)).changes === 1;
  }

  /** Queue a pause while the current owner is committing a tool batch. */
  requestPause(key: string): boolean {
    return this.#db.prepare(`
      INSERT INTO recovery_pauses (key)
      SELECT key FROM recoveries WHERE key = ?
        AND (status = 'pending' OR (status = 'ready' AND checkpoint IS NOT NULL))
      ON CONFLICT(key) DO UPDATE SET key = excluded.key
    `).run(validateKey(key)).changes === 1;
  }

  resumePaused(key: string, binding: string): boolean {
    return this.#db.prepare(`
      DELETE FROM recovery_pauses WHERE key = ? AND EXISTS (
        SELECT 1 FROM recoveries WHERE key = recovery_pauses.key
          AND binding = ? AND status = 'ready' AND checkpoint IS NOT NULL
      )
    `).run(validateKey(key), validateBinding(binding)).changes === 1;
  }

  restorePaused(
    record: RecoverableState,
    installKey?: RunArchiveRestoreKey,
  ): boolean {
    return this.#transaction(() =>
      restoreRunArchiveOnce(
        this.#db,
        installKey,
        () => installPausedRecovery(this.#db, record),
      )
    );
  }

  begin(key: string, binding: string): AgentRecoveryRecord | undefined {
    key = validateKey(key);
    binding = validateBinding(binding);
    return this.#transaction(() => {
      this.#db.prepare(
        "INSERT OR IGNORE INTO recoveries(key, binding, status) VALUES (?, ?, 'ready')",
      ).run(key, binding);
      const state = this.read(key);
      return state?.binding === binding ? state : undefined;
    });
  }

  beginBatch(
    key: string,
    binding: string,
    batch: number,
    expectedCommittedBatch?: number,
  ): boolean {
    key = validateKey(key);
    binding = validateBinding(binding);
    if (
      !validBatch(batch) ||
      (expectedCommittedBatch !== undefined &&
        (!Number.isSafeInteger(expectedCommittedBatch) ||
          expectedCommittedBatch < 0 || expectedCommittedBatch >= batch))
    ) return false;
    return Number(
      this.#db.prepare(`
      UPDATE recoveries SET status = 'pending', pendingBatch = ?
      WHERE key = ? AND binding = ? AND status = 'ready' AND committedBatch < ?
        AND NOT EXISTS (SELECT 1 FROM recovery_pauses WHERE key = recoveries.key)
        AND (? IS NULL OR committedBatch = ?)
    `).run(
          batch,
          key,
          binding,
          batch,
          expectedCommittedBatch ?? null,
          expectedCommittedBatch ?? null,
        ).changes,
    ) === 1;
  }

  commitBatch(
    key: string,
    binding: string,
    batch: number,
    checkpoint: AgentTurnCheckpoint,
    tools: readonly RecoveryToolReceipt[],
  ): boolean {
    key = validateKey(key);
    binding = validateBinding(binding);
    if (!validBatch(batch)) return false;
    let encoded: string | undefined;
    let receipts: ReturnType<typeof normalizedReceipts>;
    try {
      encoded = normalizedCheckpoint(checkpoint, batch);
      if (!encoded) return false;
      receipts = normalizedReceipts(tools);
    } catch (error) {
      if (error instanceof InvalidRecoveryProjection) return false;
      throw error;
    }
    return this.#transaction(() => {
      const previous = this.read(key);
      if (
        !previous || previous.binding !== binding ||
        previous.status !== "pending" ||
        previous.pendingBatch !== batch ||
        receipts.normalized.length <= previous.tools.length ||
        previous.tools.some((receipt, index) =>
          JSON.stringify(receipt) !== JSON.stringify(receipts.normalized[index])
        )
      ) return false;
      this.#db.prepare(`
        UPDATE recoveries SET status = 'ready', committedBatch = ?, pendingBatch = NULL,
          checkpoint = ?, tools = ?
        WHERE key = ?
      `).run(batch, encoded!, receipts.encoded, key);
      return true;
    });
  }

  finish(
    key: string,
    binding: string,
    expectedCommittedBatch?: number,
  ): boolean {
    key = validateKey(key);
    binding = validateBinding(binding);
    if (
      expectedCommittedBatch !== undefined &&
      (!Number.isSafeInteger(expectedCommittedBatch) ||
        expectedCommittedBatch < 0 || expectedCommittedBatch > MAX_BATCH)
    ) return false;
    return Number(
      this.#db.prepare(`
      UPDATE recoveries SET status = 'finished', checkpoint = NULL, tools = NULL
      WHERE key = ? AND binding = ? AND status = 'ready'
        AND NOT EXISTS (SELECT 1 FROM recovery_pauses WHERE key = recoveries.key)
        AND (? IS NULL OR committedBatch = ?)
    `).run(
          key,
          binding,
          expectedCommittedBatch ?? null,
          expectedCommittedBatch ?? null,
        ).changes,
    ) === 1;
  }

  close(): void {
    this.#db.close();
  }
}
