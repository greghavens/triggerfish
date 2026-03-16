/**
 * Step metadata validation and self-healing config parsing.
 *
 * Enforces that every task in a self-healing workflow has the four
 * required metadata fields (description, intent, expects, produces).
 * @module
 */

import type { ParseResult } from "../parser.ts";
import { err, isRecord, ok } from "../parser.ts";
import type {
  HealingNotifyEvent,
  PauseOnIntervention,
  PauseTimeoutPolicy,
  SelfHealingConfig,
  SoftSignalConfig,
} from "../../core/types/healing.ts";
import type { WorkflowTaskEntry } from "../types.ts";
import type { StepMetadata } from "./types.ts";

const VALID_PAUSE_ON: readonly string[] = ["always", "never", "blocking_only"];
const VALID_TIMEOUT_POLICY: readonly string[] = [
  "escalate_and_halt",
  "escalate_and_skip",
  "escalate_and_fail",
];
const VALID_NOTIFY_EVENTS: readonly string[] = [
  "intervention",
  "escalation",
  "approval_required",
];

const DEFAULT_PAUSE_TIMEOUT_SECONDS = 300;
const DEFAULT_PAUSE_TIMEOUT_POLICY: PauseTimeoutPolicy = "escalate_and_halt";
const DEFAULT_RETRY_BUDGET = 3;
const DEFAULT_RUN_HISTORY_WINDOW = 10;

/** Parse and validate a raw self-healing config block from workflow metadata. */
export function parseSelfHealingConfig(
  raw: unknown,
): ParseResult<SelfHealingConfig> {
  if (!isRecord(raw)) {
    return err("Self-healing config must be an object");
  }

  if (typeof raw["enabled"] !== "boolean") {
    return err("Self-healing config requires 'enabled' boolean field");
  }

  const pauseOn = parsePauseOnIntervention(raw["pause_on_intervention"]);
  if (!pauseOn.ok) return pauseOn;

  const timeoutPolicy = parsePauseTimeoutPolicy(raw["pause_timeout_policy"]);
  if (!timeoutPolicy.ok) return timeoutPolicy;

  const notifyResult = parseNotifyOn(raw["notify_on"]);
  if (!notifyResult.ok) return notifyResult;

  const softSignals = parseSoftSignals(raw["soft_signals"]);
  if (!softSignals.ok) return softSignals;

  const timeoutSeconds = typeof raw["pause_timeout_seconds"] === "number"
    ? raw["pause_timeout_seconds"]
    : DEFAULT_PAUSE_TIMEOUT_SECONDS;

  const retryBudget = typeof raw["retry_budget"] === "number"
    ? raw["retry_budget"]
    : DEFAULT_RETRY_BUDGET;

  const approvalRequired = typeof raw["approval_required"] === "boolean"
    ? raw["approval_required"]
    : true;

  const historyWindow = typeof raw["run_history_window"] === "number"
    ? raw["run_history_window"]
    : DEFAULT_RUN_HISTORY_WINDOW;

  return ok({
    enabled: raw["enabled"] as boolean,
    pause_on_intervention: pauseOn.value,
    pause_timeout_seconds: timeoutSeconds,
    pause_timeout_policy: timeoutPolicy.value,
    retry_budget: retryBudget,
    approval_required: approvalRequired,
    notify_on: notifyResult.value,
    run_history_window: historyWindow,
    soft_signals: softSignals.value,
  });
}

/** Validate a single task entry's metadata for self-healing requirements. */
export function enforceStepMetadataSchema(
  taskEntry: WorkflowTaskEntry,
): ParseResult<StepMetadata> {
  const meta = taskEntry.task.metadata;
  if (!isRecord(meta)) {
    return err(
      `Step metadata missing on task '${taskEntry.name}': self-healing requires description, expects, produces`,
    );
  }

  const fields = ["description", "expects", "produces"] as const;
  for (const field of fields) {
    if (
      typeof meta[field] !== "string" || (meta[field] as string).length === 0
    ) {
      return err(
        `Step metadata '${field}' missing or empty on task '${taskEntry.name}'`,
      );
    }
  }

  return ok({
    description: meta["description"] as string,
    expects: meta["expects"] as string,
    produces: meta["produces"] as string,
  });
}

/** Validate all tasks have required metadata when self-healing is enabled. */
export function enforceStepMetadataRequirements(
  tasks: readonly WorkflowTaskEntry[],
): ParseResult<void> {
  for (const task of tasks) {
    const result = enforceStepMetadataSchema(task);
    if (!result.ok) return err(result.error);
  }
  return ok(undefined);
}

// --- Internal parsers ---

function parsePauseOnIntervention(
  raw: unknown,
): ParseResult<PauseOnIntervention> {
  if (raw === undefined || raw === null) return ok("blocking_only");
  if (typeof raw === "boolean") {
    return ok(raw ? "always" : "never");
  }
  if (typeof raw !== "string" || !VALID_PAUSE_ON.includes(raw)) {
    return err(
      `Self-healing pause_on_intervention must be one of: ${
        VALID_PAUSE_ON.join(", ")
      } (or true/false)`,
    );
  }
  return ok(raw as PauseOnIntervention);
}

function parsePauseTimeoutPolicy(
  raw: unknown,
): ParseResult<PauseTimeoutPolicy> {
  if (raw === undefined || raw === null) {
    return ok(DEFAULT_PAUSE_TIMEOUT_POLICY);
  }
  if (typeof raw !== "string" || !VALID_TIMEOUT_POLICY.includes(raw)) {
    return err(
      `Self-healing pause_timeout_policy must be one of: ${
        VALID_TIMEOUT_POLICY.join(", ")
      }`,
    );
  }
  return ok(raw as PauseTimeoutPolicy);
}

function parseNotifyOn(
  raw: unknown,
): ParseResult<readonly HealingNotifyEvent[]> {
  if (raw === undefined || raw === null) return ok([]);
  if (!Array.isArray(raw)) {
    return err("Self-healing notify_on must be an array");
  }
  for (const item of raw) {
    if (typeof item !== "string" || !VALID_NOTIFY_EVENTS.includes(item)) {
      return err(
        `Self-healing notify_on contains invalid event '${item}'. Valid: ${
          VALID_NOTIFY_EVENTS.join(", ")
        }`,
      );
    }
  }
  return ok(raw as HealingNotifyEvent[]);
}

function parseSoftSignals(
  raw: unknown,
): ParseResult<SoftSignalConfig | undefined> {
  if (raw === undefined || raw === null) return ok(undefined);
  if (!isRecord(raw)) {
    return err("Self-healing soft_signals must be an object");
  }
  return ok({
    empty_output_from_prior_success:
      typeof raw["empty_output_from_prior_success"] === "boolean"
        ? raw["empty_output_from_prior_success"]
        : undefined,
    duration_multiplier_threshold:
      typeof raw["duration_multiplier_threshold"] === "number"
        ? raw["duration_multiplier_threshold"]
        : undefined,
    schema_drift: typeof raw["schema_drift"] === "boolean"
      ? raw["schema_drift"]
      : undefined,
  });
}

// --- Deprecated aliases ---

/** @deprecated Use enforceStepMetadataSchema instead */
export const validateStepMetadata = enforceStepMetadataSchema;
