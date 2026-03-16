/**
 * Claude session tool definitions — LLM-callable schema declarations.
 *
 * Consolidated from 5 tools to 2:
 * - claude_session (action: start, send, stop, status)
 * - claude_output (kept separate — read-back tool called repeatedly)
 *
 * @module
 */

import type { ToolDefinition } from "../core/types/tool.ts";

function buildClaudeSessionDef(): ToolDefinition {
  return {
    name: "claude_session",
    description:
      "Claude Code CLI session management. Actions: start, send, stop, status.\n" +
      "- start: start a new session. Params: prompt (required), model?, max_turns?, timeout_ms?, working_dir?, system_prompt?, allowed_tools?, max_budget_usd?\n" +
      "- send: send follow-up message. Params: session_id (required), input (required)\n" +
      "- stop: terminate session. Params: session_id (required)\n" +
      "- status: check session status. Params: session_id (required)",
    parameters: {
      action: {
        type: "string",
        description: "The operation: start, send, stop, status",
        required: true,
      },
      session_id: {
        type: "string",
        description: "Session ID from a previous start action",
        required: false,
      },
      prompt: {
        type: "string",
        description: "Initial prompt/task for the session (start)",
        required: false,
      },
      input: {
        type: "string",
        description: "Follow-up message to send (send)",
        required: false,
      },
      model: {
        type: "string",
        description: 'Model to use, e.g. "sonnet", "opus" (start)',
        required: false,
      },
      max_turns: {
        type: "number",
        description: "Maximum agent iteration turns (start)",
        required: false,
      },
      timeout_ms: {
        type: "number",
        description:
          "Max runtime in milliseconds, default: 300000 = 5min (start)",
        required: false,
      },
      working_dir: {
        type: "string",
        description: "Working directory, must be within workspace (start)",
        required: false,
      },
      system_prompt: {
        type: "string",
        description: "Custom system prompt for the session (start)",
        required: false,
      },
      allowed_tools: {
        type: "string",
        description: "Comma-separated tool allowlist (start)",
        required: false,
      },
      max_budget_usd: {
        type: "number",
        description: "Spending cap in USD (start)",
        required: false,
      },
    },
  };
}

function buildClaudeOutputDef(): ToolDefinition {
  return {
    name: "claude_output",
    description:
      "Get the accumulated output from a Claude session (non-blocking).",
    parameters: {
      session_id: {
        type: "string",
        description: "Session ID from claude_session(action: 'start')",
        required: true,
      },
    },
  };
}

/** Tool definitions for Claude session management. */
export function buildClaudeToolDefinitions(): readonly ToolDefinition[] {
  return [
    buildClaudeSessionDef(),
    buildClaudeOutputDef(),
  ];
}

/** @deprecated Use buildClaudeToolDefinitions instead */
export const getClaudeToolDefinitions = buildClaudeToolDefinitions;

/** System prompt section for Claude session tools. */
export const CLAUDE_SESSION_SYSTEM_PROMPT = `## Claude Session Tools

You can spawn headless Claude Code CLI sessions for delegating complex tasks.
Each session runs as a separate process with its own context, tools, and workspace.

- \`claude_session\`: action = start | send | stop | status
  - start: Start a new session with a prompt. Returns a session ID.
  - send: Send a follow-up message to a running session.
  - stop: Terminate a session.
  - status: Check if a session is still running.
- \`claude_output\`: Read accumulated output from a session.

Sessions are sandboxed to the agent workspace. Use these for:
- Delegating code generation tasks
- Running research in parallel
- Multi-step debugging workflows`;
