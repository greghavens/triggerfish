/**
 * Tool executor for Claude Code CLI session management.
 *
 * Provides the chain-pattern executor that dispatches tool calls
 * to a ClaudeSessionManager. Tool definitions and system prompt
 * live in `claude_tools_defs.ts`.
 *
 * @module
 */

import type {
  ClaudeSessionConfig,
  ClaudeSessionManager,
} from "./session_types.ts";

// ─── Barrel re-exports from claude_tools_defs.ts ────────────────

export {
  buildClaudeToolDefinitions,
  CLAUDE_SESSION_SYSTEM_PROMPT,
  getClaudeToolDefinitions,
} from "./claude_tools_defs.ts";

// ─── Executor Helpers ──────────────────────────────────────────────────────────

function buildSessionConfig(
  input: Record<string, unknown>,
): Partial<ClaudeSessionConfig> {
  const config: Partial<ClaudeSessionConfig> = {};
  if (typeof input.model === "string") {
    (config as Record<string, unknown>).model = input.model;
  }
  if (typeof input.max_turns === "number") {
    (config as Record<string, unknown>).maxTurns = input.max_turns;
  }
  if (typeof input.timeout_ms === "number") {
    (config as Record<string, unknown>).timeoutMs = input.timeout_ms;
  }
  if (typeof input.working_dir === "string") {
    (config as Record<string, unknown>).workingDir = input.working_dir;
  }
  if (typeof input.system_prompt === "string") {
    (config as Record<string, unknown>).systemPrompt = input.system_prompt;
  }
  if (typeof input.allowed_tools === "string") {
    (config as Record<string, unknown>).allowedTools = input.allowed_tools
      .split(",")
      .map((t: string) => t.trim());
  }
  if (typeof input.max_budget_usd === "number") {
    (config as Record<string, unknown>).maxBudgetUsd = input.max_budget_usd;
  }
  return config;
}

async function executeActionStart(
  manager: ClaudeSessionManager,
  input: Record<string, unknown>,
): Promise<string> {
  const prompt = input.prompt;
  if (typeof prompt !== "string" || prompt.length === 0) {
    return "Error: claude_session(action: 'start') requires a 'prompt' argument (string).";
  }

  const config = buildSessionConfig(input);
  const result = await manager.start(prompt, config);
  if (!result.ok) return `Error: ${result.error}`;
  return JSON.stringify({
    session_id: result.value.id,
    pid: result.value.pid,
    status: result.value.status,
    message: "Claude session started successfully.",
  });
}

async function executeActionSend(
  manager: ClaudeSessionManager,
  input: Record<string, unknown>,
): Promise<string> {
  const sessionId = input.session_id;
  const userInput = input.input;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return "Error: claude_session(action: 'send') requires a 'session_id' argument (string).";
  }
  if (typeof userInput !== "string" || userInput.length === 0) {
    return "Error: claude_session(action: 'send') requires an 'input' argument (string).";
  }

  const result = await manager.send(sessionId, userInput);
  if (!result.ok) return `Error: ${result.error}`;
  return result.value;
}

function executeActionStatus(
  manager: ClaudeSessionManager,
  input: Record<string, unknown>,
): string {
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return "Error: claude_session(action: 'status') requires a 'session_id' argument (string).";
  }

  const result = manager.status(sessionId);
  if (!result.ok) return `Error: ${result.error}`;
  const s = result.value;
  return JSON.stringify({
    session_id: s.id,
    pid: s.pid,
    status: s.status,
    started_at: s.startedAt.toISOString(),
    ended_at: s.endedAt?.toISOString() ?? null,
    exit_code: s.exitCode,
    model: s.config.model ?? "default",
  });
}

async function executeActionStop(
  manager: ClaudeSessionManager,
  input: Record<string, unknown>,
): Promise<string> {
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return "Error: claude_session(action: 'stop') requires a 'session_id' argument (string).";
  }

  const result = await manager.stop(sessionId);
  if (!result.ok) return `Error: ${result.error}`;
  return `Session ${sessionId} stopped.`;
}

function executeClaudeOutput(
  manager: ClaudeSessionManager,
  input: Record<string, unknown>,
): string {
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return "Error: claude_output requires a 'session_id' argument (string).";
  }

  const result = manager.getOutput(sessionId);
  if (!result.ok) return `Error: ${result.error}`;
  return result.value || "(no output yet)";
}

// ─── claude_session dispatcher ──────────────────────────────────────────────

async function dispatchClaudeSession(
  manager: ClaudeSessionManager,
  input: Record<string, unknown>,
): Promise<string> {
  const action = input.action;
  if (typeof action !== "string" || action.length === 0) {
    return "Error: claude_session requires an 'action' parameter (string).";
  }

  switch (action) {
    case "start":
      return await executeActionStart(manager, input);
    case "send":
      return await executeActionSend(manager, input);
    case "stop":
      return await executeActionStop(manager, input);
    case "status":
      return executeActionStatus(manager, input);
    default:
      return `Error: unknown action "${action}" for claude_session. Valid actions: start, send, stop, status`;
  }
}

/**
 * Create a tool executor for Claude session tools.
 *
 * Returns null for unrecognized tool names (chain pattern).
 */
export function createClaudeToolExecutor(
  manager: ClaudeSessionManager,
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  // deno-lint-ignore require-await
  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    switch (name) {
      case "claude_session":
        return dispatchClaudeSession(manager, input);
      case "claude_output":
        return executeClaudeOutput(manager, input);
      default:
        return null;
    }
  };
}
