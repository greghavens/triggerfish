import { createHash } from "node:crypto";
/** Owner-confirmed archival and paused restoration of exact Sentinel runs. */
import { join } from "@std/path";
import {
  type RunArchiveIdentity,
  type RunArchiveManifest,
  withVerifiedRunArchive,
  writeRunArchive,
} from "../core/run_archive.ts";
import { openRunArchiveActions } from "../core/run_archive_actions.ts";
import type { OperatorRunRef } from "../core/operator_runs.ts";
import {
  captureStoppedSentinelCaseArtifacts,
  sentinelCaseArchiveArtifactNames,
} from "../sentinel/case_archive_capture.ts";
import { readSentinelAssessment } from "../sentinel/assessment_store.ts";
import {
  isSentinelCaseId,
  resolveSentinelCasePath,
} from "../sentinel/cases.ts";
import {
  requiredSentinelRestoreArtifacts,
  restoreVerifiedSentinelCaseArchive,
} from "../sentinel/sentinel_archive_restore.ts";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digestManifest = (manifest: RunArchiveManifest) =>
  createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
const unavailable =
  "Error: The archive or exact stopped Sentinel run is unavailable.";

export async function executeOperatorSentinelArchive(
  baseDir: string,
  ref: OperatorRunRef,
  args: Record<string, unknown>,
  confirm: (message: string) => Promise<boolean>,
): Promise<Record<string, unknown> | string> {
  const { action, runId, requestId, archiveId, limit, before } = args;
  const history = action === "archive_history";
  if (
    ref.kind !== "sentinel" || ref.revision === undefined ||
    !isSentinelCaseId(ref.id) || ref.id === "main" ||
    typeof runId !== "string" || !uuid.test(runId) ||
    (action !== "archive" && action !== "restore" && !history) ||
    Object.keys(args).some((key) =>
      ![
        "action",
        "kind",
        "id",
        "revision",
        "runId",
        ...(history
          ? ["limit", "before"]
          : action === "restore"
          ? ["archiveId", "requestId"]
          : ["requestId"]),
      ].includes(key)
    )
  ) return unavailable;
  const identity: RunArchiveIdentity = {
    kind: "sentinel",
    id: ref.id,
    revision: ref.revision,
    runId: runId.toLowerCase(),
  };
  const directory = join(baseDir, "data", "run-archives");
  await Deno.mkdir(directory, { mode: 0o700, recursive: true });
  const info = await Deno.lstat(directory);
  if (!info.isDirectory || info.isSymlink || ((info.mode ?? 0) & 0o077) !== 0) {
    return unavailable;
  }
  const journal = openRunArchiveActions(join(directory, "actions.db"));
  try {
    if (history) {
      if (
        (limit !== undefined &&
          (typeof limit !== "number" || !Number.isSafeInteger(limit) ||
            limit < 1 || limit > 20)) ||
        (before !== undefined &&
          (typeof before !== "number" || !Number.isSafeInteger(before) ||
            before < 1))
      ) return unavailable;
      return { identity, ...journal.list(identity, limit, before) };
    }
    if (
      typeof requestId !== "string" || !uuid.test(requestId) ||
      (action === "restore" &&
        (typeof archiveId !== "string" || !uuid.test(archiveId)))
    ) return unavailable;
    const request = requestId.toLowerCase();
    const id = action === "archive"
      ? request
      : (archiveId as string).toLowerCase();
    const input = {
      requestId: request,
      archiveId: id,
      action,
      identity,
    } as const;
    const exact = (other: RunArchiveIdentity) =>
      other.kind === identity.kind && other.id === identity.id &&
      other.runId === identity.runId && other.revision === identity.revision;
    const prior = journal.read(request);
    if (prior) {
      return prior.action === action && prior.archiveId === id &&
          exact(prior.identity)
        ? { receipt: prior }
        : unavailable;
    }
    const source = action === "restore" ? journal.readArchived(id) : undefined;
    if (action === "restore") {
      if (
        source?.action !== "archive" || source.status !== "succeeded" ||
        !source.archiveDigest || !exact(source.identity)
      ) return unavailable;
    }
    if (action === "archive") {
      const current = readSentinelAssessment(
        resolveSentinelCasePath(baseDir, ref.id),
      );
      if (
        !current || current.active || current.paused ||
        current.plan.runId !== identity.runId ||
        current.revision !== identity.revision
      ) return unavailable;
    }
    if (
      !await confirm(
        `Approve ${action} for this exact Sentinel run?\n${
          JSON.stringify(input)
        }`,
      )
    ) {
      return "Error: The operator declined the run action.";
    }
    const admission = journal.admit(input);
    if (!admission) return unavailable;
    if (!admission.admitted) return { receipt: admission.record };
    const archivePath = join(directory, id);
    let outcome: "succeeded" | "failed" = "failed";
    let archiveDigest: string | undefined;
    try {
      if (action === "archive") {
        const staged = captureStoppedSentinelCaseArtifacts(baseDir, {
          caseId: ref.id,
          runId: identity.runId,
          evidenceRevision: ref.revision,
        }, directory);
        try {
          const manifest = await writeRunArchive(
            archivePath,
            identity,
            staged.artifacts.map(({ name, path }) => ({
              name,
              sourcePath: path,
            })),
            sentinelCaseArchiveArtifactNames,
          );
          archiveDigest = digestManifest(manifest);
        } finally {
          await Deno.remove(staged.directory, { recursive: true });
        }
      } else {
        await withVerifiedRunArchive(archivePath, directory, {
          expectedKind: "sentinel",
          permittedNames: sentinelCaseArchiveArtifactNames,
          requiredNames: requiredSentinelRestoreArtifacts,
        }, async (archive) => {
          if (
            !exact(archive.manifest.identity) ||
            digestManifest(archive.manifest) !== source?.archiveDigest
          ) {
            throw new Error("Mismatched run archive");
          }
          await restoreVerifiedSentinelCaseArchive(baseDir, archive);
        });
      }
      outcome = "succeeded";
    } catch {
      // The audit event contains no local paths, contents or storage errors.
    }
    const receipt = journal.complete(
      input,
      admission.token,
      outcome,
      outcome === "succeeded" ? archiveDigest : undefined,
    );
    return receipt ? { receipt } : unavailable;
  } finally {
    journal.close();
  }
}
