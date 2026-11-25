/** Read approved structured traffic receipts within an authorized Sentinel case. */
import type { ToolDefinition } from "../core/types/tool.ts";
import { withSentinelAssessmentWriteLock } from "../sentinel/assessment_store.ts";
import { locateSentinelCase } from "../sentinel/cases.ts";
import {
  readSentinelTrafficReceipt,
  readSentinelTrafficReceiptPage,
  type SentinelTrafficReceipt,
  type SentinelTrafficReceiptQuery,
  sentinelTrafficSources,
} from "../sentinel/traffic_receipts.ts";
import type { SentinelAgentOptions } from "./sentinel_agent.ts";
import { readAssignedSentinelModelReview } from "./sentinel_adaptive_runtime.ts";

type TrafficScope = Pick<
  SentinelAgentOptions,
  | "snapshotPath"
  | "snapshotOverride"
  | "assessmentRevision"
  | "assignedTaskId"
  | "assignedTaskLeaseToken"
>;

const revisionParameter = {
  type: "integer",
  description: "Exact saved case evidence revision",
  required: true,
} as const;

export const sentinelTrafficSearchTool: ToolDefinition = {
  name: "sentinel_traffic_search",
  description:
    "Read a page of retained, sanitized HTTP or DNS observations linked to an exact saved case revision. Workers are restricted to their assigned asset.",
  parameters: {
    revision: revisionParameter,
    assetId: { type: "string", description: "Exact observed asset ID" },
    family: {
      type: "string",
      description: "Exact ingestion format",
      enum: sentinelTrafficSources,
    },
    evidenceId: { type: "string", description: "Exact traffic evidence ID" },
    origin: {
      type: "string",
      description: "Exact HTTP origin without path or credentials",
    },
    hostname: { type: "string", description: "Exact normalized DNS hostname" },
    method: { type: "string", description: "Exact normalized HTTP method" },
    status: { type: "integer", description: "Exact HTTP status" },
    from: {
      type: "string",
      description: "Inclusive UTC timestamp in ISO format with milliseconds",
    },
    until: {
      type: "string",
      description: "Exclusive UTC timestamp in ISO format with milliseconds",
    },
    limit: { type: "integer", description: "Page size from 1 to 10" },
    cursor: {
      type: "string",
      description:
        "Opaque continuation cursor for this case, revision and filters",
    },
  },
};

export const sentinelTrafficGetTool: ToolDefinition = {
  name: "sentinel_traffic_get",
  description:
    "Reopen an exact retained sanitized traffic observation by evidence ID and digest in the saved case revision.",
  parameters: {
    revision: revisionParameter,
    evidenceId: {
      type: "string",
      description: "Exact traffic evidence ID",
      required: true,
    },
    digest: {
      type: "string",
      description: "Exact traffic receipt digest returned by search",
      required: true,
    },
  },
};

export const sentinelTrafficTools = [
  sentinelTrafficSearchTool,
  sentinelTrafficGetTool,
];

export function isSentinelTrafficTool(name: string): boolean {
  return sentinelTrafficTools.some((tool) => tool.name === name);
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function sentinelTrafficPolicyRevision(
  value: unknown,
): number | undefined {
  return validRevision(value) ? value : undefined;
}

function approvedReceipt(receipt: SentinelTrafficReceipt, onlyAsset?: string) {
  const { digest, family, evidenceId, assetIds, observation } = receipt;
  const metadata = "origin" in observation
    ? {
      origin: observation.origin,
      method: observation.method,
      status: observation.status,
      ...(observation.startedAt && { startedAt: observation.startedAt }),
    }
    : {
      hostname: observation.hostname,
      addresses: observation.addresses,
      timestamp: observation.timestamp,
    };
  return {
    digest,
    family,
    evidenceId,
    assetIds: onlyAsset ? [onlyAsset] : assetIds,
    observation: metadata,
  };
}

function searchArgs(args: Record<string, unknown>, onlyAsset?: string) {
  const { revision: _revision, limit = 5, status, ...text } = args;
  if (
    typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
    limit > 10 ||
    (status !== undefined &&
      (typeof status !== "number" || !Number.isSafeInteger(status))) ||
    Object.entries(text).some(([key, value]) =>
      !Object.hasOwn(sentinelTrafficSearchTool.parameters, key) ||
      (value !== undefined &&
        (typeof value !== "string" || value.length > 512 || !value.trim()))
    ) || (onlyAsset && text.assetId !== undefined && text.assetId !== onlyAsset)
  ) return undefined;
  return {
    ...text,
    status,
    limit,
    assetId: onlyAsset ?? text.assetId,
  } as SentinelTrafficReceiptQuery;
}

export function executeSentinelTrafficTool(
  scope: TrafficScope,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): string {
  const {
    snapshotPath,
    snapshotOverride,
    assessmentRevision,
    assignedTaskId,
    assignedTaskLeaseToken,
  } = scope;
  const revision = args.revision;
  if (
    !validRevision(revision) ||
    (assessmentRevision !== undefined && assessmentRevision !== revision) ||
    (snapshotOverride !== undefined && assessmentRevision === undefined)
  ) {
    return "Error: Traffic queries require an exact authorized saved evidence revision.";
  }
  try {
    const caseId = locateSentinelCase(snapshotPath)?.caseId;
    if (!caseId || signal?.aborted) {
      return "Error: Retained traffic is unavailable for that scope.";
    }
    // Lock revision writers until the exact lease and retained projection have been checked.
    return withSentinelAssessmentWriteLock(snapshotPath, (state) => {
      const assigned = assignedTaskId !== undefined ||
        assignedTaskLeaseToken !== undefined;
      const onlyAsset = assigned && assignedTaskId && assignedTaskLeaseToken
        ? readAssignedSentinelModelReview(
          snapshotPath,
          revision,
          assignedTaskId,
          assignedTaskLeaseToken,
        )?.nodeId
        : undefined;
      if (
        !state || (assigned && (!onlyAsset ||
          !state.result?.sharedGraph.snapshot?.nodes.some(({ id, kind }) =>
            id === onlyAsset && kind === "asset"
          )))
      ) {
        return "Error: Retained traffic requires the current exact asset assignment.";
      }
      const envelope = {
        caseId,
        evidenceRevision: revision,
        _classification: "INTERNAL",
      };
      let result: unknown;
      if (name === sentinelTrafficSearchTool.name) {
        const query = searchArgs(args, onlyAsset);
        const page = query &&
          readSentinelTrafficReceiptPage(snapshotPath, revision, query);
        if (!page) {
          return "Error: The traffic query, cursor or saved evidence scope is unavailable.";
        }
        result = {
          ...envelope,
          receipts: page.receipts.map((receipt) =>
            approvedReceipt(receipt, onlyAsset)
          ),
          nextCursor: page.nextCursor,
        };
      } else if (name === sentinelTrafficGetTool.name) {
        const { evidenceId, digest } = args;
        if (
          Object.keys(args).some((key) =>
            !Object.hasOwn(sentinelTrafficGetTool.parameters, key)
          ) ||
          typeof evidenceId !== "string" || evidenceId.length > 100 ||
          typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)
        ) {
          return "Error: Provide the exact traffic evidence ID and receipt digest.";
        }
        const receipt = readSentinelTrafficReceipt(snapshotPath, revision, {
          evidenceId,
          digest,
        }, onlyAsset);
        if (!receipt) {
          return "Error: That retained traffic receipt is unavailable in this scope.";
        }
        result = { ...envelope, receipt: approvedReceipt(receipt, onlyAsset) };
      } else return "Error: Unknown retained traffic query.";
      if (signal?.aborted) return "Error: Retained traffic query cancelled.";
      const encoded = JSON.stringify(result);
      return encoded.length <= 6000
        ? encoded
        : "Error: Reduce the traffic page size or use an exact evidence filter.";
    });
  } catch {
    return "Error: The retained traffic evidence scope is unavailable.";
  }
}
