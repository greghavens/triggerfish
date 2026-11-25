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
