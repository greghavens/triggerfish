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

/** Input shape for the llm_task tool. */
interface LlmTaskInput {
  readonly prompt: string;
  readonly system?: string;
  readonly model?: string;
}

/** Tool definitions for the llm_task tool. */
export function buildLlmTaskToolDefinitions(): readonly ToolDefinition[] {
  return [
    {
      name: "llm_task",
      description:
        "Run a one-shot LLM prompt for deep reasoning, analysis, or planning. " +
        "Use this tool when you need to think through a complex problem, analyze code structure, " +
        "plan a multi-step approach, summarize content, classify data, or extract structured information. " +
        "The subtask runs in isolation — it sees only what you pass, not the full conversation. " +
        "Get the analysis back, then act on it with tool calls.",
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
export const LLM_TASK_SYSTEM_PROMPT = `## LLM Task Tool — Your Reasoning Channel

llm_task is your dedicated reasoning tool. When you need to think deeply about a
problem before acting, delegate the thinking to llm_task — it runs with extended
reasoning enabled, giving you higher-quality analysis.

**When to use llm_task:**
- Enhancing a user request with their known rules, preferences, and conventions
  (search memories first, then pass those rules + the request to llm_task for
  a refined plan that respects everything the user has told you)
- Planning a multi-step approach before executing tool calls
- Analyzing code structure or debugging complex issues
- Reasoning through edge cases or architectural trade-offs
- Summarizing fetched content or extracting structured data
- Classifying, categorizing, or generating search queries

**How to use it effectively:**
1. Pass the relevant context (code, error messages, requirements) as the prompt
2. Get the analysis back as text
3. Act on the analysis with concrete tool calls

The subtask sees only what you pass it, not the full conversation.
If you need structured data back, ask for JSON in the prompt.`;

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

    try {
      const result = await provider.complete(messages, [], {});
      return result.content;
    } catch (err) {
      return `Error in llm_task: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  };
}

/** @deprecated Use buildLlmTaskToolDefinitions instead */
export const getLlmTaskToolDefinitions = buildLlmTaskToolDefinitions;
