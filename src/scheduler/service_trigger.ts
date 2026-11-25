/**
 * Scheduler trigger execution — loads TRIGGER.md and runs it
 * in an isolated orchestrator session.
 *
 * Before each run, prior trigger results are loaded from memory via
 * `memory_search` and injected into the prompt so the agent avoids
 * repeating the same findings. After each run, the result is persisted
 * via `memory_save` for future runs.
 *
 * @module
 */

import type { ToolExecutor } from "../core/types/tool.ts";
import { createHash } from "node:crypto";
import type {
  SchedulerExecutionIdentity,
  SchedulerServiceConfig,
} from "./service_types.ts";
import { createLogger } from "../core/logger/mod.ts";
import { deliverSchedulerOutput } from "./service_output.ts";
import { logSchedulerTokenUsage } from "./service_cron.ts";
import { reportSchedulerGoalEvidence } from "./service_goal_completion.ts";
import {
  bindScheduledAgent,
  createScheduledSession,
  schedulerExecutionIdentity,
} from "./service_execution.ts";
import type {
  SchedulerTriggerAdmission,
  SchedulerTriggerAdmissions,
  SchedulerTriggerClaim,
  SchedulerTriggerOutcome,
} from "./triggers/admissions.ts";
import { isQuietHour } from "./triggers/trigger.ts";

const log = createLogger("scheduler");

/** Memory key used to persist trigger run history. */
const TRIGGER_HISTORY_MEMORY_KEY = "trigger:run-history";

/** Maximum character length for injected history (roughly ~375 tokens). */
const MAX_HISTORY_CHARS = 1500;

/** Load TRIGGER.md content, returning null if not found. */
async function loadTriggerMd(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

/** Load prior trigger results from memory via the tool executor. */
async function loadTriggerHistory(
  toolExecutor: ToolExecutor,
): Promise<string | null | undefined> {
  try {
    const raw = await toolExecutor("memory_get", {
      key: TRIGGER_HISTORY_MEMORY_KEY,
    });
    const parsed: { found?: unknown; content?: unknown } = JSON.parse(raw);
    if (parsed.found === false) return null;
    if (parsed.found !== true || typeof parsed.content !== "string") {
      return undefined;
    }
    return parsed.content.trim() ? parsed.content : null;
  } catch {
    log.debug("No prior trigger history found in memory", {
      operation: "loadTriggerHistory",
    });
    return undefined;
  }
}

/** Build a history block to inject into the trigger prompt. */
function buildHistoryContext(historyContent: string): string {
  const capped = truncateToCharBudget(historyContent, MAX_HISTORY_CHARS);
  return `## Prior Trigger Results

Do NOT repeat findings listed below. Only report NEW or CHANGED information.

${capped}

---
`;
}

/** Truncate text to a character budget, appending an ellipsis marker. */
function truncateToCharBudget(text: string, budget: number): string {
  if (text.length <= budget) return text;
  return text.slice(0, budget) + "\n… (truncated)";
}

/** Persist the latest trigger result to memory (1 entry, char-capped). */
async function persistTriggerHistory(
  toolExecutor: ToolExecutor,
  resultText: string,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const content = truncateToCharBudget(
    `### Run at ${timestamp}\n${resultText}`,
    MAX_HISTORY_CHARS,
  );
  try {
    await toolExecutor("memory_save", {
      key: TRIGGER_HISTORY_MEMORY_KEY,
      content,
      tags: ["trigger", "history"],
    });
    log.info("Trigger history persisted to memory", {
      operation: "persistTriggerHistory",
      contentLength: content.length,
    });
  } catch (err) {
    log.error("Trigger history memory_save failed", {
      operation: "persistTriggerHistory",
      err,
    });
  }
}

/** Pre-created orchestrator session bundle from the factory. */
interface TriggerSessionBundle {
  readonly orchestrator: import("../core/types/orchestrator.ts").Orchestrator;
  readonly session: import("../core/types/session.ts").SessionState;
  readonly toolExecutor: ToolExecutor;
  readonly getSessionTaint: () =>
    import("../core/types/classification.ts").ClassificationLevel;
}

/** Execute the trigger with a pre-created orchestrator session bundle. */
async function executeTriggerSessionWithOrchestrator(
  config: SchedulerServiceConfig,
  message: string,
  bundle: TriggerSessionBundle,
  execution?: SchedulerExecutionIdentity,
  finish?: (outcome: SchedulerTriggerOutcome) => boolean,
): Promise<void> {
  const { orchestrator, session, toolExecutor, getSessionTaint } = bundle;
  log.info("Trigger orchestrator processing TRIGGER.md");
  const result = await orchestrator.executeAgentTurn({
    session,
    message,
    targetClassification: config.trigger.classificationCeiling,
  });
  if (finish && !finish(result.ok ? "completed" : "execution_unavailable")) {
    return;
  }
  if (execution && !result.ok) return;
  if (config.goalCompletion) {
    await reportSchedulerGoalEvidence(config.goalCompletion, {
      kind: "trigger",
      sourceId: "trigger",
      sessionId: session.id,
      classification: getSessionTaint(),
    });
  }
  log.info(`Trigger completed (ok: ${result.ok}, taint: ${getSessionTaint()})`);
  logSchedulerTokenUsage("trigger", result);

  const resultText = result.ok ? result.value.response : result.error;
  if (resultText && resultText.trim().length > 0) {
    await persistTriggerHistory(toolExecutor, resultText);
  }

  await deliverSchedulerOutput({
    config,
    result,
    // Live taint after the turn — the session snapshot is stale (GATEWAY-1).
    sessionTaint: getSessionTaint(),
    source: "trigger",
  });
}

/**
 * Resolve trigger instructions before creating an orchestrator.
 *
 * Checks the TRIGGER.md file (cheap I/O) and the optional memory
 * lookup callback. Both are lightweight — no orchestrator needed.
 * Returns the content and source, or null if neither has instructions.
 */
async function resolveInstructionsBeforeSession(
  config: SchedulerServiceConfig,
): Promise<{ content: string; source: "memory" | "file" } | null> {
  const memoryContent = config.checkMemoryInstructions
    ? await config.checkMemoryInstructions()
    : null;
  if (memoryContent) {
    log.info("Trigger instructions loaded from memory override", {
      operation: "resolveInstructionsBeforeSession",
      contentLength: memoryContent.length,
    });
    return { content: memoryContent, source: "memory" };
  }
  const fileContent = await loadTriggerMd(config.triggerMdPath);
  if (fileContent) {
    log.info("Trigger instructions loaded from TRIGGER.md file", {
      operation: "resolveInstructionsBeforeSession",
      contentLength: fileContent.length,
    });
    return { content: fileContent, source: "file" };
  }
  return null;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function policyDigest(config: SchedulerServiceConfig): string {
  const { enabled, intervalMinutes, quietHours, classificationCeiling } =
    config.trigger;
  return hash(JSON.stringify([
    config.triggerMdPath,
    enabled,
    intervalMinutes,
    quietHours?.start,
    quietHours?.end,
    classificationCeiling,
  ]));
}

function makeAdmission(
  config: SchedulerServiceConfig,
  execution: SchedulerExecutionIdentity,
  occurrence: string,
  resolved: NonNullable<
    Awaited<ReturnType<typeof resolveInstructionsBeforeSession>>
  >,
  history: string | null,
  message: string,
): SchedulerTriggerAdmission {
  return {
    id: execution.id,
    occurrence,
    admittedAt: Date.now(),
    instructionSource: resolved.source,
    instructionsSha256: hash(resolved.content),
    historySha256: hash(JSON.stringify(history)),
    promptSha256: hash(message),
    policySha256: policyDigest(config),
    classificationCeiling: config.trigger.classificationCeiling,
  };
}

function verifyTriggerAdmission(
  expected: SchedulerTriggerAdmission,
  current: SchedulerTriggerAdmission,
): SchedulerTriggerOutcome | undefined {
  if (
    expected.policySha256 !== current.policySha256 ||
    expected.classificationCeiling !== current.classificationCeiling
  ) return "policy_changed";
  if (
    expected.instructionSource !== current.instructionSource ||
    expected.instructionsSha256 !== current.instructionsSha256
  ) return "instructions_changed";
  if (
    expected.historySha256 !== current.historySha256 ||
    expected.promptSha256 !== current.promptSha256
  ) return "input_changed";
}

async function executeTriggerOccurrence(
  config: SchedulerServiceConfig,
  execution?: SchedulerExecutionIdentity,
  occurrence?: string,
  recovery?: {
    store: SchedulerTriggerAdmissions;
    claim: SchedulerTriggerClaim;
  },
): Promise<void> {
  let claim = recovery?.claim;
  const store = recovery?.store ??
    (config.recoverTurn && execution && occurrence
      ? config.triggerAdmissions
      : undefined);
  const finish = (outcome: SchedulerTriggerOutcome) =>
    store && claim ? store.finish(claim, outcome) : true;
  let sessionCreated = false;
  try {
    if (
      claim &&
      (claim.admission.policySha256 !== policyDigest(config) ||
        claim.admission.classificationCeiling !==
          config.trigger.classificationCeiling)
    ) {
      finish("policy_changed");
      return;
    }
    const resolved = await resolveInstructionsBeforeSession(config);
    if (
      !resolved || (claim &&
        (claim.admission.instructionSource !== resolved.source ||
          claim.admission.instructionsSha256 !== hash(resolved.content)))
    ) {
      finish("instructions_changed");
      return;
    }
    const bundle = await createScheduledSession(
      config,
      "trigger",
      { isTrigger: true, ceiling: config.trigger.classificationCeiling },
      execution,
    );
    sessionCreated = true;
    const history = await loadTriggerHistory(bundle.toolExecutor);
    if (store && history === undefined) {
      finish("history_unavailable");
      return;
    }
    const message = (history ? buildHistoryContext(history) : "") +
      resolved.content;
    let resumeOnly = recovery !== undefined;
    if (store && execution && occurrence) {
      const candidate = makeAdmission(
        config,
        execution,
        occurrence,
        resolved,
        history ?? null,
        message,
      );
      if (!claim) {
        const fresh = store.admit(candidate);
        claim = store.claim(candidate.id);
        if (!claim) return;
        resumeOnly = !fresh;
      }
      const mismatch = verifyTriggerAdmission(claim.admission, candidate);
      if (mismatch) {
        finish(mismatch);
        return;
      }
    }
    const bound = execution && resumeOnly
      ? { ...execution, resumeOnly: true as const }
      : execution;
    await executeTriggerSessionWithOrchestrator(
      config,
      message,
      bindScheduledAgent(config, bundle, bound),
      bound,
      store && claim ? finish : undefined,
    );
  } catch (error) {
    if (!store && !sessionCreated) throw error;
    try {
      finish("execution_unavailable");
    } catch {
      // Leave a failed storage claim to its lease deadline.
    }
    log.error("Trigger callback failed");
  }
}

const triggerQueue = new WeakMap<SchedulerServiceConfig, Promise<void>>();
const recovering = new WeakSet<SchedulerServiceConfig>();

async function queueTrigger(
  config: SchedulerServiceConfig,
  execute: () => Promise<void>,
) {
  if (!config.triggerAdmissions || !config.recoverTurn) return await execute();
  const previous = triggerQueue.get(config)?.catch(() => {}) ??
    Promise.resolve();
  const pending = previous.then(execute);
  triggerQueue.set(config, pending);
  try {
    await pending;
  } finally {
    if (triggerQueue.get(config) === pending) triggerQueue.delete(config);
  }
}

export function invokeTriggerCallback(
  config: SchedulerServiceConfig,
  execution?: SchedulerExecutionIdentity,
  occurrence?: string,
): Promise<void> {
  return queueTrigger(
    config,
    () => executeTriggerOccurrence(config, execution, occurrence),
  );
}

/** Resume admitted text prompts only, with no image attachments or webhook replays. */
export async function recoverTriggerAdmissions(
  config: SchedulerServiceConfig,
): Promise<void> {
  const store = config.triggerAdmissions;
  if (!store || !config.recoverTurn || recovering.has(config)) return;
  recovering.add(config);
  try {
    await queueTrigger(config, async () => {
      for (const { id, occurrence } of store.available()) {
        const execution = schedulerExecutionIdentity(
          "trigger",
          "trigger",
          occurrence,
        );
        const periodic = occurrence.startsWith("periodic:");
        const quiet = periodic && config.trigger.enabled &&
          config.trigger.quietHours;
        if (quiet && isQuietHour(quiet)) continue;
        const claim = store.claim(id);
        if (!claim) continue;
        if (execution.id !== id || (periodic && !config.trigger.enabled)) {
          store.finish(claim, "policy_changed");
          continue;
        }
        await executeTriggerOccurrence(config, execution, occurrence, {
          store,
          claim,
        });
      }
    });
  } catch {
    log.warn("Scheduled trigger admissions could not be recovered");
  } finally {
    recovering.delete(config);
  }
}
