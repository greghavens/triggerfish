/** Reviewed purge of exact, non-current Sentinel archive packages. */

import { createHash } from "node:crypto";
import { join } from "@std/path";
import { withVerifiedRunArchive } from "../core/run_archive.ts";
import {
  lockRunArchiveAction,
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

export async function executeOperatorArchivePurge(
  baseDir: string,
  args: Record<string, unknown>,
  authorize: (args: Record<string, unknown>) => Promise<boolean>,
  confirm: (message: string) => Promise<boolean>,
) {
  const { action, requestId: supplied, runTargets, ...rest } = args;
  const batch = action === "purge_archives";
  if (
    (action !== "purge_archive" && !batch) ||
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
          ? source
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
      if (reviewed && reviewed.binding !== binding) return;
      if (batch && !reviewed) {
        const eligible = [];
        for (const target of targets) {
          const source = exactSource(target);
          if (
            source && !current(target) &&
            !journal.readPurge(target.archiveId) &&
            await authorized(target)
          ) {
            eligible.push({ ...target, archiveDigest: source.archiveDigest });
          }
        }
        if (!eligible.length) return;
        if (
          !await confirm(
            `Permanently purge these exact Sentinel archive packages?\n${
              JSON.stringify(eligible)
            }`,
          )
        ) return { declined: true as const };
        if (!await authorize(group)) return;
        const ids = eligible.map(({ archiveId }) => archiveId);
        if (!journal.admitBatch(requestId, binding, ids)) return;
        reviewed = { binding, eligible: ids };
      }

      const outcomes: { target: Target; receipt?: RunArchivePurgeReceipt }[] =
        [];
      for (const target of targets) {
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
          !source || (receipt && (receipt.requestId !== call.requestId ||
            receipt.archiveDigest !== source.archiveDigest)) ||
          !await authorized(target)
        ) continue;
        const path = join(directory, archiveId);
        const staged = join(directory, `.purge-${archiveId}`);
        const cleanup = () => {
          const saved = exists(staged);
          if (
            saved?.isDirectory && !saved.isSymlink &&
            ((saved.mode ?? 0) & 0o077) === 0
          ) {
            Deno.removeSync(staged, { recursive: true });
          }
        };
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
          const completed = await withVerifiedRunArchive(
            hasStaged ? staged : path,
            directory,
            {
              expectedKind: "sentinel",
              permittedNames: permittedSentinelRestoreArtifacts,
              requiredNames: requiredSentinelRestoreArtifacts,
            },
            ({ manifest }) => {
              const { identity } = manifest;
              if (
                identity.kind !== target.kind || identity.id !== target.id ||
                identity.runId !== target.runId ||
                identity.revision !== target.revision ||
                createHash("sha256").update(JSON.stringify(manifest)).digest(
                    "hex",
                  ) !==
                  source.archiveDigest
              ) return;
              return withSentinelAssessmentWriteLock(
                resolveSentinelCasePath(baseDir, target.id),
                (state) => {
                  if (state?.plan.runId === target.runId) return;
                  const admitted = journal.admitPurge(call.requestId, source);
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
