/**
 * Response quality classification and recovery nudges.
 *
 * Detects empty/junk responses, repetition loops, leaked-intent narration,
 * trailing continuation, and dense narration. Builds recovery nudge messages
 * to re-prompt the LLM when quality is poor.
 *
 * @module
 */

import {
  LEAKED_INTENT_PATTERN,
  TRAILING_CONTINUATION_PATTERN,
} from "../orchestrator/orchestrator_types.ts";

// ─── Repetition detection ────────────────────────────────────────────────────

/** Minimum phrase length to consider for repetition detection. */
const MIN_REPEAT_PHRASE_LEN = 60;
/** Number of repetitions that trigger detection. */
const REPEAT_THRESHOLD = 3;

/**
 * Count non-overlapping occurrences of `phrase` in `text` starting from `startPos`.
 * Returns early once `target` is reached.
 */
function countOccurrences(
  text: string,
  phrase: string,
  startPos: number,
  target: number,
): number {
  let count = 0;
  let pos = startPos;
  while (pos <= text.length - phrase.length) {
    if (text.startsWith(phrase, pos)) {
      count++;
      if (count >= target) return count;
      pos += phrase.length;
    } else {
      pos++;
    }
  }
  return count;
}

/**
 * Detect a repeated phrase that dominates the response.
 *
 * Some models get stuck in a generation loop, outputting the same sentence
 * hundreds of times. Returns the first clean occurrence if repetition is
 * detected, or null if the text is normal.
 */
export function detectRepetition(text: string): string | null {
  if (text.length < MIN_REPEAT_PHRASE_LEN * REPEAT_THRESHOLD) return null;

  const maxStartOffset = Math.min(500, text.length / 3);
  const maxPhraseLen = Math.min(text.length / 3, 2000);

  for (let offset = 0; offset <= maxStartOffset; offset += 20) {
    for (
      let phraseLen = MIN_REPEAT_PHRASE_LEN;
      phraseLen <= maxPhraseLen;
      phraseLen += 20
    ) {
      if (offset + phraseLen > text.length) break;
      const phrase = text.slice(offset, offset + phraseLen);
      const count = countOccurrences(text, phrase, offset, REPEAT_THRESHOLD);
      if (count >= REPEAT_THRESHOLD) {
        const firstEnd = offset + phraseLen;
        const secondStart = text.indexOf(phrase, firstEnd);
        if (secondStart > 0) return text.slice(0, secondStart).trimEnd();
        return text.slice(0, firstEnd).trimEnd();
      }
    }
  }
  return null;
}

// ─── Trailing continuation detection ─────────────────────────────────────────

/**
 * Pattern matching conditional/future phrasing that precedes intent verbs.
 * When the model writes "Once you provide details, I'll create the team",
 * the intent is conditional — not a trailing continuation failure.
 */
const CONDITIONAL_PREFIX =
  /(?:once|when|if|after|before|unless|until|whether|should you|whenever)\b/i;

/**
 * Detect trailing continuation intent in the tail of a long response.
 *
 * Returns true when the response is long enough to be substantive (>100 chars)
 * and its last ~250 characters contain a phrase indicating the LLM intended
 * to continue with a tool call but stopped generating.
 */
export function detectTrailingContinuationIntent(text: string): boolean {
  if (text.length < 100) return false;
  const tail = text.slice(-250).trim();
  if (!TRAILING_CONTINUATION_PATTERN.test(tail)) return false;
  return !CONDITIONAL_PREFIX.test(tail);
}

// ─── Dense narration detection ───────────────────────────────────────────────

/**
 * Minimum intent-phrase count for a long response to be considered dense narration.
 */
const DENSE_NARRATION_THRESHOLD = 5;

/**
 * Global pattern matching intent phrases throughout a response body.
 * Used to count occurrences for dense-narration detection.
 */
const INTENT_PHRASE_GLOBAL =
  /\b(?:Let me |I(?:'ll| will| need to| should| am going to) (?:search|fetch|look|find|check|browse|retrieve|read|verify|list|examine|explore|create|write|run|open|update|fix|use|set up|continue|also |now |next ))/gi;

/** Detect whether a long response is dominated by intent narration. */
export function detectDenseNarration(
  text: string,
  hasTools: boolean,
): boolean {
  if (!hasTools || text.length < 300) return false;
  const matches = text.match(INTENT_PHRASE_GLOBAL);
  return (matches?.length ?? 0) >= DENSE_NARRATION_THRESHOLD;
}

// ─── Quality classification ──────────────────────────────────────────────────

/**
 * Pattern matching echoed tool-call placeholder text.
 * Some models parrot back the assistant history entry instead of continuing.
 * No `^` anchor on the second alternative — the placeholder may be embedded
 * after narration text (e.g. "Let me keep reading.(1 tool call(s) executed...)").
 */
const ECHOED_TOOL_PLACEHOLDER =
  /^\[Used tools:.*\]$|\(\d+ tool call(?:\(s\))? (?:executed|pending|queued|in progress)|^\[results\]$/;

/** Response quality classification result. */
export interface ResponseQuality {
  readonly isEmptyOrJunk: boolean;
  readonly isLeakedIntent: boolean;
  readonly hasTrailingIntent: boolean;
  readonly isTruncated: boolean;
  readonly isDenseNarration: boolean;
}

/** Options for classifying response quality. */
export interface ResponseQualityOptions {
  readonly finalText: string;
  readonly hasTools: boolean;
  readonly finishReason?: string;
  readonly allowJsonResponse?: boolean;
}

/** Detect whether the final text is empty, bare JSON junk, leaked intent, trailing intent, or truncated. */
export function classifyResponseQuality(
  finalTextOrOpts: string | ResponseQualityOptions,
  hasToolsArg?: boolean,
): ResponseQuality {
  const finalText = typeof finalTextOrOpts === "string"
    ? finalTextOrOpts
    : finalTextOrOpts.finalText;
  const hasTools = typeof finalTextOrOpts === "string"
    ? (hasToolsArg ?? false)
    : finalTextOrOpts.hasTools;
  const finishReason = typeof finalTextOrOpts === "string"
    ? undefined
    : finalTextOrOpts.finishReason;

  const isTruncated = finishReason === "length";
  const allowJsonResponse = typeof finalTextOrOpts !== "string" &&
    finalTextOrOpts.allowJsonResponse === true;
  const isEmptyOrJunk = finalText.length === 0 ||
    (!allowJsonResponse && finalText.length < 200 &&
      finalText.startsWith("{") &&
      finalText.endsWith("}")) ||
    (finalText.length < 200 && ECHOED_TOOL_PLACEHOLDER.test(finalText));
  const isLeakedIntent = hasTools && finalText.length < 300 &&
    LEAKED_INTENT_PATTERN.test(finalText);
  const hasTrailingIntent = hasTools &&
    detectTrailingContinuationIntent(finalText);
  const isDenseNarration = detectDenseNarration(finalText, hasTools);
  return {
    isEmptyOrJunk,
    isLeakedIntent,
    hasTrailingIntent,
    isTruncated,
    isDenseNarration,
  };
}

/** Options for building a recovery nudge. */
export interface RecoveryNudgeOptions {
  readonly isLeakedIntent: boolean;
  readonly hasTrailingIntent: boolean;
  readonly isTruncated: boolean;
  readonly isDenseNarration: boolean;
}

/** Build the nudge message for empty/junk, leaked-intent, truncated, or trailing-intent responses. */
export function buildRecoveryNudge(
  opts: RecoveryNudgeOptions,
  nudgeCount: number,
): string {
  if (opts.isTruncated) {
    return "[SYSTEM] Your response was truncated because it exceeded the output token limit. " +
      "Your tool call was cut off and could not be executed. " +
      "Break the task into smaller steps: write shorter files, use fewer tool arguments, " +
      "or split large operations across multiple tool calls.";
  }
  if (opts.isDenseNarration) {
    return "[SYSTEM] You wrote a long planning narrative without calling any tools. " +
      "Stop narrating and ACT. Call one tool now.";
  }
  if (opts.hasTrailingIntent) {
    return "[SYSTEM] You stated you would continue but stopped without using a tool. Execute the next step now.";
  }
  if (opts.isLeakedIntent) {
    return "[SYSTEM] You described your intent but didn't use a tool. Use the tools provided to you directly instead of narrating what you plan to do.";
  }
  if (nudgeCount === 1) {
    return "[SYSTEM] Your response was empty. Please respond to the user's message with a helpful answer. If the user asked you to search or look something up, use the web_search tool.";
  }
  return "[SYSTEM] Your previous response was still empty. You MUST write a natural language response. Summarize what you know and answer the user directly.";
}

/** The fallback response when the model returns empty/junk after all nudges. */
export const FALLBACK_RESPONSE =
  "The language model did not produce a usable response after multiple attempts. " +
  "This is typically caused by output token limits or provider issues. " +
  "Try rephrasing the request or breaking it into smaller steps.";
