import { readRunArchivePlanDependencies } from "../sentinel/archive_dependencies.ts";
import {
  decodeArchivedToolDecisions,
  openApprovalInbox,
} from "../core/approval_inbox.ts";
import { toolApprovalOwnerScope } from "../core/tool_approval_service.ts";
import { isDeepStrictEqual } from "node:util";
import { stageSentinelToolDecisions } from "../sentinel/archive_tool_decisions.ts";
import { teamAdmissionArchive } from "./startup/factory/team_admission_archive.ts";
import { executionTraceSourceVisible } from "../core/team_delivery_trace_source.ts";
import type { SessionId } from "../core/types/session.ts";
import {
  parseTeamDeliveryTraceSource,
  teamDeliveryExecutionId,
} from "./startup/factory/delegated_agent_recovery.ts";
import { assignmentRecoveryKey as recoveryKey } from "../core/durable_assignment.ts";
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
  isPausedBeforeFirstAction,
  lockAgentRecovery,
} from "../core/agent_recovery_store.ts";
import {
  canFlowTo,
  type ClassificationLevel,
} from "../core/types/classification.ts";
import {
  lockRunArchiveAction,
  lockSentinelArchiveCatalog,
  openRunArchiveActions,
  type RunArchiveActionRecord,
} from "../core/run_archive_actions.ts";
import {
  type ExecutionTraceArchive,
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
const ownerArtifacts = ["owner-checkpoint.json"] as const;
const traceArtifacts = ["execution-trace.json"] as const;
type ArchiveRef = OperatorRunRef | {
  kind: ExecutionTraceRole | "owner_chat" | "team_delivery";
  id: string;
  revision?: undefined;
};

function archiveTraceToolDecisions(
  baseDir: string,
  snapshot: ExecutionTraceArchive,
  ceiling: ClassificationLevel,
): ExecutionTraceArchive | undefined {
  const { runId, sessionId } = snapshot.run.scope;
  const decisions = new Map(
    snapshot.toolDecisions?.map((entry) => [entry.id, entry]),
  );
  const inboxPath = join(baseDir, "tool-approvals.db");
  try {
    Deno.lstatSync(inboxPath);
    const inbox = openApprovalInbox(inboxPath);
    try {
      for (
        const entry of inbox.archiveRunDecisions(
          toolApprovalOwnerScope,
          runId,
          sessionId,
        )
      ) {
        const prior = decisions.get(entry.id);
        if (prior && !isDeepStrictEqual(prior, entry)) {
          throw new Error("Conflicting archived tool decision.");
        }
        decisions.set(entry.id, entry);
      }
    } finally {
      inbox.close();
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (!decisions.size) return snapshot;
  if (!canFlowTo("INTERNAL", ceiling)) return;
  return {
    ...snapshot,
    toolDecisions: decodeArchivedToolDecisions(
      [...decisions.values()].sort((a, b) =>
        b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
      ),
      runId,
    ),
  };
}

export async function executeOperatorRunArchive(
  baseDir: string,
  ref: ArchiveRef,
  args: Record<string, unknown>,
  confirm: (message: string) => Promise<boolean>,
  workflows?: OperatorWorkflowRuns,
  ownerScope?: { sessionId: string; ceiling: ClassificationLevel },
): Promise<
  | { receipt: RunArchiveActionRecord }
  | {
    identity: RunArchiveIdentity;
    records: RunArchiveActionRecord[];
    nextBefore: number | null;
  }
  | string
> {
  const { action, runId, requestId, archiveId, limit, before } = args;
  const history = action === "archive_history";
  const sentinel = ref.kind === "sentinel";
  const team = ref.kind === "team_delivery";
  const teamTuple = team ? ref.id.toLowerCase().split(":") : [];
  if (
    team && (!ownerScope || teamTuple.length !== 3 ||
      !teamTuple.every((part) => uuid.test(part)) ||
      !canFlowTo("INTERNAL", ownerScope.ceiling))
  ) return unavailable;
  const [teamId, recipient, delivery] = teamTuple;
  const scopedTeamRun = team && ownerScope
    ? await teamDeliveryExecutionId(
      ownerScope.sessionId as SessionId,
      recipient as SessionId,
      delivery,
    )
    : undefined;
  const role = team
    ? "delegated"
    : ref.kind === "delegated" || ref.kind === "scheduled"
    ? ref.kind
    : undefined;
  function matchesTraceScope(
    scope: {
      role: string;
      sourceId?: string;
      sessionId: string;
      runId: string;
    },
  ) {
    if (scope.role !== role) return false;
    if (!team) {
      return !scope.sourceId?.startsWith("team-delivery:") &&
        executionTraceSourceVisible(
          role,
          scope.sourceId,
          ownerScope && canFlowTo("INTERNAL", ownerScope.ceiling)
            ? ownerScope.sessionId
            : undefined,
        );
    }
    const bound = parseTeamDeliveryTraceSource(scope.sourceId);
    return !!bound && bound.sender === ownerScope?.sessionId &&
      bound.teamId === teamId && bound.delivery === delivery &&
      scope.sessionId === recipient && scope.runId === scopedTeamRun;
  }
  const ownerKey = ref.kind === "owner_chat" && ownerScope &&
    recoveryKey(ownerScope.sessionId, ref.id.toLowerCase());
  const ownerChecklistScope = ownerKey && ownerScope
    ? {
      role: "owner_chat" as const,
      sessionId: ownerScope.sessionId,
      runId: ref.id.toLowerCase(),
    }
    : undefined;
  const artifacts = ownerKey
    ? ownerArtifacts
    : role
    ? traceArtifacts
    : workflowArtifacts;
  const ownerCanFlow = (level: ClassificationLevel) =>
    ownerScope !== undefined && canFlowTo(level, ownerScope.ceiling) &&
    canFlowTo(level, "INTERNAL");
  const ownerArchiveCeiling = ownerScope?.ceiling === "PUBLIC"
    ? "PUBLIC"
    : "INTERNAL";
  const linkPath = join(baseDir, "operator-run-links.db");
  const recoveryPath = join(baseDir, "agent-recovery.db");
  const openTrace = () =>
    openExecutionTraces(join(baseDir, "execution-traces.db"));
  if (
    (sentinel
      ? ref.revision === undefined || !isSentinelCaseId(ref.id) ||
        ref.id === "main" || typeof runId !== "string" || !uuid.test(runId)
      : ref.kind === "owner_chat"
      ? !ownerKey || !uuid.test(ref.id)
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
    id: ownerKey || team ? ref.id.toLowerCase() : ref.id,
    revision: ref.revision,
    runId: sentinel
      ? String(runId).toLowerCase()
      : ownerKey || scopedTeamRun || ref.id,
  };
  const directory = join(baseDir, "data", "run-archives");
  await Deno.mkdir(directory, { mode: 0o700, recursive: true });
  const info = await Deno.lstat(directory);
  if (!info.isDirectory || info.isSymlink || ((info.mode ?? 0) & 0o077) !== 0) {
    return unavailable;
  }
  let hasDelegatedRun = false;
  if (role === "delegated") {
    const trace = openTrace();
    try {
      const existing = trace.readRun(role, identity.runId, "RESTRICTED");
      if (existing && !matchesTraceScope(existing.scope)) return unavailable;
      hasDelegatedRun = existing !== undefined;
    } finally {
      trace.close();
    }
  }
  const exact = (other: RunArchiveIdentity) =>
    other.kind === identity.kind && other.id === identity.id &&
    other.runId === identity.runId && other.revision === identity.revision;

  async function canReadDelegatedArchive(saved?: RunArchiveActionRecord) {
    if (!saved || !saved.archiveDigest || !exact(saved.identity)) return false;
    try {
      return await withVerifiedRunArchive(
        join(directory, saved.archiveId),
        directory,
        {
          expectedKind: ref.kind,
          permittedNames: traceArtifacts,
          requiredNames: traceArtifacts,
        },
        async ({ manifest, artifactPath }) => {
          const path = artifactPath(traceArtifacts[0]);
          if (
            !path || !exact(manifest.identity) ||
            digestManifest(manifest) !== saved.archiveDigest
          ) return false;
          const snapshot = JSON.parse(await Deno.readTextFile(path));
          const scope = snapshot?.trace?.run?.scope ?? snapshot?.run?.scope;
          return scope?.runId === identity.runId && matchesTraceScope(scope);
        },
      );
    } catch {
      return false;
    }
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
      if (
        ref.kind === "delegated" && !hasDelegatedRun &&
        !await canReadDelegatedArchive(journal.latestArchive(identity))
      ) {
        return unavailable;
      }
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
    using lock = lockRunArchiveAction(directory, request);
    const prior = journal.read(request);
    if (
      prior &&
      (prior.action !== action || prior.archiveId !== id ||
        !exact(prior.identity))
    ) {
      return unavailable;
    }
    if (ref.kind === "delegated") {
      const archived = action === "restore" ? journal.readArchived(id) : prior;
      if (
        (!hasDelegatedRun || action === "restore") &&
        !await canReadDelegatedArchive(archived)
      ) return unavailable;
    }
    const recovering = prior?.status === "pending";
    if (prior && (!recovering || !lock)) return { receipt: prior };
    if (!lock) return unavailable;
    using packageLock = action === "restore" && request !== id
      ? lockRunArchiveAction(directory, id)
      : undefined;
    if (action === "restore" && request !== id && !packageLock) {
      return unavailable;
    }
    const source = action === "restore" ? journal.readArchived(id) : undefined;
    if (action === "restore") {
      if (
        source?.action !== "archive" || source.status !== "succeeded" ||
        !source.archiveDigest || !exact(source.identity)
      ) return unavailable;
    }
    if (action === "archive" && sentinel && !recovering) {
      const current = readSentinelAssessment(
        resolveSentinelCasePath(baseDir, ref.id),
      );
      if (
        !current || current.active || current.paused ||
        current.deadlineReviewPending ||
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
    using catalogLock = action === "archive" && sentinel
      ? lockSentinelArchiveCatalog(directory)
      : undefined;
    if (action === "archive" && sentinel && !catalogLock) return unavailable;
    const admission = recovering
      ? journal.recoverPending(input)
      : journal.admit(input);
    if (!admission) return unavailable;
    if (!admission.admitted) return { receipt: admission.record };
    const archivePath = join(directory, id);
    let outcome: "succeeded" | "failed" = "failed";
    let archiveDigest: string | undefined;
    const verification = {
      expectedKind: ref.kind,
      permittedNames: sentinel ? permittedSentinelRestoreArtifacts : artifacts,
      requiredNames: sentinel ? requiredSentinelRestoreArtifacts : artifacts,
    };
    const recordPublication = (manifest: RunArchiveManifest) => {
      if (
        !journal.recordPublication(
          input,
          admission.token,
          digestManifest(manifest),
        )
      ) {
        throw new Error("Archive publication could not be recorded");
      }
    };
    try {
      if (action === "archive" && recovering) {
        archiveDigest = await withVerifiedRunArchive(
          archivePath,
          directory,
          verification,
          ({ manifest }) => {
            const digest = digestManifest(manifest);
            if (!exact(manifest.identity) || digest !== prior.archiveDigest) {
              throw new Error("Mismatched pending archive publication");
            }
            return digest;
          },
        );
      } else if (action === "archive" && sentinel) {
        const staged = captureStoppedSentinelCaseArtifacts(baseDir, {
          caseId: ref.id,
          runId: identity.runId,
          evidenceRevision: ref.revision!,
        }, directory);
        try {
          const dependencies = readRunArchivePlanDependencies(
            join(staged.directory, "sentinel-assessment.db"),
          );
          if (
            !dependencies ||
            dependencies.some((ref) =>
              ref.kind === "sentinel" && ref.revision !== undefined &&
              journal.hasRemovedSentinelSource(ref.id, ref.revision, ref.runId)
            )
          ) throw new Error("Sentinel archive dependency is unavailable");
          const journalLinks = openOperatorRunLinkStore(linkPath);
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
                    links: journalLinks.archive("workspace-operator", {
                      ...ref,
                      revision,
                    }),
                  }))
                  .filter(({ links }) => links.length > 0),
              };
            } finally {
              journalLinks.close();
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
          const toolDecisions = stageSentinelToolDecisions(
            baseDir,
            livePath,
            staged.directory,
            ref.id,
            identity.runId,
          );
          if (toolDecisions) snapshots.push(toolDecisions);
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
            recordPublication,
          );
          archiveDigest = digestManifest(manifest);
        } finally {
          await Deno.remove(staged.directory, { recursive: true });
        }
      } else if (action === "archive") {
        const snapshot = ownerKey
          ? (() => {
            using lock = lockAgentRecovery(recoveryPath, ownerKey);
            if (!lock) return;
            const store = new AgentRecoveryStore(recoveryPath);
            try {
              const record = store.read(ownerKey);
              if (
                record && (record.status === "finished" ||
                  ((record.status === "ready" || record.status === "paused") &&
                    record.checkpoint && record.tools.length &&
                    record.tools.every(({ classification }) =>
                      ownerCanFlow(classification)
                    )))
              ) {
                const checklist = ownerChecklistScope && store.ownerChecklist(
                  ownerChecklistScope,
                  ownerArchiveCeiling,
                );
                const trace = openTrace();
                try {
                  let saved = trace.readRun(
                    "owner_chat",
                    ownerKey,
                    "RESTRICTED",
                  );
                  const stopped = record.status === "finished" &&
                    record.stoppedAt !== undefined;
                  if (stopped && saved?.status === "running") {
                    saved = trace.cancelRun(
                      "owner_chat",
                      ownerKey,
                      ownerArchiveCeiling,
                    );
                  }
                  const traceSnapshot = saved &&
                    trace.archiveSnapshot(
                      "owner_chat",
                      ownerKey,
                      ownerArchiveCeiling,
                      record.status !== "finished",
                    );
                  if (
                    record.status === "finished"
                      ? stopped
                        ? traceSnapshot?.run.status !== "interrupted" ||
                          traceSnapshot.run.operatorCancelled !== true
                        : traceSnapshot?.run.status !== "completed"
                      : saved && (!traceSnapshot || saved.status !== "running")
                  ) return;
                  const archivedTrace = traceSnapshot &&
                    archiveTraceToolDecisions(
                      baseDir,
                      traceSnapshot,
                      ownerArchiveCeiling,
                    );
                  if (traceSnapshot && !archivedTrace) return;
                  return {
                    ...record,
                    ...(checklist && { checklist }),
                    ...(archivedTrace && { trace: archivedTrace }),
                  };
                } finally {
                  trace.close();
                }
              }
            } finally {
              store.close();
            }
          })()
          : role
          ? await (async () => {
            const trace = openTrace();
            try {
              const saved = trace.readRun(role, identity.runId, "INTERNAL");
              if (!saved || !matchesTraceScope(saved.scope)) return;
              if (saved.status !== "running") {
                const savedTrace = trace.archiveSnapshot(
                  role,
                  identity.runId,
                  "INTERNAL",
                );
                const snapshot = savedTrace && archiveTraceToolDecisions(
                  baseDir,
                  savedTrace,
                  ownerScope?.ceiling ?? "INTERNAL",
                );
                if (snapshot && role === "scheduled") {
                  const admission = schedulerAdmissionArchive(
                    baseDir,
                    saved.scope,
                  )?.read(true);
                  let finishedRecovery;
                  if (saved.status === "completed") {
                    const key = recoveryKey(
                      saved.scope.sessionId,
                      identity.runId,
                    );
                    using lock = lockAgentRecovery(recoveryPath, key);
                    if (!lock) return;
                    const journal = new AgentRecoveryStore(recoveryPath);
                    try {
                      const record = journal.read(key);
                      if (record?.status === "finished") {
                        finishedRecovery = record;
                      }
                    } finally {
                      journal.close();
                    }
                  }
                  return admission || finishedRecovery
                    ? {
                      trace: snapshot,
                      finishedRecovery,
                      terminalAdmission: admission,
                    }
                    : snapshot;
                }
                if (
                  !snapshot || saved.status !== "completed" ||
                  role !== "delegated" || (!team &&
                    (!saved.scope.sourceId || !uuid.test(saved.scope.sourceId)))
                ) return snapshot;
                const key = recoveryKey(saved.scope.sessionId, identity.runId);
                using lock = lockAgentRecovery(recoveryPath, key);
                if (!lock) return;
                const store = new AgentRecoveryStore(recoveryPath);
                try {
                  const finished = store.read(key);
                  if (!finished) return snapshot;
                  if (finished.status !== "finished") return;
                  const admission = team
                    ? await teamAdmissionArchive(baseDir, snapshot.run.scope)
                      ?.read()
                    : undefined;
                  if (team && !admission) return snapshot;
                  return {
                    trace: snapshot,
                    finishedRecovery: finished,
                    ...(admission && { admission }),
                  };
                } finally {
                  store.close();
                }
              }
              const key = recoveryKey(saved.scope.sessionId, identity.runId);
              using lock = lockAgentRecovery(recoveryPath, key);
              if (!lock) return;
              const recovery = new AgentRecoveryStore(recoveryPath);
              try {
                const checkpoint = recovery.read(key);
                const savedTrace = trace.archiveSnapshot(
                  role,
                  identity.runId,
                  "INTERNAL",
                  true,
                );
                const snapshot = savedTrace && archiveTraceToolDecisions(
                  baseDir,
                  savedTrace,
                  ownerScope?.ceiling ?? "INTERNAL",
                );
                if (
                  !checkpoint || !snapshot ||
                  snapshot.run.status !== "running" ||
                  (checkpoint.status !== "ready" &&
                    checkpoint.status !== "paused") ||
                  (isPausedBeforeFirstAction(checkpoint)
                    ? snapshot.entries.length > 0
                    : !checkpoint.checkpoint || !checkpoint.tools.length) ||
                  checkpoint.tools.some(({ classification }) =>
                    !canFlowTo(classification, "INTERNAL")
                  )
                ) return;
                const admission = team
                  ? await teamAdmissionArchive(baseDir, snapshot.run.scope)
                    ?.read()
                  : role === "scheduled"
                  ? schedulerAdmissionArchive(baseDir, snapshot.run.scope)
                    ?.read()
                  : undefined;
                if ((team || role === "scheduled") && !admission) return;
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
        const stagedSnapshot = ownerKey ? snapshot : (() => {
          const links = openOperatorRunLinkStore(linkPath);
          try {
            return {
              ...snapshot,
              links: links.archive("workspace-operator", {
                kind: role ?? "workflow",
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
              recordPublication,
            ),
          );
        } finally {
          await Deno.remove(staging, { recursive: true });
        }
      } else {
        await withVerifiedRunArchive(
          archivePath,
          directory,
          verification,
          async (archive) => {
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
              const installKey = {
                requestId: request,
                archiveDigest: digestManifest(archive.manifest),
              };
              const path = archive.artifactPath(artifacts[0]);
              if (!path) throw new Error("Archive artifact is unavailable");
              const snapshot = JSON.parse(await Deno.readTextFile(path));
              if (ownerKey) {
                using lock = lockAgentRecovery(recoveryPath, ownerKey);
                const finished = snapshot?.status === "finished";
                if (
                  !lock || snapshot?.key !== ownerKey ||
                  (finished
                    ? !Object.hasOwn(snapshot, "trace") ||
                      Object.hasOwn(snapshot, "tools") ||
                      Object.hasOwn(snapshot, "checkpoint")
                    : (snapshot.status !== "ready" &&
                      snapshot.status !== "paused") ||
                      !Array.isArray(snapshot.tools) ||
                      !snapshot.tools.every((
                        { classification }: {
                          classification: ClassificationLevel;
                        },
                      ) => ownerCanFlow(classification)))
                ) throw new Error("Invalid owner checkpoint archive");
                if (Object.hasOwn(snapshot, "trace")) {
                  const trace = openTrace();
                  try {
                    if (
                      !trace.restoreSnapshot(
                        snapshot.trace,
                        "owner_chat",
                        ownerKey,
                        ownerArchiveCeiling,
                        {
                          path: recoveryPath,
                          record: snapshot,
                          ...(Object.hasOwn(snapshot, "checklist") && {
                            ownerChecklist: snapshot.checklist,
                          }),
                        },
                        installKey,
                      )
                    ) {
                      throw new Error(
                        "Owner trace and checkpoint could not be restored",
                      );
                    }
                  } finally {
                    trace.close();
                  }
                  return;
                }
                const store = new AgentRecoveryStore(recoveryPath);
                try {
                  if (
                    !store.restorePaused(
                      snapshot,
                      installKey,
                      Object.hasOwn(snapshot, "checklist") &&
                        ownerChecklistScope && ownerScope
                        ? {
                          scope: ownerChecklistScope,
                          checklist: snapshot.checklist,
                          ceiling: ownerArchiveCeiling,
                        }
                        : undefined,
                    )
                  ) {
                    throw new Error("Owner checkpoint could not be restored");
                  }
                } finally {
                  store.close();
                }
              } else if (role) {
                const trace = openTrace();
                try {
                  const checkpoint = snapshot?.checkpoint;
                  const finished = snapshot?.finishedRecovery;
                  const terminalAdmission = snapshot?.terminalAdmission;
                  const record = checkpoint ?? finished;
                  const scope = snapshot?.trace?.run?.scope;
                  const archiveScope = scope ?? snapshot?.run?.scope;
                  if (
                    !archiveScope || !matchesTraceScope(archiveScope) ||
                    (finished !== undefined &&
                      (checkpoint !== undefined || !finished ||
                        finished.status !== "finished" ||
                        Object.hasOwn(finished, "tools") ||
                        Object.hasOwn(finished, "checkpoint"))) ||
                    (terminalAdmission !== undefined &&
                      (role !== "scheduled" || !scope ||
                        checkpoint !== undefined ||
                        snapshot?.admission !== undefined ||
                        snapshot?.trace?.run?.status === "running")) ||
                    (team && (!record && snapshot?.run?.status === "running"))
                  ) {
                    throw new Error(
                      "Execution trace archive is outside current scope",
                    );
                  }
                  const key = scope &&
                    recoveryKey(scope.sessionId, identity.runId);
                  using lock = record && key
                    ? lockAgentRecovery(recoveryPath, key)
                    : undefined;
                  const admission = terminalAdmission !== undefined && scope
                    ? schedulerAdmissionArchive(baseDir, scope)?.restore(
                      terminalAdmission,
                      true,
                    )
                    : snapshot?.admission && scope &&
                      (team
                        ? await teamAdmissionArchive(baseDir, scope)?.restore(
                          snapshot.admission,
                        )
                        : schedulerAdmissionArchive(baseDir, scope)?.restore(
                          snapshot.admission,
                        ));
                  if (
                    (snapshot?.admission &&
                      (!admission || !record ||
                        (!team && (role !== "scheduled" || !checkpoint)))) ||
                    (team && record && !admission) ||
                    (terminalAdmission !== undefined && !admission)
                  ) {
                    throw new Error("Invalid execution archive admission");
                  }
                  if (snapshot.links !== undefined) {
                    openOperatorRunLinkStore(linkPath).close();
                  }
                  if (
                    (record && !lock) || !trace.restoreSnapshot(
                      record || terminalAdmission !== undefined
                        ? snapshot.trace
                        : snapshot,
                      role,
                      identity.runId,
                      "INTERNAL",
                      record || terminalAdmission !== undefined
                        ? { path: recoveryPath, record, admission }
                        : undefined,
                      installKey,
                      snapshot.links === undefined
                        ? undefined
                        : { path: linkPath, records: snapshot.links },
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
                    installKey,
                  )
                ) {
                  throw new Error("Workflow archive could not be restored");
                }
              }
            }
          },
        );
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
