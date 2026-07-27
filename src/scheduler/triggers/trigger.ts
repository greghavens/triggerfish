/**
 * Trigger loop for periodic agent wakeup.
 *
 * Triggers are distinct from cron jobs: cron runs a fixed task on a schedule,
 * while a trigger wakes the agent periodically to decide what to do based on
 * TRIGGER.md instructions.
 *
 * Supports classification ceilings and quiet hours enforcement.
 *
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("scheduler.trigger");

/** Quiet hours configuration. Hours are 0-24 in local time. */
export interface QuietHours {
  readonly start: number;
  readonly end: number;
}

/** Options for creating a trigger. */
export interface TriggerOptions {
  /** Interval in milliseconds between trigger fires. */
  readonly intervalMs: number;
  /** Callback invoked on each trigger fire. */
  readonly callback: () => Promise<void>;
  /** Maximum classification level for data accessed during trigger. */
  readonly classificationCeiling: ClassificationLevel;
  /** Optional quiet hours during which the trigger will not fire. */
  readonly quietHours?: QuietHours;
}

/** A periodic trigger that can be started and stopped. */
export interface Trigger {
  /** Start the trigger loop. */
  start(): void;
  /** Stop the trigger loop. */
  stop(): void;
}

/**
 * Check if the current time falls within quiet hours.
 *
 * Quiet hours are specified as start/end in 24-hour format (0-24).
 * If start < end, quiet hours are start..end.
 * If start > end, quiet hours wrap midnight: start..24 and 0..end.
 * If start === 0 and end === 24, all hours are quiet.
 */
function isQuietHour(quietHours: QuietHours): boolean {
  const now = new Date();
  const hour = now.getHours() + now.getMinutes() / 60;

  if (quietHours.start <= quietHours.end) {
    return hour >= quietHours.start && hour < quietHours.end;
  }
  // Wraps midnight
  return hour >= quietHours.start || hour < quietHours.end;
}

/** Execute a trigger tick, skipping if quiet hours are active. */
function executeTriggerTick(options: TriggerOptions): void {
  if (options.quietHours && isQuietHour(options.quietHours)) {
    log.debug("Trigger skipped — quiet hours active");
    return;
  }
  log.info("Trigger firing");
  options.callback().catch((err: unknown) =>
    log.error("Trigger callback failed", {
      operation: "executeTriggerTick",
      err,
    })
  );
}

/**
 * Create a new periodic trigger.
 *
 * The trigger fires the callback at the specified interval, respecting
 * quiet hours if configured. Each fire runs in an independent context.
 */
export function createTrigger(options: TriggerOptions): Trigger {
  let intervalId: ReturnType<typeof setInterval> | undefined;

  return {
    start(): void {
      if (intervalId !== undefined) return;
      const intervalMinutes = Math.round(options.intervalMs / 60000);
      log.info(
        `Trigger started (interval: ${intervalMinutes}m, ceiling: ${options.classificationCeiling})`,
      );
      // Fire immediately on start, then repeat at interval
      executeTriggerTick(options);
      intervalId = setInterval(
        () => executeTriggerTick(options),
        options.intervalMs,
      );
    },
    stop(): void {
      if (intervalId === undefined) return;
      clearInterval(intervalId);
      intervalId = undefined;
    },
  };
}
