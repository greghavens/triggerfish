import { stageSentinelArchivedDigestCatalog } from "../sentinel/evidence_digests.ts";
import { stageArchivedDiscoveryApprovals } from "../sentinel/archive_asset_discoveries.ts";
import { stageCaseExecutionEvidence } from "../sentinel/case_execution_evidence.ts";
import { readSentinelChatSnapshot } from "../sentinel/chat_mode.ts";
import { stageArchivedSourceSnapshots } from "../sentinel/archive_source_snapshots.ts";
import { schedulerAdmissionArchive } from "../scheduler/admission_archive.ts";
import { createHash } from "node:crypto";
/** Owner-confirmed archival and paused restoration of exact operator runs. */
import { join } from "@std/path";
import {
  type RunArchiveIdentity,
  type RunArchiveManifest,
  withVerifiedRunArchive,
  writeRunArchive,
} from "../core/run_archive.ts";
import {
  AgentRecoveryStore,
  lockAgentRecovery,
} from "../core/agent_recovery_store.ts";
import { canFlowTo } from "../core/types/classification.ts";
import {
  lockSentinelRestore,
  openRunArchiveActions,
} from "../core/run_archive_actions.ts";
import {
  type ExecutionTraceRole,
  openExecutionTraces,
} from "../core/execution_traces.ts";
import {
  openOperatorRunLinkStore,
  type OperatorRunRef,
} from "../core/operator_runs.ts";
import {
  captureStoppedSentinelCaseArtifacts,
} from "../sentinel/case_archive_capture.ts";
import { readSentinelAssessment } from "../sentinel/assessment_store.ts";
import {
  isSentinelCaseId,
  resolveSentinelCasePath,
} from "../sentinel/cases.ts";
import {
  permittedSentinelRestoreArtifacts,
  requiredSentinelRestoreArtifacts,
  restoreVerifiedSentinelCaseArchive,
  sentinelArchivedLinksFile,
  sentinelArchiveLinkRevisions,
} from "../sentinel/sentinel_archive_restore.ts";
import type { OperatorWorkflowRuns } from "./operator_workflow_runs.ts";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digestManifest = (manifest: RunArchiveManifest) =>
  createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
const unavailable = "Error: The archive or exact stopped run is unavailable.";
const workflowArtifacts = ["workflow.json"] as const;
const traceArtifacts = ["execution-trace.json"] as const;
const recoveryKey = (sessionId: string, runId: string) =>
  createHash("sha256").update(JSON.stringify([sessionId, runId])).digest("hex");
type ArchiveRef = OperatorRunRef | {
  kind: ExecutionTraceRole;
  id: string;
  revision?: undefined;
};

export async function executeOperatorRunArchive(
  baseDir: string,
  ref: ArchiveRef,
  args: Record<string, unknown>,
  confirm: (message: string) => Promise<boolean>,
  workflows?: OperatorWorkflowRuns,
): Promise<Record<string, unknown> | string> {
  const { action, runId, requestId, archiveId, limit, before } = args;
  const history = action === "archive_history";
  const sentinel = ref.kind === "sentinel";
  const role = ref.kind === "delegated" || ref.kind === "scheduled"
    ? ref.kind
    : undefined;
  const artifacts = role ? traceArtifacts : workflowArtifacts;
  const linkPath = join(baseDir, "operator-run-links.db");
  const recoveryPath = join(baseDir, "agent-recovery.db");
  const openTrace = () =>
    openExecutionTraces(join(baseDir, "execution-traces.db"));
  if (
    (sentinel
      ? ref.revision === undefined || !isSentinelCaseId(ref.id) ||
        ref.id === "main" || typeof runId !== "string" || !uuid.test(runId)
      : role
      ? !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(ref.id)
      : !workflows || ref.revision !== undefined || !uuid.test(ref.id)) ||
    (action !== "archive" && action !== "restore" && !history) ||
    Object.keys(args).some((key) =>
      ![
        "action",
        "kind",
        "id",
        ...(sentinel ? ["revision", "runId"] : []),
        ...(history
          ? ["limit", "before"]
          : action === "restore"
          ? ["archiveId", "requestId"]
          : ["requestId"]),
      ].includes(key)
    )
  ) return unavailable;
  const identity: RunArchiveIdentity = {
    kind: ref.kind,
    id: ref.id,
    revision: ref.revision,
    runId: sentinel ? String(runId).toLowerCase() : ref.id,
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
    const resumable = sentinel && action === "restore";
    using lock = resumable
      ? lockSentinelRestore(directory, request)
      : undefined;
    const prior = journal.read(request);
    if (
      prior &&
      (prior.action !== action || prior.archiveId !== id ||
        !exact(prior.identity))
    ) {
      return unavailable;
    }
    const recovering = resumable && prior?.status === "pending";
    if (prior && (!recovering || !lock)) return { receipt: prior };
    if (resumable && !lock) return unavailable;
    const source = action === "restore" ? journal.readArchived(id) : undefined;
    if (action === "restore") {
      if (
        source?.action !== "archive" || source.status !== "succeeded" ||
        !source.archiveDigest || !exact(source.identity)
      ) return unavailable;
    }
    if (action === "archive" && sentinel) {
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
      !recovering && !await confirm(
        `Approve ${action} for this exact ${ref.kind} run?\n${
          JSON.stringify(input)
        }`,
      )
    ) {
      return "Error: The operator declined the run action.";
    }
    const admission = recovering
      ? journal.recoverSentinelRestore(input)
      : journal.admit(input);
    if (!admission) return unavailable;
    if (!admission.admitted) return { receipt: admission.record };
    const archivePath = join(directory, id);
    let outcome: "succeeded" | "failed" = "failed";
    let archiveDigest: string | undefined;
    try {
      if (action === "archive" && sentinel) {
        const staged = captureStoppedSentinelCaseArtifacts(baseDir, {
          caseId: ref.id,
          runId: identity.runId,
          evidenceRevision: ref.revision!,
        }, directory);
        try {
          const journal = openOperatorRunLinkStore(linkPath);
          const links = (() => {
            try {
              const assessment = staged.artifacts.find(({ name }) =>
                name === "sentinel-assessment.db"
              );
              if (!assessment) {
                throw new Error("Sentinel assessment is unavailable");
              }
              return {
                version: 1,
                revisions: sentinelArchiveLinkRevisions(
                  assessment.path,
                  identity.runId,
                  ref.revision!,
                )
                  .map((revision) => ({
                    revision,
                    links: journal.archive("workspace-operator", {
                      ...ref,
                      revision,
                    }),
                  }))
                  .filter(({ links }) => links.length > 0),
              };
            } finally {
              journal.close();
            }
          })();
          const sourcePath = join(staged.directory, sentinelArchivedLinksFile);
          await Deno.writeTextFile(sourcePath, JSON.stringify(links), {
            mode: 0o600,
          });
          const snapshots = [];
          const livePath = resolveSentinelCasePath(baseDir, ref.id);
          const revisions = sentinelArchiveLinkRevisions(
            join(staged.directory, "sentinel-assessment.db"),
            identity.runId,
            ref.revision!,
          );
          const execution = await stageCaseExecutionEvidence(
            baseDir,
            livePath,
            staged.directory,
            join(staged.directory, "sentinel-assessment.db"),
            revisions,
            await readSentinelChatSnapshot(
              join(staged.directory, "sentinel.json"),
            ),
          );
          if (execution) snapshots.push(execution);
          const adaptive = staged.artifacts.find(({ name }) =>
            name === "sentinel-adaptive.db"
          );
          const discoveries = await stageArchivedDiscoveryApprovals(
            baseDir,
            livePath,
            staged.directory,
            adaptive?.path,
            { caseId: ref.id, runId: identity.runId },
            revisions,
          );
          if (discoveries) snapshots.push(discoveries);
          const digestCatalog = stageSentinelArchivedDigestCatalog(
            baseDir,
            livePath,
            staged.directory,
            { caseId: ref.id, runId: identity.runId },
            revisions,
          );
          if (digestCatalog) snapshots.push(digestCatalog);
          for (const kind of ["topology", "assessment_reviews"] as const) {
            const source = await stageArchivedSourceSnapshots(
              baseDir,
              staged.directory,
              livePath,
              {
                kind,
                path: join(staged.directory, "sentinel.json"),
                revisions,
              },
            );
            if (source) snapshots.push(source);
          }
          if (adaptive) {
            for (
              const sourceKind of [
                "findings",
                "worker_traces",
                "planner_reads",
              ] as const
            ) {
              const source = await stageArchivedSourceSnapshots(
                baseDir,
                staged.directory,
                livePath,
                {
                  kind: "adaptive",
                  path: adaptive.path,
                  runId: identity.runId,
                  revision: ref.revision!,
                  source: sourceKind,
                },
              );
              if (source) snapshots.push(source);
            }
          }
          const manifest = await writeRunArchive(
            archivePath,
            identity,
            [
              ...staged.artifacts.map(({ name, path }) => ({
                name,
                sourcePath: path,
              })),
              { name: sentinelArchivedLinksFile, sourcePath },
              ...snapshots,
            ],
            permittedSentinelRestoreArtifacts,
          );
          archiveDigest = digestManifest(manifest);
        } finally {
          await Deno.remove(staged.directory, { recursive: true });
        }
      } else if (action === "archive") {
        const snapshot = role
          ? (() => {
            const trace = openTrace();
            try {
              const saved = trace.readRun(role, identity.runId, "INTERNAL");
              if (!saved) return;
              if (saved.status !== "running") {
                return trace.archiveSnapshot(role, identity.runId, "INTERNAL");
              }
              const key = recoveryKey(saved.scope.sessionId, identity.runId);
              using lock = lockAgentRecovery(recoveryPath, key);
              if (!lock) return;
              const recovery = new AgentRecoveryStore(recoveryPath);
              try {
                const checkpoint = recovery.read(key);
                const snapshot = trace.archiveSnapshot(
                  role,
                  identity.runId,
                  "INTERNAL",
                  true,
                );
                if (
                  !checkpoint || !snapshot ||
                  snapshot.run.status !== "running" ||
                  (checkpoint.status !== "ready" &&
                    checkpoint.status !== "paused") ||
                  !checkpoint.checkpoint || !checkpoint.tools.length ||
                  checkpoint.tools.some(({ classification }) =>
                    !canFlowTo(classification, "INTERNAL")
                  )
                ) return;
                const admission = role === "scheduled"
                  ? schedulerAdmissionArchive(baseDir, snapshot.run.scope)
                    ?.read()
                  : undefined;
                if (role === "scheduled" && !admission) return;
                return {
                  trace: snapshot,
                  checkpoint,
                  ...(admission && { admission }),
                };
              } finally {
                recovery.close();
              }
            } finally {
              trace.close();
            }
          })()
          : workflows?.archiveSnapshot(identity.runId);
        if (!snapshot) throw new Error("Run is unavailable");
        const stagedSnapshot = role ? snapshot : (() => {
          const links = openOperatorRunLinkStore(linkPath);
          try {
            return {
              ...snapshot,
              links: links.archive("workspace-operator", {
                kind: "workflow",
                id: identity.runId,
              }),
            };
          } finally {
            links.close();
          }
        })();
        const staging = await Deno.makeTempDir({ dir: directory });
        try {
          const sourcePath = join(staging, artifacts[0]);
          await Deno.writeTextFile(sourcePath, JSON.stringify(stagedSnapshot), {
            mode: 0o600,
          });
          archiveDigest = digestManifest(
            await writeRunArchive(
              archivePath,
              identity,
              [{ name: artifacts[0], sourcePath }],
              artifacts,
            ),
          );
        } finally {
          await Deno.remove(staging, { recursive: true });
        }
      } else {
        await withVerifiedRunArchive(archivePath, directory, {
          expectedKind: ref.kind,
          permittedNames: sentinel
            ? permittedSentinelRestoreArtifacts
            : artifacts,
          requiredNames: sentinel
            ? requiredSentinelRestoreArtifacts
            : artifacts,
        }, async (archive) => {
          if (
            !exact(archive.manifest.identity) ||
            digestManifest(archive.manifest) !== source?.archiveDigest
          ) {
            throw new Error("Mismatched run archive");
          }
          if (sentinel) {
            await restoreVerifiedSentinelCaseArchive(baseDir, archive, {
              requestId: request,
              recovering,
            });
          } else {
            const path = archive.artifactPath(artifacts[0]);
            if (!path) throw new Error("Archive artifact is unavailable");
            const snapshot = JSON.parse(await Deno.readTextFile(path));
            if (role) {
              const trace = openTrace();
              try {
                const record = snapshot?.checkpoint;
                const scope = snapshot?.trace?.run?.scope;
                const key = scope &&
                  recoveryKey(scope.sessionId, identity.runId);
                using lock = record && key
                  ? lockAgentRecovery(recoveryPath, key)
                  : undefined;
                const admission = snapshot?.admission &&
                  schedulerAdmissionArchive(baseDir, scope)?.restore(
                    snapshot.admission,
                  );
                if (
                  snapshot?.admission &&
                  (!admission || !record || role !== "scheduled")
                ) {
                  throw new Error("Invalid scheduler archive admission");
                }
                if (
                  (record && !lock) || !trace.restoreSnapshot(
                    record ? snapshot.trace : snapshot,
                    role,
                    identity.runId,
                    "INTERNAL",
                    record
                      ? { path: recoveryPath, record, admission }
                      : undefined,
                  )
                ) {
                  throw new Error("Execution trace could not be restored");
                }
              } finally {
                trace.close();
              }
            } else {
              if (snapshot.links !== undefined) {
                openOperatorRunLinkStore(linkPath).close();
              }
              if (
                !workflows?.restoreArchive(
                  identity.runId,
                  snapshot,
                  snapshot.links === undefined
                    ? undefined
                    : { path: linkPath, records: snapshot.links },
                )
              ) {
                throw new Error("Workflow archive could not be restored");
              }
            }
          }
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
