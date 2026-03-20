/**
 * Trigger tool definitions and system prompts.
 *
 * Provides ToolDefinition objects for:
 * - `trigger_add_to_context` — loads the most recent trigger output into context.
 *
 * Also exports system prompt fragments for user sessions and trigger sessions.
 *
 * @module
 */

import type { ToolDefinition } from "../../../core/types/tool.ts";

function buildTriggerAddToContextDef(): ToolDefinition {
  return {
    name: "trigger_add_to_context",
    description:
      "Add the output of the last trigger run to the current conversation context. " +
      "Blocked if your session taint is higher than the trigger's classification (write-down). " +
      "If the trigger's classification is higher than your session taint, your session taint will escalate.",
    parameters: {
      source: {
        type: "string",
        description:
          "Trigger source identifier. Defaults to 'trigger' (the periodic trigger). " +
          "Use 'cron:<job-id>' for cron jobs or 'webhook:<source-id>' for webhooks.",
        required: false,
      },
    },
  };
}

/** Build the tool definitions for trigger context tools. */
export function buildTriggerToolDefinitions(): readonly ToolDefinition[] {
  return [buildTriggerAddToContextDef()];
}

/** @deprecated Use buildTriggerToolDefinitions instead */
export const getTriggerToolDefinitions = buildTriggerToolDefinitions;

/** @deprecated Use buildTriggerToolDefinitions instead */
export const getTriggerContextToolDefinitions = buildTriggerToolDefinitions;

/** System prompt section explaining trigger_add_to_context to the user-session LLM. */
export const TRIGGER_TOOLS_SYSTEM_PROMPT = `## Trigger Context

You can retrieve recent trigger outputs and inject them into the conversation.

- Use \`trigger_add_to_context\` to load the last periodic trigger result into context.
  - The \`source\` parameter defaults to "trigger" (the periodic trigger loop).
  - For cron jobs, use \`source="cron:<job-id>"\`. For webhooks, use \`source="webhook:<source-id>"\`.
- Write-down enforcement applies: if your session taint is higher than the trigger's
  classification, adding it to context is blocked.
- When a trigger is successfully added, its content and classification are visible in context.
- If the trigger's classification exceeds your current session taint, your session taint
  will automatically escalate to match it.`;

/**
 * System prompt section for trigger sessions — explains classification-ordered execution.
 *
 * Injected into the orchestrator system prompt when isTriggerSession is true.
 * Instructs the agent to use simulate_tool_call to determine execution order
 * from lowest to highest classification to avoid write-down violations mid-session.
 */
export const TRIGGER_SESSION_SYSTEM_PROMPT =
  `## Trigger Session — Classification-Ordered Execution

You are running in a trigger session. Your session taint starts at PUBLIC and escalates as you call classified tools. Calling a lower-classified tool AFTER a higher-classified one is blocked as a write-down violation.

**Required protocol before calling any integration tools (gmail_, calendar_, drive_, github_, etc.):**

1. **Identify all tools** you plan to call in this session.
2. **Call \`simulate_tool_call\`** for each planned tool to see its resulting taint level.
3. **Order your work from lowest to highest resulting taint** — PUBLIC first, then INTERNAL, then CONFIDENTIAL, then RESTRICTED.
4. **Execute in order** — your session taint escalates naturally. Your final session taint reflects the highest classification you accessed.

Your output is stored in the trigger store and stamped with your final session taint. The owner can then optionally pull it into their session via \`trigger_add_to_context\`, at which point their session taint may escalate to match yours.

If you skip classification ordering and call a higher-classified tool before a lower one, subsequent lower-classified calls will be blocked by write-down enforcement. Always simulate first.

**Efficient querying — CRITICAL:**

When checking for updates, always fetch only recent activity:
- GitHub: use \`sort: "updated"\`, \`direction: "desc"\`, \`per_page: 5\`
- Only increase per_page if the user's instructions specifically require more
- Never fetch all issues/PRs — only the most recently updated ones

**Deduplication — CRITICAL:**

Your prior trigger run results (if any) are injected at the top of your instructions under "Prior Trigger Results". You MUST NOT repeat findings that already appear there. Only report NEW or CHANGED information since the last run. If a PR was already reported, a calendar event was already mentioned, or an email was already summarized in prior results — skip it. The owner has already seen it.

**Notification policy — CRITICAL:**

You are a background process. The owner does NOT want to hear from you unless you found something worth reporting. After checking the items in your instructions:

- If there is **nothing actionable or noteworthy**, respond with exactly \`NO_ACTION\` and nothing else. Do NOT say "nothing to report", "all clear", or any variation — just \`NO_ACTION\`.
- If there **is** something worth reporting (urgent email, upcoming meeting, important message, etc.), respond with a concise summary of ONLY the relevant findings.
- Never pad your response with filler like "I checked your email and calendar and found nothing." That is noise, not signal.`;
