/** Read and confirm exact scheduled or delegated goal decisions from owner chat. */
import {
  type GoalCompletionRecord,
  goalConfirmationDigest,
  managedGoalClassification,
  summarizeGoalCriteria,
} from "../../../core/goal_completion.ts";
import {
  canFlowTo,
  type ClassificationLevel,
} from "../../../core/types/classification.ts";

export function createManagedGoalCommand(
  kind: "scheduler" | "delegated",
  read: (scope: string) => GoalCompletionRecord | undefined,
  confirm: (
    scope: string,
    digest: string,
    ceiling: ClassificationLevel,
  ) => Promise<GoalCompletionRecord>,
) {
  const prefix = `/goal ${kind}`;
  const commandPattern = new RegExp(
    `^${prefix} (status|confirm) ([A-Za-z0-9_.:-]{1,120})(?: ([a-f0-9]{64}))?$`,
  );
  return async (
    command: string,
    ceiling: ClassificationLevel = "PUBLIC",
  ): Promise<string | undefined> => {
    if (command !== prefix && !command.startsWith(`${prefix} `)) {
      return undefined;
    }
    const match = commandPattern.exec(command);
    if (!match || (match[1] === "status" && match[3])) {
      return `Usage: ${prefix} status <scope> or ${prefix} confirm <scope> <decisionSha256>`;
    }
    const [, action, name, digest] = match;
    if (action === "confirm" && !digest) {
      throw new Error("Confirmation requires the exact decision digest");
    }
    const scope = `${kind}:${name}`;
    const saved = read(scope);
    if (!saved) throw new Error(`Unknown configured ${kind} goal`);
    if (!canFlowTo(managedGoalClassification(saved), ceiling)) {
      throw new Error("Goal decision is unavailable at this classification");
    }
    const record = action === "confirm"
      ? await confirm(scope, digest, ceiling)
      : saved;
    return JSON.stringify({
      ...record,
      ...summarizeGoalCriteria(record),
      ...(record.policy === "operator" && record.status !== "open" && {
        confirmation: {
          scope: name,
          decisionSha256: goalConfirmationDigest(record),
        },
      }),
    });
  };
}
