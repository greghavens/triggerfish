import { MAX_SENTINEL_FINDING_RESULT_CHARS } from "../sentinel/worker_finding_recovery.ts";
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

export function parseSavedIntermediateWorkflowPage(
  result: string,
  evidenceRevision: number,
  targetId: string,
  args: { offset?: number; limit?: number },
) {
  if (result.length > 7000) return;
  const page = JSON.parse(result);
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 5;
  if (
    page?.evidenceRevision !== evidenceRevision || page.targetId !== targetId ||
    Object.keys(page).length !== 4 || !Array.isArray(page.observations) ||
    page.observations.length > limit ||
    (page.nextOffset !== null && (page.observations.length !== limit ||
      !Number.isSafeInteger(page.nextOffset) ||
      page.nextOffset !== offset + limit))
  ) return;
  const ids = new Set<string>();
  const entries: { id: string; sourceTaskId: string; observedAt: string }[] =
    [];
  for (const entry of page.observations) {
    if (
      typeof entry?.id !== "string" ||
      !/^workflow-observation:[a-f0-9]{64}$/.test(entry.id) ||
      ids.has(entry.id) || typeof entry.sourceTaskId !== "string" ||
      !/^adaptive:[a-f0-9]{64}$/.test(entry.sourceTaskId) ||
      typeof entry.observedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.observedAt) ||
      Object.keys(entry).length !== 3
    ) return;
    ids.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

export function validateSavedIntermediateWorkflowPage(
  path: string,
  scope: {
    runId: string;
    taskId: string;
    evidenceRevision: number;
    targetId: string;
  },
  args: { offset?: number; limit?: number },
  result: string,
) {
  const entries = parseSavedIntermediateWorkflowPage(
    result,
    scope.evidenceRevision,
    scope.targetId,
    args,
  );
  return entries !== undefined && entries.every((entry) => {
    const retained = readCommittedSentinelPeerWorkflowObservation(
      join(dirname(path), "sentinel-adaptive.db"),
      scope,
      entry.id,
    );
    return retained?.taskId === entry.sourceTaskId &&
      retained.receipt.observedAt === entry.observedAt;
  });
}

export function parseSavedGraphFactPage(result: string, offset: number) {
  if (result.length > 7000 || redactCredentialText(result) !== result) return;
  const page = JSON.parse(result);
  if (
    page?._classification !== "INTERNAL" || Object.keys(page).length !== 3 ||
    !Array.isArray(page.facts) || page.facts.length > 3 ||
    (page.nextOffset !== null && (page.facts.length !== 3 ||
      !Number.isSafeInteger(page.nextOffset) || page.nextOffset !== offset + 3))
  ) return;
  const ids = new Set<string>();
  const facts: { id: string }[] = [];
  for (const fact of page.facts) {
    if (
      typeof fact?.id !== "string" ||
      !/^worker-graph-fact:[a-f0-9]{64}$/.test(fact.id) ||
      ids.has(fact.id)
    ) return;
    ids.add(fact.id);
    facts.push(fact);
  }
  return facts;
}

export function validateSavedGraphFactPage(
  path: string,
  scope: {
    caseId: string;
    runId: string;
    evidenceRevision: number;
    targetId: string;
  },
  offset: number,
  result: string,
) {
  const facts = parseSavedGraphFactPage(result, offset);
  return facts !== undefined && facts.every((fact) => {
    const retained = readSentinelWorkerGraphFact(path, scope, fact.id);
    return retained !== undefined && isDeepStrictEqual(retained, fact);
  });
}

export function parseSavedFindingPage(
  result: string,
  scope: { caseId: string; evidenceRevision: number },
  args: { revision?: number; limit?: number; beforeReceiptId?: string },
) {
  if (
    result.length > MAX_SENTINEL_FINDING_RESULT_CHARS ||
    redactCredentialText(result) !== result
  ) return;
  const page = JSON.parse(result);
  if (
    page?._classification !== "INTERNAL" || !Array.isArray(page.records) ||
    page.records.length > (args.limit ?? 5) ||
    (args.revision !== undefined && args.revision > scope.evidenceRevision)
  ) return;
  if (
    Object.keys(page).length === 3 && page.records.length === 0 &&
    page.nextBeforeReceiptId === null && args.beforeReceiptId === undefined
  ) return [];
  if (
    Object.keys(page).length !== 5 || page.caseId !== scope.caseId ||
    page.evidenceRevision !== (args.revision ?? scope.evidenceRevision) ||
    (page.nextBeforeReceiptId !== null &&
      (!page.records.length ||
        page.nextBeforeReceiptId !== page.records.at(-1)?.id))
  ) return;
  const ids = new Set<string>();
  const records: { id: string }[] = [];
  for (const record of page.records) {
    if (
      typeof record?.id !== "string" ||
      !/^worker-(?:finding|recheck):[a-f0-9]{64}$/.test(record.id) ||
      ids.has(record.id) || record.id === args.beforeReceiptId
    ) return;
    ids.add(record.id);
    records.push(record);
  }
  return records;
}

export function validateSavedFindingPage(
  path: string,
  scope: {
    caseId: string;
    runId: string;
    targetId: string;
    evidenceRevision: number;
  },
  args: { revision?: number; limit?: number; beforeReceiptId?: string },
  result: string,
) {
  const records = parseSavedFindingPage(result, scope, args);
  if (!records) return false;
  if (!records.length && args.beforeReceiptId === undefined) return true;
  if (!hasSentinelWorkerFindingJournal(path)) return false;
  const store = openSentinelWorkerFindingStore(path);
  try {
    const read = (id: string) => {
      const record = store.read(id);
      return record?.caseId === scope.caseId && record.runId === scope.runId &&
          record.targetId === scope.targetId &&
          record.evidenceRevision <= scope.evidenceRevision &&
          (args.revision === undefined ||
            args.revision === record.evidenceRevision)
        ? record
        : undefined;
    };
    return (args.beforeReceiptId === undefined ||
      !!read(args.beforeReceiptId)) &&
      records.every((record) => isDeepStrictEqual(read(record.id), record));
  } finally {
    store.close();
  }
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
        goalProofEligible: true,
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
    !hasSentinelWorkerFindingJournal(path)
  ) return;
  const journal = openSentinelWorkerFindingStore(path);
  try {
    const record = journal.read(args.receiptId);
    if (
      !record ||
      record.caseId !== scope.caseId || record.runId !== scope.runId ||
      record.targetId !== scope.targetId ||
      record.evidenceRevision > scope.evidenceRevision ||
      (args.revision !== undefined && args.revision !== record.evidenceRevision)
    ) return;
    const result = JSON.stringify({ _classification: "INTERNAL", record });
    if (
      result.length > MAX_SENTINEL_FINDING_RESULT_CHARS ||
      redactCredentialText(result) !== result
    ) return;
    return {
      args,
      id: record.id,
      result,
      goalProofEligible: record.kind === "recheck" &&
        record.outcome === "pass" &&
        record.evidenceRevision === scope.evidenceRevision,
    };
  } finally {
    journal.close();
  }
}
