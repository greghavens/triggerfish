/**
 * Hook runner — evaluates policy rules at enforcement points.
 *
 * Creates a runner bound to a PolicyEngine that evaluates hooks
 * with timeout protection, structured logging, and default-deny
 * on failure.
 *
 * @module
 */

import type { HookType } from "../rules.ts";
import type { PolicyEngine } from "../engine.ts";
import type {
  HookContext,
  HookLogEntry,
  HookResult,
  HookRunner,
  HookRunnerOptions,
} from "./hook_types.ts";
import { buildEvaluationContext } from "./hook_violations.ts";
import { createLogger } from "../../logger/logger.ts";

const log = createLogger("policy");

/** Default timeout for hook evaluation in milliseconds. */
const DEFAULT_TIMEOUT_MS = 5000;

/** Build a structured log entry for a hook evaluation. */
function buildHookLogEntry(
  engine: PolicyEngine,
  hook: HookType,
  context: HookContext,
  result: HookResult,
): HookLogEntry {
  return {
    timestamp: new Date(),
    hook,
    sessionId: context.session.id,
    userId: context.session.userId,
    input: context.auditInput ?? context.input,
    result: context.auditInput ? { ...result, message: undefined } : result,
    rulesEvaluated: engine.getRules(hook).map((r) => r.id),
  };
}

/** Build a BLOCK result for error/timeout cases. */
function buildTimeoutBlockResult(duration: number): HookResult {
  return {
    allowed: false,
    action: "BLOCK",
    ruleId: null,
    message: "Hook evaluation timed out",
    duration,
  };
}

/**
 * Evaluate the policy engine with a timeout guard.
 *
 * If evaluation does not complete within timeoutMs, rejects with BLOCK.
 */
function evaluateWithTimeout(
  engine: PolicyEngine,
  hook: HookType,
  context: HookContext,
  timeoutMs: number,
): Promise<Omit<HookResult, "duration">> {
  return new Promise((resolve, reject) => {
    if (timeoutMs <= 0) {
      reject(new Error("Hook evaluation timed out"));
      return;
    }

    const timer = setTimeout(() => {
      reject(new Error("Hook evaluation timed out"));
    }, timeoutMs);

    try {
      const evalContext = buildEvaluationContext(context);
      const result = engine.evaluate(hook, evalContext);

      clearTimeout(timer);
      resolve({
        allowed: result.action === "ALLOW",
        action: result.action,
        ruleId: result.ruleId ?? null,
        message: result.message,
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

/**
 * Create an enforcement hook runner bound to a policy engine.
 *
 * The runner evaluates policy rules at each hook point, enforcing
 * deterministic decisions with timeout protection and optional logging.
 *
 * @param engine - The policy engine containing rules to evaluate
 * @param options - Optional logger and timeout configuration
 * @returns A HookRunner instance
 */
export function createHookRunner(
  engine: PolicyEngine,
  options?: HookRunnerOptions,
): HookRunner {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const hookLogger = options?.logger;

  return {
    async evaluateHook(hook, context) {
      const start = performance.now();

      try {
        const result = await evaluateWithTimeout(
          engine,
          hook,
          context,
          timeoutMs,
        );
        const hookResult: HookResult = {
          ...result,
          duration: performance.now() - start,
        };
        hookLogger?.log(buildHookLogEntry(engine, hook, context, hookResult));
        return hookResult;
      } catch (err: unknown) {
        const duration = performance.now() - start;
        log.warn("Hook evaluation failed, defaulting to BLOCK", {
          hook,
          sessionId: context.session.id,
          ...(!context.auditInput && {
            error: err instanceof Error ? err.message : String(err),
          }),
          durationMs: Math.round(duration),
        });
        const blockResult = buildTimeoutBlockResult(duration);
        hookLogger?.log(buildHookLogEntry(engine, hook, context, blockResult));
        return blockResult;
      }
    },
  };
}
