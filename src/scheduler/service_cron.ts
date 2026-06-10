/**
 * Scheduler cron execution — runs cron jobs in isolated orchestrator
 * sessions and records execution history.
 *
 * @module
 */

import type { Result } from "../core/types/classification.ts";
import type { CronJob } from "./cron/parser.ts";
import type { CronManager } from "./cron/parser.ts";
import type { SchedulerServiceConfig } from "./service_types.ts";
import { matchesNow, parseCronExpression } from "./cron/cron.ts";
import { createLogger } from "../core/logger/mod.ts";
import { deliverSchedulerOutput } from "./service_output.ts";

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
    const { orchestrator, session, getSessionTaint } = await config
      .orchestratorFactory.create(
        "cron",
        { ceiling: job.classificationCeiling },
      );
    const result = await orchestrator.executeAgentTurn({
      session,
      message: job.task,
      targetClassification: job.classificationCeiling,
    });
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
    recordCronFailure(recordOpts, err);
  }
}

/** Check all cron jobs against the current time and fire matching ones. */
export function tickCronJobs(
  config: SchedulerServiceConfig,
  cronManager: CronManager,
): void {
  const now = new Date();
  for (const job of cronManager.list()) {
    if (!job.enabled) continue;
    const parseResult = parseCronExpression(job.expression);
    if (!parseResult.ok) continue;
    if (matchesNow(parseResult.value, now)) {
      executeCronJob({ config, cronManager, job });
    }
  }
}
