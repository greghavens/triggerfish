/** Lease durable cron occurrences without retaining prompt text. */
import { schedulerAdmissionDatabase } from "../admission_database.ts";
import type { ClassificationLevel } from "../../core/types/classification.ts";

export interface SchedulerCronAdmission {
  readonly id: string;
  readonly jobId: string;
  readonly occurrence: number;
  readonly promptSha256: string;
  readonly classificationCeiling: ClassificationLevel;
}

export interface SchedulerCronClaim {
  readonly admission: SchedulerCronAdmission;
  readonly token: string;
}

export interface SchedulerCronAdmissions {
  admit(admission: SchedulerCronAdmission): void;
  available(): readonly SchedulerCronAdmission[];
  claim(id: string): SchedulerCronClaim | undefined;
  finish(claim: SchedulerCronClaim): boolean;
}

const fields = "id, jobId, occurrence, promptSha256, classificationCeiling";

function parseAdmission(
  row: Record<string, unknown> | undefined,
): SchedulerCronAdmission | undefined {
  if (!row) return undefined;
  const { id, jobId, occurrence, promptSha256, classificationCeiling } = row;
  if (
    typeof id !== "string" || !/^scheduler-cron-[a-f0-9]{64}$/.test(id) ||
    typeof jobId !== "string" || !jobId || typeof occurrence !== "number" ||
    !Number.isSafeInteger(occurrence) || occurrence < 0 ||
    typeof promptSha256 !== "string" || !/^[a-f0-9]{64}$/.test(promptSha256) ||
    (classificationCeiling !== "PUBLIC" &&
      classificationCeiling !== "INTERNAL" &&
      classificationCeiling !== "CONFIDENTIAL" &&
      classificationCeiling !== "RESTRICTED")
  ) return undefined;
  return { id, jobId, occurrence, promptSha256, classificationCeiling };
}

export function openSchedulerCronAdmissions(
  path: string,
  options: { readonly now?: () => number; readonly leaseMs?: number } = {},
): SchedulerCronAdmissions {
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? 300_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
    throw new Error("Invalid scheduler cron admission lease.");
  }
  const withDatabase = schedulerAdmissionDatabase(path);
  withDatabase((db) =>
    db.exec(`
    CREATE TABLE IF NOT EXISTS cron_admissions (
      id TEXT PRIMARY KEY,
      jobId TEXT NOT NULL,
      occurrence INTEGER NOT NULL,
      promptSha256 TEXT NOT NULL,
      classificationCeiling TEXT NOT NULL,
      leaseToken TEXT,
      leaseUntil INTEGER,
      closed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS cron_admissions_available
      ON cron_admissions(closed, occurrence, leaseUntil);
  `)
  );
  return {
    admit({ id, jobId, occurrence, promptSha256, classificationCeiling }) {
      withDatabase((db) => {
        db.prepare(
          "DELETE FROM cron_admissions WHERE closed = 1 AND occurrence < ?",
        )
          .run(occurrence - 1);
        db.prepare(
          `INSERT OR IGNORE INTO cron_admissions (${fields}) VALUES (?, ?, ?, ?, ?)`,
        )
          .run(id, jobId, occurrence, promptSha256, classificationCeiling);
      });
    },
    available() {
      return withDatabase((db) => {
        const time = now();
        return db.prepare(`
          SELECT ${fields} FROM cron_admissions
          WHERE closed = 0 AND (leaseUntil IS NULL OR leaseUntil <= ?) AND occurrence <= ?
          ORDER BY occurrence, id LIMIT 32
        `).all(time, Math.floor(time / 60_000)).flatMap((row) =>
          parseAdmission(row) ?? []
        );
      });
    },
    claim(id) {
      return withDatabase((db) => {
        const token = crypto.randomUUID();
        const time = now();
        const admission = parseAdmission(
          db.prepare(`
          UPDATE cron_admissions SET leaseToken = ?, leaseUntil = ?
          WHERE id = ? AND closed = 0 AND (leaseUntil IS NULL OR leaseUntil <= ?)
          RETURNING ${fields}
        `).get(token, time + leaseMs, id, time),
        );
        return admission ? { admission, token } : undefined;
      });
    },
    finish({ admission, token }) {
      return withDatabase((db) =>
        db.prepare(`
          UPDATE cron_admissions SET closed = 1, leaseToken = NULL, leaseUntil = NULL
          WHERE id = ? AND closed = 0 AND leaseToken = ?
        `).run(admission.id, token).changes === 1
      );
    },
  };
}
