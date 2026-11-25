/** Durable evidence-gated goal completion shared by trusted application adapters. */
/// <reference path="../sentinel/sqlite_types.d.ts" />
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "@std/path";

export type GoalCompletionPolicy = "automatic" | "operator";
export type GoalCompletionStatus =
  | "open"
  | "awaiting_confirmation"
  | "completed";

export interface GoalCriterion {
  readonly id: string;
  readonly description: string;
  readonly requirement?: string;
}

export interface GoalEvidence {
  readonly source: string;
  readonly reference: string;
  readonly detail: string;
}

export interface GoalObservation {
  readonly criterionId: string;
  readonly evidence: readonly GoalEvidence[];
}

export interface GoalCompletionRecord {
  readonly scope: string;
  readonly goal: string;
  readonly criteria: readonly GoalCriterion[];
  readonly policy: GoalCompletionPolicy;
  readonly status: GoalCompletionStatus;
  readonly observations: readonly GoalObservation[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

/** Summarize each registered criterion's verified evidence status in order. */
export function summarizeGoalCriteria(record: GoalCompletionRecord): {
  readonly open: readonly string[];
  readonly satisfied: readonly string[];
} {
  const verified = new Set(
    record.observations.filter(({ evidence }) => evidence.length)
      .map(({ criterionId }) => criterionId),
  );
  const ids = record.criteria.map(({ id }) => id);
  return {
    open: ids.filter((id) => !verified.has(id)),
    satisfied: ids.filter((id) => verified.has(id)),
  };
}

type EvidenceVerifier = (
  criterionId: string,
  evidence: GoalEvidence,
) => boolean;
const MAX_CRITERIA = 32;
const MAX_EVIDENCE_PER_CRITERION = 16;
const MAX_RECORD_BYTES = 128 * 1024;

function encodeRecord(record: GoalCompletionRecord): string {
  const encoded = JSON.stringify(record);
  if (new TextEncoder().encode(encoded).length > MAX_RECORD_BYTES) {
    throw new Error("Goal completion record exceeds storage bound");
  }
  return encoded;
}

function text(value: unknown, field: string, limit: number): string {
  if (
    typeof value !== "string" || !value.trim() || value.length > limit ||
    value.includes("\x00")
  ) {
    throw new Error(`Invalid goal completion ${field}`);
  }
  return value;
}

function normalizeCriteria(criteria: readonly GoalCriterion[]) {
  if (
    !Array.isArray(criteria) || !criteria.length ||
    criteria.length > MAX_CRITERIA
  ) {
    throw new Error("Invalid goal completion criteria");
  }
  const normalized = Array.from(criteria, (criterion) => ({
    id: text(criterion?.id, "criterion ID", 256),
    description: text(criterion?.description, "description", 1000),
    ...(criterion?.requirement !== undefined && {
      requirement: text(criterion.requirement, "requirement", 1024),
    }),
  }));
  if (new Set(normalized.map(({ id }) => id)).size !== normalized.length) {
    throw new Error("Duplicate goal completion criterion ID");
  }
  return normalized;
}

function normalizeObservations(
  observations: readonly GoalObservation[],
  criteria: readonly GoalCriterion[],
) {
  if (!Array.isArray(observations) || observations.length > MAX_CRITERIA) {
    throw new Error("Invalid goal completion observations");
  }
  const ids = new Set(criteria.map(({ id }) => id));
  return Array.from(observations, (observation) => {
    if (
      !observation || !ids.has(observation.criterionId) ||
      !Array.isArray(observation.evidence) ||
      observation.evidence.length > MAX_EVIDENCE_PER_CRITERION
    ) {
      throw new Error("Invalid goal completion observation");
    }
    return {
      criterionId: observation.criterionId,
      evidence: Array.from(
        observation.evidence as readonly GoalEvidence[],
        (evidence) => ({
          source: text(evidence?.source, "evidence source", 256),
          reference: text(evidence?.reference, "evidence reference", 4096),
          detail: text(evidence?.detail, "evidence detail", 2000),
        }),
      ),
    };
  });
}

function verifyObservations(
  record: GoalCompletionRecord,
  observations: readonly GoalObservation[],
  verify: EvidenceVerifier,
): GoalObservation[] {
  const evidenceByCriterion = new Map(
    record.criteria.map(({ id }) => [id, new Map<string, GoalEvidence>()]),
  );
  const checked = new Set<string>();
  for (const entry of [...record.observations, ...observations]) {
    const retained = evidenceByCriterion.get(entry.criterionId)!;
    for (const evidence of entry.evidence) {
      const checkKey = JSON.stringify([entry.criterionId, evidence]);
      if (checked.has(checkKey)) continue;
      checked.add(checkKey);
      if (verify(entry.criterionId, { ...evidence }) === true) {
        retained.set(
          JSON.stringify([evidence.source, evidence.reference]),
          evidence,
        );
      }
    }
  }
  return [...evidenceByCriterion].flatMap(([criterionId, retained]) => {
    if (retained.size > MAX_EVIDENCE_PER_CRITERION) {
      throw new Error("Too many verified facts for goal completion criterion");
    }
    return retained.size
      ? [{ criterionId, evidence: [...retained.values()] }]
      : [];
  });
}

function openPrivateGoalDatabase(path: string) {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  Deno.mkdirSync(parent, { mode: 0o700, recursive: true });
  const directory = Deno.lstatSync(parent);
  if (
    !directory.isDirectory || directory.isSymlink ||
    (directory.mode !== null && (directory.mode & 0o022) !== 0)
  ) {
    throw new Error(
      "Goal completion requires an operator-controlled directory",
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
    throw new Error("Goal completion requires a private regular database file");
  }
  return new DatabaseSync(absolute);
}

export class GoalCompletionStore {
  readonly #db: DatabaseSync;
  readonly #lookup: ReturnType<DatabaseSync["prepare"]>;
  readonly #insert: ReturnType<DatabaseSync["prepare"]>;
  readonly #update: ReturnType<DatabaseSync["prepare"]>;
  readonly #now: () => number;

  constructor(path: string, now = Date.now) {
    this.#db = openPrivateGoalDatabase(path);
    this.#now = now;
    try {
      this.#db.exec("PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;");
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS goal_completion (
          scope TEXT PRIMARY KEY,
          record TEXT NOT NULL
        );`);
      this.#lookup = this.#db.prepare(
        "SELECT record FROM goal_completion WHERE scope = ?",
      );
      this.#insert = this.#db.prepare(
        "INSERT INTO goal_completion VALUES (?, ?)",
      );
      this.#update = this.#db.prepare(
        "UPDATE goal_completion SET record = ? WHERE scope = ?",
      );
    } catch (error) {
      this.#db.close();
      throw error;
    }
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

  register(
    scope: string,
    goal: string,
    criteria: readonly GoalCriterion[],
    policy: GoalCompletionPolicy,
  ): GoalCompletionRecord {
    scope = text(scope, "scope", 256);
    goal = text(goal, "goal", 4000);
    const normalized = normalizeCriteria(criteria);
    if (policy !== "automatic" && policy !== "operator") {
      throw new Error("Invalid goal completion policy");
    }
    return this.#transaction(() => {
      const previous = this.read(scope);
      if (previous) {
        if (
          previous.goal !== goal || previous.policy !== policy ||
          JSON.stringify(previous.criteria) !== JSON.stringify(normalized)
        ) {
          throw new Error(
            "Goal completion scope is already registered with different criteria",
          );
        }
        return previous;
      }
      const at = new Date(this.#now()).toISOString();
      const record: GoalCompletionRecord = {
        scope,
        goal,
        criteria: normalized,
        policy,
        status: "open",
        observations: [],
        createdAt: at,
        updatedAt: at,
      };
      this.#insert.run(scope, encodeRecord(record));
      return record;
    });
  }

  read(scope: string): GoalCompletionRecord | undefined {
    const row = this.#lookup.get(text(scope, "scope", 256));
    return typeof row?.record === "string"
      ? JSON.parse(row.record) as GoalCompletionRecord
      : undefined;
  }

  report(
    scope: string,
    observations: readonly GoalObservation[],
    verify: EvidenceVerifier,
    operatorConfirmed = false,
  ): GoalCompletionRecord {
    if (
      typeof verify !== "function" || typeof operatorConfirmed !== "boolean"
    ) {
      throw new Error("Goal completion requires a trusted evidence verifier");
    }
    return this.#transaction(() => {
      const previous = this.read(scope);
      if (!previous) throw new Error("Goal completion scope is not registered");
      if (previous.status === "completed") return previous;
      const supplied = normalizeObservations(observations, previous.criteria);
      const verified = verifyObservations(previous, supplied, verify);
      const satisfied = verified.length === previous.criteria.length;
      const status = !satisfied
        ? "open"
        : previous.policy === "automatic" || operatorConfirmed
        ? "completed"
        : "awaiting_confirmation";
      if (
        status === previous.status &&
        JSON.stringify(verified) === JSON.stringify(previous.observations)
      ) return previous;
      const at = new Date(this.#now()).toISOString();
      const record: GoalCompletionRecord = {
        ...previous,
        status,
        observations: verified,
        updatedAt: at,
        ...(status === "completed" && { completedAt: at }),
      };
      this.#update.run(encodeRecord(record), scope);
      return record;
    });
  }

  close(): void {
    this.#db.close();
  }
}
