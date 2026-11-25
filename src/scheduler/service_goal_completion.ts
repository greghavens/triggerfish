/** Report verified evidence from scheduler runs through configured source bindings. */
import type { GoalCompletionStore } from "../core/goal_completion.ts";
import { createLogger } from "../core/logger/mod.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";

type Report = GoalCompletionStore["report"];
type Observation = Parameters<Report>[1][number];
type Evidence = Observation["evidence"][number];

export type SchedulerGoalSource = {
  readonly kind: "cron" | "trigger" | "webhook";
  readonly sourceId: string;
};

export interface SchedulerGoalCompletionBinding extends SchedulerGoalSource {
  readonly scope: string;
  readonly criterionId: string;
}

export interface SchedulerGoalCompletionConfig {
  readonly store: Pick<GoalCompletionStore, "report">;
  readonly bindings: readonly SchedulerGoalCompletionBinding[];
  /** Resolve evidence recorded for the exact runtime session and configured binding. */
  readonly readEvidence: (
    invocation: SchedulerGoalCompletionBinding & {
      readonly sessionId: string;
      readonly classification: ClassificationLevel;
      readonly afterSequence?: number;
    },
  ) => Promise<
    readonly Pick<Evidence, "reference" | "detail" | "classification">[]
  >;
  /** Revalidate newly reported and retained evidence before the transaction. */
  readonly prepareVerification: (
    scope: string,
    observations: readonly Observation[],
  ) => Promise<Parameters<Report>[2]>;
}

const log = createLogger("scheduler");
const scopeReports = new WeakMap<
  SchedulerGoalCompletionConfig,
  Map<string, Promise<unknown>>
>();

export async function serializeSchedulerGoalReport<T>(
  completion: SchedulerGoalCompletionConfig,
  scope: string,
  operation: () => Promise<T>,
): Promise<T> {
  let reports = scopeReports.get(completion);
  if (!reports) {
    reports = new Map();
    scopeReports.set(completion, reports);
  }
  const previous = reports.get(scope)?.catch(() => undefined) ??
    Promise.resolve();
  const report = previous.then(operation);
  reports.set(scope, report);
  try {
    return await report;
  } finally {
    if (reports.get(scope) === report) reports.delete(scope);
  }
}

export function reportPreparedSchedulerGoal(
  completion: SchedulerGoalCompletionConfig,
  scope: string,
  observations: readonly Observation[],
  operatorConfirmed = false,
  isCurrent?: () => boolean,
): Promise<ReturnType<Report>> {
  return serializeSchedulerGoalReport(completion, scope, async () => {
    const verify = await completion.prepareVerification(scope, observations);
    if (isCurrent?.() === false) {
      throw new Error("Scheduled goal reporting is no longer active.");
    }
    return completion.store.report(
      scope,
      observations,
      verify,
      operatorConfirmed,
    );
  });
}

export async function reportSchedulerGoalEvidence(
  completion: SchedulerGoalCompletionConfig,
  invocation: SchedulerGoalSource & {
    readonly sessionId: string;
    readonly classification: ClassificationLevel;
  },
): Promise<void> {
  const { kind, sourceId, sessionId, classification } = invocation;
  const byScope = new Map<string, Map<string, Evidence[]>>();
  for (const binding of completion.bindings) {
    if (binding.kind !== kind || binding.sourceId !== sourceId) continue;
    try {
      const candidates = await completion.readEvidence({
        ...binding,
        sessionId,
        classification,
      });
      if (!candidates.length) continue;
      const criteria = byScope.get(binding.scope) ??
        new Map<string, Evidence[]>();
      const evidence = criteria.get(binding.criterionId) ?? [];
      for (const { reference, detail, classification } of candidates) {
        evidence.push({
          source: `scheduler:${kind}:${sourceId}`,
          reference,
          detail,
          ...(classification !== undefined && { classification }),
        });
      }
      criteria.set(binding.criterionId, evidence);
      byScope.set(binding.scope, criteria);
    } catch {
      log.warn("Scheduled goal evidence could not be read");
    }
  }
  for (const [scope, criteria] of byScope) {
    const observations = [...criteria].map(([criterionId, evidence]) => ({
      criterionId,
      evidence,
    }));
    try {
      await reportPreparedSchedulerGoal(completion, scope, observations);
    } catch {
      log.warn("Scheduled goal evidence could not be committed");
    }
  }
}
