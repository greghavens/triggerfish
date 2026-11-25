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
  const { table, state, columns, initialize } = journals[kind];
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

  return {
    read() {
      initialize(path);
      return schedulerAdmissionDatabase(path)((db) => {
        const row = db.prepare(`
          SELECT ${fields} FROM ${table} WHERE id = ? AND ${state}
        `).get(scope.runId);
        return row && parse(row);
      });
    },
    restore(raw: Record<string, unknown>) {
      const record = raw && parse(raw);
      if (!record) return;
      initialize(path);
      return {
        path,
        install(db: DatabaseSync) {
          const existing = db.prepare(`
            SELECT ${fields}, (${state}) AS pending
            FROM archive_admission.${table} WHERE id = ?
          `).get(record.id);
          if (existing) {
            return existing.pending === 1 &&
              JSON.stringify(parse(existing)) === JSON.stringify(record);
          }
          const values = columns.map((name) =>
            (record as unknown as Record<string, string | number>)[name]
          );
          return db.prepare(`
            INSERT INTO archive_admission.${table} (${fields})
            VALUES (${columns.map(() => "?").join(", ")})
          `).run(...values).changes === 1;
        },
      };
    },
  };
}
