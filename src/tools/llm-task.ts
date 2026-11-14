/**
 * llm_task tool — isolated one-shot LLM completions for subtasks.
 *
 * Enables the agent to run focused LLM calls (summarization, extraction,
 * classification, plan generation) without polluting the main conversation
 * history. Used heavily by the deep research skill.
 *
 * @module
 */

import type { ToolDefinition } from "../core/types/tool.ts";
import type { LlmProviderRegistry } from "../core/types/llm.ts";
import { createLogger } from "../core/logger/mod.ts";

const log = createLogger("llm-task");

/** Input shape for the llm_task tool. */
interface LlmTaskInput {
  readonly prompt: string;
  readonly system?: string;
  readonly model?: string;
}

/** Maximum time in ms to wait for an llm_task completion before aborting. */
const LLM_TASK_TIMEOUT_MS = 30_000;

/**
 * Pattern detecting arithmetic/data-processing prompts that the model
 * should handle inline instead of delegating to llm_task.
 *
 * Deterministic gate — the LLM ignores the tool description telling it
 * not to use llm_task for arithmetic, so we enforce it in code.
 */
const TRIVIAL_TASK_PATTERN =
  /\b(?:calculate|sum|total|count|add up|tally|aggregate|how many|tabulate|summar(?:y|ize|ise)|download.?count|group by)\b/i;

/** Tool definitions for the llm_task tool. */
export function buildLlmTaskToolDefinitions(): readonly ToolDefinition[] {
  return [
    {
      name: "llm_task",
      description:
        "Run a one-shot LLM prompt ONLY for problems requiring extended multi-step reasoning " +
        "that you genuinely cannot solve yourself. Examples: complex architectural trade-off " +
        "analysis, multi-constraint planning with many interacting rules, intricate debugging " +
        "chains. Do NOT use for arithmetic, counting, summing, data extraction, summarization, " +
        "formatting, or any task you can accomplish directly — those are faster and cheaper " +
        "inline. The subtask runs in isolation with no tools and no conversation context.",
      parameters: {
        prompt: {
          type: "string",
          description: "The prompt to send",
          required: true,
        },
        system: {
          type: "string",
          description: "Optional system prompt",
          required: false,
        },
        model: {
          type: "string",
          description: "Optional model/provider name override",
          required: false,
        },
      },
    },
  ];
}

/** Platform-level system prompt section for the llm_task tool. */
export const LLM_TASK_SYSTEM_PROMPT =
  `## LLM Task Tool — Extended Reasoning Only

llm_task delegates a prompt to an LLM with extended reasoning enabled.
It has NO tools and NO conversation context — it only sees what you pass.

**When to use llm_task:**
- Reasoning through complex multi-constraint problems (many interacting rules)
- Architectural trade-off analysis requiring deep chain-of-thought
- Multi-step planning where the plan itself is the hard part

**Do NOT use llm_task for:**
- Arithmetic, counting, summing numbers — do it yourself
- Summarizing or extracting data from tool responses — do it yourself
- Formatting, categorizing, or listing — do it yourself
- Any task you can accomplish directly in your response

llm_task is slow and expensive. If you can do the work yourself, do it yourself.`;

/**
 * Create a tool executor for the llm_task tool.
 *
 * Returns null for unrecognized tool names (chain pattern).
 */
export function createLlmTaskToolExecutor(
  registry: LlmProviderRegistry,
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    if (name !== "llm_task") return null;

    const taskInput = input as unknown as LlmTaskInput;

    if (typeof taskInput.prompt !== "string" || taskInput.prompt.length === 0) {
      return "Error: llm_task requires a non-empty 'prompt' argument (string).";
    }

    // Deterministic rejection of arithmetic/data-processing tasks.
    // The LLM ignores the tool description, so we enforce in code.
    if (TRIVIAL_TASK_PATTERN.test(taskInput.prompt)) {
      log.warn("llm_task rejected — trivial arithmetic/data task", {
        operation: "rejectTrivialLlmTask",
        promptSnippet: taskInput.prompt.slice(0, 100),
      });
      return (
        "REJECTED: Do not use llm_task for arithmetic, counting, summing, " +
        "or data aggregation. You already have the data in your conversation " +
        "context — calculate the answer yourself directly in your response."
      );
    }

    const modelName = typeof taskInput.model === "string"
      ? taskInput.model
      : undefined;
    const provider = modelName
      ? registry.get(modelName) ?? registry.getDefault()
      : registry.getDefault();

    if (!provider) {
      return "Error: No LLM provider available.";
    }

    const messages: { role: string; content: string }[] = [];
    if (typeof taskInput.system === "string" && taskInput.system.length > 0) {
      messages.push({ role: "system", content: taskInput.system });
    }
    messages.push({ role: "user", content: taskInput.prompt });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        provider.complete(messages, [], {}),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () =>
              reject(
                new Error(`llm_task timed out after ${LLM_TASK_TIMEOUT_MS}ms`),
              ),
            LLM_TASK_TIMEOUT_MS,
          );
        }),
      ]);
      return result.content;
    } catch (err) {
      log.error("llm_task failed", {
        operation: "executeLlmTask",
        err,
      });
      return `Error in llm_task: ${
        err instanceof Error ? err.message : String(err)
      }`;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  };
}

/** @deprecated Use buildLlmTaskToolDefinitions instead */
export const getLlmTaskToolDefinitions = buildLlmTaskToolDefinitions;
