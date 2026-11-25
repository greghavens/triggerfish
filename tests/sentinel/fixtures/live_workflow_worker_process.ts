import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../../src/agent/llm.ts";
import type { HookRunner } from "../../../src/core/policy/hooks/hooks.ts";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  readAdaptiveSentinel,
  readAssignedSentinelModelReview,
} from "../../../src/gateway/sentinel_adaptive_runtime.ts";
import { createSentinelSubagent } from "../../../src/gateway/sentinel_agent.ts";
import { createSentinelLiveWorkflowReader } from "../../../src/gateway/sentinel_live_workflow.ts";
import { openSentinelAdaptiveStore } from "../../../src/sentinel/adaptive_store.ts";
import { readSentinelAssessment } from "../../../src/sentinel/assessment_store.ts";
import { readSentinelWorkerFindingHistory } from "../../../src/sentinel/worker_finding_store.ts";
import { resolveSentinelCasePath } from "../../../src/sentinel/cases.ts";

import { verifySentinelGitHubWorkflowAccess } from "../../../src/sentinel/github_workflow_runs.ts";

const [baseDir, phase] = Deno.args;
const path = resolveSentinelCasePath(baseDir);
const database = join(dirname(path), "sentinel-adaptive.db");
const metadataUrl =
  "https://api.github.com/repos/owner/pipeline/actions/workflows/17";
const allowedUrl = `${metadataUrl}/runs?per_page=10&page=1`;
const graphPhase = [
  "resume_graph",
  "interrupt_graph_mutation",
  "resume_graph_mutation",
].includes(phase);
const findingBatch = phase.endsWith("_finding_batch") ||
  phase.endsWith("_finding_partial");
const findingTool = phase.endsWith("_finding") || findingBatch
  ? "sentinel_report_finding"
  : phase.endsWith("_recheck")
  ? "sentinel_record_finding_recheck"
  : phase.endsWith("_amendment")
  ? "sentinel_update_finding_report"
  : undefined;
const assignedPhase = phase === "interrupt_assigned" ||
  phase === "resume_assigned" || graphPhase || findingTool !== undefined;
const firstBatch = phase.endsWith("_first_batch");
const mixedWrite = phase.endsWith("_workflow_batch") || firstBatch;
const mixedPhase = phase.endsWith("_mixed") || phase.endsWith("_multi");
const multiPhase = phase.endsWith("_multi");
const targetTool = "sentinel_assigned_target";
const selectedTool = assignedPhase
  ? "sentinel_assigned_target"
  : "sentinel_live_workflow_status";
const replayDenied = ["blocked", "blocked_pre", "revoked", "missing_credential"]
  .includes(phase);
function record(name: string) {
  Deno.writeTextFileSync(join(baseDir, "hook.log"), `${phase}:${name}\n`, {
    append: true,
  });
}

const hookRunner: HookRunner = {
  evaluateHook: (hook, { input, auditInput, session }) => {
    let allowed = input.url === undefined ||
      (input.url === allowedUrl || input.url === metadataUrl) &&
        input.sentinel_case_id === "main";
    const tool = input.tool_name ??
      (input.tool_call as { name?: unknown } | undefined)?.name;
    const tracked = tool === selectedTool ||
      (mixedPhase || mixedWrite) && tool === targetTool;
    if (hook === "PRE_TOOL_CALL" && tracked) {
      record(
        input.url === metadataUrl
          ? "pre_metadata"
          : input.url === allowedUrl
          ? "pre_outbound"
          : tool === targetTool && mixedPhase
          ? "pre_target"
          : "pre_tool",
      );
      if (phase === "blocked_pre") allowed = false;
    }
    if (
      hook === "POST_TOOL_RESPONSE" &&
      tracked
    ) {
      if (
        typeof input.tool_response !== "string" ||
        !input.tool_response.includes(
          tool === targetTool ? '"id":"delivery"' : '"failure"',
        ) ||
        Object.hasOwn(auditInput ?? {}, "tool_response") ||
        session.taint !== "INTERNAL"
      ) throw new Error("Invalid post-response policy input");
      if (phase === "blocked" || phase === "blocked_original") allowed = false;
      record(
        tool === targetTool && mixedPhase
          ? "post_target"
          : allowed
          ? "post_allow"
          : "post_deny",
      );
    }
    if (
      hook === "POST_TOOL_RESPONSE" &&
      tool === "sentinel_publish_workflow_observation"
    ) {
      if (
        typeof input.tool_response !== "string" ||
        !input.tool_response.includes("workflow-observation:")
      ) {
        throw new Error("The fixture did not commit its observation");
      }
      record(
        (phase === "resume_mutation" || phase === "resume_workflow_batch" ||
            phase === "resume_first_batch")
          ? "publication_reauthorized"
          : "mutation_committed",
      );
      if (
        phase === "interrupt_mutation" ||
        phase === "interrupt_workflow_batch" ||
        phase === "interrupt_first_batch"
      ) {
        Deno.writeTextFileSync(join(baseDir, "checkpoint-ready"), "ready");
        return new Promise(() => {});
      }
    }
    if (
      tool === "sentinel_publish_graph_fact" && hook === "POST_TOOL_RESPONSE" &&
      phase !== "resume_graph"
    ) {
      if (
        typeof input.tool_response !== "string" ||
        !input.tool_response.includes("worker-graph-fact:")
      ) throw new Error("Missing graph fact");
      record(
        (phase === "interrupt_graph_mutation" ||
            phase === "interrupt_finding_partial" ||
            phase === "interrupt_finding_batch")
          ? "graph_committed"
          : "graph_reauthorized",
      );
      if (
        phase === "interrupt_graph_mutation" ||
        phase === "interrupt_finding_partial"
      ) {
        Deno.writeTextFileSync(join(baseDir, "checkpoint-ready"), "ready");
        return new Promise(() => {});
      }
    }
    if (findingTool && tool === findingTool && hook === "POST_TOOL_RESPONSE") {
      if (
        typeof input.tool_response !== "string" ||
        !input.tool_response.includes('"id":"worker-')
      ) {
        throw new Error("The finding mutation did not commit");
      }
      record(
        phase.startsWith("interrupt")
          ? "finding_committed"
          : "finding_reauthorized",
      );
      if (phase.startsWith("interrupt")) {
        Deno.writeTextFileSync(join(baseDir, "checkpoint-ready"), "ready");
        return new Promise(() => {});
      }
    }
    if (hook === "PRE_OUTPUT") {
      allowed &&= input.target_classification === "INTERNAL";
      record(allowed ? "output_internal" : "output_denied");
    }
    return Promise.resolve({
      allowed,
      action: allowed ? "ALLOW" : "DENY",
      ruleId: null,
      duration: 0,
    });
  },
};
const reader = createSentinelLiveWorkflowReader({
  scopes: [{
    case: "main",
    asset: "delivery",
    owner: "owner",
    repo: "pipeline",
    workflow_id: 17,
  }],
  resolveToken: () => {
    record("resolve_credential");
    return Promise.resolve(
      phase === "missing_credential" ? undefined : "fixture-token",
    );
  },
  ssrfChecker: () => Promise.resolve({ ok: true, value: "192.0.2.1" }),
  verifyAccess: (target, options) =>
    verifySentinelGitHubWorkflowAccess(target, {
      ...options,
      request(url, init, _checker, policy) {
        if (
          url !== metadataUrl || init?.method !== "GET" ||
          new Headers(init.headers).get("authorization") !==
            "Bearer fixture-token" ||
          policy?.maxRedirects !== 0 || !policy.isUrlAllowed?.(metadataUrl) ||
          policy.isUrlAllowed?.(allowedUrl)
        ) throw new Error("Invalid workflow permission probe.");
        record("probe_metadata");
        return Promise.resolve({
          ok: true,
          value: phase === "revoked"
            ? new Response(null, { status: 403 })
            : Response.json({ id: 17 }),
        });
      },
    }),
  readRuns: () => {
    Deno.writeTextFileSync(join(baseDir, "transport.log"), "read\n", {
      append: true,
    });
    return Promise.resolve([{
      id: phase === "fresh" ? 52 : 51,
      status: "completed",
      conclusion: "failure",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:01:00Z",
    }]);
  },
});
const registry = createProviderRegistry();
registry.register({
  name: "workflow-restart-fixture",
  supportsStreaming: false,
  complete(messages) {
    record("provider");
    if (
      replayDenied || phase === "resume_graph_unproven" ||
      phase === "resume_finding_partial" ||
      phase === "resume_workflow_unapproved"
    ) {
      throw new Error("Denied receipt reached the provider");
    }
    const results = messages.filter(({ role }) => role === "tool");
    const result = results[0];
    const usage = { inputTokens: 1, outputTokens: 1 };
    if (mixedWrite) {
      if (
        phase === "interrupt_workflow_batch" ||
        phase === "interrupt_first_batch"
      ) {
        const names = !firstBatch && !results.length
          ? [targetTool]
          : [selectedTool, "sentinel_publish_workflow_observation"];
        if (results.length > (firstBatch ? 0 : 1)) {
          throw new Error("Publication did not interrupt");
        }
        return Promise.resolve({
          content: "",
          usage,
          toolCalls: names.map((name) => ({
            type: "function",
            id: name,
            function: { name, arguments: "{}" },
          })),
        });
      }
      const read = firstBatch ? 0 : 1;
      if (
        results.length !== read + 2 ||
        (!firstBatch &&
          !String(results[0].content).includes('"id":"delivery"')) ||
        !String(results[read].content).includes('"id":51') ||
        !String(results[read + 1].content).includes(
          '"id":"workflow-observation:',
        )
      ) {
        throw new Error("The mixed checkpoint lost an exact result");
      }
      return Promise.resolve({
        content:
          '{"summary":"Recovered a live read and publication from one batch.","followUps":[]}',
        toolCalls: [],
        usage,
      });
    }
    if (mixedPhase) {
      const complete = (names: string[]) =>
        Promise.resolve({
          content: "fixture-only-mixed-draft",
          usage,
          toolCalls: names.map((name) => ({
            type: "function",
            id: `fixture-only-${name}`,
            function: { name, arguments: "{}" },
          })),
        });
      if (phase.startsWith("interrupt")) {
        if (!results.length) {
          return complete(
            multiPhase ? [targetTool] : [targetTool, selectedTool],
          );
        }
        if (multiPhase && results.length === 1) return complete([selectedTool]);
        Deno.writeTextFileSync(join(baseDir, "checkpoint-ready"), "ready");
        return new Promise(() => {});
      }
      if (
        results.length !== 2 ||
        !String(results[0].content).includes('"id":"delivery"') ||
        !String(results[1].content).includes('"id":51') ||
        JSON.stringify(messages).includes("fixture-only-")
      ) throw new Error("The checkpoint lost or changed a mixed result");
      return Promise.resolve({
        content: '{"summary":"Resumed both approved reads.","followUps":[]}',
        toolCalls: [],
        usage,
      });
    }
    if (!result) {
      if (
        phase === "resume" || phase === "resume_assigned" ||
        phase === "resume_graph" || phase === "resume_graph_mutation"
      ) {
        throw new Error("Resume lost the saved tool result");
      }
      return Promise.resolve({
        content: "Synthetic checkpoint draft: fixture-only-draft",
        reasoning: "Synthetic checkpoint reasoning: fixture-only-reasoning",
        usage,
        toolCalls: [{
          type: "function",
          id: "fixture-only-provider-id",
          function: { name: selectedTool, arguments: "{}" },
        }],
      });
    }
    if (phase === "resume_unproven") {
      throw new Error("An uncertain mutation was re-claimed");
    }
    if (phase === "resume_mutation") {
      if (
        results.length !== 2 ||
        !String(results[0].content).includes('"id":51') ||
        !String(results[1].content).includes('"id":"workflow-observation:')
      ) {
        throw new Error(
          "The committed publication did not reach the resumed model",
        );
      }
      return Promise.resolve({
        content:
          '{"summary":"Resumed the committed publication.","followUps":[]}',
        toolCalls: [],
        usage,
      });
    }
    if (phase === "interrupt_mutation") {
      return Promise.resolve({
        content: "",
        usage,
        toolCalls: [{
          type: "function",
          id: "mutation-call",
          function: {
            name: "sentinel_publish_workflow_observation",
            arguments: "{}",
          },
        }],
      });
    }
    const serialized = String(result.content);
    if (
      phase === "resume" && JSON.stringify(messages).includes("fixture-only-")
    ) {
      throw new Error("Unapproved assistant fields survived worker restart");
    }
    if (findingTool) {
      if (results.length === 1 && phase.startsWith("interrupt")) {
        const original = readSentinelWorkerFindingHistory(path).find((
          { kind },
        ) => kind === "finding");
        const args = findingTool === "sentinel_report_finding"
          ? {
            graphFindingId: "review-gap",
            controlId: "check-control",
            evidenceId: "check",
            title: "Verified control gap",
          }
          : findingTool === "sentinel_record_finding_recheck"
          ? { findingId: original?.id, evidenceId: "check" }
          : {
            findingId: original?.id,
            expectedVersion: 1,
            title: "Updated report",
          };
        return Promise.resolve({
          content: "",
          usage,
          toolCalls: [
            ...(findingBatch
              ? [{
                type: "function",
                id: "batch-graph",
                function: {
                  name: "sentinel_publish_graph_fact",
                  arguments: JSON.stringify({
                    from: "check",
                    to: "delivery",
                    relation: "observed_on",
                    requestId: "cba7ef0f-5479-4f75-93c9-1f144e97eee9",
                  }),
                },
              }]
              : []),
            {
              type: "function",
              id: "finding-write",
              function: {
                name: findingTool,
                arguments: JSON.stringify({
                  ...args,
                  summary: "Verified worker report",
                  requestId: "15673bf0-5479-4f75-93c9-1f144e97eee9",
                }),
              },
            },
          ],
        });
      }
      if (
        results.length !== (findingBatch ? 3 : 2) ||
        !String(results.at(-1)?.content).includes('"id":"worker-') ||
        (findingBatch &&
          !String(results[1].content).includes("worker-graph-fact:"))
      ) {
        throw new Error("Committed finding receipt missing");
      }
      return Promise.resolve({
        content:
          '{"summary":"Resumed the committed finding write.","followUps":[]}',
        toolCalls: [],
        usage,
      });
    }
    if (graphPhase) {
      if (!serialized.includes('"relation":"observed_on"')) {
        throw new Error("The saved graph edge is missing");
      }
      if (results.length === 1) {
        if (phase === "resume_graph_mutation") {
          throw new Error("Graph publication receipt missing");
        }
        return Promise.resolve({
          content: "",
          usage,
          toolCalls: [{
            type: "function",
            id: "publish-restored-graph",
            function: {
              name: "sentinel_publish_graph_fact",
              arguments: JSON.stringify({
                from: "pipeline-record",
                to: "delivery",
                relation: "observed_on",
                requestId: "15673bf0-5479-4f75-93c9-1f144e97eee9",
              }),
            },
          }],
        });
      }
      const fact = JSON.parse(String(results[1].content));
      if (
        !fact.id?.startsWith("worker-graph-fact:") || fact.sourceStepIndex !== 0
      ) {
        throw new Error(
          "The restored evidence did not admit an exact publication",
        );
      }
      return Promise.resolve({
        content:
          '{"summary":"Published from the restored target evidence.","followUps":[]}',
        toolCalls: [],
        usage,
      });
    }
    if (assignedPhase) {
      if (!serialized.includes('"id":"delivery"')) {
        throw new Error("Missing assigned target result");
      }
      if (phase === "interrupt_assigned") {
        Deno.writeTextFileSync(join(baseDir, "checkpoint-ready"), "ready");
        return new Promise(() => {});
      }
      return Promise.resolve({
        content:
          '{"summary":"Resumed with the saved assignment target.","followUps":[]}',
        toolCalls: [],
        usage,
      });
    }
    if (phase === "blocked_original") {
      if (serialized !== "Tool response withheld by policy.") {
        throw new Error("The denied original tool output was forwarded");
      }
      return Promise.resolve({
        content:
          '{"summary":"The workflow response was withheld.","followUps":[]}',
        usage,
        toolCalls: [],
      });
    }
    if (
      !serialized.includes('"failure"') ||
      (phase === "fresh" && !serialized.includes('"id":52')) ||
      messages.filter(({ role, content }) =>
          role === "user" &&
          typeof content === "string" &&
          content.includes("Review this assigned defensive Sentinel task")
        ).length !== 1
    ) throw new Error("Resume changed the saved model conversation");
    if (phase === "interrupt") {
      Deno.writeTextFileSync(join(baseDir, "checkpoint-ready"), "ready");
      return new Promise(() => {});
    }
    return Promise.resolve({
      content:
        '{"summary":"Resumed using the exact saved failed run.","followUps":[]}',
      usage,
      toolCalls: [],
    });
  },
});
registry.setDefault("workflow-restart-fixture");

const planner = createSentinelModelPlanner(path, (state, taskId, token) => {
  if (!taskId || !token) {
    return {
      execute(_message, send) {
        send({
          type: "response",
          taint: "INTERNAL",
          text: '[{"kind":"impact","nodeId":"delivery"}]',
        });
        return Promise.resolve();
      },
      clear() {},
    };
  }
  const withStore = <T>(
    operation: (store: ReturnType<typeof openSentinelAdaptiveStore>) => T,
  ) => {
    const store = openSentinelAdaptiveStore(database);
    try {
      return operation(store);
    } finally {
      store.close();
    }
  };
  return createSentinelSubagent({
    snapshotPath: path,
    assessmentRevision: state.revision,
    assignedTaskId: taskId,
    assignedTaskLeaseToken: token,
    providerRegistry: registry,
    hookRunner,
    allowModelAccess: true,
    readLiveWorkflowStatus: (
      { task, evidenceRevision, signal, authorize, resumeOnly },
    ) =>
      reader({
        caseId: "main",
        assetId: task.nodeId!,
        evidenceRevision,
        signal,
        authorize,
        resumeOnly,
        isCurrent: () =>
          !!readAssignedSentinelModelReview(
            path,
            evidenceRevision,
            taskId,
            token,
          ),
        loadSaved: () =>
          withStore((store) =>
            store.readLeasedGitHubWorkflowResult(
              task.revision,
              task.id,
              token,
              evidenceRevision,
            )
          ),
        saveResult: (receipt) =>
          withStore((store) =>
            store.recordLeasedGitHubWorkflowResult(
              task.revision,
              task.id,
              token,
              evidenceRevision,
              receipt,
            )
          ),
      }),
  });
});
const state = readSentinelAssessment(path)!;
try {
  for (let attempts = 0; attempts < 120; attempts++) {
    advanceAdaptiveSentinel(path, state);
    planner.advance(state);
    const adaptive = readAdaptiveSentinel(path, state);
    if (
      ((phase === "resume_workflow_batch" || phase === "resume_first_batch") &&
        adaptive?.modelReviews.some(({ summary, steps }) => {
          const read = firstBatch ? 0 : 1;
          return summary ===
              "Recovered a live read and publication from one batch." &&
            steps.length === read + 2 &&
            (firstBatch || steps[0].assignedTarget?.targetId === "delivery") &&
            steps[read].githubWorkflowRead?.runs[0]?.id === 51 &&
            steps[read + 1].target?.startsWith("workflow-observation:");
        })) ||
      (phase === "resume_mutation" &&
        adaptive?.modelReviews.some(({ summary, steps }) =>
          summary === "Resumed the committed publication." &&
          steps.length === 2 &&
          steps[1].tool === "sentinel_publish_workflow_observation" &&
          steps[1].target?.startsWith("workflow-observation:")
        )) ||
      ((phase === "resume_unproven" || phase === "resume_graph_unproven" ||
        phase === "resume_finding_partial" ||
        phase === "resume_workflow_unapproved") &&
        adaptive?.modelReviewStates.some(
          (review) =>
            review.outcomeUncertain && review.status === "interrupted" &&
            !review.retryable && review.attempts === 1,
        )) ||
      (replayDenied &&
        adaptive?.modelReviewStates.some(
          ({ status }) => status === "exhausted",
        ) && !adaptive.modelReviews.length) ||
      (phase === "blocked_original" && adaptive?.modelReviews.some(
        ({ summary, steps }) =>
          summary === "The workflow response was withheld." && !steps.length,
      )) ||
      (mixedPhase && phase.startsWith("resume") &&
        adaptive?.modelReviews.some(({ summary, steps }) =>
          summary === "Resumed both approved reads." && steps.length === 2 &&
          steps[0].assignedTarget?.targetId === "delivery" &&
          steps[1].githubWorkflowRead?.runs[0]?.id === 51
        )) ||
      (findingTool && phase.startsWith("resume") &&
        adaptive?.modelReviews.some(({ summary, steps }) =>
          summary === "Resumed the committed finding write." &&
          steps.length === (findingBatch ? 3 : 2) &&
          steps.at(-1)?.tool === findingTool &&
          steps.at(-1)?.target?.startsWith("worker-")
        )) ||
      ((phase === "resume_graph" || phase === "resume_graph_mutation") &&
        adaptive?.modelReviews.some(({ summary, steps }) =>
          summary === "Published from the restored target evidence." &&
          steps.length === 2 &&
          steps[0].assignedTarget?.targetId === "delivery" &&
          steps[1].tool === "sentinel_publish_graph_fact" &&
          steps[1].outcome === "returned"
        )) ||
      (phase === "resume_assigned" &&
        adaptive?.modelReviews.some(({ summary, steps }) =>
          summary === "Resumed with the saved assignment target." &&
          steps.length === 1 && steps[0].assignedTarget?.targetId === "delivery"
        )) ||
      ((phase === "resume" || phase === "fresh") &&
        adaptive?.modelReviews.some((
          { summary, steps },
        ) =>
          summary === "Resumed using the exact saved failed run." &&
          steps.some(({ githubWorkflowRead }) =>
            githubWorkflowRead?.runs[0]?.id === (phase === "fresh" ? 52 : 51)
          )
        ))
    ) Deno.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The gateway worker fixture did not finish");
} finally {
  planner.stop();
}
