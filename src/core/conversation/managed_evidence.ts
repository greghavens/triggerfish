import type { SavedSourceAuthorization } from "../types/orchestrator.ts";
import type { ConversationRecord } from "./conversation_types.ts";
/** Approved identity fields for reauthorizing a local managed-goal proof. */
import {
  canFlowTo,
  type ClassificationLevel,
  parseClassification,
} from "../types/classification.ts";

export interface ManagedTranscriptIdentity {
  readonly source: string;
  readonly channelId: string;
  readonly createdAt: string;
  readonly isTrigger: boolean;
  readonly ceiling: ClassificationLevel | null;
  readonly observationGrantDigest?: string;
}

export function validManagedTranscriptIdentity(
  value: ManagedTranscriptIdentity | undefined,
): value is ManagedTranscriptIdentity {
  return !!value &&
    /^(?:delegated:(?:subagent|team)|scheduler:(?:trigger|cron|webhook):[A-Za-z0-9_.:-]{1,120})$/
      .test(value.source) &&
    typeof value.channelId === "string" &&
    /^[A-Za-z0-9_.:-]{1,180}$/.test(value.channelId) &&
    typeof value.createdAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.isTrigger === "boolean" &&
    (value.ceiling === null || parseClassification(value.ceiling).ok) &&
    (value.observationGrantDigest === undefined ||
      (value.source.startsWith("scheduler:") &&
        /^[0-9a-f]{64}$/.test(value.observationGrantDigest)));
}

/** Reject legacy or redacted rows that cannot reproduce the original typed call. */
export function isManagedChecklistProof(
  source: string,
  row: ConversationRecord,
): boolean {
  return row.role === "tool_call" && row.tool_name === "todo_read" &&
    !!row.tool_args && Object.keys(row.tool_args).length === 0 &&
    validManagedTranscriptIdentity(row.managedTranscriptIdentity) &&
    row.managedTranscriptIdentity.source === source &&
    parseClassification(row.classification).ok;
}

export type ManagedTranscriptGrantReader = (
  source: string,
  grantDigest: string,
  authorization: SavedSourceAuthorization,
) => Promise<
  {
    readonly result: string;
    readonly current: () => boolean;
  } | undefined
>;

/** Only an exact, approved scheduled observation grant can use the transcript seam. */
export function isManagedObservationProof(
  source: string,
  row: ConversationRecord,
): boolean {
  return row.role === "tool_call" &&
    row.tool_name === "read_committed_observation" &&
    !!row.tool_args && Object.keys(row.tool_args).length === 0 &&
    validManagedTranscriptIdentity(row.managedTranscriptIdentity) &&
    row.managedTranscriptIdentity.source === source &&
    !!row.managedTranscriptIdentity.observationGrantDigest &&
    row.managedTranscriptIdentity.isTrigger &&
    parseClassification(row.classification).ok &&
    canFlowTo("INTERNAL", row.classification);
}
