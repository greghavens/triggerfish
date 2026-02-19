/**
 * Agent orchestrator — the main agent loop.
 *
 * Receives messages from channels, fires enforcement hooks,
 * builds LLM context with SPINE.md, calls the LLM provider,
 * executes tool calls, and returns responses subject to policy checks.
 *
 * Uses native tool calling: tool definitions are passed to providers via
 * their API (OpenAI tools format). All supported providers handle native
 * tool calls, so text-based fallback is not needed.
 *
 * @module
 */

import { createLogger } from "../core/logger/mod.ts";
import type { Result, ClassificationLevel } from "../core/types/classification.ts";
import { canFlowTo } from "../core/types/classification.ts";
import type { SecretStore } from "../secrets/keychain.ts";
import { resolveSecretRefs } from "../secrets/resolver.ts";
import type { PathClassifier } from "../core/security/path_classification.ts";
import type { ToolFloorRegistry } from "../core/security/tool_floors.ts";
import {
  FILESYSTEM_READ_TOOLS,
  FILESYSTEM_WRITE_TOOLS,
  URL_READ_TOOLS,
  URL_WRITE_TOOLS,
} from "../core/security/constants.ts";
import type { DomainClassifier } from "../web/domains.ts";
import type { SessionState, SessionId } from "../core/types/session.ts";
import type { HookRunner } from "../core/policy/hooks.ts";
import type { LlmProviderRegistry, LlmMessage, LlmProvider } from "./llm.ts";
import { createCompactor, estimateHistoryTokens, countTokens } from "./compactor.ts";
import type { Compactor, CompactorConfig, CompactResult } from "./compactor.ts";
import type { MessageContent, ImageContentBlock, ContentBlock } from "../image/content.ts";
import { extractText, hasImages, normalizeContent } from "../image/content.ts";
import type { PlanManager } from "./plan.ts";
import { createPlanToolExecutor } from "./plan.ts";
import { buildPlanModePrompt, buildAwaitingApprovalPrompt, buildPlanExecutionPrompt } from "./plan_prompt.ts";

/** Default system prompt used when no SPINE.md is found. */
const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful AI assistant powered by Triggerfish. " +
  "Follow the user's instructions and respond clearly and concisely.";

/** Maximum tool call iterations to prevent infinite loops. */
const MAX_TOOL_ITERATIONS = 25;

/** Iteration at which the LLM is warned to wrap up. */
const SOFT_LIMIT_ITERATIONS = 20;

/**
 * Pattern detecting leaked tool-intent narration in LLM responses.
 * Matches phrases like "I'll search", "Let me fetch", "I need to look up", etc.
 * Used as a defense-in-depth guard — the primary fix is prompt hardening.
 */
export const LEAKED_INTENT_PATTERN =
  /\b(?:(?:I(?:'ll| will| need to| should| can| am going to)\s+(?:search|fetch|look up|find|check|browse|retrieve|use web_))|(?:(?:Let|let) me (?:search|fetch|look|find|check|browse|retrieve|use))|(?:(?:We|I) need to (?:fetch|search|look up|find|check|browse|retrieve)))/i;

/** A tool definition for prompt-based tool calling. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, {
    readonly type: string;
    readonly description: string;
    readonly required?: boolean;
    readonly items?: Readonly<Record<string, unknown>>;
    readonly enum?: readonly string[];
  }>>;
}

/** Handler that executes a tool call and returns the result text. */
export type ToolExecutor = (
  name: string,
  input: Record<string, unknown>,
) => Promise<string>;

/** Configuration for creating an orchestrator. */
export interface OrchestratorConfig {
  readonly hookRunner: HookRunner;
  readonly providerRegistry: LlmProviderRegistry;
  readonly spinePath?: string;
  /** Tool definitions available to the agent. */
  readonly tools?: readonly ToolDefinition[];
  /**
   * Live getter for additional tool definitions resolved at each LLM call.
   * Used for dynamically-connected sources such as MCP servers.
   */
  readonly getExtraTools?: () => readonly ToolDefinition[];
  /**
   * Live getter for additional system prompt sections resolved at each LLM call.
   * Used for dynamically-connected sources such as MCP servers.
   */
  readonly getExtraSystemPromptSections?: () => readonly string[];
  /** Callback to execute tool calls. */
  readonly toolExecutor?: ToolExecutor;
  /** Event callback for real-time progress reporting. */
  readonly onEvent?: OrchestratorEventCallback;
  /** Configuration for conversation compactor. */
  readonly compactorConfig?: Partial<CompactorConfig>;
  /**
   * Additional system prompt sections injected by the platform.
   * Appended AFTER SPINE.md and tool definitions. SPINE.md remains
   * the foundation — these sections layer platform behaviour on top.
   */
  readonly systemPromptSections?: readonly string[];
  /** Plan manager for plan mode state tracking and tool execution. */
  readonly planManager?: PlanManager;
  /** Enable streaming responses from the LLM provider. Default: true. */
  readonly enableStreaming?: boolean;
  /** Enable verbose logging of LLM responses and tool calls to stderr. */
  readonly debug?: boolean;
  /** Vision-capable LLM provider for describing images when the primary model lacks vision. */
  readonly visionProvider?: LlmProvider;
  /** Tool prefix → classification level. Enforced before every tool dispatch. */
  readonly toolClassifications?: ReadonlyMap<string, ClassificationLevel>;
  /** Read current session taint for canFlowTo checks. */
  readonly getSessionTaint?: () => ClassificationLevel;
  /** Escalate session taint after tool dispatch (upward only via maxClassification). */
  readonly escalateTaint?: (level: ClassificationLevel, reason: string) => void;
  /** Whether the active session belongs to the owner. */
  readonly isOwnerSession?: () => boolean;
  /**
   * Classification ceiling for the active non-owner session.
   * null = no explicit classification → all tools blocked.
   * Non-null = tools classified at or below this level are allowed.
   */
  readonly getNonOwnerCeiling?: () => ClassificationLevel | null;
  /** Path classifier for filesystem tool security checks. */
  readonly pathClassifier?: PathClassifier;
  /** Domain classifier for URL-based tool security checks. Uses same infrastructure as pathClassifier. */
  readonly domainClassifier?: DomainClassifier;
  /** Tool floor registry for minimum classification enforcement. */
  readonly toolFloorRegistry?: ToolFloorRegistry;
  /**
   * Secret store for resolving `{{secret:name}}` references in tool arguments.
   * When provided, all tool input arguments are scanned and references substituted
   * before dispatch. The resolved values are never logged or returned to the LLM.
   */
  readonly secretStore?: SecretStore;
}

/** Config shape for building integration/plugin/channel classification map. */
export interface ClassificationMapConfig {
  /** Google Workspace classification. */
  readonly google?: { readonly classification?: string };
  /** GitHub integration classification. */
  readonly github?: { readonly classification?: string };
  /** Plugins keyed by name — each with enabled + classification. */
  readonly plugins?: Readonly<Record<string, { readonly enabled?: boolean; readonly classification?: string } | undefined>>;
}

/**
 * Build tool prefix → classification map for integrations, plugins, and channels.
 *
 * Built-in tools are not in this map and pass through ungated.
 * Only external integrations, plugins, and channels are classified.
 */
export function buildToolClassifications(config: ClassificationMapConfig): Map<string, ClassificationLevel> {
  const m = new Map<string, ClassificationLevel>();

  // Google Workspace — gmail_, calendar_, drive_, sheets_, tasks_
  const googleClassification = (config.google?.classification ?? "PUBLIC") as ClassificationLevel;
  for (const prefix of ["gmail_", "calendar_", "drive_", "sheets_", "tasks_"]) {
    m.set(prefix, googleClassification);
  }

  // GitHub — all tools start with github_
  m.set("github_", (config.github?.classification ?? "PUBLIC") as ClassificationLevel);

  // Plugins — each plugin's tools use {pluginName}_ prefix convention
  if (config.plugins) {
    for (const [name, pluginConfig] of Object.entries(config.plugins)) {
      const cfg = pluginConfig as { enabled?: boolean; classification?: string } | undefined;
      if (cfg?.enabled) {
        m.set(`${name}_`, (cfg.classification ?? "INTERNAL") as ClassificationLevel);
      }
    }
  }

  return m;
}

/** Options for processing a single message. */
export interface ProcessMessageOptions {
  readonly session: SessionState;
  readonly message: MessageContent;
  readonly targetClassification: ClassificationLevel;
  /** Optional signal to abort the operation. */
  readonly signal?: AbortSignal;
}

/** Successful response from message processing. */
export interface ProcessMessageResult {
  readonly response: string;
}

/** A conversation history entry. */
export interface HistoryEntry {
  readonly role: string;
  readonly content: MessageContent;
}

/** The orchestrator interface for processing messages. */
export interface Orchestrator {
  /** Process a user message through the full agent loop. */
  processMessage(
    options: ProcessMessageOptions,
  ): Promise<Result<ProcessMessageResult, string>>;
  /** Get conversation history for a session. */
  getHistory(sessionId: SessionId): readonly HistoryEntry[];
  /** Clear conversation history for a session. */
  clearHistory(sessionId: SessionId): void;
  /** Force LLM-based summarization of a session's history. */
  compactHistory(sessionId: SessionId): Promise<CompactResult>;
}

/** Events emitted by the orchestrator during message processing. */
export type OrchestratorEvent =
  | { readonly type: "llm_start"; readonly iteration: number; readonly maxIterations: number }
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
  | { readonly type: "response_chunk"; readonly text: string; readonly done: boolean }
  | { readonly type: "vision_start"; readonly imageCount: number }
  | { readonly type: "vision_complete"; readonly imageCount: number };

/** Callback for real-time orchestrator event reporting. */
export type OrchestratorEventCallback = (event: OrchestratorEvent) => void;

/**
 * Load SPINE.md content from the filesystem.
 * Returns the file content or null if the file cannot be read.
 */
async function loadSpine(spinePath: string | undefined): Promise<string | null> {
  if (!spinePath) return null;
  try {
    return await Deno.readTextFile(spinePath);
  } catch {
    return null;
  }
}

/** A parsed tool call from LLM text output. */
interface ParsedToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/**
 * Create an agent orchestrator.
 *
 * The orchestrator implements the agent loop:
 * 1. Receive message from channel
 * 2. Fire PRE_CONTEXT_INJECTION hook
 * 3. Build LLM context with SPINE.md as system prompt
 * 4. Send to LLM provider with native tool definitions
 * 5. Parse native tool calls from provider response
 * 6. If tool calls found: execute each, append results, call LLM again
 * 7. Repeat until no more tool calls (or max iterations)
 * 8. Fire PRE_OUTPUT on final text response
 * 9. Return response
 *
 * @param config - Orchestrator configuration
 * @returns An Orchestrator instance
 */
export function createOrchestrator(config: OrchestratorConfig): Orchestrator {
  const { hookRunner, providerRegistry, spinePath } = config;
  const baseTools = config.tools ?? [];
  const getExtraTools = config.getExtraTools;
  const getExtraSystemPromptSections = config.getExtraSystemPromptSections;
  const rawToolExecutor = config.toolExecutor;

  /** Computed security context returned alongside the hook input. */
  interface SecurityContext {
    readonly toolName: string;
    readonly toolFloor: ClassificationLevel | null;
    readonly resourceClassification: ClassificationLevel | null;
    readonly operationType: "read" | "write" | null;
    readonly isOwner: boolean;
    readonly nonOwnerCeiling: ClassificationLevel | null;
    readonly resourceParam: string | null;
  }

  /**
   * Build enriched hook input for PRE_TOOL_CALL with security context.
   * Returns both the hook input (flat Record for policy engine) and
   * the structured SecurityContext (for building detailed error messages).
   */
  function buildSecurityHookInput(
    call: ParsedToolCall,
  ): { input: Record<string, unknown>; ctx: SecurityContext } {
    const hookInput: Record<string, unknown> = { tool_call: call };
    const toolName = call.name;

    // Tool floor
    const toolFloor = config.toolFloorRegistry?.getFloor(toolName) ?? null;
    if (toolFloor !== null) {
      hookInput.tool_floor = toolFloor;
    }

    // Resource classification for filesystem and URL tools
    let resourceClassification: ClassificationLevel | null = null;
    let operationType: "read" | "write" | null = null;
    let resourceParam: string | null = null;

    // --- FILESYSTEM TOOLS ---
    const pathParam = (call.args.path ?? call.args.directory ?? call.args.search_path) as string | null ?? null;
    if (config.pathClassifier && pathParam) {
      if (FILESYSTEM_READ_TOOLS.has(toolName)) {
        const result = config.pathClassifier.classify(pathParam);
        resourceClassification = result.classification;
        operationType = "read";
        resourceParam = pathParam;
      } else if (FILESYSTEM_WRITE_TOOLS.has(toolName)) {
        const result = config.pathClassifier.classify(pathParam);
        resourceClassification = result.classification;
        operationType = "write";
        resourceParam = pathParam;
      }
    }

    // --- URL TOOLS ---
    const urlParam = (call.args.url) as string | undefined ?? null;
    if (config.domainClassifier && urlParam && resourceClassification === null) {
      if (URL_READ_TOOLS.has(toolName)) {
        const result = config.domainClassifier.classify(urlParam);
        resourceClassification = result.classification;
        operationType = "read";
        resourceParam = urlParam;
      } else if (URL_WRITE_TOOLS.has(toolName)) {
        const result = config.domainClassifier.classify(urlParam);
        resourceClassification = result.classification;
        operationType = "write";
        resourceParam = urlParam;
      }
    }

    // Set hook input fields (same fields regardless of source)
    if (resourceClassification !== null) {
      hookInput.resource_classification = resourceClassification;
      hookInput.operation_type = operationType;
    }

    // Identity context
    const isOwner = config.isOwnerSession?.() ?? true;
    hookInput.is_owner = isOwner;
    const nonOwnerCeiling = config.getNonOwnerCeiling?.() ?? null;
    if (nonOwnerCeiling !== null) {
      hookInput.non_owner_ceiling = nonOwnerCeiling;
    }

    return {
      input: hookInput,
      ctx: { toolName, toolFloor, resourceClassification, operationType, isOwner, nonOwnerCeiling, resourceParam },
    };
  }

  /**
   * Build a detailed, actionable error message for a blocked tool call.
   *
   * Uses the ruleId from the policy engine to determine which security
   * check failed, then includes the actual classification levels and
   * remediation advice (e.g. /clear to reset session taint).
   */
  function formatBlockReason(
    ruleId: string | null,
    ctx: SecurityContext,
    sessionTaint: ClassificationLevel,
  ): string {
    switch (ruleId) {
      case "tool-floor-enforcement":
        return `Error: "${ctx.toolName}" requires a minimum session taint of ${ctx.toolFloor}. ` +
          `Your current session taint is ${sessionTaint}. ` +
          `Access higher-classified data first to escalate your session taint, ` +
          `or use a tool that doesn't require ${ctx.toolFloor} clearance.`;

      case "resource-write-down":
        return `Error: Write-down blocked — your session taint is ${sessionTaint}, ` +
          `but the target resource${ctx.resourceParam ? ` "${ctx.resourceParam}"` : ""} is classified ${ctx.resourceClassification}. ` +
          `A ${sessionTaint}-tainted session cannot write to ${ctx.resourceClassification}-level destinations. ` +
          `Use /clear to reset your session context and taint before writing to ${ctx.resourceClassification}-classified resources.`;

      case "resource-read-ceiling":
        return `Error: Access denied — the resource${ctx.resourceParam ? ` "${ctx.resourceParam}"` : ""} is classified ${ctx.resourceClassification}, ` +
          `which exceeds your session ceiling of ${ctx.nonOwnerCeiling}. ` +
          `You do not have permission to access ${ctx.resourceClassification}-classified resources.`;

      case "no-write-down":
        return `Error: Write-down blocked — your session taint is ${sessionTaint}, ` +
          `which exceeds the target classification. ` +
          `Use /clear to reset your session context and taint before outputting to lower-classified channels.`;

      default:
        return `Tool call blocked by policy: ${ruleId ?? "denied"}`;
    }
  }

  // Wrap tool executor with classification enforcement for integrations.
  // Only tools whose name matches a prefix in toolClassifications are gated.
  // Built-in tools (read_file, todo_, plan., etc.) have no entry and pass through.
  // Matched integrations: escalate taint on entry.
  // Write-down check is done in processMessage (before this wrapper) so that
  // blocked=true can be set on the tool_result event for channel notification.
  const toolExecutor: ToolExecutor | undefined = rawToolExecutor
    ? async (name: string, input: Record<string, unknown>): Promise<string> => {
        // Non-owner tool access enforcement.
        if (config.isOwnerSession && !config.isOwnerSession()) {
          const ceiling = config.getNonOwnerCeiling?.() ?? null;

          // No explicit classification → all tools blocked.
          if (ceiling === null) {
            return `Error: Tool calls are not available in this session.`;
          }

          // Has explicit classification → only classified tools at or below ceiling.
          if (config.toolClassifications) {
            let matched = false;
            for (const [prefix, level] of config.toolClassifications) {
              if (name.startsWith(prefix)) {
                matched = true;
                if (!canFlowTo(level, ceiling)) {
                  return `Error: ${name} (classified ${level}) exceeds session ceiling ${ceiling}. Access denied.`;
                }
                break;
              }
            }
            // Unclassified tools (built-ins) are never available to non-owners.
            if (!matched) {
              return `Error: Tool calls are not available in this session.`;
            }
          }
        }

        if (config.toolClassifications && config.escalateTaint) {
          for (const [prefix, level] of config.toolClassifications) {
            if (name.startsWith(prefix)) {
              // Taint escalation for allowed integration calls.
              // Write-down check has already run in processMessage (before toolExecutor is called),
              // so this point is only reached when the call is permitted.
              config.escalateTaint(level, `Tool call: ${name}`);
              break;
            }
          }
        }

        // Resolve {{secret:name}} references in tool input before dispatch.
        // The LLM never sees the resolved values — substitution happens here,
        // below the LLM layer.
        let resolvedInput = input;
        if (config.secretStore) {
          const resolution = await resolveSecretRefs(input, config.secretStore);
          if (resolution.ok) {
            if (resolution.value.missing.length > 0) {
              return `Error: The following secrets were referenced but not found in the secret store: ${
                resolution.value.missing.map((n) => `'${n}'`).join(", ")
              }. Use secret_save to store them first.`;
            }
            resolvedInput = resolution.value.resolved;
          }
        }

        const result = await rawToolExecutor(name, resolvedInput);

        // Post-call: escalate based on response-level classification
        // (e.g. GitHub per-repo classification in _classification field)
        if (config.escalateTaint) {
          try {
            const parsed = JSON.parse(result);
            const cls = parsed._classification;
            if (typeof cls === "string") {
              config.escalateTaint(cls as ClassificationLevel, `Tool response: ${name}`);
            }
          } catch { /* not JSON or no classification field */ }
        }

        return result;
      }
    : undefined;
  const baseSystemPromptSections = config.systemPromptSections ?? [];
  const planManager = config.planManager;
  const visionProvider = config.visionProvider;
  const emit = config.onEvent ?? (() => {});
  const debug = config.debug ?? false;
  const histories = new Map<string, HistoryEntry[]>();

  // Derive effective budget: explicit config > provider contextWindow > 100k default
  const provider0 = providerRegistry.getDefault();
  const effectiveBudget = config.compactorConfig?.contextBudget
    ?? provider0?.contextWindow
    ?? 100_000;
  const compactor: Compactor = createCompactor({
    ...config.compactorConfig,
    contextBudget: effectiveBudget,
  });

  const orchLog = createLogger("orchestrator");

  /** Log to the structured logger at TRACE level (replaces old debugLog). */
  function debugLog(label: string, data: unknown): void {
    if (!debug) return;
    const str = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    const preview = str.length > 500 ? str.slice(0, 500) + `… [${str.length} chars]` : str;
    orchLog.trace(`${label}: ${preview}`);
  }

  /**
   * Describe images using the vision provider.
   * Returns a text description for each image block.
   */
  async function describeImages(
    images: readonly ImageContentBlock[],
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    const descriptions: string[] = [];
    for (const image of images) {
      const messages: LlmMessage[] = [
        {
          role: "user",
          content: [
            { type: "image", source: image.source },
            { type: "text", text: "Describe this image in detail. Be specific about what you see." },
          ],
        },
      ];
      try {
        const result = await visionProvider!.complete(messages, [], {
          ...(signal ? { signal } : {}),
        });
        descriptions.push(result.content);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        descriptions.push(`[Image description unavailable: ${msg}]`);
      }
    }
    return descriptions;
  }

  async function processMessage(
    options: ProcessMessageOptions,
  ): Promise<Result<ProcessMessageResult, string>> {
    const { session, message, targetClassification, signal } = options;

    // 1. Fire PRE_CONTEXT_INJECTION hook
    const preContextResult = await hookRunner.run("PRE_CONTEXT_INJECTION", {
      session,
      input: { content: extractText(message), source_type: "OWNER" },
    });

    if (!preContextResult.allowed) {
      return {
        ok: false,
        error: preContextResult.message ?? "Input blocked by policy",
      };
    }

    // Session key for history and plan state lookups
    const sessionKey = session.id as string;

    // 2. Get the default LLM provider
    const provider = providerRegistry.getDefault();
    if (!provider) {
      return { ok: false, error: "No default LLM provider configured" };
    }

    // 3. Build LLM context — load SPINE.md or use default prompt
    const spineContent = await loadSpine(spinePath);
    let systemPrompt = spineContent ?? DEFAULT_SYSTEM_PROMPT;

    // Append platform-level sections (layered after SPINE.md).
    // getExtraSystemPromptSections is called live to pick up dynamic sources (e.g. MCP).
    const effectiveSystemPromptSections = getExtraSystemPromptSections
      ? [...baseSystemPromptSections, ...getExtraSystemPromptSections()]
      : baseSystemPromptSections;
    for (const section of effectiveSystemPromptSections) {
      systemPrompt += "\n\n" + section;
    }

    // Inject plan mode context based on current session plan state
    if (planManager) {
      const planState = planManager.getState(sessionKey);
      if (planState.mode === "plan" && planState.goal) {
        systemPrompt += "\n\n" + buildPlanModePrompt(planState.goal, planState.scope);
      }
      if (planState.mode === "awaiting_approval") {
        systemPrompt += "\n\n" + buildAwaitingApprovalPrompt();
      }
      if (planState.activePlan) {
        systemPrompt += "\n\n" + buildPlanExecutionPrompt(planState.activePlan);
      }
    }

    // Get or create conversation history for this session
    if (!histories.has(sessionKey)) {
      histories.set(sessionKey, []);
    }
    const history = histories.get(sessionKey)!;

    // Add user message to history
    history.push({ role: "user", content: message });

    // Vision fallback: describe images for non-vision primary models
    if (visionProvider && typeof message !== "string" && hasImages(message as readonly ContentBlock[])) {
      const blocks = normalizeContent(message);
      const images = blocks.filter(
        (b): b is ImageContentBlock => b.type === "image",
      );

      emit({ type: "vision_start", imageCount: images.length });
      debugLog("vision", `describing ${images.length} image(s) via vision provider`);

      const descriptions = await describeImages(images, signal);

      emit({ type: "vision_complete", imageCount: images.length });

      // Build text-only message: inline descriptions where images were
      const parts: string[] = [];
      let descIdx = 0;
      for (const block of blocks) {
        if (block.type === "image") {
          parts.push(
            `[The user shared an image. A vision model described it as follows: ${descriptions[descIdx++]}]`,
          );
        } else {
          parts.push(block.text);
        }
      }
      const textOnlyMessage = parts.join("\n\n");

      // Replace the last history entry with the text-only version
      history[history.length - 1] = { role: "user", content: textOnlyMessage };

      // Tell the LLM that image descriptions are already provided
      systemPrompt += "\n\n## Image Descriptions\n" +
        "The user's message may contain image descriptions provided by a vision model " +
        "in brackets like [The user shared an image. A vision model described it as follows: ...]. " +
        "Treat these descriptions as if you can see the images yourself. " +
        "Do NOT use image_analyze or any other tool to re-examine these images — the descriptions are already complete.";
    }

    // Auto-compact history if approaching context limits.
    // Pass system prompt token count as overhead so the compactor measures
    // total context usage (system + history), not just history tokens alone.
    const systemPromptTokens = countTokens(systemPrompt);
    const compacted = compactor.compact(history, systemPromptTokens);
    if (compacted.length < history.length) {
      history.length = 0;
      history.push(...compacted);
    }

    // 4. Agent loop — call LLM, parse tool calls, execute, repeat
    let iterations = 0;
    let emptyNudgeCount = 0; // Track empty-response recovery attempts
    const MAX_EMPTY_NUDGES = 2;
    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      // Check abort signal
      if (signal?.aborted) {
        return { ok: false, error: "Operation cancelled by user" };
      }

      emit({ type: "llm_start", iteration: iterations, maxIterations: MAX_TOOL_ITERATIONS });

      // Build messages array: system prompt + conversation history
      const messages: LlmMessage[] = [
        { role: "system", content: systemPrompt },
        ...history,
      ];

      debugLog(`iter${iterations} sending`, `${messages.length} msgs, sysPrompt=${systemPrompt.length}chars, history=${history.length} entries`);
      if (debug && iterations === 1) {
        orchLog.trace(`=== SYSTEM PROMPT ===\n${systemPrompt}\n=== END SYSTEM PROMPT ===`);
        for (const h of history) {
          const preview = typeof h.content === "string" ? h.content.slice(0, 100) : "(non-string)";
          orchLog.trace(`history ${h.role}: ${preview}`);
        }
      }

      // Resolve live tool list — merges static tools with dynamic extra tools (e.g. MCP servers).
      const tools = getExtraTools
        ? [...baseTools, ...getExtraTools()]
        : baseTools;

      // Call LLM provider — pass native tool definitions for providers that support them
      const nativeTools = (tools.length > 0 && toolExecutor)
        ? tools.map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: {
                type: "object" as const,
                properties: Object.fromEntries(
                  Object.entries(t.parameters).map(([k, v]) => {
                    const prop: Record<string, unknown> = {
                      type: v.type,
                      description: v.description,
                    };
                    if (v.items) prop.items = v.items;
                    if (v.enum) prop.enum = v.enum;
                    return [k, prop];
                  }),
                ),
                required: Object.entries(t.parameters)
                  .filter(([_, v]) => v.required !== false)
                  .map(([k]) => k),
              },
            },
          }))
        : [];

      const completion = await provider.complete(messages, nativeTools, {
        ...(signal ? { signal } : {}),
      });

      // Close the race window: if the signal was aborted while the LLM was finishing,
      // treat the response as cancelled rather than emitting it.
      if (signal?.aborted) {
        return { ok: false, error: "Operation cancelled by user" };
      }

      debugLog(`iter${iterations} raw`, completion.content);

      // Parse native tool calls from provider response
      const hasTools = (tools.length > 0 && toolExecutor) || planManager;
      let parsedCalls: readonly ParsedToolCall[] = [];

      // Check for native tool calls from provider (OpenAI or Anthropic/Gemini format)
      if (hasTools && Array.isArray(completion.toolCalls) && completion.toolCalls.length > 0) {
        parsedCalls = completion.toolCalls
          .map((tc: unknown): ParsedToolCall | null => {
            const t = tc as Record<string, unknown>;
            if (t === null || typeof t !== "object") return null;

            // OpenAI format: { function: { name, arguments } }
            if (typeof (t as { function?: unknown }).function === "object") {
              const fn = (t as { function: { name: string; arguments: string } }).function;
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(fn.arguments);
              } catch {
                // Malformed arguments
              }
              return { name: fn.name, args };
            }

            // Anthropic format: { type: "tool_use", name, input }
            if (t.type === "tool_use" && typeof t.name === "string") {
              const input = (t.input ?? {}) as Record<string, unknown>;
              return { name: t.name as string, args: input };
            }

            return null;
          })
          .filter((tc): tc is ParsedToolCall => tc !== null);
        debugLog(`iter${iterations} nativeToolCalls`, parsedCalls.length);
      }

      debugLog(`iter${iterations} parsedCalls`, parsedCalls.length);

      emit({
        type: "llm_complete",
        iteration: iterations,
        hasToolCalls: parsedCalls.length > 0,
      });

      if (parsedCalls.length === 0) {
        // No tool calls — this is the final response
        const finalText = completion.content.trim();
        debugLog(`iter${iterations} finalText`, finalText || "(EMPTY)");

        // Recovery: if the model returned empty text, bare JSON gibberish,
        // or leaked tool intent (e.g. "We need to search web"), retry with
        // a nudge (up to MAX_EMPTY_NUDGES). Catches unreliable models.
        const isEmptyOrJunk = finalText.length === 0 ||
          (finalText.length < 200 && finalText.startsWith("{") && finalText.endsWith("}"));
        const isLeakedIntent = hasTools && finalText.length < 300 &&
          LEAKED_INTENT_PATTERN.test(finalText);
        if ((isEmptyOrJunk || isLeakedIntent) && emptyNudgeCount < MAX_EMPTY_NUDGES && iterations < MAX_TOOL_ITERATIONS) {
          emptyNudgeCount++;
          debugLog(`iter${iterations}`, `${isLeakedIntent ? "leaked intent" : "junk/empty"} (${finalText.length} chars) — nudge ${emptyNudgeCount}/${MAX_EMPTY_NUDGES}`);
          // Don't push empty assistant messages into history
          if (completion.content.trim().length > 0) {
            history.push({ role: "assistant", content: completion.content });
          }
          const nudge = isLeakedIntent
            ? "[SYSTEM] You described your intent but didn't use a tool. Use the tools provided to you directly instead of narrating what you plan to do."
            : (emptyNudgeCount === 1
              ? "[SYSTEM] Your response was empty. Please respond to the user's message with a helpful answer. If the user asked you to search or look something up, use the web_search tool."
              : "[SYSTEM] Your previous response was still empty. You MUST write a natural language response. Summarize what you know and answer the user directly.");
          history.push({ role: "user", content: nudge });
          continue;
        }

        // If the model returned empty/junk after exhausting nudges, provide a fallback
        const isJunkFinal = finalText.length === 0 || isEmptyOrJunk || isLeakedIntent;
        const responseText = isJunkFinal && emptyNudgeCount >= MAX_EMPTY_NUDGES
          ? "I'm sorry, I wasn't able to generate a response. The language model returned empty or malformed output. This may be a temporary issue — please try again, or consider switching to a more capable model (e.g. google/gemini-2.0-flash-001)."
          : finalText;

        // Fire PRE_OUTPUT hook — use real-time session taint (same pattern
        // as PRE_TOOL_CALL) so the write-down check sees post-escalation taint.
        // For owner sessions the output target IS the current session taint:
        // the owner reads their own session, so there is no write-down.
        // For non-owner channels the fixed targetClassification (channel level)
        // is correct and blocks output to lower-classified channels.
        const outputTaint = config.getSessionTaint?.() ?? session.taint;
        const outputSession = outputTaint !== session.taint
          ? { ...session, taint: outputTaint }
          : session;
        const isOwnerOutput = config.isOwnerSession !== undefined && config.isOwnerSession();
        const effectiveTargetClassification = isOwnerOutput
          ? outputTaint
          : targetClassification;

        const preOutputResult = await hookRunner.run("PRE_OUTPUT", {
          session: outputSession,
          input: {
            content: responseText,
            target_classification: effectiveTargetClassification,
          },
        });

        if (!preOutputResult.allowed) {
          return {
            ok: false,
            error: preOutputResult.message ?? "Output blocked by policy",
          };
        }

        emit({ type: "response", text: responseText });

        // Add assistant response to history
        history.push({ role: "assistant", content: responseText.length > 0 ? responseText : completion.content });

        return {
          ok: true,
          value: { response: responseText },
        };
      }

      // Tool calls found — add assistant message to history
      // If the model used native tool calls and content is empty, synthesize
      // a descriptive placeholder so the history stays coherent
      const assistantContent = completion.content.trim().length > 0
        ? completion.content
        : `[Used tools: ${parsedCalls.map((c) => c.name).join(", ")}]`;
      history.push({ role: "assistant", content: assistantContent });

      // Inject soft limit warning to help the LLM wrap up
      if (iterations === SOFT_LIMIT_ITERATIONS) {
        history.push({
          role: "user",
          content:
            `[SYSTEM] You have used many tool calls (${iterations}/${MAX_TOOL_ITERATIONS}). ` +
            `You have ${MAX_TOOL_ITERATIONS - iterations} remaining iterations. ` +
            "Please provide your best answer now based on the information gathered so far. " +
            "If you cannot find what you're looking for, say so rather than continuing to search.",
        });
      }

      // Execute each tool call and build results
      const resultParts: string[] = [];
      for (const call of parsedCalls) {
        // Check abort signal before each tool execution
        if (signal?.aborted) {
          return { ok: false, error: "Operation cancelled by user" };
        }

        emit({ type: "tool_call", name: call.name, args: call.args });

        let resultText: string | undefined;
        let blocked = false;

        // Step 1: Plan mode filter (only if plan manager exists)
        if (planManager && planManager.isToolBlocked(sessionKey, call.name)) {
          resultText = `Tool "${call.name}" is blocked in plan mode. ` +
            `Use plan.exit to present your implementation plan first.`;
          blocked = true;
        } else if (planManager) {
          // Step 2: Try plan tools (returns null if not a plan tool)
          const planExecutor = createPlanToolExecutor(planManager, sessionKey);
          const planResult = await planExecutor(call.name, call.args);
          if (planResult !== null) {
            resultText = planResult;
          }
        }

        // Step 3: Universal security + execution path (runs if not handled above)
        if (resultText === undefined) {
          const { input: secInput, ctx: secCtx } = buildSecurityHookInput(call);

          // Owner pre-escalation: escalate taint from the resolved resource
          // classification BEFORE the hook so tool floor checks see the
          // post-escalation taint. Owner sessions have no ceiling — reads
          // are always allowed. Write-down checks still work because
          // maxClassification only goes up (taint ≥ resource → no write-down).
          if (secCtx.resourceClassification !== null && secCtx.isOwner && config.escalateTaint) {
            config.escalateTaint(secCtx.resourceClassification, `${call.name}: ${secCtx.resourceParam}`);
          }

          // Use real-time session taint for hook evaluation — reflects both
          // prior tool calls in this turn and the owner pre-escalation above.
          const currentTaint = config.getSessionTaint?.() ?? session.taint;
          const hookSession = currentTaint !== session.taint
            ? { ...session, taint: currentTaint }
            : session;
          const preToolResult = await hookRunner.run("PRE_TOOL_CALL", {
            session: hookSession,
            input: secInput,
          });
          if (!preToolResult.allowed) {
            resultText = formatBlockReason(preToolResult.ruleId, secCtx, currentTaint);
            blocked = true;
          } else {
            // Integration write-down check — runs here (not inside toolExecutor) so that
            // `blocked` can be set to true, enabling channels like Telegram to notify the
            // user directly when a tool is blocked due to session taint exceeding the tool's
            // classification level.
            if (config.toolClassifications && config.getSessionTaint) {
              const integrationTaint = config.getSessionTaint();
              for (const [prefix, level] of config.toolClassifications) {
                if (call.name.startsWith(prefix)) {
                  if (!canFlowTo(integrationTaint, level)) {
                    resultText =
                      `Error: Session taint ${integrationTaint} cannot flow to ${call.name} (classified ${level}). ` +
                      `Accessing a lower-classified tool from a higher-tainted session risks data leakage. ` +
                      `Use /clear to reset your session context and taint before using ${level}-classified tools.`;
                    blocked = true;
                  }
                  break;
                }
              }
            }

            if (resultText === undefined) {
              // Non-owner escalation: only after hook confirms the read/write is allowed
              if (secCtx.resourceClassification !== null && !secCtx.isOwner && config.escalateTaint) {
                config.escalateTaint(secCtx.resourceClassification, `${call.name}: ${secCtx.resourceParam}`);
              }
              resultText = await toolExecutor!(call.name, call.args);
            }
          }
        }

        emit({
          type: "tool_result",
          name: call.name,
          result: resultText,
          blocked,
        });
        resultParts.push(`[TOOL_RESULT name="${call.name}"]\n${resultText}\n[/TOOL_RESULT]`);
      }

      // Add tool results as a user message
      history.push({ role: "user", content: resultParts.join("\n\n") });
    }

    // Exceeded max iterations
    return {
      ok: false,
      error: "Agent loop exceeded maximum tool call iterations",
    };
  }

  function getHistory(sessionId: SessionId): readonly HistoryEntry[] {
    const sessionKey = sessionId as string;
    return histories.get(sessionKey) ?? [];
  }

  function clearHistory(sessionId: SessionId): void {
    histories.delete(sessionId as string);
  }

  async function compactHistory(sessionId: SessionId): Promise<CompactResult> {
    const sessionKey = sessionId as string;
    const history = histories.get(sessionKey) ?? [];
    const messagesBefore = history.length;
    const tokensBefore = estimateHistoryTokens(history);

    if (history.length === 0) {
      return { messagesBefore: 0, messagesAfter: 0, tokensBefore: 0, tokensAfter: 0 };
    }

    const provider = providerRegistry.getDefault();
    if (!provider) {
      // Fall back to sliding-window compaction
      const compacted = [...compactor.compact(history)];
      history.length = 0;
      history.push(...compacted);
      const tokensAfter = estimateHistoryTokens(history);
      return { messagesBefore, messagesAfter: history.length, tokensBefore, tokensAfter };
    }

    const summarized = [...await compactor.summarize(history, provider)];
    history.length = 0;
    history.push(...summarized);
    const tokensAfter = estimateHistoryTokens(history);
    return { messagesBefore, messagesAfter: history.length, tokensBefore, tokensAfter };
  }

  return { processMessage, getHistory, clearHistory, compactHistory };
}
