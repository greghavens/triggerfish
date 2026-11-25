import { readSentinelRemediationReceipts } from "../sentinel/worker_finding_store.ts";
import { digestSentinelSnapshot } from "../sentinel/shared_inventory.ts";
/** Save and reopen compact members of an exact Sentinel provenance revision. */
import { dirname, join } from "@std/path";
import { createHash } from "node:crypto";
import type { ToolDefinition } from "../core/types/tool.ts";
import type { OperatorRunRef } from "../core/operator_runs.ts";
import {
  readSentinelAssessmentRevision,
  readSentinelOperatingConstraints,
  readSentinelRunIdForRevision,
} from "../sentinel/assessment_store.ts";
import { sentinelOperatingConstraintsAllow } from "../sentinel/operating_constraints.ts";
import {
  readSentinelCaseGraphFacts,
  sentinelGraphFactScopeFilter,
} from "../sentinel/worker_graph_facts.ts";
import {
  locateSentinelCase,
  resolveSentinelCasePath,
} from "../sentinel/cases.ts";
import {
  expandArchivedSentinelEvidenceDigest,
  normalizeSentinelEvidenceDigestMembers,
  openSentinelEvidenceDigests,
  readSentinelArchivedDigestCatalog,
  sentinelArchivedDigestFile,
} from "../sentinel/evidence_digests.ts";
import {
  readSentinelAdaptiveEvidenceMapping,
  readSentinelIntermediateWorkflowObservations,
  readSentinelProvenance,
} from "./sentinel_adaptive_runtime.ts";

const unavailable =
  "Error: The requested evidence digest or revision is unavailable.";
const nodeKinds = new Set([
  "asset",
  "control",
  "evidence",
  "finding",
  "goal",
  "task",
  "observation",
]);

/** Typed observations in a digest stay subject to the current constraint of their run. */
export function allowSentinelDigestObservations(
  path: string,
  runId: string,
  revision: number,
  members: readonly { readonly id: string }[],
): boolean {
  const prefix = "observation:adaptive:";
  const observations = members.flatMap(({ id }) => {
    if (!id.startsWith(prefix)) return [];
    const reference = id.slice(prefix.length);
    return /^(?:workflow-observation|worker-graph-fact|worker-recheck):/.test(
        reference,
      )
      ? [reference]
      : [];
  });
  if (!observations.length) return true;
  const snapshot = readSentinelAssessmentRevision(path, revision)?.result
    .sharedGraph.snapshot;
  if (!snapshot) return false;
  const constraints = readSentinelOperatingConstraints(path, runId)
    ?.constraints;
  const caseId = locateSentinelCase(path)?.caseId;
  if (!caseId) return false;
  const allowsTarget = (nodeId: string) =>
    sentinelOperatingConstraintsAllow(
      constraints,
      { kind: "review_evidence", nodeId },
      snapshot,
    );
  const allowsFact = sentinelGraphFactScopeFilter(snapshot, allowsTarget);
  const rechecks = new Map(
    readSentinelRemediationReceipts(path, {
      caseId,
      runId,
      evidenceRevision: revision,
      snapshotDigest: digestSentinelSnapshot(snapshot),
    }, observations.filter((id) => id.startsWith("worker-recheck:"))).map(
      ({ id, targetId }) => [id, targetId],
    ),
  );
  return observations.every((id) => {
    if (id.startsWith("worker-recheck:")) {
      const target = rechecks.get(id);
      return target !== undefined && allowsTarget(target);
    }
    if (id.startsWith("worker-graph-fact:")) {
      const retained = readSentinelCaseGraphFacts(
        path,
        {
          caseId,
          runId,
          evidenceRevision: revision,
        },
        { id },
        allowsFact,
      );
      return !!retained && "fact" in retained;
    }
    const retained = readSentinelIntermediateWorkflowObservations(
      path,
      revision,
      runId,
      { id },
    );
    return !!retained?.observation &&
      allowsTarget(retained.observation.targetId);
  });
}

export async function executeOperatorEvidenceDigest(
  baseDir: string,
  ref: OperatorRunRef,
  args: Record<string, unknown>,
  confirm: (message: string) => Promise<boolean>,
): Promise<Record<string, unknown> | string> {
  const { action, query = "", nodeKind, cursor, limit = 5, digestId } = args;
  const save = action === "save_digest";
  const list = action === "list_digests";
  if (
    ref.kind !== "sentinel" || ref.revision === undefined ||
    (!save && !list && action !== "expand_digest") ||
    Object.keys(args).some((key) =>
      ![
        "action",
        "kind",
        "id",
        "revision",
        ...(save ? ["query", "nodeKind"] : ["limit", "cursor"]),
        ...(!save && !list ? ["digestId"] : []),
      ].includes(key)
    ) ||
    typeof query !== "string" || query.length > 256 ||
    (nodeKind !== undefined &&
      (typeof nodeKind !== "string" || !nodeKinds.has(nodeKind))) ||
    (cursor !== undefined && typeof cursor !== "string") ||
    typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
    limit > 10 ||
    (!save && !list &&
      (typeof digestId !== "string" ||
        !/^sentinel-digest:[a-f0-9]{64}$/.test(digestId)))
  ) return unavailable;
  const revision = ref.revision;
  const path = resolveSentinelCasePath(baseDir, ref.id);
  const readRunId = () =>
    readSentinelRunIdForRevision(path, revision) ??
      readSentinelAdaptiveEvidenceMapping(path, revision)?.goal.id;
  const runId = readRunId();
  if (!runId) return unavailable;
  const scope = { caseId: ref.id, runId, evidenceRevision: revision };
  const store = openSentinelEvidenceDigests(baseDir);
  try {
    if (!save) {
      const archived = readSentinelArchivedDigestCatalog(
        join(dirname(path), sentinelArchivedDigestFile),
        { caseId: scope.caseId },
      ).filter(({ digest }) =>
        digest.scope.runId === runId &&
        digest.scope.evidenceRevision === revision
      );
      if (list) {
        const archivedIndex = archived.findIndex(({ digest }) =>
          digest.id === cursor
        );
        const live = archivedIndex < 0
          ? store.list(
            scope,
            limit,
            cursor,
            archived.map(({ digest }) => digest.id),
          )
          : { digests: [], nextCursor: null };
        if (!live) return unavailable;
        if (live.nextCursor) return { run: ref, page: live };
        const digests = [
          ...live.digests,
          ...archived.slice(archivedIndex + 1).map(({ digest }) => digest),
        ];
        const page = {
          digests: digests.slice(0, limit),
          nextCursor: digests.length > limit ? digests[limit - 1].id : null,
        };
        return { run: ref, page };
      }
      const entry = archived.find(({ digest }) => digest.id === digestId);
      const page = entry
        ? expandArchivedSentinelEvidenceDigest(entry, limit, cursor)
        : store.expand(scope, digestId as string, limit, cursor);
      return page &&
          allowSentinelDigestObservations(path, runId, revision, page.members)
        ? { run: ref, page }
        : unavailable;
    }
    const select = () =>
      normalizeSentinelEvidenceDigestMembers(
        readSentinelProvenance(path, revision)?.graph
          .searchNodes(query, nodeKind as string | undefined)
          .map((node) => ({
            id: node.id,
            kind: node.kind,
            label: node.label.replace(/\s+/g, " ").trim().slice(0, 240),
            ...("status" in node && typeof node.status === "string" &&
              node.status && {
              status: node.status,
            }),
          })),
      );
    const members = select();
    if (!members) return unavailable;
    const serialized = JSON.stringify(members);
    if (
      !await confirm(`Save this Sentinel evidence digest?\n${
        JSON.stringify({
          ...scope,
          query,
          nodeKind,
          memberCount: members.length,
          memberDigest: createHash("sha256").update(serialized).digest("hex"),
        })
      }`)
    ) return "Error: The operator declined the run action.";
    if (readRunId() !== runId || JSON.stringify(select()) !== serialized) {
      return unavailable;
    }
    const digest = store.record(scope, { members });
    return digest ? { run: ref, digest } : unavailable;
  } finally {
    store.close();
  }
}

/** Native Sentinel read tools for the selected case's coordinator and planner. */
export const sentinelEvidenceDigestTools: readonly ToolDefinition[] = [
  {
    name: "sentinel_list_evidence_digests",
    description:
      "List saved evidence digests in the selected case and exact revision.",
    parameters: {
      revision: {
        type: "integer",
        description: "Exact evidence revision",
        required: true,
      },
      limit: { type: "integer", description: "Page size" },
      cursor: {
        type: "string",
        description: "Next continuation from this case revision",
      },
    },
  },
  {
    name: "sentinel_expand_evidence_digest",
    description: "Reopen compact evidence members from one exact saved digest.",
    parameters: {
      revision: {
        type: "integer",
        description: "Exact evidence revision",
        required: true,
      },
      digestId: {
        type: "string",
        description: "Exact digest ID",
        required: true,
      },
      limit: { type: "integer", description: "Page size" },
      cursor: {
        type: "string",
        description: "Next continuation from this digest",
      },
    },
  },
];

export function isSentinelEvidenceDigestTool(name: string) {
  return sentinelEvidenceDigestTools.some((tool) => tool.name === name);
}
