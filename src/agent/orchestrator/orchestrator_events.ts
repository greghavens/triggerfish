/**
 * Orchestrator events, patterns, and skill context types.
 *
 * Defines the event types emitted during message processing,
 * regex patterns for detecting leaked intent and trailing continuation,
 * the ParsedToolCall interface, and the ActiveSkillContext type.
 *
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";

/**
 * Pattern detecting leaked tool-intent narration in LLM responses.
 * Matches phrases like "I'll search", "Let me fetch", "I need to look up", etc.
 * Used as a defense-in-depth guard — the primary fix is prompt hardening.
 */
export const LEAKED_INTENT_PATTERN =
  /\b(?:(?:I(?:'ll| will| need to| should| can| am going to)\s+(?:search|fetch|look up|find|check|browse|retrieve|read|continue|keep|use web_))|(?:(?:Let|let) me (?:search|fetch|look|find|check|browse|retrieve|read|continue|keep|use))|(?:(?:We|I) need to (?:fetch|search|look up|find|check|browse|retrieve|read|continue|keep)))/i;

/**
 * Pattern detecting trailing continuation intent at the end of a long response.
 *
 * Matches phrases like "Let me now create", "I'll search", "Next, I'll fetch"
 * when they appear in the tail of a response. Unlike LEAKED_INTENT_PATTERN
 * (which checks short responses entirely), this catches the case where the LLM
 * writes a long valid response but then trails off with unfulfilled intent.
 */
export const TRAILING_CONTINUATION_PATTERN =
  /(?:Let me (?:now |also |next )?(?:create|search|fetch|look|find|check|browse|retrieve|read|continue|keep|proceed|do|make|add|set up|handle|update|generate|build|write|run|open|close|delete|send|post|submit|call))|(?:I(?:'ll| will| am going to) (?:now |also |next )?(?:create|search|fetch|look|find|check|browse|retrieve|read|continue|keep|proceed|do|make|add|set up|handle|update|generate|build|write|run|open|close|delete|send|post|submit|call))|(?:Next,? I(?:'ll| will))|(?:Now (?:let me|I'll|I will))/i;

/**
 * Structural snapshot of an active skill's capability declarations.
 *
 * Defined here (not in tools/) to avoid layer violations per dependency-layers.md.
 * Satisfied by Skill from src/tools/skills/loader.ts at the gateway wiring layer.
 */
export interface ActiveSkillContext {
  readonly name: string;
  /**
   * Tools the skill declared it needs.
   * null = not declared (unrestricted). [] = declared empty (no tool access).
   */
  readonly requiresTools: readonly string[] | null;
  /**
   * Network domains the skill declared it needs.
   * null = not declared (unrestricted). [] = declared empty (no network access).
   */
  readonly networkDomains: readonly string[] | null;
  readonly classificationCeiling: ClassificationLevel;
}

/** Events emitted by the orchestrator during message processing. */
export type OrchestratorEvent =
  | {
    readonly type: "llm_start";
    readonly iteration: number;
    readonly maxIterations: number;
  }
  | {
    readonly type: "llm_complete";
    readonly iteration: number;
    readonly hasToolCalls: boolean;
  }
  | {
    readonly type: "tool_call";
    readonly name: string;
    readonly args: Record<string, unknown>;
  }
  | {
    readonly type: "tool_result";
    readonly name: string;
    readonly result: string;
    readonly blocked: boolean;
  }
  | { readonly type: "response"; readonly text: string }
  | {
    readonly type: "response_chunk";
    readonly text: string;
    readonly done: boolean;
  }
  | {
    readonly type: "reasoning_chunk";
    readonly text: string;
    readonly done: boolean;
  }
  | { readonly type: "vision_start"; readonly imageCount: number }
  | { readonly type: "vision_complete"; readonly imageCount: number };

/** Callback for real-time orchestrator event reporting. */
export type OrchestratorEventCallback = (event: OrchestratorEvent) => void;

/** A parsed tool call from LLM text output. */
export interface ParsedToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  /**
   * Provider-supplied tool call ID (OpenAI: `id` on the tool_call object;
   * Anthropic: `id` on the tool_use block). Required to round-trip the
   * call/result pair back to the model in subsequent turns.
   */
  readonly id?: string;
  /**
   * Error message captured when the provider-supplied JSON arguments failed
   * to parse. When present, the dispatcher must short-circuit execution and
   * return this error to the model as the tool result, so the model can
   * retry with valid JSON instead of silently invoking the tool with empty
   * args. Populated by the tool-call parser; absent when arguments parsed
   * cleanly.
   */
  readonly argsParseError?: string;
  /** The raw, unparseable argument string preserved alongside argsParseError. */
  readonly rawArgs?: string;
}
