/** Restore only the exact derived goal status authorized for this execution. */
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "@std/path";
import { committedRecoverySelectors } from "../../../core/committed_recovery_evidence.ts";
import { openExecutionTraces } from "../../../core/execution_traces.ts";
import { GoalCompletionStore } from "../../../core/goal_completion.ts";
import type { SavedSourceAuthorization } from "../../../core/types/orchestrator.ts";
import {
  backgroundGoalStateArgs,
  backgroundGoalUnavailable,
} from "./background_goal_state.ts";
import {
  findRecoveredGoalTrace,
  parseRecoveredGoalReport,
  readRecoveredGoalReport,
} from "./recovered_goal_reporting.ts";

export interface RecoveredGoalStateScope {
  readonly baseDir: string;
  readonly family: "delegated" | "scheduler";
  readonly executionId: string;
  readonly sessionId: string;
  readonly source: string;
  readonly traceSource?: string;
  readonly current: () => Promise<boolean>;
  readonly criteria: (scope: string) => readonly {
    id: string;
    tool: string;
    resultSha256: string;
  }[];
}

const active = new AsyncLocalStorage<
  RecoveredGoalStateScope & { emitted: Set<string> }
>();

export const withRecoveredGoalState = <T>(
  scope: RecoveredGoalStateScope,
  run: () => Promise<T>,
) => active.run({ ...scope, emitted: new Set() }, run);

/** Only persist a response just constructed by the scoped reader. */
export function projectEmittedGoalState(text: string): string | undefined {
  return text === backgroundGoalUnavailable ||
      active.getStore()?.emitted.has(text)
    ? text
    : undefined;
}

export async function readRecoveredGoalState(
  args: Record<string, unknown>,
  authorization: SavedSourceAuthorization,
  beforeBatch?: number,
): Promise<string> {
  const scope = active.getStore();
  const query = backgroundGoalStateArgs(args);
  if (!scope || !query) return backgroundGoalUnavailable;
  const { baseDir, family, executionId, sessionId, source } = scope;
  const role = family === "scheduler" ? "scheduled" : "delegated";
  const current = async () =>
    !authorization.signal?.aborted && await scope.current() &&
    !authorization.signal?.aborted;
  try {
    const criteria = scope.criteria(query.scope);
    if (!criteria.length || !await current()) return backgroundGoalUnavailable;
    const selectors = committedRecoverySelectors(
      executionId,
      sessionId,
      family === "scheduler"
        ? "scheduled_goal_report"
        : "delegated_goal_report",
      beforeBatch,
    );
    if (!selectors) return backgroundGoalUnavailable;
    const journal = openExecutionTraces(join(baseDir, "execution-traces.db"));
    let traceSource;
    try {
      const run = journal.readRun(role, executionId, "INTERNAL");
      if (
        run?.status !== "running" || run.operatorCancelled ||
        run.scope.sessionId !== sessionId || !run.scope.sourceId ||
        (scope.traceSource !== undefined &&
          scope.traceSource !== run.scope.sourceId)
      ) return backgroundGoalUnavailable;
      traceSource = run.scope.sourceId;
    } finally {
      journal.close();
    }
    const goalScope = `${family}:${query.scope}`;
    const store = new GoalCompletionStore(join(baseDir, "goal-completion.db"));
    let goal;
    try {
      goal = store.read(goalScope);
    } finally {
      store.close();
    }
    if (!goal || goal.policy !== "operator") return backgroundGoalUnavailable;
    const page = [];
    for (
      const { id, tool, resultSha256 } of criteria.slice(
        query.offset,
        query.offset + query.limit,
      )
    ) {
      let evidence;
      for (const selector of selectors) {
        const report = parseRecoveredGoalReport(selector);
        if (
          !report || report.scope !== query.scope || report.criterion !== id
        ) continue;
        const saved = readRecoveredGoalReport(
          baseDir,
          executionId,
          sessionId,
          selector,
          family,
        );
        if (!saved) continue;
        const reference = JSON.parse(saved).evidenceReference;
        if (
          !goal.observations.some((entry) =>
            entry.criterionId === id &&
            entry.evidence.some((proof) =>
              proof.source === source && proof.reference === reference &&
              proof.classification === "INTERNAL"
            )
          )
        ) continue;
        const exact = await findRecoveredGoalTrace(
          baseDir,
          {
            role,
            executionId,
            sessionId,
            sourceId: traceSource,
            callId: report.sourceCallId,
          },
          { tool, resultSha256 },
          authorization,
        );
        if (
          exact &&
          `${executionId}:${exact.ordinal}:${exact.id}` === reference &&
          exact.recordedAt >= goal.createdAt
        ) {
          evidence = {
            source,
            reference,
            classification: exact.classification,
          };
          break;
        }
      }
      page.push({ id, tool, ...(evidence && { evidence }) });
    }
    if (!await current()) return backgroundGoalUnavailable;
    const text = JSON.stringify({
      scope: query.scope,
      criteria: page,
      satisfied: page.filter(({ evidence }) => evidence).map(({ id }) => id),
      open: page.filter(({ evidence }) => !evidence).map(({ id }) => id),
      nextOffset: query.offset + page.length < criteria.length
        ? query.offset + page.length
        : null,
      _classification: "INTERNAL",
    });
    if (beforeBatch === undefined) scope.emitted.add(text);
    return text;
  } catch {
    return backgroundGoalUnavailable;
  }
}
