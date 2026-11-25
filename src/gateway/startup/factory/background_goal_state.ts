/** Project only the goal criteria and retained receipts authorized for this turn. */
import type { MessageStore } from "../../../core/conversation/mod.ts";
import type { GoalCompletionRecord } from "../../../core/goal_completion.ts";
import { computeContentHash } from "../../../core/session/lineage_serde.ts";
import {
  canFlowTo,
  type ClassificationLevel,
  maxClassification,
} from "../../../core/types/classification.ts";
import type { SavedSourceAuthorization } from "../../../core/types/orchestrator.ts";
import type { ToolDefinition } from "../../../core/types/tool.ts";

export const backgroundGoalUnavailable =
  "Error: Background goal state is unavailable.";
export const backgroundGoalStateTool: ToolDefinition = {
  name: "background_goal_state",
  description:
    "Read your configured goal criteria and the exact evidence verified in this turn.",
  parameters: {
    scope: {
      type: "string",
      description: "Exact configured goal scope",
      required: true,
    },
    offset: {
      type: "integer",
      description: "First role-scoped criterion to read",
    },
    limit: {
      type: "integer",
      description: "Maximum criteria to read, up to eight",
    },
  },
};

export function backgroundGoalStateArgs(args: Record<string, unknown>) {
  const { scope, offset = 0, limit = 8 } = args;
  if (
    Object.keys(args).some((key) =>
      !Object.hasOwn(backgroundGoalStateTool.parameters, key)
    ) ||
    typeof scope !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(scope) ||
    typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 ||
    typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
    limit > 8
  ) return;
  return { scope, offset, limit };
}

export async function projectBackgroundGoalState(options: {
  readonly args: NonNullable<ReturnType<typeof backgroundGoalStateArgs>>;
  readonly record: GoalCompletionRecord;
  readonly criteria: readonly {
    id: string;
    tool: string;
    resultSha256: string;
  }[];
  readonly messages: MessageStore;
  readonly sessionId: string;
  readonly after: number;
  readonly source: string;
  readonly ceiling: ClassificationLevel;
  readonly current: () => boolean;
  readonly authorization: SavedSourceAuthorization;
}): Promise<string> {
  const {
    args,
    record,
    criteria,
    messages,
    sessionId,
    after,
    source,
    ceiling,
    current,
    authorization,
  } = options;
  if (!current() || !criteria.length) return backgroundGoalUnavailable;
  try {
    const rows = await messages.loadSession(sessionId);
    const prefix = `${sessionId}:`;
    let classification: ClassificationLevel = "PUBLIC";
    const page = [];
    for (
      const criterion of criteria.slice(args.offset, args.offset + args.limit)
    ) {
      const stored = record.observations.find(({ criterionId }) =>
        criterionId === criterion.id
      );
      let evidence;
      for (const proof of stored?.evidence ?? []) {
        if (!current() || authorization.signal?.aborted) {
          return backgroundGoalUnavailable;
        }
        if (
          proof.source !== source || !proof.reference.startsWith(prefix) ||
          !proof.classification || !canFlowTo(proof.classification, ceiling)
        ) continue;
        const messageId = proof.reference.slice(prefix.length);
        const row = rows.find(({ session_id, message_id }) =>
          session_id === sessionId && message_id === messageId
        );
        if (
          !row || row.sequence <= after || row.role !== "tool_call" ||
          row.tool_name !== criterion.tool ||
          row.classification !== proof.classification ||
          await computeContentHash(row.content) !== criterion.resultSha256 ||
          !await authorization.authorizeSavedCall(
            { name: criterion.tool, args: row.tool_args ?? {} },
            row.classification,
          ) ||
          !await authorization.authorizeSavedResponse(
            criterion.tool,
            row.content,
            row.classification,
          )
        ) continue;
        classification = maxClassification(classification, row.classification);
        evidence = {
          source: proof.source,
          reference: proof.reference,
          classification: row.classification,
        };
        break;
      }
      page.push({
        id: criterion.id,
        tool: criterion.tool,
        ...(evidence && { evidence }),
      });
    }
    if (!current() || authorization.signal?.aborted) {
      return backgroundGoalUnavailable;
    }
    return JSON.stringify({
      scope: args.scope,
      criteria: page,
      satisfied: page.filter(({ evidence }) => evidence).map(({ id }) => id),
      open: page.filter(({ evidence }) => !evidence).map(({ id }) => id),
      nextOffset: args.offset + page.length < criteria.length
        ? args.offset + page.length
        : null,
      _classification: classification,
    });
  } catch {
    return backgroundGoalUnavailable;
  }
}
