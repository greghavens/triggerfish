/** Durable evidence-gated goal completion shared by trusted application adapters. */
/// <reference path="./sqlite_types.d.ts" />
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { dirname, resolve } from "@std/path";
import {
  canFlowTo,
  type ClassificationLevel,
  maxClassification,
  parseClassification,
} from "./types/classification.ts";

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

export interface GoalEvidenceSubmission {
  readonly requestId: string;
  readonly binding: string;
  readonly criterionId: string;
  readonly source: string;
  readonly reference: string;
}

export interface GoalEvidenceSubmissionReceipt {
  readonly criterionId: string;
  readonly status: GoalCompletionStatus;
  readonly proof: GoalEvidence;
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

export interface GoalRegistration {
  readonly requestId: string;
  readonly revisesRequestId?: string;
  readonly record: GoalCompletionRecord;
  readonly classification: ClassificationLevel;
  readonly afterSequence?: number;
}

/** Bind approval to the goal and exact verified observations across completion. */
export function goalConfirmationDigest(record: GoalCompletionRecord): string {
  return createHash("sha256").update(JSON.stringify([
    record.scope,
    record.goal,
    record.criteria,
    record.policy,
    record.observations,
  ])).digest("hex");
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
const REGISTRATION_REQUEST_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function registrationId(requestId: string): string {
  if (requestId !== "legacy" && !REGISTRATION_REQUEST_ID.test(requestId)) {
    throw new Error("Invalid goal registration request ID");
  }
  return requestId;
}

function registrationClassification(value: unknown): ClassificationLevel {
  const parsed = parseClassification(String(value));
  return parsed.ok ? parsed.value : "RESTRICTED";
}

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

  hasScopePrefix(prefix: string): boolean {
    prefix = text(prefix, "scope prefix", 256);
    return !!this.#db.prepare(
      "SELECT 1 FROM goal_completion WHERE substr(scope, 1, length(?)) = ? LIMIT 1",
    ).get(prefix, prefix);
  }

  register(
    scope: string,
    goal: string,
    criteria: readonly GoalCriterion[],
    policy: GoalCompletionPolicy,
  ): GoalCompletionRecord {
    return this.#transaction(() => {
      return this.#register(scope, goal, criteria, policy);
    });
  }

  #register(
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
  }

  #hasRegistrations(): boolean {
    return !!this.#db.prepare(`SELECT 1 FROM sqlite_schema
      WHERE type = 'table' AND name = 'goal_completion_registrations'`).get();
  }

  /** Read the current registration or an exact historical one in this family. */
  readRegistration(
    family: string,
    requestId?: string,
  ): GoalRegistration | undefined {
    family = text(family, "registration family", 256);
    if (requestId !== undefined) registrationId(requestId);
    if (this.#hasRegistrations()) {
      const row = requestId === undefined
        ? this.#db.prepare(
          `SELECT *
          FROM goal_completion_registrations WHERE family = ?
          ORDER BY position DESC LIMIT 1`,
        ).get(family)
        : this.#db.prepare(
          `SELECT *
          FROM goal_completion_registrations WHERE family = ? AND requestId = ?`,
        )
          .get(family, requestId);
      if (row) {
        const record = this.read(String(row.goalScope));
        if (!record) throw new Error("Goal registration is missing its record");
        return {
          requestId: String(row.requestId),
          ...(typeof row.revisesRequestId === "string" &&
            { revisesRequestId: row.revisesRequestId }),
          afterSequence: Number(row.afterSequence),
          classification: registrationClassification(row.classification),
          record,
        };
      }
    }
    if (requestId === undefined || requestId === "legacy") {
      const record = this.read(family);
      if (record) {
        return { requestId: "legacy", record, classification: "RESTRICTED" };
      }
    }
  }

  /** Register a successor or revise the exact current goal without altering its proof. */
  registerSuccessive(
    family: string,
    requestId: string | undefined,
    goal: string,
    criteria: readonly GoalCriterion[],
    policy: GoalCompletionPolicy,
    afterSequence: number,
    classification: ClassificationLevel,
    revisesRequestId?: string,
  ): GoalRegistration {
    family = text(family, "registration family", 256);
    if (
      requestId !== undefined &&
      (typeof requestId !== "string" ||
        !REGISTRATION_REQUEST_ID.test(requestId))
    ) throw new Error("Invalid goal registration request ID");
    if (revisesRequestId !== undefined) {
      registrationId(revisesRequestId);
      if (!requestId || revisesRequestId === requestId) {
        throw new Error("A goal revision requires a new requestId");
      }
    }
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error("Invalid goal evidence boundary");
    }
    if (!parseClassification(classification).ok) {
      throw new Error("Invalid goal registration classification");
    }
    const id = requestId ?? "legacy";
    return this.#transaction(() => {
      const prior = this.readRegistration(family, id);
      if (prior) {
        if (!canFlowTo(prior.classification, classification)) {
          throw new Error(
            "Goal registration is unavailable at this classification",
          );
        }
        if (prior.revisesRequestId !== revisesRequestId) {
          throw new Error("Conflicting goal registration request");
        }
        this.#register(prior.record.scope, goal, criteria, policy);
        return prior;
      }
      const current = this.readRegistration(family);
      if (current && !canFlowTo(current.classification, classification)) {
        throw new Error(
          "Goal registration is unavailable at this classification",
        );
      }
      if (current && requestId === undefined) {
        throw new Error("A successor goal requires a new requestId");
      }
      if (revisesRequestId !== undefined) {
        if (!current || current.requestId !== revisesRequestId) {
          throw new Error(
            "The expected goal registration is no longer current",
          );
        }
        if (current.record.status === "completed") {
          throw new Error("A completed goal can only have a successor");
        }
      } else if (current && current.record.status !== "completed") {
        throw new Error(
          "Complete the current goal before registering a successor",
        );
      }
      const record = this.#register(
        requestId === undefined ? family : `${family}:goal:${requestId}`,
        goal,
        criteria,
        policy,
      );
      this.#db.exec(`CREATE TABLE IF NOT EXISTS goal_completion_registrations (
        position INTEGER PRIMARY KEY,
        family TEXT NOT NULL,
        requestId TEXT NOT NULL,
        goalScope TEXT NOT NULL UNIQUE REFERENCES goal_completion(scope),
        afterSequence INTEGER NOT NULL CHECK(afterSequence >= 0),
        classification TEXT NOT NULL CHECK(classification IN (
          'PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'
        )),
        revisesRequestId TEXT,
        UNIQUE(family, requestId)
      ) STRICT`);
      this.#db.prepare(
        `INSERT INTO goal_completion_registrations
          (family, requestId, goalScope, afterSequence, classification)
          VALUES (?, ?, ?, ?, ?)`,
      )
        .run(family, id, record.scope, afterSequence, classification);
      if (revisesRequestId !== undefined) {
        if (
          !this.#db.prepare("PRAGMA table_info(goal_completion_registrations)")
            .all().some(({ name }) => name === "revisesRequestId")
        ) {
          this.#db.exec(`ALTER TABLE goal_completion_registrations
            ADD COLUMN revisesRequestId TEXT`);
        }
        this.#db.prepare(`UPDATE goal_completion_registrations
          SET revisesRequestId = ? WHERE family = ? AND requestId = ?`)
          .run(revisesRequestId, family, id);
      }
      return {
        requestId: id,
        ...(revisesRequestId !== undefined && { revisesRequestId }),
        record,
        afterSequence,
        classification,
      };
    });
  }

  /** Page newest-first registrations, including the initial legacy record. */
  registrationHistory(family: string, before?: string) {
    family = text(family, "registration family", 256);
    if (before !== undefined) registrationId(before);
    if (before === "legacy") return { registrations: [], nextBefore: null };
    const limit = 20;
    const hasRegistrations = this.#hasRegistrations();
    const cursor = before && hasRegistrations
      ? this.#db.prepare(
        `SELECT position FROM goal_completion_registrations
        WHERE family = ? AND requestId = ?`,
      ).get(family, before)?.position
      : undefined;
    if (before !== undefined && cursor === undefined) {
      throw new Error("Unknown goal registration");
    }
    const rows = hasRegistrations
      ? this.#db.prepare(
        `SELECT *
        FROM goal_completion_registrations
        WHERE family = ? AND (? IS NULL OR position < ?)
        ORDER BY position DESC LIMIT ?`,
      )
        .all(family, cursor ?? null, cursor ?? null, limit + 1)
      : [];
    const registrations: GoalRegistration[] = rows.map((row) => {
      const record = this.read(String(row.goalScope));
      if (!record) throw new Error("Goal registration is missing its record");
      return {
        requestId: String(row.requestId),
        ...(typeof row.revisesRequestId === "string" &&
          { revisesRequestId: row.revisesRequestId }),
        afterSequence: Number(row.afterSequence),
        classification: registrationClassification(row.classification),
        record,
      };
    });
    if (
      registrations.length <= limit &&
      !registrations.some(({ requestId }) => requestId === "legacy")
    ) {
      const legacy = this.readRegistration(family, "legacy");
      if (legacy) registrations.push(legacy);
    }
    const page = registrations.slice(0, limit);
    return {
      registrations: page,
      nextBefore: registrations.length > limit ? page.at(-1)!.requestId : null,
    };
  }

  read(scope: string): GoalCompletionRecord | undefined {
    const row = this.#lookup.get(text(scope, "scope", 256));
    return typeof row?.record === "string"
      ? JSON.parse(row.record) as GoalCompletionRecord
      : undefined;
  }

  /** Report evidence and commit its classification with the decision. */
  reportRegistration(
    family: string,
    requestId: string,
    observations: readonly GoalObservation[],
    verify: EvidenceVerifier,
    classification: ClassificationLevel,
    operatorConfirmed = false,
    expectedDecisionSha256?: string,
  ): GoalCompletionRecord {
    if (
      typeof verify !== "function" || typeof operatorConfirmed !== "boolean" ||
      !parseClassification(classification).ok
    ) throw new Error("Goal completion requires a trusted evidence verifier");
    if (
      expectedDecisionSha256 !== undefined &&
      (!operatorConfirmed || typeof expectedDecisionSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(expectedDecisionSha256))
    ) throw new Error("Invalid goal confirmation decision digest");
    if (
      operatorConfirmed && requestId !== "legacy" &&
      expectedDecisionSha256 === undefined
    ) throw new Error("This goal requires an exact confirmation decision");
    return this.#transaction(() => {
      const current = this.readRegistration(family, requestId);
      if (!current || !canFlowTo(current.classification, classification)) {
        throw new Error(
          "Goal registration is unavailable at this classification",
        );
      }
      if (expectedDecisionSha256 !== undefined) {
        if (current.record.policy !== "operator") {
          throw new Error("This goal does not require operator confirmation");
        }
        if (goalConfirmationDigest(current.record) !== expectedDecisionSha256) {
          throw new Error("The goal confirmation decision has changed");
        }
        if (current.record.status === "completed") return current.record;
        if (current.record.status !== "awaiting_confirmation") {
          throw new Error("The goal is not awaiting confirmation");
        }
      }
      if (this.readRegistration(family)?.requestId !== requestId) {
        throw new Error("The goal registration is no longer current");
      }
      const record = this.#report(
        current.record.scope,
        observations,
        verify,
        operatorConfirmed,
        current.record,
        expectedDecisionSha256,
      );
      const label = maxClassification(current.classification, classification);
      if (
        label !== current.classification && record !== current.record
      ) {
        this.#db.prepare(
          `UPDATE goal_completion_registrations SET classification = ?
          WHERE family = ? AND requestId = ?`,
        ).run(label, family, requestId);
      }
      return record;
    });
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
    return this.#transaction(() =>
      this.#report(scope, observations, verify, operatorConfirmed)
    );
  }

  #report(
    scope: string,
    observations: readonly GoalObservation[],
    verify: EvidenceVerifier,
    operatorConfirmed: boolean,
    previous = this.read(scope),
    expectedDecisionSha256?: string,
  ) {
    if (!previous) throw new Error("Goal completion scope is not registered");
    if (previous.status === "completed") return previous;
    const supplied = normalizeObservations(observations, previous.criteria);
    const verified = verifyObservations(previous, supplied, verify);
    const satisfied = verified.length === previous.criteria.length;
    if (
      expectedDecisionSha256 !== undefined &&
      (!satisfied ||
        goalConfirmationDigest({ ...previous, observations: verified }) !==
          expectedDecisionSha256)
    ) throw new Error("The goal confirmation evidence could not be reverified");
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
  }

  readEvidenceSubmission(
    scope: string,
    requestId: string,
  ) {
    if (
      !this.#db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'goal_evidence_submissions'",
      ).get()
    ) return;
    const row = this.#db.prepare(
      "SELECT binding, receipt FROM goal_evidence_submissions WHERE scope = ? AND requestId = ?",
    )
      .get(scope, requestId);
    if (!row) return;
    return {
      binding: String(row.binding),
      receipt: JSON.parse(String(row.receipt)) as GoalEvidenceSubmissionReceipt,
    };
  }

  reportEvidenceSubmission(
    scope: string,
    observations: readonly GoalObservation[],
    verify: EvidenceVerifier,
    request: GoalEvidenceSubmission,
  ): GoalEvidenceSubmissionReceipt {
    if (
      !/^[0-9a-f]{64}$/.test(request.binding) ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.requestId)
    ) {
      throw new Error("Invalid goal evidence submission");
    }
    return this.#transaction(() => {
      const existing = this.readEvidenceSubmission(scope, request.requestId);
      if (existing) {
        if (existing.binding !== request.binding) {
          throw new Error("Conflicting goal evidence request");
        }
        return existing.receipt;
      }
      const record = this.#report(scope, observations, verify, false);
      const proof = record.observations.find(({ criterionId }) =>
        criterionId === request.criterionId
      )?.evidence.find(({ source, reference }) =>
        source === request.source && reference === request.reference
      );
      if (!proof) {
        throw new Error("The submitted goal evidence could not be verified");
      }
      this.#db.exec(`CREATE TABLE IF NOT EXISTS goal_evidence_submissions (
        scope TEXT NOT NULL REFERENCES goal_completion(scope),
        requestId TEXT NOT NULL,
        binding TEXT NOT NULL,
        receipt TEXT NOT NULL,
        PRIMARY KEY(scope, requestId)
      ) STRICT`);
      if (
        Number(
          this.#db.prepare(
            "SELECT COUNT(*) AS count FROM goal_evidence_submissions WHERE scope = ?",
          ).get(scope)?.count,
        ) >= 512
      ) {
        throw new Error("Goal evidence submission receipt capacity reached");
      }
      const receipt = {
        criterionId: request.criterionId,
        status: record.status,
        proof,
      };
      this.#db.prepare(
        "INSERT INTO goal_evidence_submissions VALUES (?, ?, ?, ?)",
      )
        .run(
          scope,
          request.requestId,
          request.binding,
          JSON.stringify(receipt),
        );
      return receipt;
    });
  }

  close(): void {
    this.#db.close();
  }
}
