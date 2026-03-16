/**
 * CLI cron command — manage persistent cron jobs.
 *
 * Provides `runCron()` which dispatches to add, list, delete, history subcommands.
 * @module
 */

import { join } from "@std/path";
import { resolveBaseDir } from "../config/paths.ts";
import { createSqliteStorage } from "../../core/storage/sqlite.ts";
import { createPersistentCronManager } from "../../scheduler/cron/cron.ts";
import { parseClassification } from "../../core/types/classification.ts";
import type { CronManager } from "../../scheduler/cron/parser.ts";

function handleCronAdd(
  cronManager: CronManager,
  flags: Readonly<Record<string, boolean | string>>,
): void {
  const expression = flags.expression as string | undefined;
  const task = flags.task as string | undefined;
  if (!expression || !task) {
    console.log('Usage: triggerfish cron add "<schedule>" <task description>');
    console.log('Example: triggerfish cron add "0 9 * * *" morning briefing');
    Deno.exit(1);
  }
  const rawClassification = typeof flags.classification === "string"
    ? flags.classification
    : "INTERNAL";
  const parsedLevel = parseClassification(rawClassification);
  if (!parsedLevel.ok) {
    console.log(`Invalid classification: ${rawClassification}`);
    console.log("Valid levels: PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED");
    Deno.exit(1);
  }
  const result = cronManager.create({
    expression,
    task,
    classificationCeiling: parsedLevel.value,
  });
  if (!result.ok) {
    console.log(`Error: ${result.error}`);
    Deno.exit(1);
  }
  const job = result.value;
  console.log(`Created cron job:`);
  console.log(`  ID:             ${job.id}`);
  console.log(`  Schedule:       ${job.expression}`);
  console.log(`  Task:           ${job.task}`);
  console.log(`  Classification: ${job.classificationCeiling}`);
  console.log(`  Created:        ${job.createdAt.toISOString()}`);
}

function handleCronList(cronManager: CronManager): void {
  const jobs = cronManager.list();
  if (jobs.length === 0) {
    console.log("No cron jobs registered.");
    console.log(
      '\nCreate one with: triggerfish cron add "0 9 * * *" your task here',
    );
    return;
  }
  console.log(`${jobs.length} cron job(s):\n`);
  for (const job of jobs) {
    const hist = cronManager.history(job.id);
    const lastRun = hist.length > 0
      ? hist[hist.length - 1].executedAt.toISOString()
      : "never";
    console.log(`  ${job.enabled ? "+" : "-"} ${job.id}`);
    console.log(`    Schedule: ${job.expression}`);
    console.log(`    Task:     ${job.task}`);
    console.log(`    Ceiling:  ${job.classificationCeiling}`);
    console.log(`    Last run: ${lastRun}`);
    console.log(`    Runs:     ${hist.length}`);
    console.log();
  }
}

function handleCronDelete(
  cronManager: CronManager,
  flags: Readonly<Record<string, boolean | string>>,
): void {
  const jobId = flags.job_id as string | undefined;
  if (!jobId) {
    console.log("Usage: triggerfish cron delete <job_id>");
    Deno.exit(1);
  }
  const result = cronManager.delete(jobId);
  if (!result.ok) {
    console.log(`Error: ${result.error}`);
    Deno.exit(1);
  }
  console.log(`Deleted cron job ${jobId}`);
}

function handleCronHistory(
  cronManager: CronManager,
  flags: Readonly<Record<string, boolean | string>>,
): void {
  const jobId = flags.job_id as string | undefined;
  if (!jobId) {
    console.log("Usage: triggerfish cron history <job_id>");
    Deno.exit(1);
  }
  const hist = cronManager.history(jobId);
  if (hist.length === 0) {
    console.log("No execution history for this job.");
    return;
  }
  console.log(`Last ${Math.min(hist.length, 20)} execution(s):\n`);
  for (const e of hist.slice(-20)) {
    const status = e.success ? "OK" : "FAIL";
    const dur = Math.round(e.durationMs);
    const err = e.error ? ` — ${e.error}` : "";
    console.log(
      `  ${e.executedAt.toISOString()}  ${status}  ${dur}ms${err}`,
    );
  }
}

function printCronUsage(): void {
  console.log("Usage: triggerfish cron <add|list|delete|history>");
  console.log("\nSubcommands:");
  console.log('  add "<schedule>" <task>   Create a new cron job');
  console.log("  list                      List all cron jobs");
  console.log("  delete <job_id>           Delete a cron job");
  console.log("  history <job_id>          Show execution history");
}

/**
 * Manage cron jobs via CLI subcommands.
 */
export async function dispatchCronCommand(
  subcommand: string | undefined,
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  const baseDir = resolveBaseDir();
  const dataDir = join(baseDir, "data");
  await Deno.mkdir(dataDir, { recursive: true });
  const storage = createSqliteStorage(join(dataDir, "triggerfish.db"));
  const cronManager = await createPersistentCronManager(storage);

  try {
    switch (subcommand) {
      case "add":
        handleCronAdd(cronManager, flags);
        break;
      case "list":
        handleCronList(cronManager);
        break;
      case "delete":
        handleCronDelete(cronManager, flags);
        break;
      case "history":
        handleCronHistory(cronManager, flags);
        break;
      default:
        printCronUsage();
        break;
    }
  } finally {
    await storage.close();
  }
}

/** @deprecated Use dispatchCronCommand instead */
export const runCron = dispatchCronCommand;
