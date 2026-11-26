import type { OperatorRunRef } from "../core/operator_runs.ts";
import {
  type ArchiveDependency,
  readRunArchivePlanDependencies,
} from "../sentinel/archive_dependencies.ts";
/** Reviewed admission of exact Sentinel run archival and restoration. */

import { createHash } from "node:crypto";
import { dirname, join } from "@std/path";
import { withVerifiedRunArchive } from "../core/run_archive.ts";
import {
  permittedSentinelRestoreArtifacts,
  requiredSentinelRestoreArtifacts,
} from "../sentinel/sentinel_archive_restore.ts";
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
  readonly archiveId?: string;
}

function targets(raw: unknown, restore: boolean): ArchiveTarget[] | undefined {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) return;
  const result: ArchiveTarget[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const { kind, id, revision, runId, archiveId } = item;
    if (
      kind !== "sentinel" || typeof id !== "string" || !isSentinelCaseId(id) ||
      seen.has(id) || !Number.isSafeInteger(revision) || revision < 1 ||
      typeof runId !== "string" || !uuid.test(runId) ||
      (restore && (typeof archiveId !== "string" || !uuid.test(archiveId))) ||
      Object.keys(item).some((key) =>
        !["kind", "id", "revision", "runId", ...(restore ? ["archiveId"] : [])]
          .includes(key)
      )
    ) return;
    seen.add(id);
    result.push({
      kind,
      id,
      revision,
      runId: runId.toLowerCase(),
      ...(restore && { archiveId: archiveId.toLowerCase() }),
    });
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

export function orderedArchiveTargets<T extends ArchiveTarget>(
  chosen: readonly T[],
  sources: ReadonlyMap<string, readonly ArchiveDependency[]>,
  restore: boolean,
): T[] {
  const dependsOn = (dependent: ArchiveTarget, source: ArchiveTarget) =>
    sources.get(dependent.archiveId ?? dependent.id)?.some((ref) =>
      ref.kind === source.kind && ref.id === source.id &&
      ref.revision === source.revision &&
      (ref.runId === undefined || ref.runId === source.runId)
    );
  const visited = new Set<string>();
  const ordered: T[] = [];
  const visit = (target: T) => {
    const key = target.archiveId ?? target.id;
    if (visited.has(key)) return;
    visited.add(key);
    for (const other of chosen) {
      if (restore ? dependsOn(target, other) : dependsOn(other, target)) {
        visit(other);
      }
    }
    ordered.push(target);
  };
  chosen.forEach(visit);
  return ordered;
}

export async function readArchivedRunDependencies(
  directory: string,
  target: ArchiveTarget,
  receipt: RunArchiveActionRecord | undefined,
  packagePath?: string,
): Promise<ArchiveDependency[] | undefined> {
  if (!target.archiveId || !receipt?.archiveDigest) return;
  try {
    return await withVerifiedRunArchive(
      packagePath ?? join(directory, target.archiveId),
      directory,
      {
        expectedKind: "sentinel",
        permittedNames: permittedSentinelRestoreArtifacts,
        requiredNames: requiredSentinelRestoreArtifacts,
      },
      ({ manifest, artifactPath }) => {
        const { kind, id, revision, runId } = manifest.identity;
        if (
          kind !== target.kind || id !== target.id ||
          revision !== target.revision || runId !== target.runId ||
          createHash("sha256").update(JSON.stringify(manifest)).digest(
              "hex",
            ) !==
            receipt.archiveDigest
        ) return;
        const path = artifactPath("sentinel-assessment.db");
        if (!path) return;
        return readRunArchivePlanDependencies(path);
      },
    );
  } catch {
    return;
  }
}

async function hasDestination(path: string) {
  try {
    await Deno.lstat(dirname(path));
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
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
  const restore = args.action === "restore_runs";
  if (!restore && args.action !== "archive_runs") return;
  const chosen = targets(args.runTargets, restore);
  if (
    typeof args.requestId !== "string" || !uuid.test(args.requestId) ||
    !chosen ||
    Object.keys(args).some((key) =>
      !["action", "requestId", "runTargets"].includes(key)
    )
  ) return;
  const requestId = args.requestId.toLowerCase();
  const group = { action: args.action, requestId, runTargets: chosen };
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
  const itemArgs = (target: ArchiveTarget) => ({
    action: restore ? "restore" : "archive",
    ...target,
    requestId: archiveRequestId(requestId, target),
  });
  const eligible = async (
    target: ArchiveTarget,
  ): Promise<ArchiveDependency[] | undefined> => {
    if (!await authorize(itemArgs(target))) return;
    const path = resolveSentinelCasePath(baseDir, target.id);
    if (restore) {
      if (await hasDestination(path)) return;
      return readArchivedRunDependencies(
        directory,
        target,
        journal.readArchived(target.archiveId!),
      );
    }
    const current = readSentinelAssessment(path);
    if (
      !current || current.active || current.paused ||
      current.deadlineReviewPending || current.revision !== target.revision ||
      current.plan.runId !== target.runId
    ) return;
    const parent = input.parent(target);
    return parent ? [parent] : [];
  };
  try {
    let approved = journal.readBatch(requestId);
    if (approved && approved.binding !== binding) return;
    if (!approved) {
      const ready: ArchiveTarget[] = [];
      const dependencies = new Map<string, ArchiveDependency[]>();
      for (const target of chosen) {
        const sources = await eligible(target);
        if (!sources) continue;
        ready.push(target);
        dependencies.set(target.archiveId ?? target.id, sources);
      }
      const planned = orderedArchiveTargets(ready, dependencies, restore);
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
          `${
            restore ? "Restore" : "Archive"
          } these exact Sentinel runs in order?\n${
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
      const call = itemArgs(target);
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
