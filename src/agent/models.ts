/**
 * Model context window registry.
 *
 * Maps model name patterns to context window and output limit info.
 * Used by the compactor to derive accurate budgets per-model.
 *
 * @module
 */

/** Information about a model's capabilities. */
export interface ModelInfo {
  /** Maximum input context window in tokens. */
  readonly contextWindow: number;
  /** Maximum output tokens per completion. */
  readonly outputLimit: number;
}

/**
 * Registry of known model patterns → capabilities.
 *
 * Order matters: first match wins. More specific patterns come first.
 * Patterns are matched against the full model name string (case-insensitive).
 */
const MODEL_REGISTRY: readonly (readonly [RegExp, ModelInfo])[] = [
  // --- Anthropic (per docs: opus 4.6=128K, sonnet 4.6/4.5=64K, opus 4/4.1=32K) ---
  [/claude-opus-4-6/i, { contextWindow: 200_000, outputLimit: 128_000 }],
  [/claude-opus-4/i, { contextWindow: 200_000, outputLimit: 32_000 }],
  [/claude-sonnet-4/i, { contextWindow: 200_000, outputLimit: 64_000 }],
  [/claude-haiku-4/i, { contextWindow: 200_000, outputLimit: 64_000 }],
  [/claude-3-5-sonnet/i, { contextWindow: 200_000, outputLimit: 8_192 }],
  [/claude-3-5-haiku/i, { contextWindow: 200_000, outputLimit: 8_192 }],
  [/claude-3-opus/i, { contextWindow: 200_000, outputLimit: 4_096 }],
  [/claude-3-sonnet/i, { contextWindow: 200_000, outputLimit: 4_096 }],
  [/claude-3-haiku/i, { contextWindow: 200_000, outputLimit: 4_096 }],
  [/claude/i, { contextWindow: 200_000, outputLimit: 16_000 }],

  // --- OpenAI ---
  [/gpt-4o-mini/i, { contextWindow: 128_000, outputLimit: 16_384 }],
  [/gpt-4o/i, { contextWindow: 128_000, outputLimit: 16_384 }],
  [/gpt-4-turbo/i, { contextWindow: 128_000, outputLimit: 4_096 }],
  [/gpt-4-32k/i, { contextWindow: 32_768, outputLimit: 4_096 }],
  [/gpt-4/i, { contextWindow: 8_192, outputLimit: 4_096 }],
  [/o1-mini/i, { contextWindow: 128_000, outputLimit: 65_536 }],
  [/o1-preview/i, { contextWindow: 128_000, outputLimit: 32_768 }],
  [/o1/i, { contextWindow: 200_000, outputLimit: 100_000 }],
  [/o3-mini/i, { contextWindow: 200_000, outputLimit: 100_000 }],
  [/o3/i, { contextWindow: 200_000, outputLimit: 100_000 }],
  [/o4-mini/i, { contextWindow: 200_000, outputLimit: 100_000 }],

  // --- Google ---
  [/gemini-2\.5/i, { contextWindow: 1_048_576, outputLimit: 65_536 }],
  [/gemini-2\.0-flash/i, { contextWindow: 1_048_576, outputLimit: 8_192 }],
  [/gemini-1\.5-pro/i, { contextWindow: 2_097_152, outputLimit: 8_192 }],
  [/gemini-1\.5-flash/i, { contextWindow: 1_048_576, outputLimit: 8_192 }],
  [/gemini/i, { contextWindow: 1_048_576, outputLimit: 8_192 }],

  // --- Meta Llama ---
  [/llama-3\.3/i, { contextWindow: 128_000, outputLimit: 4_096 }],
  [/llama-3\.2/i, { contextWindow: 128_000, outputLimit: 4_096 }],
  [/llama-3\.1/i, { contextWindow: 128_000, outputLimit: 4_096 }],
  [/llama-3/i, { contextWindow: 8_192, outputLimit: 4_096 }],

  // --- Mistral ---
  [/mistral-large/i, { contextWindow: 128_000, outputLimit: 4_096 }],
  [/mistral-medium/i, { contextWindow: 32_000, outputLimit: 4_096 }],
  [/mistral-small/i, { contextWindow: 32_000, outputLimit: 4_096 }],
  [/mixtral-8x22b/i, { contextWindow: 65_536, outputLimit: 4_096 }],
  [/mixtral-8x7b/i, { contextWindow: 32_768, outputLimit: 4_096 }],
  [/mixtral/i, { contextWindow: 32_000, outputLimit: 4_096 }],
  [/mistral/i, { contextWindow: 32_000, outputLimit: 4_096 }],

  // --- DeepSeek ---
  [/deepseek-v3-0324/i, { contextWindow: 128_000, outputLimit: 8_192 }],
  [/deepseek-v3/i, { contextWindow: 128_000, outputLimit: 8_192 }],
  [/deepseek-r1/i, { contextWindow: 128_000, outputLimit: 8_192 }],
  [/deepseek/i, { contextWindow: 64_000, outputLimit: 4_096 }],

  // --- Qwen ---
  [/qwen-2\.5/i, { contextWindow: 128_000, outputLimit: 8_192 }],
  [/qwen2p5-72b/i, { contextWindow: 128_000, outputLimit: 8_192 }],
  [/qwen/i, { contextWindow: 32_000, outputLimit: 4_096 }],

  // --- Moonshot / Kimi (262K context, Fireworks blog example uses 32K output) ---
  [/kimi-k2/i, { contextWindow: 262_144, outputLimit: 32_768 }],

  // --- Fireworks (model names prefixed with accounts/fireworks/models/) ---
  [/llama-v3p1-405b/i, { contextWindow: 128_000, outputLimit: 4_096 }],
  [/llama-v3p1-70b/i, { contextWindow: 128_000, outputLimit: 4_096 }],
  [/llama-v3p1-8b/i, { contextWindow: 128_000, outputLimit: 4_096 }],
  [/llama-v3p3-70b/i, { contextWindow: 128_000, outputLimit: 4_096 }],
];

/** Default model info when no pattern matches. */
const DEFAULT_MODEL_INFO: ModelInfo = {
  contextWindow: 100_000,
  outputLimit: 4_096,
};

/**
 * Look up model capabilities by name.
 *
 * Pattern-matches against the MODEL_REGISTRY. Returns a safe default
 * (100k context, 4k output) if no pattern matches.
 *
 * @param modelName - Model identifier string (e.g. "claude-sonnet-4-5-20250929")
 * @returns ModelInfo with contextWindow and outputLimit
 */
export function resolveModelInfo(modelName: string): ModelInfo {
  for (const [pattern, info] of MODEL_REGISTRY) {
    if (pattern.test(modelName)) {
      return info;
    }
  }
  return DEFAULT_MODEL_INFO;
}

/** @deprecated Use resolveModelInfo instead */
export const getModelInfo = resolveModelInfo;
