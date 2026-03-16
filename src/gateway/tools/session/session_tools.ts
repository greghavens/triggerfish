/**
 * Session tool executor orchestrator.
 *
 * Wires the three domain-specific dispatchers (session management,
 * channel messaging, Signal) into a single executor function.
 *
 * Types, tool definitions, and system prompt live in `session_tools_defs.ts`.
 * Domain handlers live in `session_executors.ts`, `channel_executors.ts`,
 * and `signal_executors.ts`.
 *
 * @module
 */

import {
  dispatchSessionTool,
  SESSION_MANAGEMENT_TOOLS,
} from "./session_executors.ts";
import {
  CHANNEL_TOOLS,
  dispatchChannelTool,
  isChannelSendInput,
} from "./channel_executors.ts";
import { dispatchSignalTool, SIGNAL_TOOLS } from "./signal_executors.ts";

import type { SessionToolContext } from "./session_tools_defs.ts";

// ─── Barrel re-exports from session_tools_defs.ts ───────────────────────────

export {
  buildSessionToolDefinitions,
  buildSignalToolDefinitions,
  getSessionToolDefinitions,
  getSignalToolDefinitions,
  SESSION_TOOLS_SYSTEM_PROMPT,
} from "./session_tools_defs.ts";
export type {
  RegisteredChannel,
  SessionToolContext,
} from "./session_tools_defs.ts";

/** All session tool names recognized by the executor. */
const ALL_SESSION_TOOLS = new Set([
  ...SESSION_MANAGEMENT_TOOLS,
  ...CHANNEL_TOOLS,
  ...SIGNAL_TOOLS,
]);

/**
 * Create a tool executor for session management tools.
 *
 * Returns null for non-session tool names (allowing chaining).
 * All taint decisions use the injected context, not LLM arguments.
 *
 * @param ctx - Session tool context with manager and caller identity
 * @returns An executor function: (name, input) => Promise<string | null>
 */
export function createSessionToolExecutor(
  ctx: SessionToolContext | undefined,
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    if (!ALL_SESSION_TOOLS.has(name)) return null;

    if (!ctx) {
      return "Session management is not available in this context.";
    }

    // For sessions_send with channel params, route to channel executor first
    if (name === "sessions_send" && isChannelSendInput(input)) {
      return dispatchChannelTool(ctx, name, input);
    }

    return (
      (await dispatchSessionTool(ctx, name, input)) ??
        (await dispatchChannelTool(ctx, name, input)) ??
        (await dispatchSignalTool(ctx, name, input))
    );
  };
}
