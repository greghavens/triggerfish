/**
 * Screen event handlers for LLM lifecycle and streaming responses.
 *
 * Handles llm_start, llm_complete, response_chunk (with thinking-tag
 * filtering), vision_start, and final response events.
 * @module
 */

import type { ScreenManager } from "../../terminal/screen.ts";
import { DIM, RESET } from "../render/ansi.ts";
import type { ToolDisplayMode } from "../render/ansi.ts";
import { formatResponse } from "../render/format.ts";
import { createSpinner } from "../render/spinner.ts";
import {
  ensureStreamingActive,
  resetScreenStreamingState,
  type ScreenHandlerState,
  stopSpinnerFallback,
  writeIndentedChunk,
  writeStreamingHeader,
} from "./event_handler_state.ts";

/** Handle llm_start event. */
export function renderScreenLlmStart(
  state: ScreenHandlerState,
  screen: ScreenManager,
  event: { iteration: number; maxIterations: number },
): void {
  if (screen.isTty) {
    screen.startSpinner(
      event.iteration > 1
        ? `step ${event.iteration}/${event.maxIterations}`
        : "",
    );
  } else {
    state.spinner = createSpinner(
      event.iteration === 1
        ? "Thinking\u2026"
        : `Thinking\u2026 (step ${event.iteration}/${event.maxIterations})`,
    );
  }
}

/** Handle llm_complete event. */
export function renderScreenLlmComplete(
  state: ScreenHandlerState,
  screen: ScreenManager,
  getDisplayMode: () => ToolDisplayMode,
  hasToolCalls: boolean,
): void {
  stopSpinnerFallback(state, screen);
  if (hasToolCalls) {
    closeReasoningStream(state, screen, getDisplayMode);
    if (state.isStreaming) screen.writeChunk("\n");
    resetScreenStreamingState(state);
  }
}

/** Handle thinking content from a response chunk. */
function handleThinkingChunk(
  state: ScreenHandlerState,
  screen: ScreenManager,
  thinking: string,
  enteredThinking: boolean,
  exitedThinking: boolean,
): void {
  ensureStreamingActive(state, screen);
  writeStreamingHeader(state, screen);
  if (enteredThinking && !state.thinkingHeaderWritten) {
    screen.writeChunk(`  ${DIM}`);
    state.thinkingHeaderWritten = true;
  }
  if (thinking.length > 0) {
    state.atLineStart = writeIndentedChunk(screen, thinking, state.atLineStart);
  }
  if (exitedThinking) {
    screen.writeChunk(`${RESET}\n`);
    state.atLineStart = true;
    state.thinkingHeaderWritten = false;
  }
}

/** Close an open reasoning-stream run when content begins. */
function closeReasoningStream(
  state: ScreenHandlerState,
  screen: ScreenManager,
  getDisplayMode: () => ToolDisplayMode,
): void {
  if (!state.inReasoningStream) return;
  state.inReasoningStream = false;
  if (getDisplayMode() === "expanded") {
    handleThinkingChunk(state, screen, "", false, true);
  }
}

/**
 * Handle reasoning_chunk event (provider-separated thinking text).
 *
 * Distinct from the inline `<think>` tags some models emit in their content
 * stream: those flow through the response_chunk path and are stripped by
 * thinkFilter. reasoning_chunk arrives on a dedicated channel from providers
 * that expose model thinking via `reasoning_content` (DeepSeek R1, GLM Z1/4.7,
 * Kimi K2.5, Qwen3, etc.). Rendered identically to inline thinking when the
 * display mode is expanded; suppressed otherwise.
 */
export function renderScreenReasoningChunk(
  state: ScreenHandlerState,
  screen: ScreenManager,
  getDisplayMode: () => ToolDisplayMode,
  text: string,
): void {
  if (getDisplayMode() !== "expanded") {
    state.inReasoningStream = true;
    return;
  }
  const entering = !state.inReasoningStream;
  state.inReasoningStream = true;
  handleThinkingChunk(state, screen, text, entering, false);
}

/** Handle response_chunk event (streaming text). */
export function renderScreenResponseChunk(
  state: ScreenHandlerState,
  screen: ScreenManager,
  getDisplayMode: () => ToolDisplayMode,
  text: string,
): void {
  closeReasoningStream(state, screen, getDisplayMode);
  const { visible, thinking, enteredThinking, exitedThinking } = state
    .thinkFilter.filter(text);

  const hasThinkingContent = thinking.length > 0 || enteredThinking ||
    exitedThinking;
  if (hasThinkingContent && getDisplayMode() === "expanded") {
    handleThinkingChunk(
      state,
      screen,
      thinking,
      enteredThinking,
      exitedThinking,
    );
  }

  if (visible.length > 0) {
    ensureStreamingActive(state, screen);
    writeStreamingHeader(state, screen);
    state.atLineStart = writeIndentedChunk(
      screen,
      visible,
      state.atLineStart,
    );
  }
}

/** Handle vision_start event. */
export function renderScreenVisionStart(
  state: ScreenHandlerState,
  screen: ScreenManager,
  event: { imageCount: number },
): void {
  const label = event.imageCount === 1
    ? "Analyzing image"
    : `Analyzing ${event.imageCount} images`;
  if (screen.isTty) {
    screen.startSpinner(label);
  } else {
    state.spinner = createSpinner(label + "\u2026");
  }
}

/** Handle response event (final response). */
export function renderScreenResponse(
  state: ScreenHandlerState,
  screen: ScreenManager,
  text: string,
): void {
  if (screen.isTty) screen.stopSpinner();
  if (state.isStreaming) {
    screen.writeOutput("");
    resetScreenStreamingState(state);
  } else {
    screen.writeOutput(formatResponse(text));
    state.thinkFilter.reset();
  }
}

/** @deprecated Use renderScreenLlmStart instead */
export const handleScreenLlmStart = renderScreenLlmStart;

/** @deprecated Use renderScreenLlmComplete instead */
export const handleScreenLlmComplete = renderScreenLlmComplete;

/** @deprecated Use renderScreenResponseChunk instead */
export const handleScreenResponseChunk = renderScreenResponseChunk;

/** @deprecated Use renderScreenVisionStart instead */
export const handleScreenVisionStart = renderScreenVisionStart;

/** @deprecated Use renderScreenResponse instead */
export const handleScreenResponse = renderScreenResponse;
