/**
 * Turn-scoped reasoning replay for OpenAI-compatible providers.
 *
 * Every reasoning model this project talks to scopes reasoning to the
 * *current turn* — the span from the user's message through the tool-call
 * round-trips until the model produces a user-facing answer. Reasoning from
 * earlier turns is dropped. The providers differ only in how strictly they
 * enforce it:
 *
 * - DeepSeek (thinking mode): if the assistant made a tool call between two
 *   user messages, its `reasoning_content` MUST be replayed on every
 *   subsequent request. Omitting it is a 400. Outside a tool call it is
 *   ignored.
 * - Z.AI GLM-4.7 ("Preserved Thinking"): `reasoning_content` must be
 *   replayed or the model loses its plan after each action and loops.
 * - gpt-oss / harmony: keep the analysis channel within the turn, drop it
 *   once the model has written to the final channel.
 * - Qwen (DashScope): ignores replayed `reasoning_content` unless
 *   `preserve_thinking` is set, and never errors on its presence — so
 *   replaying it is safe here even though Qwen's chat guide says to drop it.
 *
 * No provider errors on receiving current-turn reasoning, so this needs no
 * per-model gate. Expiry is handled upstream: the orchestrator clears
 * reasoning from prior turns when a new user message arrives
 * (see `expirePreviousTurnReasoning`), which means anything still carrying
 * reasoning by the time it reaches a provider belongs to the current turn.
 *
 * @module
 */

import type { HistoryEntry } from "../../core/types/orchestrator.ts";

/**
 * Attach the assistant's reasoning to an outgoing OpenAI-compatible message.
 *
 * Emits the `reasoning_content` field the OpenAI-compatible reasoning models
 * expect. Messages without reasoning are returned unchanged, so this is safe
 * to call on every message regardless of role or model.
 *
 * @param message - The outgoing message being built
 * @param reasoning - Reasoning text from the originating history entry
 * @returns The message, with `reasoning_content` added when reasoning exists
 */
export function withReasoningContent(
  message: Record<string, unknown>,
  reasoning: string | undefined,
): Record<string, unknown> {
  if (!reasoning) return message;
  return { ...message, reasoning_content: reasoning };
}

/**
 * Drop reasoning from every history entry, marking the end of a turn.
 *
 * Called by the orchestrator when a new user message arrives. Reasoning is
 * only ever meaningful within the turn that produced it; carrying it across
 * a user turn wastes input tokens on every provider and is explicitly
 * discouraged by the harmony and Qwen guidance.
 *
 * @param history - Conversation history, mutated in place
 */
export function expirePreviousTurnReasoning(history: HistoryEntry[]): void {
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (entry.reasoning === undefined && entry.reasoningBlocks === undefined) {
      continue;
    }
    const { reasoning: _text, reasoningBlocks: _blocks, ...rest } = entry;
    history[i] = rest;
  }
}
