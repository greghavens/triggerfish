import { createHash } from "node:crypto";
import { dirname, join } from "@std/path";
import { querySentinelWorkerObservations } from "../sentinel/adaptive_store.ts";
/** Reopen the exact scoped, immutable evidence used in a worker goal proof. */
import {
  SENTINEL_GOAL_GRAPH_FACT_READ,
  sentinelGoalReceiptReadArguments,
} from "../sentinel/worker_goal_recovery.ts";
import { readSentinelWorkerGraphFact } from "../sentinel/worker_graph_facts.ts";
import {
  hasSentinelWorkerFindingJournal,
  openSentinelWorkerFindingStore,
} from "../sentinel/worker_finding_store.ts";

export function sentinelWorkerObservationPage(
  task: string,
  revision: number,
  offset: number,
  json: string,
) {
  const end = Math.min(offset + 1000, json.length);
  return {
    task,
    revision,
    offset,
    nextOffset: end < json.length ? end : null,
    _classification: "INTERNAL",
    observationJson: json.slice(offset, end),
    observationSha256: createHash("sha256").update(json).digest("hex"),
  };
}

export function reopenSentinelGoalReceiptRead(
  path: string,
  scope: {
    caseId: string;
    runId: string;
    evidenceRevision: number;
    targetId: string;
  },
  tool: string,
  value: unknown,
) {
  const args = sentinelGoalReceiptReadArguments(tool, value);
  if (!args) return;
  if (tool === SENTINEL_GOAL_GRAPH_FACT_READ && "id" in args && args.id) {
    const fact = readSentinelWorkerGraphFact(path, scope, args.id);
    if (fact) {
      return {
        args,
        id: fact.id,
        result: JSON.stringify({ _classification: "INTERNAL", ...fact }),
      };
    }
    return;
  }
  if (args.task) {
    if (
      args.revision !== undefined && args.revision !== scope.evidenceRevision
    ) return;
    const json = querySentinelWorkerObservations(
      join(dirname(path), "sentinel-adaptive.db"),
      scope.evidenceRevision,
      { task: args.task, runId: scope.runId },
    );
    if (typeof json !== "string" || !json.length) return;
    const page = sentinelWorkerObservationPage(
      args.task,
      scope.evidenceRevision,
      0,
      json,
    );
    return {
      args,
      id: args.task,
      result: JSON.stringify(page),
      observationSha256: page.observationSha256,
    };
  }
  if (
    !("receiptId" in args) || !args.receiptId ||
    (args.revision !== undefined && args.revision !== scope.evidenceRevision) ||
    !hasSentinelWorkerFindingJournal(path)
  ) return;
  const journal = openSentinelWorkerFindingStore(path);
  try {
    const record = journal.read(args.receiptId);
    if (
      record?.kind !== "recheck" || record.outcome !== "pass" ||
      record.caseId !== scope.caseId || record.runId !== scope.runId ||
      record.targetId !== scope.targetId ||
      record.evidenceRevision !== scope.evidenceRevision
    ) return;
    return {
      args,
      id: record.id,
      result: JSON.stringify({ _classification: "INTERNAL", record }),
    };
  } finally {
    journal.close();
  }
}
