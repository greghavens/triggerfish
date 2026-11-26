import type { ArchiveDependency } from "../sentinel/archive_dependencies.ts";
/** Reviewed purge of exact, non-current Sentinel archive packages. */

import { createHash } from "node:crypto";
import { join } from "@std/path";
import {
  type RunArchiveManifest,
  withVerifiedRunArchive,
} from "../core/run_archive.ts";
import {
  orderedArchiveTargets,
  readArchivedRunDependencies,
} from "./operator_run_archive_batch.ts";
import {
  lockRunArchiveAction,
  lockSentinelArchiveCatalog,
  openRunArchiveActions,
  type RunArchivePurgeReceipt,
} from "../core/run_archive_actions.ts";
import {
  isSentinelCaseId,
  resolveSentinelCasePath,
} from "../sentinel/cases.ts";
import {
  readSentinelAssessment,
  withSentinelAssessmentWriteLock,
} from "../sentinel/assessment_store.ts";
import {
  permittedSentinelRestoreArtifacts,
  requiredSentinelRestoreArtifacts,
} from "../sentinel/sentinel_archive_restore.ts";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function parseTarget(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const target = raw as Record<string, unknown>;
  const { kind, id, revision, runId, archiveId } = target;
  if (
    kind !== "sentinel" || typeof id !== "string" || !isSentinelCaseId(id) ||
    typeof revision !== "number" || !Number.isSafeInteger(revision) ||
    revision < 1 || typeof runId !== "string" || !uuid.test(runId) ||
    typeof archiveId !== "string" || !uuid.test(archiveId) ||
    Object.keys(target).length !== 5
  ) return;
  return {
    kind,
    id,
    revision,
    runId: runId.toLowerCase(),
    archiveId: archiveId.toLowerCase(),
  } as const;
}

type Target = NonNullable<ReturnType<typeof parseTarget>>;

function memberRequest(group: string, target: Target) {
  const hex = createHash("sha256").update(
    JSON.stringify(["purge-archive-member", group, target]),
  ).digest("hex");
  const [a, b, c, d, e] = [8, 12, 16, 20, 32];
  return [
    hex.slice(0, a),
    hex.slice(a, b),
    hex.slice(b, c),
    hex.slice(c, d),
    hex.slice(d, e),
  ].join("-");
}

function exists(path: string) {
  try {
    return Deno.lstatSync(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function archiveMatches(
  manifest: RunArchiveManifest,
  { kind, id, runId, revision }: Target,
  digest: string,
): boolean {
  const source = manifest.identity;
  return source.kind === kind && source.id === id && source.runId === runId &&
    source.revision === revision &&
    createHash("sha256").update(JSON.stringify(manifest)).digest("hex") ===
      digest;
}

function removeQuarantine(path: string) {
  const saved = exists(path);
  if (
    saved?.isDirectory && !saved.isSymlink && ((saved.mode ?? 0) & 0o077) === 0
  ) {
    Deno.removeSync(path, { recursive: true });
  }
}

const verifySentinelArchive = {
  expectedKind: "sentinel" as const,
  permittedNames: permittedSentinelRestoreArtifacts,
  requiredNames: requiredSentinelRestoreArtifacts,
};

async function hasRetainedDependent(
  journal: ReturnType<typeof openRunArchiveActions>,
  directory: string,
  target: Target,
): Promise<boolean> {
  let before = Number.MAX_SAFE_INTEGER;
  while (true) {
    const page = journal.sentinelDependencyCatalog(before);
    if (!page.length) return false;
    for (const { sequence, record } of page) {
      before = sequence;
      if (record.archiveId === target.archiveId) continue;
      const { kind, id, revision, runId } = record.identity;
      if (kind !== "sentinel" || revision === undefined) return true;
      const staged = join(directory, `.purge-${record.archiveId}`);
      const dependencies = await readArchivedRunDependencies(
        directory,
        { kind, id, revision, runId, archiveId: record.archiveId },
        record,
        exists(staged) ? staged : undefined,
      );
      if (
        !dependencies ||
        dependencies.some((source) =>
          source.kind === target.kind && source.id === target.id &&
          source.revision === target.revision &&
          (source.runId === undefined || source.runId === target.runId)
        )
      ) return true;
    }
  }
}

function reviewedPurgeBatch(
  journal: ReturnType<typeof openRunArchiveActions>,
  batchRequestId: string,
  target: Target,
  receipt: RunArchivePurgeReceipt,
): Record<string, unknown> | undefined {
  const batch = journal.readBatch(batchRequestId);
  if (
    !batch?.eligible.includes(target.archiveId) ||
    (batch.purgeDigests &&
      batch.purgeDigests.find(({ archiveId }) => archiveId === target.archiveId)
          ?.archiveDigest !== receipt.archiveDigest)
  ) return;
  const group = JSON.parse(batch.binding);
  if (
    group.action !== "purge_archives" || group.requestId !== batchRequestId ||
    !Array.isArray(group.runTargets) || group.runTargets.length > 8 ||
    memberRequest(batchRequestId, target) !== receipt.requestId ||
    !group.runTargets.some((raw: unknown) =>
      JSON.stringify(parseTarget(raw)) === JSON.stringify(target)
    )
  ) return;
  return group;
}

/** Reconcile prior purges with durable authority and current policy. */
export async function recoverSentinelArchivePurges(
  baseDir: string,
  authorize: (args: Record<string, unknown>) => Promise<boolean>,
) {
  const directory = join(baseDir, "data", "run-archives");
  const root = exists(directory);
  if (
    !root?.isDirectory || root.isSymlink || ((root.mode ?? 0) & 0o077) ||
    !exists(join(directory, "actions.db"))
  ) return;
  const journal = openRunArchiveActions(join(directory, "actions.db"));
  try {
    for (const binding of journal.pendingReviewedPurgeBatchBindings()) {
      try {
        await executeOperatorArchivePurge(
          baseDir,
          JSON.parse(binding),
          authorize,
          () => Promise.resolve(false),
          true,
        );
      } catch {
        // A different verified group can still recover.
      }
    }
    for await (const entry of Deno.readDir(directory)) {
      if (!entry.isDirectory) continue;
      const staged = entry.name.startsWith(".purge-");
      const archiveId = staged
        ? entry.name.slice(".purge-".length)
        : entry.name;
      if (!uuid.test(archiveId) || archiveId !== archiveId.toLowerCase()) {
        continue;
      }
      if (!journal.readPurge(archiveId)) continue;
      try {
        using packageLock = lockRunArchiveAction(directory, archiveId);
        using catalogLock = packageLock &&
          lockSentinelArchiveCatalog(directory);
        if (!catalogLock) continue;
        const path = join(directory, archiveId);
        const quarantine = join(directory, `.purge-${archiveId}`);
        if (exists(staged ? path : quarantine)) continue;
        const receipt = journal.readPurge(archiveId);
        if (!receipt) continue;
        const target = parseTarget({ ...receipt.identity, archiveId });
        const archived = journal.readArchived(archiveId, true);
        if (!target || archived?.archiveDigest !== receipt.archiveDigest) {
          continue;
        }
        if (receipt.status === "succeeded") {
          if (staged) removeQuarantine(quarantine);
          continue;
        }
        const approval = journal.readPurgeAuthorization(archiveId);
        if (!staged && !approval) continue;
        const group = approval?.kind === "batch"
          ? reviewedPurgeBatch(
            journal,
            approval.batchRequestId,
            target,
            receipt,
          )
          : undefined;
        if (approval?.kind === "batch" && !group) continue;
        const action = {
          action: "purge_archive",
          ...target,
          requestId: receipt.requestId,
        };
        const reauthorize = async () =>
          (!group || await authorize(group)) && await authorize(action);
        if (
          !await reauthorize() ||
          await hasRetainedDependent(journal, directory, target)
        ) continue;
        const completed = await withVerifiedRunArchive(
          staged ? quarantine : path,
          directory,
          verifySentinelArchive,
          async ({ manifest }) => {
            if (
              !archiveMatches(manifest, target, receipt.archiveDigest) ||
              !await reauthorize()
            ) return;
            return withSentinelAssessmentWriteLock(
              resolveSentinelCasePath(baseDir, target.id),
              (state) => {
                if (
                  state?.plan.runId === target.runId ||
                  exists(staged ? path : quarantine)
                ) return;
                if (!staged) Deno.renameSync(path, quarantine);
                return journal.completePurge(receipt);
              },
            );
          },
        );
        if (completed?.status === "succeeded") removeQuarantine(quarantine);
      } catch {
        // Keep incomplete or unverifiable quarantines for reviewed recovery.
      }
    }
  } finally {
    journal.close();
  }
}

export async function executeOperatorArchivePurge(
  baseDir: string,
  args: Record<string, unknown>,
  authorize: (args: Record<string, unknown>) => Promise<boolean>,
  confirm: (message: string) => Promise<boolean>,
  recoveryOnly = false,
) {
  const { action, requestId: supplied, runTargets, ...rest } = args;
  const batch = action === "purge_archives";
  if (
    (action !== "purge_archive" && !batch) || (recoveryOnly && !batch) ||
    typeof supplied !== "string" || !uuid.test(supplied)
  ) return;
  const requestId = supplied.toLowerCase();
  const raw = batch
    ? Object.keys(rest).length === 0 && Array.isArray(runTargets)
      ? runTargets
      : []
    : runTargets === undefined
    ? [rest]
    : [];
  if (raw.length < 1 || raw.length > 8) return;
  const targets = raw.map(parseTarget);
  if (
    !targets.every((target): target is Target => !!target) ||
    new Set(targets.map(({ archiveId }) => archiveId)).size !== targets.length
  ) {
    return;
  }
  const group = batch
    ? { action, requestId, runTargets: targets }
    : { action, requestId, ...targets[0] };
  const binding = JSON.stringify(group);
  if (!await authorize(group)) return;
  const directory = join(baseDir, "data", "run-archives");
  try {
    const root = exists(directory);
    if (
      !root?.isDirectory || root.isSymlink || ((root.mode ?? 0) & 0o077) !== 0
    ) {
      return;
    }
    // The package lock is also held by restore. A distinct lock protects the
    // reviewed batch request across confirmation and recovery.
    using batchLock = batch
      ? lockRunArchiveAction(directory, requestId)
      : undefined;
    if (batch && !batchLock) return;
    const journal = openRunArchiveActions(join(directory, "actions.db"));
    try {
      const exactSource = (target: Target) => {
        const source = journal.readArchived(target.archiveId, true);
        return source?.identity.kind === target.kind &&
            source.identity.id === target.id &&
            source.identity.runId === target.runId &&
            source.identity.revision === target.revision &&
            !!source.archiveDigest
          ? { ...source, archiveDigest: source.archiveDigest }
          : undefined;
      };
      const item = (target: Target) => ({
        action: "purge_archive",
        ...target,
        requestId: batch ? memberRequest(requestId, target) : requestId,
      });
      const current = (target: Target) =>
        readSentinelAssessment(resolveSentinelCasePath(baseDir, target.id))
          ?.plan.runId === target.runId;
      const authorized = async (target: Target) =>
        await authorize(group) && (!batch || await authorize(item(target)));

      let reviewed = batch ? journal.readBatch(requestId) : undefined;
      if (
        (reviewed && reviewed.binding !== binding) ||
        (recoveryOnly && !reviewed?.purgeDigests)
      ) return;
      if (batch && !reviewed) {
        const eligible = [];
        const dependencies = new Map<string, readonly ArchiveDependency[]>();
        for (const target of targets) {
          const source = exactSource(target);
          if (
            source && !current(target) &&
            !journal.readPurge(target.archiveId) &&
            await authorized(target)
          ) {
            const references = await readArchivedRunDependencies(
              directory,
              target,
              source,
            );
            if (references && await authorized(target)) {
              eligible.push({ ...target, archiveDigest: source.archiveDigest });
              dependencies.set(target.archiveId, references);
            }
          }
        }
        if (!eligible.length) return;
        const ordered = orderedArchiveTargets(eligible, dependencies, false);
        if (
          !await confirm(
            `Permanently purge these exact Sentinel archive packages?\n${
              JSON.stringify(ordered)
            }`,
          )
        ) return { declined: true as const };
        if (!await authorize(group)) return;
        const ids = ordered.map(({ archiveId }) => archiveId);
        const purgeDigests = ordered.map(({ archiveId, archiveDigest }) => ({
          archiveId,
          archiveDigest,
        }));
        if (!journal.admitBatch(requestId, binding, ids, purgeDigests)) return;
        reviewed = { binding, eligible: ids, purgeDigests };
      }

      const outcomes: { target: Target; receipt?: RunArchivePurgeReceipt }[] =
        [];
      const byId = new Map(targets.map((target) => [target.archiveId, target]));
      const eligibleOrder = reviewed?.eligible;
      const ordered = eligibleOrder
        ? [
          ...eligibleOrder.flatMap((id) => byId.get(id) ?? []),
          ...targets.filter(({ archiveId }) =>
            !eligibleOrder.includes(archiveId)
          ),
        ]
        : targets;
      for (const target of ordered) {
        const call = item(target);
        const { archiveId } = target;
        const outcome: typeof outcomes[number] = { target };
        outcomes.push(outcome);
        if (
          (reviewed && !reviewed.eligible.includes(archiveId)) ||
          (batch && requestId === archiveId)
        ) continue;
        using packageLock = lockRunArchiveAction(directory, archiveId);
        if (!packageLock) continue;
        const source = exactSource(target);
        const receipt = journal.readPurge(archiveId);
        if (
          !source || (reviewed?.purgeDigests &&
            reviewed.purgeDigests.find((entry) => entry.archiveId === archiveId)
                ?.archiveDigest !== source.archiveDigest) ||
          (receipt && (receipt.requestId !== call.requestId ||
            receipt.archiveDigest !== source.archiveDigest)) ||
          !await authorized(target)
        ) continue;
        const path = join(directory, archiveId);
        const staged = join(directory, `.purge-${archiveId}`);
        const cleanup = () => removeQuarantine(staged);
        if (receipt?.status === "succeeded") {
          try {
            cleanup();
          } catch {
            // The durable receipt remains authoritative; a retry can clean up.
          }
          outcome.receipt = receipt;
          continue;
        }
        if (current(target)) continue;
        const hasStaged = !!exists(staged);
        if (hasStaged && (!receipt || exists(path))) continue;
        if (
          !receipt && !batch && !await confirm(
            `Permanently purge this exact Sentinel archive package?\n${
              JSON.stringify({ ...call, archiveDigest: source.archiveDigest })
            }`,
          )
        ) return { declined: true as const };
        if (!await authorized(target)) continue;
        try {
          using catalogLock = lockSentinelArchiveCatalog(directory);
          if (
            !catalogLock ||
            await hasRetainedDependent(journal, directory, target)
          ) continue;
          if (!await authorized(target)) continue;
          const completed = await withVerifiedRunArchive(
            hasStaged ? staged : path,
            directory,
            verifySentinelArchive,
            async ({ manifest }) => {
              if (!archiveMatches(manifest, target, source.archiveDigest!)) {
                return;
              }
              if (!await authorized(target)) return;
              return withSentinelAssessmentWriteLock(
                resolveSentinelCasePath(baseDir, target.id),
                (state) => {
                  if (state?.plan.runId === target.runId) return;
                  const admitted = journal.admitPurge(
                    call.requestId,
                    source,
                    batch
                      ? { kind: "batch", batchRequestId: requestId }
                      : { kind: "standalone" },
                  );
                  if (!admitted) return;
                  if (!hasStaged) {
                    if (exists(staged)) return;
                    Deno.renameSync(path, staged);
                  }
                  return journal.completePurge(admitted);
                },
              );
            },
          );
          if (completed?.status === "succeeded") {
            outcome.receipt = completed;
            cleanup();
          }
        } catch {
          // A quarantined package with a pending receipt is reconciled on replay.
        }
      }
      return batch
        ? { requestId, outcomes }
        : outcomes[0].receipt
        ? { receipt: outcomes[0].receipt }
        : undefined;
    } finally {
      journal.close();
    }
  } catch {
    return;
  }
}
