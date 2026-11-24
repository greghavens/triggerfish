/**
 * X API monthly quota tracker.
 *
 * Tracks monthly API consumption against tier ceilings and configurable
 * spending caps. Persists state via SecretStore so it survives restarts.
 *
 * Thresholds:
 * - 80%: warning logged
 * - 95%: warning included in tool response
 * - 100%: operation blocked
 *
 * @module
 */

import { createLogger } from "../../../core/logger/logger.ts";
import type { SecretStore } from "../../../core/secrets/keychain/keychain.ts";
import type { XApiTier } from "../auth/types_auth.ts";

const log = createLogger("x-quota");

/** Storage key for persisted quota state. */
const QUOTA_KEY = "x:quota";

/** Monthly post read limits per tier. */
const TIER_READ_LIMITS: Readonly<Record<XApiTier, number>> = {
  free: 0,
  basic: 10_000,
  pro: 1_000_000,
  pay_per_use: 2_000_000,
};

/** Monthly post write limits per tier. */
const TIER_WRITE_LIMITS: Readonly<Record<XApiTier, number>> = {
  free: 500,
  basic: 50_000,
  pro: 300_000,
  pay_per_use: 300_000,
};

/** Persisted monthly quota state. */
interface QuotaState {
  readonly month: string;
  readonly readsUsed: number;
  readonly writesUsed: number;
}

/** Current quota usage report. */
export interface QuotaUsage {
  readonly month: string;
  readonly tier: XApiTier;
  readonly reads: { readonly used: number; readonly limit: number };
  readonly writes: { readonly used: number; readonly limit: number };
}

/** Quota check result. */
export type QuotaCheckResult =
  | { readonly ok: true; readonly warning?: string }
  | { readonly ok: false; readonly error: string };

/** Safe fallback when quota check cannot complete. */
const QUOTA_CHECK_UNAVAILABLE: QuotaCheckResult = {
  ok: false,
  error: "Quota check unavailable",
} as const;

/** Monthly API quota tracker for X integration. */
export interface XQuotaTracker {
  /** Record a read API call. */
  readonly recordRead: () => Promise<void>;
  /** Record a write API call (post creation, retweet, etc.). */
  readonly recordWrite: () => Promise<void>;
  /** Get current quota usage. */
  readonly getUsage: () => Promise<QuotaUsage>;
  /** Check if a read operation is allowed. */
  readonly checkReadQuota: () => Promise<QuotaCheckResult>;
  /** Check if a write operation is allowed. */
  readonly checkWriteQuota: () => Promise<QuotaCheckResult>;
}

/** Get the current month as YYYY-MM string. */
function currentMonth(nowFn: () => number): string {
  const d = new Date(nowFn());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Load quota state, resetting if month has changed. */
async function loadQuotaState(
  secretStore: SecretStore,
  nowFn: () => number,
): Promise<QuotaState> {
  const month = currentMonth(nowFn);
  const result = await secretStore.getSecret(QUOTA_KEY);
  if (result.ok) {
    try {
      const state = JSON.parse(result.value) as QuotaState;
      if (state.month === month) return state;
    } catch (err: unknown) {
      log.warn("Quota state JSON parse failed, resetting counters", {
        operation: "loadQuotaState",
        err,
      });
    }
  }
  return { month, readsUsed: 0, writesUsed: 0 };
}

/** Persist quota state. */
async function saveQuotaState(
  secretStore: SecretStore,
  state: QuotaState,
): Promise<void> {
  await secretStore.setSecret(QUOTA_KEY, JSON.stringify(state));
}

/** Options for checking quota usage against a limit. */
interface CheckUsageOpts {
  readonly used: number;
  readonly limit: number;
  readonly kind: string;
  readonly warningThreshold: number;
  readonly cutoffThreshold: number;
}

/** Return blocked result when tier has zero capacity. */
function checkTierDisabled(kind: string): QuotaCheckResult {
  return {
    ok: false,
    error: `X API ${kind} operations not available on this tier`,
  };
}

/** Return exhausted result when quota is fully consumed. */
function checkExhausted(opts: CheckUsageOpts): QuotaCheckResult {
  return {
    ok: false,
    error:
      `X API monthly ${opts.kind} quota exhausted (${opts.used}/${opts.limit}). Resets next month.`,
  };
}

/** Return cutoff warning when usage is critically high. */
function checkCutoff(opts: CheckUsageOpts, ratio: number): QuotaCheckResult {
  const percentage = Math.round(ratio * 100);
  log.warn("X API monthly quota approaching limit", {
    operation: "checkXQuota",
    kind: opts.kind,
    used: opts.used,
    limit: opts.limit,
    percentage,
  });
  return {
    ok: true,
    warning:
      `X API monthly ${opts.kind} quota at ${percentage}% (${opts.used}/${opts.limit}). ` +
      `Approaching limit.`,
  };
}

/** Log warning threshold breach without surfacing to user. */
function checkWarning(opts: CheckUsageOpts, ratio: number): QuotaCheckResult {
  log.warn("X API monthly quota warning", {
    operation: "checkXQuota",
    kind: opts.kind,
    used: opts.used,
    limit: opts.limit,
    percentage: Math.round(ratio * 100),
  });
  return { ok: true };
}

/** Check usage against a limit and return appropriate result. */
function checkUsage(opts: CheckUsageOpts): QuotaCheckResult {
  if (opts.limit === 0) return checkTierDisabled(opts.kind);
  const ratio = opts.used / opts.limit;
  if (ratio >= 1.0) return checkExhausted(opts);
  if (ratio >= opts.cutoffThreshold) return checkCutoff(opts, ratio);
  if (ratio >= opts.warningThreshold) return checkWarning(opts, ratio);
  return { ok: true };
}

/** Clamp and order quota thresholds to ensure correct enforcement. */
function validateThresholds(
  warning: number,
  cutoff: number,
): { readonly warning: number; readonly cutoff: number } {
  const clampedWarning = Math.max(0.01, Math.min(warning, 0.99));
  const clampedCutoff = Math.max(0.01, Math.min(cutoff, 0.99));
  if (clampedWarning >= clampedCutoff) {
    log.warn("Quota warning threshold >= cutoff threshold, auto-correcting", {
      operation: "validateQuotaThresholds",
      warning: clampedWarning,
      cutoff: clampedCutoff,
    });
    return {
      warning: Math.max(0.001, clampedCutoff - 0.05),
      cutoff: clampedCutoff,
    };
  }
  return { warning: clampedWarning, cutoff: clampedCutoff };
}

/**
 * Create an X API monthly quota tracker.
 *
 * @param secretStore - For persisting quota state across restarts
 * @param tier - The active X API tier
 * @param opts - Optional overrides for warning/cutoff thresholds and clock
 */
export function createXQuotaTracker(
  secretStore: SecretStore,
  tier: XApiTier,
  opts?: {
    readonly warningThreshold?: number;
    readonly cutoffThreshold?: number;
    readonly nowFn?: () => number;
  },
): XQuotaTracker {
  const { warning: warningThreshold, cutoff: cutoffThreshold } =
    validateThresholds(
      opts?.warningThreshold ?? 0.8,
      opts?.cutoffThreshold ?? 0.95,
    );
  const nowFn = opts?.nowFn ?? Date.now;
  const readLimit = TIER_READ_LIMITS[tier];
  const writeLimit = TIER_WRITE_LIMITS[tier];

  /** Serialize quota mutations to prevent lost increments under concurrency. */
  let pendingMutation: Promise<void> = Promise.resolve();

  /**
   * Run a quota mutation serially — queued behind any pending mutation.
   * A failed prior mutation is logged at WARN and the chain continues.
   * This means a lost increment is possible but the chain never deadlocks.
   * Accepted trade-off: quota counts may undercount by 1 on transient errors.
   */
  function serializeMutation(fn: () => Promise<void>): Promise<void> {
    pendingMutation = pendingMutation
      .catch((priorErr: unknown) => {
        log.warn("Prior quota mutation failed, continuing chain", {
          operation: "serializeQuotaMutation",
          err: priorErr,
        });
      })
      .then(fn);
    return pendingMutation;
  }

  return {
    /** Increment read counter. Serialized via promise chain to prevent lost increments. */
    async recordRead(): Promise<void> {
      await serializeMutation(async () => {
        const state = await loadQuotaState(secretStore, nowFn);
        await saveQuotaState(secretStore, {
          ...state,
          readsUsed: state.readsUsed + 1,
        });
      });
    },

    /** Increment write counter. Serialized via promise chain to prevent lost increments. */
    async recordWrite(): Promise<void> {
      await serializeMutation(async () => {
        const state = await loadQuotaState(secretStore, nowFn);
        await saveQuotaState(secretStore, {
          ...state,
          writesUsed: state.writesUsed + 1,
        });
      });
    },

    async getUsage(): Promise<QuotaUsage> {
      const state = await loadQuotaState(secretStore, nowFn);
      return {
        month: state.month,
        tier,
        reads: { used: state.readsUsed, limit: readLimit },
        writes: { used: state.writesUsed, limit: writeLimit },
      };
    },

    async checkReadQuota(): Promise<QuotaCheckResult> {
      let result: QuotaCheckResult = QUOTA_CHECK_UNAVAILABLE;
      await serializeMutation(async () => {
        const state = await loadQuotaState(secretStore, nowFn);
        result = checkUsage({
          used: state.readsUsed,
          limit: readLimit,
          kind: "read",
          warningThreshold,
          cutoffThreshold,
        });
      });
      return result;
    },

    async checkWriteQuota(): Promise<QuotaCheckResult> {
      let result: QuotaCheckResult = QUOTA_CHECK_UNAVAILABLE;
      await serializeMutation(async () => {
        const state = await loadQuotaState(secretStore, nowFn);
        result = checkUsage({
          used: state.writesUsed,
          limit: writeLimit,
          kind: "write",
          warningThreshold,
          cutoffThreshold,
        });
      });
      return result;
    },
  };
}
