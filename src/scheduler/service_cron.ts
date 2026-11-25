/**
 * Scheduler cron execution — runs cron jobs in isolated orchestrator
 * sessions and records execution history.
 *
 * @module
 */

import { createHash } from "node:crypto";
import type { Result } from "../core/types/classification.ts";
import type {
  SchedulerCronAdmission,
  SchedulerCronAdmissions,
} from "./cron/admissions.ts";
import type { CronJob } from "./cron/parser.ts";
import type { CronManager } from "./cron/parser.ts";
import type {
  SchedulerExecutionIdentity,
  SchedulerServiceConfig,
} from "./service_types.ts";
import { matchesNow, parseCronExpression } from "./cron/cron.ts";
import { createLogger } from "../core/logger/mod.ts";
import { deliverSchedulerOutput } from "./service_output.ts";
import { reportSchedulerGoalEvidence } from "./service_goal_completion.ts";
import {
  createScheduledAgent,
  runSchedulerOccurrence,
  schedulerExecutionIdentity,
} from "./service_execution.ts";

const log = createLogger("scheduler");

/** Token usage shape returned by the orchestrator. */
interface TokenUsageResult {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Options for recording a cron execution result. */
interface CronRecordOptions {
  readonly cronManager: CronManager;
  readonly jobId: string;
  readonly startTime: number;
}

/** Bundled context for executing a single cron job. */
interface CronJobContext {
  readonly config: SchedulerServiceConfig;
  readonly cronManager: CronManager;
  readonly job: CronJob;
  readonly execution?: SchedulerExecutionIdentity;
  readonly closeAdmission?: () => boolean;
}

/** Log token usage from an orchestrator result. */
export function logSchedulerTokenUsage(
  source: string,
  result: Result<
    {
      readonly response: string;
      readonly tokenUsage: TokenUsageResult;
    },
    string
  >,
): void {
  if (!result.ok) return;
  const { inputTokens, outputTokens } = result.value.tokenUsage;
  log.info(
    `[${source}] Token usage — input: ${inputTokens}, output: ${outputTokens}, total: ${
      inputTokens + outputTokens
    }`,
  );
}

/** Record a cron execution result in the cron manager. */
function recordCronExecution(
  opts: CronRecordOptions,
  result: Result<{ readonly response: string }, string>,
): void {
  opts.cronManager.recordExecution({
    jobId: opts.jobId,
    executedAt: new Date(),
    durationMs: performance.now() - opts.startTime,
    success: result.ok,
    error: result.ok ? undefined : result.error,
  });
}

/** Record a failed cron execution from an unhandled error. */
function recordCronFailure(opts: CronRecordOptions, err: unknown): void {
  opts.cronManager.recordExecution({
    jobId: opts.jobId,
    executedAt: new Date(),
    durationMs: performance.now() - opts.startTime,
    success: false,
    error: err instanceof Error ? err.message : String(err),
  });
}

/** Execute a single cron job in an isolated session. */
async function executeCronJob(ctx: CronJobContext): Promise<void> {
  const { config, cronManager, job } = ctx;
  log.info(`Executing cron job: ${job.id}`);
  const startTime = performance.now();
  const recordOpts: CronRecordOptions = {
    cronManager,
    jobId: job.id,
    startTime,
  };
  try {
    // The job's classification ceiling is an enforced read ceiling for the
    // session, not just an output gate (SCHEDULER-1).
    const { orchestrator, session, getSessionTaint } =
      await createScheduledAgent(
        config,
        "cron",
        { ceiling: job.classificationCeiling },
        ctx.execution,
      );
    const result = await orchestrator.executeAgentTurn({
      session,
      message: job.task,
      targetClassification: job.classificationCeiling,
    });
    if (ctx.closeAdmission && !ctx.closeAdmission()) return;
    if (config.recoverTurn && ctx.execution && !result.ok) return;
    if (config.goalCompletion) {
      await reportSchedulerGoalEvidence(config.goalCompletion, {
        kind: "cron",
        sourceId: job.id,
        sessionId: session.id,
        classification: getSessionTaint(),
      });
    }
    logSchedulerTokenUsage(`cron:${job.id}`, result);
    await deliverSchedulerOutput({
      config,
      result,
      // Live taint after the turn — the session snapshot is stale (GATEWAY-1).
      sessionTaint: getSessionTaint(),
      source: `cron:${job.id}`,
    });
    recordCronExecution(recordOpts, result);
  } catch (err) {
    if (ctx.closeAdmission && !ctx.closeAdmission()) return;
    recordCronFailure(recordOpts, err);
  }
}

function promptDigest(job: CronJob): string {
  return createHash("sha256").update(job.task).digest("hex");
}

function matchesAdmission(
  admission: SchedulerCronAdmission,
  job: CronJob | undefined,
): job is CronJob {
  if (
    !job?.enabled || admission.jobId !== job.id ||
    admission.classificationCeiling !== job.classificationCeiling ||
    admission.promptSha256 !== promptDigest(job)
  ) return false;
  const schedule = parseCronExpression(job.expression);
  return schedule.ok &&
    matchesNow(schedule.value, new Date(admission.occurrence * 60_000));
}

function executeCronAdmission(
  config: SchedulerServiceConfig,
  cronManager: CronManager,
  admissions: SchedulerCronAdmissions,
  candidate: SchedulerCronAdmission,
) {
  const execution = schedulerExecutionIdentity(
    "cron",
    candidate.jobId,
    candidate.occurrence,
  );
  void runSchedulerOccurrence(config, execution, async () => {
    try {
      const claim = admissions.claim(candidate.id);
      if (!claim) return;
      const currentJob = () =>
        cronManager.list().find(({ id }) => id === candidate.jobId);
      const job = currentJob();
      const { admission } = claim;
      if (
        admission.id !== execution.id ||
        admission.occurrence !== candidate.occurrence ||
        !matchesAdmission(admission, job)
      ) {
        admissions.finish(claim);
        return;
      }
      await executeCronJob({
        config,
        cronManager,
        job,
        execution,
        closeAdmission: () =>
          admissions.finish(claim) &&
          matchesAdmission(admission, currentJob()),
      });
    } catch {
      log.warn("Durable cron occurrence could not be recovered");
    }
  });
}

/** Check all cron jobs against the current time and fire matching ones. */
export function tickCronJobs(
  config: SchedulerServiceConfig,
  cronManager: CronManager,
  now = new Date(),
): void {
  const admissions = config.recoverTurn ? config.cronAdmissions : undefined;
  const due = new Map<string, SchedulerCronAdmission>();
  for (const job of cronManager.list()) {
    if (!job.enabled) continue;
    const parseResult = parseCronExpression(job.expression);
    if (!parseResult.ok) continue;
    if (matchesNow(parseResult.value, now)) {
      const occurrence = Math.floor(now.getTime() / 60_000);
      const execution = config.recoverTurn || config.executionTracePath
        ? schedulerExecutionIdentity("cron", job.id, occurrence)
        : undefined;
      if (admissions && execution) {
        const admission = {
          id: execution.id,
          jobId: job.id,
          occurrence,
          promptSha256: promptDigest(job),
          classificationCeiling: job.classificationCeiling,
        };
        try {
          admissions.admit(admission);
          due.set(admission.id, admission);
        } catch {
          log.warn("Durable cron occurrence could not be admitted");
        }
        continue;
      }
      void runSchedulerOccurrence(
        config,
        execution,
        () => executeCronJob({ config, cronManager, job, execution }),
      );
    }
  }
  if (!admissions) return;
  try {
    for (const pending of admissions.available()) due.set(pending.id, pending);
  } catch {
    log.warn("Durable cron admissions could not be read");
  }
  for (const candidate of due.values()) {
    executeCronAdmission(config, cronManager, admissions, candidate);
  }
}
