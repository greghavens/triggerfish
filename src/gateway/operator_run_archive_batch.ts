/** Reviewed admission of exact stopped Sentinel runs through the existing archive service. */

import { createHash } from "node:crypto";
import { join } from "@std/path";
import type { OperatorRunRef } from "../core/operator_runs.ts";
import {
  lockRunArchiveAction,
  openRunArchiveActions,
  type RunArchiveActionRecord,
} from "../core/run_archive_actions.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import {
  isSentinelCaseId,
  resolveSentinelCasePath,
} from "../sentinel/cases.ts";
import { readSentinelAssessment } from "../sentinel/assessment_store.ts";
import { executeOperatorRunArchive } from "./operator_run_archive.ts";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

interface ArchiveTarget {
  readonly kind: "sentinel";
  readonly id: string;
  readonly revision: number;
  readonly runId: string;
}

function targets(raw: unknown): ArchiveTarget[] | undefined {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) return;
  const result: ArchiveTarget[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const { kind, id, revision, runId } = item;
    if (
      kind !== "sentinel" || typeof id !== "string" || !isSentinelCaseId(id) ||
      seen.has(id) || !Number.isSafeInteger(revision) || revision < 1 ||
      typeof runId !== "string" || !uuid.test(runId) ||
      Object.keys(item).some((key) =>
        !["kind", "id", "revision", "runId"].includes(key)
      )
    ) return;
    seen.add(id);
    result.push({ kind, id, revision, runId: runId.toLowerCase() });
  }
  return result;
}

function archiveRequestId(group: string, target: ArchiveTarget): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(["sentinel-archive-batch", group, target])).digest(
      "hex",
    );
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
}

function childFirst(
  chosen: readonly ArchiveTarget[],
  parent: (target: ArchiveTarget) => OperatorRunRef | undefined,
): ArchiveTarget[] {
  const preceding = chosen.map((child) => {
    const ref = parent(child);
    return chosen.findIndex((target) =>
      ref?.kind === "sentinel" && ref.id === target.id &&
      ref.revision === target.revision
    );
  });
  const visited = new Set<number>();
  const ordered: ArchiveTarget[] = [];
  const visit = (index: number) => {
    if (visited.has(index)) return;
    visited.add(index);
    preceding.forEach((prior, child) => {
      if (prior === index) visit(child);
    });
    ordered.push(chosen[index]);
  };
  chosen.forEach((_, i) => visit(i));
  return ordered;
}

export async function executeOperatorRunArchiveBatch(input: {
  readonly baseDir: string;
  readonly args: Record<string, unknown>;
  readonly ownerSessionId: string;
  readonly ceiling: ClassificationLevel;
  readonly authorize: (args: Record<string, unknown>) => Promise<boolean>;
  readonly confirm: (summary: string) => Promise<boolean>;
  readonly parent: (target: ArchiveTarget) => OperatorRunRef | undefined;
}) {
  const { baseDir, args, ownerSessionId, ceiling, authorize, confirm } = input;
  const chosen = targets(args.runTargets);
  if (
    typeof args.requestId !== "string" || !uuid.test(args.requestId) ||
    !chosen ||
    Object.keys(args).some((key) =>
      !["action", "requestId", "runTargets"].includes(key)
    )
  ) return;
  const requestId = args.requestId.toLowerCase();
  const group = { action: "archive_runs", requestId, runTargets: chosen };
  const binding = JSON.stringify(group);
  const directory = join(baseDir, "data", "run-archives");
  if (!await authorize(group)) return;
  await Deno.mkdir(directory, { mode: 0o700, recursive: true });
  const info = await Deno.lstat(directory);
  if (!info.isDirectory || info.isSymlink || ((info.mode ?? 0) & 0o077) !== 0) {
    return;
  }
  using lock = lockRunArchiveAction(directory, requestId);
  if (!lock) return;
  const journal = openRunArchiveActions(join(directory, "actions.db"));
  const archiveArgs = (target: ArchiveTarget) => ({
    action: "archive",
    ...target,
    requestId: archiveRequestId(requestId, target),
  });
  const eligible = async (target: ArchiveTarget) => {
    if (!await authorize(archiveArgs(target))) return false;
    const current = readSentinelAssessment(
      resolveSentinelCasePath(baseDir, target.id),
    );
    return !!current && !current.active && !current.paused &&
      !current.deadlineReviewPending && current.revision === target.revision &&
      current.plan.runId === target.runId;
  };
  try {
    let approved = journal.readBatch(requestId);
    if (approved && approved.binding !== binding) return;
    if (!approved) {
      const ready: ArchiveTarget[] = [];
      for (const target of chosen) {
        if (await eligible(target)) ready.push(target);
      }
      const planned = childFirst(ready, input.parent);
      if (!planned.length) {
        return {
          requestId,
          outcomes: chosen.map((target) => ({
            target,
            status: "unavailable" as const,
          })),
        };
      }
      if (
        !await confirm(
          `Archive these exact stopped Sentinel runs in order?\n${
            JSON.stringify({ requestId, targets: planned })
          }`,
        )
      ) return { declined: true as const };
      if (!await authorize(group)) return;
      const reviewed: string[] = [];
      for (const target of planned) {
        if (await eligible(target)) reviewed.push(target.id);
      }
      if (!await authorize(group)) return;
      if (!journal.admitBatch(requestId, binding, reviewed)) return;
      approved = { binding, eligible: reviewed };
    }
    const receipts = new Map<string, RunArchiveActionRecord>();
    for (const id of approved.eligible) {
      const target = chosen.find((item) => item.id === id);
      if (!target) return;
      const call = archiveArgs(target);
      if (!await authorize(group) || !await authorize(call)) continue;
      const result = await executeOperatorRunArchive(
        baseDir,
        { kind: target.kind, id: target.id, revision: target.revision },
        call,
        () => authorize(call),
        undefined,
        { sessionId: ownerSessionId, ceiling },
      );
      if (typeof result !== "string" && "receipt" in result) {
        receipts.set(id, result.receipt);
      }
    }
    return {
      requestId,
      outcomes: chosen.map((target) => {
        const receipt = receipts.get(target.id);
        return receipt
          ? { target, status: receipt.status, receipt }
          : { target, status: "unavailable" as const };
      }),
    };
  } finally {
    journal.close();
  }
}
