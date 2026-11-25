/** Portable Sentinel approval history has no authority to dispatch tools. */
import { dirname, join } from "@std/path";
import { isDeepStrictEqual } from "node:util";
import {
  type ArchivedToolDecision,
  MAX_ARCHIVED_TOOL_DECISIONS,
  openApprovalInbox,
} from "../core/approval_inbox.ts";

export const sentinelArchivedToolDecisionsFile = "sentinel-tool-decisions.json";
const maxBytes = 1024 * 1024;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const reference = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const name = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const fields = new Set([
  "id",
  "runId",
  "assignmentId",
  "tool",
  "status",
  "decision",
  "dispatchOutcome",
  "handlerReturnedAt",
  "createdAt",
  "updatedAt",
]);

interface ToolDecisionArchive {
  readonly version: 1;
  readonly caseId: string;
  readonly runId: string;
  readonly decisions: readonly ArchivedToolDecision[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid archived tool decisions.");
  }
  return value as Record<string, unknown>;
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function decodeSentinelToolDecisions(
  raw: unknown,
  caseId: string,
  runId: string,
): ToolDecisionArchive {
  const archive = record(raw);
  if (
    Object.keys(archive).length !== 4 || archive.version !== 1 ||
    archive.caseId !== caseId || archive.runId !== runId || !uuid.test(runId) ||
    !Array.isArray(archive.decisions) ||
    archive.decisions.length > MAX_ARCHIVED_TOOL_DECISIONS
  ) throw new Error("Invalid archived tool decisions.");

  const identities = new Set<string>();
  for (const item of archive.decisions) {
    const itemRecord = record(item);
    const {
      id,
      assignmentId,
      tool,
      status,
      decision,
      dispatchOutcome,
      handlerReturnedAt,
      createdAt,
      updatedAt,
    } = itemRecord;
    const completed = status === "completed";
    if (
      Object.keys(itemRecord).some((key) => !fields.has(key)) ||
      typeof id !== "string" || !uuid.test(id) || identities.has(id) ||
      itemRecord.runId !== runId || typeof assignmentId !== "string" ||
      !reference.test(assignmentId) || typeof tool !== "string" ||
      !name.test(tool) ||
      (status !== "completed" && status !== "denied" && status !== "stale") ||
      decision !== (status === "denied" ? "denied" : "approved") ||
      !timestamp(createdAt) || !timestamp(updatedAt) || updatedAt < createdAt ||
      (completed
        ? (dispatchOutcome !== "returned" && dispatchOutcome !== "blocked" &&
          dispatchOutcome !== "failed") ||
          (handlerReturnedAt !== undefined &&
            (!timestamp(handlerReturnedAt) || handlerReturnedAt < createdAt ||
              handlerReturnedAt > updatedAt))
        : dispatchOutcome !== undefined || handlerReturnedAt !== undefined)
    ) throw new Error("Invalid archived tool decision.");
    identities.add(id);
  }
  return archive as unknown as ToolDecisionArchive;
}

function privateFile(path: string, sizeLimit?: number) {
  try {
    const info = Deno.lstatSync(path);
    if (
      !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
      ((info.mode ?? 0) & 0o077) !== 0 ||
      (sizeLimit !== undefined && info.size > sizeLimit)
    ) {
      throw new Error("Unsafe archived tool decision file.");
    }
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export function readSentinelArchivedToolDecisions(
  path: string,
  caseId: string,
  runId: string,
): readonly ArchivedToolDecision[] {
  if (!privateFile(path, maxBytes)) return [];
  const saved = record(JSON.parse(Deno.readTextFileSync(path)));
  if (saved.caseId === caseId && saved.runId !== runId) return [];
  return decodeSentinelToolDecisions(saved, caseId, runId).decisions;
}

export function stageSentinelToolDecisions(
  baseDir: string,
  snapshotPath: string,
  staging: string,
  caseId: string,
  runId: string,
) {
  const retainedPath = join(
    dirname(snapshotPath),
    sentinelArchivedToolDecisionsFile,
  );
  const retained = readSentinelArchivedToolDecisions(
    retainedPath,
    caseId,
    runId,
  );
  const decisions = new Map(retained.map((entry) => [entry.id, entry]));
  const inboxPath = join(baseDir, "tool-approvals.db");
  if (privateFile(inboxPath)) {
    const inbox = openApprovalInbox(inboxPath);
    try {
      for (const entry of inbox.archiveRunDecisions("workspace-owner", runId)) {
        const prior = decisions.get(entry.id);
        if (prior && !isDeepStrictEqual(prior, entry)) {
          throw new Error("Conflicting archived tool decision.");
        }
        decisions.set(entry.id, entry);
      }
    } finally {
      inbox.close();
    }
  }
  if (!decisions.size) return;
  const archived = decodeSentinelToolDecisions(
    {
      version: 1,
      caseId,
      runId,
      decisions: [...decisions.values()].sort((left, right) =>
        right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
      ),
    },
    caseId,
    runId,
  );
  const sourcePath = join(staging, sentinelArchivedToolDecisionsFile);
  Deno.writeTextFileSync(sourcePath, JSON.stringify(archived), { mode: 0o600 });
  return { name: sentinelArchivedToolDecisionsFile, sourcePath };
}
