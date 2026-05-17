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
  /**
   * Whether this model supports the OpenAI-compat thinking toggle
   * (`thinking: {type}` / `reasoning_history` / `reasoning_effort`).
   * True for Kimi K2, DeepSeek R1, QwQ, GLM Z1, and similar open reasoning models.
   */
  readonly supportsThinking?: boolean;
  /**
   * Whether the model's chat template + parser architecture supports running
   * thinking AND tool calls in the same completion (joint mode).
   *
   * True when the family has a per-family template that leaves `<think>`
   * (or equivalent reasoning channel) open even when tools are present, and
   * a corresponding parser that splits the joint output stream back into
   * separate thinking + content + tool_calls fields. Verified against
   * Ollama's `model/renderers/` + `model/parsers/` for each family.
   *
   * False (or unset) means the model architecturally CAN'T run joint mode,
   * OR the only available host (Fireworks, Triggerfish Gateway, etc.) has
   * known serving bugs that make joint mode unstable. Providers that
   * disable thinking when tools are present (fireworks.ts, triggerfish.ts)
   * apply that workaround unconditionally for their model — they do not
   * read this flag.
   *
   * Providers that DO read this flag (local.ts/LM Studio, zai.ts/Z.ai,
   * zenmux.ts, openrouter) use it to gate the "disable thinking on tools"
   * workaround: when true, thinking stays enabled alongside tools; when
   * false/unset, the workaround kicks in.
   */
  readonly jointThinkingTools?: boolean;
  /**
   * Whether this model supports Gemini's `thinkingConfig.thinkingBudget`
   * generation config parameter. True for Gemini 2.5+.
   */
  readonly supportsGeminiThinking?: boolean;
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
  [/gemini-2\.5/i, { contextWindow: 1_048_576, outputLimit: 65_536, supportsGeminiThinking: true }],
  [/gemini-2\.0-flash/i, { contextWindow: 1_048_576, outputLimit: 8_192 }],
  [/gemini-1\.5-pro/i, { contextWindow: 2_097_152, outputLimit: 8_192 }],
  [/gemini-1\.5-flash/i, { contextWindow: 1_048_576, outputLimit: 8_192 }],
  [/gemini/i, { contextWindow: 1_048_576, outputLimit: 8_192 }],

  // --- Meta Llama ---
  [/llama-3\.3/i, { contextWindow: 128_000, outputLimit: 16_384 }],
  [/llama-3\.2/i, { contextWindow: 128_000, outputLimit: 16_384 }],
  [/llama-3\.1/i, { contextWindow: 128_000, outputLimit: 16_384 }],
  [/llama-3/i, { contextWindow: 8_192, outputLimit: 4_096 }],

  // --- NVIDIA Nemotron (Llama-derived, supports large outputs for code) ---
  // Nemotron 3 Super/Nano are thinking-capable; Ollama keeps <think> open
  // alongside tool calls in the same completion (joint mode).
  [/nemotron-3-super/i, {
    contextWindow: 128_000,
    outputLimit: 32_768,
    supportsThinking: true,
    jointThinkingTools: true,
  }],
  [/nemotron-3-nano/i, {
    contextWindow: 128_000,
    outputLimit: 32_768,
    supportsThinking: true,
    jointThinkingTools: true,
  }],
  [/nemotron/i, { contextWindow: 128_000, outputLimit: 16_384 }],

  // --- OpenAI gpt-oss (Harmony format with thinking support) ---
  // Harmony's analysis/commentary/final channels are joint by design: the
  // model emits reasoning in `analysis` and tool calls in `commentary` in
  // the same completion. LM Studio (and any harmony-aware server) parses
  // them back into separate fields.
  [/gpt-oss-120b/i, {
    contextWindow: 131_072,
    outputLimit: 32_768,
    supportsThinking: true,
    jointThinkingTools: true,
  }],
  [/gpt-oss-20b/i, {
    contextWindow: 131_072,
    outputLimit: 32_768,
    supportsThinking: true,
    jointThinkingTools: true,
  }],
  [/gpt-oss/i, {
    contextWindow: 131_072,
    outputLimit: 32_768,
    supportsThinking: true,
    jointThinkingTools: true,
  }],

  // --- Mistral ---
  // Ministral 3 reasoning is a thinking model — must come before generic ministral
  [/ministral-3.*reasoning/i, {
    contextWindow: 32_000,
    outputLimit: 32_768,
    supportsThinking: true,
    jointThinkingTools: true,
  }],
  [/ministral-3/i, { contextWindow: 32_000, outputLimit: 16_384 }],
  [/ministral/i, { contextWindow: 32_000, outputLimit: 8_192 }],
  [/mistral-large/i, { contextWindow: 128_000, outputLimit: 16_384 }],
  [/mistral-medium/i, { contextWindow: 32_000, outputLimit: 8_192 }],
  [/mistral-small/i, { contextWindow: 32_000, outputLimit: 8_192 }],
  [/mixtral-8x22b/i, { contextWindow: 65_536, outputLimit: 8_192 }],
  [/mixtral-8x7b/i, { contextWindow: 32_768, outputLimit: 8_192 }],
  [/mixtral/i, { contextWindow: 32_000, outputLimit: 8_192 }],
  [/mistral/i, { contextWindow: 32_000, outputLimit: 8_192 }],

  // --- DeepSeek ---
  [/deepseek-v3-0324/i, { contextWindow: 128_000, outputLimit: 16_384 }],
  [/deepseek-v3/i, { contextWindow: 128_000, outputLimit: 16_384 }],
  [/deepseek-r1/i, {
    contextWindow: 128_000,
    outputLimit: 32_768,
    supportsThinking: true,
    jointThinkingTools: true,
  }],
  [/deepseek/i, { contextWindow: 64_000, outputLimit: 8_192 }],

  // --- Qwen3 (newest, before older Qwen entries) ---
  // Qwen3-Coder is intentionally non-thinking (Ollama's qwen3coder renderer
  // signature explicitly discards the think param; HasThinkingSupport=false).
  [/qwen3-coder/i, { contextWindow: 262_144, outputLimit: 32_768 }],
  [/qwen3-vl-thinking/i, {
    contextWindow: 128_000,
    outputLimit: 32_768,
    supportsThinking: true,
    jointThinkingTools: true,
  }],
  [/qwen3\.5/i, {
    contextWindow: 128_000,
    outputLimit: 32_768,
    supportsThinking: true,
    jointThinkingTools: true,
  }],
  [/qwen3/i, {
    contextWindow: 128_000,
    outputLimit: 32_768,
    supportsThinking: true,
    jointThinkingTools: true,
  }],
  // --- Qwen 2.x ---
  [/qwen-2\.5/i, { contextWindow: 128_000, outputLimit: 16_384 }],
  [/qwen2p5-72b/i, { contextWindow: 128_000, outputLimit: 16_384 }],
  // QwQ is Qwen's reasoning model — must come before the generic qwen catch-all
  [/qwq/i, {
    contextWindow: 128_000,
    outputLimit: 32_768,
    supportsThinking: true,
    jointThinkingTools: true,
  }],
  [/qwen/i, { contextWindow: 32_000, outputLimit: 8_192 }],

  // --- Moonshot / Kimi (262K context, K2.5 supports thinking) ---
  // Kimi K2.5's architecture supports joint mode (Ollama keeps <think> open
  // alongside <|tool_calls_section_begin|>). Flag reflects model capability;
  // fireworks.ts and triggerfish.ts (Gateway) ignore the flag because their
  // serving layers have documented instability with joint thinking+tools.
  [/kimi-k2/i, {
    contextWindow: 262_144,
    outputLimit: 32_768,
    supportsThinking: true,
    jointThinkingTools: true,
  }],

  // --- Z.AI GLM ---
  // GLM Z1 (thinking variants — must come before generic glm catch-all)
  [/glm-z1/i, {
    contextWindow: 128_000,
    outputLimit: 16_384,
    supportsThinking: true,
    jointThinkingTools: true,
  }],
  // GLM 4.7 and 4.6 are newer thinking-capable models
  [/glm-4\.7/i, {
    contextWindow: 128_000,
    outputLimit: 32_768,
    supportsThinking: true,
    jointThinkingTools: true,
  }],
  [/glm-4\.6/i, {
    contextWindow: 128_000,
    outputLimit: 32_768,
    supportsThinking: true,
    jointThinkingTools: true,
  }],
  [/glm-4\.5/i, { contextWindow: 128_000, outputLimit: 16_384 }],
  [/glm-4/i, { contextWindow: 128_000, outputLimit: 16_384 }],

  // --- MiniMax (long-context, large output for code) ---
  [/minimax-m2/i, { contextWindow: 262_144, outputLimit: 32_768 }],
  [/minimax/i, { contextWindow: 200_000, outputLimit: 16_384 }],

  // --- Fireworks (model names prefixed with accounts/fireworks/models/) ---
  [/llama-v3p1-405b/i, { contextWindow: 128_000, outputLimit: 16_384 }],
  [/llama-v3p1-70b/i, { contextWindow: 128_000, outputLimit: 16_384 }],
  [/llama-v3p1-8b/i, { contextWindow: 128_000, outputLimit: 16_384 }],
  [/llama-v3p3-70b/i, { contextWindow: 128_000, outputLimit: 16_384 }],
];

/**
 * Default model info when no pattern matches.
 *
 * The default output limit is intentionally generous: code generation
 * tasks (HTML, JSON, scripts) routinely exceed 4K output tokens, and a
 * truncated tool call destroys the agent turn. Models that genuinely
 * cap output below 16K should add an explicit registry entry.
 */
const DEFAULT_MODEL_INFO: ModelInfo = {
  contextWindow: 100_000,
  outputLimit: 16_384,
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

/**
 * Whether the model supports the OpenAI-compat thinking toggle.
 *
 * True for open reasoning models (Kimi K2, DeepSeek R1, QwQ, GLM Z1) that
 * accept `thinking: {type}` / `reasoning_history` / `reasoning_effort` params.
 * Used by providers to gate reasoning-control parameters.
 *
 * @param modelName - Model identifier string
 */
export function modelSupportsThinking(modelName: string): boolean {
  return resolveModelInfo(modelName).supportsThinking === true;
}

/**
 * Whether the model supports running thinking AND tool calls in the same
 * completion (joint mode).
 *
 * True for families with per-family templates + parsers that split the
 * joint output stream (verified against Ollama renderers/parsers):
 * gpt-oss (harmony), Nemotron-3, Kimi K2.5, GLM-4.7/4.6/Z1, DeepSeek R1,
 * QwQ, Qwen3+, Ministral-3 reasoning.
 *
 * Providers consult this flag to decide whether to disable thinking when
 * tools are present. Some providers (fireworks.ts, triggerfish.ts) ignore
 * the flag and always disable joint mode due to documented serving-layer
 * instability on their host.
 *
 * @param modelName - Model identifier string
 */
export function modelSupportsJointThinkingTools(modelName: string): boolean {
  return resolveModelInfo(modelName).jointThinkingTools === true;
}

/**
 * Whether the model supports Gemini's `thinkingConfig.thinkingBudget` parameter.
 *
 * True for Gemini 2.5+. Uses a different API surface than the OpenAI-compat
 * thinking toggle, so this is tracked separately from `supportsThinking`.
 *
 * @param modelName - Model identifier string
 */
export function modelSupportsGeminiThinking(modelName: string): boolean {
  return resolveModelInfo(modelName).supportsGeminiThinking === true;
}
