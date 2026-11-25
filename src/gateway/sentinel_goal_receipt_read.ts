import { redactCredentialText } from "../core/logger/redactor.ts";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { dirname, join } from "@std/path";
import {
  querySentinelWorkerObservations,
  readCommittedSentinelPeerWorkflowObservation,
} from "../sentinel/adaptive_store.ts";
/** Reopen the exact scoped, immutable evidence used in a worker goal proof. */
import {
  SENTINEL_GOAL_GRAPH_FACT_READ,
  SENTINEL_INTERMEDIATE_WORKFLOW_READ,
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

/** Only persist bounded search projections with the original page shape. */
export function parseSavedSentinelObservationSearch(
  result: string,
  revision: number,
  offset: number,
) {
  if (result.length > 7000 || redactCredentialText(result) !== result) return;
  const page = JSON.parse(result);
  if (
    page?.revision !== revision || page.offset !== offset ||
    !Array.isArray(page.observations) || page.observations.length > 5 ||
    (page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) ||
      page.nextOffset !== offset + 5 || page.observations.length !== 5))
  ) return;
  const ids = new Set<string>();
  for (const observation of page.observations) {
    if (
      typeof observation?.id !== "string" ||
      !/^adaptive:[a-f0-9]{64}$/.test(observation.id) ||
      typeof observation.kind !== "string" ||
      typeof observation.nodeId !== "string" && observation.nodeId !== null ||
      typeof observation.summary !== "string" && observation.summary !== null ||
      Object.keys(observation).length !== 4 || ids.has(observation.id)
    ) return;
    ids.add(observation.id);
  }
  if (Object.keys(page).length !== 4) return;
  return { page, ids: [...ids] };
}

export function validateSavedSentinelObservationSearch(
  path: string,
  runId: string,
  revision: number,
  args: { query: string; revision?: number; offset?: number },
  result: string,
) {
  if (args.revision !== undefined && args.revision !== revision) return false;
  const saved = parseSavedSentinelObservationSearch(
    result,
    revision,
    args.offset ?? 0,
  );
  if (!saved) return false;
  const retained = querySentinelWorkerObservations(
    join(dirname(path), "sentinel-adaptive.db"),
    revision,
    {
      query: args.query,
      offset: args.offset ?? 0,
      saved: { runId, ids: saved.ids },
    },
  );
  return typeof retained === "object" &&
    isDeepStrictEqual(
      JSON.parse(JSON.stringify(retained.observations)),
      saved.page.observations,
    );
}

export function reopenSentinelGoalReceiptRead(
  path: string,
  scope: {
    caseId: string;
    runId: string;
    taskId: string;
    evidenceRevision: number;
    targetId: string;
  },
  tool: string,
  value: unknown,
) {
  const args = sentinelGoalReceiptReadArguments(tool, value);
  if (!args) return;
  if (tool === SENTINEL_INTERMEDIATE_WORKFLOW_READ && args.id) {
    const observation = readCommittedSentinelPeerWorkflowObservation(
      join(dirname(path), "sentinel-adaptive.db"),
      scope,
      args.id,
    );
    if (observation) {
      return { args, id: observation.id, result: JSON.stringify(observation) };
    }
    return;
  }
  if (tool === SENTINEL_GOAL_GRAPH_FACT_READ && "id" in args && args.id) {
    const { caseId, runId, evidenceRevision, targetId } = scope;
    const fact = readSentinelWorkerGraphFact(path, {
      caseId,
      runId,
      evidenceRevision,
      targetId,
    }, args.id);
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
      args.offset ?? 0,
      json,
    );
    if (!page.observationJson.length) return;
    return {
      args,
      id: args.task,
      result: JSON.stringify(page),
      observationSha256: page.offset === 0 ? page.observationSha256 : undefined,
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
