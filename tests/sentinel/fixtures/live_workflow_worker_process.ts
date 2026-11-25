import {
  readSentinelSharedAssetDiscoveries,
  submitSentinelAssetDiscovery,
} from "../../../src/gateway/sentinel_asset_discoveries.ts";
import { dirname, join } from "@std/path";
import { createHash } from "node:crypto";
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
const trafficListing = phase.endsWith("_traffic_listing");
const trafficSearch = phase.endsWith("_traffic_search");
const trafficBatch = phase.endsWith("_traffic_batch") || trafficSearch ||
  trafficListing ||
  phase === "resume_traffic_unavailable";
const traffic = trafficBatch
  ? JSON.parse(await Deno.readTextFile(join(baseDir, "fixture-traffic.json")))
  : undefined;
const database = join(dirname(path), "sentinel-adaptive.db");
const metadataUrl =
  "https://api.github.com/repos/owner/pipeline/actions/workflows/17";
const allowedUrl = `${metadataUrl}/runs?per_page=10&page=1`;
const graphPhase = [
  "resume_graph",
  "interrupt_graph_mutation",
  "resume_graph_mutation",
  "interrupt_graph_batch",
  "resume_graph_batch",
].includes(phase);
const findingBatch = phase.endsWith("_finding_batch") ||
  phase.endsWith("_finding_partial");
const recheckBatch = phase.endsWith("_recheck_batch");
const findingTool = phase.endsWith("_finding") || findingBatch
  ? "sentinel_report_finding"
  : phase.endsWith("_recheck") || recheckBatch
  ? "sentinel_record_finding_recheck"
  : phase.endsWith("_amendment")
  ? "sentinel_update_finding_report"
  : undefined;
const recheckDenied = phase === "resume_recheck_goal_proof_denied";
const proofPhase = phase.endsWith("_goal_proof") || recheckDenied;
const peerFact = phase.endsWith("_peer_goal_proof")
  ? JSON.parse(Deno.readTextFileSync(join(baseDir, "peer-goal-fact")))
  : undefined;
const peerTask = phase.endsWith("_task_goal_proof")
  ? JSON.parse(Deno.readTextFileSync(join(baseDir, "peer-goal-task")))
  : undefined;
const peerRecheck = phase.endsWith("_recheck_goal_proof") || recheckDenied
  ? JSON.parse(Deno.readTextFileSync(join(baseDir, "peer-goal-recheck")))
  : undefined;
const peerSearch = peerTask
  ? Deno.readTextFileSync(join(baseDir, "peer-goal-search"))
  : undefined;
const peerTrace = peerTask
  ? Deno.readTextFileSync(join(baseDir, "peer-goal-trace"))
  : undefined;
const peerWorkflow = peerTask
  ? Deno.readTextFileSync(join(baseDir, "peer-goal-workflow"))
  : undefined;
const peerWorkflowPage = peerTask
  ? Deno.readTextFileSync(join(baseDir, "peer-goal-workflow-page"))
  : undefined;
const peerEvidence = peerTask?.[0]?.task ?? peerFact?.id ?? peerRecheck?.id;
const peerTool = peerTask
  ? "sentinel_worker_observation"
  : peerRecheck
  ? "sentinel_worker_findings"
  : "sentinel_graph_facts";
const peerResponse = peerTask
  ? JSON.stringify(peerTask[0])
  : peerFact
  ? JSON.stringify({ _classification: "INTERNAL", ...peerFact })
  : peerRecheck
  ? JSON.stringify({ _classification: "INTERNAL", record: peerRecheck })
  : undefined;
const proposalPhase = phase.endsWith("_goal_proposal");
const discoveryWithdrawn = phase === "resume_discovery_withdrawn";
const discoveryPhase = phase.endsWith("_discovery") || discoveryWithdrawn;
const approvedDiscovery = discoveryPhase
  ? Deno.readTextFileSync(join(baseDir, "approved-discovery"))
  : undefined;
const approvedDiscoveryId = approvedDiscovery
  ? JSON.parse(approvedDiscovery).discovery.id
  : undefined;
const approvedDiscoveryListing = approvedDiscovery && (() => {
  const { id, claim, sourceCaseId } = JSON.parse(approvedDiscovery).discovery;
  return JSON.stringify({
    discoveries: [{ id, kind: claim.kind, sourceCaseId }],
    truncated: false,
  });
})();
const assignedPhase = proofPhase || proposalPhase || discoveryPhase ||
  phase === "interrupt_assigned" ||
  phase === "resume_assigned" || graphPhase || findingTool !== undefined;
const firstBatch = phase.endsWith("_first_batch");
const mixedWrite = phase.endsWith("_workflow_batch") || firstBatch;
const mixedPhase = phase.endsWith("_mixed") || phase.endsWith("_multi");
const multiPhase = phase.endsWith("_multi");
const priorAssigned = phase.endsWith("_prior_assigned");
const priorEvidence = priorAssigned
  ? Deno.readTextFileSync(join(baseDir, "prior-assigned-evidence"))
  : undefined;
const targetTool = "sentinel_assigned_target";
const selectedTool = assignedPhase
  ? "sentinel_assigned_target"
  : "sentinel_live_workflow_status";
const replayDenied = discoveryWithdrawn || recheckDenied ||
  ["blocked", "blocked_pre", "revoked", "missing_credential"]
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
        (phase === "interrupt_graph_batch" ||
            phase === "interrupt_graph_mutation" ||
            phase === "interrupt_finding_partial" ||
            phase === "interrupt_finding_batch")
          ? "graph_committed"
          : "graph_reauthorized",
      );
      if (
        phase === "interrupt_graph_batch" ||
        phase === "interrupt_graph_mutation" ||
        phase === "interrupt_finding_partial"
      ) {
        Deno.writeTextFileSync(join(baseDir, "checkpoint-ready"), "ready");
        return new Promise(() => {});
      }
    }
    if (
      recheckBatch && tool === "sentinel_finding_recheck_context" &&
      hook === "POST_TOOL_RESPONSE"
    ) {
      if (
        typeof input.tool_response !== "string" ||
        JSON.parse(input.tool_response).current?.outcome !== "pass"
      ) {
        throw new Error(
          "The recheck context was missing its original finding and current proof",
        );
      }
      record("recheck_context");
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
    if (
      trafficListing && hook === "POST_TOOL_RESPONSE" &&
      tool === "sentinel_finding_traffic_links"
    ) {
      const result = String(input.tool_response);
      const page = JSON.parse(result);
      if (
        page.links?.length !== 1 || page.links[0].authority?.kind !== "operator"
      ) {
        throw new Error("The saved page was replaced with the current listing");
      }
      const proofPath = join(baseDir, "traffic-listing.sha256");
      const hash = createHash("sha256").update(result).digest("hex");
      if (phase.startsWith("interrupt")) {
        Deno.writeTextFileSync(proofPath, hash);
      } else if (Deno.readTextFileSync(proofPath) !== hash) {
        throw new Error("Traffic listing changed on replay");
      }
      record("traffic_listing");
    }
    if (
      trafficSearch && hook === "POST_TOOL_RESPONSE" &&
      tool === "sentinel_traffic_search"
    ) {
      const page = JSON.parse(String(input.tool_response));
      if (
        page.receipts?.length !== 1 || !page.nextCursor ||
        page.receipts[0].observation.origin !== "https://service.example"
      ) {
        throw new Error("Missing exact paginated traffic result");
      }
      const proofPath = join(baseDir, "traffic-page.sha256");
      const hash = createHash("sha256").update(String(input.tool_response))
        .digest("hex");
      if (phase === "interrupt_traffic_search") {
        Deno.writeTextFileSync(proofPath, hash);
      } else if (Deno.readTextFileSync(proofPath) !== hash) {
        throw new Error("The saved traffic search page changed on replay");
      }
      record("traffic_search");
    }
    if (
      trafficBatch && hook === "POST_TOOL_RESPONSE" &&
      tool === "sentinel_traffic_get"
    ) {
      const { receipt } = JSON.parse(String(input.tool_response));
      if (
        receipt?.digest !== traffic.digest ||
        receipt.observation?.origin !== "https://service.example"
      ) {
        throw new Error("The exact traffic proof was missing");
      }
      record("traffic_read");
    }
    if (
      trafficBatch && hook === "POST_TOOL_RESPONSE" &&
      tool === "sentinel_attach_finding_traffic"
    ) {
      const { link } = JSON.parse(String(input.tool_response));
      if (
        link?.trafficDigest !== traffic.digest ||
        link.findingId !== traffic.findingId
      ) {
        throw new Error("The exact attachment was missing");
      }
      record("traffic_attachment");
      if (
        phase === "interrupt_traffic_batch" ||
        phase === "interrupt_traffic_search" ||
        phase === "interrupt_traffic_listing"
      ) {
        Deno.writeTextFileSync(join(baseDir, "checkpoint-ready"), "ready");
        return new Promise(() => {});
      }
    }
    if (priorAssigned && tool === "sentinel_prior_assigned_evidence") {
      if (hook === "PRE_TOOL_CALL") record("prior_pre");
      if (hook === "POST_TOOL_RESPONSE") {
        if (input.tool_response !== priorEvidence) {
          throw new Error("The exact historical evidence changed");
        }
        record("prior_post");
      }
    }
    if (approvedDiscovery && tool === "sentinel_shared_asset_discoveries") {
      if (hook === "PRE_TOOL_CALL") record("discovery_read_pre");
      if (hook === "POST_TOOL_RESPONSE") {
        if (
          input.tool_response !== approvedDiscovery &&
          input.tool_response !== approvedDiscoveryListing
        ) {
          throw new Error("The approved discovery changed");
        }
        record("discovery_read_post");
      }
    }
    if (
      discoveryPhase && hook === "POST_TOOL_RESPONSE" &&
      tool === "sentinel_submit_asset_discovery"
    ) {
      const result = JSON.parse(String(input.tool_response));
      if (
        !result.id?.startsWith("asset-discovery:") ||
        result.status !== "pending"
      ) {
        throw new Error("The historical discovery result was not pending");
      }
      record("discovery_result");
      if (phase === "interrupt_discovery") {
        Deno.writeTextFileSync(join(baseDir, "checkpoint-ready"), "ready");
        return new Promise(() => {});
      }
    }
    if (
      proposalPhase && hook === "POST_TOOL_RESPONSE" &&
      tool === "sentinel_propose_goal"
    ) {
      const { proposal } = JSON.parse(String(input.tool_response));
      if (
        session.taint !== "INTERNAL" || proposal?.goal.policy !== "operator" ||
        proposal?.goal.criteria?.[0].reference !== "pipeline-record"
      ) {
        throw new Error("The expected proposal receipt was unavailable");
      }
      record("goal_proposal_result");
      if (phase === "interrupt_goal_proposal") {
        Deno.writeTextFileSync(join(baseDir, "checkpoint-ready"), "ready");
        return new Promise(() => {});
      }
    }
    if (peerWorkflow && tool === "sentinel_intermediate_workflow_observation") {
      if (hook === "PRE_TOOL_CALL") record("intermediate_pre");
      if (hook === "POST_TOOL_RESPONSE") {
        if (
          input.tool_response !== peerWorkflow &&
          input.tool_response !== peerWorkflowPage
        ) {
          throw new Error("The published intermediate observation changed");
        }
        record("intermediate_post");
      }
    }
    if (peerTrace && tool === "sentinel_worker_trace_search") {
      if (hook === "PRE_TOOL_CALL") record("trace_pre");
      if (hook === "POST_TOOL_RESPONSE") {
        if (input.tool_response !== peerTrace) {
          throw new Error("The original trace page changed");
        }
        record("trace_post");
      }
    }
    if (peerEvidence && tool === peerTool) {
      if (hook === "PRE_TOOL_CALL") record("peer_fact_pre");
      if (hook === "POST_TOOL_RESPONSE") {
        if (
          input.tool_response !== peerResponse &&
          input.tool_response !== peerSearch &&
          (!peerTask || input.tool_response !== JSON.stringify(peerTask[1]))
        ) {
          throw new Error(
            "The exact peer receipt did not pass the root response hook",
          );
        }
        if (recheckDenied) allowed = false;
        record(recheckDenied ? "peer_fact_post_denied" : "peer_fact_post");
      }
    }
    if (
      proofPhase && hook === "POST_TOOL_RESPONSE" &&
      tool === "sentinel_prove_goal"
    ) {
      const receipt = JSON.parse(String(input.tool_response));
      if (
        receipt.status !== "open" ||
        receipt.proof?.reference !== (peerEvidence ?? "pipeline-record")
      ) {
        throw new Error(
          "The proof receipt did not preserve the original status",
        );
      }
      record("goal_proof_result");
      if (proofPhase && phase.startsWith("interrupt")) {
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
      phase === "resume_graph_batch_corrupt" ||
      phase === "resume_finding_partial" ||
      phase === "resume_workflow_unapproved" ||
      phase === "resume_traffic_unavailable"
    ) {
      throw new Error("Denied receipt reached the provider");
    }
    if (discoveryWithdrawn) {
      throw new Error("Withdrawn discovery reached the provider");
    }
    if (recheckDenied) throw new Error("Denied recheck reached the provider");
    const results = messages.filter(({ role }) => role === "tool");
    const result = results[0];
    const usage = { inputTokens: 1, outputTokens: 1 };
    if (priorAssigned) {
      if (!results.length && phase.startsWith("interrupt")) {
        return Promise.resolve({
          content: "",
          usage,
          toolCalls: [{
            type: "function",
            id: "prior-evidence",
            function: {
              name: "sentinel_prior_assigned_evidence",
              arguments: "{}",
            },
          }],
        });
      }
      if (results.length !== 1 || result.content !== priorEvidence) {
        throw new Error("Missing exact historical evidence");
      }
      if (phase.startsWith("interrupt")) {
        Deno.writeTextFileSync(join(baseDir, "checkpoint-ready"), "ready");
        return new Promise(() => {});
      }
      return Promise.resolve({
        content:
          '{"summary":"Recovered the exact historical evidence.","followUps":[]}',
        usage,
        toolCalls: [],
      });
    }
    if (trafficBatch) {
      if (phase.startsWith("interrupt_traffic_") && !results.length) {
        const revision = readSentinelAssessment(path)?.revision;
        const { evidenceId, digest, findingId } = traffic;
        return Promise.resolve({
          content: "",
          usage,
          toolCalls: [
            ...(trafficListing
              ? [{
                type: "function",
                id: "traffic-links",
                function: {
                  name: "sentinel_finding_traffic_links",
                  arguments: JSON.stringify({ revision, findingId }),
                },
              }]
              : []),

            ...(trafficSearch
              ? [{
                type: "function",
                id: "traffic-search",
                function: {
                  name: "sentinel_traffic_search",
                  arguments: JSON.stringify({
                    revision,
                    origin: "https://service.example",
                    status: 403,
                    limit: 1,
                  }),
                },
              }]
              : []),

            {
              type: "function",
              id: "traffic-read",
              function: {
                name: "sentinel_traffic_get",
                arguments: JSON.stringify({ revision, evidenceId, digest }),
              },
            },
            {
              type: "function",
              id: "traffic-attach",
              function: {
                name: "sentinel_attach_finding_traffic",
                arguments: JSON.stringify({
                  revision,
                  evidenceId,
                  digest,
                  findingId,
                  reportVersion: 1,
                  requestId: "15673bf0-5479-4f75-93c9-1f144e97eee9",
                }),
              },
            },
          ],
        });
      }
      if (
        results.length !== (trafficSearch || trafficListing ? 3 : 2) ||
        (trafficSearch && !JSON.parse(String(results[0].content)).nextCursor) ||
        !String(results.at(-2)?.content).includes(traffic.digest) ||
        !String(results.at(-1)?.content).includes("finding-traffic-link:")
      ) throw new Error("Traffic results did not survive");
      return Promise.resolve({
        content:
          '{"summary":"Recovered the traffic and attachment.","followUps":[]}',
        usage,
        toolCalls: [],
      });
    }
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
        phase === "resume_graph" || phase === "resume_graph_mutation" ||
        phase === "resume_graph_batch" || phase === "resume_discovery" ||
        phase === "resume_goal_proposal" ||
        (proofPhase && phase.startsWith("resume"))
      ) {
        throw new Error("Resume lost the saved tool result");
      }
      const targetCall = {
        type: "function",
        id: "fixture-only-provider-id",
        function: { name: selectedTool, arguments: "{}" },
      };
      const graphCall = {
        type: "function",
        id: "graph-batch-publication",
        function: {
          name: "sentinel_publish_graph_fact",
          arguments: JSON.stringify({
            from: "pipeline-record",
            to: "delivery",
            relation: "observed_on",
            requestId: "15673bf0-5479-4f75-93c9-1f144e97eee9",
          }),
        },
      };
      return Promise.resolve({
        content: "Synthetic checkpoint draft: fixture-only-draft",
        reasoning: "Synthetic checkpoint reasoning: fixture-only-reasoning",
        usage,
        toolCalls: proofPhase && phase.startsWith("interrupt")
          ? [
            ...(peerWorkflowPage
              ? [{
                type: "function",
                id: "peer-intermediate-page",
                function: {
                  name: "sentinel_intermediate_workflow_observation",
                  arguments: JSON.stringify({ offset: 0, limit: 1 }),
                },
              }]
              : []),
            ...(peerWorkflow
              ? [{
                type: "function",
                id: "peer-intermediate",
                function: {
                  name: "sentinel_intermediate_workflow_observation",
                  arguments: JSON.stringify({
                    id: JSON.parse(peerWorkflow).id,
                  }),
                },
              }]
              : []),
            ...(peerTrace
              ? [{
                type: "function",
                id: "peer-trace",
                function: {
                  name: "sentinel_worker_trace_search",
                  arguments: JSON.stringify({
                    query: "assigned_target",
                    limit: 1,
                  }),
                },
              }]
              : []),
            ...(peerSearch
              ? [{
                type: "function",
                id: "peer-search",
                function: {
                  name: peerTool,
                  arguments: JSON.stringify({
                    query: "retained peer",
                    offset: 0,
                  }),
                },
              }]
              : []),
            peerEvidence
              ? {
                type: "function",
                id: "peer-fact",
                function: {
                  name: peerTool,
                  arguments: JSON.stringify(
                    peerTask ? { task: peerEvidence } : peerRecheck
                      ? {
                        receiptId: peerEvidence,
                        revision: peerRecheck.evidenceRevision,
                      }
                      : { id: peerEvidence },
                  ),
                },
              }
              : targetCall,
            ...(peerTask
              ? [{
                type: "function",
                id: "peer-task-page-two",
                function: {
                  name: peerTool,
                  arguments: JSON.stringify({
                    task: peerEvidence,
                    offset: peerTask[1].offset,
                    revision: peerTask[1].revision,
                  }),
                },
              }]
              : []),
            {
              type: "function",
              id: "goal-proof",
              function: {
                name: "sentinel_prove_goal",
                arguments: JSON.stringify({
                  goalId: "pipeline-review",
                  criterionId: "worker-proof",
                  evidenceId: peerEvidence ?? "pipeline-record",
                  ...(peerEvidence &&
                    {
                      source: peerTask
                        ? "adaptive_task"
                        : peerRecheck
                        ? "finding_recheck"
                        : "graph_fact",
                    }),
                  requestId: "15673bf0-5479-4f75-93c9-1f144e97eee9",
                }),
              },
            },
          ]
          : phase === "interrupt_goal_proposal"
          ? [targetCall, {
            type: "function",
            id: "goal-proposal",
            function: {
              name: "sentinel_propose_goal",
              arguments: JSON.stringify({
                goalId: "pipeline-review",
                title: "  Review the delivery pipeline  ",
                criterion: "Verify the retained pipeline record",
                evidenceId: "pipeline-record",
                requestId: "15673bf0-5479-4f75-93c9-1f144e97eee9",
              }),
            },
          }]
          : phase === "interrupt_discovery"
          ? [targetCall, {
            type: "function",
            id: "discovery-list",
            function: {
              name: "sentinel_shared_asset_discoveries",
              arguments: "{}",
            },
          }, {
            type: "function",
            id: "discovery-read",
            function: {
              name: "sentinel_shared_asset_discoveries",
              arguments: JSON.stringify({ id: approvedDiscoveryId }),
            },
          }, {
            type: "function",
            id: "discovery-submit",
            function: {
              name: "sentinel_submit_asset_discovery",
              arguments: JSON.stringify({
                kind: "asset",
                evidenceId: "pipeline-record",
                requestId: "15673bf0-5479-4f75-93c9-1f144e97eee9",
              }),
            },
          }]
          : phase === "interrupt_graph_batch"
          ? [targetCall, graphCall]
          : [targetCall],
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
            ...(recheckBatch
              ? [{
                type: "function",
                id: "finding-context",
                function: {
                  name: "sentinel_finding_recheck_context",
                  arguments: JSON.stringify({ findingId: original?.id }),
                },
              }]
              : []),
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
        results.length !== (findingBatch || recheckBatch ? 3 : 2) ||
        !String(results.at(-1)?.content).includes('"id":"worker-') ||
        (recheckBatch &&
          JSON.parse(String(results[1].content)).current?.outcome !== "pass") ||
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
    if (proofPhase) {
      const receipt = JSON.parse(String(results.at(-1)?.content));
      if (
        results.length !== (peerTask ? 7 : 2) || receipt.status !== "open" ||
        (peerTask &&
          (results[0].content !== peerWorkflowPage ||
            results[1].content !== peerWorkflow ||
            results[2].content !== peerTrace ||
            results[3].content !== peerSearch ||
            results[5].content !== JSON.stringify(peerTask[1]))) ||
        receipt.criterionId !== "pipeline-review/worker-proof" ||
        (peerEvidence && results[peerTask ? 4 : 0].content !== peerResponse)
      ) {
        throw new Error("The original proof receipt was not recovered");
      }
      return Promise.resolve({
        content:
          '{"summary":"Recovered the worker goal proof.","followUps":[]}',
        toolCalls: [],
        usage,
      });
    }
    if (proposalPhase) {
      const { proposal } = JSON.parse(String(results[1]?.content));
      if (
        results.length !== 2 || !proposal?.id?.startsWith("goal-proposal:") ||
        proposal.goal.title !== "Review the delivery pipeline"
      ) throw new Error("The saved goal proposal is missing");
      return Promise.resolve({
        content:
          '{"summary":"Recovered the worker goal proposal.","followUps":[]}',
        toolCalls: [],
        usage,
      });
    }
    if (discoveryPhase) {
      const receipt = JSON.parse(String(results[3]?.content));
      if (
        results.length !== 4 ||
        results[1].content !== approvedDiscoveryListing ||
        results[2].content !== approvedDiscovery ||
        receipt.status !== "pending" ||
        receipt.claim?.evidenceId !== "pipeline-record"
      ) {
        throw new Error("The saved discovery receipt is missing");
      }
      return Promise.resolve({
        content:
          '{"summary":"Recovered the asset discovery submission.","followUps":[]}',
        toolCalls: [],
        usage,
      });
    }
    if (graphPhase) {
      if (!serialized.includes('"relation":"observed_on"')) {
        throw new Error("The saved graph edge is missing");
      }
      if (results.length === 1) {
        if (
          phase === "resume_graph_mutation" || phase === "resume_graph_batch"
        ) {
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
          text: priorAssigned ? "[]" : JSON.stringify([{
            kind: "impact",
            nodeId: traffic?.assetId ?? "delivery",
          }]),
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
    readSharedAssetDiscoveries: discoveryPhase
      ? ({ task, evidenceRevision, id, signal }) =>
        readSentinelSharedAssetDiscoveries(
          path,
          { taskId: task.id, token, evidenceRevision },
          id,
          signal,
        )
      : undefined,
    submitAssetDiscovery: discoveryPhase
      ? ({ claim, requestId, evidenceRevision, task, signal }) =>
        Promise.resolve(
          signal.aborted ? undefined : submitSentinelAssetDiscovery(
            path,
            {
              taskId: task.id,
              token,
              evidenceRevision,
            },
            claim,
            requestId,
          ),
        )
      : undefined,
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
      (phase === "resume_prior_assigned" &&
        adaptive?.modelReviews.some(({ summary, steps }) =>
          summary === "Recovered the exact historical evidence." &&
          steps.length === 1 &&
          steps[0].tool === "sentinel_prior_assigned_evidence" &&
          steps[0].target === "pipeline-record" &&
          steps[0].goalReceiptRead !== undefined
        )) ||
      (proofPhase && phase.startsWith("resume") &&
        adaptive?.modelReviews.some(({ summary, steps }) =>
          summary === "Recovered the worker goal proof." &&
          steps.length === (peerTask ? 7 : 2) &&
          steps.at(-1)?.tool === "sentinel_prove_goal" &&
          steps.at(-1)?.target === (peerEvidence ?? "pipeline-record") &&
          (!peerTask ||
            (steps[1].intermediateWorkflowObservation?.sourceTaskId ===
                JSON.parse(peerWorkflow!).taskId &&
              steps[1].intermediateWorkflowObservation?.sourceStepIndex === 2 &&
              steps[2].goalReceiptRead?.args.query === "assigned_target" &&
              steps[3].goalReceiptRead?.args.query === "retained peer" &&
              steps[5].goalReceiptRead?.args.offset === 1000)) &&
          (!peerEvidence ||
            (steps[peerTask ? 4 : 0].goalReceiptRead?.args.id ??
                steps[peerTask ? 4 : 0].goalReceiptRead?.args.task ??
                steps[peerTask ? 4 : 0].goalReceiptRead?.args.receiptId) ===
              peerEvidence)
        )) ||
      (phase === "resume_goal_proposal" &&
        adaptive?.modelReviews.some(({ summary, steps }) =>
          summary === "Recovered the worker goal proposal." &&
          steps.length === 2 &&
          steps[1].tool === "sentinel_propose_goal" &&
          steps[1].target?.startsWith("goal-proposal:")
        )) ||
      (phase === "resume_discovery" &&
        adaptive?.modelReviews.some(({ summary, steps }) =>
          summary === "Recovered the asset discovery submission." &&
          steps.length === 4 &&
          steps[0].assignedTarget?.targetId === "delivery" &&
          steps[1].tool === "sentinel_shared_asset_discoveries" &&
          steps[1].goalReceiptRead !== undefined &&
          steps[2].sharedAssetDiscovery?.id === approvedDiscoveryId &&
          steps[3].tool === "sentinel_submit_asset_discovery" &&
          steps[3].target?.startsWith("asset-discovery:")
        )) ||
      ((phase === "resume_traffic_batch" ||
        phase === "resume_traffic_search" ||
        phase === "resume_traffic_listing") &&
        adaptive?.modelReviews.some(({ summary, steps }) =>
          summary === "Recovered the traffic and attachment." &&
          steps.length === (trafficSearch || trafficListing ? 3 : 2) &&
          (!trafficListing ||
            steps[0].trafficLinks?.args.findingId === traffic.findingId) &&
          (!trafficSearch || steps[0].trafficSearch?.args?.limit === 1) &&
          steps.at(-2)?.trafficRead?.digest === traffic.digest &&
          steps.at(-1)?.target?.startsWith("finding-traffic-link:")
        )) ||
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
        phase === "resume_graph_batch_corrupt" ||
        phase === "resume_finding_partial" ||
        phase === "resume_workflow_unapproved" ||
        phase === "resume_traffic_unavailable") &&
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
          steps.length === (findingBatch || recheckBatch ? 3 : 2) &&
          (!recheckBatch ||
            steps[1].recheckContext?.findingId?.startsWith(
              "worker-finding:",
            )) &&
          steps.at(-1)?.tool === findingTool &&
          steps.at(-1)?.target?.startsWith("worker-")
        )) ||
      ((phase === "resume_graph" || phase === "resume_graph_mutation" ||
        phase === "resume_graph_batch") &&
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
