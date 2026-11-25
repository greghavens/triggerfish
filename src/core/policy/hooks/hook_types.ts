import type { ToolApprovalService } from "../../tool_approval_service.ts";

/**
 * Type definitions for enforcement hooks.
 *
 * Hooks are the enforcement layer between the LLM and external actions.
 * Every hook execution is:
 * - DETERMINISTIC: Same input → same decision, no randomness, no LLM calls
 * - SYNCHRONOUS: Completes before action proceeds; timeout = rejection
 * - LOGGED: Every execution recorded with full context
 * - UNFORGEABLE: Cannot be bypassed by LLM output
 *
 * @module
 */

import type { SessionId, SessionState, UserId } from "../../types/session.ts";
import type { HookType, PolicyAction } from "../rules.ts";

/** Context provided to a hook for evaluation. */
export interface HookContext {
  readonly session: SessionState;
  readonly input: Record<string, unknown>;
  /** Trusted log-only projection. Policy evaluation still uses input. */
  readonly auditInput?: Record<string, unknown>;
}

/** Result of a hook evaluation. */
export interface HookResult {
  readonly allowed: boolean;
  readonly action: PolicyAction;
  readonly ruleId: string | null;
  readonly message?: string;
  readonly duration: number;
}

/** Logger interface for recording hook decisions. */
export interface HookLogger {
  /** Log a hook execution entry. */
  log(entry: HookLogEntry): void;
}

/** Structured log entry for a hook execution. */
export interface HookLogEntry {
  readonly timestamp: Date;
  readonly hook: HookType;
  readonly sessionId: SessionId;
  readonly userId: UserId;
  readonly input: Record<string, unknown>;
  readonly result: HookResult;
  readonly rulesEvaluated: readonly string[];
}

/** Options for configuring a hook runner. */
export interface HookRunnerOptions {
  readonly logger?: HookLogger;
  readonly timeoutMs?: number;
}

/** Runner that evaluates hooks against the policy engine. */
export interface HookRunner {
  readonly toolApprovalInbox?: ToolApprovalService;
  /** Evaluate a hook against the policy engine. Returns a promise resolving to the decision. */
  evaluateHook(hook: HookType, context: HookContext): Promise<HookResult>;
}
