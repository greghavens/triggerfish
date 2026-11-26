import {
  isSentinelTrafficPayloadByteLength,
  SENTINEL_TRAFFIC_BLOB,
  sentinelTrafficBlobArgs,
  sentinelTrafficPayloadByteLengthParameter,
  sentinelTrafficPayloadOffsetParameter,
  sentinelTrafficPayloadPartParameter,
} from "../sentinel/traffic_recovery.ts";
/** Read approved structured traffic receipts within an authorized Sentinel case. */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { ToolDefinition } from "../core/types/tool.ts";
import {
  readSentinelAssessmentRevision,
  readSentinelOperatingConstraints,
  readSentinelRunIdForRevision,
  withSentinelAssessmentWriteLock,
} from "../sentinel/assessment_store.ts";
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

type TrafficScope =
  & Pick<
    SentinelAgentOptions,
    | "snapshotPath"
    | "snapshotOverride"
    | "assessmentRevision"
    | "assignedTaskId"
    | "assignedTaskLeaseToken"
  >
  & { readonly includePayloadMetadata?: boolean };

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
    bodyContains: {
      type: "string",
      description:
        "Literal case-insensitive phrase in reviewed retained request or response text. Returns receipt metadata only.",
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

export const sentinelTrafficBlobTool: ToolDefinition = {
  name: SENTINEL_TRAFFIC_BLOB,
  description:
    "Read a page of explicitly retained, reviewed HAR body text, binary response, or headers. Use the exact case revision, evidence ID and receipt digest.",
  parameters: {
    ...sentinelTrafficGetTool.parameters,
    payloadPart: sentinelTrafficPayloadPartParameter,
    offset: sentinelTrafficPayloadOffsetParameter,
    byteLength: sentinelTrafficPayloadByteLengthParameter,
  },
};

export const sentinelTrafficTools = [
  sentinelTrafficSearchTool,
  sentinelTrafficGetTool,
  sentinelTrafficBlobTool,
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

function trafficPayloadMetadata(text: string) {
  return {
    encoding: "utf-8",
    byteLength: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

function binaryPayloadMetadata(bytes: Uint8Array) {
  return {
    encoding: "base64",
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function projectSentinelTrafficReceipt(
  receipt: SentinelTrafficReceipt,
  onlyAsset?: string,
  includePayloadMetadata = false,
) {
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
    ...(includePayloadMetadata && receipt.reviewedHeaders !== undefined && {
      headersPayload: trafficPayloadMetadata(receipt.reviewedHeaders),
    }),
    ...(includePayloadMetadata && receipt.reviewedRequestBody !== undefined && {
      requestPayload: trafficPayloadMetadata(receipt.reviewedRequestBody),
    }),
    ...(includePayloadMetadata &&
      receipt.reviewedResponseBase64 !== undefined && {
      responsePayload: binaryPayloadMetadata(
        Buffer.from(receipt.reviewedResponseBase64, "base64"),
      ),
    }),
    ...(includePayloadMetadata && receipt.reviewedResponseBody !== undefined &&
      {
        responsePayload: trafficPayloadMetadata(receipt.reviewedResponseBody),
      }),
  };
}

export function projectSentinelTrafficBlob(
  receipt: SentinelTrafficReceipt,
  payloadPart: unknown,
  offset: unknown = 0,
  byteLength?: unknown,
) {
  if (
    (byteLength !== undefined &&
      !isSentinelTrafficPayloadByteLength(byteLength)) ||
    typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 ||
    (payloadPart !== "request" && payloadPart !== "response" &&
      payloadPart !== "headers")
  ) return "Error: Select a retained payload part and a valid offset.";
  if (
    payloadPart === "response" && receipt.reviewedResponseBase64 !== undefined
  ) {
    const bytes = Buffer.from(receipt.reviewedResponseBase64, "base64");
    if (offset > bytes.length) {
      return "Error: Traffic payload offset is unavailable.";
    }
    const end = Math.min(bytes.length, offset + (byteLength ?? 512));
    return {
      responsePayload: binaryPayloadMetadata(bytes),
      offset,
      ...(byteLength !== undefined && { offsetUnit: "bytes" }),
      base64: bytes.subarray(offset, end).toString("base64"),
      nextOffset: end < bytes.length ? end : null,
    };
  }
  const text = payloadPart === "request"
    ? receipt.reviewedRequestBody
    : payloadPart === "headers"
    ? receipt.reviewedHeaders
    : receipt.reviewedResponseBody;
  if (text === undefined) {
    return `Error: Reviewed ${payloadPart} content is unavailable for this exact receipt.`;
  }
  const descriptor = trafficPayloadMetadata(text);
  const metadata = payloadPart === "request"
    ? { requestPayload: descriptor }
    : payloadPart === "headers"
    ? { headersPayload: descriptor }
    : { responsePayload: descriptor };
  if (byteLength !== undefined) {
    const bytes = Buffer.from(text, "utf8");
    const continuation = (index: number) => (bytes[index] & 0xc0) === 0x80;
    if (
      offset > bytes.length || (offset < bytes.length && continuation(offset))
    ) {
      return "Error: Traffic payload byte offset must be at a UTF-8 character boundary.";
    }
    let end = Math.min(bytes.length, offset + byteLength);
    while (end < bytes.length && end > offset && continuation(end)) end--;
    if (end === offset && offset < bytes.length) {
      return "Error: The byte range is too short for the next UTF-8 character.";
    }
    return {
      ...metadata,
      offset,
      offsetUnit: "bytes",
      text: bytes.subarray(offset, end).toString("utf8"),
      nextOffset: end < bytes.length ? end : null,
    };
  }
  const body = Array.from(text);
  if (offset > body.length) {
    return "Error: Traffic payload offset is unavailable.";
  }
  const end = Math.min(body.length, offset + 512);
  return {
    ...metadata,
    offset,
    text: body.slice(offset, end).join(""),
    nextOffset: end < body.length ? end : null,
  };
}

/** Intersect the original revision and current case asset boundaries. */
export function readSentinelTrafficAssetScope(path: string, revision: number) {
  const runId = readSentinelRunIdForRevision(path, revision);
  const snapshot = readSentinelAssessmentRevision(path, revision)?.result
    .sharedGraph.snapshot;
  if (!runId || !snapshot) return;
  const saved = readSentinelOperatingConstraints(path, runId, revision)
    ?.constraints;
  const current = readSentinelOperatingConstraints(path, runId)?.constraints;
  const priorAssets = saved?.allowedAssetIds && new Set(saved.allowedAssetIds);
  const currentAssets = current?.allowedAssetIds &&
    new Set(current.allowedAssetIds);
  const denied = saved?.deniedKinds.includes("review_evidence") ||
    current?.deniedKinds.includes("review_evidence");
  return {
    runId,
    snapshot,
    assets: new Set(
      denied
        ? []
        : snapshot.nodes.flatMap((node) =>
          node.kind === "asset" && (!priorAssets || priorAssets.has(node.id)) &&
            (!currentAssets || currentAssets.has(node.id))
            ? [node.id]
            : []
        ),
    ),
  };
}

export function currentSentinelNativeTrafficRead(
  path: string,
  revision: number,
  response: string,
) {
  const scope = readSentinelTrafficAssetScope(path, revision);
  const caseId = locateSentinelCase(path)?.caseId;
  const page = JSON.parse(response);
  if (
    !scope || !caseId || page.caseId !== caseId ||
    page.evidenceRevision !== revision
  ) return false;
  const ids: readonly unknown[] = Array.isArray(page.receipts)
    ? page.receipts.map(({ evidenceId }: SentinelTrafficReceipt) => evidenceId)
    : [page.receipt?.evidenceId ?? page.evidenceId];
  return ids.every((evidenceId) => {
    const targets = scope.snapshot.edges.flatMap(({ from, relation, to }) =>
      from === evidenceId && relation === "observed_on" ? [to] : []
    );
    return targets.length > 0 && targets.every((id) => scope.assets.has(id));
  });
}

export function readProjectedSentinelTrafficReceipt(
  snapshotPath: string,
  caseId: string,
  revision: number,
  exact: { evidenceId: string; digest: string },
  onlyAsset?: string,
  includePayloadMetadata = false,
) {
  const scope = readSentinelTrafficAssetScope(snapshotPath, revision);
  if (!scope) return;
  const receipt = readSentinelTrafficReceipt(
    snapshotPath,
    revision,
    exact,
    onlyAsset,
    scope.assets,
  );
  return receipt && {
    caseId,
    evidenceRevision: revision,
    _classification: "INTERNAL",
    receipt: projectSentinelTrafficReceipt(
      receipt,
      onlyAsset,
      includePayloadMetadata,
    ),
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

export function readProjectedSentinelTrafficPage(
  snapshotPath: string,
  revision: number,
  args: Record<string, unknown>,
  onlyAsset?: string,
  includePayloadMetadata = false,
) {
  const query = searchArgs(args, onlyAsset);
  const scope = readSentinelTrafficAssetScope(snapshotPath, revision);
  const page = query && scope &&
    readSentinelTrafficReceiptPage(snapshotPath, revision, query, scope.assets);
  return page && {
    receipts: page.receipts.map((receipt) =>
      projectSentinelTrafficReceipt(receipt, onlyAsset, includePayloadMetadata)
    ),
    nextCursor: page.nextCursor,
  };
}

export function reopenProjectedSentinelTrafficPage(
  path: string,
  caseId: string,
  revision: number,
  args: Record<string, unknown>,
  assetId: string,
) {
  const page = readProjectedSentinelTrafficPage(path, revision, args, assetId);
  const result = page && JSON.stringify({
    caseId,
    evidenceRevision: revision,
    _classification: "INTERNAL",
    ...page,
  });
  return result && result.length <= 6000 ? result : undefined;
}

export function reopenProjectedSentinelTrafficBlob(
  path: string,
  caseId: string,
  revision: number,
  args: NonNullable<ReturnType<typeof sentinelTrafficBlobArgs>>,
  assetId?: string,
) {
  const scope = readSentinelTrafficAssetScope(path, revision);
  if (args.revision !== revision || !scope) return;
  const { evidenceId, digest, payloadPart, offset, byteLength } = args;
  const receipt = readSentinelTrafficReceipt(
    path,
    revision,
    {
      evidenceId,
      digest,
    },
    assetId,
    scope.assets,
  );
  if (!receipt) return;
  const page = projectSentinelTrafficBlob(
    receipt,
    payloadPart,
    offset,
    byteLength,
  );
  if (typeof page === "string") return;
  const output = JSON.stringify({
    caseId,
    evidenceRevision: revision,
    _classification: "INTERNAL",
    evidenceId,
    digest,
    ...page,
  });
  return output.length <= 6000 ? output : undefined;
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
        const page = readProjectedSentinelTrafficPage(
          snapshotPath,
          revision,
          args,
          onlyAsset,
          scope.includePayloadMetadata,
        );
        if (!page) {
          return "Error: The traffic query, cursor or saved evidence scope is unavailable.";
        }
        result = { ...envelope, ...page };
      } else if (name === sentinelTrafficBlobTool.name) {
        const selector = sentinelTrafficBlobArgs(args);
        if (!selector) {
          return "Error: Provide the exact traffic evidence ID, receipt digest, and valid offset.";
        }
        return reopenProjectedSentinelTrafficBlob(
          snapshotPath,
          caseId,
          revision,
          selector,
          onlyAsset,
        ) ??
          `Error: Reviewed ${selector.payloadPart} content is unavailable for this exact receipt.`;
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
        result = readProjectedSentinelTrafficReceipt(
          snapshotPath,
          caseId,
          revision,
          {
            evidenceId,
            digest,
          },
          onlyAsset,
          scope.includePayloadMetadata,
        );
        if (!result) {
          return "Error: That retained traffic receipt is unavailable in this scope.";
        }
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
