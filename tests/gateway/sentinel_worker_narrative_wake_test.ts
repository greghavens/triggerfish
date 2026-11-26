import { assert, assertEquals } from "@std/assert";
import { dirname } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import {
  notifyCommittedEvidence,
  subscribeCommittedEvidence,
} from "../../src/core/evidence_task_progression.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { createSentinelSubagent } from "../../src/gateway/sentinel_agent.ts";
import { startSentinelAssessmentCoordinator } from "../../src/gateway/sentinel_assessment_service.ts";
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

const usage = { inputTokens: 1, outputTokens: 1 };

function toolCall(name: string, args: Record<string, unknown>) {
  return {
    type: "function" as const,
    id: crypto.randomUUID(),
    function: { name, arguments: JSON.stringify(args) },
  };
}

async function waitFor(
  label: string,
  condition: () => boolean,
  timeout = 3_000,
) {
  const deadline = performance.now() + timeout;
  while (!condition() && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(condition(), label);
}

Deno.test("Committed worker narrative wakes a settled coordinator through cooldown and duplicate delivery", async () => {
  const baseDir = await Deno.makeTempDir();
  const caseId = "narrative-wake";
  const path = resolveSentinelCasePath(baseDir, caseId);
  const commit = "sentinel_publish_worker_narrative";
  const open = "sentinel_worker_narrative";
  const summary = "The retained application check is due for review.";
  const allowPublication = Promise.withResolvers<void>();
  const finishSource = Promise.withResolvers<void>();
  let planner: ReturnType<typeof createSentinelModelPlanner> | undefined;
  let coordinator:
    | ReturnType<typeof startSentinelAssessmentCoordinator>
    | undefined;
  let unsubscribe: (() => void) | undefined;
  let sourceTaskId: string | undefined;
  let sourceAtPublication = false;
  let created: Record<string, unknown> | undefined;
  let reopened: unknown;
  let sourceFinished = false;
  let duplicateAcknowledged = false;
  let offset = 0;
  let starts = 0;
  let coordinatorAdvances = 0;
  const wakeIds: string[] = [];
  const hooks: HookRunner = {
    evaluateHook: () =>
      Promise.resolve({
        allowed: true,
        action: "ALLOW",
        ruleId: null,
        duration: 0,
      }),
  };
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", kind: "asset", label: "Application" },
          { id: "check", kind: "evidence", label: "Local inventory check" },
        ],
        edges: [{ from: "check", to: "app", relation: "observed_on" }],
      }),
    );
    const state = startSentinelAssessment(path);
    const runId = state.plan.runId;
    assert(runId);
    unsubscribe = subscribeCommittedEvidence(caseId, (address) => {
      if (address.run_id === runId && address.revision === state.revision) {
        wakeIds.push(address.observation_id);
      }
    });
    const now = () => Date.now() + offset;
    const plannerModel = createProviderRegistry();
    plannerModel.register({
      name: "narrative-wake-planner",
      supportsStreaming: false,
      complete(messages) {
        const result = messages.findLast(({ role }) => role === "tool");
        const prompt = String(
          messages.findLast(({ role }) => role === "user")?.content,
        );
        const payload = JSON.parse(prompt.split("\n").at(-1)!);
        const narrativeId = payload.workerNarratives?.[0]?.id;
        if (!result) starts++;
        if (!narrativeId) {
          // Keep the run inside cooldown, but let it expire before the
          // assessment service's periodic poll can run.
          offset = 58_750;
          return Promise.resolve({
            usage,
            content: '[{"kind":"impact","nodeId":"app"}]',
            toolCalls: [],
          });
        }
        if (!result) {
          return Promise.resolve({
            usage,
            content: "",
            toolCalls: [toolCall(open, { id: narrativeId })],
          });
        }
        reopened = JSON.parse(String(result.content));
        return Promise.resolve({
          usage,
          content: JSON.stringify([{
            kind: "trace",
            nodeId: "app",
            depth: 1,
            workerNarrativeId: narrativeId,
          }]),
          toolCalls: [],
        });
      },
    });
    plannerModel.setDefault("narrative-wake-planner");
    const sourceModel = createProviderRegistry();
    sourceModel.register({
      name: "narrative-wake-source",
      supportsStreaming: false,
      async complete(messages) {
        const results = messages.filter(({ role }) => role === "tool");
        const publishArgs = {
          summary,
          confidence: "observed",
          evidenceId: "check",
        };
        if (!results.length) {
          return {
            usage,
            content: "",
            toolCalls: [toolCall("sentinel_assigned_target", {})],
          };
        }
        if (results.length === 1) {
          sourceAtPublication = true;
          await allowPublication.promise;
          return {
            usage,
            content: "",
            toolCalls: [toolCall(commit, publishArgs)],
          };
        }
        if (results.length === 2) {
          created = JSON.parse(String(results[1].content));
          return {
            usage,
            content: "",
            toolCalls: [toolCall(commit, publishArgs)],
          };
        }
        assertEquals(JSON.parse(String(results[2].content)), created);
        duplicateAcknowledged = true;
        await finishSource.promise;
        sourceFinished = true;
        return {
          usage,
          content: '{"summary":"Review complete.","followUps":[]}',
          toolCalls: [],
        };
      },
    });
    sourceModel.setDefault("narrative-wake-source");
    planner = createSentinelModelPlanner(
      path,
      (current, taskId, token) => {
        if (taskId) sourceTaskId ??= taskId;
        if (taskId && taskId !== sourceTaskId) {
          return { execute: () => Promise.resolve(), clear() {} };
        }
        return createSentinelSubagent({
          snapshotPath: path,
          assessmentRevision: current.revision,
          ...(taskId
            ? { assignedTaskId: taskId, assignedTaskLeaseToken: token }
            : { plannerExecutionEvidenceRunId: runId }),
          providerRegistry: taskId ? sourceModel : plannerModel,
          hookRunner: hooks,
          allowModelAccess: true,
        });
      },
      () => () => {},
      now,
    );
    coordinator = startSentinelAssessmentCoordinator({
      snapshotPath: path,
      advanceAdaptive(current) {
        coordinatorAdvances++;
        advanceAdaptiveSentinel(path, current);
        planner!.advance(current);
      },
      stopAdaptive: () => planner!.stop(),
    });
    const adaptive = () => readAdaptiveSentinel(path, state, "revision");
    await waitFor(
      "Initial planning must settle before the worker publishes",
      () =>
        sourceAtPublication &&
        adaptive()?.modelPlannerHistory[0]?.finished !== undefined,
    );
    assertEquals(starts, 1);
    const initial = adaptive()!.modelPlannerHistory[0];
    assertEquals(initial.outcome, "completed");
    const priorAdvances = coordinatorAdvances;
    allowPublication.resolve();
    await waitFor(
      "Publication must notify the assessment service",
      () => !!created && duplicateAcknowledged,
    );
    const narrativeId = created!.id as string;
    assertEquals(wakeIds.filter((id) => id === narrativeId), [narrativeId]);
    assert(coordinatorAdvances > priorAdvances);
    assertEquals(starts, 1);
    const followup = () =>
      adaptive()?.tasks.find(({ plannerRound }) =>
        plannerRound?.workerNarrativeId === narrativeId
      );
    await waitFor(
      "Cooldown retry must plan from the committed narrative",
      () => !!followup(),
    );
    assertEquals(reopened, created);
    assertEquals(sourceFinished, false);
    assertEquals(followup()?.nodeId, "app");
    assertEquals(starts, 2);
    const successes = adaptive()?.modelPlannerHistory.filter(({ reads }) =>
      reads?.some(({ target, outcome }) =>
        target === narrativeId && outcome === "returned"
      )
    );
    assertEquals(successes?.length, 1);
    const delivery = {
      case: caseId,
      run_id: runId,
      revision: state.revision,
      observation_id: narrativeId,
    };
    const beforeDuplicateDelivery = coordinatorAdvances;
    notifyCommittedEvidence(delivery);
    notifyCommittedEvidence(delivery);
    await waitFor(
      "Repeated delivery must reach the assessment subscriber",
      () => coordinatorAdvances > beforeDuplicateDelivery,
    );
    assertEquals(coordinatorAdvances, beforeDuplicateDelivery + 1);
    assertEquals(wakeIds.filter((id) => id === narrativeId).length, 3);
    assertEquals(starts, 2);
    assertEquals(
      adaptive()?.tasks.filter(({ plannerRound }) =>
        plannerRound?.workerNarrativeId === narrativeId
      ).length,
      1,
    );
  } finally {
    unsubscribe?.();
    coordinator?.stop();
    planner?.stop();
    allowPublication.resolve();
    finishSource.resolve();
    await waitFor(
      "Stopped planner must release its workers",
      () => !planner?.hasInFlightWork(),
    );
    await Deno.remove(baseDir, { recursive: true });
  }
});
