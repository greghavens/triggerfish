/**
 * Intervention triage — pure function that categorizes failures.
 *
 * Examines error patterns, retry counts, and step metadata to
 * assign one of five intervention categories.
 * @module
 */

import type {
  InterventionCategory,
  SelfHealingConfig,
} from "../../core/types/healing.ts";
import type { StepMetadata } from "../../workflow/healing/types.ts";

/** Context available for triage decision-making. */
export interface TriageContext {
  /** The error message from the failed step. */
  readonly errorMessage: string;
  /** How many times this step has been retried in the current run. */
  readonly retryCount: number;
  /** The overall retry budget from self-healing config. */
  readonly config: SelfHealingConfig;
  /** Step metadata (description, intent, expects, produces). */
  readonly stepMetadata?: StepMetadata;
  /** Number of times this step has failed in recent run history. */
  readonly historicalFailureCount?: number;
}

/** Transient error patterns — network, rate limiting, temporary unavailability. */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENETUNREACH/i,
  /timeout/i,
  /rate.?limit/i,
  /429/,
  /503/,
  /502/,
  /504/,
  /temporarily.?unavailable/i,
  /service.?unavailable/i,
  /try.?again/i,
];

/** Plugin/integration error patterns — auth, schema changes, missing capabilities. */
const PLUGIN_PATTERNS: readonly RegExp[] = [
  /401/,
  /403/,
  /authentication/i,
  /authorization/i,
  /token.?expired/i,
  /api.?key/i,
  /schema.?changed/i,
  /endpoint.?removed/i,
  /not.?implemented/i,
  /capability.?not.?found/i,
];

/** Triage a step failure into one of five intervention categories. */
export function triageIntervention(
  context: TriageContext,
): InterventionCategory {
  if (context.retryCount >= context.config.retry_budget) {
    return "unresolvable";
  }

  if (matchesTransientPattern(context.errorMessage)) {
    return "transient_retry";
  }

  if (matchesPluginPattern(context.errorMessage)) {
    return "plugin_gap";
  }

  if (isRecurringHistoricalFailure(context)) {
    return "structural_fix";
  }

  if (context.retryCount === 0) {
    return "runtime_workaround";
  }

  return "structural_fix";
}

function matchesTransientPattern(errorMessage: string): boolean {
  return TRANSIENT_PATTERNS.some((p) => p.test(errorMessage));
}

function matchesPluginPattern(errorMessage: string): boolean {
  return PLUGIN_PATTERNS.some((p) => p.test(errorMessage));
}

function isRecurringHistoricalFailure(context: TriageContext): boolean {
  return (context.historicalFailureCount ?? 0) >= 2;
}
