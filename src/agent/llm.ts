/**
 * LLM provider abstraction for multi-provider support.
 *
 * Interfaces are defined in core/types/llm.ts and re-exported here.
 * This module provides the factory function for creating provider registries.
 *
 * @module
 */

export type {
  LlmMessage,
  LlmUsage,
  LlmCompletionResult,
  LlmStreamChunk,
  LlmProvider,
  LlmProviderRegistry,
} from "../core/types/llm.ts";

import type { LlmProvider, LlmProviderRegistry } from "../core/types/llm.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import { CLASSIFICATION_ORDER } from "../core/types/classification.ts";

/**
 * Create a new LLM provider registry.
 *
 * @returns An empty LlmProviderRegistry ready for provider registration
 */
export function createProviderRegistry(): LlmProviderRegistry {
  const providers = new Map<string, LlmProvider>();
  const classificationProviders = new Map<ClassificationLevel, LlmProvider>();
  let defaultName: string | undefined;

  return {
    register(provider: LlmProvider): void {
      providers.set(provider.name, provider);
    },

    get(name: string): LlmProvider | undefined {
      return providers.get(name);
    },

    setDefault(name: string): void {
      defaultName = name;
    },

    getDefault(): LlmProvider | undefined {
      if (defaultName === undefined) return undefined;
      return providers.get(defaultName);
    },

    setClassificationProvider(level: ClassificationLevel, provider: LlmProvider): void {
      classificationProviders.set(level, provider);
    },

    getForClassification(level: ClassificationLevel): LlmProvider | undefined {
      // 1. Exact match
      const exact = classificationProviders.get(level);
      if (exact !== undefined) return exact;

      // 2. Highest configured level whose sensitivity is ≤ the taint level.
      // "Highest" = largest CLASSIFICATION_ORDER value that still fits under
      // the taint — this errs toward the most restrictive available model.
      const taintOrder = CLASSIFICATION_ORDER[level];
      let bestProvider: LlmProvider | undefined;
      let bestOrder = 0;

      for (const [configuredLevel, provider] of classificationProviders) {
        const configuredOrder = CLASSIFICATION_ORDER[configuredLevel];
        if (configuredOrder <= taintOrder && configuredOrder > bestOrder) {
          bestOrder = configuredOrder;
          bestProvider = provider;
        }
      }

      return bestProvider;
    },
  };
}
