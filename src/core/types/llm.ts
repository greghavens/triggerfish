/**
 * LLM provider type abstractions.
 *
 * Defines the interfaces for LLM completions and provider registry.
 * Extracted into core so that tools/, models/, gateway/, and agent/
 * can all depend on these types without circular imports.
 *
 * The factory function `createProviderRegistry()` remains in agent/llm.ts
 * since it is implementation, not interface.
 *
 * @module
 */

import type { ClassificationLevel } from "./classification.ts";

/** A single message in a conversation. */
export interface LlmMessage {
  readonly role: string;
  readonly content: string | unknown;
}

/** Token usage statistics from a completion. */
export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Result of an LLM completion call. */
export interface LlmCompletionResult {
  readonly content: string;
  readonly toolCalls: readonly unknown[];
  readonly usage: LlmUsage;
}

/** A chunk yielded during streaming. */
export interface LlmStreamChunk {
  /** Incremental text content (may be empty for non-text chunks). */
  readonly text: string;
  /** Whether this is the final chunk. */
  readonly done: boolean;
  /** Usage statistics, available on the final chunk. */
  readonly usage?: LlmUsage;
  /** Tool calls from the LLM, available on the done:true chunk. */
  readonly toolCalls?: readonly unknown[];
}

/**
 * Interface for LLM completion providers.
 *
 * Each provider normalizes to/from the common message format.
 * Implementations exist per provider (Anthropic, OpenAI, Google, Local, OpenRouter, ZenMux).
 */
export interface LlmProvider {
  /** Provider name identifier. */
  readonly name: string;
  /** Whether this provider supports streaming responses. */
  readonly supportsStreaming: boolean;
  /** Model context window size in tokens, if known. */
  readonly contextWindow?: number;
  /** Send messages to the LLM and receive a completion response. */
  complete(
    messages: readonly LlmMessage[],
    tools: readonly unknown[],
    options: Record<string, unknown>,
  ): Promise<LlmCompletionResult>;
  /** Stream a response from the LLM, yielding incremental chunks. */
  stream?(
    messages: readonly LlmMessage[],
    tools: readonly unknown[],
    options: Record<string, unknown>,
  ): AsyncIterable<LlmStreamChunk>;
}

/**
 * Registry for managing multiple LLM providers.
 *
 * Supports registering providers by name, retrieving them, and setting
 * a default provider for use when no specific provider is requested.
 */
export interface LlmProviderRegistry {
  /** Register a provider. Replaces any existing provider with the same name. */
  register(provider: LlmProvider): void;
  /** Get a provider by name, or undefined if not registered. */
  get(name: string): LlmProvider | undefined;
  /** Set the default provider by name. The provider must already be registered. */
  setDefault(name: string): void;
  /** Get the default provider, or undefined if none set. */
  getDefault(): LlmProvider | undefined;
  /** Associate a provider with a classification level. */
  setClassificationProvider(level: ClassificationLevel, provider: LlmProvider): void;
  /**
   * Get the provider for a classification level.
   *
   * Lookup order:
   * 1. Exact match for the taint level.
   * 2. Highest configured level whose sensitivity is ≤ the taint level
   *    (errs toward the most secure model available for the given taint).
   * 3. Returns undefined — caller should fall back to getDefault().
   */
  getForClassification(level: ClassificationLevel): LlmProvider | undefined;
}
