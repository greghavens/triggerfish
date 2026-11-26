/**
 * LLM provider abstraction for multi-provider support.
 *
 * Interfaces are defined in core/types/llm.ts and re-exported here.
 * This module provides the factory function for creating provider registries.
 *
 * @module
 */

export type {
  LlmCompletionResult,
  LlmMessage,
  LlmProvider,
  LlmProviderRegistry,
  LlmStreamChunk,
  LlmUsage,
} from "../core/types/llm.ts";

import type { LlmProvider, LlmProviderRegistry } from "../core/types/llm.ts";
import {
  canFlowTo,
  type ClassificationLevel,
} from "../core/types/classification.ts";

export interface EffectiveModelProfile {
  readonly classification: ClassificationLevel;
  readonly provider: string;
  readonly model?: string;
}

/** Report the same routes the orchestrator selects at each permitted taint. */
export function listEffectiveModelProfiles(
  registry: LlmProviderRegistry,
  ceiling: ClassificationLevel,
): readonly EffectiveModelProfile[] {
  try {
    registry = registry.snapshotForTurn?.() ?? registry;
  } catch {
    return [];
  }
  const levels = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"] as const;
  return levels.flatMap((classification) => {
    if (!canFlowTo(classification, ceiling)) return [];
    const provider = registry.getForClassification(classification);
    if (!provider) return [];
    return [{
      classification,
      provider: provider.name,
      ...(provider.model !== undefined && { model: provider.model }),
    }];
  });
}

/**
 * Create a new LLM provider registry.
 *
 * @returns An empty LlmProviderRegistry ready for provider registration
 */
export function createProviderRegistry(): LlmProviderRegistry {
  const providers = new Map<string, LlmProvider>();
  const classificationOverrides = new Map<string, LlmProvider>();
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

    registerClassificationOverride(
      level: ClassificationLevel,
      provider: LlmProvider,
    ): void {
      classificationOverrides.set(level, provider);
    },

    getForClassification(level: ClassificationLevel): LlmProvider | undefined {
      return classificationOverrides.get(level) ?? this.getDefault();
    },
  };
}
