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
import { resolveSentinelCasePath } from "../../../src/sentinel/cases.ts";

const [baseDir, phase] = Deno.args;
const path = resolveSentinelCasePath(baseDir);
const database = join(dirname(path), "sentinel-adaptive.db");
const allowedUrl =
  "https://api.github.com/repos/owner/pipeline/actions/workflows/17/runs?per_page=10&page=1";
function record(name: string) {
  Deno.writeTextFileSync(join(baseDir, "hook.log"), `${phase}:${name}\n`, {
    append: true,
  });
}

const hookRunner: HookRunner = {
  evaluateHook: (hook, { input, auditInput, session }) => {
    let allowed = input.url === undefined ||
      input.url === allowedUrl && input.sentinel_case_id === "main";
    if (
      hook === "PRE_TOOL_CALL" &&
      (input.tool_name === "sentinel_live_workflow_status" ||
        (input.tool_call as { name?: unknown } | undefined)?.name ===
          "sentinel_live_workflow_status")
    ) {
      record(input.url === allowedUrl ? "pre_outbound" : "pre_tool");
      if (phase === "blocked_pre") allowed = false;
    }
    if (
      hook === "POST_TOOL_RESPONSE" &&
      input.tool_name === "sentinel_live_workflow_status"
    ) {
      if (
        typeof input.tool_response !== "string" ||
        !input.tool_response.includes('"failure"') ||
        Object.hasOwn(auditInput ?? {}, "tool_response") ||
        session.taint !== "INTERNAL"
      ) throw new Error("Invalid post-response policy input");
      if (phase === "blocked" || phase === "blocked_original") allowed = false;
      record(allowed ? "post_allow" : "post_deny");
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
    return Promise.resolve("fixture-token");
  },
  ssrfChecker: () => Promise.resolve({ ok: true, value: "192.0.2.1" }),
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
    if (phase === "blocked" || phase === "blocked_pre") {
      throw new Error("Denied receipt reached the provider");
    }
    const result = messages.find(({ role }) => role === "tool");
    const usage = { inputTokens: 1, outputTokens: 1 };
    if (!result) {
      if (phase === "resume") {
        throw new Error("Resume lost the saved tool result");
      }
      return Promise.resolve({
        content: "",
        usage,
        toolCalls: [{
          type: "function",
          id: "durable-call",
          function: { name: "sentinel_live_workflow_status", arguments: "{}" },
        }],
      });
    }
    const serialized = String(result.content);
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
      ((phase === "blocked" || phase === "blocked_pre") &&
        adaptive?.modelReviewStates.some(
          ({ status }) => status === "exhausted",
        ) && !adaptive.modelReviews.length) ||
      (phase === "blocked_original" && adaptive?.modelReviews.some(
        ({ summary, steps }) =>
          summary === "The workflow response was withheld." && !steps.length,
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
