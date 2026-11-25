/// <reference path="./sqlite_types.d.ts" />
import {
  type SentinelOutputLanguage,
  sentinelOutputLanguages,
} from "../core/config_types.ts";
import {
  isSentinelFindingMutation,
  sentinelFindingMutationArguments,
} from "./worker_finding_recovery.ts";
import type { AgentTurnCheckpoint } from "../core/types/orchestrator.ts";

/** Durable leases and evidence provenance for allowlisted defensive tasks. */

import {
  normalizeSentinelWorkflowReviewStep,
  readSentinelAssignedTargetReceipt,
  readSentinelGitHubWorkflowReadReceipt,
  type SentinelGitHubWorkflowReadReceipt,
  type SentinelReviewStep,
} from "./assessment_store.ts";
import {
  parseSentinelGraphFactRelationship,
  type SentinelWorkerGraphFact,
  type SentinelWorkerGraphRelationship,
} from "./worker_graph_facts.ts";
import { isSentinelCaseId } from "./cases.ts";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "@std/path";

const APPLICATION_ID = 0x53414450;
const VERSION = 1;
export const MAX_ADAPTIVE_TASKS = 1000;
export const MAX_ADAPTIVE_TASK_ATTEMPTS = 3;
const MAX_OBSERVATION_BYTES = 1024 * 1024;
const WORKER_CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_WORKER_CHECKPOINT_BYTES = 24 * 1024;
const WORKFLOW_CHECKPOINT_TOOL = "sentinel_live_workflow_status";
const WORKFLOW_CHECKPOINT_CALL = "sentinel-workflow-status";
const WORKFLOW_PUBLICATION_TOOL = "sentinel_publish_workflow_observation";
const WORKFLOW_PUBLICATION_CALL = "sentinel-workflow-publication";
const GRAPH_PUBLICATION_TOOL = "sentinel_publish_graph_fact";
const GRAPH_PUBLICATION_CALL = "sentinel-graph-publication";

export type SentinelJournalMutationLookup = (
  taskId: string,
  targetId: string,
  tool: string,
  requestId: string,
) => {
  readonly id: string;
  readonly args: Record<string, unknown>;
  readonly result: string;
  readonly source?: { stepIndex: number; sha256: string };
} | undefined;

export function sentinelGraphPublicationArguments(input: unknown) {
  if (!input || typeof input !== "object" || Object.keys(input).length !== 4) {
    return;
  }
  const { from, to, relation, requestId } = input as Record<string, unknown>;
  if (
    typeof from !== "string" || typeof requestId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId)
  ) return;
  const edge = parseSentinelGraphFactRelationship({ from, to, relation }, from);
  return edge && { ...edge, requestId: requestId.toLowerCase() };
}

function workflowPublicationResult(observation: AdaptiveWorkflowObservation) {
  const { id, targetId, evidenceRevision } = observation;
  return JSON.stringify({ id, targetId, evidenceRevision });
}
const ASSIGNED_TARGET_CHECKPOINT_TOOL = "sentinel_assigned_target";
const ASSIGNED_TARGET_CHECKPOINT_CALL = "sentinel-assigned-target";
const WORKER_STEERING_PREFIX = "Operator guidance for this assignment:\n";

export function formatSentinelWorkerSteering(id: number, note: string): string {
  return `Steering #${id}: ${JSON.stringify(note)}`;
}

export function workerSteeringCheckpointIds(
  history: AgentTurnCheckpoint["history"],
  steering: readonly Pick<
    SentinelWorkerControlReceipt,
    "steeringId" | "note"
  >[],
): number[] | undefined {
  const notes = steering.flatMap(({ steeringId, note }) =>
    steeringId === undefined || note === undefined ? [] : [{
      id: steeringId,
      text: formatSentinelWorkerSteering(steeringId, note),
    }]
  );
  const delivered: number[] = [];
  for (const entry of history.slice(1)) {
    if (entry?.role !== "user") continue;
    if (
      typeof entry.content !== "string" ||
      !entry.content.startsWith(WORKER_STEERING_PREFIX)
    ) return;
    let block: number[] | undefined;
    for (let start = 0; start < notes.length && !block; start++) {
      if (notes[start].id <= (delivered.at(-1) ?? 0)) continue;
      for (let end = start + 1; end <= notes.length; end++) {
        const candidate = notes.slice(start, end);
        if (
          entry.content ===
            WORKER_STEERING_PREFIX +
              candidate.map(({ text }) => text).join("\n")
        ) {
          block = candidate.map(({ id }) => id);
          break;
        }
      }
    }
    if (!block) return;
    delivered.push(...block);
  }
  return delivered;
}

function normalizeWorkerCheckpoint(
  value: AgentTurnCheckpoint,
  promptSha256: string,
  targetId: string,
  receipt: SentinelGitHubWorkflowReadReceipt | undefined,
  progress: readonly SentinelReviewStep[],
  publication: AdaptiveWorkflowObservation | undefined,
  steering: readonly Pick<
    SentinelWorkerControlReceipt,
    "steeringId" | "note"
  >[],
  lookupMutation?: (
    tool: string,
    requestId: string,
  ) => ReturnType<SentinelJournalMutationLookup>,
): AgentTurnCheckpoint | undefined {
  if (
    !value || !Array.isArray(value.history) || value.history.length < 3 ||
    value.history.length > 16 ||
    !Number.isSafeInteger(value.completedIterations) ||
    value.completedIterations < 1 || value.completedIterations > 4 ||
    value.nudgeCount !== 0 || value.eosRetries !== 0 ||
    !Array.isArray(value.toolCallCounts) ||
    !workerSteeringCheckpointIds(value.history, steering)
  ) return;
  const [user, ...exchanges] = value.history;
  const inputTokens = value.tokenUsage?.inputTokens;
  const outputTokens = value.tokenUsage?.outputTokens;
  if (
    !Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) || outputTokens < 0 ||
    user?.role !== "user" || typeof user.content !== "string" ||
    user.content.length > 8_000 ||
    createHash("sha256").update(user.content).digest("hex") !== promptSha256
  ) return;
  const history: AgentTurnCheckpoint["history"][number][] = [
    { role: "user", content: user.content },
  ];
  const seen = new Map<string, readonly [string, number]>();
  const sourceResults: string[] = [];
  let batches = 0;
  let guidance = 0;
  for (let index = 0; index < exchanges.length; index++) {
    const assistant = exchanges[index];
    if (assistant?.role === "user") {
      history.push({ role: "user", content: assistant.content });
      guidance++;
      continue;
    }
    if (
      assistant?.role !== "assistant" ||
      !Array.isArray(assistant.tool_calls) || !assistant.tool_calls.length ||
      assistant.tool_calls.length > 6
    ) return;
    batches++;
    const calls = [];
    const results: typeof history = [];
    const providerIds = new Set<string>();
    for (const raw of assistant.tool_calls) {
      const call = raw as {
        id?: unknown;
        type?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      } | undefined;
      const name = call?.function?.name;
      const workflow = name === WORKFLOW_CHECKPOINT_TOOL;
      const graph = name === GRAPH_PUBLICATION_TOOL;
      const finding =
        typeof name === "string" && isSentinelFindingMutation(name)
          ? name
          : undefined;
      const journalWrite = graph || finding !== undefined;
      const published = name === WORKFLOW_PUBLICATION_TOOL;
      if (
        typeof name !== "string" ||
        (!workflow && !published && !journalWrite &&
          name !== ASSIGNED_TARGET_CHECKPOINT_TOOL) ||
        seen.has(name) || typeof call?.id !== "string" ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(call.id) || providerIds.has(call.id) ||
        (call.type !== undefined && call.type !== "function") ||
        typeof call.function?.arguments !== "string" ||
        (!journalWrite && !/^\s*\{\s*\}\s*$/.test(call.function.arguments))
      ) return;
      const tool = exchanges[++index];
      if (
        tool?.role !== "tool" || tool.tool_call_id !== call.id ||
        typeof tool.content !== "string" || tool.content.length > 7_000
      ) return;
      let args: Record<string, unknown> = {};
      if (journalWrite) {
        let claimed:
          | ReturnType<typeof sentinelGraphPublicationArguments>
          | ReturnType<typeof sentinelFindingMutationArguments>;
        try {
          const offered = JSON.parse(call.function.arguments);
          claimed = finding
            ? sentinelFindingMutationArguments(finding, offered)
            : sentinelGraphPublicationArguments(offered);
        } catch {
          return;
        }
        const saved = claimed &&
          lookupMutation?.(String(name), claimed.requestId);
        const source = saved?.source && sourceResults[saved.source.stepIndex];
        if (
          !claimed || !saved || !isDeepStrictEqual(claimed, saved.args) ||
          tool.content !== saved.result ||
          (saved.source &&
            (!source || !seen.has(ASSIGNED_TARGET_CHECKPOINT_TOOL) ||
              saved.source.sha256 !==
                createHash("sha256").update(source).digest("hex")))
        ) return;
        args = claimed;
      } else if (workflow) {
        if (
          !receipt || tool.content !== JSON.stringify({ targetId, ...receipt })
        ) return;
      } else if (published) {
        if (
          !publication || !seen.has(WORKFLOW_CHECKPOINT_TOOL) ||
          tool.content !== workflowPublicationResult(publication)
        ) return;
      } else {
        const digest = createHash("sha256").update(tool.content).digest("hex");
        if (
          !progress.some((step) =>
            step.tool === name && step.outcome === "returned" &&
            step.assignedTarget?.targetId === targetId &&
            step.resultSnapshot?.sha256 === digest
          )
        ) return;
      }
      const id = workflow
        ? WORKFLOW_CHECKPOINT_CALL
        : published
        ? WORKFLOW_PUBLICATION_CALL
        : graph
        ? GRAPH_PUBLICATION_CALL
        : finding
        ? `recovery-${finding}`
        : ASSIGNED_TARGET_CHECKPOINT_CALL;
      seen.set(name, [
        `${name}:${JSON.stringify(args, Object.keys(args).sort())}`,
        1,
      ]);
      sourceResults.push(tool.content);
      providerIds.add(call.id);
      calls.push({
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      });
      results.push({ role: "tool", content: tool.content, tool_call_id: id });
    }
    history.push(
      { role: "assistant", content: " ", tool_calls: calls },
      ...results,
    );
  }
  const counts = [...seen.values()];
  if (
    history.at(-1)?.role !== "tool" || value.completedIterations < batches ||
    value.completedIterations > batches + guidance ||
    !isDeepStrictEqual(value.toolCallCounts, counts)
  ) return;
  return {
    history,
    completedIterations: value.completedIterations,
    tokenUsage: { inputTokens, outputTokens },
    nudgeCount: 0,
    eosRetries: 0,
    toolCallCounts: counts,
  };
}
const MAX_PLANNER_RELATED_NODE_IDS = 50;

function validatedPlannerObservationNodeIds(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length > MAX_OBSERVATION_BYTES) return [];
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values)) return [];
  const ids = new Set<string>();
  for (const value of values) {
    if (
      typeof value === "string" && value.length <= 4096 && value.trim() &&
      !value.includes("\x00")
    ) {
      ids.add(value);
      if (ids.size === MAX_PLANNER_RELATED_NODE_IDS) break;
    }
  }
  return [...ids];
}

function savedAssignedTargetEvidenceIds(raw: unknown, nodeId: unknown) {
  if (typeof raw !== "string" || raw.length > MAX_OBSERVATION_BYTES) return [];
  const receipts: unknown = JSON.parse(raw);
  if (!Array.isArray(receipts)) return [];
  const ids = new Set<string>();
  for (const value of receipts) {
    const receipt = readSentinelAssignedTargetReceipt(value, nodeId);
    for (const id of receipt?.linkedNodeIds ?? []) {
      ids.add(id);
      if (ids.size === MAX_PLANNER_RELATED_NODE_IDS) return [...ids];
    }
  }
  return [...ids];
}

function savedGitHubWorkflowReads(raw: unknown, evidenceRevision: number) {
  if (typeof raw !== "string" || raw.length > MAX_OBSERVATION_BYTES) return [];
  const receipts = JSON.parse(raw) as unknown[];
  const retained = new Map<string, SentinelGitHubWorkflowReadReceipt>();
  for (const value of receipts) {
    const receipt = readSentinelGitHubWorkflowReadReceipt(
      value,
      evidenceRevision,
    );
    if (receipt) retained.set(JSON.stringify(receipt), receipt);
  }
  return [...retained.values()];
}
const MAX_REVISION_OBSERVATION_BYTES = 16 * 1024 * 1024;
const taskKinds = [
  "coverage",
  "defense_coverage",
  "impact",
  "trace",
  "case",
  "incident_correlation",
  "review_finding",
  "review_evidence",
  "review_incident",
  "verify_control_coverage",
] as const;
const scopedKinds = new Set<AdaptiveTaskKind>([
  "impact",
  "trace",
  "review_finding",
  "review_evidence",
  "review_incident",
]);

export type AdaptiveTaskKind = typeof taskKinds[number];
export type AdaptiveTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "superseded"
  | "cancelled";

export type AdaptiveSourceKind = "worker_result" | "model_review";

export interface AdaptiveUpstreamCitation {
  readonly alertId: string;
  readonly checkId: string;
}

export interface AdaptiveWorkerSource {
  readonly taskId: string;
  readonly kind: AdaptiveSourceKind;
}

export interface AdaptivePeerFindingCitation {
  readonly localAssetId: string;
  readonly sourceCaseId: string;
  readonly sourceAssetId: string;
  readonly sourceFindingId: string;
  readonly snapshotDigest: string;
}

/** A completed, internal check against a destination evidence revision. */
export interface AdaptivePeerFindingVerification {
  readonly citation: AdaptivePeerFindingCitation;
  readonly verified: boolean;
}

export interface AdaptivePriorAssignedTargetCitation {
  readonly sourceTaskId: string;
  readonly evidenceRevision: number;
  readonly targetId: string;
  readonly stepIndex: number;
}

export interface AdaptiveCarriedAssignedTargetCitation {
  readonly carrierTaskId: string;
  readonly citation: AdaptivePriorAssignedTargetCitation;
}

export interface AdaptivePlannerRound {
  readonly graphFactId?: string;
  readonly graphFactOnly?: true;
  readonly graphRelationship?: SentinelWorkerGraphRelationship;
  readonly identity: string;
  readonly githubWorkflowCitation?: {
    readonly sourceTaskId: string;
    readonly resultSha256: string;
  };
  readonly attempt: number;
  readonly hintId?: number;
  readonly sourceKind?: AdaptiveSourceKind;
  readonly workerSources?: readonly AdaptiveWorkerSource[];
  readonly upstreamCheckId?: string;
  readonly upstreamCitations?: readonly AdaptiveUpstreamCitation[];
  readonly peerFindingCitations?: readonly AdaptivePeerFindingCitation[];
  readonly priorAssignedTargetCitations?:
    readonly AdaptivePriorAssignedTargetCitation[];
  readonly carriedAssignedTargetCitations?:
    readonly AdaptiveCarriedAssignedTargetCitation[];
}

export interface AdaptivePlannerConstraintProof {
  readonly version: number;
  readonly digest: string;
}

/** Exact bounded inputs included in the rendered request for one attempt. */
export interface AdaptivePlannerInputManifest {
  readonly promptSha256: string;
  readonly operatingConstraints?: AdaptivePlannerConstraintProof;
  readonly hintIds: readonly number[];
  readonly findingReviewIds: readonly number[];
  readonly incidentReviewIds: readonly number[];
  readonly incidentCandidateIds: readonly string[];
  readonly investigationIds: readonly string[];
  readonly inventoryNodeIds: readonly string[];
  readonly workerObservations: readonly {
    readonly taskId: string;
    readonly workerResult: boolean;
    readonly modelReviewSummary: boolean;
    readonly modelReviewRelatedNodeIds?: readonly string[];
    readonly priorAssignedTargetCitations?:
      readonly AdaptivePriorAssignedTargetCitation[];
  }[];
  readonly upstreamCheckIds?: readonly string[];
  readonly graphFactIds?: readonly string[];
  readonly findingRecheckIds?: readonly string[];
  readonly coldDigestIds?: readonly string[];
}

/** Metadata from one completed tool call in a dispatched planner attempt. */
export interface AdaptivePlannerRead {
  readonly tool: string;
  readonly outcome: "returned" | "error";
  readonly target?: string;
  readonly resultSha256?: string;
  readonly sourceSnapshots?: SentinelReviewStep["sourceSnapshots"];
}

export interface AdaptiveTaskRequest {
  readonly kind: AdaptiveTaskKind;
  readonly nodeId?: string;
  readonly depth?: number;
  readonly prerequisites?: readonly string[];
  readonly reason?: string;
  readonly plannerRound?: AdaptivePlannerRound;
  readonly carriedFrom?: string;
  readonly revalidatedPeerFindingCitations?:
    readonly AdaptivePeerFindingCitation[];
  readonly revalidatedAssignedTargetCitations?:
    readonly AdaptivePriorAssignedTargetCitation[];
  readonly carriedAssignedTargetCitations?:
    readonly AdaptiveCarriedAssignedTargetCitation[];
  readonly reviewedFrom?: string;
  readonly reopened?: boolean;
  readonly reuseObservation?: boolean;
  readonly removedEvidenceIds?: readonly string[];
  readonly evidenceIds?: readonly string[];
}

interface PlannerQueueChanges {
  readonly priorities?: readonly string[];
  readonly retirements?: readonly { id: string; reason: string }[];
}

export interface AdaptiveTask extends AdaptiveTaskRequest {
  readonly id: string;
  readonly revision: string;
  readonly prerequisites: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly status: AdaptiveTaskStatus;
  readonly attempts: number;
  readonly prioritized?: boolean;
  readonly plannerPriority?: number;
  readonly retirementReason?: string;
  readonly dependencyRecommendation?: {
    readonly id: string;
    readonly prerequisites: readonly string[];
    readonly reason: string;
    readonly size?: number;
    readonly queueOnly?: boolean;
    readonly queueChanges?: PlannerQueueChanges;
    readonly citations?: readonly AdaptiveTaskRequest[];
    readonly additions?:
      readonly (AdaptiveTaskRequest & { readonly id: string })[];
  };
  readonly observation?: unknown;
  readonly factSatisfaction?: AdaptiveFactSatisfaction;
  readonly leaseExpiresAt?: string;
}

export interface AdaptiveFactSatisfaction {
  readonly sourceTaskId: string;
  readonly sourceObservationSha256: string;
  readonly graphFactId?: string;
}

export interface SentinelWorkerControlReceipt {
  readonly requestId: string;
  readonly revision: string;
  readonly taskId: string;
  readonly action: "steer" | "stop";
  readonly note?: string;
  readonly requestedAt: string;
  readonly steeringId?: number;
}

function decodeWorkerControl(row: Row): SentinelWorkerControlReceipt {
  return {
    requestId: String(row.requestId),
    revision: String(row.revision),
    taskId: String(row.taskId),
    action: row.action === "stop" ? "stop" : "steer",
    ...(typeof row.note === "string" && { note: row.note }),
    requestedAt: new Date(Number(row.requestedAt)).toISOString(),
    ...(row.action === "steer" && { steeringId: Number(row.id) }),
  };
}

/** A committed intermediate workflow fact, independent of review completion. */
export interface AdaptiveWorkflowObservation {
  readonly id: string;
  readonly taskId: string;
  readonly targetId: string;
  readonly evidenceRevision: number;
  readonly stepIndex: number;
  readonly receipt: SentinelGitHubWorkflowReadReceipt;
}

export function taskWorkerSources(
  task: Pick<AdaptiveTask, "reviewedFrom" | "plannerRound">,
): readonly AdaptiveWorkerSource[] {
  return task.plannerRound?.workerSources ?? (task.reviewedFrom
    ? [{
      taskId: task.reviewedFrom,
      kind: task.plannerRound
        ? task.plannerRound.sourceKind ?? "worker_result"
        : "model_review",
    }]
    : []);
}

export function taskUpstreamCitations(
  task: Pick<AdaptiveTask, "plannerRound" | "evidenceIds">,
): readonly AdaptiveUpstreamCitation[] {
  const round = task.plannerRound;
  if (round?.upstreamCitations) return round.upstreamCitations;
  const checkId = round?.upstreamCheckId;
  return checkId
    ? task.evidenceIds.filter((id) => id.startsWith("case-alert:"))
      .map((alertId) => ({ alertId, checkId }))
    : [];
}

export function roundWithUpstreamCitations(
  round: AdaptivePlannerRound,
  citations: readonly AdaptiveUpstreamCitation[],
): AdaptivePlannerRound {
  const check = citations[0]?.checkId;
  return {
    ...round,
    upstreamCheckId: citations.every(({ checkId }) => check === checkId)
      ? check
      : undefined,
    upstreamCitations: citations.length ? citations : undefined,
  };
}

export interface AdaptiveTaskEvent {
  readonly revision: string;
  readonly taskId: string;
  readonly event: string;
  readonly attempt: number;
  readonly at: string;
  readonly note: string | null;
  readonly removedEvidenceIds?: readonly string[];
}

export interface AdaptiveTaskNote {
  readonly steps?: readonly SentinelReviewStep[];
  readonly revision: string;
  readonly taskId: string | null;
  readonly note: string;
  readonly at: string;
}

type RelationshipTaskIdentity = Pick<
  AdaptivePlannerRound,
  "graphFactOnly" | "graphFactId" | "graphRelationship"
>;
type TaskIdentity =
  & Pick<AdaptiveTaskRequest, "kind" | "nodeId" | "depth">
  & RelationshipTaskIdentity
  & { plannerRound?: Partial<AdaptivePlannerRound> };
type Row = NonNullable<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>>;

function revisionKey(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z\d._:-]{1,224}$/.test(value)) {
    throw new Error("Invalid Sentinel adaptive evidence revision");
  }
  return value;
}

function boundedText(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== "string" || !value.trim() || value.length > maxLength ||
    value.includes("\x00")
  ) {
    throw new Error(`Invalid Sentinel adaptive ${field}`);
  }
  return value;
}

function optionalText(value: unknown, field: string, maxLength: number) {
  return value === undefined ? undefined : boundedText(value, field, maxLength);
}

const MAX_PLANNER_READS = 32;

function normalizePlannerRead(read: AdaptivePlannerRead): AdaptivePlannerRead {
  if (
    !read || typeof read.tool !== "string" ||
    !/^sentinel_[a-z0-9_]{1,63}$/.test(read.tool) ||
    (read.outcome !== "returned" && read.outcome !== "error")
  ) throw new Error("Invalid Sentinel planner read");
  if (read.outcome === "error") return { tool: read.tool, outcome: "error" };
  if (
    read.resultSha256 !== undefined &&
    (typeof read.resultSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(read.resultSha256))
  ) throw new Error("Invalid Sentinel planner read digest");
  const target = optionalText(read.target, "planner read target", 4096);
  if (
    read.sourceSnapshots !== undefined &&
    (!Array.isArray(read.sourceSnapshots) || read.sourceSnapshots.length > 32)
  ) throw new Error("Invalid Sentinel planner read sources");
  const sourceSnapshots = read.sourceSnapshots?.map((source) => {
    if (
      !source || typeof source.caseId !== "string" ||
      !isSentinelCaseId(source.caseId) ||
      typeof source.snapshotDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(source.snapshotDigest)
    ) throw new Error("Invalid Sentinel planner read source");
    const assetId = optionalText(source.assetId, "planner source asset", 4096);
    return {
      caseId: source.caseId,
      snapshotDigest: source.snapshotDigest,
      ...(assetId !== undefined && { assetId }),
    };
  });
  return {
    tool: read.tool,
    outcome: read.outcome,
    ...(target !== undefined && { target }),
    ...(read.resultSha256 !== undefined && { resultSha256: read.resultSha256 }),
    ...(sourceSnapshots?.length && { sourceSnapshots }),
  };
}

function manifestList<T>(
  items: readonly T[],
  limit: number,
  key: (item: T) => string,
): readonly T[] {
  if (
    !Array.isArray(items) || items.length > limit ||
    new Set(Array.from(items, key)).size !== items.length
  ) {
    throw new Error("Invalid Sentinel planning input manifest list");
  }
  return items;
}

function normalizePlannerConstraintProof(
  value: unknown,
): AdaptivePlannerConstraintProof | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const { version, digest } = value as Record<string, unknown>;
  if (
    typeof version !== "number" || !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)
  ) return undefined;
  return { version, digest };
}

function decodePlanningInputManifest(
  encoded: string,
): AdaptivePlannerInputManifest {
  const { operatingConstraints, ...manifest } = JSON.parse(
    encoded,
  ) as AdaptivePlannerInputManifest;
  const proof = normalizePlannerConstraintProof(operatingConstraints);
  return { ...manifest, ...(proof && { operatingConstraints: proof }) };
}

function normalizePlanningInputManifest(input: AdaptivePlannerInputManifest) {
  if (
    !input || typeof input !== "object" ||
    typeof input.promptSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.promptSha256)
  ) {
    throw new Error("Invalid Sentinel planning prompt digest");
  }
  const proof = normalizePlannerConstraintProof(input.operatingConstraints);
  if (input.operatingConstraints !== undefined && !proof) {
    throw new Error("Invalid Sentinel planning operating constraint proof");
  }
  function numericKey(id: number) {
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new Error("Invalid Sentinel planning input record ID");
    }
    return String(id);
  }
  const workerObservations = manifestList(
    input.workerObservations,
    128,
    (worker) => {
      if (
        !worker || typeof worker.workerResult !== "boolean" ||
        typeof worker.modelReviewSummary !== "boolean"
      ) {
        throw new Error("Invalid Sentinel planning worker input");
      }
      return taskId(worker.taskId);
    },
  ).map((
    {
      taskId,
      workerResult,
      modelReviewSummary,
      modelReviewRelatedNodeIds,
      priorAssignedTargetCitations,
    },
  ) => ({
    taskId,
    workerResult,
    modelReviewSummary,
    ...(modelReviewRelatedNodeIds !== undefined && {
      modelReviewRelatedNodeIds: manifestList(
        modelReviewRelatedNodeIds,
        MAX_PLANNER_RELATED_NODE_IDS,
        (id) => boundedText(id, "planning model review evidence ID", 4096),
      ),
    }),
    ...(priorAssignedTargetCitations !== undefined && {
      priorAssignedTargetCitations: normalizeAssignedTargetCitations(
        priorAssignedTargetCitations,
      ),
    }),
  }));
  const manifest: AdaptivePlannerInputManifest = {
    promptSha256: input.promptSha256,
    ...(proof && { operatingConstraints: proof }),
    hintIds: manifestList(input.hintIds, 3, numericKey),
    findingReviewIds: manifestList(input.findingReviewIds, 12, numericKey),
    incidentReviewIds: manifestList(input.incidentReviewIds, 12, numericKey),
    incidentCandidateIds: manifestList(input.incidentCandidateIds, 12, (id) => {
      if (typeof id !== "string" || !/^incident:[0-9a-f]{64}$/.test(id)) {
        throw new Error("Invalid Sentinel planning incident ID");
      }
      return id;
    }),
    investigationIds: manifestList(input.investigationIds, 30, taskId),
    inventoryNodeIds: manifestList(input.inventoryNodeIds, 30, (id) => {
      if (typeof id !== "string" || !id.trim() || id.length > 100) {
        throw new Error("Invalid Sentinel planning inventory node ID");
      }
      return id;
    }),
    workerObservations,
    ...(input.coldDigestIds !== undefined && {
      coldDigestIds: manifestList(input.coldDigestIds, 6, (id) => {
        if (
          typeof id !== "string" || !/^sentinel-digest:[a-f0-9]{64}$/.test(id)
        ) {
          throw new Error("Invalid Sentinel evidence digest ID");
        }
        return id;
      }),
    }),
    ...(input.graphFactIds !== undefined && {
      graphFactIds: manifestList(input.graphFactIds, 5, (id) => {
        if (
          typeof id !== "string" || !/^worker-graph-fact:[a-f0-9]{64}$/.test(id)
        ) {
          throw new Error("Invalid Sentinel graph fact ID");
        }
        return id;
      }),
    }),
    ...(input.findingRecheckIds !== undefined && {
      findingRecheckIds: manifestList(input.findingRecheckIds, 8, (id) => {
        if (
          typeof id !== "string" || !/^worker-recheck:[a-f0-9]{64}$/.test(id)
        ) {
          throw new Error("Invalid Sentinel finding recheck ID");
        }
        return id;
      }),
    }),
    ...(input.upstreamCheckIds !== undefined && {
      upstreamCheckIds: manifestList(
        input.upstreamCheckIds,
        128,
        (id) => boundedText(id, "planning upstream check ID", 128),
      ),
    }),
  };
  const encoded = JSON.stringify(manifest);
  if (new TextEncoder().encode(encoded).length > 32 * 1024) {
    throw new Error("Sentinel planning input manifest exceeds 32 KiB");
  }
  return encoded;
}

function normalizeIdentity(request: TaskIdentity) {
  const kind = taskKinds.find((kind) => kind === request.kind);
  if (kind === undefined) {
    throw new Error("Unsupported Sentinel adaptive task kind");
  }
  const nodeId = optionalText(request.nodeId, "node ID", 4096);
  if (scopedKinds.has(kind) && nodeId === undefined) {
    throw new Error("This Sentinel adaptive task requires an exact target ID");
  }
  const depth = request.depth;
  if (
    depth !== undefined && ((kind !== "trace" && kind !== "impact") ||
      !Number.isSafeInteger(depth) || depth < 0 || depth > 16)
  ) {
    throw new Error("Invalid Sentinel adaptive task depth");
  }
  const effectiveDepth = kind === "trace" || kind === "impact"
    ? depth ?? 2
    : undefined;
  return { kind, nodeId, depth: effectiveDepth };
}

export function sentinelAdaptiveTaskId(
  revision: string,
  request: TaskIdentity,
) {
  const { kind, nodeId, depth } = normalizeIdentity(request);
  const receipt = request.plannerRound ?? request;
  const relationship = receipt.graphFactOnly && receipt.graphRelationship;
  const requirement = !receipt.graphFactOnly
    ? undefined
    : relationship
    ? [relationship.from, relationship.relation, relationship.to]
    : receipt.graphFactId;
  const hash = createHash("sha256")
    .update(JSON.stringify([
      revisionKey(revision),
      kind,
      nodeId,
      depth,
      ...(requirement ? [requirement] : []),
    ]))
    .digest("hex");
  return `adaptive:${hash}`;
}

function taskId(value: unknown): string {
  if (typeof value !== "string" || !/^adaptive:[a-f\d]{64}$/.test(value)) {
    throw new Error("Invalid Sentinel adaptive task ID");
  }
  return value;
}

function uniqueValues(
  value: readonly string[] | undefined,
  field: string,
  max: number,
  validate: (item: unknown) => string,
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) {
    throw new Error(`Invalid Sentinel adaptive ${field} list`);
  }
  return [...new Set(value.map(validate))].sort();
}

const MAX_PEER_FINDING_CITATIONS = 4;
const MAX_PEER_VERIFICATION_BATCH = 128;

function peerFindingKey(citation: AdaptivePeerFindingCitation) {
  return JSON.stringify([
    citation.localAssetId,
    citation.sourceCaseId,
    citation.sourceAssetId,
    citation.sourceFindingId,
    citation.snapshotDigest,
  ]);
}

function normalizePeerFindingCitation(citation: AdaptivePeerFindingCitation) {
  if (
    !citation || typeof citation.sourceCaseId !== "string" ||
    !isSentinelCaseId(citation.sourceCaseId) ||
    typeof citation.snapshotDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(citation.snapshotDigest)
  ) throw new Error("Invalid Sentinel peer finding citation source");
  return {
    localAssetId: boundedText(citation.localAssetId, "local asset ID", 4096),
    sourceCaseId: citation.sourceCaseId,
    sourceAssetId: boundedText(
      citation.sourceAssetId,
      "source asset ID",
      4096,
    ),
    sourceFindingId: boundedText(
      citation.sourceFindingId,
      "source finding ID",
      4096,
    ),
    snapshotDigest: citation.snapshotDigest,
  };
}

function normalizePeerFindingCitations(
  values: readonly AdaptivePeerFindingCitation[],
) {
  if (
    !Array.isArray(values) || !values.length ||
    values.length > MAX_PEER_FINDING_CITATIONS
  ) throw new Error("Invalid Sentinel peer finding citations");
  const citations = Array.from(values, normalizePeerFindingCitation);
  if (new Set(citations.map(peerFindingKey)).size !== citations.length) {
    throw new Error("Duplicate Sentinel peer finding citation");
  }
  return citations;
}

function assignedTargetCitationKey(
  citation: AdaptivePriorAssignedTargetCitation,
) {
  return JSON.stringify([
    citation.sourceTaskId,
    citation.evidenceRevision,
    citation.targetId,
    citation.stepIndex,
  ]);
}

function normalizeAssignedTargetCitations(
  citations: readonly AdaptivePriorAssignedTargetCitation[],
) {
  return manifestList(citations, 4, (citation) => {
    if (
      !citation || !Number.isSafeInteger(citation.evidenceRevision) ||
      citation.evidenceRevision < 1 ||
      !Number.isSafeInteger(citation.stepIndex) ||
      citation.stepIndex < 0 || citation.stepIndex >= 16
    ) throw new Error("Invalid Sentinel prior assigned target citation");
    taskId(citation.sourceTaskId);
    boundedText(citation.targetId, "prior assigned target evidence ID", 4096);
    return assignedTargetCitationKey(citation);
  }).map(({ sourceTaskId, evidenceRevision, targetId, stepIndex }) => ({
    sourceTaskId,
    evidenceRevision,
    targetId,
    stepIndex,
  }));
}

function carriedAssignedTargetKey(
  entry: AdaptiveCarriedAssignedTargetCitation,
) {
  return JSON.stringify([
    entry.carrierTaskId,
    assignedTargetCitationKey(entry.citation),
  ]);
}

function normalizeCarriedAssignedTargets(
  entries: readonly AdaptiveCarriedAssignedTargetCitation[],
) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 4) {
    throw new Error("Invalid Sentinel carried assigned target citations");
  }
  const normalized = Array.from(entries, (entry) => ({
    carrierTaskId: taskId(entry?.carrierTaskId),
    citation: normalizeAssignedTargetCitations([entry?.citation])[0],
  }));
  return manifestList(normalized, 4, carriedAssignedTargetKey);
}

function normalizePlannerRound(round: AdaptivePlannerRound | undefined) {
  if (!round) return undefined;
  const {
    identity,
    attempt,
    hintId,
    sourceKind,
    upstreamCheckId,
    upstreamCitations,
    workerSources,
    graphFactId,
    graphFactOnly,
    graphRelationship,
    githubWorkflowCitation,
    peerFindingCitations,
    priorAssignedTargetCitations,
    carriedAssignedTargetCitations,
  } = round;
  const requiredRelationship = graphRelationship && (
    parseSentinelGraphFactRelationship(
      graphRelationship,
      graphRelationship.from,
    )
  );
  if (
    graphRelationship &&
    (!requiredRelationship || graphFactOnly !== true || graphFactId)
  ) {
    throw new Error("Invalid Sentinel relationship requirement");
  }
  if (
    !Number.isSafeInteger(attempt) || attempt < 1 ||
    (upstreamCheckId !== undefined &&
      (typeof upstreamCheckId !== "string" ||
        !/^[a-z_]{1,80}$/.test(upstreamCheckId))) ||
    (sourceKind !== undefined && sourceKind !== "worker_result" &&
      sourceKind !== "model_review") ||
    (hintId !== undefined && (!Number.isSafeInteger(hintId) || hintId < 1))
  ) {
    throw new Error("Invalid Sentinel assignment planner round");
  }
  if (
    graphFactId !== undefined &&
    !/^worker-graph-fact:[a-f0-9]{64}$/.test(graphFactId)
  ) {
    throw new Error("Invalid Sentinel graph fact citation");
  }
  if (
    githubWorkflowCitation &&
    !/^[a-f0-9]{64}$/.test(githubWorkflowCitation.resultSha256)
  ) {
    throw new Error("Invalid Sentinel workflow result citation");
  }
  if (
    upstreamCitations !== undefined &&
    (!Array.isArray(upstreamCitations) || !upstreamCitations.length ||
      upstreamCitations.length > 12 ||
      upstreamCitations.some((citation) =>
        !citation || typeof citation.alertId !== "string" ||
        !/^case-alert:[a-f0-9]{64}$/.test(citation.alertId) ||
        typeof citation.checkId !== "string" ||
        !/^[a-z_]{1,80}$/.test(citation.checkId)
      ))
  ) throw new Error("Invalid Sentinel upstream citations");
  if (
    workerSources !== undefined && (
      !Array.isArray(workerSources) ||
      !workerSources.length ||
      workerSources.length > 4 || workerSources.some((source) =>
        !source ||
        (source.kind !== "worker_result" && source.kind !== "model_review") ||
        taskId(source.taskId) !== source.taskId
      ) || new Set(workerSources.map(({ taskId }) =>
          taskId
        )).size !== workerSources.length
    )
  ) throw new Error("Invalid Sentinel worker sources");
  return {
    identity: revisionKey(identity),
    ...(graphFactId && { graphFactId }),
    ...(graphFactOnly === true && (graphFactId || requiredRelationship) &&
      { graphFactOnly }),
    ...(requiredRelationship && { graphRelationship: requiredRelationship }),
    ...(githubWorkflowCitation && {
      githubWorkflowCitation: {
        sourceTaskId: taskId(githubWorkflowCitation.sourceTaskId),
        resultSha256: githubWorkflowCitation.resultSha256,
      },
    }),
    attempt,
    ...(hintId !== undefined && { hintId }),
    ...(sourceKind !== undefined && { sourceKind }),
    ...(workerSources && { workerSources }),
    ...(upstreamCheckId !== undefined && { upstreamCheckId }),
    ...(upstreamCitations && { upstreamCitations }),
    ...(peerFindingCitations !== undefined && {
      peerFindingCitations: normalizePeerFindingCitations(peerFindingCitations),
    }),
    ...(priorAssignedTargetCitations !== undefined && {
      priorAssignedTargetCitations: normalizeAssignedTargetCitations(
        priorAssignedTargetCitations,
      ),
    }),
    ...(carriedAssignedTargetCitations !== undefined && {
      carriedAssignedTargetCitations: normalizeCarriedAssignedTargets(
        carriedAssignedTargetCitations,
      ),
    }),
  };
}

function normalizeTask(revision: string, request: AdaptiveTaskRequest) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Expected a Sentinel adaptive task proposal");
  }
  const identity = normalizeIdentity(request);
  const plannerRound = normalizePlannerRound(request.plannerRound);
  const carriedAssignedTargetCitations =
    request.carriedAssignedTargetCitations === undefined
      ? undefined
      : normalizeCarriedAssignedTargets(request.carriedAssignedTargetCitations);
  if (
    carriedAssignedTargetCitations && (
      !plannerRound || request.carriedFrom ||
      carriedAssignedTargetCitations.some(({ citation }) =>
        citation.targetId !== identity.nodeId
      )
    )
  ) {
    throw new Error(
      "Carried assigned target citations require their exact planner assignment",
    );
  }
  const revalidatedAssignedTargetCitations =
    request.revalidatedAssignedTargetCitations === undefined
      ? undefined
      : normalizeAssignedTargetCitations(
        request.revalidatedAssignedTargetCitations,
      );
  if (
    revalidatedAssignedTargetCitations && (
      !revalidatedAssignedTargetCitations.length || !request.carriedFrom ||
      !plannerRound || revalidatedAssignedTargetCitations.some(({ targetId }) =>
        targetId !== identity.nodeId
      )
    )
  ) {
    throw new Error(
      "Revalidated assigned target citations require an exact Sentinel carryover task",
    );
  }
  const revalidatedPeerFindingCitations =
    request.revalidatedPeerFindingCitations === undefined
      ? undefined
      : normalizePeerFindingCitations(request.revalidatedPeerFindingCitations);
  if (
    revalidatedPeerFindingCitations && (!request.carriedFrom || !plannerRound)
  ) {
    throw new Error(
      "Revalidated peer finding citations require a Sentinel carryover planner round",
    );
  }
  const peerFindings = revalidatedPeerFindingCitations ??
    plannerRound?.peerFindingCitations;
  if (
    peerFindings &&
    ((identity.kind !== "impact" && identity.kind !== "trace") ||
      peerFindings.some(({ localAssetId }) => localAssetId !== identity.nodeId))
  ) {
    throw new Error(
      "Sentinel peer finding citation requires its exact asset task",
    );
  }
  return {
    ...identity,
    id: sentinelAdaptiveTaskId(revision, request),
    reason: optionalText(request.reason, "reason", 1000),
    plannerRound: plannerRound && ({
      ...plannerRound,
      ...(request.carriedFrom && { peerFindingCitations: undefined }),
      priorAssignedTargetCitations: undefined,
      carriedAssignedTargetCitations: undefined,
    } satisfies AdaptivePlannerRound) as AdaptivePlannerRound,
    revalidatedPeerFindingCitations,
    revalidatedAssignedTargetCitations,
    carriedAssignedTargetCitations,
    carriedFrom: request.carriedFrom === undefined
      ? undefined
      : taskId(request.carriedFrom),
    reviewedFrom: request.reviewedFrom === undefined
      ? undefined
      : taskId(request.reviewedFrom),
    reopened: request.reopened === true,
    reuseObservation: request.reuseObservation === true,
    removedEvidenceIds: uniqueValues(
      request.removedEvidenceIds,
      "removed evidence",
      12,
      (id) => boundedText(id, "removed evidence ID", 4096),
    ),
    prerequisites: uniqueValues(
      request.prerequisites,
      "prerequisite",
      32,
      taskId,
    ),
    evidenceIds: uniqueValues(
      request.evidenceIds,
      "evidence ID",
      64,
      (id) => boundedText(id, "evidence ID", 4096),
    ),
  };
}

function openPrivateDatabase(path: string, readOnly = false): DatabaseSync {
  const resolved = resolve(path);
  if (!readOnly) {
    try {
      Deno.openSync(resolved, { write: true, createNew: true, mode: 0o600 })
        .close();
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
  }
  const info = Deno.lstatSync(resolved);
  if (
    !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
    (info.mode !== null && (info.mode & 0o077) !== 0)
  ) {
    throw new Error(
      "Adaptive database must be a regular file accessible only to its owner",
    );
  }
  return new DatabaseSync(resolved, { readOnly });
}

export function readAdaptiveSourceSnapshotReferences(path: string) {
  let db: DatabaseSync;
  try {
    db = openPrivateDatabase(path, true);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  try {
    const tables = db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
    );
    const available = [
      { table: "adaptive_note_steps", column: "steps" },
      { table: "adaptive_model_reads", column: "plannerReads" },
      { table: "adaptive_worker_progress", column: "steps" },
    ].filter(({ table }) => tables.get(table));
    const selects = available.map(({ table, column }) => `
      SELECT DISTINCT json_extract(source.value, '$.caseId') AS caseId,
        json_extract(source.value, '$.snapshotDigest') AS digest
      FROM ${table} AS trace,
        json_each(trace.${column}) AS step,
        json_each(step.value, '$.sourceSnapshots') AS source
      WHERE json_type(source.value, '$.snapshotDigest') = 'text'
    `);
    if (
      db.prepare(
        "SELECT 1 FROM pragma_table_info('adaptive_tasks') WHERE name = 'plannerRound'",
      ).get()
    ) {
      selects.push(`
        SELECT DISTINCT json_extract(citation.value, '$.sourceCaseId') AS caseId,
          json_extract(citation.value, '$.snapshotDigest') AS digest
        FROM adaptive_tasks AS task,
          json_each(task.plannerRound, '$.peerFindingCitations') AS citation
        WHERE json_type(citation.value, '$.snapshotDigest') = 'text'
      `);
    }
    return selects.length ? db.prepare(selects.join(" UNION ")).all() : [];
  } finally {
    db.close();
  }
}

/** Find committed model reviews that consulted an exact shared asset snapshot. */
export function readAdaptiveAssetSnapshotCitations(
  path: string,
  source: { caseId: string; digest: string; asset: string },
  limit: number,
  offset = 0,
) {
  let db: DatabaseSync;
  try {
    db = openPrivateDatabase(path, true);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  try {
    const tables = db.prepare(`SELECT count(*) AS count FROM sqlite_schema
      WHERE type = 'table' AND name IN ('adaptive_note_steps', 'adaptive_evidence_revisions')`)
      .get();
    if (tables?.count !== 2) return [];
    return db.prepare(`
      SELECT DISTINCT mapping.evidenceNumber AS revision, review.taskId
      FROM adaptive_model_reviews review
      JOIN adaptive_note_steps trace ON trace.note_id = review.noteId
      JOIN adaptive_tasks task ON task.id = review.taskId
      JOIN adaptive_evidence_revisions mapping ON mapping.revision = task.revision,
        json_each(trace.steps) AS step,
        json_each(step.value, '$.sourceSnapshots') AS citation
      WHERE task.status = 'completed'
        AND mapping.rowid = (
          SELECT MAX(rowid) FROM adaptive_evidence_revisions
          WHERE evidenceNumber = mapping.evidenceNumber
        )
        AND json_extract(step.value, '$.outcome') = 'returned'
        AND json_extract(citation.value, '$.caseId') = ?
        AND json_extract(citation.value, '$.snapshotDigest') = ?
        AND json_extract(citation.value, '$.assetId') = ?
      ORDER BY revision DESC, review.taskId
      LIMIT ? OFFSET ?
    `).all(source.caseId, source.digest, source.asset, limit, offset).map((
      row,
    ) => ({
      revision: Number(row.revision),
      focusId: `observation:adaptive:review:${row.taskId}`,
    }));
  } finally {
    db.close();
  }
}

/** Read committed results from the exact archived evidence revision without opening a writer. */
export function querySentinelWorkerObservations(
  path: string,
  revision: number,
  request:
    | { readonly task: string }
    | { readonly query: string; readonly offset: number },
) {
  let db: DatabaseSync;
  try {
    db = openPrivateDatabase(path, true);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  try {
    db.exec("PRAGMA busy_timeout = 250");
    if (
      db.prepare("PRAGMA application_id").get()?.application_id !==
        APPLICATION_ID ||
      db.prepare("PRAGMA user_version").get()?.user_version !== VERSION ||
      !db.prepare(`SELECT 1 FROM sqlite_schema
        WHERE type = 'table' AND name = 'adaptive_evidence_revisions'`).get()
    ) return undefined;
    const lookup = `FROM adaptive_tasks WHERE status = 'completed'
      AND observation IS NOT NULL AND revision = (
        SELECT revision FROM adaptive_evidence_revisions WHERE evidenceNumber = ?
        ORDER BY rowid DESC LIMIT 1
      )`;
    if ("task" in request) {
      const row = db.prepare(
        `SELECT observation ${lookup} AND id = ?`,
      ).get(revision, taskId(request.task));
      return typeof row?.observation === "string" ? row.observation : undefined;
    }
    const rows = db.prepare(`SELECT id, kind, substr(nodeId, 1, 100) AS nodeId,
      substr(json_extract(observation, '$.summary'), 1, 96) AS summary
      ${lookup} AND (instr(lower(observation), lower(?)) > 0
        OR instr(lower(COALESCE(nodeId, '')), lower(?)) > 0)
      ORDER BY rowid DESC LIMIT 6 OFFSET ?`)
      .all(revision, request.query, request.query, request.offset);
    return {
      observations: rows.slice(0, 5),
      nextOffset: rows.length > 5 ? request.offset + 5 : null,
    };
  } finally {
    db.close();
  }
}

function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function initialize(db: DatabaseSync): void {
  db.exec(
    "PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF",
  );
  transaction(db, () => {
    const applicationId = db.prepare("PRAGMA application_id").get()
      ?.application_id;
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (applicationId === APPLICATION_ID && version === VERSION) {
      db.exec(
        "CREATE INDEX IF NOT EXISTS adaptive_events_by_task ON adaptive_events(revision, taskId)",
      );
      if (
        !db.prepare("PRAGMA table_info(adaptive_events)").all().some(
          ({ name }) => name === "removedEvidenceIds",
        )
      ) {
        db.exec(
          "ALTER TABLE adaptive_events ADD COLUMN removedEvidenceIds TEXT",
        );
      }
      if (
        !db.prepare("PRAGMA table_info(adaptive_tasks)").all().some(
          ({ name }) => name === "reviewedFrom",
        )
      ) {
        db.exec("ALTER TABLE adaptive_tasks ADD COLUMN reviewedFrom TEXT");
      }
      if (
        !db.prepare("PRAGMA table_info(adaptive_tasks)").all().some(
          ({ name }) => name === "plannerRound",
        )
      ) {
        db.exec("ALTER TABLE adaptive_tasks ADD COLUMN plannerRound TEXT");
      }
      if (
        !db.prepare("PRAGMA table_info(adaptive_tasks)").all().some(
          ({ name }) => name === "plannerPriority",
        )
      ) {
        db.exec(
          "ALTER TABLE adaptive_tasks ADD COLUMN plannerPriority INTEGER",
        );
      }
      if (
        !db.prepare("PRAGMA table_info(adaptive_tasks)").all().some(
          ({ name }) => name === "retirementReason",
        )
      ) {
        db.exec("ALTER TABLE adaptive_tasks ADD COLUMN retirementReason TEXT");
      }
      if (
        !db.prepare("PRAGMA table_info(adaptive_tasks)").all().some(
          ({ name }) => name === "dependencyRecommendation",
        )
      ) {
        db.exec(
          "ALTER TABLE adaptive_tasks ADD COLUMN dependencyRecommendation TEXT",
        );
      }
      if (
        !db.prepare("PRAGMA table_info(adaptive_tasks)").all().some(
          ({ name }) => name === "factSatisfaction",
        )
      ) db.exec("ALTER TABLE adaptive_tasks ADD COLUMN factSatisfaction TEXT");
      return;
    }
    if (
      applicationId !== 0 || version !== 0 ||
      db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
    ) {
      throw new Error("Invalid Sentinel adaptive database or version");
    }
    db.exec(`
      CREATE TABLE adaptive_revisions (
        revision TEXT PRIMARY KEY,
        openedAt INTEGER NOT NULL
      );
      CREATE TABLE adaptive_active (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision TEXT NOT NULL REFERENCES adaptive_revisions(revision)
      );
      CREATE TABLE adaptive_tasks (
        id TEXT PRIMARY KEY,
        revision TEXT NOT NULL REFERENCES adaptive_revisions(revision),
        kind TEXT NOT NULL,
        nodeId TEXT,
        depth INTEGER,
        reason TEXT,
        evidenceIds TEXT NOT NULL,
        prerequisites TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','superseded')),
        attempts INTEGER NOT NULL DEFAULT 0,
        leaseToken TEXT,
        leaseExpiresAt INTEGER,
        observation TEXT,
        reviewedFrom TEXT,
        plannerRound TEXT,
        plannerPriority INTEGER,
        retirementReason TEXT,
        dependencyRecommendation TEXT,
        factSatisfaction TEXT
      );
      CREATE INDEX adaptive_tasks_by_revision ON adaptive_tasks(revision, status);
      CREATE TABLE adaptive_dependencies (
        taskId TEXT NOT NULL REFERENCES adaptive_tasks(id),
        dependencyId TEXT NOT NULL REFERENCES adaptive_tasks(id),
        PRIMARY KEY(taskId, dependencyId)
      );
      CREATE TABLE adaptive_events (
        revision TEXT NOT NULL REFERENCES adaptive_revisions(revision),
        taskId TEXT NOT NULL REFERENCES adaptive_tasks(id),
        event TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        at INTEGER NOT NULL,
        note TEXT,
        removedEvidenceIds TEXT
      );
      CREATE INDEX adaptive_events_by_revision ON adaptive_events(revision);
      CREATE INDEX adaptive_events_by_task ON adaptive_events(revision, taskId);
      CREATE TABLE adaptive_notes (
        revision TEXT NOT NULL REFERENCES adaptive_revisions(revision),
        taskId TEXT REFERENCES adaptive_tasks(id),
        note TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX adaptive_notes_by_revision ON adaptive_notes(revision);
      PRAGMA application_id = ${APPLICATION_ID};
      PRAGMA user_version = ${VERSION};
    `);
  });
}

function decodeTask(row: Row): AdaptiveTask {
  const { id, revision, kind, nodeId, depth, reason, observation } = row;
  return {
    id: String(id),
    revision: String(revision),
    kind: kind as AdaptiveTaskKind,
    ...(typeof nodeId === "string" && { nodeId }),
    ...(depth !== null && { depth: Number(depth) }),
    ...(typeof reason === "string" && { reason }),
    ...(typeof row.plannerRound === "string" && {
      plannerRound: normalizePlannerRound(JSON.parse(row.plannerRound)),
    }),
    ...(typeof row.factSatisfaction === "string" && {
      factSatisfaction: JSON.parse(
        row.factSatisfaction,
      ) as AdaptiveFactSatisfaction,
    }),
    status: row.cancelled ? "cancelled" : row.status as AdaptiveTaskStatus,
    attempts: Number(row.attempts),
    ...(row.prioritized && { prioritized: true }),
    ...(row.status === "queued" && typeof row.plannerPriority === "number" && {
      plannerPriority: row.plannerPriority,
    }),
    ...(typeof row.reviewedFrom === "string" &&
      { reviewedFrom: row.reviewedFrom }),
    ...(row.status === "queued" && typeof row.retirementReason === "string" && {
      retirementReason: row.retirementReason,
    }),
    ...(row.status === "queued" &&
      typeof row.dependencyRecommendation === "string" && {
      dependencyRecommendation: JSON.parse(row.dependencyRecommendation),
    }),
    evidenceIds: JSON.parse(String(row.evidenceIds)),
    prerequisites: JSON.parse(String(row.prerequisites)),
    ...(typeof observation === "string" &&
      { observation: JSON.parse(observation) }),
    ...(row.leaseExpiresAt !== null && {
      leaseExpiresAt: new Date(Number(row.leaseExpiresAt)).toISOString(),
    }),
  };
}

function observationJson(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Sentinel adaptive observation must be a JSON object");
  }
  const encoded = JSON.stringify(value);
  const bytes = encoded?.length <= MAX_OBSERVATION_BYTES
    ? new TextEncoder().encode(encoded).length
    : Infinity;
  if (!encoded?.startsWith("{") || bytes > MAX_OBSERVATION_BYTES) {
    throw new Error("Invalid or oversized Sentinel adaptive observation");
  }
  return { encoded, bytes };
}

function reportLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
    throw new Error("Sentinel adaptive report limit must be 1–1000");
  }
  return value;
}

export interface AdaptiveIncidentImpactSource {
  readonly targetId: string;
  readonly sourceId: string;
}

export interface AdaptiveVerificationReviewSource {
  readonly targetId: string;
  readonly sourceId: string;
  readonly evidenceId: string;
}

export interface AdaptiveVerificationReviewCandidate
  extends AdaptiveVerificationReviewSource {
  readonly sourceObservationDigest: string;
}

export interface AdaptiveEvidenceRevision {
  readonly number: number;
  readonly unavailableAssignments?: readonly string[];
  readonly goal: { readonly id: string; readonly label: string };
}

/** Trusted operator assignment input already validated against the current graph. */
export interface AdaptiveOperatorAssignmentIntentInput {
  readonly requestId: string;
  readonly runId: string;
  readonly evidenceRevision: number;
  readonly adaptiveRevision: string;
  readonly task: AdaptiveTaskRequest;
  readonly reason: string;
  readonly takeOverQueued?: boolean;
}

export interface AdaptiveOperatorAssignmentIntentReceipt {
  readonly requestId: string;
  readonly runId: string;
  readonly evidenceRevision: number;
  readonly adaptiveRevision: string;
  readonly taskId: string;
  readonly kind: AdaptiveTaskKind;
  readonly nodeId?: string;
  readonly depth?: number;
  readonly graphRelationship?: SentinelWorkerGraphRelationship;
  readonly disposition: "enqueued" | "adopted" | "existing";
  readonly recordedAt: string;
}

function operatorAssignmentRequestId(value: unknown): string | undefined {
  return typeof value === "string" &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

/** A staged queue plan must be rebuilt from the newly committed task state. */
export class SentinelAdaptiveQueueChanged extends Error {
  constructor() {
    super("Sentinel adaptive queue changed during evidence rollover");
  }
}

interface LeaseRequest {
  readonly taskId: string;
  readonly leaseToken: string;
}

/** Open a local task store. Each public mutation is one SQLite transaction. */
export function openSentinelAdaptiveStore(path: string, now = Date.now) {
  const db = openPrivateDatabase(path);
  try {
    initialize(db);
    db.exec(`CREATE TABLE IF NOT EXISTS adaptive_model_reviews (
      taskId TEXT PRIMARY KEY REFERENCES adaptive_tasks(id),
      attempts INTEGER NOT NULL,
      token TEXT,
      availableAt INTEGER NOT NULL,
      noteId INTEGER,
      operatorRetry INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS adaptive_worker_controls (
      id INTEGER PRIMARY KEY,
      requestId TEXT NOT NULL UNIQUE,
      revision TEXT NOT NULL,
      taskId TEXT NOT NULL REFERENCES adaptive_tasks(id),
      action TEXT NOT NULL CHECK (action IN ('steer', 'stop')),
      note TEXT,
      requestedAt INTEGER NOT NULL,
      appliedAt INTEGER
    );
    CREATE INDEX IF NOT EXISTS adaptive_worker_controls_by_task
      ON adaptive_worker_controls(revision, taskId, action, id);
    CREATE TABLE IF NOT EXISTS adaptive_worker_progress (
      taskId TEXT PRIMARY KEY REFERENCES adaptive_tasks(id),
      revision TEXT NOT NULL,
      steps TEXT NOT NULL
    );`);
    const hasReviewColumn = (column: string) =>
      db.prepare("PRAGMA table_info(adaptive_model_reviews)").all()
        .some(({ name }) => name === column);
    for (
      const [column, definition] of [
        ["noteId", "noteId INTEGER"],
        ["operatorRetry", "operatorRetry INTEGER NOT NULL DEFAULT 0"],
      ]
    ) {
      if (!hasReviewColumn(column)) {
        transaction(db, () => {
          if (!hasReviewColumn(column)) {
            db.exec(
              `ALTER TABLE adaptive_model_reviews ADD COLUMN ${definition}`,
            );
          }
        });
      }
    }
    db.exec(`CREATE TABLE IF NOT EXISTS adaptive_model_usage (
      evidenceRevision INTEGER PRIMARY KEY,
      calls INTEGER NOT NULL,
      inputTokens INTEGER NOT NULL,
      outputTokens INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS adaptive_worker_settings (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      workerLimit INTEGER NOT NULL CHECK (workerLimit > 0)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS adaptive_model_language (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      language TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS adaptive_case_hints (
      id INTEGER PRIMARY KEY,
      evidenceRevision INTEGER NOT NULL,
      at INTEGER NOT NULL,
      text TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS adaptive_operator_case_hint_requests (
      requestId TEXT PRIMARY KEY,
      operatorScope TEXT NOT NULL,
      runId TEXT NOT NULL,
      hintId INTEGER NOT NULL REFERENCES adaptive_case_hints(id)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS adaptive_verification_sources (
      revision TEXT NOT NULL REFERENCES adaptive_revisions(revision),
      targetId TEXT NOT NULL REFERENCES adaptive_tasks(id),
      sourceId TEXT NOT NULL REFERENCES adaptive_tasks(id),
      evidenceId TEXT NOT NULL,
      PRIMARY KEY (revision, targetId, sourceId)
    )`);
  } catch (error) {
    db.close();
    throw error;
  }

  const lookup = db.prepare("SELECT * FROM adaptive_tasks WHERE id = ?");
  const getActive = db.prepare(
    "SELECT revision FROM adaptive_active WHERE singleton = 1",
  );
  const priorityOrder = `COALESCE((
    SELECT CASE WHEN activity.event = 'prioritized' THEN activity.rowid ELSE 0 END
    FROM adaptive_events AS activity
    WHERE activity.revision = task.revision AND activity.taskId = task.id
      AND activity.event IN ('prioritized', 'priority_withdrawn', 'claimed')
    ORDER BY activity.rowid DESC LIMIT 1
  ), 0)`;
  const getRevisionTasks = db.prepare(
    `SELECT task.*, EXISTS (
      SELECT 1 FROM adaptive_events AS activity
      WHERE activity.revision = task.revision AND activity.taskId = task.id
        AND activity.event = 'cancelled'
    ) AS cancelled, (task.status = 'queued' AND ${priorityOrder} > 0) AS prioritized
    FROM adaptive_tasks AS task WHERE task.revision = ? ORDER BY task.rowid`,
  );
  const event = db.prepare(
    "INSERT INTO adaptive_events (revision, taskId, event, attempt, at, note) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const updateStatus = db.prepare(
    "UPDATE adaptive_tasks SET status = ?, leaseToken = NULL, leaseExpiresAt = NULL WHERE id = ?",
  );
  const revisions = db.prepare(
    "SELECT 1 FROM adaptive_revisions WHERE revision = ?",
  );

  const activeRevision = (): string | null => {
    const active = getActive.get()?.revision;
    return typeof active === "string" ? active : null;
  };
  function appendCaseHint(
    hint: string,
    evidenceRevision: number,
    time: number,
  ) {
    const result = db.prepare(
      "INSERT INTO adaptive_case_hints (evidenceRevision, at, text) VALUES (?, ?, ?)",
    ).run(evidenceRevision, time, hint);
    const revision = activeRevision();
    if (revision) {
      const affected = db.prepare(`SELECT id, attempts FROM adaptive_tasks
        WHERE revision = ? AND status = 'queued' AND dependencyRecommendation IS NOT NULL`)
        .all(revision);
      db.prepare(`UPDATE adaptive_tasks SET dependencyRecommendation = NULL
        WHERE revision = ? AND status = 'queued' AND dependencyRecommendation IS NOT NULL`)
        .run(revision);
      for (const task of affected) {
        event.run(
          revision,
          task.id,
          "plan_proposal_superseded",
          task.attempts,
          time,
          `Case hint #${result.lastInsertRowid} superseded the pending plan proposal.`,
        );
      }
    }
    return result;
  }
  const taskQueueWatermark = () =>
    Number(
      db.prepare(
        "SELECT COALESCE(MAX(rowid), 0) AS cursor FROM adaptive_events",
      ).get()?.cursor,
    );

  function setActive(revision: string, time: number) {
    const previous = activeRevision();
    if (previous === revision) return;
    if (hasWorkerCheckpointTable()) {
      db.prepare("DELETE FROM adaptive_worker_checkpoints WHERE revision <> ?")
        .run(revision);
    }
    if (hasGitHubWorkflowResultTable()) {
      db.prepare(
        "DELETE FROM adaptive_live_workflow_results WHERE revision <> ?",
      )
        .run(revision);
    }
    for (
      const row of db.prepare(
        "SELECT * FROM adaptive_tasks WHERE status IN ('queued','running') AND revision = ?",
      ).all(previous)
    ) {
      updateStatus.run("superseded", row.id);
      event.run(previous, row.id, "superseded", row.attempts, time, null);
    }
    db.prepare("INSERT OR IGNORE INTO adaptive_revisions VALUES (?, ?)").run(
      revision,
      time,
    );
    db.prepare(
      `INSERT INTO adaptive_active VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision`,
    ).run(revision);
    for (
      const row of db.prepare(
        `SELECT * FROM adaptive_tasks AS task
         WHERE status = 'superseded' AND revision = ?
           AND NOT EXISTS (
             SELECT 1 FROM adaptive_events AS activity
             WHERE activity.revision = task.revision AND activity.taskId = task.id
               AND activity.event = 'cancelled'
           )`,
      ).all(revision)
    ) {
      const recoverable = Number(row.attempts) < MAX_ADAPTIVE_TASK_ATTEMPTS;
      updateStatus.run(recoverable ? "queued" : "failed", row.id);
      event.run(
        revision,
        row.id,
        recoverable ? "requeued" : "failed",
        row.attempts,
        time,
        null,
      );
    }
  }

  function enqueue(
    revision: string,
    task: ReturnType<typeof normalizeTask>,
    time: number,
    destinationEvidence?: AdaptiveEvidenceRevision,
  ) {
    const carriedFrom = task.carriedFrom;
    const prior = carriedFrom ? lookup.get(carriedFrom) : undefined;
    if (carriedFrom) {
      if (
        typeof prior?.revision !== "string" || prior.revision === revision ||
        sentinelAdaptiveTaskId(prior.revision, task) !== task.carriedFrom
      ) {
        throw new Error(
          "Sentinel carryover must reference the same investigation in a prior plan.",
        );
      }
      if (task.revalidatedPeerFindingCitations && task.plannerRound) {
        const priorKeys = new Set(
          (decodeTask(prior).plannerRound?.peerFindingCitations ?? []).map(
            peerFindingKey,
          ),
        );
        if (
          !task.revalidatedPeerFindingCitations.every((citation) =>
            priorKeys.has(peerFindingKey(citation))
          )
        ) {
          throw new Error(
            "Sentinel revalidated peer finding must match an exact prior citation",
          );
        }
        task = {
          ...task,
          plannerRound: {
            ...task.plannerRound,
            peerFindingCitations: task.revalidatedPeerFindingCitations,
          },
        };
      }
      if (task.revalidatedAssignedTargetCitations && task.plannerRound) {
        const candidateKeys = new Set(
          destinationEvidence
            ? priorAssignedTargetCitationCandidates(
              carriedFrom,
              destinationEvidence.number,
              destinationEvidence.goal,
            ).map(({ citation }) => assignedTargetCitationKey(citation))
            : [],
        );
        if (
          !task.revalidatedAssignedTargetCitations.every((citation) =>
            candidateKeys.has(assignedTargetCitationKey(citation))
          )
        ) {
          throw new Error(
            "Sentinel historical assigned target citation has no exact prior saved receipt",
          );
        }
        task = {
          ...task,
          plannerRound: {
            ...task.plannerRound,
            priorAssignedTargetCitations:
              task.revalidatedAssignedTargetCitations,
          },
        };
      }
    }
    const existing = lookup.get(task.id);
    const dependencies = JSON.stringify(task.prerequisites);
    if (existing) {
      if (existing.prerequisites !== dependencies) {
        throw new Error(
          "Cannot change prerequisites on an existing Sentinel adaptive task",
        );
      }
      return;
    }
    if (task.carriedAssignedTargetCitations && task.plannerRound) {
      if (
        !validCarriedAssignedTargets(task, revision, (id) => {
          const row = lookup.get(id);
          return row ? decodeTask(row) : undefined;
        })
      ) {
        throw new Error(
          "Sentinel carried assigned target requires an exact completed carrier prerequisite",
        );
      }
      task = {
        ...task,
        plannerRound: {
          ...task.plannerRound,
          carriedAssignedTargetCitations: task.carriedAssignedTargetCitations,
          priorAssignedTargetCitations: uniqueAssignedTargetCitations(
            [],
            task.carriedAssignedTargetCitations,
          ),
        },
      };
    }
    for (const prerequisite of task.prerequisites) {
      if (lookup.get(prerequisite)?.revision !== revision) {
        throw new Error(
          "Sentinel adaptive prerequisites must be existing tasks in the same evidence revision",
        );
      }
    }
    if (
      task.reviewedFrom &&
      (!task.prerequisites.includes(task.reviewedFrom) ||
        lookup.get(task.reviewedFrom)?.status !== "completed")
    ) {
      throw new Error(
        "Sentinel review follow-up requires its completed source task",
      );
    }
    if (
      task.plannerRound?.sourceKind === "model_review" &&
      (!task.reviewedFrom || !hasCitedModelReview(task.reviewedFrom))
    ) {
      throw new Error(
        "Sentinel planner citation requires a saved model review",
      );
    }
    // Carryover candidates are persisted only when the current prerequisite
    // actually reused the same committed bytes. A queued or rerun source
    // remains a dependency and can be cited by a later planning round.
    if (prior && task.plannerRound?.workerSources) {
      const reused = db.prepare(`SELECT 1 FROM adaptive_events
        WHERE revision = ? AND taskId = ? AND event = 'result_reused'`);
      const original = new Map(
        taskWorkerSources(decodeTask(prior)).flatMap(({ taskId, kind }) => {
          const oldSource = lookup.get(taskId);
          return kind === "worker_result" &&
              oldSource?.revision === prior.revision &&
              oldSource.status === "completed" &&
              typeof oldSource.observation === "string"
            ? [
              [
                sentinelAdaptiveTaskId(revision, decodeTask(oldSource)),
                oldSource.observation,
              ] as const,
            ]
            : [];
        }),
      );
      const workerSources = task.plannerRound.workerSources.filter(
        ({ taskId, kind }) => {
          const source = lookup.get(taskId);
          return kind === "worker_result" &&
            typeof source?.observation === "string" &&
            source.observation === original.get(taskId) &&
            !!reused.get(revision, taskId);
        },
      );
      task = {
        ...task,
        plannerRound: {
          ...task.plannerRound,
          workerSources: workerSources.length ? workerSources : undefined,
        },
      };
    }
    if (
      !validWorkerSources(task, (id) => lookup.get(id)?.status === "completed")
    ) {
      throw new Error("Sentinel assignment requires completed cited sources");
    }
    let reusedObservation: string | null = null;
    if (
      task.reuseObservation && !task.reopened &&
      prior?.status === "completed" &&
      typeof prior.observation === "string" &&
      task.prerequisites.every((id) => lookup.get(id)?.status === "completed")
    ) {
      const budget = db.prepare(`
        SELECT COALESCE(SUM(length(CAST(observation AS BLOB))), 0) AS bytes
        FROM adaptive_tasks WHERE revision = ?
      `).get(revision);
      const bytes = new TextEncoder().encode(prior.observation).length;
      if (Number(budget?.bytes) + bytes <= MAX_REVISION_OBSERVATION_BYTES) {
        reusedObservation = prior.observation;
      }
    }
    db.prepare(`
      INSERT INTO adaptive_tasks
        (id, revision, kind, nodeId, depth, reason, evidenceIds, prerequisites, status, observation, reviewedFrom, plannerRound)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      revision,
      task.kind,
      task.nodeId ?? null,
      task.depth ?? null,
      task.reason ?? null,
      JSON.stringify(task.evidenceIds),
      dependencies,
      reusedObservation === null ? "queued" : "completed",
      reusedObservation,
      task.reviewedFrom ?? null,
      task.plannerRound ? JSON.stringify(task.plannerRound) : null,
    );
    for (const prerequisite of task.prerequisites) {
      const dependency = lookup.get(prerequisite);
      if (dependency?.status === "queued" && dependency.retirementReason) {
        db.prepare(
          "UPDATE adaptive_tasks SET retirementReason = NULL WHERE id = ?",
        )
          .run(prerequisite);
        event.run(
          revision,
          prerequisite,
          "retirement_withdrawn",
          dependency.attempts,
          time,
          "A new investigation needs this prerequisite.",
        );
      }
      if (
        dependency?.status === "queued" && dependency.dependencyRecommendation
      ) {
        dismissDependencyGroup(
          revision,
          String(prerequisite),
          "A new investigation needs this prerequisite.",
        );
      }
      db.prepare("INSERT INTO adaptive_dependencies VALUES (?, ?)").run(
        task.id,
        prerequisite,
      );
    }
    if (reusedObservation === null) {
      event.run(revision, task.id, "queued", 0, time, task.reason ?? null);
    }
    if (task.carriedFrom) {
      event.run(
        revision,
        task.id,
        reusedObservation !== null
          ? "result_reused"
          : task.reopened
          ? "reopened"
          : "carried_forward",
        0,
        time,
        reusedObservation !== null
          ? `Reused the verified result of completed task ${task.carriedFrom}.`
          : task.reopened
          ? `Updated evidence prompted a review of completed task ${task.carriedFrom}.`
          : `Revalidated assignment from task ${task.carriedFrom}.`,
      );
      if (task.reopened && task.removedEvidenceIds.length) {
        db.prepare(
          "UPDATE adaptive_events SET removedEvidenceIds = ? WHERE rowid = last_insert_rowid()",
        )
          .run(
            JSON.stringify(task.removedEvidenceIds),
          );
      }
    }
    return true;
  }

  function recover(revision: string, time: number) {
    for (
      const row of db.prepare(
        "SELECT id, attempts FROM adaptive_tasks WHERE revision = ? AND status = 'running' AND leaseExpiresAt <= ?",
      ).all(revision, time)
    ) {
      updateStatus.run(
        Number(row.attempts) < MAX_ADAPTIVE_TASK_ATTEMPTS ? "queued" : "failed",
        row.id,
      );
      event.run(revision, row.id, "lease_expired", row.attempts, time, null);
    }
  }

  function nextClaimableTask(
    revision: string,
    excludedTaskIds: ReadonlySet<string>,
  ) {
    const ready = db.prepare(`
      SELECT task.* FROM adaptive_tasks AS task
      WHERE task.revision = ? AND task.status = 'queued'
      AND task.retirementReason IS NULL AND task.dependencyRecommendation IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM adaptive_dependencies AS dependency
        JOIN adaptive_tasks AS required ON required.id = dependency.dependencyId
        WHERE dependency.taskId = task.id
          AND (required.status != 'completed' OR required.revision != task.revision)
      ) ORDER BY ${priorityOrder} DESC, task.plannerPriority NULLS LAST, task.rowid
      ${excludedTaskIds.size ? "" : "LIMIT 1"}
    `);
    return excludedTaskIds.size
      ? ready.all(revision).find(({ id }) => !excludedTaskIds.has(String(id)))
      : ready.get(revision);
  }

  function assertLease(request: LeaseRequest, time: number): Row {
    const task = lookup.get(taskId(request.taskId));
    if (
      !task || task.revision !== activeRevision() ||
      task.status !== "running" ||
      task.leaseToken !== request.leaseToken ||
      Number(task.leaseExpiresAt) <= time
    ) {
      throw new Error("Sentinel adaptive task lease is unavailable or expired");
    }
    return task;
  }

  const pendingMutation = db.prepare(`
    SELECT rowid, event, note FROM adaptive_events
    WHERE revision = ? AND taskId = ?
      AND event IN ('model_mutation_pending', 'model_mutation_settled')
    ORDER BY rowid DESC LIMIT 1
  `);

  function mutationPending(revision: string, id: string): boolean {
    return pendingMutation.get(revision, id)?.event ===
      "model_mutation_pending";
  }

  const nextModelReview = db.prepare(`
    SELECT task.*, COALESCE(review.attempts, 0) AS reviewAttempts
    FROM adaptive_tasks AS task
    LEFT JOIN adaptive_model_reviews AS review ON review.taskId = task.id
    WHERE task.revision = ? AND (task.reason = ? OR task.kind = 'review_incident')
      AND task.status = 'completed' AND task.factSatisfaction IS NULL AND review.noteId IS NULL
      AND COALESCE(review.attempts, 0) < 2 + COALESCE(review.operatorRetry, 0)
      AND COALESCE(review.availableAt, 0) <= ?
      AND COALESCE((SELECT activity.event FROM adaptive_events AS activity
        WHERE activity.revision = task.revision AND activity.taskId = task.id
          AND activity.event IN ('model_mutation_pending', 'model_mutation_settled')
        ORDER BY activity.rowid DESC LIMIT 1), '') != 'model_mutation_pending'

      AND NOT EXISTS (SELECT 1 FROM adaptive_worker_controls AS control
        WHERE control.revision = task.revision AND control.taskId = task.id AND control.action = 'stop')
      AND NOT EXISTS (SELECT 1 FROM adaptive_events AS activity
        WHERE activity.revision = task.revision AND activity.taskId = task.id
          AND activity.event = 'model_review_completed')
    ORDER BY reviewAttempts, task.rowid
  `);

  const expireModelReviews = db.prepare(`
    UPDATE adaptive_model_reviews SET token = NULL
    WHERE token IS NOT NULL AND availableAt <= ?
      AND taskId IN (SELECT id FROM adaptive_tasks WHERE revision = ?)
    RETURNING taskId, attempts
  `);

  function recordExpiredModelReviews(revision: string, time: number): void {
    for (const row of expireModelReviews.all(time, revision)) {
      event.run(
        revision,
        row.taskId,
        "model_review_lease_expired",
        row.attempts,
        time,
        null,
      );
    }
  }

  function insertNote(
    revision: string,
    id: string | null,
    note: string,
    steps: readonly SentinelReviewStep[],
    time: number,
  ): AdaptiveTaskNote {
    db.prepare("INSERT INTO adaptive_notes VALUES (?, ?, ?, ?)").run(
      revision,
      id,
      note,
      time,
    );
    const retained = steps.slice(0, 16);
    if (retained.some((step) => step.githubWorkflowRead !== undefined)) {
      const evidenceRevision = recordedEvidenceNumber(revision);
      for (const [index, step] of retained.entries()) {
        retained[index] = normalizeSentinelWorkflowReviewStep(
          step,
          evidenceRevision,
        );
      }
    }
    if (retained.length) {
      db.exec(
        "CREATE TABLE IF NOT EXISTS adaptive_note_steps (note_id INTEGER PRIMARY KEY, steps TEXT NOT NULL)",
      );
      db.prepare(
        "INSERT INTO adaptive_note_steps VALUES (last_insert_rowid(), ?)",
      ).run(JSON.stringify(retained));
    }
    return {
      revision,
      taskId: id,
      note,
      at: new Date(time).toISOString(),
      ...(retained.length && { steps: retained }),
    };
  }

  function adoptQueuedAssignment(
    revision: string,
    id: string,
    reason: string,
    time: number,
  ): boolean {
    const task = lookup.get(id);
    if (
      activeRevision() !== revision || task?.revision !== revision ||
      task.status !== "queued"
    ) return false;
    if (task.reason === reason) return true;
    db.prepare("UPDATE adaptive_tasks SET reason = ? WHERE id = ?").run(
      reason,
      id,
    );
    insertNote(
      revision,
      id,
      "Operator explicitly assigned the queued review. Previous assignment reason: " +
        String(task.reason ?? "No reason recorded."),
      [],
      time,
    );
    event.run(revision, id, "operator_assigned", task.attempts, time, null);
    return true;
  }

  function readOperatorAssignmentIntent(requestId: string) {
    const canonical = operatorAssignmentRequestId(requestId);
    if (
      !canonical || !db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_operator_assignment_intents'",
      ).get()
    ) return undefined;
    const row = db.prepare(
      "SELECT receipt FROM adaptive_operator_assignment_intents WHERE requestId = ?",
    ).get(canonical);
    return typeof row?.receipt === "string"
      ? JSON.parse(row.receipt) as AdaptiveOperatorAssignmentIntentReceipt
      : undefined;
  }

  type DependencyChange = {
    id: string;
    prerequisites: readonly string[];
    reason: string;
  };

  function recordedEvidenceNumber(revision: string): number {
    if (
      !db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_evidence_revisions'",
      ).get()
    ) return NaN;
    return Number(
      db.prepare(`
      SELECT evidenceNumber FROM adaptive_evidence_revisions
      WHERE revision = ?
      ORDER BY evidenceNumber DESC, rowid DESC LIMIT 1
    `).get(revision)?.evidenceNumber,
    );
  }

  function hasGitHubWorkflowResultTable() {
    return !!db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_live_workflow_results'",
    ).get();
  }

  function hasWorkflowObservationTable() {
    return !!db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_workflow_observations'",
    ).get();
  }

  function decodeWorkflowObservation(row: Row): AdaptiveWorkflowObservation {
    const evidenceRevision = Number(row.evidenceRevision);
    const receipt = readSentinelGitHubWorkflowReadReceipt(
      JSON.parse(String(row.receipt)),
      evidenceRevision,
    );
    if (!receipt) {
      throw new Error("Invalid committed Sentinel workflow observation");
    }
    return {
      id: String(row.id),
      taskId: String(row.taskId),
      targetId: String(row.targetId),
      evidenceRevision,
      stepIndex: Number(row.stepIndex),
      receipt,
    };
  }

  function assignmentPublication(
    revision: string,
    id: string,
    evidenceRevision: number,
  ) {
    if (!hasWorkflowObservationTable()) return;
    const row = db.prepare(`
      SELECT * FROM adaptive_workflow_observations
      WHERE revision = ? AND taskId = ? AND evidenceRevision = ?
    `).get(revision, id, evidenceRevision);
    return row && decodeWorkflowObservation(row);
  }

  function validWorkflowObservationPage(offset: number, limit: number) {
    return Number.isSafeInteger(offset) && offset >= 0 &&
      offset <= MAX_ADAPTIVE_TASKS && Number.isSafeInteger(limit) &&
      limit > 0 && limit <= 30;
  }

  function hasWorkerCheckpointTable() {
    return !!db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_worker_checkpoints'",
    ).get();
  }

  function validWorkflowResultLease(
    revision: string,
    id: string,
    token: string,
    evidenceRevision: number,
  ) {
    if (
      activeRevision() !== revision ||
      recordedEvidenceNumber(revision) !== evidenceRevision ||
      !Number.isSafeInteger(evidenceRevision) || evidenceRevision < 1
    ) return false;
    const canonical = db.prepare(`
      SELECT revision FROM adaptive_evidence_revisions
      WHERE evidenceNumber = ? ORDER BY rowid DESC LIMIT 1
    `).get(evidenceRevision);
    return canonical?.revision === revision && !!db.prepare(`
      SELECT 1 FROM adaptive_tasks AS task
      JOIN adaptive_model_reviews AS review ON review.taskId = task.id
      WHERE task.revision = ? AND task.id = ? AND task.status = 'completed'
        AND review.token = ? AND review.availableAt > ? AND review.noteId IS NULL
        AND NOT EXISTS (SELECT 1 FROM adaptive_worker_controls AS control
          WHERE control.revision = task.revision AND control.taskId = task.id AND control.action = 'stop')
    `).get(revision, id, token, now());
  }

  function readWorkflowResult(
    revision: string,
    id: string,
    evidenceRevision: number,
  ) {
    const saved = db.prepare(`
      SELECT receipt FROM adaptive_live_workflow_results
      WHERE revision = ? AND taskId = ? AND evidenceRevision = ?
    `).get(revision, id, evidenceRevision);
    return typeof saved?.receipt === "string"
      ? readSentinelGitHubWorkflowReadReceipt(
        JSON.parse(saved.receipt),
        evidenceRevision,
      )
      : undefined;
  }

  function latestHintId() {
    const id = db.prepare("SELECT MAX(id) AS id FROM adaptive_case_hints").get()
      ?.id;
    return id == null ? null : Number(id);
  }

  function readTaskMap(revision: string) {
    return new Map(
      getRevisionTasks.all(revision).map(decodeTask).map((
        task,
      ) => [task.id, task]),
    );
  }

  function dismissDependencyGroup(
    revision: string,
    target: string,
    reason: string,
  ) {
    const tasks = readTaskMap(revision);
    const id = tasks.get(target)?.dependencyRecommendation?.id;
    if (!id) return;
    for (const task of tasks.values()) {
      if (task.dependencyRecommendation?.id !== id) continue;
      db.prepare(
        "UPDATE adaptive_tasks SET dependencyRecommendation = NULL WHERE id = ?",
      ).run(task.id);
      event.run(
        revision,
        task.id,
        "dependency_change_dismissed",
        task.attempts,
        now(),
        reason,
      );
    }
  }

  function hasCitedModelReview(assignment: string): boolean {
    return !!db.prepare(`SELECT 1 FROM adaptive_model_reviews review
      JOIN adaptive_notes note ON note.rowid = review.noteId
      WHERE review.taskId = ?`).get(assignment);
  }

  function priorAssignedTargetCitationFromSource(
    sourceTaskId: string,
    evidenceRevision: number,
    targetId: string,
    beforeEvidenceRevision: number,
    goal: AdaptiveEvidenceRevision["goal"],
    exactIndex?: number,
  ) {
    const row = lookup.get(taskId(sourceTaskId));
    if (
      !row || row.status !== "completed" || row.kind === "review_incident" ||
      typeof row.nodeId !== "string" ||
      !Number.isSafeInteger(evidenceRevision) || evidenceRevision < 1 ||
      evidenceRevision >= beforeEvidenceRevision
    ) return;
    const mapping = db.prepare(`
      SELECT revision, goalId, goalLabel FROM adaptive_evidence_revisions
      WHERE evidenceNumber = ? ORDER BY rowid DESC LIMIT 1
    `).get(evidenceRevision);
    if (
      mapping?.revision !== row.revision || mapping?.goalId !== goal.id ||
      mapping?.goalLabel !== goal.label
    ) return;
    const saved = db.prepare(`
      SELECT trace.steps FROM adaptive_model_reviews review
      JOIN adaptive_notes note ON note.rowid = review.noteId
        AND note.taskId = review.taskId AND note.revision = ?
      JOIN adaptive_note_steps trace ON trace.note_id = note.rowid
      WHERE review.taskId = ?
    `).get(row.revision, sourceTaskId);
    if (typeof saved?.steps !== "string") return;
    const steps = JSON.parse(saved.steps) as SentinelReviewStep[];
    for (const [stepIndex, step] of steps.slice(0, 16).entries()) {
      if (
        (exactIndex !== undefined && exactIndex !== stepIndex) ||
        step?.tool !== "sentinel_assigned_target" ||
        step.outcome !== "returned" ||
        (step.target !== row.nodeId &&
          step.target !== row.nodeId.slice(0, 256)) ||
        !readSentinelAssignedTargetReceipt(step.assignedTarget, row.nodeId)
          ?.linkedNodeIds.includes(targetId)
      ) continue;
      return {
        citation: { sourceTaskId, evidenceRevision, targetId, stepIndex },
        sourceTargetId: row.nodeId,
      };
    }
  }

  function priorAssignedTargetCitationCandidates(
    priorTaskId: string,
    beforeEvidenceRevision: number,
    destinationGoal?: AdaptiveEvidenceRevision["goal"],
  ): {
    citation: AdaptivePriorAssignedTargetCitation;
    sourceTargetId: string;
  }[] {
    const priorRow = lookup.get(taskId(priorTaskId));
    const tables = db.prepare(
      "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name IN ('adaptive_note_steps', 'adaptive_evidence_revisions')",
    ).get();
    if (
      !priorRow || !Number.isSafeInteger(beforeEvidenceRevision) ||
      beforeEvidenceRevision < 2 || tables?.count !== 2
    ) return [];
    const prior = decodeTask(priorRow);
    const targetId = prior.nodeId;
    if (!targetId) return [];
    const scope = db.prepare(`
      SELECT evidenceNumber, goalId, goalLabel FROM adaptive_evidence_revisions AS current
      WHERE revision = ? AND evidenceNumber < ?
        AND rowid = (
          SELECT MAX(mapping.rowid) FROM adaptive_evidence_revisions mapping
          WHERE mapping.evidenceNumber = current.evidenceNumber
        )
      ORDER BY evidenceNumber DESC LIMIT 1
    `).get(prior.revision, beforeEvidenceRevision);
    if (
      !scope || typeof scope.goalId !== "string" ||
      typeof scope.goalLabel !== "string" || (destinationGoal &&
        (scope.goalId !== destinationGoal.id ||
          scope.goalLabel !== destinationGoal.label))
    ) return [];
    const goal = { id: scope.goalId, label: scope.goalLabel };
    const candidates = new Map<
      string,
      { citation: AdaptivePriorAssignedTargetCitation; sourceTargetId: string }
    >();
    function include(
      targetId: string,
      sourceTaskId: string,
      evidenceRevision: number,
      exactIndex?: number,
    ) {
      const source = priorAssignedTargetCitationFromSource(
        sourceTaskId,
        evidenceRevision,
        targetId,
        beforeEvidenceRevision,
        goal,
        exactIndex,
      );
      if (source) {
        candidates.set(assignedTargetCitationKey(source.citation), source);
      }
    }
    for (
      const citation of prior.plannerRound?.priorAssignedTargetCitations ?? []
    ) {
      if (citation.targetId === prior.nodeId) {
        include(
          targetId,
          citation.sourceTaskId,
          citation.evidenceRevision,
          citation.stepIndex,
        );
      }
    }
    for (const source of taskWorkerSources(prior)) {
      if (
        source.kind === "model_review" &&
        prior.prerequisites.includes(source.taskId) &&
        lookup.get(source.taskId)?.revision === prior.revision
      ) include(targetId, source.taskId, Number(scope.evidenceNumber));
    }
    return [...candidates.values()];
  }

  function validWorkerSources(
    task: ReturnType<typeof normalizeTask>,
    completed: (id: string) => boolean,
  ) {
    return !task.plannerRound?.workerSources || (!task.reviewedFrom &&
      taskWorkerSources(task).every(({ taskId, kind }) =>
        task.prerequisites.includes(taskId) && completed(taskId) &&
        (kind !== "model_review" || hasCitedModelReview(taskId))
      ));
  }

  function validCarriedAssignedTargets(
    task: ReturnType<typeof normalizeTask>,
    revision: string,
    get: (id: string) => AdaptiveTask | undefined,
  ) {
    return task.carriedAssignedTargetCitations?.every(
      ({ carrierTaskId, citation }) => {
        const carrier = get(carrierTaskId);
        return task.prerequisites.includes(carrierTaskId) &&
          carrier?.revision === revision && carrier.status === "completed" &&
          carrier.nodeId === citation.targetId &&
          carrier.plannerRound?.priorAssignedTargetCitations?.some((saved) =>
            assignedTargetCitationKey(saved) ===
              assignedTargetCitationKey(citation)
          );
      },
    ) ?? true;
  }

  function uniqueAssignedTargetCitations(
    existing: readonly AdaptivePriorAssignedTargetCitation[],
    carried: readonly AdaptiveCarriedAssignedTargetCitation[],
  ) {
    return [...new Map(
      [...existing, ...carried.map(({ citation }) => citation)].map((
        citation,
      ) => [assignedTargetCitationKey(citation), citation]),
    ).values()];
  }

  function includeProposedTasks(
    tasks: Map<string, AdaptiveTask>,
    revision: string,
    requests: readonly AdaptiveTaskRequest[],
  ) {
    if (
      requests.length > 8 || tasks.size + requests.length > MAX_ADAPTIVE_TASKS
    ) {
      return undefined;
    }
    const additions = requests.map((request) =>
      normalizeTask(revision, request)
    );
    for (const task of additions) {
      if (
        !task.plannerRound || tasks.has(task.id) || task.carriedFrom ||
        !validWorkerSources(
          task,
          (id) => tasks.get(id)?.status === "completed",
        ) ||
        !validCarriedAssignedTargets(task, revision, (id) => tasks.get(id)) ||
        (task.reviewedFrom &&
          (!task.prerequisites.includes(task.reviewedFrom) ||
            tasks.get(task.reviewedFrom)?.status !== "completed")) ||
        (task.plannerRound.sourceKind === "model_review" &&
          (!task.reviewedFrom || !hasCitedModelReview(task.reviewedFrom))) ||
        task.prerequisites.some((id) => {
          const prerequisite = tasks.get(id);
          return !prerequisite ||
            !["queued", "running", "completed"].includes(prerequisite.status) ||
            !!prerequisite.retirementReason ||
            !!prerequisite.dependencyRecommendation;
        })
      ) return undefined;
      tasks.set(task.id, { ...task, revision, status: "queued", attempts: 0 });
    }
    return additions;
  }

  function citationUpdates(
    tasks: ReadonlyMap<string, AdaptiveTask>,
    requests: readonly ReturnType<typeof normalizeTask>[],
    requireCompatible: boolean,
  ) {
    const updates = new Map<string, AdaptiveTask>();
    for (const request of requests) {
      const candidate = taskUpstreamCitations(request);
      const workers = taskWorkerSources(request);
      const peerFindings = request.plannerRound?.peerFindingCitations ?? [];
      const carriedTargets = request.carriedAssignedTargetCitations ?? [];
      const current = updates.get(request.id) ?? tasks.get(request.id);
      if (
        (!candidate.length && !workers.length && !peerFindings.length &&
          !carriedTargets.length) ||
        !current?.plannerRound ||
        !validCarriedAssignedTargets(
          request,
          current.revision,
          (id) => tasks.get(id),
        ) ||
        !workers.every(({ taskId, kind }) =>
          current.prerequisites.includes(taskId) &&
          tasks.get(taskId)?.status === "completed" &&
          (kind !== "model_review" || hasCitedModelReview(taskId))
        ) ||
        (current.status !== "queued" && current.status !== "completed") ||
        !isDeepStrictEqual(current.prerequisites, request.prerequisites) ||
        !candidate.every(({ alertId }) =>
          /^case-alert:[a-f0-9]{64}$/.test(alertId)
        )
      ) {
        if (requireCompatible) return undefined;
        continue;
      }
      const original = taskUpstreamCitations(current);
      const combined = [
        ...new Map(
          [...original, ...candidate].map((
            entry,
          ) => [JSON.stringify([entry.alertId, entry.checkId]), entry]),
        ).values(),
      ];
      const evidenceIds = [
        ...new Set([
          ...current.evidenceIds,
          ...combined.map(({ alertId }) => alertId),
        ]),
      ].sort();
      const priorWorkers = taskWorkerSources(current);
      const priorCarriers =
        current.plannerRound.carriedAssignedTargetCitations ?? [];
      const combinedCarriers = [...new Map(
        [...priorCarriers, ...carriedTargets].map((
          entry,
        ) => [carriedAssignedTargetKey(entry), entry]),
      ).values()];
      const combinedTargets = uniqueAssignedTargetCitations(
        current.plannerRound.priorAssignedTargetCitations ?? [],
        combinedCarriers,
      );
      const priorPeers = current.plannerRound.peerFindingCitations ?? [];
      const combinedPeers = [
        ...new Map([...priorPeers, ...peerFindings].map((citation) => [
          peerFindingKey(citation),
          citation,
        ])).values(),
      ];
      const workerSources = new Map(
        priorWorkers.map((source) => [source.taskId, source]),
      );
      const conflicts = workers.some(({ taskId, kind }) => {
        const previous = workerSources.get(taskId);
        return previous && previous.kind !== kind;
      });
      for (const source of workers) workerSources.set(source.taskId, source);
      if (
        combined.length > 12 || evidenceIds.length > 12 ||
        workerSources.size > 4 || conflicts ||
        combinedPeers.length > MAX_PEER_FINDING_CITATIONS ||
        combinedCarriers.length > 4 || combinedTargets.length > 4
      ) {
        if (requireCompatible) return undefined;
        continue;
      }
      if (
        combined.length === original.length &&
        workerSources.size === priorWorkers.length &&
        combinedPeers.length === priorPeers.length &&
        combinedCarriers.length === priorCarriers.length
      ) continue;
      updates.set(request.id, {
        ...current,
        evidenceIds,
        plannerRound: roundWithUpstreamCitations({
          ...current.plannerRound,
          ...(workerSources.size > priorWorkers.length &&
            { workerSources: [...workerSources.values()] }),
          ...(combinedPeers.length > priorPeers.length &&
            { peerFindingCitations: combinedPeers }),
          ...(combinedCarriers.length > priorCarriers.length && {
            carriedAssignedTargetCitations: combinedCarriers,
            priorAssignedTargetCitations: combinedTargets,
          }),
        }, combined),
      });
    }
    return [...updates.values()];
  }

  function writeCitationUpdates(
    revision: string,
    updates: readonly AdaptiveTask[],
    time: number,
  ) {
    if (!updates.length) return;
    const save = db.prepare(
      "UPDATE adaptive_tasks SET evidenceIds = ?, plannerRound = ? WHERE id = ? AND revision = ?",
    );
    for (const task of updates) {
      save.run(
        JSON.stringify(task.evidenceIds),
        JSON.stringify(task.plannerRound),
        task.id,
        revision,
      );
      event.run(
        revision,
        task.id,
        "evidence_attached",
        task.attempts,
        time,
        "Planner attached validated investigation evidence.",
      );
    }
  }

  function setPlannerPriorities(revision: string, ordered: readonly string[]) {
    db.prepare(`UPDATE adaptive_tasks SET plannerPriority = NULL
      WHERE revision = ? AND status = 'queued' AND plannerPriority IS NOT NULL`)
      .run(revision);
    const ranked = db.prepare(
      `UPDATE adaptive_tasks SET plannerPriority = ?, retirementReason = NULL
      WHERE id = ? AND revision = ? AND status = 'queued' AND plannerRound IS NOT NULL`,
    );
    let count = 0;
    for (const [index, id] of ordered.entries()) {
      const held = lookup.get(id)?.retirementReason;
      if (!ranked.run(index + 1, id, revision).changes) continue;
      if (held) {
        event.run(
          revision,
          id,
          "retirement_withdrawn",
          0,
          now(),
          "The latest model plan prioritized this investigation.",
        );
      }
      event.run(
        revision,
        id,
        "planner_prioritized",
        0,
        now(),
        "The latest model plan prioritized this queued investigation.",
      );
      count++;
    }
    return count;
  }

  function setRetirementRecommendations(
    revision: string,
    proposed: ReadonlyMap<string, string>,
  ) {
    const setReason = db.prepare(
      "UPDATE adaptive_tasks SET retirementReason = ? WHERE id = ?",
    );
    const hasDependent = db.prepare(
      `SELECT 1 FROM adaptive_dependencies AS dependency
      JOIN adaptive_tasks AS dependent ON dependent.id = dependency.taskId
      WHERE dependency.dependencyId = ? AND dependent.status IN ('queued', 'running')
      LIMIT 1`,
    );
    for (const task of getRevisionTasks.all(revision).map(decodeTask)) {
      if (task.status !== "queued" || !task.plannerRound) continue;
      const reason = task.prioritized || task.dependencyRecommendation ||
          hasDependent.get(task.id)
        ? undefined
        : proposed.get(task.id);
      if (reason === task.retirementReason) continue;
      setReason.run(reason ?? null, task.id);
      event.run(
        revision,
        task.id,
        reason ? "retirement_recommended" : "retirement_withdrawn",
        task.attempts,
        now(),
        reason ??
          "The latest model plan withdrew its retirement recommendation.",
      );
    }
  }

  function optionalQueueChangeTargets(
    tasks: ReadonlyMap<string, AdaptiveTask>,
    changes: ReadonlyMap<string, DependencyChange>,
    queueChanges: PlannerQueueChanges,
    groupId?: string,
  ) {
    const targets = new Map<string, string>();
    for (const id of queueChanges.priorities ?? []) {
      targets.set(taskId(id), "Proposed planner priority.");
    }
    for (const { id, reason } of queueChanges.retirements ?? []) {
      if (targets.has(id)) return undefined;
      targets.set(taskId(id), boundedText(reason, "retirement reason", 300));
    }
    for (const id of targets.keys()) {
      const task = tasks.get(id);
      if (
        !task?.plannerRound || task.status !== "queued" || task.prioritized ||
        task.dependencyRecommendation?.id !== groupId || changes.has(id)
      ) return undefined;
      if (
        [...tasks.values()].some((other) =>
          ["queued", "running"].includes(other.status) &&
          (changes.get(other.id)?.prerequisites ?? other.prerequisites)
            .includes(id)
        )
      ) return undefined;
    }
    return targets;
  }

  function canChangeDependencies(
    tasks: ReadonlyMap<string, AdaptiveTask>,
    changes: ReadonlyMap<string, DependencyChange>,
    groupId?: string,
  ): boolean {
    for (const change of changes.values()) {
      const target = tasks.get(change.id);
      if (
        !target?.plannerRound || target.status !== "queued" ||
        target.prioritized ||
        target.retirementReason ||
        taskWorkerSources(target).some(({ taskId }) =>
          !change.prerequisites.includes(taskId)
        ) ||
        target.plannerRound.carriedAssignedTargetCitations?.some((
          { carrierTaskId },
        ) => !change.prerequisites.includes(carrierTaskId)) ||
        target.dependencyRecommendation?.id !== groupId ||
        JSON.stringify(target.prerequisites) ===
          JSON.stringify(change.prerequisites)
      ) return false;
      const pending = [...change.prerequisites];
      const visited = new Set<string>();
      while (pending.length) {
        const id = pending.pop()!;
        if (id === target.id) return false;
        if (visited.has(id)) continue;
        visited.add(id);
        const task = tasks.get(id);
        if (
          !task || !["queued", "running", "completed"].includes(task.status) ||
          task.retirementReason ||
          (task.dependencyRecommendation &&
            task.dependencyRecommendation.id !== groupId)
        ) return false;
        pending.push(...(changes.get(id)?.prerequisites ?? task.prerequisites));
      }
    }
    return ![...tasks.values()].some((task) =>
      !changes.has(task.id) && ["queued", "running"].includes(task.status) &&
      task.prerequisites.some((id) => changes.has(id))
    );
  }

  return {
    /** Activate an evidence revision and add topologically ordered proposals. */
    sync(
      revision: string,
      requests: readonly AdaptiveTaskRequest[],
      expectedRevision?: string | null,
      evidence?: AdaptiveEvidenceRevision,
      incidentSources: readonly AdaptiveIncidentImpactSource[] = [],
      verificationSources: readonly AdaptiveVerificationReviewCandidate[] = [],
      expectedQueueWatermark?: number,
    ): AdaptiveTask[] {
      revision = revisionKey(revision);
      if (!Array.isArray(requests) || requests.length > MAX_ADAPTIVE_TASKS) {
        throw new Error("Too many Sentinel adaptive task proposals");
      }
      const tasks = requests.map((request) => normalizeTask(revision, request));
      return transaction(db, () => {
        const time = now();
        if (
          expectedQueueWatermark !== undefined &&
          taskQueueWatermark() !== expectedQueueWatermark
        ) throw new SentinelAdaptiveQueueChanged();
        if (
          expectedRevision !== undefined &&
          activeRevision() !== expectedRevision
        ) {
          if (expectedQueueWatermark !== undefined) {
            throw new SentinelAdaptiveQueueChanged();
          }
          throw new Error("Sentinel adaptive evidence revision changed");
        }
        const previous = activeRevision();
        recordExpiredModelReviews(revision, time);
        for (const id of new Set(evidence?.unavailableAssignments)) {
          const prior = lookup.get(taskId(id));
          const pending = prior?.revision === previous &&
            (prior?.status === "queued" || prior?.status === "running");
          const completed = prior?.status === "completed" &&
            prior.revision !== revision;
          if (!prior || previous === revision || (!pending && !completed)) {
            throw new Error(
              "Unavailable Sentinel assignment must belong to an earlier plan.",
            );
          }
          if (
            completed && db.prepare(`
            SELECT 1 FROM adaptive_events WHERE revision = ? AND taskId = ?
              AND event = 'assignment_unavailable'
          `).get(prior.revision, id)
          ) continue;
          event.run(
            prior.revision,
            id,
            "assignment_unavailable",
            prior.attempts,
            time,
            `The assignment could not be revalidated against evidence revision ${
              evidence!.number
            }.`,
          );
        }
        setActive(revision, time);
        if (evidence) {
          db.exec(`CREATE TABLE IF NOT EXISTS adaptive_evidence_revisions (
            revision TEXT NOT NULL REFERENCES adaptive_revisions(revision),
            evidenceNumber INTEGER NOT NULL,
            goalId TEXT NOT NULL,
            goalLabel TEXT NOT NULL,
            PRIMARY KEY (evidenceNumber, revision)
          )`);
          const latest = db.prepare(
            "SELECT revision FROM adaptive_evidence_revisions WHERE evidenceNumber = ? ORDER BY rowid DESC LIMIT 1",
          ).get(evidence.number) as { revision: string } | undefined;
          if (latest?.revision !== revision) {
            db.prepare(
              "INSERT OR REPLACE INTO adaptive_evidence_revisions VALUES (?, ?, ?, ?)",
            )
              .run(
                revision,
                evidence.number,
                evidence.goal.id,
                evidence.goal.label,
              );
          }
        }

        const existing = db.prepare(
          "SELECT id FROM adaptive_tasks WHERE revision = ?",
        ).all(revision);
        const ids = new Set([
          ...existing.map((task) => String(task.id)),
          ...tasks.map((task) => task.id),
        ]);
        if (ids.size > MAX_ADAPTIVE_TASKS) {
          throw new Error("Sentinel adaptive revision exceeds 1000 tasks");
        }
        const priorities: { id: string; order: number }[] = [];
        const recentPriority = db.prepare(`
          SELECT rowid, event FROM adaptive_events
          WHERE revision = (SELECT revision FROM adaptive_tasks WHERE id = ?)
            AND taskId = ? AND event IN ('prioritized', 'priority_withdrawn', 'claimed')
          ORDER BY rowid DESC LIMIT 1
        `);
        for (const task of tasks) {
          if (!enqueue(revision, task, time, evidence) || !task.carriedFrom) {
            continue;
          }
          const prior = recentPriority.get(task.carriedFrom, task.carriedFrom);
          if (prior?.event === "prioritized") {
            priorities.push({ id: task.id, order: Number(prior.rowid) });
          }
        }
        for (const task of priorities.sort((a, b) => a.order - b.order)) {
          event.run(
            revision,
            task.id,
            "prioritized",
            0,
            time,
            "Pending operator priority carried forward from the prior plan.",
          );
        }
        const saveEvidence = db.prepare(
          "UPDATE adaptive_tasks SET evidenceIds = ? WHERE id = ?",
        );
        for (const { targetId, sourceId } of incidentSources) {
          const target = lookup.get(targetId);
          const source = lookup.get(sourceId);
          if (
            target?.revision !== revision || target.kind !== "impact" ||
            (target.status !== "queued" && target.status !== "completed") ||
            source?.revision !== revision ||
            source.kind !== "review_incident" ||
            source.status !== "completed" ||
            typeof source.observation !== "string" ||
            typeof source.nodeId !== "string" ||
            !/^incident:[a-f0-9]{64}$/.test(source.nodeId)
          ) continue;
          const observation = JSON.parse(source.observation) as
            | Record<string, unknown>
            | null;
          if (
            observation?.id !== source.nodeId ||
            (observation.asset !== target.nodeId &&
              !(Array.isArray(observation.relatedAssetIds) &&
                observation.relatedAssetIds.includes(target.nodeId)))
          ) continue;
          const evidenceIds = decodeTask(target).evidenceIds;
          if (evidenceIds.length >= 64 || evidenceIds.includes(source.nodeId)) {
            continue;
          }
          saveEvidence.run(
            JSON.stringify([...evidenceIds, source.nodeId].sort()),
            targetId,
          );
          event.run(
            revision,
            targetId,
            "evidence_attached",
            Number(target.attempts),
            time,
            "A completed incident review supplied additional impact evidence.",
          );
        }
        const saveVerificationSource = db.prepare(`
          INSERT OR IGNORE INTO adaptive_verification_sources
            (revision, targetId, sourceId, evidenceId) VALUES (?, ?, ?, ?)
        `);
        const verificationObservations = new Map<string, {
          readonly digest: string;
          readonly failures?: ReadonlySet<string>;
        }>();
        for (
          const { targetId, sourceId, evidenceId, sourceObservationDigest }
            of verificationSources
        ) {
          const target = lookup.get(targetId);
          const source = lookup.get(sourceId);
          if (
            target?.revision !== revision ||
            target.kind !== "review_evidence" ||
            target.nodeId !== evidenceId ||
            source?.revision !== revision ||
            source.kind !== "verify_control_coverage" ||
            source.status !== "completed" ||
            typeof source.observation !== "string"
          ) continue;
          let proof = verificationObservations.get(sourceId);
          if (!proof) {
            const observation = JSON.parse(source.observation);
            const controls = observation?.controlVerification?.controls;
            const digested = typeof observation?.resultDigest === "string" &&
              /^[a-f0-9]{64}$/.test(observation.resultDigest);
            proof = {
              digest: createHash("sha256").update(source.observation).digest(
                "hex",
              ),
              // The planner validates an oversized observation against the
              // pinned full result before presenting the digest citation.
              failures: Array.isArray(controls)
                ? new Set(
                  controls.flatMap((control) =>
                    control?.status === "fail" &&
                      typeof control.evidenceId === "string"
                      ? [control.evidenceId]
                      : []
                  ),
                )
                : digested
                ? undefined
                : new Set(),
            };
            verificationObservations.set(sourceId, proof);
          }
          if (
            proof.digest !== sourceObservationDigest ||
            (proof.failures && !proof.failures.has(evidenceId))
          ) continue;
          const saved = saveVerificationSource.run(
            revision,
            targetId,
            sourceId,
            evidenceId,
          );
          if (saved.changes) {
            event.run(
              revision,
              targetId,
              "evidence_attached",
              Number(target.attempts),
              time,
              "A completed control verification cited this exact failure record.",
            );
          }
        }
        if (
          db.prepare(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_peer_verifications'",
          ).get()
        ) {
          if (previous !== revision) {
            db.exec("DELETE FROM adaptive_peer_verifications");
          } else {
            db.prepare(
              "DELETE FROM adaptive_peer_verifications WHERE revision = ?",
            ).run(revision);
          }
        }
        return getRevisionTasks.all(revision).map(decodeTask);
      });
    },

    peerFindingVerifications(
      revision: string,
    ): AdaptivePeerFindingVerification[] {
      revision = revisionKey(revision);
      if (
        !db.prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_peer_verifications'",
        ).get()
      ) return [];
      return db.prepare(`
        SELECT citation, verified FROM adaptive_peer_verifications
        WHERE revision = ? ORDER BY citation
      `).all(revision).map(({ citation, verified }) => ({
        citation: JSON.parse(String(citation)) as AdaptivePeerFindingCitation,
        verified: verified === 1,
      }));
    },

    prunePeerFindingVerifications(
      revision: string,
      citations: readonly AdaptivePeerFindingCitation[],
    ): void {
      revision = revisionKey(revision);
      if (citations.length > MAX_ADAPTIVE_TASKS * 4) {
        throw new Error("Too many selected Sentinel peer verifications");
      }
      if (
        !db.prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_peer_verifications'",
        ).get()
      ) return;
      const keys = citations.map((citation) =>
        JSON.stringify(normalizePeerFindingCitation(citation))
      );
      db.prepare(`
        DELETE FROM adaptive_peer_verifications WHERE revision = ?
        AND citation NOT IN (SELECT value FROM json_each(?))
      `).run(revision, JSON.stringify(keys));
    },

    recordPeerFindingVerifications(
      revision: string,
      entries: readonly AdaptivePeerFindingVerification[],
      includeActive = false,
    ): void {
      revision = revisionKey(revision);
      if (
        !Array.isArray(entries) || entries.length > MAX_PEER_VERIFICATION_BATCH
      ) {
        throw new Error("Too many Sentinel peer verifications in one batch");
      }
      const normalized = Array.from(entries, (entry) => {
        if (!entry || typeof entry.verified !== "boolean") {
          throw new Error("Invalid Sentinel peer verification outcome");
        }
        return {
          citation: JSON.stringify(
            normalizePeerFindingCitation(entry.citation),
          ),
          verified: Number(entry.verified),
        };
      });
      if (!normalized.length) return;
      transaction(db, () => {
        if (!includeActive && revision === activeRevision()) return;
        db.exec(`CREATE TABLE IF NOT EXISTS adaptive_peer_verifications (
          revision TEXT NOT NULL,
          citation TEXT NOT NULL,
          verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
          PRIMARY KEY(revision, citation)
        )`);
        db.prepare(
          "DELETE FROM adaptive_peer_verifications WHERE revision <> ?",
        ).run(revision);
        const save = db.prepare(`
          INSERT INTO adaptive_peer_verifications VALUES (?, ?, ?)
          ON CONFLICT(revision, citation) DO UPDATE SET verified = excluded.verified
        `);
        for (const { citation, verified } of normalized) {
          save.run(revision, citation, verified);
        }
        const count = db.prepare(
          "SELECT count(*) AS count FROM adaptive_peer_verifications",
        ).get();
        if (
          Number(count?.count) > MAX_ADAPTIVE_TASKS * MAX_PEER_FINDING_CITATIONS
        ) {
          throw new Error("Sentinel peer verification cache is full");
        }
      });
    },

    claimModelPlan(
      identity: string,
      context?: {
        readonly hintIds?: readonly number[];
        readonly findingReviewIds?: readonly number[];
        readonly incidentReviewIds?: readonly number[];
        readonly incidentCandidateIds?: readonly string[];
        readonly findingReviewId?: number;
        readonly incidentReviewId?: number;
        readonly formalGoalSetKey?: string;
        readonly operatingConstraintKey?: string;
      },
    ): number | "already_claimed" | "cooldown" {
      identity = revisionKey(identity);
      return transaction(db, () => {
        db.exec(`CREATE TABLE IF NOT EXISTS adaptive_model_attempts (
          identity TEXT PRIMARY KEY,
          started INTEGER NOT NULL
        )`);
        db.exec(`CREATE TABLE IF NOT EXISTS adaptive_model_leases (
          identity TEXT PRIMARY KEY REFERENCES adaptive_model_attempts(identity),
          attempt INTEGER NOT NULL,
          completed INTEGER NOT NULL DEFAULT 0
        )`);
        db.exec(`CREATE TABLE IF NOT EXISTS adaptive_model_history (
          identity TEXT NOT NULL REFERENCES adaptive_model_attempts(identity),
          attempt INTEGER NOT NULL,
          started INTEGER NOT NULL,
          outcome INTEGER NOT NULL DEFAULT 0,
          finished INTEGER,
          PRIMARY KEY(identity, attempt)
        )`);
        const prior = db.prepare(`
          SELECT attempts.started, lease.attempt, lease.completed
          FROM adaptive_model_attempts AS attempts
          LEFT JOIN adaptive_model_leases AS lease USING (identity)
          WHERE attempts.identity = ?
        `).get(identity);
        if (
          prior &&
          (prior.attempt === null || Number(prior.completed) > 0 ||
            Number(prior.attempt) >= 2)
        ) {
          return "already_claimed";
        }
        const time = now();
        const last = db.prepare(
          "SELECT MAX(started) AS latest FROM adaptive_model_attempts",
        ).get()?.latest;
        const goalSet = context?.formalGoalSetKey;
        let firstGoalRound = false;
        if (!prior && goalSet && /^[a-f0-9]{64}$/.test(goalSet)) {
          db.exec(
            `CREATE TABLE IF NOT EXISTS adaptive_model_formal_goal_rounds (
            goalSet TEXT PRIMARY KEY
          )`,
          );
          firstGoalRound = Boolean(
            db.prepare(
              "INSERT OR IGNORE INTO adaptive_model_formal_goal_rounds VALUES (?)",
            )
              .run(goalSet).changes,
          );
        }
        const constraintKey = context?.operatingConstraintKey;
        let firstConstraintRound = false;
        if (!prior && constraintKey && /^[a-f0-9]{64}$/.test(constraintKey)) {
          db.exec(`CREATE TABLE IF NOT EXISTS adaptive_model_constraint_rounds (
            constraintKey TEXT PRIMARY KEY
          )`);
          firstConstraintRound = Boolean(
            db.prepare(
              "INSERT OR IGNORE INTO adaptive_model_constraint_rounds VALUES (?)",
            ).run(constraintKey).changes,
          );
        }
        if (
          !firstGoalRound && !firstConstraintRound &&
          typeof last === "number" && time - last < 60_000
        ) {
          return "cooldown";
        }
        if (prior?.attempt != null) {
          db.prepare(`INSERT OR IGNORE INTO adaptive_model_history
            (identity, attempt, started, outcome) VALUES (?, ?, ?, ?)`)
            .run(identity, prior.attempt, prior.started, prior.completed);
          db.prepare(`UPDATE adaptive_model_history
            SET outcome = -1, finished = ?
            WHERE identity = ? AND attempt = ? AND outcome = 0`)
            .run(time, identity, prior.attempt);
        }
        const attempt = Number(prior?.attempt ?? 0) + 1;
        db.prepare(`INSERT INTO adaptive_model_attempts VALUES (?, ?)
          ON CONFLICT(identity) DO UPDATE SET started = excluded.started`).run(
          identity,
          time,
        );
        db.prepare(`INSERT INTO adaptive_model_leases VALUES (?, ?, 0)
          ON CONFLICT(identity) DO UPDATE SET attempt = excluded.attempt, completed = 0`)
          .run(
            identity,
            attempt,
          );
        db.prepare(`INSERT INTO adaptive_model_history
          (identity, attempt, started) VALUES (?, ?, ?)`).run(
          identity,
          attempt,
          time,
        );
        if (context?.findingReviewId || context?.incidentReviewId) {
          db.exec(`CREATE TABLE IF NOT EXISTS adaptive_model_decision_context (
            identity TEXT PRIMARY KEY REFERENCES adaptive_model_attempts(identity),
            findingReviewId INTEGER,
            incidentReviewId INTEGER
          )`);
          db.prepare(
            "INSERT OR IGNORE INTO adaptive_model_decision_context VALUES (?, ?, ?)",
          )
            .run(
              identity,
              context.findingReviewId ?? null,
              context.incidentReviewId ?? null,
            );
        }
        if (context?.hintIds !== undefined) {
          db.exec(`CREATE TABLE IF NOT EXISTS adaptive_model_hint_context (
            identity TEXT NOT NULL,
            attempt INTEGER NOT NULL,
            hintIds TEXT NOT NULL,
            PRIMARY KEY(identity, attempt),
            FOREIGN KEY(identity, attempt) REFERENCES adaptive_model_history(identity, attempt)
          )`);
          db.prepare("INSERT INTO adaptive_model_hint_context VALUES (?, ?, ?)")
            .run(identity, attempt, JSON.stringify(context.hintIds));
        }
        if (context?.findingReviewIds || context?.incidentReviewIds) {
          db.exec(`CREATE TABLE IF NOT EXISTS adaptive_model_decision_inputs (
            identity TEXT NOT NULL,
            attempt INTEGER NOT NULL,
            findingReviewIds TEXT NOT NULL,
            incidentReviewIds TEXT NOT NULL,
            PRIMARY KEY(identity, attempt),
            FOREIGN KEY(identity, attempt) REFERENCES adaptive_model_history(identity, attempt)
          )`);
          db.prepare(
            "INSERT INTO adaptive_model_decision_inputs VALUES (?, ?, ?, ?)",
          )
            .run(
              identity,
              attempt,
              JSON.stringify(context.findingReviewIds ?? []),
              JSON.stringify(context.incidentReviewIds ?? []),
            );
        }
        if (context?.incidentCandidateIds !== undefined) {
          const ids = context.incidentCandidateIds;
          if (
            ids.length > 12 || new Set(ids).size !== ids.length ||
            ids.some((id) => !/^incident:[a-f0-9]{64}$/.test(id))
          ) {
            throw new Error("Invalid Sentinel incident planning inputs");
          }
          db.exec(`CREATE TABLE IF NOT EXISTS adaptive_model_incident_inputs (
            identity TEXT NOT NULL,
            attempt INTEGER NOT NULL,
            incidentCandidateIds TEXT NOT NULL,
            PRIMARY KEY(identity, attempt),
            FOREIGN KEY(identity, attempt) REFERENCES adaptive_model_history(identity, attempt)
          )`);
          db.prepare(
            "INSERT INTO adaptive_model_incident_inputs VALUES (?, ?, ?)",
          )
            .run(identity, attempt, JSON.stringify(ids));
        }
        return attempt;
      });
    },

    /** Bind an immutable post-budget input receipt to the active attempt. */
    recordModelPlanInputManifest(
      identity: string,
      attempt: number,
      input: AdaptivePlannerInputManifest,
    ): boolean {
      identity = revisionKey(identity);
      if (!Number.isSafeInteger(attempt) || attempt < 1) {
        throw new Error("Invalid Sentinel planning attempt");
      }
      const manifest = normalizePlanningInputManifest(input);
      return transaction(db, () => {
        if (
          !db.prepare(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_model_leases'",
          ).get()
        ) return false;
        const lease = db.prepare(`
          SELECT started FROM adaptive_model_leases
          JOIN adaptive_model_history USING (identity, attempt)
          WHERE identity = ? AND attempt = ? AND completed = 0 AND outcome = 0
        `).get(identity, attempt);
        if (!lease || now() >= Number(lease.started) + 30_000) return false;
        db.exec(`CREATE TABLE IF NOT EXISTS adaptive_model_input_manifests (
          identity TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          inputManifest TEXT NOT NULL,
          PRIMARY KEY(identity, attempt),
          FOREIGN KEY(identity, attempt) REFERENCES adaptive_model_history(identity, attempt)
        )`);
        db.prepare(
          "INSERT OR IGNORE INTO adaptive_model_input_manifests VALUES (?, ?, ?)",
        ).run(identity, attempt, manifest);
        return db.prepare(`
          SELECT inputManifest FROM adaptive_model_input_manifests
          WHERE identity = ? AND attempt = ?
        `).get(identity, attempt)?.inputManifest === manifest;
      });
    },

    modelPlanStatus(identity: string) {
      if (
        !db.prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_model_leases'",
        ).get()
      ) return null;
      const row = db.prepare(`
        SELECT started, attempt, completed
        FROM adaptive_model_attempts JOIN adaptive_model_leases USING (identity)
        WHERE identity = ?
      `).get(revisionKey(identity));
      if (!row) return null;
      const attempt = Number(row.attempt);
      const started = Number(row.started);
      const status = row.completed === 1
        ? "completed"
        : row.completed === 2
        ? "no_new_assignments"
        : row.completed === 3
        ? "proposal_rejected"
        : row.completed === -2
        ? "superseded"
        : row.completed === 0 && now() < started + 30_000
        ? "running"
        : attempt < 2
        ? "retry_pending"
        : "exhausted";
      return { attempt, status };
    },

    /** Save a bounded read receipt on its dispatched and current attempt. */
    recordModelPlanRead(
      identity: string,
      attempt: number,
      read: AdaptivePlannerRead,
    ): boolean {
      identity = revisionKey(identity);
      if (!Number.isSafeInteger(attempt) || attempt < 1) {
        throw new Error("Invalid Sentinel planning attempt");
      }
      const encoded = JSON.stringify(normalizePlannerRead(read));
      if (encoded.length > 32_768) {
        throw new Error("Sentinel planner read metadata is too large");
      }
      return transaction(db, () => {
        if (
          !db.prepare(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_model_input_manifests'",
          ).get()
        ) return false;
        const lease = db.prepare(`
          SELECT started FROM adaptive_model_leases
          JOIN adaptive_model_history USING (identity, attempt)
          JOIN adaptive_model_input_manifests USING (identity, attempt)
          WHERE identity = ? AND attempt = ? AND completed = 0 AND outcome = 0
        `).get(identity, attempt);
        if (!lease || now() >= Number(lease.started) + 30_000) return false;
        db.exec(`CREATE TABLE IF NOT EXISTS adaptive_model_reads (
          identity TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          plannerReads TEXT NOT NULL,
          PRIMARY KEY(identity, attempt),
          FOREIGN KEY(identity, attempt) REFERENCES adaptive_model_input_manifests(identity, attempt)
        )`);
        const saved = db.prepare(`
          INSERT INTO adaptive_model_reads VALUES (?, ?, json_array(json(?)))
          ON CONFLICT(identity, attempt) DO UPDATE
          SET plannerReads = json_insert(plannerReads, '$[#]', json(?))
          WHERE json_array_length(plannerReads) < ?
        `).run(identity, attempt, encoded, encoded, MAX_PLANNER_READS);
        return Number(saved.changes) === 1;
      });
    },

    modelPlanHistory(
      identity: string,
      includeSteeredRounds = false,
      referencedRounds: readonly string[] = [],
    ) {
      if (
        !db.prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_model_history'",
        ).get()
      ) return [];
      const base = revisionKey(identity);
      const hasDecisionContext = db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_model_decision_context'",
      ).get();
      const hasHintContext = db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_model_hint_context'",
      ).get();
      const hasDecisionInputs = db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_model_decision_inputs'",
      ).get();
      const hasIncidentInputs = db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_model_incident_inputs'",
      ).get();
      const hasInputManifest = db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_model_input_manifests'",
      ).get();
      const hasPlannerReads = db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_model_reads'",
      ).get();
      return db.prepare(`SELECT identity, attempt, started, outcome, finished
        ${hasHintContext ? ", hintIds" : ""}
        ${hasIncidentInputs ? ", incidentCandidateIds" : ""}
        ${hasDecisionInputs ? ", findingReviewIds, incidentReviewIds" : ""}
        ${hasDecisionContext ? ", findingReviewId, incidentReviewId" : ""}
        ${hasInputManifest ? ", inputManifest" : ""}
        ${hasPlannerReads ? ", plannerReads" : ""}
        FROM adaptive_model_history
        ${
        hasDecisionContext
          ? "LEFT JOIN adaptive_model_decision_context USING (identity)"
          : ""
      }
        ${
        hasHintContext
          ? "LEFT JOIN adaptive_model_hint_context USING (identity, attempt)"
          : ""
      }
        ${
        hasDecisionInputs
          ? "LEFT JOIN adaptive_model_decision_inputs USING (identity, attempt)"
          : ""
      }
        ${
        hasIncidentInputs
          ? "LEFT JOIN adaptive_model_incident_inputs USING (identity, attempt)"
          : ""
      }
        ${
        hasInputManifest
          ? "LEFT JOIN adaptive_model_input_manifests USING (identity, attempt)"
          : ""
      }
        ${
        hasPlannerReads
          ? "LEFT JOIN adaptive_model_reads USING (identity, attempt)"
          : ""
      }
        WHERE identity = ? OR (? = 1 AND (
          identity GLOB ? OR identity GLOB ? OR identity GLOB ?
          OR identity GLOB ? OR identity GLOB ?
        ))
          OR identity IN (SELECT value FROM json_each(?))
        ORDER BY started, identity, attempt`)
        .all(
          base,
          Number(includeSteeredRounds),
          `${base}:hint:*`,
          `${base}:review:*`,
          `${base}:obs:*`,
          `${base}:goal:*`,
          `${base}:constraints:*`,
          JSON.stringify(referencedRounds.map(revisionKey)),
        ).map((row) => {
          const hint = /:hint:(\d+)(?:$|:review:|:goal:|:constraints:|:obs:)/
            .exec(
              String(row.identity),
            );
          const inputManifest = typeof row.inputManifest === "string"
            ? decodePlanningInputManifest(row.inputManifest)
            : undefined;
          const hintIds = inputManifest?.hintIds ??
            (typeof row.hintIds === "string"
              ? JSON.parse(row.hintIds) as number[]
              : undefined);
          const findingReviewIds = inputManifest?.findingReviewIds ??
            (typeof row.findingReviewIds === "string"
              ? JSON.parse(row.findingReviewIds) as number[]
              : undefined);
          const incidentReviewIds = inputManifest?.incidentReviewIds ??
            (typeof row.incidentReviewIds === "string"
              ? JSON.parse(row.incidentReviewIds) as number[]
              : undefined);
          const incidentCandidateIds = inputManifest?.incidentCandidateIds ??
            (typeof row.incidentCandidateIds === "string"
              ? JSON.parse(row.incidentCandidateIds) as string[]
              : undefined);
          return {
            identity: String(row.identity),
            ...(typeof row.findingReviewId === "number" &&
              { findingReviewId: row.findingReviewId }),
            ...(typeof row.incidentReviewId === "number" &&
              { incidentReviewId: row.incidentReviewId }),
            ...(findingReviewIds !== undefined && { findingReviewIds }),
            ...(incidentReviewIds !== undefined && { incidentReviewIds }),
            ...(incidentCandidateIds !== undefined && { incidentCandidateIds }),
            ...(inputManifest !== undefined && { inputManifest }),
            ...(typeof row.plannerReads === "string" && {
              reads: JSON.parse(row.plannerReads) as AdaptivePlannerRead[],
            }),
            attempt: Number(row.attempt),
            ...(hintIds !== undefined && { hintIds }),
            ...(hint && { hintId: Number(hint[1]) }),
            started: new Date(Number(row.started)).toISOString(),
            finished: row.finished === null
              ? null
              : new Date(Number(row.finished)).toISOString(),
            outcome: row.outcome === 1
              ? "completed"
              : row.outcome === 2
              ? "no_new_assignments"
              : row.outcome === 3
              ? "proposal_rejected"
              : row.outcome === -2
              ? "superseded"
              : row.outcome === -3
              ? "failed"
              : row.outcome === -1
              ? "interrupted"
              : now() < Number(row.started) + 30_000
              ? "running"
              : "interrupted",
          };
        });
    },

    completeModelPlan(
      identity: string,
      attempt: number,
      outcome:
        | boolean
        | "superseded"
        | "failed"
        | "no_new_assignments"
        | "proposal_rejected" = true,
    ): void {
      identity = revisionKey(identity);
      const status = outcome === "superseded"
        ? -2
        : outcome === "failed"
        ? -3
        : outcome === "proposal_rejected"
        ? 3
        : outcome === "no_new_assignments"
        ? 2
        : outcome
        ? 1
        : -1;
      transaction(db, () => {
        const updated = db.prepare(
          `UPDATE adaptive_model_leases SET completed = ?
          WHERE identity = ? AND attempt = ? AND completed = 0`,
        ).run(status, identity, attempt);
        if (updated.changes) {
          db.prepare(
            `UPDATE adaptive_model_history SET outcome = ?, finished = ?
            WHERE identity = ? AND attempt = ?`,
          ).run(status, now(), identity, attempt);
        }
      });
    },

    evidenceForTask(target: string, before: number): number | undefined {
      if (
        !db.prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_evidence_revisions'",
        ).get()
      ) return undefined;
      const row = db.prepare(`
        SELECT candidate.evidenceNumber FROM adaptive_evidence_revisions AS candidate
        JOIN adaptive_tasks AS task ON task.revision = candidate.revision
        WHERE task.id = ? AND candidate.evidenceNumber < ?
          AND candidate.rowid = (
            SELECT MAX(mapping.rowid) FROM adaptive_evidence_revisions AS mapping
            WHERE mapping.evidenceNumber = candidate.evidenceNumber
          )
        ORDER BY candidate.evidenceNumber DESC LIMIT 1
      `).get(taskId(target), before);
      return row ? Number(row.evidenceNumber) : undefined;
    },

    forEvidence(number: number, selection: "exact" | "earlier" = "exact") {
      if (
        !db.prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_evidence_revisions'",
        ).get()
      ) return null;
      const row = db.prepare(
        `SELECT revision, goalId, goalLabel FROM adaptive_evidence_revisions
        WHERE evidenceNumber ${selection === "exact" ? "=" : "<"} ?
        ORDER BY evidenceNumber DESC, rowid DESC LIMIT 1`,
      ).get(number);
      return row
        ? {
          revision: String(row.revision),
          goal: { id: String(row.goalId), label: String(row.goalLabel) },
        }
        : null;
    },

    latestAssignments(
      before: number,
      goal: { id: string; label: string },
      operatorReason: string,
    ) {
      if (!this.forEvidence(before, "earlier")) return [];
      return db.prepare(`
        SELECT * FROM (
          SELECT task.*, mapping.evidenceNumber,
            ROW_NUMBER() OVER (
              PARTITION BY task.kind, task.nodeId, task.depth, task.reason IS ?
              ORDER BY mapping.evidenceNumber DESC, mapping.rowid DESC
            ) AS rank
          FROM adaptive_tasks AS task
          JOIN adaptive_evidence_revisions AS mapping ON mapping.revision = task.revision
          WHERE mapping.evidenceNumber < ? AND mapping.goalId = ?
            AND mapping.goalLabel = ?
        )
        WHERE rank = 1
        ORDER BY evidenceNumber DESC, id
      `).all(operatorReason, before, goal.id, goal.label).map((row) => ({
        task: decodeTask(row),
        evidenceNumber: Number(row.evidenceNumber),
      }));
    },

    /** Test exact recorded unavailability independently of paginated history. */
    wasAssignmentUnavailable(id: string): boolean {
      return !!db.prepare(`
        SELECT 1 FROM adaptive_tasks AS task
        WHERE task.id = ?
          AND EXISTS (
            SELECT 1 FROM adaptive_events AS event
            WHERE event.revision = task.revision AND event.taskId = task.id
              AND event.event = 'assignment_unavailable'
          )
          AND NOT EXISTS (
            SELECT 1 FROM adaptive_events AS event
            WHERE event.revision = task.revision AND event.taskId = task.id
              AND event.event = 'cancelled'
          )
      `).get(taskId(id));
    },

    activeRevision,
    priorAssignedTargetCitationCandidates,

    readPriorAssignedTargetCitation(
      citation: AdaptivePriorAssignedTargetCitation,
      beforeEvidenceRevision: number,
      goal: AdaptiveEvidenceRevision["goal"],
    ) {
      if (
        !Number.isSafeInteger(beforeEvidenceRevision) ||
        !Number.isSafeInteger(citation.stepIndex) || citation.stepIndex < 0 ||
        citation.stepIndex >= 16
      ) return;
      return priorAssignedTargetCitationFromSource(
        citation.sourceTaskId,
        citation.evidenceRevision,
        citation.targetId,
        beforeEvidenceRevision,
        goal,
        citation.stepIndex,
      );
    },
    taskQueueWatermark,

    verificationReviewSources(
      revision: string,
    ): AdaptiveVerificationReviewSource[] {
      return db.prepare(`
        SELECT targetId, sourceId, evidenceId FROM adaptive_verification_sources
        WHERE revision = ? ORDER BY targetId, sourceId
      `).all(revisionKey(revision)).map((
        { targetId, sourceId, evidenceId },
      ) => ({
        targetId: String(targetId),
        sourceId: String(sourceId),
        evidenceId: String(evidenceId),
      }));
    },

    plannerObservations(revision: string) {
      const hasTrace = db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_note_steps'",
      ).get();
      const evidenceRevision = hasTrace
        ? recordedEvidenceNumber(revision)
        : NaN;
      return db.prepare(`WITH saved AS (
        SELECT t.id, t.kind, t.nodeId, t.evidenceIds, t.observation, note.note AS reviewSummary,
          json_extract(t.plannerRound, '$.priorAssignedTargetCitations') AS priorAssignedTargetCitations,
          ${hasTrace ? "trace.steps AS reviewSteps," : ""}
          ROW_NUMBER() OVER (ORDER BY (SELECT MAX(a.rowid) FROM adaptive_events a
            WHERE a.revision = t.revision AND a.taskId = t.id
              AND a.event IN ('completed', 'result_reused', 'fact_satisfied')) DESC, t.id) AS position
        FROM adaptive_tasks t
        LEFT JOIN adaptive_model_reviews review ON review.taskId = t.id
        LEFT JOIN adaptive_notes note ON note.rowid = review.noteId
          AND note.taskId = t.id AND note.revision = t.revision
        ${
        hasTrace
          ? "LEFT JOIN adaptive_note_steps trace ON trace.note_id = note.rowid"
          : ""
      }
        WHERE t.revision = ? AND t.status = 'completed'
          AND t.observation IS NOT NULL
      )
      SELECT id, kind, nodeId, evidenceIds, reviewSummary, priorAssignedTargetCitations,
        ${
        hasTrace
          ? `(SELECT json_group_array(json_extract(step.value, '$.assignedTarget'))
          FROM json_each(saved.reviewSteps) step
          WHERE step.type = 'object'
            AND json_extract(step.value, '$.tool') = 'sentinel_assigned_target'
            AND json_extract(step.value, '$.outcome') = 'returned'
            AND json_type(step.value, '$.assignedTarget') = 'object'
        ) AS assignedTargets,
        (SELECT json_group_array(json_extract(step.value, '$.githubWorkflowRead'))
          FROM json_each(saved.reviewSteps) step
          WHERE step.type = 'object'
            AND json_extract(step.value, '$.tool') = 'sentinel_live_workflow_status'
            AND json_extract(step.value, '$.outcome') = 'returned'
            AND json_type(step.value, '$.githubWorkflowRead') = 'object'
        ) AS githubWorkflowReads,`
          : ""
      }
        CASE WHEN position <= 4 AND length(observation) <= 12000
          THEN observation END AS observation,
        substr(json_extract(observation, '$.summary'), 1, 180) AS summary,
        CASE WHEN json_type(observation, '$.relatedNodeIds') = 'array'
          THEN json_extract(observation, '$.relatedNodeIds') END AS relatedNodeIds
      FROM saved ORDER BY position LIMIT ?`).all(revision, MAX_ADAPTIVE_TASKS)
        .map((row) => {
          const githubWorkflowReads = savedGitHubWorkflowReads(
            row.githubWorkflowReads,
            evidenceRevision,
          );
          const modelReviewRelatedNodeIds = row.kind === "review_incident"
            ? []
            : savedAssignedTargetEvidenceIds(row.assignedTargets, row.nodeId);
          const priorAssignedTargetCitations =
            typeof row.priorAssignedTargetCitations === "string"
              ? normalizeAssignedTargetCitations(
                JSON.parse(row.priorAssignedTargetCitations),
              ).filter(({ targetId }) => targetId === row.nodeId)
              : [];
          return {
            taskId: String(row.id),
            kind: String(row.kind),
            nodeId: row.nodeId as string | null,
            evidenceIds: JSON.parse(String(row.evidenceIds)) as string[],
            relatedNodeIds: validatedPlannerObservationNodeIds(
              row.relatedNodeIds,
            ),
            ...(modelReviewRelatedNodeIds.length &&
              { modelReviewRelatedNodeIds }),
            ...(priorAssignedTargetCitations.length &&
              { priorAssignedTargetCitations }),
            ...(githubWorkflowReads.length && { githubWorkflowReads }),
            ...(typeof row.reviewSummary === "string" &&
              { reviewSummary: row.reviewSummary }),
            ...(typeof row.observation === "string"
              ? {
                observation: JSON.parse(row.observation) as Record<
                  string,
                  unknown
                >,
              }
              : {
                observation: undefined,
                summary: typeof row.summary === "string" ? row.summary : null,
              }),
          };
        });
    },

    list(revision = activeRevision()): AdaptiveTask[] {
      return revision === null
        ? []
        : getRevisionTasks.all(revisionKey(revision)).map(decodeTask);
    },

    activeModelReviewTask(revision: string, id: string, token: string) {
      if (activeRevision() !== revision) return undefined;
      const row = db.prepare(`
        SELECT task.* FROM adaptive_tasks AS task
        JOIN adaptive_model_reviews AS review ON review.taskId = task.id
        WHERE task.id = ? AND task.revision = ? AND task.status = 'completed'
          AND review.token = ? AND review.availableAt > ? AND review.noteId IS NULL
          AND NOT EXISTS (SELECT 1 FROM adaptive_worker_controls AS control
            WHERE control.revision = task.revision AND control.taskId = task.id AND control.action = 'stop')
      `).get(taskId(id), revisionKey(revision), token, now());
      return row ? decodeTask(row) : undefined;
    },

    requestModelReviewControl(
      revision: string,
      id: string,
      requestId: string,
      action: "steer" | "stop",
      note?: string,
      allowNew = true,
    ): SentinelWorkerControlReceipt | undefined {
      revision = revisionKey(revision);
      id = taskId(id);
      if (
        typeof requestId !== "string" ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId) ||
        (action !== "steer" && action !== "stop") ||
        (action === "stop" && note !== undefined)
      ) return;
      const instruction = action === "steer"
        ? boundedText(note, "worker steering note", 1000)
        : undefined;
      return transaction(db, () => {
        const getRequest = db.prepare(
          "SELECT * FROM adaptive_worker_controls WHERE requestId = ?",
        );
        const existing = getRequest.get(requestId);
        if (existing) {
          return existing.revision === revision && existing.taskId === id &&
              existing.action === action &&
              existing.note === (instruction ?? null)
            ? decodeWorkerControl(existing)
            : undefined;
        }
        if (
          !allowNew || activeRevision() !== revision || db.prepare(`
          SELECT 1 FROM adaptive_worker_controls
          WHERE revision = ? AND taskId = ? AND action = 'stop'
        `).get(revision, id)
        ) return;
        const time = now();
        const current = db.prepare(`
          SELECT review.attempts FROM adaptive_model_reviews AS review
          JOIN adaptive_tasks AS task ON task.id = review.taskId
          WHERE task.revision = ? AND task.id = ? AND task.status = 'completed'
            AND review.token IS NOT NULL AND review.availableAt > ? AND review.noteId IS NULL
        `).get(revision, id, time);
        if (!current) return;
        if (action === "steer") {
          const count = db.prepare(`
            SELECT count(*) AS count FROM adaptive_worker_controls
            WHERE revision = ? AND taskId = ? AND action = 'steer'
          `).get(revision, id)?.count;
          if (Number(count) >= 8) return;
        }
        db.prepare(`
          INSERT INTO adaptive_worker_controls (requestId, revision, taskId, action, note, requestedAt)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(requestId, revision, id, action, instruction ?? null, time);
        event.run(
          revision,
          id,
          action === "stop"
            ? "model_review_stop_requested"
            : "model_review_steered",
          current.attempts,
          time,
          requestId,
        );
        return decodeWorkerControl(getRequest.get(requestId)!);
      });
    },

    modelReviewControls(revision: string, id: string) {
      const rows = db.prepare(`
        SELECT * FROM adaptive_worker_controls WHERE revision = ? AND taskId = ? ORDER BY id
      `).all(revisionKey(revision), taskId(id));
      return {
        stopped: rows.some(({ action }) => action === "stop"),
        steering: rows.filter(({ action }) => action === "steer").map((
          row,
        ) => ({
          ...decodeWorkerControl(row),
          ...(typeof row.appliedAt === "number" &&
            { appliedAt: new Date(row.appliedAt).toISOString() }),
        })),
      };
    },

    markModelReviewSteeringApplied(
      revision: string,
      id: string,
      token: string,
      steeringId: number,
    ): boolean {
      if (!Number.isSafeInteger(steeringId) || steeringId < 1) return false;
      return transaction(db, () => {
        if (!this.activeModelReviewTask(revision, id, token)) return false;
        const changed = db.prepare(`
          UPDATE adaptive_worker_controls SET appliedAt = COALESCE(appliedAt, ?)
          WHERE id = ? AND revision = ? AND taskId = ? AND action = 'steer'
        `).run(now(), steeringId, revision, id);
        return Number(changed.changes) === 1;
      });
    },

    recordModelMutationBoundary(
      revision: string,
      id: string,
      token: string,
      evidenceRevision: number,
      tools: readonly string[] | null,
      publicationIteration?: number,
      journalRequests?:
        readonly ({ requestId: string; argsDigest: string } | null)[],
    ): boolean {
      revision = revisionKey(revision);
      id = taskId(id);
      if (
        tools && (!tools.length || tools.length > 16 ||
          tools.some((name) => !/^sentinel_[a-z_]{1,80}$/.test(name)))
      ) return false;
      return transaction(db, () => {
        if (
          !validWorkflowResultLease(revision, id, token, evidenceRevision) ||
          mutationPending(revision, id) !== (tools === null)
        ) return false;
        event.run(
          revision,
          id,
          tools ? "model_mutation_pending" : "model_mutation_settled",
          0,
          now(),
          tools
            ? JSON.stringify(
              publicationIteration === undefined ? tools : {
                tools,
                publicationIteration,
                ...(journalRequests && { journalRequests }),
              },
            )
            : null,
        );
        return true;
      });
    },

    modelReviewProgress(revision: string, id: string): SentinelReviewStep[] {
      const row = db.prepare(
        "SELECT steps FROM adaptive_worker_progress WHERE revision = ? AND taskId = ?",
      )
        .get(revisionKey(revision), taskId(id));
      return typeof row?.steps === "string"
        ? JSON.parse(row.steps) as SentinelReviewStep[]
        : [];
    },

    recordModelReviewProgress(
      revision: string,
      id: string,
      token: string,
      steps: readonly SentinelReviewStep[],
    ): boolean {
      revision = revisionKey(revision);
      id = taskId(id);
      return transaction(db, () => {
        if (
          activeRevision() !== revision || !db.prepare(`
          SELECT 1 FROM adaptive_model_reviews AS review
          JOIN adaptive_tasks AS task ON task.id = review.taskId
          WHERE task.revision = ? AND task.id = ? AND review.token = ?
            AND review.availableAt > ? AND review.noteId IS NULL
        `).get(revision, id, token, now())
        ) return false;
        const evidenceRevision = recordedEvidenceNumber(revision);
        const retained = steps.slice(0, 16).map((step) =>
          normalizeSentinelWorkflowReviewStep(step, evidenceRevision)
        );
        const saved = this.modelReviewProgress(revision, id);
        if (
          saved.some((step, index) => !isDeepStrictEqual(step, retained[index]))
        ) return false;
        const encoded = JSON.stringify(retained);
        if (new TextEncoder().encode(encoded).length > 128 * 1024) return false;
        db.prepare(`
          INSERT INTO adaptive_worker_progress VALUES (?, ?, ?)
          ON CONFLICT(taskId) DO UPDATE SET steps = excluded.steps
        `).run(id, revision, encoded);
        return true;
      });
    },

    /** Replay a normalized network result only under the exact current review lease. */
    readLeasedGitHubWorkflowResult(
      revision: string,
      id: string,
      token: string,
      evidenceRevision: number,
    ): SentinelGitHubWorkflowReadReceipt | undefined {
      revision = revisionKey(revision);
      id = taskId(id);
      if (!hasGitHubWorkflowResultTable()) return;
      return transaction(
        db,
        () =>
          validWorkflowResultLease(revision, id, token, evidenceRevision)
            ? readWorkflowResult(revision, id, evidenceRevision)
            : undefined,
      );
    },

    commitLeasedWorkflowObservation(
      revision: string,
      id: string,
      token: string,
      evidenceRevision: number,
      stepIndex: number,
    ): AdaptiveWorkflowObservation | undefined {
      revision = revisionKey(revision);
      id = taskId(id);
      if (
        !Number.isSafeInteger(stepIndex) || stepIndex < 0 || stepIndex >= 16
      ) return;
      return transaction(db, () => {
        if (
          !validWorkflowResultLease(revision, id, token, evidenceRevision) ||
          !hasGitHubWorkflowResultTable()
        ) return;
        const producer = lookup.get(id);
        const targetId = producer?.nodeId;
        const receipt = readWorkflowResult(revision, id, evidenceRevision);
        if (!producer || typeof targetId !== "string" || !receipt) return;
        const observationId = `workflow-observation:${
          createHash("sha256").update(JSON.stringify([
            revision,
            id,
            targetId,
            evidenceRevision,
            stepIndex,
            receipt,
          ])).digest("hex")
        }`;
        db.exec(`CREATE TABLE IF NOT EXISTS adaptive_workflow_observations (
          id TEXT PRIMARY KEY,
          revision TEXT NOT NULL,
          taskId TEXT NOT NULL REFERENCES adaptive_tasks(id),
          targetId TEXT NOT NULL,
          evidenceRevision INTEGER NOT NULL,
          stepIndex INTEGER NOT NULL,
          receipt TEXT NOT NULL,
          UNIQUE (revision, taskId, evidenceRevision)
        );
        CREATE INDEX IF NOT EXISTS adaptive_workflow_observations_by_scope
          ON adaptive_workflow_observations(revision, targetId, evidenceRevision);`);
        const inserted = db.prepare(`
          INSERT OR IGNORE INTO adaptive_workflow_observations
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          observationId,
          revision,
          id,
          targetId,
          evidenceRevision,
          stepIndex,
          JSON.stringify(receipt),
        );
        if (inserted.changes) {
          event.run(
            revision,
            id,
            "workflow_observation_committed",
            producer.attempts,
            now(),
            observationId,
          );
        }
        const saved = db.prepare(`
          SELECT * FROM adaptive_workflow_observations WHERE id = ? AND revision = ? AND taskId = ?
        `).get(observationId, revision, id);
        return saved ? decodeWorkflowObservation(saved) : undefined;
      });
    },

    listLeasedWorkflowObservations(
      revision: string,
      id: string,
      token: string,
      evidenceRevision: number,
      offset = 0,
      limit = 10,
    ): AdaptiveWorkflowObservation[] {
      revision = revisionKey(revision);
      id = taskId(id);
      if (
        !validWorkflowObservationPage(offset, limit) ||
        !hasWorkflowObservationTable()
      ) return [];
      return transaction(db, () => {
        if (!validWorkflowResultLease(revision, id, token, evidenceRevision)) {
          return [];
        }
        const targetId = lookup.get(id)?.nodeId;
        if (typeof targetId !== "string") return [];
        return db.prepare(`
          SELECT * FROM adaptive_workflow_observations
          WHERE revision = ? AND targetId = ? AND evidenceRevision = ? AND taskId != ?
          ORDER BY rowid LIMIT ? OFFSET ?
        `).all(revision, targetId, evidenceRevision, id, limit, offset).map(
          decodeWorkflowObservation,
        );
      });
    },

    readLeasedWorkflowObservation(
      revision: string,
      id: string,
      token: string,
      evidenceRevision: number,
      receiptId: string,
    ): AdaptiveWorkflowObservation | undefined {
      revision = revisionKey(revision);
      id = taskId(id);
      if (
        !/^workflow-observation:[a-f0-9]{64}$/.test(receiptId) ||
        !hasWorkflowObservationTable()
      ) return;
      return transaction(db, () => {
        if (!validWorkflowResultLease(revision, id, token, evidenceRevision)) {
          return;
        }
        const targetId = lookup.get(id)?.nodeId;
        if (typeof targetId !== "string") return;
        const row = db.prepare(`
          SELECT * FROM adaptive_workflow_observations
          WHERE id = ? AND revision = ? AND targetId = ? AND evidenceRevision = ? AND taskId != ?
        `).get(receiptId, revision, targetId, evidenceRevision, id);
        return row ? decodeWorkflowObservation(row) : undefined;
      });
    },

    /** Trusted, revision-pinned projection for provenance and historical export. */
    workflowObservations(
      revision: string,
      offset = 0,
      limit = 30,
    ): AdaptiveWorkflowObservation[] {
      revision = revisionKey(revision);
      if (
        !validWorkflowObservationPage(offset, limit) ||
        !hasWorkflowObservationTable()
      ) return [];
      return db.prepare(`
        SELECT * FROM adaptive_workflow_observations
        WHERE revision = ? ORDER BY rowid LIMIT ? OFFSET ?
      `).all(revision, limit, offset).map(decodeWorkflowObservation);
    },

    workflowObservationById(
      revision: string,
      receiptId: string,
    ): AdaptiveWorkflowObservation | undefined {
      revision = revisionKey(revision);
      if (
        !/^workflow-observation:[a-f0-9]{64}$/.test(receiptId) ||
        !hasWorkflowObservationTable()
      ) return;
      const row = db.prepare(`
        SELECT * FROM adaptive_workflow_observations WHERE revision = ? AND id = ?
      `).get(revision, receiptId);
      return row ? decodeWorkflowObservation(row) : undefined;
    },

    readLeasedWorkerCheckpoint(
      revision: string,
      id: string,
      token: string,
      evidenceRevision: number,
      promptSha256: string,
      lookupMutation?: SentinelJournalMutationLookup,
    ): AgentTurnCheckpoint | undefined {
      revision = revisionKey(revision);
      id = taskId(id);
      if (!/^[a-f0-9]{64}$/.test(promptSha256) || !hasWorkerCheckpointTable()) {
        return;
      }
      return transaction(db, () => {
        if (!validWorkflowResultLease(revision, id, token, evidenceRevision)) {
          return;
        }
        const saved = db.prepare(`
          SELECT checkpoint FROM adaptive_worker_checkpoints
          WHERE revision = ? AND taskId = ? AND evidenceRevision = ?
            AND promptSha256 = ? AND expiresAt > ? AND version = 1
        `).get(revision, id, evidenceRevision, promptSha256, now());
        const nodeId = lookup.get(id)?.nodeId;
        const receipt = hasGitHubWorkflowResultTable()
          ? readWorkflowResult(revision, id, evidenceRevision)
          : undefined;
        if (
          typeof nodeId !== "string" ||
          typeof saved?.checkpoint !== "string"
        ) return;
        return normalizeWorkerCheckpoint(
          JSON.parse(saved.checkpoint),
          promptSha256,
          nodeId,
          receipt,
          this.modelReviewProgress(revision, id),
          assignmentPublication(revision, id, evidenceRevision),
          this.modelReviewControls(revision, id).steering,
          lookupMutation &&
            ((tool, requestId) => lookupMutation(id, nodeId, tool, requestId)),
        );
      });
    },

    recordLeasedWorkerCheckpoint(
      revision: string,
      id: string,
      token: string,
      evidenceRevision: number,
      promptSha256: string,
      checkpoint: AgentTurnCheckpoint,
      lookupMutation?: SentinelJournalMutationLookup,
    ): boolean {
      revision = revisionKey(revision);
      id = taskId(id);
      if (
        !/^[a-f0-9]{64}$/.test(promptSha256)
      ) return false;
      return transaction(db, () => {
        if (!validWorkflowResultLease(revision, id, token, evidenceRevision)) {
          return false;
        }
        const nodeId = lookup.get(id)?.nodeId;
        const receipt = hasGitHubWorkflowResultTable()
          ? readWorkflowResult(revision, id, evidenceRevision)
          : undefined;
        if (typeof nodeId !== "string") return false;
        const normalized = normalizeWorkerCheckpoint(
          checkpoint,
          promptSha256,
          nodeId,
          receipt,
          this.modelReviewProgress(revision, id),
          assignmentPublication(revision, id, evidenceRevision),
          this.modelReviewControls(revision, id).steering,
          lookupMutation &&
            ((tool, requestId) => lookupMutation(id, nodeId, tool, requestId)),
        );
        if (!normalized) return false;
        const encoded = JSON.stringify(normalized);
        if (
          new TextEncoder().encode(encoded).length > MAX_WORKER_CHECKPOINT_BYTES
        ) return false;
        db.exec(`CREATE TABLE IF NOT EXISTS adaptive_worker_checkpoints (
          revision TEXT NOT NULL,
          taskId TEXT NOT NULL REFERENCES adaptive_tasks(id),
          evidenceRevision INTEGER NOT NULL,
          promptSha256 TEXT NOT NULL,
          expiresAt INTEGER NOT NULL,
          version INTEGER NOT NULL,
          checkpoint TEXT NOT NULL,
          PRIMARY KEY(revision, taskId, evidenceRevision)
        )`);
        const time = now();
        db.prepare(
          "DELETE FROM adaptive_worker_checkpoints WHERE expiresAt <= ?",
        ).run(time);
        db.prepare(`
          INSERT INTO adaptive_worker_checkpoints VALUES (?, ?, ?, ?, ?, 1, ?)
          ON CONFLICT(revision, taskId, evidenceRevision) DO UPDATE
          SET promptSha256 = excluded.promptSha256, expiresAt = excluded.expiresAt,
            version = excluded.version, checkpoint = excluded.checkpoint
        `).run(
          revision,
          id,
          evidenceRevision,
          promptSha256,
          time + WORKER_CHECKPOINT_TTL_MS,
          encoded,
        );
        return true;
      });
    },

    /** Stage the first canonical result before making it visible to a worker. */
    recordLeasedGitHubWorkflowResult(
      revision: string,
      id: string,
      token: string,
      evidenceRevision: number,
      value: SentinelGitHubWorkflowReadReceipt,
    ): SentinelGitHubWorkflowReadReceipt | undefined {
      revision = revisionKey(revision);
      id = taskId(id);
      const receipt = readSentinelGitHubWorkflowReadReceipt(
        value,
        evidenceRevision,
      );
      if (!receipt) return;
      return transaction(db, () => {
        if (!validWorkflowResultLease(revision, id, token, evidenceRevision)) {
          return;
        }
        db.exec(`CREATE TABLE IF NOT EXISTS adaptive_live_workflow_results (
          revision TEXT NOT NULL,
          taskId TEXT NOT NULL REFERENCES adaptive_tasks(id),
          evidenceRevision INTEGER NOT NULL,
          receipt TEXT NOT NULL,
          PRIMARY KEY(revision, taskId, evidenceRevision)
        )`);
        db.prepare(
          "INSERT OR IGNORE INTO adaptive_live_workflow_results VALUES (?, ?, ?, ?)",
        )
          .run(revision, id, evidenceRevision, JSON.stringify(receipt));
        return readWorkflowResult(revision, id, evidenceRevision);
      });
    },

    readOperatorAssignmentIntent,

    /** Bind exact operator intent and its queue effect in a single transaction. */
    recordOperatorAssignmentIntent(
      input: AdaptiveOperatorAssignmentIntentInput,
    ): AdaptiveOperatorAssignmentIntentReceipt | undefined {
      const requestId = operatorAssignmentRequestId(input.requestId);
      if (
        !requestId || !Number.isSafeInteger(input.evidenceRevision) ||
        input.evidenceRevision < 1
      ) return undefined;
      const adaptiveRevision = revisionKey(input.adaptiveRevision);
      const runId = boundedText(input.runId, "operator assignment run", 128);
      const reason = boundedText(input.reason, "assignment reason", 300);
      const task = normalizeTask(adaptiveRevision, { ...input.task, reason });
      return transaction(db, () => {
        const prior = readOperatorAssignmentIntent(requestId);
        if (prior) {
          return prior.runId === runId &&
              prior.evidenceRevision === input.evidenceRevision &&
              prior.adaptiveRevision === adaptiveRevision &&
              prior.taskId === task.id
            ? prior
            : undefined;
        }
        const mapping = this.forEvidence(input.evidenceRevision);
        if (
          activeRevision() !== adaptiveRevision ||
          mapping?.revision !== adaptiveRevision || mapping.goal.id !== runId
        ) {
          return undefined;
        }
        const existing = lookup.get(task.id);
        if (existing && existing.revision !== adaptiveRevision) {
          return undefined;
        }

        const time = now();
        let disposition:
          AdaptiveOperatorAssignmentIntentReceipt["disposition"] = "existing";
        if (input.takeOverQueued) {
          if (
            existing?.status !== "queued" ||
            !adoptQueuedAssignment(adaptiveRevision, task.id, reason, time)
          ) return undefined;
          if (existing.reason !== reason) disposition = "adopted";
        } else if (!existing) {
          const count = db.prepare(
            "SELECT COUNT(*) AS count FROM adaptive_tasks WHERE revision = ?",
          ).get(adaptiveRevision)?.count;
          if (Number(count) >= MAX_ADAPTIVE_TASKS) return undefined;
          if (
            !enqueue(adaptiveRevision, task, time, {
              number: input.evidenceRevision,
              goal: mapping.goal,
            })
          ) return undefined;
          insertNote(
            adaptiveRevision,
            task.id,
            "Operator assigned this investigation.",
            [],
            time,
          );
          disposition = "enqueued";
        }

        const receipt: AdaptiveOperatorAssignmentIntentReceipt = {
          requestId,
          runId,
          evidenceRevision: input.evidenceRevision,
          adaptiveRevision,
          taskId: task.id,
          kind: task.kind,
          ...(task.nodeId !== undefined && { nodeId: task.nodeId }),
          ...(task.depth !== undefined && { depth: task.depth }),
          ...(task.plannerRound?.graphRelationship && {
            graphRelationship: task.plannerRound.graphRelationship,
          }),
          disposition,
          recordedAt: new Date(time).toISOString(),
        };
        db.exec(
          `CREATE TABLE IF NOT EXISTS adaptive_operator_assignment_intents (
          requestId TEXT PRIMARY KEY,
          receipt TEXT NOT NULL
        ) STRICT`,
        );
        db.prepare(
          "INSERT INTO adaptive_operator_assignment_intents VALUES (?, ?)",
        )
          .run(requestId, JSON.stringify(receipt));
        return receipt;
      });
    },

    assignQueuedTask(revision: string, id: string, reason: string): boolean {
      revision = revisionKey(revision);
      id = taskId(id);
      reason = boundedText(reason, "assignment reason", 300);
      return transaction(
        db,
        () => adoptQueuedAssignment(revision, id, reason, now()),
      );
    },

    claim(
      revision: string,
      leaseSeconds = 60,
      excludedTaskIds: ReadonlySet<string> = new Set(),
    ): { task: AdaptiveTask; leaseToken: string } | null {
      revision = revisionKey(revision);
      if (
        !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 ||
        leaseSeconds > 3600
      ) {
        throw new Error(
          "Sentinel adaptive lease duration must be 1–3600 seconds",
        );
      }
      return transaction(db, () => {
        if (activeRevision() !== revision) return null;
        const time = now();
        recover(revision, time);
        const next = nextClaimableTask(revision, excludedTaskIds);
        if (!next) return null;
        const leaseToken = randomUUID();
        db.prepare(`
          UPDATE adaptive_tasks
          SET status = 'running', attempts = attempts + 1, leaseToken = ?, leaseExpiresAt = ?
          WHERE id = ?
        `).run(leaseToken, time + leaseSeconds * 1000, next.id);
        event.run(
          revision,
          next.id,
          "claimed",
          Number(next.attempts) + 1,
          time,
          null,
        );
        return { task: decodeTask(lookup.get(next.id)!), leaseToken };
      });
    },

    peekNextClaimable(
      revision: string,
      excludedTaskIds: ReadonlySet<string> = new Set(),
    ): AdaptiveTask | undefined {
      revision = revisionKey(revision);
      return transaction(db, () => {
        if (activeRevision() !== revision) return;
        recover(revision, now());
        const next = nextClaimableTask(revision, excludedTaskIds);
        return next ? decodeTask(next) : undefined;
      });
    },

    /** Complete receipt-only work using its verified relationship fact. */
    satisfyQueuedRelationshipFact(
      revision: string,
      id: string,
      fact: SentinelWorkerGraphFact,
      excludedTaskIds: ReadonlySet<string>,
    ): boolean {
      revision = revisionKey(revision);
      id = taskId(id);
      return transaction(db, () => {
        const mapping = this.forEvidence(fact.evidenceRevision);
        if (
          activeRevision() !== revision || mapping?.revision !== revision ||
          mapping.goal.id !== fact.runId
        ) return false;
        const time = now();
        recover(revision, time);
        const row = nextClaimableTask(revision, excludedTaskIds);
        if (!row || row.id !== id || row.attempts !== 0) return false;
        const task = decodeTask(row);
        const round = task.plannerRound;
        const source = lookup.get(fact.taskId);
        if (
          task.kind !== "trace" || task.depth !== 1 ||
          task.nodeId !== fact.targetId || round?.graphFactOnly !== true ||
          (round.graphRelationship
            ? !isDeepStrictEqual(round.graphRelationship, fact.relationship)
            : round.graphFactId !== fact.id ||
              !task.prerequisites.includes(fact.taskId)) ||
          source?.revision !== revision || source.status !== "completed" ||
          source.nodeId !== task.nodeId ||
          task.evidenceIds.length || taskWorkerSources(task).length ||
          round.githubWorkflowCitation || round.peerFindingCitations?.length ||
          round.priorAssignedTargetCitations?.length ||
          round.carriedAssignedTargetCitations?.length ||
          round.upstreamCheckId || round.upstreamCitations?.length
        ) return false;
        const observation = JSON.stringify({
          relationship: fact.relationship,
          graphFactId: fact.id,
        });
        const budget = db.prepare(`
          SELECT COALESCE(SUM(length(CAST(observation AS BLOB))), 0) AS bytes
          FROM adaptive_tasks WHERE revision = ?
        `).get(revision);
        if (
          Number(budget?.bytes) + new TextEncoder().encode(observation).length >
            MAX_REVISION_OBSERVATION_BYTES
        ) return false;
        const binding: AdaptiveFactSatisfaction = {
          sourceTaskId: fact.taskId,
          sourceObservationSha256: fact.resultSha256,
          graphFactId: fact.id,
        };
        db.prepare(`
          UPDATE adaptive_tasks SET status = 'completed', observation = ?, factSatisfaction = ?
          WHERE id = ?
        `).run(observation, JSON.stringify(binding), id);
        event.run(
          revision,
          id,
          "fact_satisfied",
          0,
          time,
          `Verified the exact relationship receipt ${fact.id} in evidence revision ${fact.evidenceRevision}.`,
        );
        return true;
      });
    },

    /** Atomically reuse an equivalent, committed observation without a worker lease. */
    satisfyQueuedTaskFromFact(
      revision: string,
      request: AdaptiveFactSatisfaction & { readonly taskId: string },
      excludedTaskIds: ReadonlySet<string> = new Set(),
    ): boolean {
      revision = revisionKey(revision);
      const id = taskId(request.taskId);
      const sourceTaskId = taskId(request.sourceTaskId);
      const digest = request.sourceObservationSha256;
      if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
        return false;
      }
      return transaction(db, () => {
        if (activeRevision() !== revision) return false;
        const time = now();
        recover(revision, time);
        const target = nextClaimableTask(revision, excludedTaskIds);
        const source = lookup.get(sourceTaskId);
        if (
          target?.id !== id || target.attempts !== 0 ||
          typeof target.nodeId !== "string" ||
          source?.revision !== revision || source.status !== "completed" ||
          source.nodeId !== target.nodeId ||
          !(
            target.kind === "trace" && source.kind === "review_evidence" ||
            source.kind === "trace" && target.kind === "review_evidence"
          ) ||
          (target.depth ?? 1) !== 1 || (source.depth ?? 1) !== 1 ||
          typeof source.observation !== "string" ||
          createHash("sha256").update(source.observation).digest("hex") !==
            digest
        ) return false;
        const assignment = decodeTask(target);
        const witnesses = taskWorkerSources(assignment);
        const round = assignment.plannerRound;
        if (
          witnesses.some(({ kind }) => kind !== "worker_result") ||
          (witnesses.length &&
            !witnesses.some(({ taskId }) => taskId === sourceTaskId)) ||
          round?.peerFindingCitations?.length ||
          round?.priorAssignedTargetCitations?.length ||
          round?.carriedAssignedTargetCitations?.length ||
          round?.upstreamCheckId ||
          round?.upstreamCitations?.length ||
          (round?.githubWorkflowCitation || round?.graphFactId)
        ) return false;
        const saved = JSON.parse(source.observation);
        const trace = saved?.trace;
        if (
          !Array.isArray(trace?.nodes) || !Array.isArray(trace.edges) ||
          trace.nodes[0]?.id !== target.nodeId ||
          trace.nodes[0]?.kind !== "evidence" ||
          trace.nodes[0]?.distance !== 0 ||
          !Array.isArray(saved.relatedNodeIds) ||
          !saved.relatedNodeIds.includes(target.nodeId) ||
          assignment.evidenceIds.some((id) =>
            !saved.relatedNodeIds.includes(id) ||
            !trace.nodes.some((node: { id?: unknown; kind?: unknown } | null) =>
              node?.id === id && node.kind === "evidence"
            )
          ) ||
          !Number.isSafeInteger(trace.nodeCount) ||
          trace.nodeCount < trace.nodes.length ||
          !Number.isSafeInteger(trace.edgeCount) ||
          trace.edgeCount < trace.edges.length ||
          typeof trace.truncated !== "boolean"
        ) return false;
        const budget = db.prepare(`
          SELECT COALESCE(SUM(length(CAST(observation AS BLOB))), 0) AS bytes
          FROM adaptive_tasks WHERE revision = ?
        `).get(revision);
        const bytes = new TextEncoder().encode(source.observation).length;
        if (Number(budget?.bytes) + bytes > MAX_REVISION_OBSERVATION_BYTES) {
          return false;
        }
        const receipt = { sourceTaskId, sourceObservationSha256: digest };
        db.prepare(`
          UPDATE adaptive_tasks SET status = 'completed', observation = ?, factSatisfaction = ?
          WHERE id = ?
        `).run(source.observation, JSON.stringify(receipt), id);
        event.run(
          revision,
          id,
          "fact_satisfied",
          0,
          time,
          `The exact evidence node and depth-one trace match the committed observation from task ${sourceTaskId} in this revision.`,
        );
        return true;
      });
    },

    interrupt(request: LeaseRequest, evidenceChanged: boolean): boolean {
      const id = taskId(request.taskId);
      return transaction(db, () => {
        const row = lookup.get(id);
        if (
          !row || row.status !== "running" ||
          row.leaseToken !== request.leaseToken ||
          row.revision !== activeRevision()
        ) return false;
        updateStatus.run("queued", id);
        event.run(
          row.revision,
          id,
          "interrupted",
          row.attempts,
          now(),
          evidenceChanged
            ? "Evidence changed before the worker could save its result."
            : "The case was paused or stopped before the result was saved.",
        );
        return true;
      });
    },

    complete(
      request: LeaseRequest & {
        readonly observation: unknown;
        readonly note?: string;
      },
    ): AdaptiveTask {
      const observation = observationJson(request.observation);
      const note = optionalText(request.note, "completion note", 2000);
      return transaction(db, () => {
        const time = now();
        const row = assertLease(request, time);
        const stored = db.prepare(
          "SELECT COALESCE(SUM(length(CAST(observation AS BLOB))), 0) AS bytes FROM adaptive_tasks WHERE revision = ?",
        ).get(row.revision);
        if (
          Number(stored?.bytes) + observation.bytes >
            MAX_REVISION_OBSERVATION_BYTES
        ) {
          throw new Error(
            "Sentinel adaptive revision observation budget exhausted",
          );
        }
        updateStatus.run("completed", row.id);
        db.prepare("UPDATE adaptive_tasks SET observation = ? WHERE id = ?")
          .run(observation.encoded, row.id);
        event.run(
          row.revision,
          row.id,
          "completed",
          row.attempts,
          time,
          note ?? null,
        );
        return decodeTask(lookup.get(row.id)!);
      });
    },

    fail(
      request: LeaseRequest & {
        readonly note: string;
        readonly retry?: boolean;
      },
    ): AdaptiveTask {
      const note = boundedText(request.note, "failure note", 2000);
      return transaction(db, () => {
        const time = now();
        const row = assertLease(request, time);
        const status =
          request.retry && Number(row.attempts) < MAX_ADAPTIVE_TASK_ATTEMPTS
            ? "queued"
            : "failed";
        updateStatus.run(status, row.id);
        event.run(
          row.revision,
          row.id,
          status === "queued" ? "retry_queued" : "failed",
          row.attempts,
          time,
          note,
        );
        return decodeTask(lookup.get(row.id)!);
      });
    },

    cancelQueued(revision: string, target: string): boolean {
      revision = revisionKey(revision);
      const id = taskId(target);
      return transaction(db, () => {
        if (activeRevision() !== revision) return false;
        const row = lookup.get(id);
        if (row?.revision !== revision || row.status !== "queued") return false;
        const affected = db.prepare(`
          WITH RECURSIVE downstream(id) AS (
            SELECT ?
            UNION
            SELECT dependency.taskId FROM adaptive_dependencies AS dependency
            JOIN downstream ON downstream.id = dependency.dependencyId
          )
          SELECT task.id, task.attempts, task.dependencyRecommendation FROM adaptive_tasks AS task
          JOIN downstream ON downstream.id = task.id
          WHERE task.revision = ? AND task.status = 'queued'
          ORDER BY task.rowid
        `).all(id, revision);
        const time = now();
        for (const task of affected) {
          if (task.dependencyRecommendation) {
            dismissDependencyGroup(
              revision,
              String(task.id),
              "An investigation in the proposal was cancelled.",
            );
          }
          updateStatus.run("superseded", task.id);
          event.run(
            revision,
            task.id,
            "cancelled",
            task.attempts,
            time,
            task.id === id
              ? "Operator cancelled this investigation."
              : "A prerequisite was cancelled.",
          );
        }
        return true;
      });
    },

    refreshPlannerPriorities(revision: string, ids: readonly string[]) {
      revision = revisionKey(revision);
      const ordered = [...new Set(ids.map(taskId))];
      return transaction(db, () => {
        if (activeRevision() !== revision) return 0;
        return setPlannerPriorities(revision, ordered);
      });
    },

    applyModelPlan(
      revision: string,
      expectedHintId: number | null,
      requests: readonly AdaptiveTaskRequest[],
      queue: PlannerQueueChanges,
    ): number | null {
      revision = revisionKey(revision);
      if (requests.length > 8) {
        throw new Error("Too many Sentinel model assignments");
      }
      const tasks = requests.map((request) => normalizeTask(revision, request));
      const priorities = queue.priorities &&
        [...new Set(queue.priorities.map(taskId))];
      const retirements = queue.retirements &&
        new Map(queue.retirements.map(({ id, reason }) => [
          taskId(id),
          boundedText(reason, "retirement reason", 300),
        ]));
      return transaction(db, () => {
        if (
          activeRevision() !== revision || latestHintId() !== expectedHintId
        ) return null;
        const existing = readTaskMap(revision);
        const additions = new Map<string, typeof tasks[number]>();
        for (const task of tasks) {
          if (!existing.has(task.id) && !additions.has(task.id)) {
            additions.set(task.id, task);
          }
        }
        if (existing.size + additions.size > MAX_ADAPTIVE_TASKS) return null;
        const prerequisites = new Set(
          [...additions.values()].flatMap((task) => task.prerequisites),
        );
        const required = tasks.filter(({ id }) =>
          existing.has(id) && prerequisites.has(id)
        );
        if (!citationUpdates(existing, required, true)) return null;
        const time = now();
        for (const task of additions.values()) enqueue(revision, task, time);
        const citations = citationUpdates(
          readTaskMap(revision),
          tasks,
          false,
        );
        writeCitationUpdates(revision, citations ?? [], time);
        if (priorities) setPlannerPriorities(revision, priorities);
        if (retirements) setRetirementRecommendations(revision, retirements);
        if (additions.size) {
          insertNote(
            revision,
            null,
            `Planner added ${additions.size} validated investigation task(s).`,
            [],
            time,
          );
        }
        return additions.size + (citations?.length ?? 0);
      });
    },

    recommendDependencyChanges(
      revision: string,
      requests: readonly DependencyChange[],
      additions: readonly AdaptiveTaskRequest[] = [],
      queueChanges: PlannerQueueChanges = {},
      expectedHintId?: number | null,
      planningIdentity?: string,
      citations: readonly AdaptiveTaskRequest[] = [],
    ) {
      revision = revisionKey(revision);
      if (planningIdentity !== undefined) {
        planningIdentity = revisionKey(planningIdentity);
      }
      if (
        !requests.length || requests.length > 4 ||
        additions.length + citations.length > 8
      ) return false;
      const changes = new Map(requests.map((change) => {
        const id = taskId(change.id);
        return [id, {
          id,
          prerequisites: uniqueValues(
            change.prerequisites,
            "prerequisite",
            4,
            taskId,
          ),
          reason: boundedText(change.reason, "dependency rationale", 300),
        }];
      }));
      if (changes.size !== requests.length) return false;
      return transaction(db, () => {
        if (activeRevision() !== revision) return false;
        if (expectedHintId !== undefined && latestHintId() !== expectedHintId) {
          return false;
        }
        const tasks = readTaskMap(revision);
        const citationRequests = citations.map((request) =>
          normalizeTask(revision, request)
        );
        const updates = citationUpdates(tasks, citationRequests, true);
        if (!updates) return false;
        for (const task of updates) tasks.set(task.id, task);
        const proposedTasks = includeProposedTasks(tasks, revision, additions);
        if (!proposedTasks || !canChangeDependencies(tasks, changes)) {
          return false;
        }
        const targets = optionalQueueChangeTargets(
          tasks,
          changes,
          queueChanges,
        );
        if (!targets) return false;
        const id = randomUUID();
        const update = db.prepare(
          "UPDATE adaptive_tasks SET dependencyRecommendation = ? WHERE id = ?",
        );
        for (const change of changes.values()) {
          update.run(
            JSON.stringify({
              id,
              prerequisites: change.prerequisites,
              reason: change.reason,
              size: changes.size,
              planningIdentity,
              queueChanges,
              ...(citationRequests.length && { citations: citationRequests }),
              ...(proposedTasks.length && { additions: proposedTasks }),
            }),
            change.id,
          );
          event.run(
            revision,
            change.id,
            "dependency_change_recommended",
            tasks.get(change.id)!.attempts,
            now(),
            change.reason,
          );
        }
        for (const [target, reason] of targets) {
          update.run(
            JSON.stringify({
              id,
              reason,
              prerequisites: [],
              queueOnly: true,
              planningIdentity,
            }),
            target,
          );
          event.run(
            revision,
            target,
            "queue_change_recommended",
            tasks.get(target)!.attempts,
            now(),
            reason,
          );
        }
        return true;
      });
    },

    supersedeStaleDependencyChanges(
      revision: string,
      planningIdentity: string,
      hasDecisions: boolean,
    ) {
      revision = revisionKey(revision);
      planningIdentity = revisionKey(planningIdentity);
      return transaction(db, () => {
        if (activeRevision() !== revision) return;
        const stale = db.prepare(`
          SELECT id, attempts FROM adaptive_tasks
          WHERE revision = ? AND status = 'queued' AND dependencyRecommendation IS NOT NULL
          AND COALESCE(json_extract(dependencyRecommendation, '$.planningIdentity') != ?, ?)
        `).all(revision, planningIdentity, Number(hasDecisions));
        const clear = db.prepare(
          "UPDATE adaptive_tasks SET dependencyRecommendation = NULL WHERE id = ?",
        );
        for (const task of stale) {
          clear.run(task.id);
          event.run(
            revision,
            task.id,
            "plan_proposal_superseded",
            task.attempts,
            now(),
            "A new planning input superseded the pending plan proposal.",
          );
        }
      });
    },

    resolveDependencyChange(
      revision: string,
      targetId: string,
      proposalId: string,
      apply: boolean,
    ) {
      revision = revisionKey(revision);
      const target = taskId(targetId);
      return transaction(db, () => {
        if (activeRevision() !== revision) return false;
        const tasks = readTaskMap(revision);
        if (tasks.get(target)?.dependencyRecommendation?.id !== proposalId) {
          return false;
        }
        const proposal = [...tasks.values()].map((task) =>
          task.dependencyRecommendation
        )
          .find((item) => item?.id === proposalId && !item.queueOnly);
        if (!proposal) return false;
        const changes = new Map([...tasks.values()].flatMap((task) => {
          const item = task.dependencyRecommendation;
          return item?.id === proposalId && !item.queueOnly
            ? [
              [task.id, {
                id: task.id,
                prerequisites: item.prerequisites,
                reason: item.reason,
              }] as const,
            ]
            : [];
        }));
        if (!apply) {
          dismissDependencyGroup(
            revision,
            target,
            "Operator kept the current prerequisites.",
          );
          return true;
        }
        const citations = citationUpdates(
          tasks,
          (proposal.citations ?? []).map((request) =>
            normalizeTask(revision, request)
          ),
          true,
        );
        if (!citations) return false;
        for (const task of citations) tasks.set(task.id, task);
        const additions = includeProposedTasks(
          tasks,
          revision,
          proposal.additions ?? [],
        );
        if (
          !additions || changes.size !== (proposal.size ?? 1) ||
          !canChangeDependencies(tasks, changes, proposalId)
        ) return false;
        const queueChanges = proposal.queueChanges ?? {};
        const targets = optionalQueueChangeTargets(
          tasks,
          changes,
          queueChanges,
          proposalId,
        );
        if (!targets) return false;
        writeCitationUpdates(revision, citations, now());
        for (const task of additions) enqueue(revision, task, now());
        const remove = db.prepare(
          "DELETE FROM adaptive_dependencies WHERE taskId = ?",
        );
        const insert = db.prepare(
          "INSERT INTO adaptive_dependencies VALUES (?, ?)",
        );
        const update = db.prepare(
          "UPDATE adaptive_tasks SET prerequisites = ?, dependencyRecommendation = NULL WHERE id = ?",
        );
        for (const change of changes.values()) {
          remove.run(change.id);
          for (const prerequisite of change.prerequisites) {
            insert.run(change.id, prerequisite);
          }
          update.run(JSON.stringify(change.prerequisites), change.id);
          event.run(
            revision,
            change.id,
            "dependency_change_applied",
            tasks.get(change.id)!.attempts,
            now(),
            change.reason,
          );
        }
        const release = db.prepare(
          "UPDATE adaptive_tasks SET dependencyRecommendation = NULL WHERE id = ?",
        );
        for (const id of targets.keys()) release.run(id);
        if (queueChanges.priorities) {
          setPlannerPriorities(revision, [...new Set(queueChanges.priorities)]);
        }
        if (queueChanges.retirements) {
          setRetirementRecommendations(
            revision,
            new Map(
              queueChanges.retirements.map(({ id, reason }) => [id, reason]),
            ),
          );
        }
        return true;
      });
    },

    refreshRetirementRecommendations(
      revision: string,
      recommendations: readonly { id: string; reason: string }[],
    ) {
      revision = revisionKey(revision);
      const proposed = new Map(recommendations.map(({ id, reason }) => [
        taskId(id),
        boundedText(reason, "retirement reason", 300),
      ]));
      return transaction(db, () => {
        if (activeRevision() !== revision) return;
        return setRetirementRecommendations(revision, proposed);
      });
    },

    prioritize(revision: string, target: string, requested = true): boolean {
      revision = revisionKey(revision);
      const id = taskId(target);
      return transaction(db, () => {
        if (activeRevision() !== revision) return false;
        const row = lookup.get(id);
        if (row?.revision !== revision || row.status !== "queued") return false;
        if (
          !requested &&
          !db.prepare(`SELECT ${priorityOrder} AS priority
            FROM adaptive_tasks AS task WHERE task.id = ?`).get(id)?.priority
        ) return false;
        if (requested && row.retirementReason) {
          db.prepare(
            "UPDATE adaptive_tasks SET retirementReason = NULL WHERE id = ?",
          ).run(id);
          event.run(
            revision,
            id,
            "retirement_dismissed",
            row.attempts,
            now(),
            "Operator dismissed the retirement recommendation.",
          );
        }
        if (requested && row.dependencyRecommendation) {
          dismissDependencyGroup(
            revision,
            id,
            "Operator prioritized the investigation with its current prerequisites.",
          );
        }
        event.run(
          revision,
          id,
          requested ? "prioritized" : "priority_withdrawn",
          row.attempts,
          now(),
          requested
            ? "Operator requested this investigation next."
            : "Operator withdrew the priority request.",
        );
        return true;
      });
    },

    retryFailed(revision: string, target: string): boolean {
      revision = revisionKey(revision);
      const id = taskId(target);
      return transaction(db, () => {
        if (activeRevision() !== revision) return false;
        const row = lookup.get(id);
        if (
          row?.revision !== revision || row.status !== "failed" ||
          Number(row.attempts) >= MAX_ADAPTIVE_TASK_ATTEMPTS
        ) return false;
        updateStatus.run("queued", id);
        event.run(
          revision,
          id,
          "retry_queued",
          row.attempts,
          now(),
          "Operator requested a retry.",
        );
        return true;
      });
    },

    workerLimit(): number | undefined {
      const row = db.prepare(
        "SELECT workerLimit FROM adaptive_worker_settings WHERE singleton = 1",
      ).get();
      return row ? Number(row.workerLimit) : undefined;
    },

    setWorkerLimit(limit: number | null): void {
      if (limit === null) {
        db.prepare("DELETE FROM adaptive_worker_settings WHERE singleton = 1")
          .run();
        return;
      }
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error("Invalid Sentinel worker limit");
      }
      db.prepare(`INSERT INTO adaptive_worker_settings VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET workerLimit = excluded.workerLimit`)
        .run(limit);
    },

    addCaseHint(text: string, evidenceRevision: number) {
      const hint = boundedText(text, "case hint", 1000);
      return transaction(
        db,
        () => appendCaseHint(hint, evidenceRevision, now()),
      );
    },

    /** The trusted gateway holds the assessment revision lock around this write. */
    addOperatorCaseHint(
      text: string,
      revision: number,
      requestId: string,
      operatorScope: string,
      runId: string,
    ) {
      const hint = boundedText(text, "case hint", 1000);
      operatorScope = boundedText(operatorScope, "operator scope", 256);
      runId = boundedText(runId, "case hint run ID", 256);
      if (
        !Number.isSafeInteger(revision) || revision < 1 ||
        typeof requestId !== "string" ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId)
      ) return undefined;
      return transaction(db, () => {
        const existing = db.prepare(`
          SELECT hint.id, hint.evidenceRevision, hint.at, hint.text, request.runId, request.operatorScope
          FROM adaptive_operator_case_hint_requests AS request
          JOIN adaptive_case_hints AS hint ON hint.id = request.hintId
          WHERE request.requestId = ?
        `).get(requestId);
        if (existing) {
          if (
            existing.evidenceRevision !== revision || existing.text !== hint ||
            existing.runId !== runId || existing.operatorScope !== operatorScope
          ) return undefined;
          return {
            id: Number(existing.id),
            revision,
            at: new Date(Number(existing.at)).toISOString(),
            text: hint,
          };
        }
        const time = now();
        const { lastInsertRowid } = appendCaseHint(hint, revision, time);
        db.prepare(
          "INSERT INTO adaptive_operator_case_hint_requests VALUES (?, ?, ?, ?)",
        ).run(
          requestId,
          operatorScope,
          runId,
          lastInsertRowid,
        );
        return {
          id: Number(lastInsertRowid),
          revision,
          at: new Date(time).toISOString(),
          text: hint,
        };
      });
    },

    caseHintsById(ids: readonly number[]) {
      if (!ids.length) return [];
      return db.prepare(`
        SELECT id, evidenceRevision, at, text FROM adaptive_case_hints
        WHERE id IN (SELECT value FROM json_each(?))
        ORDER BY id
      `).all(JSON.stringify(ids)).map((row) => ({
        id: Number(row.id),
        revision: Number(row.evidenceRevision) || null,
        at: new Date(Number(row.at)).toISOString(),
        text: String(row.text),
      }));
    },

    caseHints(limit: number, before?: number, revision?: number) {
      return db.prepare(`
        SELECT * FROM adaptive_case_hints
        WHERE (? IS NULL OR id < ?) AND (? IS NULL OR evidenceRevision <= ?)
        ORDER BY id DESC LIMIT ?
      `).all(
        before ?? null,
        before ?? null,
        revision ?? null,
        revision ?? null,
        limit,
      )
        .map((row) => ({
          id: Number(row.id),
          revision: Number(row.evidenceRevision) || null,
          at: new Date(Number(row.at)).toISOString(),
          text: String(row.text),
        }));
    },

    outputLanguage(): SentinelOutputLanguage | undefined {
      const row = db.prepare(
        "SELECT language FROM adaptive_model_language WHERE singleton = 1",
      ).get();
      return sentinelOutputLanguages.find((language) =>
        language === row?.language
      );
    },

    setOutputLanguage(language: SentinelOutputLanguage | null): void {
      if (language === null) {
        db.prepare("DELETE FROM adaptive_model_language WHERE singleton = 1")
          .run();
        return;
      }
      db.prepare(`INSERT INTO adaptive_model_language VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET language = excluded.language`).run(
        language,
      );
    },

    recordModelUsage(
      revision: number | "interactive",
      inputTokens: number,
      outputTokens: number,
    ) {
      if (
        (revision !== "interactive" &&
          (!Number.isSafeInteger(revision) || revision < 1)) ||
        ![inputTokens, outputTokens].every((count) =>
          Number.isSafeInteger(count) && count >= 0
        )
      ) {
        return;
      }
      db.prepare(`
        INSERT INTO adaptive_model_usage VALUES (?, 1, ?, ?)
        ON CONFLICT(evidenceRevision) DO UPDATE SET calls = calls + 1,
          inputTokens = inputTokens + excluded.inputTokens,
          outputTokens = outputTokens + excluded.outputTokens
      `).run(
        revision === "interactive" ? 0 : revision,
        inputTokens,
        outputTokens,
      );
    },

    modelUsage(scope?: number | "interactive") {
      const revision = scope === "interactive" ? 0 : scope ?? null;
      const row = db.prepare(`
        SELECT SUM(calls) AS calls, SUM(inputTokens) AS inputTokens,
          SUM(outputTokens) AS outputTokens FROM adaptive_model_usage
        WHERE (? IS NULL AND evidenceRevision > 0) OR evidenceRevision = ?
      `).get(revision, revision);
      return row?.calls == null ? undefined : {
        calls: Number(row.calls),
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
      };
    },

    readSavedGitHubWorkflowReceipt(
      revision: string,
      sourceTaskId: string,
      targetId: string,
      evidenceRevision: number,
      resultSha256: string,
    ) {
      if (
        this.forEvidence(evidenceRevision)?.revision !== revision ||
        !/^[a-f0-9]{64}$/.test(resultSha256)
      ) return undefined;
      const row = db.prepare(`
        SELECT trace.steps FROM adaptive_tasks AS source
        JOIN adaptive_model_reviews AS review ON review.taskId = source.id
        JOIN adaptive_notes AS note ON note.rowid = review.noteId
          AND note.revision = source.revision AND note.taskId = source.id
        JOIN adaptive_note_steps AS trace ON trace.note_id = note.rowid
        WHERE source.id = ? AND source.revision = ? AND source.nodeId = ?
          AND source.status = 'completed'
      `).get(taskId(sourceTaskId), revisionKey(revision), targetId);
      if (typeof row?.steps !== "string") return undefined;
      const steps = JSON.parse(row.steps) as SentinelReviewStep[];
      let matched:
        | {
          sourceTaskId: string;
          stepIndex: number;
          receipt: SentinelGitHubWorkflowReadReceipt;
        }
        | undefined;
      for (const [stepIndex, step] of steps.slice(0, 16).entries()) {
        if (
          step.tool !== "sentinel_live_workflow_status" ||
          step.outcome !== "returned" ||
          (step.target !== targetId && step.target !== targetId.slice(0, 256))
        ) continue;
        const receipt = readSentinelGitHubWorkflowReadReceipt(
          step.githubWorkflowRead,
          evidenceRevision,
        );
        if (receipt?.resultSha256 === resultSha256) {
          if (matched && !isDeepStrictEqual(matched.receipt, receipt)) {
            return undefined;
          }
          matched ??= { sourceTaskId, stepIndex, receipt };
        }
      }
      return matched;
    },

    modelReviewNotes(revision: string) {
      const hasConstraintProof = db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_model_review_constraint_proofs'",
      ).get();
      const hasSteps = db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_note_steps'",
      ).get();
      return db.prepare(`
        SELECT task.id AS taskId, note.note AS summary, note.at,
          ${hasSteps ? "trace.steps" : "NULL AS steps"}
          ${
        hasConstraintProof
          ? ", proof.version AS constraintVersion, proof.digest AS constraintDigest"
          : ""
      }
        FROM adaptive_tasks AS task
        LEFT JOIN adaptive_model_reviews AS review ON review.taskId = task.id
        JOIN adaptive_notes AS note ON note.rowid = COALESCE(review.noteId, (
          SELECT MAX(candidate.rowid) FROM adaptive_notes AS candidate
          WHERE candidate.revision = task.revision AND candidate.taskId = task.id
            AND EXISTS (SELECT 1 FROM adaptive_events AS activity
              WHERE activity.revision = task.revision AND activity.taskId = task.id
                AND activity.event = 'model_review_completed' AND activity.at = candidate.at)
          GROUP BY candidate.at HAVING COUNT(*) = 1
          ORDER BY candidate.at DESC LIMIT 1
        ))
        ${
        hasSteps
          ? "LEFT JOIN adaptive_note_steps AS trace ON trace.note_id = note.rowid"
          : ""
      }
        ${
        hasConstraintProof
          ? "LEFT JOIN adaptive_model_review_constraint_proofs AS proof ON proof.note_id = note.rowid"
          : ""
      }
        WHERE task.revision = ? AND task.status = 'completed'
        ORDER BY task.rowid
      `).all(revisionKey(revision)).map((row) => {
        const operatingConstraints = normalizePlannerConstraintProof({
          version: row.constraintVersion,
          digest: row.constraintDigest,
        });
        return {
          taskId: String(row.taskId),
          summary: String(row.summary),
          at: new Date(Number(row.at)).toISOString(),
          steps: typeof row.steps === "string"
            ? JSON.parse(row.steps) as SentinelReviewStep[]
            : [],
          ...(operatingConstraints && { operatingConstraints }),
        };
      });
    },

    modelReviewStates(revision: string) {
      const active = activeRevision() === revision;
      const time = now();
      return db.prepare(`
        SELECT review.taskId, review.attempts, review.token, review.availableAt,
          review.noteId, review.operatorRetry,
          (
            SELECT requestedAt FROM adaptive_worker_controls AS control
            WHERE control.revision = task.revision AND control.taskId = task.id
              AND control.action = 'stop'
            LIMIT 1
          ) AS stoppedAt,
          steering.id AS steeringId, steering.requestId AS steeringRequestId,
          steering.note AS steeringNote, steering.requestedAt AS steeringRequestedAt,
          steering.appliedAt AS steeringAppliedAt, progress.steps AS progressSteps,
          EXISTS (SELECT 1 FROM adaptive_events AS activity
            WHERE activity.revision = task.revision AND activity.taskId = task.id
              AND activity.event = 'model_review_completed') AS recordedCompletion
        FROM adaptive_model_reviews AS review
        JOIN adaptive_tasks AS task ON task.id = review.taskId
        LEFT JOIN adaptive_worker_progress AS progress
          ON progress.revision = task.revision AND progress.taskId = task.id
        LEFT JOIN adaptive_worker_controls AS steering
          ON steering.id = (
            SELECT MAX(control.id) FROM adaptive_worker_controls AS control
            WHERE control.revision = task.revision AND control.taskId = task.id
              AND control.action = 'steer'
          )
        WHERE task.revision = ?
      `).all(revisionKey(revision)).map((row) => {
        const attempts = Number(row.attempts);
        const outcomeUncertain = mutationPending(revision, String(row.taskId));
        const status = typeof row.stoppedAt === "number"
          ? "stopped"
          : row.noteId != null || row.recordedCompletion === 1
          ? "completed"
          : !active ||
              (outcomeUncertain &&
                (row.token == null || Number(row.availableAt) <= time))
          ? "interrupted"
          : row.token != null && Number(row.availableAt) > time
          ? "running"
          : attempts >= 2 + Number(row.operatorRetry)
          ? "exhausted"
          : "retry_pending";
        return {
          taskId: String(row.taskId),
          attempts,
          status,
          retryable: status === "exhausted" && row.operatorRetry === 0,
          ...(outcomeUncertain && { outcomeUncertain: true }),
          ...(typeof row.stoppedAt === "number" &&
            { stoppedAt: new Date(row.stoppedAt).toISOString() }),
          ...(typeof row.steeringId === "number" && {
            lastSteering: {
              id: row.steeringId,
              requestId: String(row.steeringRequestId),
              note: String(row.steeringNote),
              requestedAt: new Date(Number(row.steeringRequestedAt))
                .toISOString(),
              ...(typeof row.steeringAppliedAt === "number" &&
                { appliedAt: new Date(row.steeringAppliedAt).toISOString() }),
            },
          }),
          ...(typeof row.progressSteps === "string" && {
            progressSteps: JSON.parse(
              row.progressSteps,
            ) as SentinelReviewStep[],
          }),
        };
      });
    },

    retryModelReview(revision: string, target: string): boolean {
      return transaction(db, () => {
        if (
          activeRevision() !== revision ||
          mutationPending(revision, taskId(target))
        ) return false;
        const time = now();
        recordExpiredModelReviews(revision, time);
        const row = db.prepare(`
          UPDATE adaptive_model_reviews SET operatorRetry = 1, availableAt = ?
          WHERE taskId = ? AND noteId IS NULL AND token IS NULL
            AND attempts = 2 AND operatorRetry = 0
            AND taskId IN (
              SELECT id FROM adaptive_tasks WHERE revision = ? AND status = 'completed'
            )
            AND NOT EXISTS (SELECT 1 FROM adaptive_events AS activity
              WHERE activity.taskId = adaptive_model_reviews.taskId
                AND activity.event = 'model_review_completed')
            AND NOT EXISTS (SELECT 1 FROM adaptive_worker_controls AS control
              WHERE control.revision = ? AND control.taskId = adaptive_model_reviews.taskId AND control.action = 'stop')
          RETURNING attempts
        `).get(time, taskId(target), revision, revision);
        if (!row) return false;
        event.run(
          revision,
          target,
          "model_review_retry_queued",
          row.attempts,
          time,
          null,
        );
        return true;
      });
    },

    reconcileWorkerPublications(
      revision: string,
      evidenceRevision: number,
      eligible: (task: AdaptiveTask) => boolean,
      lookupMutation?: SentinelJournalMutationLookup,
    ): void {
      if (
        !hasWorkerCheckpointTable()
      ) return;
      transaction(db, () => {
        if (
          activeRevision() !== revision ||
          recordedEvidenceNumber(revision) !== evidenceRevision
        ) return;
        const time = now();
        const candidates = db.prepare(`
          SELECT task.*, checkpoint.checkpoint, checkpoint.promptSha256, review.attempts AS reviewAttempts
          FROM adaptive_worker_checkpoints AS checkpoint
          JOIN adaptive_tasks AS task ON task.id = checkpoint.taskId
          JOIN adaptive_model_reviews AS review ON review.taskId = task.id
          WHERE checkpoint.revision = ? AND checkpoint.evidenceRevision = ?
            AND checkpoint.version = 1 AND checkpoint.expiresAt > ?
            AND task.revision = checkpoint.revision AND task.status = 'completed'
            AND review.availableAt <= ? AND review.noteId IS NULL
            AND NOT EXISTS (SELECT 1 FROM adaptive_worker_controls AS control
              WHERE control.revision = task.revision AND control.taskId = task.id AND control.action = 'stop')
        `).all(revision, evidenceRevision, time, time);
        for (const row of candidates) {
          const id = String(row.id);
          const pending = pendingMutation.get(revision, id);
          if (
            pending?.event !== "model_mutation_pending" ||
            typeof pending.note !== "string" ||
            typeof row.nodeId !== "string" ||
            !eligible(decodeTask(row))
          ) continue;
          const marker = JSON.parse(pending.note);
          const saved = JSON.parse(
            String(row.checkpoint),
          ) as AgentTurnCheckpoint;
          if (
            !marker ||
            (marker.publicationIteration !== saved.completedIterations &&
              marker.publicationIteration !== saved.completedIterations + 1)
          ) continue;
          const results = saved.history.filter(({ role }) => role === "tool");
          const observation = assignmentPublication(
            revision,
            id,
            evidenceRevision,
          );
          const receipt = hasGitHubWorkflowResultTable()
            ? readWorkflowResult(revision, id, evidenceRevision)
            : undefined;
          if (
            !Array.isArray(marker.tools) || !marker.tools.length ||
            marker.tools.length > 6 ||
            (marker.journalRequests !== undefined &&
              (!Array.isArray(marker.journalRequests) ||
                marker.journalRequests.length !== marker.tools.length)) ||
            (marker.journalRequests === undefined && marker.tools.length !== 1)
          ) continue;
          const progress = this.modelReviewProgress(revision, id);
          const alreadySaved =
            marker.publicationIteration === saved.completedIterations;
          const earlierResults = alreadySaved
            ? results.slice(0, -marker.tools.length)
            : results;
          const workflowResult = receipt && JSON.stringify({
            targetId: row.nodeId,
            ...receipt,
          });
          const batch = [];
          for (const [index, tool] of marker.tools.entries()) {
            if (typeof tool !== "string") break;
            if (tool === WORKFLOW_CHECKPOINT_TOOL) {
              const step = progress[earlierResults.length + index];
              if (
                marker.journalRequests?.[index] !== null || !workflowResult ||
                step?.tool !== tool || step.outcome !== "returned" ||
                !isDeepStrictEqual(step.githubWorkflowRead, receipt)
              ) break;
              batch.push({
                tool,
                callId: WORKFLOW_CHECKPOINT_CALL,
                args: {},
                result: workflowResult,
                id: undefined,
              });
              continue;
            }
            if (tool === WORKFLOW_PUBLICATION_TOOL) {
              const source = observation &&
                (earlierResults[observation.stepIndex]?.content ??
                  batch[observation.stepIndex - earlierResults.length]?.result);
              if (
                (marker.journalRequests &&
                  marker.journalRequests[index] !== null) ||
                !observation || !receipt ||
                observation.targetId !== row.nodeId ||
                !isDeepStrictEqual(observation.receipt, receipt) ||
                source !== workflowResult ||
                !db.prepare(`SELECT 1 FROM adaptive_events
                  WHERE revision = ? AND taskId = ? AND event = 'workflow_observation_committed'
                    AND rowid > ? AND note = ?`).get(
                  revision,
                  id,
                  pending.rowid,
                  observation.id,
                )
              ) break;
              batch.push({
                tool,
                callId: WORKFLOW_PUBLICATION_CALL,
                args: {},
                result: workflowPublicationResult(observation),
                id: observation.id,
              });
              continue;
            }
            if (
              tool !== GRAPH_PUBLICATION_TOOL &&
              !isSentinelFindingMutation(tool)
            ) break;
            const admitted = marker.journalRequests === undefined
              ? marker.journalRequest ?? marker.graphPublication
              : marker.journalRequests[index];
            const requestId = admitted?.requestId;
            const verified = typeof requestId === "string" &&
              lookupMutation?.(id, row.nodeId, tool, requestId);
            if (
              !verified ||
              admitted.argsDigest !==
                createHash("sha256").update(JSON.stringify(verified.args))
                  .digest("hex")
            ) break;
            batch.push({
              tool,
              callId: tool === GRAPH_PUBLICATION_TOOL
                ? GRAPH_PUBLICATION_CALL
                : `recovery-${tool}`,
              ...verified,
            });
          }
          if (batch.length !== marker.tools.length) continue;
          const references = batch.flatMap(({ id }) => id ? [id] : []);
          if (!references.length) continue;
          if (
            alreadySaved && !isDeepStrictEqual(
              results.slice(-batch.length).map(({ content }) => content),
              batch.map(({ result }) => result),
            )
          ) continue;
          const normalized = normalizeWorkerCheckpoint(
            alreadySaved ? saved : {
              ...saved,
              completedIterations: marker.publicationIteration,
              toolCallCounts: [
                ...saved.toolCallCounts,
                ...batch.map(({ tool, args }) =>
                  [
                    `${tool}:${JSON.stringify(args, Object.keys(args).sort())}`,
                    1,
                  ] as const
                ),
              ],
              history: [
                ...saved.history,
                {
                  role: "assistant",
                  content: " ",
                  tool_calls: batch.map(({ callId, tool, args }) => ({
                    id: callId,
                    type: "function",
                    function: { name: tool, arguments: JSON.stringify(args) },
                  })),
                },
                ...batch.map(({ callId, result }) => ({
                  role: "tool" as const,
                  tool_call_id: callId,
                  content: result,
                })),
              ],
            },
            String(row.promptSha256),
            row.nodeId,
            receipt,
            progress,
            observation,
            this.modelReviewControls(revision, id).steering,
            lookupMutation &&
              ((tool, requestId) =>
                lookupMutation(id, String(row.nodeId), tool, requestId)),
          );
          if (!normalized) continue;
          const encoded = JSON.stringify(normalized);
          if (
            new TextEncoder().encode(encoded).length >
              MAX_WORKER_CHECKPOINT_BYTES
          ) continue;
          db.prepare(`UPDATE adaptive_worker_checkpoints SET checkpoint = ?
            WHERE revision = ? AND taskId = ? AND evidenceRevision = ?`)
            .run(encoded, revision, id, evidenceRevision);
          event.run(
            revision,
            id,
            "model_mutation_settled",
            row.reviewAttempts,
            time,
            references.length === 1
              ? references[0]
              : JSON.stringify(references),
          );
        }
      });
    },

    modelReviewAvailable(
      revision: string,
      reason: string,
      eligible: (task: AdaptiveTask) => boolean = () => true,
    ): boolean {
      return activeRevision() === revision &&
        nextModelReview.all(revision, reason, now())
          .some((row) => eligible(decodeTask(row)));
    },

    claimModelReview(
      revision: string,
      reason: string,
      eligible: (task: AdaptiveTask) => boolean = () => true,
    ) {
      return transaction(db, () => {
        if (activeRevision() !== revision) return null;
        const time = now();
        recordExpiredModelReviews(revision, time);
        const row = nextModelReview.all(revision, reason, time)
          .find((row) => eligible(decodeTask(row)));
        if (!row) return null;
        const token = randomUUID();
        db.prepare(`
          INSERT INTO adaptive_model_reviews (taskId, attempts, token, availableAt)
          VALUES (?, 1, ?, ?)
          ON CONFLICT(taskId) DO UPDATE SET attempts = attempts + 1,
            token = excluded.token, availableAt = excluded.availableAt
        `).run(row.id, token, time + 45_000);
        event.run(
          revision,
          row.id,
          "model_review_claimed",
          Number(row.reviewAttempts) + 1,
          time,
          null,
        );
        return { task: decodeTask(row), token };
      });
    },

    finishModelReview(
      revision: string,
      target: string,
      token: string,
      outcome:
        | {
          note: string;
          steps: readonly SentinelReviewStep[];
          followUps?: readonly AdaptiveTaskRequest[];
          operatingConstraints?: AdaptivePlannerConstraintProof;
        }
        | "interrupted"
        | "failed",
    ): boolean {
      return transaction(db, () => {
        if (activeRevision() !== revision) return false;
        const time = now();
        const row = db.prepare(`
          SELECT review.attempts FROM adaptive_model_reviews AS review
          JOIN adaptive_tasks AS task ON task.id = review.taskId
          WHERE task.id = ? AND task.revision = ? AND review.token = ?
            AND review.availableAt > ?
        `).get(target, revision, token, time);
        if (!row) return false;
        const attempts = Number(row.attempts);
        if (this.modelReviewControls(revision, target).stopped) {
          db.prepare(
            "UPDATE adaptive_model_reviews SET token = NULL, availableAt = ? WHERE taskId = ?",
          )
            .run(time, target);
          event.run(
            revision,
            target,
            "model_review_stopped",
            attempts,
            time,
            null,
          );
          return true;
        }
        if (typeof outcome !== "string") {
          const proof = normalizePlannerConstraintProof(
            outcome.operatingConstraints,
          );
          if (outcome.operatingConstraints !== undefined && !proof) {
            throw new Error(
              "Invalid Sentinel model review operating constraint proof",
            );
          }
          insertNote(
            revision,
            target,
            boundedText(outcome.note, "note", 2000),
            outcome.steps,
            time,
          );
          const saved = db.prepare(`UPDATE adaptive_model_reviews SET noteId = (
            SELECT MAX(rowid) FROM adaptive_notes WHERE revision = ? AND taskId = ?
          ) WHERE taskId = ? RETURNING noteId`).get(revision, target, target);
          if (proof) {
            if (typeof saved?.noteId !== "number") {
              throw new Error("Missing committed Sentinel model review note");
            }
            db.exec(`
              CREATE TABLE IF NOT EXISTS adaptive_model_review_constraint_proofs (
                note_id INTEGER PRIMARY KEY,
                version INTEGER NOT NULL,
                digest TEXT NOT NULL
              ) STRICT
            `);
            db.prepare(
              "INSERT INTO adaptive_model_review_constraint_proofs VALUES (?, ?, ?)",
            )
              .run(saved.noteId, proof.version, proof.digest);
          }
          if (hasGitHubWorkflowResultTable()) {
            db.prepare(
              "DELETE FROM adaptive_live_workflow_results WHERE revision = ? AND taskId = ?",
            )
              .run(revision, target);
          }
          if (hasWorkerCheckpointTable()) {
            db.prepare(
              "DELETE FROM adaptive_worker_checkpoints WHERE revision = ? AND taskId = ?",
            )
              .run(revision, target);
          }
          const capacity = MAX_ADAPTIVE_TASKS - Number(
            db.prepare(
              "SELECT COUNT(*) AS count FROM adaptive_tasks WHERE revision = ?",
            ).get(revision)?.count,
          );
          const scheduled = new Set<string>();
          for (const followUp of outcome.followUps ?? []) {
            if (scheduled.size >= Math.min(capacity, 2)) break;
            const request = normalizeTask(revision, {
              ...followUp,
              prerequisites: [target],
              reviewedFrom: target,
            });
            if (lookup.get(request.id)) continue;
            if (enqueue(revision, request, time)) scheduled.add(request.id);
          }
        }
        db.prepare(`
          UPDATE adaptive_model_reviews SET token = NULL, attempts = ?, availableAt = ?
          WHERE taskId = ?
        `).run(
          outcome === "interrupted" ? attempts - 1 : attempts,
          outcome === "failed" ? time + 15_000 : time,
          target,
        );
        const status = outcome === "interrupted"
          ? "model_review_interrupted"
          : outcome === "failed"
          ? "model_review_failed"
          : "model_review_completed";
        event.run(revision, target, status, attempts, time, null);
        return true;
      });
    },

    addNote(
      revision: string,
      note: string,
      target?: string,
      steps: readonly SentinelReviewStep[] = [],
    ): AdaptiveTaskNote {
      revision = revisionKey(revision);
      note = boundedText(note, "note", 2000);
      const id = target === undefined ? null : taskId(target);
      return transaction(db, () => {
        if (
          !revisions.get(revision) ||
          (id !== null && lookup.get(id)?.revision !== revision)
        ) {
          throw new Error(
            "Sentinel adaptive note must reference a known revision and task",
          );
        }
        return insertNote(revision, id, note, steps, now());
      });
    },

    notes(revision = activeRevision(), limit = 100): AdaptiveTaskNote[] {
      if (revision === null) return [];
      return db.prepare(
        "SELECT * FROM adaptive_notes WHERE revision = ? ORDER BY rowid DESC LIMIT ?",
      ).all(revisionKey(revision), reportLimit(limit)).map((row) => ({
        revision: String(row.revision),
        taskId: row.taskId === null ? null : String(row.taskId),
        note: String(row.note),
        at: new Date(Number(row.at)).toISOString(),
      }));
    },

    recentNotes(limit = 100, revision?: string) {
      const traced = db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'adaptive_note_steps'",
      ).get();
      return db.prepare(`
        SELECT note.*, task.kind, task.nodeId, ${
        traced ? "trace.steps" : "NULL AS steps"
      }
        FROM adaptive_notes AS note
        LEFT JOIN adaptive_tasks AS task ON task.id = note.taskId
        ${
        traced
          ? "LEFT JOIN adaptive_note_steps AS trace ON trace.note_id = note.rowid"
          : ""
      }
        WHERE (? IS NULL OR note.revision = ?)
        ORDER BY note.rowid DESC LIMIT ?
      `).all(
        revision ?? null,
        revision ?? null,
        reportLimit(limit),
      ).map((
        row,
      ) => ({
        revision: String(row.revision),
        taskId: row.taskId === null ? null : String(row.taskId),
        note: String(row.note),
        at: new Date(Number(row.at)).toISOString(),
        kind: typeof row.kind === "string" ? row.kind : undefined,
        nodeId: typeof row.nodeId === "string" ? row.nodeId : undefined,
        ...(typeof row.steps === "string" &&
          { steps: JSON.parse(row.steps) as SentinelReviewStep[] }),
      }));
    },

    history(revision = activeRevision(), limit = 100): AdaptiveTaskEvent[] {
      if (revision === null) return [];
      return db.prepare(
        "SELECT * FROM adaptive_events WHERE revision = ? ORDER BY rowid DESC LIMIT ?",
      ).all(revisionKey(revision), reportLimit(limit)).map((row) => ({
        revision: String(row.revision),
        taskId: String(row.taskId),
        event: String(row.event),
        attempt: Number(row.attempt),
        at: new Date(Number(row.at)).toISOString(),
        note: row.note === null ? null : String(row.note),
        ...(typeof row.removedEvidenceIds === "string" && {
          removedEvidenceIds: JSON.parse(row.removedEvidenceIds) as string[],
        }),
      }));
    },

    recentActivity(limit = 100, revision?: string, before?: number) {
      return db.prepare(`
        SELECT activity.rowid AS cursor, activity.*, task.kind, task.nodeId
        FROM adaptive_events AS activity
        LEFT JOIN adaptive_tasks AS task ON task.id = activity.taskId
        WHERE (? IS NULL OR activity.revision = ?)
          AND (? IS NULL OR activity.rowid < ?)
        ORDER BY activity.rowid DESC LIMIT ?
      `).all(
        revision ?? null,
        revision ?? null,
        before ?? null,
        before ?? null,
        reportLimit(limit),
      ).map((
        row,
      ) => ({
        cursor: Number(row.cursor),
        revision: String(row.revision),
        taskId: String(row.taskId),
        event: String(row.event),
        attempt: Number(row.attempt),
        at: new Date(Number(row.at)).toISOString(),
        note: row.note === null ? null : String(row.note),
        ...(typeof row.removedEvidenceIds === "string" && {
          removedEvidenceIds: JSON.parse(row.removedEvidenceIds) as string[],
        }),
        kind: typeof row.kind === "string" ? row.kind : undefined,
        nodeId: typeof row.nodeId === "string" ? row.nodeId : undefined,
      }));
    },

    close(): void {
      db.close();
    },
  };
}
