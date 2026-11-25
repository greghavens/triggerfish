/** Archive the exact metadata needed to revalidate one scheduler occurrence. */
import { join } from "@std/path";
import type { DatabaseSync } from "node:sqlite";
import type { ExecutionTraceScope } from "../core/execution_traces.ts";
import {
  canFlowTo,
  parseClassification,
} from "../core/types/classification.ts";
import { schedulerAdmissionDatabase } from "./admission_database.ts";
import {
  openSchedulerCronAdmissions,
  parseCronAdmission,
} from "./cron/admissions.ts";
import {
  openSchedulerTriggerAdmissions,
  parseTriggerAdmission,
} from "./triggers/admissions.ts";
import { openSchedulerWebhookAdmissions } from "./webhooks/admissions.ts";
import { schedulerExecutionIdentity } from "./service_execution.ts";

const journals = {
  cron: {
    table: "cron_admissions",
    state: "closed = 0",
    disposition: "closed",
    columns: [
      "id",
      "jobId",
      "occurrence",
      "promptSha256",
      "classificationCeiling",
    ],
    initialize: openSchedulerCronAdmissions,
  },
  trigger: {
    table: "trigger_admissions",
    state: "outcome IS NULL",
    disposition: "outcome",
    columns: [
      "id",
      "occurrence",
      "admittedAt",
      "instructionSource",
      "instructionsSha256",
      "historySha256",
      "promptSha256",
      "policySha256",
      "classificationCeiling",
    ],
    initialize: openSchedulerTriggerAdmissions,
  },
  webhook: {
    table: "webhook_admissions",
    state: "completed = 0",
    disposition: "completed",
    columns: [
      "id",
      "sourceId",
      "ceiling",
      "policySha256",
      "promptDigest",
      "credentialProof",
    ],
    initialize: openSchedulerWebhookAdmissions,
  },
} as const;

function parseWebhook(row: Record<string, unknown>) {
  const { id, sourceId, ceiling, policySha256, promptDigest, credentialProof } =
    row;
  const classification = typeof ceiling === "string"
    ? parseClassification(ceiling)
    : undefined;
  if (
    typeof id !== "string" || typeof sourceId !== "string" ||
    !classification?.ok || typeof policySha256 !== "string" ||
    typeof promptDigest !== "string" || typeof credentialProof !== "string" ||
    ![policySha256, promptDigest, credentialProof].every((value) =>
      /^[a-f0-9]{64}$/.test(value)
    )
  ) return;
  return {
    id,
    sourceId,
    ceiling: classification.value,
    policySha256,
    promptDigest,
    credentialProof,
  };
}

export function schedulerAdmissionArchive(
  baseDir: string,
  scope: ExecutionTraceScope,
) {
  if (scope.role !== "scheduled") return;
  const match = /^scheduler-(cron|trigger|webhook)-[a-f0-9]{64}$/.exec(
    scope.runId,
  );
  if (!match || !scope.sourceId || !scope.classification) return;
  const kind = match[1] as keyof typeof journals;
  const { table, state, disposition, columns, initialize } = journals[kind];
  const fields = columns.join(", ");
  const path = join(baseDir, `scheduler-${kind}-admissions.db`);
  const parse = (row: Record<string, unknown>) => {
    const record = kind === "cron"
      ? parseCronAdmission(row)
      : kind === "trigger"
      ? parseTriggerAdmission(row)
      : parseWebhook(row);
    if (!record || record.id !== scope.runId) return;
    const source = "jobId" in record
      ? record.jobId
      : "sourceId" in record
      ? record.sourceId
      : "trigger";
    const ceiling = "ceiling" in record
      ? record.ceiling
      : record.classificationCeiling;
    if (
      source !== scope.sourceId || !canFlowTo(ceiling, scope.classification!)
    ) return;
    if (
      "occurrence" in record &&
      schedulerExecutionIdentity(kind, source, record.occurrence).id !==
        record.id
    ) return;
    return record;
  };

  const validDisposition = (value: unknown) =>
    kind === "trigger"
      ? value === null || (typeof value === "string" && [
        "completed",
        "policy_changed",
        "instructions_changed",
        "history_unavailable",
        "input_changed",
        "execution_unavailable",
      ].includes(value))
      : value === 0 || value === 1;
  return {
    read(terminal = false) {
      initialize(path);
      return schedulerAdmissionDatabase(path)((db) => {
        const row = db.prepare(`
          SELECT ${fields}, ${disposition} AS disposition, leaseToken, leaseUntil
          FROM ${table} WHERE id = ? AND ${terminal ? "1" : state}
        `).get(scope.runId);
        if (!row) return;
        const record = parse(row);
        if (!terminal) return record;
        if (
          !record || !validDisposition(row.disposition) ||
          row.leaseToken !== null || row.leaseUntil !== null
        ) {
          throw new Error(
            "The scheduler admission did not settle at the archive boundary.",
          );
        }
        return { ...record, disposition: row.disposition };
      });
    },
    restore(raw: Record<string, unknown>, terminal = false) {
      const record = raw && parse(raw);
      if (
        !record ||
        (terminal
          ? !validDisposition(raw.disposition)
          : raw.disposition !== undefined)
      ) return;
      initialize(path);
      return {
        path,
        install(db: DatabaseSync) {
          const existing = db.prepare(`
            SELECT ${fields}, (${state}) AS pending,
              ${disposition} AS disposition, leaseToken, leaseUntil
            FROM archive_admission.${table} WHERE id = ?
          `).get(record.id);
          if (existing) {
            return (terminal
              ? existing.disposition === raw.disposition &&
                existing.leaseToken === null && existing.leaseUntil === null
              : existing.pending === 1) &&
              JSON.stringify(parse(existing)) === JSON.stringify(record);
          }
          const values = columns.map((name) =>
            (record as unknown as Record<string, string | number>)[name]
          );
          if (terminal) {
            return db.prepare(`
              INSERT INTO archive_admission.${table} (${fields}, ${disposition})
              VALUES (${columns.map(() => "?").join(", ")}, ?)
            `).run(...values, raw.disposition as string | number | null)
              .changes === 1;
          }
          return db.prepare(`
            INSERT INTO archive_admission.${table} (${fields})
            VALUES (${columns.map(() => "?").join(", ")})
          `).run(...values).changes === 1;
        },
      };
    },
  };
}
