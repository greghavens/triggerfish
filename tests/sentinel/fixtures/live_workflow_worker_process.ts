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

import { verifySentinelGitHubWorkflowAccess } from "../../../src/sentinel/github_workflow_runs.ts";

const [baseDir, phase] = Deno.args;
const path = resolveSentinelCasePath(baseDir);
const database = join(dirname(path), "sentinel-adaptive.db");
const metadataUrl =
  "https://api.github.com/repos/owner/pipeline/actions/workflows/17";
const allowedUrl = `${metadataUrl}/runs?per_page=10&page=1`;
const assignedPhase = phase === "interrupt_assigned" ||
  phase === "resume_assigned";
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
    const tracked = tool === selectedTool || mixedPhase && tool === targetTool;
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
    if (replayDenied) {
      throw new Error("Denied receipt reached the provider");
    }
    const results = messages.filter(({ role }) => role === "tool");
    const result = results[0];
    const usage = { inputTokens: 1, outputTokens: 1 };
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
      if (phase === "resume" || phase === "resume_assigned") {
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
    const serialized = String(result.content);
    if (
      phase === "resume" && JSON.stringify(messages).includes("fixture-only-")
    ) {
      throw new Error("Unapproved assistant fields survived worker restart");
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
