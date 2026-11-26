import {
  namedConversations,
  type NamedRecordChange,
  parseDisplayName,
} from "../core/named_records.ts";
import { canFlowTo } from "../core/types/classification.ts";
import type { OperatorRunToolContext } from "./operator_run_tool.ts";
import { stopNamedConversationTurns } from "./named_conversation_turns.ts";

export const namedRecordReads = [
  "named_conversations",
] as const;
export const namedRecordActions = [
  ...namedRecordReads,
  "set_named_conversation",
  "delete_named_conversations",
] as const;

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const unavailable = "Error: The named record operation is unavailable.";

function version(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && value < Number.MAX_SAFE_INTEGER;
}

function orderedChange(
  id: string,
  args: Record<string, unknown>,
  creationNeedsName: boolean,
): NamedRecordChange | undefined {
  const { expectedVersion, displayName, pinned } = args;
  const name = parseDisplayName(displayName);
  if (
    !version(expectedVersion) || (displayName !== undefined && !name) ||
    (pinned !== undefined && typeof pinned !== "boolean") ||
    (!name && pinned === undefined) ||
    (creationNeedsName && expectedVersion === 0 && !name)
  ) return;
  return {
    id,
    expectedVersion,
    ...(name && { name }),
    ...(pinned !== undefined && { pinned }),
  };
}

export async function executeNamedRecordAction(
  baseDir: string,
  args: Record<string, unknown>,
  context: OperatorRunToolContext | undefined,
  confirm: (message: string) => Promise<boolean>,
): Promise<string> {
  const owner = context?.authenticatedOwnerSessionId;
  const authorize = context?.authorizeOwnerRunCall;
  if (
    !owner || !authorize || !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC")
  ) {
    return unavailable;
  }
  const { action, id, requestId } = args;
  const output = (payload: object) =>
    JSON.stringify({ ...payload, _classification: "INTERNAL" });
  const only = (...keys: string[]) =>
    Object.keys(args).every((key) => key === "action" || keys.includes(key));

  try {
    if (action === "named_conversations" && only("limit", "offset")) {
      const { limit = 20, offset = 0 } = args;
      if (
        !version(limit) || limit < 1 || limit > 30 || !version(offset) ||
        !await authorize(args)
      ) return unavailable;
      const records = namedConversations(baseDir).list(limit + 1, offset);
      return output({
        conversations: records.slice(0, limit),
        nextOffset: records.length > limit ? offset + limit : null,
      });
    }
    let changes: readonly NamedRecordChange[];
    if (action === "set_named_conversation") {
      if (
        typeof id !== "string" || !uuid.test(id) ||
        !only("id", "expectedVersion", "displayName", "pinned", "requestId")
      ) return unavailable;
      const change = orderedChange(id, args, true);
      if (!change) return unavailable;
      changes = [change];
    } else if (action === "delete_named_conversations") {
      if (
        !only("conversationTargets", "requestId") ||
        !Array.isArray(args.conversationTargets) ||
        !args.conversationTargets.length || args.conversationTargets.length > 12
      ) return unavailable;
      const validated: NamedRecordChange[] = [];
      for (const entry of args.conversationTargets) {
        if (
          !entry || typeof entry !== "object" ||
          Object.keys(entry).length !== 2 ||
          typeof entry.id !== "string" || !uuid.test(entry.id) ||
          entry.id === owner ||
          !version(entry.expectedVersion) || entry.expectedVersion === 0
        ) return unavailable;
        validated.push({
          id: entry.id,
          expectedVersion: entry.expectedVersion,
          deleted: true,
        });
      }
      changes = validated.sort((a, b) => a.id.localeCompare(b.id));
      if (new Set(changes.map((change) => change.id)).size !== changes.length) {
        return unavailable;
      }
    } else return unavailable;

    if (
      typeof requestId !== "string" || !uuid.test(requestId) ||
      !canFlowTo(context.inputClassification ?? "INTERNAL", "INTERNAL") ||
      !await authorize(args)
    ) return unavailable;
    const store = namedConversations(baseDir);
    const saved = store.receipt(requestId, changes);
    if (!saved) {
      if (
        !changes.every((change) =>
          (store.read(change.id)?.version ?? 0) === change.expectedVersion
        )
      ) return unavailable;
      const reviewed = await confirm(
        "Approve this exact list metadata change?\n" +
          JSON.stringify({ action, changes, requestId }),
      );
      if (!reviewed) return "Error: The operator declined the run action.";
    }
    if (!await authorize(args)) return unavailable;
    const records = saved ?? store.apply(requestId, changes);
    for (const record of records ?? []) {
      if (record.deleted) stopNamedConversationTurns(baseDir, record.id);
    }
    return records ? output({ records }) : unavailable;
  } catch {
    return unavailable;
  }
}
