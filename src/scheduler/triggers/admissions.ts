/** Persist trigger identity, hashes and lease state without recording prompt text. */
import type { ClassificationLevel } from "../../core/types/classification.ts";
import { schedulerAdmissionDatabase } from "../admission_database.ts";

export interface SchedulerTriggerAdmission {
  readonly id: string;
  readonly occurrence: string;
  readonly admittedAt: number;
  readonly instructionSource: "file" | "memory";
  readonly instructionsSha256: string;
  readonly historySha256: string;
  readonly promptSha256: string;
  readonly policySha256: string;
  readonly classificationCeiling: ClassificationLevel;
}

export interface SchedulerTriggerClaim {
  readonly admission: SchedulerTriggerAdmission;
  readonly token: string;
}

export type SchedulerTriggerOutcome =
  | "completed"
  | "policy_changed"
  | "instructions_changed"
  | "history_unavailable"
  | "input_changed"
  | "execution_unavailable";

export interface SchedulerTriggerAdmissions {
  /** True only when this call creates a new occurrence. */
  admit(admission: SchedulerTriggerAdmission): boolean;
  has(id: string): boolean;
  available(
    eligible?: (id: string) => boolean,
  ): readonly SchedulerTriggerAdmission[];
  claim(id: string): SchedulerTriggerClaim | undefined;
  release(claim: SchedulerTriggerClaim): boolean;
  finish(
    claim: SchedulerTriggerClaim,
    outcome: SchedulerTriggerOutcome,
  ): boolean;
  readOutcome(id: string): SchedulerTriggerOutcome | undefined;
}

const fields =
  "id, occurrence, admittedAt, instructionSource, instructionsSha256, historySha256, promptSha256, policySha256, classificationCeiling";
const digest = /^[a-f0-9]{64}$/;
const occurrencePattern =
  /^(?:manual:[a-f0-9-]{36}|periodic:[1-9]\d{0,12}:\d{1,16})$/;

export function parseTriggerAdmission(
  row: Record<string, unknown> | undefined,
): SchedulerTriggerAdmission | undefined {
  if (!row) return undefined;
  const {
    id,
    occurrence,
    admittedAt,
    instructionSource,
    instructionsSha256,
    historySha256,
    promptSha256,
    policySha256,
    classificationCeiling,
  } = row;
  if (
    typeof id !== "string" || !/^scheduler-trigger-[a-f0-9]{64}$/.test(id) ||
    typeof occurrence !== "string" || !occurrencePattern.test(occurrence) ||
    typeof admittedAt !== "number" || !Number.isSafeInteger(admittedAt) ||
    admittedAt < 0 ||
    (instructionSource !== "file" && instructionSource !== "memory") ||
    typeof instructionsSha256 !== "string" ||
    !digest.test(instructionsSha256) ||
    typeof historySha256 !== "string" || !digest.test(historySha256) ||
    typeof promptSha256 !== "string" || !digest.test(promptSha256) ||
    typeof policySha256 !== "string" || !digest.test(policySha256) ||
    (classificationCeiling !== "PUBLIC" &&
      classificationCeiling !== "INTERNAL" &&
      classificationCeiling !== "CONFIDENTIAL" &&
      classificationCeiling !== "RESTRICTED")
  ) return undefined;
  return {
    id,
    occurrence,
    admittedAt,
    instructionSource,
    instructionsSha256,
    historySha256,
    promptSha256,
    policySha256,
    classificationCeiling,
  };
}

export function openSchedulerTriggerAdmissions(
  path: string,
  options: { readonly now?: () => number; readonly leaseMs?: number } = {},
): SchedulerTriggerAdmissions {
  const withDatabase = schedulerAdmissionDatabase(path);
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? 300_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
    throw new Error("Invalid scheduler trigger admission lease.");
  }
  withDatabase((db) =>
    db.exec(`
    CREATE TABLE IF NOT EXISTS trigger_admissions (
      id TEXT PRIMARY KEY,
      occurrence TEXT NOT NULL,
      admittedAt INTEGER NOT NULL,
      instructionSource TEXT NOT NULL,
      instructionsSha256 TEXT NOT NULL,
      historySha256 TEXT NOT NULL,
      promptSha256 TEXT NOT NULL,
      policySha256 TEXT NOT NULL,
      classificationCeiling TEXT NOT NULL,
      leaseToken TEXT,
      leaseUntil INTEGER,
      outcome TEXT
    );
    CREATE INDEX IF NOT EXISTS trigger_admissions_available
      ON trigger_admissions(outcome, admittedAt, leaseUntil);
  `)
  );
  return {
    admit(input) {
      if (!parseTriggerAdmission({ ...input })) {
        throw new Error("Invalid scheduler trigger admission.");
      }
      const {
        id,
        occurrence,
        admittedAt,
        instructionSource,
        instructionsSha256,
        historySha256,
        promptSha256,
        policySha256,
        classificationCeiling,
      } = input;
      return withDatabase((db) => {
        db.exec(`
          DELETE FROM trigger_admissions WHERE id IN (
            SELECT id FROM trigger_admissions WHERE outcome IS NOT NULL
            ORDER BY admittedAt DESC, id LIMIT -1 OFFSET 128
          )
        `);
        return db.prepare(
          `INSERT OR IGNORE INTO trigger_admissions (${fields}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .run(
            id,
            occurrence,
            admittedAt,
            instructionSource,
            instructionsSha256,
            historySha256,
            promptSha256,
            policySha256,
            classificationCeiling,
          ).changes === 1;
      });
    },
    has(id) {
      return withDatabase((db) =>
        db.prepare("SELECT 1 FROM trigger_admissions WHERE id = ?").get(id) !==
          undefined
      );
    },
    available(eligible) {
      return withDatabase((db) => {
        const time = now();
        const query = db.prepare(`
          SELECT ${fields} FROM trigger_admissions
          WHERE outcome IS NULL AND (leaseUntil IS NULL OR leaseUntil <= ?) AND admittedAt <= ?
          ORDER BY admittedAt, id LIMIT 16 OFFSET ?
        `);
        const selected: SchedulerTriggerAdmission[] = [];
        for (let offset = 0; selected.length < 16; offset += 16) {
          const page = query.all(time, time, offset);
          for (const row of page) {
            const candidate = parseTriggerAdmission(row);
            if (candidate && (!eligible || eligible(candidate.id))) {
              selected.push(candidate);
              if (selected.length === 16) break;
            }
          }
          if (page.length < 16) break;
        }
        return selected;
      });
    },
    claim(id) {
      return withDatabase((db) => {
        const token = crypto.randomUUID();
        const time = now();
        const admission = parseTriggerAdmission(
          db.prepare(`
          UPDATE trigger_admissions SET leaseToken = ?, leaseUntil = ?
          WHERE id = ? AND outcome IS NULL AND (leaseUntil IS NULL OR leaseUntil <= ?) AND admittedAt <= ?
          RETURNING ${fields}
        `).get(token, time + leaseMs, id, time, time),
        );
        return admission ? { admission, token } : undefined;
      });
    },
    release({ admission, token }) {
      return withDatabase((db) =>
        db.prepare(`
        UPDATE trigger_admissions SET leaseToken = NULL, leaseUntil = NULL
        WHERE id = ? AND outcome IS NULL AND leaseToken = ?
      `).run(admission.id, token).changes === 1
      );
    },
    finish({ admission, token }, outcome) {
      return withDatabase((db) =>
        db.prepare(`
        UPDATE trigger_admissions SET outcome = ?, leaseToken = NULL, leaseUntil = NULL
        WHERE id = ? AND outcome IS NULL AND leaseToken = ?
      `).run(outcome, admission.id, token).changes === 1
      );
    },
    readOutcome(id) {
      const outcome = withDatabase((db) =>
        db.prepare("SELECT outcome FROM trigger_admissions WHERE id = ?").get(
          id,
        )?.outcome
      );
      if (
        outcome === "completed" || outcome === "policy_changed" ||
        outcome === "instructions_changed" ||
        outcome === "history_unavailable" ||
        outcome === "input_changed" || outcome === "execution_unavailable"
      ) return outcome;
    },
  };
}
