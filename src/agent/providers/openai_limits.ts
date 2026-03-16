/**
 * OpenAI API rate limit constants.
 *
 * Values reflect OpenAI's published tier limits as of early 2026.
 * See: https://platform.openai.com/account/rate-limits
 *
 * TPM = Tokens Per Minute
 * RPM = Requests Per Minute
 * TPD = Tokens Per Day
 *
 * Tier 1 is the default for new accounts with any payment method on file.
 * Tier 5 is the highest publicly available tier.
 *
 * @module
 */

/** Rate limits for a single model at a specific OpenAI usage tier. */
export interface OpenAiModelLimits {
  /** Maximum tokens per minute (input + output combined). */
  readonly tpm: number;
  /** Maximum requests per minute. */
  readonly rpm: number;
  /** Maximum tokens per day. */
  readonly tpd: number;
}

/** OpenAI usage tier identifier. */
export type OpenAiTier =
  | "free"
  | "tier1"
  | "tier2"
  | "tier3"
  | "tier4"
  | "tier5";

// ---------------------------------------------------------------------------
// gpt-4o limits by tier
// ---------------------------------------------------------------------------

/** gpt-4o rate limits — Free tier. */
export const GPT4O_FREE: OpenAiModelLimits = {
  tpm: 20_000,
  rpm: 3,
  tpd: 200_000,
};

/** gpt-4o rate limits — Tier 1 (default for paid accounts). */
export const GPT4O_TIER1: OpenAiModelLimits = {
  tpm: 30_000,
  rpm: 500,
  tpd: 90_000,
};

/** gpt-4o rate limits — Tier 2. */
export const GPT4O_TIER2: OpenAiModelLimits = {
  tpm: 450_000,
  rpm: 5_000,
  tpd: 1_350_000,
};

/** gpt-4o rate limits — Tier 3. */
export const GPT4O_TIER3: OpenAiModelLimits = {
  tpm: 800_000,
  rpm: 5_000,
  tpd: 40_000_000,
};

/** gpt-4o rate limits — Tier 4. */
export const GPT4O_TIER4: OpenAiModelLimits = {
  tpm: 2_000_000,
  rpm: 10_000,
  tpd: 300_000_000,
};

/** gpt-4o rate limits — Tier 5. */
export const GPT4O_TIER5: OpenAiModelLimits = {
  tpm: 30_000_000,
  rpm: 10_000,
  tpd: 5_000_000_000,
};

// ---------------------------------------------------------------------------
// gpt-4o-mini limits by tier
// ---------------------------------------------------------------------------

/** gpt-4o-mini rate limits — Free tier. */
export const GPT4O_MINI_FREE: OpenAiModelLimits = {
  tpm: 200_000,
  rpm: 3,
  tpd: 2_000_000,
};

/** gpt-4o-mini rate limits — Tier 1. */
export const GPT4O_MINI_TIER1: OpenAiModelLimits = {
  tpm: 200_000,
  rpm: 500,
  tpd: 10_000_000,
};

/** gpt-4o-mini rate limits — Tier 2. */
export const GPT4O_MINI_TIER2: OpenAiModelLimits = {
  tpm: 2_000_000,
  rpm: 5_000,
  tpd: 50_000_000,
};

/** gpt-4o-mini rate limits — Tier 3. */
export const GPT4O_MINI_TIER3: OpenAiModelLimits = {
  tpm: 4_000_000,
  rpm: 5_000,
  tpd: 200_000_000,
};

/** gpt-4o-mini rate limits — Tier 4. */
export const GPT4O_MINI_TIER4: OpenAiModelLimits = {
  tpm: 10_000_000,
  rpm: 10_000,
  tpd: 5_000_000_000,
};

/** gpt-4o-mini rate limits — Tier 5. */
export const GPT4O_MINI_TIER5: OpenAiModelLimits = {
  tpm: 150_000_000,
  rpm: 30_000,
  tpd: 5_000_000_000,
};

// ---------------------------------------------------------------------------
// o1 limits by tier
// ---------------------------------------------------------------------------

/** o1 rate limits — Tier 1. */
export const O1_TIER1: OpenAiModelLimits = {
  tpm: 30_000,
  rpm: 500,
  tpd: 90_000,
};

/** o1 rate limits — Tier 2. */
export const O1_TIER2: OpenAiModelLimits = {
  tpm: 450_000,
  rpm: 5_000,
  tpd: 1_350_000,
};

/** o1 rate limits — Tier 3. */
export const O1_TIER3: OpenAiModelLimits = {
  tpm: 800_000,
  rpm: 5_000,
  tpd: 40_000_000,
};

/** o1 rate limits — Tier 4. */
export const O1_TIER4: OpenAiModelLimits = {
  tpm: 2_000_000,
  rpm: 10_000,
  tpd: 300_000_000,
};

/** o1 rate limits — Tier 5. */
export const O1_TIER5: OpenAiModelLimits = {
  tpm: 30_000_000,
  rpm: 10_000,
  tpd: 5_000_000_000,
};

// ---------------------------------------------------------------------------
// o3-mini limits by tier
// ---------------------------------------------------------------------------

/** o3-mini rate limits — Tier 1. */
export const O3_MINI_TIER1: OpenAiModelLimits = {
  tpm: 150_000,
  rpm: 500,
  tpd: 1_000_000,
};

/** o3-mini rate limits — Tier 2. */
export const O3_MINI_TIER2: OpenAiModelLimits = {
  tpm: 2_000_000,
  rpm: 5_000,
  tpd: 50_000_000,
};

/** o3-mini rate limits — Tier 3. */
export const O3_MINI_TIER3: OpenAiModelLimits = {
  tpm: 5_000_000,
  rpm: 5_000,
  tpd: 200_000_000,
};

/** o3-mini rate limits — Tier 4. */
export const O3_MINI_TIER4: OpenAiModelLimits = {
  tpm: 20_000_000,
  rpm: 10_000,
  tpd: 1_000_000_000,
};

/** o3-mini rate limits — Tier 5. */
export const O3_MINI_TIER5: OpenAiModelLimits = {
  tpm: 150_000_000,
  rpm: 30_000,
  tpd: 5_000_000_000,
};

// ---------------------------------------------------------------------------
// Lookup helper
// ---------------------------------------------------------------------------

/**
 * Look up the OpenAI rate limits for a given model and tier.
 *
 * Returns undefined if the model/tier combination is not in the registry.
 * Callers should fall back to a conservative default when undefined is returned.
 *
 * @param model - Model name (e.g. "gpt-4o", "gpt-4o-mini")
 * @param tier  - Usage tier (default: "tier1")
 */
export function resolveOpenAiLimits(
  model: string,
  tier: OpenAiTier = "tier1",
): OpenAiModelLimits | undefined {
  if (/gpt-4o-mini/i.test(model)) {
    return GPT4O_MINI_BY_TIER[tier];
  }
  if (/gpt-4o/i.test(model)) {
    return GPT4O_BY_TIER[tier];
  }
  if (/o1/i.test(model)) {
    return O1_BY_TIER[tier];
  }
  if (/o3-mini/i.test(model)) {
    return O3_MINI_BY_TIER[tier];
  }
  return undefined;
}

const GPT4O_BY_TIER: Readonly<Record<OpenAiTier, OpenAiModelLimits>> = {
  free: GPT4O_FREE,
  tier1: GPT4O_TIER1,
  tier2: GPT4O_TIER2,
  tier3: GPT4O_TIER3,
  tier4: GPT4O_TIER4,
  tier5: GPT4O_TIER5,
};

const GPT4O_MINI_BY_TIER: Readonly<Record<OpenAiTier, OpenAiModelLimits>> = {
  free: GPT4O_MINI_FREE,
  tier1: GPT4O_MINI_TIER1,
  tier2: GPT4O_MINI_TIER2,
  tier3: GPT4O_MINI_TIER3,
  tier4: GPT4O_MINI_TIER4,
  tier5: GPT4O_MINI_TIER5,
};

// o1 and o3-mini have no free tier; map free → tier1 as a safe default.
const O1_BY_TIER: Readonly<Record<OpenAiTier, OpenAiModelLimits>> = {
  free: O1_TIER1,
  tier1: O1_TIER1,
  tier2: O1_TIER2,
  tier3: O1_TIER3,
  tier4: O1_TIER4,
  tier5: O1_TIER5,
};

const O3_MINI_BY_TIER: Readonly<Record<OpenAiTier, OpenAiModelLimits>> = {
  free: O3_MINI_TIER1,
  tier1: O3_MINI_TIER1,
  tier2: O3_MINI_TIER2,
  tier3: O3_MINI_TIER3,
  tier4: O3_MINI_TIER4,
  tier5: O3_MINI_TIER5,
};

/** @deprecated Use resolveOpenAiLimits instead */
export const getOpenAiLimits = resolveOpenAiLimits;
