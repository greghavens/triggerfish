import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createTidepoolSentinelHandler } from "../../src/gateway/startup/services/tidepool_sentinel.ts";
import type { BootstrapResult } from "../../src/gateway/startup/bootstrap.ts";
import {
  executionEvidenceDigest,
  repositoryVisibilityEvidenceId,
  sentinelExecutionEvidenceFile,
  workflowControlEvidenceId,
} from "../../src/sentinel/case_execution_evidence.ts";
import { sentinelAlertsPath } from "../../src/sentinel/paths.ts";
import { syncSentinelTopology } from "../../src/gateway/sentinel_topology_sync.ts";
import { createHash } from "node:crypto";
import {
  inspectSentinelProvenance,
  readSentinelGraphProjection,
  searchSentinelProvenance,
  searchSentinelWorkerTraces,
} from "../../src/gateway/sentinel_agent.ts";
import { verifyWorkerFindingRecheck } from "../../src/sentinel/worker_finding_evidence.ts";
import {
  addSentinelCaseHint,
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
  readHistoricalAdaptiveSentinel,
  readSentinelProvenance,
  readSentinelWorkerObservation,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  openSentinelAdaptiveStore,
  sentinelAdaptiveTaskId,
} from "../../src/sentinel/adaptive_store.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
  sentinelIncidentCandidates,
} from "../../src/sentinel/adaptive_planner.ts";
import { sentinelWorkerObservationPage } from "../../src/gateway/sentinel_goal_receipt_read.ts";
import { digestSentinelGoalProposal } from "../../src/sentinel/formal_goals.ts";
import {
  ensureSentinelFormalGoalContract,
  readSentinelGoalCompletionForState,
  reportSentinelGoalCompletion,
} from "../../src/gateway/sentinel_goal_completion.ts";
import { openSentinelAssetDiscoveryStore } from "../../src/sentinel/asset_discovery_store.ts";
import {
  readSentinelTrafficReceiptPage,
  recordSentinelTrafficReceipt,
} from "../../src/sentinel/traffic_receipts.ts";
import {
  listSentinelFindingTrafficLinks,
  openSentinelFindingTrafficLinks,
} from "../../src/sentinel/finding_traffic_links.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import {
  applySentinelFormalGoals,
  readSentinelWorkerGoalProposalReceipt,
  readSentinelWorkerGoalProposals,
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { digestSentinelSnapshot } from "../../src/sentinel/shared_inventory.ts";
import {
  listSentinelPlannerGraphFacts,
  openSentinelWorkerGraphFacts,
} from "../../src/sentinel/worker_graph_facts.ts";
import {
  openSentinelWorkerFindingStore,
  readSentinelWorkerFindingWriteReceipt,
} from "../../src/sentinel/worker_finding_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

async function verifyHistoricalWorkerReads(
  dir: string,
  path: string,
  assessment: ReturnType<typeof startSentinelAssessment>,
  summary: string,
  indices: readonly number[],
) {
  const review = readAdaptiveSentinel(path, assessment)?.modelReviews
    .find(
      ({ summary: value }) => value === summary,
    );
  assert(review);
  let selected = 0;
  let denied = false;
  let response = "";
  const registry = createProviderRegistry();
  registry.register({
    name: "historical-telemetry-fixture",
    supportsStreaming: false,
    complete(messages) {
      const last = messages.at(-1);
      const done = last?.role === "tool";
      if (done) response = String(last.content);
      return Promise.resolve({
        content: done ? "Review finished." : "",
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: done ? [] : [{
          type: "function",
          id: crypto.randomUUID(),
          function: {
            name: "operator_runs",
            arguments: JSON.stringify({
              action: "worker_trace_result",
              kind: "sentinel",
              id: "main",
              revision: assessment.revision,
              taskId: review.taskId,
              stepIndices: [selected],
            }),
          },
        }],
      });
    },
  });
  registry.setDefault("historical-telemetry-fixture");
  const chat = createChatSession({
    session: createSession({
      userId: "owner" as UserId,
      channelId: "historical-telemetry" as ChannelId,
      bumpersEnabled: false,
    }),
    providerRegistry: registry,
    operatorRunExecutor: createOperatorRunToolExecutor({
      baseDir: dir,
      confirm: () => Promise.resolve(false),
    }),
    hookRunner: {
      evaluateHook(hook, { input }) {
        const allowed = !(denied && hook === "POST_TOOL_RESPONSE" &&
          input.tool_name === review.steps[selected].tool);
        return Promise.resolve({
          allowed,
          action: allowed ? "ALLOW" : "BLOCK",
          duration: 0,
          ruleId: null,
        });
      },
    },
  });
  for (const index of indices) {
    selected = index;
    await chat.executeAgentTurn(
      "Read the exact saved evidence page.",
      () => {},
    );
    const result = JSON.stringify(JSON.parse(response).result);
    assertEquals(
      createHash("sha256").update(result).digest("hex"),
      review.steps[index].goalReceiptRead?.sha256 ??
        review.steps[index].resultSha256,
    );
  }
  denied = true;
  await chat.executeAgentTurn(
    "Read the saved evidence again.",
    () => {},
  );
  assert(response.includes("unavailable"));
}

for (
  const scenario of [
    "resume",
    "resume_control_renewal",
    "resume_assigned",
    "resume_execution_evidence",
    "resume_native_execution_evidence",
    "resume_native_execution_evidence_denied",
    "resume_execution_evidence_page",
    "resume_execution_evidence_followup",
    "resume_repository_visibility_followup",
    "resume_actions_control_followup",
    "resume_execution_evidence_finding",
    "resume_execution_evidence_finding_denied",
    "resume_execution_evidence_denied",
    "resume_defense_summary",
    "resume_prior_assigned",
    "resume_saved_workflow",
    "resume_pinned_sources",
    "resume_shared_asset_links",
    "resume_graph",
    "resume_graph_mutation",
    "resume_graph_batch",
    "resume_discovery",
    "resume_discovery_withdrawn",
    "resume_goal_proposal",
    "resume_goal_proof",
    "resume_peer_goal_proof",
    "resume_task_goal_proof",
    "resume_recheck_goal_proof",
    "resume_recheck_goal_proof_denied",
    "resume_graph_batch_corrupt",
    "resume_graph_unproven",
    "resume_finding",
    "resume_finding_batch",
    "resume_finding_partial",
    "resume_recheck",
    "resume_recheck_batch",
    "resume_traffic_batch",
    "resume_traffic_search",
    "resume_traffic_listing",
    "resume_traffic_unavailable",
    "resume_amendment",
    "resume_mixed",
    "resume_multi",
    "resume_mutation",
    "resume_workflow_batch",
    "resume_first_batch",
    "resume_workflow_unapproved",
    "resume_unproven",
    "fresh",
    "blocked_pre",
    "revoked",
    "missing_credential",
    "blocked",
    "blocked_original",
  ] as const
) {
  const visibilityFollowup =
    scenario === "resume_repository_visibility_followup";
  const actionsFollowup = scenario === "resume_actions_control_followup";
  const typedFollowup = visibilityFollowup || actionsFollowup;
  const nativeExecution = scenario.startsWith(
    "resume_native_execution_evidence",
  );
  const phase = typedFollowup
    ? "resume_execution_evidence_followup"
    : scenario === "resume_native_execution_evidence"
    ? "resume_execution_evidence"
    : scenario === "resume_native_execution_evidence_denied"
    ? "resume_execution_evidence_denied"
    : scenario;
  Deno.test({
    name: nativeExecution
      ? phase.endsWith("_denied")
        ? "Sentinel withholds a native remediation receipt when workflow access is revoked during restart"
        : "Sentinel resumes a native remediation receipt without listing workflow runs again"
      : actionsFollowup
      ? "Sentinel recovers a committed Actions recheck after worker process death"
      : visibilityFollowup
      ? "Sentinel recovers a committed repository visibility recheck after worker process death"
      : phase === "resume_execution_evidence_followup"
      ? "Sentinel recovers an exact receipt-scoped finding read and its committed recheck"
      : phase === "resume_execution_evidence_page"
      ? "Sentinel resumes the exact execution finding page after a newer finding is committed"
      : phase === "resume_execution_evidence_finding_denied"
      ? "Sentinel withholds an interrupted receipt-backed finding when source access is revoked"
      : phase === "resume_execution_evidence_finding"
      ? "Sentinel recovers an interrupted finding from an exact execution receipt"
      : phase === "resume_execution_evidence"
      ? "Sentinel resumes an approved execution receipt after worker process death"
      : phase === "resume_execution_evidence_denied"
      ? "Sentinel blocks a retained execution receipt after source policy is revoked during restart"
      : phase === "resume_workflow_unapproved"
      ? "Sentinel keeps a mixed batch held without proof the read passed response policy"
      : phase === "resume_first_batch"
      ? "Sentinel recovers a first tool batch before any tool checkpoint exists"
      : phase === "resume_workflow_batch"
      ? "Sentinel recovers a live status read and publication in the same batch"
      : phase === "resume_finding_batch"
      ? "Sentinel reconciles every receipt in a committed mixed mutation batch"
      : phase === "resume_finding_partial"
      ? "Sentinel holds a partially committed mutation batch without retrying it"
      : phase === "resume_traffic_unavailable"
      ? "Sentinel holds an interrupted attachment when its exact retained traffic is missing"
      : phase === "resume_traffic_listing"
      ? "Sentinel recovers the original finding-traffic listing alongside its attachment"
      : phase === "resume_traffic_search"
      ? "Sentinel recovers a paginated traffic search with its read and attachment"
      : phase === "resume_traffic_batch"
      ? "Sentinel recovers a sanitized traffic read and finding attachment after restart"
      : phase === "resume_recheck_batch"
      ? "Sentinel resumes a finding context read and recheck committed in the same batch"
      : phase === "resume_finding" || phase === "resume_recheck" ||
          phase === "resume_amendment"
      ? `Sentinel recovers a committed ${phase.slice(7)} write after restart`
      : phase === "resume_graph_unproven"
      ? "A graph journal receipt with a different admitted request stays held"
      : phase === "resume_recheck_goal_proof_denied"
      ? "Sentinel withholds a saved remediation recheck when response policy changes after restart"
      : phase === "resume_recheck_goal_proof"
      ? "Sentinel restores the original worker finding page and committed remediation proof"
      : phase === "resume_task_goal_proof"
      ? "Sentinel restores the original intermediate workflow page alongside peer evidence and a committed proof"
      : phase === "resume_peer_goal_proof"
      ? "Sentinel restores a paginated peer graph fact read and its committed goal proof"
      : phase === "resume_goal_proof"
      ? "Sentinel restores original goal and case hint pages after newer updates"
      : phase === "resume_goal_proposal"
      ? "Sentinel reconciles a worker goal proposal without submitting it again"
      : phase === "resume_defense_summary"
      ? "Sentinel restores defense summaries and paginated incident alerts after restart"
      : phase === "resume_saved_workflow"
      ? "Sentinel resumes the exact saved workflow receipt from its prerequisite"
      : phase === "resume_shared_asset_links"
      ? "Sentinel restores original shared asset links and in-turn finding authority"
      : phase === "resume_pinned_sources"
      ? "Sentinel restores original pinned topology and finding sources after a gateway restart"
      : phase === "resume_prior_assigned"
      ? "Sentinel restores the exact historical evidence cited by a carried assignment"
      : phase === "resume_discovery_withdrawn"
      ? "Sentinel withholds an approved discovery withdrawn before recovery"
      : phase === "resume_discovery"
      ? "Sentinel recovers both discovery pages and the original submission receipt"
      : phase === "resume_graph_batch"
      ? "Sentinel recovers a first batch that reads and publishes an assigned relationship"
      : phase === "resume_graph_batch_corrupt"
      ? "Sentinel holds an interrupted graph batch when the retained read digest changes"
      : phase === "resume_graph_mutation"
      ? "Sentinel reconciles an interrupted graph publication from the request-bound journal receipt"
      : phase === "resume_graph"
      ? "Sentinel publishes an exact relationship from reauthorized assigned evidence after restart"
      : phase === "resume_mutation"
      ? "Sentinel reconciles a committed publication without dispatching it again"
      : phase === "resume_unproven"
      ? "An unproven publication remains held without dispatching it again"
      : phase === "resume_mixed"
      ? "Sentinel resumes both reads from one mixed tool batch"
      : phase === "resume_multi"
      ? "Sentinel resumes both reads across multiple model iterations"
      : phase === "resume_assigned"
      ? "A Sentinel worker resumes its committed assigned target after process restart"
      : phase === "resume_control_renewal"
      ? "Gateway restart after a control renewal reads a fresh live workflow result"
      : phase === "fresh"
      ? "A new evidence revision starts a fresh workflow conversation after interruption"
      : phase === "blocked"
      ? "A stricter post-tool policy blocks a saved workflow receipt after process restart"
      : phase === "blocked_pre"
      ? "Root pre-call denial blocks saved workflow replay before the source is checked"
      : phase === "revoked" || phase === "missing_credential"
      ? `Saved workflow replay is blocked after restart with ${phase} access`
      : phase === "blocked_original"
      ? "Post-tool policy withholds a live workflow result from the model and review trace"
      : "An interrupted gateway worker resumes the saved workflow conversation without repeating transport",
    ignore: Deno.build.os === "windows",
    async fn() {
      const controlRenewal = phase === "resume_control_renewal";
      const peerProof = phase === "resume_peer_goal_proof";
      const taskProof = phase === "resume_task_goal_proof";
      const discoveryWithdrawn = phase === "resume_discovery_withdrawn";
      const discovery = phase === "resume_discovery" || discoveryWithdrawn;
      const priorAssigned = phase === "resume_prior_assigned";
      const sharedAssetLinks = phase === "resume_shared_asset_links";
      const pinnedSources = phase === "resume_pinned_sources" ||
        sharedAssetLinks;
      const savedWorkflow = phase === "resume_saved_workflow";
      const defenseSummary = phase === "resume_defense_summary";
      const executionEvidence = phase.startsWith("resume_execution_evidence");
      const executionFinding = phase.startsWith(
        "resume_execution_evidence_finding",
      );
      const executionFollowup = phase === "resume_execution_evidence_followup";
      const executionDiscovery = phase === "resume_execution_evidence_page" ||
        executionFollowup;
      const executionDenied = executionEvidence && phase.endsWith("_denied");
      const graphPhase = executionEvidence || defenseSummary || savedWorkflow ||
        pinnedSources ||
        priorAssigned ||
        taskProof ||
        peerProof ||
        discovery ||
        phase === "resume_goal_proposal" || phase === "resume_goal_proof" ||
        phase === "resume_graph" ||
        phase === "resume_graph_mutation" ||
        phase === "resume_graph_unproven" ||
        phase === "resume_graph_batch" ||
        phase === "resume_graph_batch_corrupt";
      const trafficPhase = phase === "resume_traffic_batch" ||
        phase === "resume_traffic_search" ||
        phase === "resume_traffic_listing" ||
        phase === "resume_traffic_unavailable";
      const historicalTrafficId = `har:evidence:${"e".repeat(64)}`;
      const trafficId = `har:evidence:${"a".repeat(64)}`;
      const assetId = trafficPhase ? `har:asset:${"b".repeat(64)}` : "delivery";
      const recheckDenied = phase === "resume_recheck_goal_proof_denied";
      const recheckProof = phase === "resume_recheck_goal_proof" ||
        recheckDenied;
      const findingPhase = recheckProof || [
        "resume_finding",
        "resume_finding_batch",
        "resume_finding_partial",
        "resume_recheck",
        "resume_recheck_batch",
        "resume_amendment",
        "resume_traffic_batch",
        "resume_traffic_search",
        "resume_traffic_listing",
        "resume_traffic_unavailable",
      ].includes(phase);
      const dir = await Deno.makeTempDir();
      const path = resolveSentinelCasePath(dir);
      let child: Deno.ChildProcess | undefined;
      let followupTaskId: string | undefined;
      try {
        await Deno.mkdir(dirname(path), { recursive: true });
        const now = Date.now();
        const observedAt = new Date(now - 60_000).toISOString();
        const validUntil = new Date(now + 3_600_000).toISOString();
        const controlChecks = ["control-original", "control-renewed"].map((
          id,
          index,
        ) => ({
          id,
          kind: "evidence",
          label: id,
          controlVerification: {
            outcome: "pass" as const,
            observedAt: new Date(now + (index ? 30_000 : -30_000))
              .toISOString(),
            validUntil: new Date(now + (index ? 120_000 : 45_000))
              .toISOString(),
          },
        }));
        let receiptNode = `execution-evidence:${"e".repeat(64)}`;
        const branchPayload = {
          kind: "github_branch_protection" as const,
          repo: "owner/repo",
          repositoryId: 42,
          protectedCount: executionFinding ? 0 : 1,
          unprotectedCount: executionFinding ? 1 : 0,
          ...((executionFinding || executionDiscovery) &&
            {
              approvedBranches: [{
                name: "main",
                protected: !executionFinding,
              }],
            }),
        };
        const visibilityPayload = {
          kind: "github_repository_status" as const,
          repo: branchPayload.repo,
          repositoryId: branchPayload.repositoryId,
          visibility: "private" as const,
        };
        const actionsPayload = {
          kind: "github_actions_status" as const,
          repo: branchPayload.repo,
          repositoryId: branchPayload.repositoryId,
          workflow: "22",
          runs: [{
            id: 2,
            status: "completed",
            conclusion: "success",
            created_at: new Date(now - 90_000).toISOString(),
          }],
        };
        const payload = actionsFollowup
          ? actionsPayload
          : visibilityFollowup
          ? visibilityPayload
          : branchPayload;
        const executionSource = {
          role: "delegated" as const,
          runId: "fixture-delegated",
          ordinal: 1,
          receiptId: `execution-trace:${"a".repeat(64)}`,
          resultSha256: executionEvidenceDigest(payload),
        };
        if (executionEvidence && !nativeExecution) {
          await Deno.writeTextFile(
            join(dirname(path), sentinelExecutionEvidenceFile),
            JSON.stringify([{
              ...executionSource,
              classification: "INTERNAL",
              recordedAt: observedAt,
              payload,
            }]),
            { mode: 0o600 },
          );
        }
        const snapshot = {
          version: 1,
          nodes: [
            ...(controlRenewal
              ? [
                ...controlChecks,
                { id: "control", kind: "control", label: "Control" },
                {
                  id: "control-finding",
                  kind: "finding",
                  label: "Control finding",
                  severity: "low",
                },
              ]
              : []),
            {
              id: assetId,
              kind: "asset",
              label: "Delivery pipeline",
              ...(discovery &&
                { aliases: ["delivery.example.invalid"] }),
            },
            ...(trafficPhase
              ? [{
                id: trafficId,
                kind: "evidence",
                label: "Sanitized traffic",
              }]
              : []),
            ...(executionEvidence
              ? [{
                id: receiptNode,
                kind: "evidence",
                label: "Approved branch protection",
                executionSource,
                controlVerification: {
                  outcome: executionFinding ? "fail" : "pass",
                  observedAt,
                  validUntil,
                },
              }]
              : graphPhase
              ? [{
                id: "pipeline-record",
                kind: "evidence",
                label: "Retained pipeline record",
              }]
              : []),
            ...(nativeExecution || executionFinding || executionDiscovery
              ? [
                {
                  id: "receipt-gap",
                  kind: "finding",
                  label: "Branch gap",
                  severity: "low",
                },
                {
                  id: "receipt-control",
                  kind: "control",
                  label: "Branch protection",
                },
              ]
              : []),
            ...(findingPhase
              ? [
                {
                  id: "review-gap",
                  kind: "finding",
                  label: "Control gap",
                  severity: "high",
                },
                {
                  id: "check-control",
                  kind: "control",
                  label: "Control under review",
                },
                {
                  id: "check",
                  kind: "evidence",
                  label: "Retained verification",
                  controlVerification: {
                    outcome: phase === "resume_recheck" ||
                        phase === "resume_recheck_batch" || recheckProof
                      ? "pass"
                      : "fail",
                    observedAt,
                    validUntil,
                  },
                },
              ]
              : []),
          ],
          edges: graphPhase
            ? [
              {
                from: executionEvidence ? receiptNode : "pipeline-record",
                to: assetId,
                relation: "observed_on",
              },
              ...(nativeExecution || executionFinding || executionDiscovery
                ? [
                  { from: "receipt-gap", to: assetId, relation: "affects" },
                  {
                    from: "receipt-control",
                    to: "receipt-gap",
                    relation: "mitigates",
                  },
                  {
                    from: receiptNode,
                    to: "receipt-control",
                    relation: "verifies",
                  },
                ]
                : []),
            ]
            : findingPhase
            ? [
              { from: "review-gap", to: assetId, relation: "affects" },
              {
                from: "check-control",
                to: "review-gap",
                relation: "mitigates",
              },
              { from: "check", to: "check-control", relation: "verifies" },
              { from: "check", to: assetId, relation: "observed_on" },
            ]
            : [],
        };
        if (controlRenewal) {
          snapshot.edges.push(
            { from: "control", to: "control-finding", relation: "mitigates" },
            { from: "control-finding", to: assetId, relation: "affects" },
            ...controlChecks.flatMap(({ id }) => [
              { from: id, to: assetId, relation: "observed_on" },
              { from: id, to: "control", relation: "verifies" },
            ]),
          );
        }
        if (trafficPhase) {
          snapshot.edges.push({
            from: trafficId,
            to: assetId,
            relation: "observed_on",
          });
          recordSentinelTrafficReceipt(
            path,
            "har",
            loadSentinelGraph(snapshot).snapshot(),
            {
              assetId,
              evidenceId: trafficId,
              origin: "https://service.example",
              method: "GET",
              status: 403,
              startedAt: observedAt,
            },
          );
        }
        if (
          phase === "resume_traffic_search" ||
          phase === "resume_traffic_listing"
        ) {
          const evidenceId = historicalTrafficId;
          snapshot.nodes.push({
            id: evidenceId,
            kind: "evidence",
            label: "Another sanitized record",
          });
          snapshot.edges.push({
            from: evidenceId,
            to: assetId,
            relation: "observed_on",
          });
          recordSentinelTrafficReceipt(
            path,
            "har",
            loadSentinelGraph(snapshot).snapshot(),
            {
              assetId,
              evidenceId,
              origin: "https://service.example",
              method: "GET",
              status: 403,
              startedAt: observedAt,
            },
          );
        }
        await Deno.writeTextFile(path, JSON.stringify(snapshot));
        const reporter = resolveSentinelCasePath(dir, "reporter");
        const dependency = {
          id: "dependency",
          kind: "asset",
          label: "Retained dependency",
        };
        let findingSourceDigest: string | undefined;
        if (pinnedSources) {
          await Deno.writeTextFile(
            path,
            JSON.stringify({
              ...snapshot,
              nodes: [
                ...snapshot.nodes.map((node) =>
                  node.id === "pipeline-record"
                    ? {
                      ...node,
                      controlVerification: {
                        outcome: "pass",
                        observedAt,
                        validUntil,
                      },
                    }
                    : node
                ),
                dependency,
                {
                  id: "local-finding",
                  kind: "finding",
                  label: "Pinned local finding",
                  severity: "high",
                },
                {
                  id: "local-control",
                  kind: "control",
                  label: "Pinned mitigation",
                },
              ],
              edges: [
                ...snapshot.edges,
                { from: "local-finding", to: assetId, relation: "affects" },
                {
                  from: "local-control",
                  to: "local-finding",
                  relation: "mitigates",
                },
                {
                  from: "pipeline-record",
                  to: "local-control",
                  relation: "verifies",
                },
              ],
            }),
          );
          const remoteDependency = sharedAssetLinks
            ? { ...dependency, id: "remote-dependency" }
            : dependency;
          const reportedAssetId = sharedAssetLinks
            ? "remote-delivery"
            : assetId;
          const remote = {
            version: 1,
            nodes: [
              { id: reportedAssetId, kind: "asset", label: "Reporting asset" },
              remoteDependency,
              {
                id: "remote-finding",
                kind: "finding",
                label: "Retained control gap",
                severity: "low",
              },
            ],
            edges: [
              {
                from: reportedAssetId,
                to: remoteDependency.id,
                relation: "depends_on",
              },
              {
                from: "remote-finding",
                to: reportedAssetId,
                relation: "affects",
              },
            ],
          };
          await Deno.mkdir(dirname(reporter), { recursive: true });
          await Deno.writeTextFile(reporter, JSON.stringify(remote));
          if (sharedAssetLinks) {
            for (let index = 0; index < 33; index++) {
              const id = `other-publication-${index}`;
              const other = resolveSentinelCasePath(dir, id);
              await Deno.mkdir(dirname(other), { recursive: true });
              await Deno.writeTextFile(
                other,
                JSON.stringify({
                  version: 1,
                  nodes: [{ id, label: id, kind: "asset" }],
                  edges: [],
                }),
              );
            }
            const bridge = resolveSentinelCasePath(dir, "alias-bridge");
            await Deno.mkdir(dirname(bridge), { recursive: true });
            await Deno.writeTextFile(
              bridge,
              JSON.stringify({
                version: 1,
                nodes: [
                  { ...dependency, aliases: [remoteDependency.id] },
                  {
                    id: assetId,
                    kind: "asset",
                    label: "Alias of the reporting asset",
                    aliases: [reportedAssetId],
                  },
                ],
                edges: [],
              }),
            );
          }
          await syncSentinelTopology(dir, "main", path);
          findingSourceDigest = digestSentinelSnapshot(
            loadSentinelGraph(remote).snapshot(),
          );
        }
        if (defenseSummary) {
          await Deno.writeTextFile(
            sentinelAlertsPath(path),
            JSON.stringify([
              {
                type: "authentication_success_after_failures",
                severity: "high",
                asset: assetId,
                subject: "fixture-account",
                observedAt,
                evidenceIds: ["pinned-auth-evidence"],
              },
              ...[0, 1].map((index) => ({
                type: "integrity_change",
                severity: "high",
                asset: assetId,
                subject: "fixture-account",
                observedAt,
                evidenceIds: [`pinned-cloudtrail-${index}`],
                triggeringAction: "cloudtrail.amazonaws.com:StopLogging",
              })),
            ]),
          );
        }
        let assessment = startSentinelAssessment(path);
        let priorEvidenceId = "pre-import-check";
        const priorObservedAt = new Date(now - 120_000).toISOString();
        if (nativeExecution) {
          advanceAdaptiveSentinel(path, assessment);
          const revision = adaptiveRevision(assessment);
          const store = openSentinelAdaptiveStore(
            join(dirname(path), "sentinel-adaptive.db"),
          );
          try {
            store.sync(revision, [{
              kind: "trace",
              nodeId: assetId,
              depth: 1,
              reason: MODEL_ASSIGNMENT_REASON,
            }], revision);
            advanceAdaptiveSentinel(path, assessment);
            const source = store.claimModelReview(
              revision,
              MODEL_ASSIGNMENT_REASON,
              (task) => task.kind === "trace" && task.nodeId === assetId,
            );
            assert(source);
            const runs = [{
              id: 51,
              status: "completed",
              conclusion: "success",
              repositoryId: 42,
              createdAt: new Date(now - 90_000).toISOString(),
            }];
            const resultSha256 = createHash("sha256").update(
              JSON.stringify(runs),
            ).digest("hex");
            assert(
              store.recordModelReviewProgress(
                revision,
                source.task.id,
                source.token,
                [{
                  tool: "sentinel_live_workflow_status",
                  target: assetId,
                  outcome: "returned",
                  githubWorkflowRead: {
                    repository: "owner/pipeline",
                    workflowId: 17,
                    evidenceRevision: assessment.revision,
                    observedAt,
                    connectorId: "github-actions",
                    resultSha256,
                    runs,
                  },
                }],
              ),
            );
            const oldNode = receiptNode;
            receiptNode = "native-workflow-evidence:" + resultSha256;
            const rebound = JSON.parse(
              JSON.stringify(snapshot).replaceAll(oldNode, receiptNode),
            );
            const node = rebound.nodes.find(({ id }: { id: string }) =>
              id === receiptNode
            );
            delete node.executionSource;
            node.nativeWorkflowSource = {
              runId: assessment.plan.runId,
              revision: assessment.revision,
              taskId: source.task.id,
              stepIndex: 0,
              workflowRunNumber: 51,
              resultSha256,
            };
            await Deno.writeTextFile(path, JSON.stringify(rebound));
            await Deno.writeTextFile(
              join(dir, "native-execution-evidence-node"),
              receiptNode,
            );
            assessment = refreshSentinelAssessment(path)!;
          } finally {
            store.close();
          }
        }

        if (typedFollowup) {
          const runId = assessment.plan.runId!;
          const earlierPayload = actionsFollowup
            ? {
              ...actionsPayload,
              runs: [{
                ...actionsPayload.runs[0],
                id: 1,
                conclusion: "failure",
                created_at: new Date(now - 180_000).toISOString(),
              }],
            }
            : { ...visibilityPayload, visibility: "public" as const };
          const earlierSource = {
            ...executionSource,
            ordinal: 2,
            receiptId: `execution-trace:${"b".repeat(64)}`,
            resultSha256: executionEvidenceDigest(earlierPayload),
          };
          const evidenceId = (source: typeof executionSource) =>
            actionsFollowup
              ? workflowControlEvidenceId(
                runId,
                assetId,
                "receipt-control",
                source,
                actionsPayload.repositoryId,
                actionsPayload.workflow,
                validUntil,
              )
              : repositoryVisibilityEvidenceId(
                runId,
                assetId,
                "receipt-control",
                source,
                visibilityPayload.repositoryId,
                validUntil,
              );
          priorEvidenceId = evidenceId(earlierSource);
          const placeholder = receiptNode;
          receiptNode = evidenceId(executionSource);
          const rebound = JSON.parse(
            JSON.stringify(snapshot).replaceAll(placeholder, receiptNode),
          );
          rebound.nodes.push({
            id: priorEvidenceId,
            kind: "evidence",
            label: actionsFollowup
              ? "Earlier failed workflow receipt"
              : "Earlier public repository receipt",
            executionSource: earlierSource,
            controlVerification: {
              outcome: "fail",
              observedAt: priorObservedAt,
              validUntil,
            },
          });
          rebound.edges.push(
            { from: priorEvidenceId, to: assetId, relation: "observed_on" },
            {
              from: priorEvidenceId,
              to: "receipt-control",
              relation: "verifies",
            },
          );
          await Deno.writeTextFile(path, JSON.stringify(rebound));
          await Deno.writeTextFile(
            join(dirname(path), sentinelExecutionEvidenceFile),
            JSON.stringify([
              {
                ...executionSource,
                classification: "INTERNAL",
                recordedAt: observedAt,
                payload,
              },
              {
                ...earlierSource,
                classification: "INTERNAL",
                recordedAt: priorObservedAt,
                payload: earlierPayload,
              },
            ]),
            { mode: 0o600 },
          );
          await Deno.writeTextFile(
            join(dir, "followup-evidence-node"),
            receiptNode,
          );
          assessment = refreshSentinelAssessment(path)!;
        }

        if (
          nativeExecution || executionFinding ||
          (executionDiscovery && !executionFollowup)
        ) {
          const revision = adaptiveRevision(assessment);
          const store = openSentinelAdaptiveStore(
            join(dirname(path), "sentinel-adaptive.db"),
          );
          try {
            store.sync(revision, [{
              kind: "review_evidence",
              nodeId: receiptNode,
              reason: MODEL_ASSIGNMENT_REASON,
            }], nativeExecution ? store.activeRevision() : null);
          } finally {
            store.close();
          }
        }
        if (executionDiscovery) {
          const journal = openSentinelWorkerFindingStore(path);
          try {
            const original = journal.recordFinding({
              caseId: "main",
              runId: assessment.plan.runId!,
              evidenceRevision: assessment.revision,
              taskId: "previous-asset-review",
              targetId: assetId,
              graphFindingId: "receipt-gap",
              controlId: "receipt-control",
              evidenceId: priorEvidenceId,
              snapshotDigest: "b".repeat(64),
              observedAt: priorObservedAt,
              evaluatedAt: observedAt,
              validUntil,
              requestId: "prior-discovery-finding",
              title: "Prior control gap",
              summary: "Originally visible in the discovery page.",
            });
            assert(original);
            if (executionFollowup) {
              await Deno.writeTextFile(
                join(dir, "followup-finding"),
                JSON.stringify(original),
              );
            }
          } finally {
            journal.close();
          }
        }
        if (controlRenewal) {
          await Deno.writeTextFile(
            join(dir, "renewal-clock"),
            String(now + 60_000),
          );
          const revision = adaptiveRevision(assessment);
          advanceAdaptiveSentinel(path, assessment);
          const store = openSentinelAdaptiveStore(
            join(dirname(path), "sentinel-adaptive.db"),
          );
          const journal = openSentinelWorkerGraphFacts(path);
          try {
            const source = {
              kind: "trace" as const,
              nodeId: assetId,
              depth: 7,
            };
            const gate = {
              kind: "trace" as const,
              nodeId: assetId,
              depth: 1,
              plannerRound: {
                identity: revision,
                attempt: 1,
                graphFactOnly: true as const,
                graphRelationship: {
                  to: "control",
                  relation: "verifies" as const,
                  requireCurrentPass: true as const,
                },
              },
            };
            store.sync(revision, [source, gate, {
              kind: "impact",
              nodeId: assetId,
              depth: 7,
              reason: MODEL_ASSIGNMENT_REASON,
              prerequisites: [sentinelAdaptiveTaskId(revision, gate)],
            }], revision);
            advanceAdaptiveSentinel(path, assessment);
            const sourceId = sentinelAdaptiveTaskId(revision, source);
            assertEquals(
              store.list(revision).find(({ id }) => id === sourceId)?.status,
              "completed",
            );
            const graph = assessment.result?.sharedGraph.snapshot;
            assert(graph && assessment.plan.runId);
            for (const check of controlChecks) {
              assert(journal.record({
                caseId: "main",
                runId: assessment.plan.runId,
                evidenceRevision: assessment.revision,
                targetId: assetId,
                taskId: sourceId,
                snapshotDigest: digestSentinelSnapshot(graph),
                resultSha256: "a".repeat(64),
                relationship: {
                  from: check.id,
                  to: "control",
                  relation: "verifies",
                },
                controlVerification: check.controlVerification,
                sourceStepIndex: 0,
                requestId: crypto.randomUUID(),
              }, () => true));
            }
          } finally {
            journal.close();
            store.close();
          }
          advanceAdaptiveSentinel(path, assessment);
        }

        if (defenseSummary) {
          const incident = sentinelIncidentCandidates(assessment).find((
            { alertCount },
          ) => typeof alertCount === "number" && alertCount >= 2);
          assert(typeof incident?.id === "string");
          await Deno.writeTextFile(
            join(dir, "defense-incident-id"),
            incident.id,
          );
        }

        if (pinnedSources) {
          const evidence = assessment.result?.sharedGraph.snapshot?.nodes.find((
            node,
          ) => node.kind === "evidence" && node.relationshipSources?.length);
          assert(evidence);
          assert(findingSourceDigest);
          const revision = adaptiveRevision(assessment);
          advanceAdaptiveSentinel(path, assessment);
          const store = openSentinelAdaptiveStore(
            join(dirname(path), "sentinel-adaptive.db"),
          );
          try {
            store.sync(revision, [{
              kind: "trace",
              depth: 7,
              nodeId: assetId,
              reason: MODEL_ASSIGNMENT_REASON,
              ...(!sharedAssetLinks && {
                plannerRound: {
                  identity: revision,
                  attempt: 1,
                  peerFindingCitations: [{
                    localAssetId: assetId,
                    sourceCaseId: "reporter",
                    sourceAssetId: assetId,
                    sourceFindingId: "remote-finding",
                    snapshotDigest: findingSourceDigest,
                  }],
                },
              }),
            }], revision);
          } finally {
            store.close();
          }
          advanceAdaptiveSentinel(path, assessment);
          await Deno.writeTextFile(
            join(dir, "pinned-source-args"),
            JSON.stringify([
              { evidenceId: evidence.id, sourceCase: "reporter" },
              {
                asset: assetId,
                sourceCase: "reporter",
                sourceAsset: sharedAssetLinks ? "remote-delivery" : assetId,
                finding: "remote-finding",
                snapshotDigest: findingSourceDigest,
              },
              { node: "evidence:pipeline-record", limit: 1 },
              { kind: "observation", origin: "adaptive", limit: 1 },
              {
                graph: "provenance",
                from: "evidence:pipeline-record",
                to: "asset:delivery",
                direction: "outgoing",
                relation: "observed_on",
              },
              {
                graph: "provenance",
                from: "evidence:pipeline-record",
                to: "asset:delivery",
                relation: "references",
                limit: 2,
              },
              {
                from: "pipeline-record",
                to: "delivery",
                direction: "outgoing",
                relation: "observed_on",
              },
              {
                graph: "inventory",
                from: "pipeline-record",
                to: "delivery",
                limit: 2,
              },
              { node: "delivery", depth: 1 },
              { node: "dependency", depth: 1 },
              { offset: 0, limit: 1 },
              { offset: 0, limit: 1 },
            ]),
          );
        }
        if (discovery) {
          const sourceCaseId = "discovery-origin";
          const sourcePath = resolveSentinelCasePath(dir, sourceCaseId);
          await Deno.mkdir(dirname(sourcePath), { recursive: true });
          await Deno.writeTextFile(sourcePath, JSON.stringify(snapshot));
          const source = startSentinelAssessment(sourcePath);
          const graph = source.result?.sharedGraph.snapshot;
          assert(graph);
          const store = openSentinelAssetDiscoveryStore(dir);
          try {
            const proposal = store.propose({
              sourceCaseId,
              taskId: "adaptive:" + "a".repeat(64),
              evidenceRevision: source.revision,
              sourceDigest: digestSentinelSnapshot(graph),
              claim: { kind: "asset", assetId, evidenceId: "pipeline-record" },
            });
            const approved = store.approve(proposal.id, proposal.version);
            assertEquals(approved?.status, "approved");
            if (!discoveryWithdrawn) {
              const entries = [approved];
              for (let index = 1; index <= 5; index++) {
                const extra = store.propose({
                  ...approved!,
                  taskId: "adaptive:" + String(index).repeat(64),
                });
                entries.push(store.approve(extra.id, extra.version));
              }
              const rows = entries.map((entry) => {
                assert(entry);
                return {
                  id: entry.id,
                  kind: entry.claim.kind,
                  sourceCaseId: entry.sourceCaseId,
                };
              });
              await Deno.writeTextFile(
                join(dir, "discovery-pages"),
                JSON.stringify({
                  first: JSON.stringify({
                    discoveries: rows.slice(0, 5),
                    truncated: true,
                    nextAfter: rows[4].id,
                  }),
                  second: JSON.stringify({
                    discoveries: rows.slice(5),
                    truncated: false,
                  }),
                  after: rows[4].id,
                }),
              );
            }
            await Deno.writeTextFile(
              join(dir, "approved-discovery"),
              JSON.stringify({
                discovery: { ...approved, mappedAssetId: assetId },
              }),
            );
          } finally {
            store.close();
          }
        }

        if (savedWorkflow) {
          const revision = adaptiveRevision(assessment);
          advanceAdaptiveSentinel(path, assessment);
          const store = openSentinelAdaptiveStore(
            join(dirname(path), "sentinel-adaptive.db"),
          );
          try {
            store.sync(revision, [{
              kind: "impact",
              nodeId: assetId,
              reason: MODEL_ASSIGNMENT_REASON,
            }], revision);
            advanceAdaptiveSentinel(path, assessment);
            const source = store.claimModelReview(
              revision,
              MODEL_ASSIGNMENT_REASON,
            );
            assert(source);
            const runs = [{
              id: 51,
              status: "completed",
              conclusion: "failure",
            }];
            const receipt = {
              repository: "owner/pipeline",
              workflowId: 17,
              connectorId: "github",
              observedAt,
              evidenceRevision: assessment.revision,
              resultSha256: createHash("sha256").update(JSON.stringify(runs))
                .digest("hex"),
              runs,
            };
            assert(
              store.finishModelReview(revision, source.task.id, source.token, {
                note: "Committed prerequisite workflow review.",
                steps: [{
                  tool: "sentinel_live_workflow_status",
                  target: assetId,
                  outcome: "returned",
                  githubWorkflowRead: receipt,
                }],
              }),
            );
            store.sync(revision, [{
              kind: "trace",
              nodeId: assetId,
              reason: MODEL_ASSIGNMENT_REASON,
              prerequisites: [source.task.id],
              reviewedFrom: source.task.id,
              plannerRound: {
                identity: revision,
                attempt: 1,
                sourceKind: "model_review",
                githubWorkflowCitation: {
                  sourceTaskId: source.task.id,
                  resultSha256: receipt.resultSha256,
                },
              },
            }], revision);
            await Deno.writeTextFile(
              join(dir, "saved-workflow-evidence"),
              JSON.stringify({
                targetId: assetId,
                sourceTaskId: source.task.id,
                stepIndex: 0,
                receipt,
              }),
            );
          } finally {
            store.close();
          }
          advanceAdaptiveSentinel(path, assessment);
        }
        if (priorAssigned) {
          const earlier = assessment;
          advanceAdaptiveSentinel(path, earlier);
          const revision = adaptiveRevision(earlier);
          const store = openSentinelAdaptiveStore(
            join(dirname(path), "sentinel-adaptive.db"),
          );
          let sourceTaskId: string;
          try {
            store.sync(revision, [{
              kind: "impact",
              nodeId: assetId,
              reason: MODEL_ASSIGNMENT_REASON,
            }], revision);
            advanceAdaptiveSentinel(path, earlier);
            const source = store.claimModelReview(
              revision,
              MODEL_ASSIGNMENT_REASON,
            );
            assert(source);
            sourceTaskId = source.task.id;
            assert(
              store.finishModelReview(revision, sourceTaskId, source.token, {
                note: "Private earlier review narrative.",
                steps: [{
                  tool: "sentinel_assigned_target",
                  target: assetId,
                  outcome: "returned",
                  assignedTarget: {
                    targetId: assetId,
                    linkedNodeIds: ["pipeline-record"],
                  },
                }],
              }),
            );
            store.sync(revision, [{
              kind: "review_evidence",
              nodeId: "pipeline-record",
              reason: MODEL_ASSIGNMENT_REASON,
              prerequisites: [sourceTaskId],
              plannerRound: {
                identity: revision,
                attempt: 1,
                workerSources: [{ taskId: sourceTaskId, kind: "model_review" }],
              },
            }], revision);
          } finally {
            store.close();
          }
          await Deno.writeTextFile(
            path,
            JSON.stringify({
              ...snapshot,
              nodes: [...snapshot.nodes, {
                id: "additional-asset",
                kind: "asset",
                label: "New asset",
              }],
            }),
          );
          assessment = refreshSentinelAssessment(path)!;
          assert(assessment.revision > earlier.revision);
          advanceAdaptiveSentinel(path, assessment);
          const task = readAdaptiveSentinel(path, assessment)?.tasks.find((
            { nodeId },
          ) => nodeId === "pipeline-record");
          assert(task);
          const citation = {
            sourceTaskId,
            evidenceRevision: earlier.revision,
            targetId: "pipeline-record",
            stepIndex: 0,
          };
          assertEquals(task.plannerRound?.priorAssignedTargetCitations, [
            citation,
          ]);
          await Deno.writeTextFile(
            join(dir, "prior-assigned-evidence"),
            JSON.stringify({
              revision: assessment.revision,
              taskId: task.id,
              citations: [{
                ...citation,
                sourceTargetId: assetId,
                evidence: {
                  id: "pipeline-record",
                  kind: "evidence",
                  label: "Retained pipeline record",
                },
                relationships: [{
                  from: "pipeline-record",
                  to: assetId,
                  relation: "observed_on",
                }],
              }],
              unavailableCount: 0,
              truncated: false,
            }),
          );
        }

        const publishWorkflow = (depth: number) => {
          const revision = adaptiveRevision(assessment);
          const publisher = {
            kind: "trace" as const,
            nodeId: assetId,
            depth,
            reason: "fixture intermediate publisher",
          };
          const producer = openSentinelAdaptiveStore(
            join(dirname(path), "sentinel-adaptive.db"),
          );
          try {
            const publishedTaskId = sentinelAdaptiveTaskId(
              revision,
              publisher,
            );
            producer.sync(
              revision,
              [publisher],
              revision,
            );
            const lease = producer.claim(
              revision,
              60,
              new Set(
                producer.list(revision).filter((task) =>
                  task.id !== publishedTaskId
                ).map((task) => task.id),
              ),
            );
            assert(lease);
            producer.complete({
              taskId: publishedTaskId,
              leaseToken: lease.leaseToken,
              observation: { summary: "Workflow assignment" },
            });
            const review = producer.claimModelReview(
              revision,
              publisher.reason,
            );
            assert(review);
            const runs = [{
              id: 51,
              status: "completed",
              conclusion: "failure",
            }];
            assert(
              producer.recordLeasedGitHubWorkflowResult(
                revision,
                publishedTaskId,
                review.token,
                assessment.revision,
                {
                  repository: "owner/pipeline",
                  workflowId: 17,
                  connectorId: "github",
                  observedAt,
                  evidenceRevision: assessment.revision,
                  resultSha256: createHash("sha256").update(
                    JSON.stringify(runs),
                  ).digest("hex"),
                  runs,
                },
              ),
            );
            const committed = producer.commitLeasedWorkflowObservation(
              revision,
              publishedTaskId,
              review.token,
              assessment.revision,
              2,
            );
            assert(committed);
            return committed;
          } finally {
            producer.close();
          }
        };
        let peerFactId: string | undefined;
        if (phase === "resume_goal_proof" || peerProof || taskProof) {
          const goals = [{
            id: "pipeline-review",
            title: "Review delivery",
            policy: "operator" as const,
            criteria: ["worker-proof", "operator-proof"].map((id) => ({
              id,
              description: "Verify the retained pipeline record",
              source: peerProof && id === "worker-proof"
                ? "graph_fact" as const
                : taskProof && id === "worker-proof"
                ? "adaptive_task" as const
                : "graph_evidence" as const,
              reference: peerProof && id === "worker-proof"
                ? JSON.stringify(["pipeline-record", "observed_on", assetId])
                : taskProof && id === "worker-proof"
                ? `task:trace:1:${assetId}`
                : "pipeline-record",
            })),
          }];
          assessment = applySentinelFormalGoals(path, {
            mode: "append",
            requestId: crypto.randomUUID(),
            expectedRunId: assessment.plan.runId,
            expectedRevision: assessment.revision,
            proposalDigest: digestSentinelGoalProposal(goals),
            goals,
          }).state;
          assert(ensureSentinelFormalGoalContract(path, assessment));
          if (phase === "resume_goal_proof") {
            addSentinelCaseHint(path, "Review the oldest retained hint.");
            addSentinelCaseHint(path, "Review the original latest hint.");
          }

          if (taskProof) {
            advanceAdaptiveSentinel(path, assessment);
            const revision = adaptiveRevision(assessment);
            const request = {
              kind: "trace" as const,
              nodeId: assetId,
              depth: 1,
            };
            const store = openSentinelAdaptiveStore(
              join(dirname(path), "sentinel-adaptive.db"),
            );
            const completedTaskId = sentinelAdaptiveTaskId(revision, request);
            peerFactId = completedTaskId;
            try {
              store.sync(revision, [{
                ...request,
                reason: "fixture peer review",
              }], revision);
              const lease = store.claim(
                revision,
                60,
                new Set(
                  store.list(revision).filter(({ id }) => id !== peerFactId)
                    .map(({ id }) => id),
                ),
              );
              assertEquals(lease?.task.id, peerFactId);
              assert(lease);
              store.complete({
                taskId: peerFactId,
                leaseToken: lease.leaseToken,
                observation: {
                  summary: "A retained peer result.",
                  records: "a".repeat(980) + "Evidence on page two.",
                },
              });
              const review = store.claimModelReview(
                revision,
                "fixture peer review",
                (task) => task.id === completedTaskId,
              );
              assert(review);
              assert(
                store.finishModelReview(
                  revision,
                  completedTaskId,
                  review.token,
                  {
                    note: "A completed peer review.",
                    steps: [{
                      tool: "sentinel_assigned_target",
                      target: "delivery",
                      outcome: "returned",
                    }],
                  },
                ),
              );
            } finally {
              store.close();
            }
            const workflow = publishWorkflow(3);
            await Deno.writeTextFile(
              join(dir, "peer-goal-workflow"),
              JSON.stringify(workflow),
            );
            await Deno.writeTextFile(
              join(dir, "peer-goal-workflow-page"),
              JSON.stringify({
                evidenceRevision: assessment.revision,
                targetId: assetId,
                observations: [{
                  id: workflow.id,
                  sourceTaskId: workflow.taskId,
                  observedAt: workflow.receipt.observedAt,
                }],
                nextOffset: null,
              }),
            );
            const saved = readSentinelWorkerObservation(
              path,
              assessment.revision,
              { task: peerFactId },
            );
            assert(typeof saved === "string");
            const search = readSentinelWorkerObservation(
              path,
              assessment.revision,
              {
                query: "retained peer",
                offset: 0,
              },
            );
            assert(typeof search === "object");
            assertEquals(search.observations.map(({ id }) => id), [
              completedTaskId,
            ]);
            await Deno.writeTextFile(
              join(dir, "peer-goal-search"),
              JSON.stringify({
                revision: assessment.revision,
                offset: 0,
                ...search,
              }),
            );
            const tracePage = searchSentinelWorkerTraces({
              snapshotPath: path,
              assessmentRevision: assessment.revision,
            }, { query: "assigned_target", limit: 1 });
            assertEquals(
              JSON.parse(tracePage).steps.map((
                { taskId }: { taskId: string },
              ) => taskId),
              [completedTaskId],
            );
            await Deno.writeTextFile(join(dir, "peer-goal-trace"), tracePage);
            await Deno.writeTextFile(
              join(dir, "peer-goal-task"),
              JSON.stringify(
                [0, 1000].map((offset) =>
                  sentinelWorkerObservationPage(
                    completedTaskId,
                    assessment.revision,
                    offset,
                    saved,
                  )
                ),
              ),
            );
          }
          if (peerProof) {
            assert(assessment.plan.runId);
            const graph = assessment.result?.sharedGraph.snapshot;
            assert(graph);
            const journal = openSentinelWorkerGraphFacts(path);
            try {
              const fact = journal.record({
                caseId: "main",
                runId: assessment.plan.runId,
                evidenceRevision: assessment.revision,
                targetId: assetId,
                taskId: "adaptive:" + "a".repeat(64),
                snapshotDigest: digestSentinelSnapshot(graph),
                resultSha256: "b".repeat(64),
                sourceStepIndex: 0,
                requestId: crypto.randomUUID(),
                relationship: {
                  from: "pipeline-record",
                  to: assetId,
                  relation: "observed_on",
                },
              }, () => true);
              assert(fact);
              peerFactId = fact.id;
              assert(journal.record({
                ...fact,
                taskId: "adaptive:" + "c".repeat(64),
                requestId: crypto.randomUUID(),
              }, () => true));

              await Deno.writeTextFile(
                join(dir, "peer-goal-fact"),
                JSON.stringify(fact),
              );
            } finally {
              journal.close();
            }
          }
        }
        if (
          phase === "resume_recheck" || phase === "resume_recheck_batch" ||
          phase === "resume_amendment" || trafficPhase || recheckProof
        ) {
          assert(assessment.plan.runId);
          const journal = openSentinelWorkerFindingStore(path);
          try {
            const finding = journal.recordFinding({
              caseId: "main",
              runId: assessment.plan.runId,
              evidenceRevision: assessment.revision,
              taskId: "original-task",
              targetId: assetId,
              graphFindingId: "review-gap",
              controlId: "check-control",
              evidenceId: "old-check",
              snapshotDigest: "a".repeat(64),
              observedAt: new Date(now - 120_000).toISOString(),
              evaluatedAt: observedAt,
              validUntil,
              requestId: "original-request",
              title: "Prior control gap",
              summary: "Original failure",
            });
            if (recheckProof) {
              const goals = [{
                id: "pipeline-review",
                title: "Review remediation",
                policy: "operator" as const,
                criteria: [{
                  id: "worker-proof",
                  description:
                    "Verify that the original control gap was remediated.",
                  source: "finding_recheck" as const,
                  reference: `pass:${finding.id}`,
                }, {
                  id: "operator-proof",
                  description: "Review the verification evidence.",
                  source: "graph_evidence" as const,
                  reference: "check",
                }],
              }];
              assessment = applySentinelFormalGoals(path, {
                mode: "append",
                requestId: crypto.randomUUID(),
                expectedRunId: assessment.plan.runId,
                expectedRevision: assessment.revision,
                proposalDigest: digestSentinelGoalProposal(goals),
                goals,
              }).state;
              assert(ensureSentinelFormalGoalContract(path, assessment));
              const outcome = verifyWorkerFindingRecheck(
                assessment.result?.sharedGraph.snapshot,
                {
                  caseId: "main",
                  evidenceRevision: assessment.revision,
                  evaluatedAt: assessment.result?.controlEvaluationAt ??
                    assessment.updatedAt,
                },
                {
                  findingId: "review-gap",
                  assetId,
                  controlId: "check-control",
                  evidenceId: "check",
                },
              );
              assert(outcome?.outcome === "pass");
              const result = journal.recordRecheck({
                ...outcome,
                findingId: finding.id,
                graphFindingId: "review-gap",
                controlId: "check-control",
                evidenceId: "check",
                caseId: "main",
                runId: finding.runId,
                evidenceRevision: assessment.revision,
                taskId: "earlier-recheck-assignment",
                targetId: assetId,
                requestId: crypto.randomUUID(),
                summary: "Retained evidence shows that the control passed.",
              });
              await Deno.writeTextFile(
                join(dir, "peer-original-finding"),
                JSON.stringify(finding),
              );
              peerFactId = result.id;
              await Deno.writeTextFile(
                join(dir, "peer-goal-recheck"),
                JSON.stringify(result),
              );
            }
            if (trafficPhase) {
              const traffic = readSentinelTrafficReceiptPage(
                path,
                assessment.revision,
                {
                  assetId,
                  evidenceId: trafficId,
                },
              )?.receipts[0];
              assert(traffic);
              if (phase === "resume_traffic_listing") {
                const historical = readSentinelTrafficReceiptPage(
                  path,
                  assessment.revision,
                  {
                    assetId,
                    evidenceId: historicalTrafficId,
                  },
                )?.receipts[0];
                assert(historical);
                const links = openSentinelFindingTrafficLinks(path);
                try {
                  assert(links.record({
                    caseId: "main",
                    assetId,
                    evidenceRevision: assessment.revision,
                    findingId: finding.id,
                    reportVersion: 1,
                    trafficId: historical.evidenceId,
                    trafficSource: historical.family,
                    trafficDigest: historical.digest,
                    authority: { kind: "operator" },
                    requestId: "4bcb28fe-744b-474e-91b0-96457230407a",
                  }, () => true));
                } finally {
                  links.close();
                }
              }

              await Deno.writeTextFile(
                join(dir, "fixture-traffic.json"),
                JSON.stringify({
                  assetId,
                  evidenceId: trafficId,
                  digest: traffic.digest,
                  findingId: finding.id,
                }),
              );
            }
          } finally {
            journal.close();
          }
        }
        const fixture = fromFileUrl(
          new URL(
            "./fixtures/live_workflow_worker_process.ts",
            import.meta.url,
          ),
        );
        const spawn = (phase: string) =>
          new Deno.Command(Deno.execPath(), {
            args: ["run", "-A", fixture, dir, phase],
            stdout: "null",
            stderr: "piped",
          }).spawn();
        if (phase === "blocked_original") {
          child = spawn(phase);
          const blocked = await child.output();
          child = undefined;
          assert(blocked.success, new TextDecoder().decode(blocked.stderr));
          assertEquals(
            await Deno.readTextFile(join(dir, "transport.log")),
            "read\n",
          );
          const hooks = (await Deno.readTextFile(join(dir, "hook.log"))).trim()
            .split("\n");
          assertEquals(hooks, [
            "blocked_original:provider",
            "blocked_original:pre_tool",
            "blocked_original:pre_outbound",
            "blocked_original:resolve_credential",
            "blocked_original:post_deny",
            "blocked_original:provider",
            "blocked_original:output_internal",
          ]);
          return;
        }
        child = spawn(
          executionFollowup
            ? "interrupt_execution_evidence_followup"
            : executionDiscovery
            ? "interrupt_execution_evidence_page"
            : executionFinding
            ? "interrupt_execution_evidence_finding"
            : executionEvidence
            ? "interrupt_execution_evidence"
            : discoveryWithdrawn
            ? "interrupt_discovery"
            : recheckDenied
            ? "interrupt_recheck_goal_proof"
            : phase === "resume_traffic_unavailable"
            ? "interrupt_traffic_batch"
            : phase === "resume_graph_batch_corrupt"
            ? "interrupt_graph_batch"
            : phase === "resume_workflow_unapproved"
            ? "interrupt_workflow_batch"
            : phase === "resume_graph_unproven"
            ? "interrupt_graph_mutation"
            : phase === "resume_graph"
            ? "interrupt_assigned"
            : phase === "resume_unproven"
            ? "interrupt_mutation"
            : phase.startsWith("resume_")
            ? phase.replace("resume_", "interrupt_")
            : "interrupt",
        );
        let ready = false;
        for (let attempt = 0; attempt < 200 && !ready; attempt++) {
          try {
            await Deno.stat(join(dir, "checkpoint-ready"));
            ready = true;
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        if (!ready) {
          const diagnostics = await child.output();
          const debug = controlRenewal || executionFollowup || nativeExecution
            ? JSON.stringify(readAdaptiveSentinel(path, assessment)) +
              await Deno.readTextFile(join(dir, "hook.log")).catch(() => "")
            : "";
          throw new Error(new TextDecoder().decode(diagnostics.stderr) + debug);
        }
        child.kill("SIGKILL");
        assert(!(await child.status).success);
        child = undefined;

        const database = join(dirname(path), "sentinel-adaptive.db");
        for (const file of [database, `${database}-wal`]) {
          try {
            const bytes = await Deno.readFile(file);
            assert(!new TextDecoder().decode(bytes).includes("fixture-only-"));
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound) || file === database) {
              throw error;
            }
          }
        }
        const store = new DatabaseSync(database);
        try {
          assertEquals(
            store.prepare(
              "SELECT COUNT(*) AS count FROM adaptive_worker_checkpoints",
            ).get()?.count,
            1,
          );
          if (executionFollowup) {
            const checkpoint = JSON.parse(String(
              store.prepare(
                "SELECT checkpoint FROM adaptive_worker_checkpoints",
              ).get()?.checkpoint,
            ));
            assertEquals(checkpoint.completedIterations, 1);
            const original = JSON.parse(
              await Deno.readTextFile(join(dir, "followup-finding")),
            );
            const boundTasks = store.prepare(`
              SELECT id, nodeId, plannerRound FROM adaptive_tasks
              WHERE json_extract(plannerRound, '$.recheckFindingId') IS NOT NULL
            `).all();
            assertEquals(boundTasks.length, 1);
            const [bound] = boundTasks;
            assert(typeof bound.id === "string");
            followupTaskId = bound.id;
            assertEquals(bound.nodeId, receiptNode);
            const round = JSON.parse(String(bound.plannerRound));
            assertEquals(round.recheckFindingId, original.id);
            const planning = readAdaptiveSentinel(path, assessment)
              ?.modelPlannerHistory
              .find(({ identity, attempt }) =>
                identity === round.identity && attempt === round.attempt
              );
            assert(
              planning?.reads?.some(({ tool, target, recheckFindingIds }) =>
                tool === "sentinel_case_execution_evidence" &&
                target === receiptNode &&
                recheckFindingIds?.includes(original.id)
              ),
            );
            const read = store.prepare(
              "SELECT stepIndex, result FROM adaptive_observation_search_batch_receipts",
            ).get();
            assertEquals(read?.stepIndex, 1);
            assertEquals(
              JSON.parse(String(read?.result)).record,
              JSON.parse(
                await Deno.readTextFile(join(dir, "followup-finding")),
              ),
            );
          }
          if (controlRenewal) {
            const checkpoint = JSON.parse(String(
              store.prepare(
                "SELECT checkpoint FROM adaptive_worker_checkpoints",
              ).get()?.checkpoint,
            ));
            const staged = store.prepare(
              "SELECT receipt, controlClaimSha256 FROM adaptive_live_workflow_results",
            ).get();
            assert(/^[a-f0-9]{64}$/.test(checkpoint.controlClaimSha256));
            assertEquals(
              staged?.controlClaimSha256,
              checkpoint.controlClaimSha256,
            );
            assertEquals(JSON.parse(String(staged?.receipt)).runs[0].id, 51);
          }
          if (phase === "resume_first_batch") {
            const baseline = JSON.parse(
              String(
                store.prepare(
                  "SELECT checkpoint FROM adaptive_worker_checkpoints",
                ).get()?.checkpoint,
              ),
            );
            assertEquals(baseline.completedIterations, 0);
            assertEquals(
              baseline.history.map(({ role }: { role: string }) => role),
              ["user"],
            );
            assertEquals(baseline.toolCallCounts, []);
          }
          if (phase === "resume_recheck_batch") {
            assertEquals(
              store.prepare(
                "SELECT stepIndex FROM adaptive_recheck_context_batch_receipts",
              ).get()?.stepIndex,
              1,
            );
          }
          if (phase !== "resume_assigned" && !graphPhase && !findingPhase) {
            assertEquals(
              store.prepare(
                "SELECT COUNT(*) AS count FROM adaptive_live_workflow_results",
              ).get()?.count,
              1,
            );
          }
          if (
            phase === "resume_graph_batch" ||
            phase === "resume_graph_batch_corrupt"
          ) {
            assertEquals(
              store.prepare(
                "SELECT stepIndex FROM adaptive_assigned_target_batch_receipts",
              ).get()?.stepIndex,
              0,
            );
            assertEquals(
              JSON.parse(
                String(
                  store.prepare(
                    "SELECT checkpoint FROM adaptive_worker_checkpoints",
                  ).get()?.checkpoint,
                ),
              ).completedIterations,
              0,
            );
            if (phase === "resume_graph_batch_corrupt") {
              store.exec(
                "UPDATE adaptive_assigned_target_batch_receipts SET result = result || ' '",
              );
            }
          }
          if (phase === "resume_graph_unproven") {
            const row = store.prepare(
              "SELECT rowid, note FROM adaptive_events WHERE event = 'model_mutation_pending'",
            ).get();
            assert(typeof row?.note === "string");
            const marker = JSON.parse(row.note);
            marker.journalRequests[0].requestId =
              "cba7ef0f-5479-4f75-93c9-1f144e97eee9";
            store.prepare("UPDATE adaptive_events SET note = ? WHERE rowid = ?")
              .run(JSON.stringify(marker), row.rowid);
          }
          if (phase === "resume_workflow_unapproved") {
            const row = store.prepare(
              "SELECT taskId, steps FROM adaptive_worker_progress",
            ).get();
            assert(typeof row?.steps === "string");
            const steps = JSON.parse(row.steps);
            assertEquals(steps[1]?.tool, "sentinel_live_workflow_status");
            store.prepare(
              "UPDATE adaptive_worker_progress SET steps = ? WHERE taskId = ?",
            )
              .run(JSON.stringify(steps.slice(0, 1)), row.taskId);
          }
          if (phase === "resume_unproven") {
            store.exec(
              "DELETE FROM adaptive_events WHERE event = 'workflow_observation_committed'",
            );
          }
          // Advance only the expired lease clock in the isolated fixture.
          store.exec(
            "UPDATE adaptive_model_reviews SET availableAt = 0 WHERE token IS NOT NULL",
          );
        } finally {
          store.close();
        }
        if (phase === "fresh") {
          const previous = JSON.parse(await Deno.readTextFile(path));
          previous.nodes[0].label = "Updated delivery pipeline";
          await Deno.writeTextFile(path, JSON.stringify(previous));
          refreshSentinelAssessment(path);
          const clock = new DatabaseSync(
            join(dirname(path), "sentinel-adaptive.db"),
          );
          try {
            clock.exec("UPDATE adaptive_model_attempts SET started = 0");
          } finally {
            clock.close();
          }
        }
        if (phase === "resume_traffic_unavailable") {
          const missing = new DatabaseSync(
            join(dirname(path), "sentinel-traffic-receipts.db"),
          );
          try {
            missing.exec("DELETE FROM traffic_receipts_v1");
          } finally {
            missing.close();
          }
        }
        if (discovery) {
          const store = openSentinelAssetDiscoveryStore(dir);
          try {
            const pending = store.readProposalReceipt(
              "15673bf0-5479-4f75-93c9-1f144e97eee9",
            );
            assert(pending);
            assertEquals(pending.status, "pending");
            assertEquals(
              store.approve(pending.id, pending.version)?.status,
              "approved",
            );
            const { discovery: approved } = JSON.parse(
              await Deno.readTextFile(join(dir, "approved-discovery")),
            );
            const extra = store.propose({
              sourceCaseId: approved.sourceCaseId,
              taskId: approved.taskId,
              evidenceRevision: approved.evidenceRevision,
              sourceDigest: approved.sourceDigest,
              claim: {
                kind: "alias",
                assetId,
                alias: "delivery.example.invalid",
                evidenceId: "pipeline-record",
              },
            });
            assertEquals(
              store.approve(extra.id, extra.version)?.status,
              "approved",
            );
            if (discoveryWithdrawn) {
              assertEquals(
                store.withdraw(approved.id, approved.version)?.status,
                "withdrawn",
              );
            }
          } finally {
            store.close();
          }
        }
        if (phase === "resume_goal_proof") {
          addSentinelCaseHint(
            path,
            "Review the new hint published during downtime.",
          );
          const partial = readSentinelGoalCompletionForState(path, assessment);
          assertEquals(partial?.status, "open");
          assert(partial);
          const later = reportSentinelGoalCompletion(path, partial.scope, [{
            criterionId: "pipeline-review/operator-proof",
            evidence: [{
              source: "graph_evidence",
              reference: "pipeline-record",
              detail: "Confirmed retained evidence.",
            }],
          }]);
          assertEquals(later.record.status, "awaiting_confirmation");
        }
        if (taskProof) {
          assert(peerFactId);
          const newerWorkflow = publishWorkflow(4);
          const storeForPage = openSentinelAdaptiveStore(
            join(dirname(path), "sentinel-adaptive.db"),
          );
          try {
            const publications = storeForPage.workflowObservations(
              adaptiveRevision(assessment),
            );
            assertEquals(publications.length, 2);
            assertEquals(publications[1].id, newerWorkflow.id);
          } finally {
            storeForPage.close();
          }
          const revision = adaptiveRevision(assessment);
          const request = { kind: "trace" as const, nodeId: assetId, depth: 2 };
          const store = openSentinelAdaptiveStore(
            join(dirname(path), "sentinel-adaptive.db"),
          );
          try {
            const id = sentinelAdaptiveTaskId(revision, request);
            store.sync(revision, [{
              ...request,
              reason: "fixture peer review",
            }], revision);
            const lease = store.claim(
              revision,
              60,
              new Set(
                store.list(revision).filter((task) => task.id !== id).map((
                  task,
                ) => task.id),
              ),
            );
            assert(lease);
            assertEquals(lease.task.id, id);
            store.complete({
              taskId: id,
              leaseToken: lease.leaseToken,
              observation: {
                summary: "A new retained peer result.",
              },
            });
            const review = store.claimModelReview(
              revision,
              "fixture peer review",
              (task) => task.id === id,
            );
            assert(review);
            assert(store.finishModelReview(revision, id, review.token, {
              note: "A completed peer review.",
              steps: [{
                tool: "sentinel_assigned_target",
                target: "delivery",
                outcome: "returned",
              }],
            }));
            const now = readSentinelWorkerObservation(
              path,
              assessment.revision,
              {
                query: "retained peer",
                offset: 0,
              },
            );
            assert(typeof now === "object");
            assertEquals(now.observations.map((row) => row.id), [
              id,
              peerFactId,
            ]);
            const tracePage = searchSentinelWorkerTraces({
              snapshotPath: path,
              assessmentRevision: assessment.revision,
            }, { query: "assigned_target", limit: 1 });
            assertEquals(JSON.parse(tracePage).totalSteps, 2);
            assertEquals(JSON.parse(tracePage).nextOffset, 1);
          } finally {
            store.close();
          }
        }
        if (pinnedSources) {
          const args = { node: "evidence:pipeline-record", limit: 1 };
          const selected = {
            snapshotPath: path,
            assessmentRevision: assessment.revision,
          };
          const alternatePath = JSON.parse(
            await Deno.readTextFile(join(dir, "pinned-source-args")),
          )[5];
          const recompute = () =>
            readSentinelGraphProjection(
              path,
              assessment.revision,
              "sentinel_path",
              alternatePath,
            );
          const originalPath = await recompute();
          const before = JSON.parse(inspectSentinelProvenance(selected, args));
          const search = { kind: "observation", origin: "adaptive", limit: 1 };
          const beforeSearch = JSON.parse(
            searchSentinelProvenance(selected, search),
          );
          assertEquals(beforeSearch.nodes.length, 1);
          const view = readAdaptiveSentinel(path, assessment);
          const source = view?.tasks.find((task) =>
            task.kind === "trace" && task.nodeId === assetId
          );
          const graph = assessment.result?.sharedGraph.snapshot;
          assert(source && graph && assessment.plan.runId);
          const facts = openSentinelWorkerGraphFacts(path);
          try {
            assert(facts.record({
              caseId: "main",
              runId: assessment.plan.runId,
              evidenceRevision: assessment.revision,
              taskId: source.id,
              targetId: assetId,
              sourceStepIndex: 0,
              snapshotDigest: digestSentinelSnapshot(graph),
              resultSha256: "a".repeat(64),
              requestId: crypto.randomUUID(),
              relationship: {
                from: "pipeline-record",
                to: assetId,
                relation: "observed_on",
              },
            }, () => true));
          } finally {
            facts.close();
          }
          const after = JSON.parse(inspectSentinelProvenance(selected, args));
          assert(
            originalPath !== await recompute(),
            "The new fact must change the alternate path response",
          );
          assertEquals(after.totalConnections, before.totalConnections + 1);
          const afterSearch = JSON.parse(
            searchSentinelProvenance(selected, search),
          );
          assertEquals(afterSearch.totalNodes, beforeSearch.totalNodes + 1);
          await Deno.writeTextFile(
            path,
            JSON.stringify({ ...snapshot, edges: [] }),
          );

          if (sharedAssetLinks) {
            await Deno.remove(resolveSentinelCasePath(dir, "alias-bridge"));
          }
          await Deno.writeTextFile(
            reporter,
            JSON.stringify({ version: 1, nodes: [dependency], edges: [] }),
          );
        }
        if (peerProof) {
          const fact = JSON.parse(
            await Deno.readTextFile(join(dir, "peer-goal-fact")),
          );
          const journal = openSentinelWorkerGraphFacts(path);
          try {
            assert(
              journal.record({
                ...fact,
                taskId: "adaptive:" + "d".repeat(64),
                requestId: crypto.randomUUID(),
              }, () => true),
            );
            const page = journal.list({
              caseId: fact.caseId,
              runId: fact.runId,
              evidenceRevision: fact.evidenceRevision,
              targetId: fact.targetId,
            }, { offset: 1, limit: 3 });
            assertEquals(page.facts.length, 2);
            assert(page.facts[0].id !== fact.id);
          } finally {
            journal.close();
          }
        }
        if (recheckProof) {
          const saved = JSON.parse(
            await Deno.readTextFile(join(dir, "peer-goal-recheck")),
          );
          const journal = openSentinelWorkerFindingStore(path);
          try {
            const original = journal.readFinding(saved.findingId);
            assert(original);
            const added = journal.recordFinding({
              ...original,
              evidenceRevision: assessment.revision,
              requestId: crypto.randomUUID(),
              summary: "Additional finding committed during downtime.",
            });
            assertEquals(journal.list(assessment.revision)[0].id, added.id);
            assert(added.id !== saved.id);
          } finally {
            journal.close();
          }
        }
        if (defenseSummary) {
          await Deno.writeTextFile(sentinelAlertsPath(path), "[]");
        }
        if (executionDiscovery && !executionFollowup) {
          const journal = openSentinelWorkerFindingStore(path);
          try {
            const [original] = journal.list(assessment.revision);
            assert(original?.kind === "finding");
            const added = journal.recordFinding({
              ...original,
              requestId: "new-discovery-finding",
              summary: "A new finding committed during downtime.",
            });
            assert(added && added.id !== original.id);
            assertEquals(journal.list(assessment.revision)[0].id, added.id);
          } finally {
            journal.close();
          }
        }
        child = spawn(phase);
        const resumed = await child.output();
        child = undefined;
        assert(resumed.success, new TextDecoder().decode(resumed.stderr));
        const transport = await Deno.readTextFile(join(dir, "transport.log"))
          .catch((error) => {
            if (error instanceof Deno.errors.NotFound) return "";
            throw error;
          });
        assertEquals(
          transport,
          phase === "resume_assigned" || graphPhase || findingPhase
            ? ""
            : phase === "fresh" || controlRenewal
            ? "read\nread\n"
            : "read\n",
        );
        const hooks = (await Deno.readTextFile(join(dir, "hook.log"))).trim()
          .split("\n");
        if (controlRenewal) {
          const restartHooks = hooks.filter((line) =>
            line.startsWith("resume_control_renewal:")
          );
          assert(restartHooks.includes("resume_control_renewal:pre_outbound"));
          assert(
            !restartHooks.includes("resume_control_renewal:probe_metadata"),
          );
          const store = openSentinelAdaptiveStore(database);
          try {
            const claims = store.history(adaptiveRevision(assessment)).filter((
              { event },
            ) => event === "model_review_claimed");
            assertEquals(claims.length, 2);
            assertEquals(claims[0].taskId, claims[1].taskId);
            assert(claims[0].note && claims[1].note);
            const [renewed, original] = claims.map(({ note }) =>
              JSON.parse(note!).controlPrerequisites[0]
            );
            assertEquals(renewed.initialGraphFactId, original.graphFactId);
            assert(renewed.graphFactId !== original.graphFactId);
            assertEquals(renewed.evidenceRevision, original.evidenceRevision);
          } finally {
            store.close();
          }
          return;
        }
        if (defenseSummary) {
          assertEquals(
            hooks.filter((line) =>
              line.startsWith("resume_defense_summary:incident_")
            ),
            [
              ...Array(2).fill("resume_defense_summary:incident_pre"),
              ...Array(2).fill("resume_defense_summary:incident_post"),
            ],
          );
          assertEquals(
            hooks.filter((line) =>
              line.startsWith("resume_defense_summary:defense_")
            ),
            [
              ...Array(3).fill("resume_defense_summary:defense_pre"),
              ...Array(3).fill("resume_defense_summary:defense_post"),
            ],
          );
          await verifyHistoricalWorkerReads(
            dir,
            path,
            assessment,
            "Recovered the original defense reads.",
            [2, 4],
          );
          return;
        }
        if (sharedAssetLinks) {
          assertEquals(
            hooks.filter((line) => /:asset_links_(pre|post)$/.test(line)),
            [
              "interrupt_shared_asset_links:asset_links_pre",
              "interrupt_shared_asset_links:asset_links_post",
              "resume_shared_asset_links:asset_links_pre",
              "resume_shared_asset_links:asset_links_post",
            ],
          );
          const history = readAdaptiveSentinel(path, assessment);
          const review = history?.modelReviews.find(({ summary }) =>
            summary === "Recovered shared asset links."
          );
          assert(review);
          const scope = {
            snapshotPath: path,
            assessmentRevision: assessment.revision,
          };
          const trace = JSON.parse(searchSentinelWorkerTraces(scope, {
            revision: assessment.revision,
            task: review.taskId,
            stepIndices: [0],
          }));
          assertEquals(trace.steps[0].tool, "sentinel_shared_asset_links");
          for (
            const [label, projection] of [
              ...Object.entries(history ?? {}).map((
                [key, value],
              ) => [key, JSON.stringify(value) ?? ""]),
              ["trace", JSON.stringify(trace)],
              [
                "provenance",
                inspectSentinelProvenance(scope, {
                  node: trace.steps[0].reviewId,
                }),
              ],
            ]
          ) {
            assert(!projection.includes("sharedAssetLinksPage"), label);
          }
          await verifyHistoricalWorkerReads(
            dir,
            path,
            assessment,
            "Recovered shared asset links.",
            [0],
          );
          return;
        }
        if (pinnedSources) {
          for (
            const source of [
              "topology",
              "finding",
              "provenance",
              "provenance_search",
              "path",
              "trace",
              "impact",
              "report",
              "coverage",
            ]
          ) {
            const events = hooks.filter((line) =>
              line.endsWith(`:${source}_pre`) ||
              line.endsWith(`:${source}_post`)
            );
            assert(events.includes(`interrupt_pinned_sources:${source}_post`));
            assertEquals(
              events.filter((line) => line.startsWith("resume_pinned_sources")),
              [
                `resume_pinned_sources:${source}_pre`,
                ...(source === "path"
                  ? [
                    ...Array(3).fill(`resume_pinned_sources:${source}_pre`),
                    ...Array(3).fill(`resume_pinned_sources:${source}_post`),
                  ]
                  : []),
                `resume_pinned_sources:${source}_post`,
              ],
            );
          }
          const history = readHistoricalAdaptiveSentinel(
            path,
            assessment.revision,
            undefined,
            false,
            true,
          );
          const exactPaths = history?.modelReviews
            .find(({ summary }) =>
              summary === "Recovered exact pinned sources."
            )
            ?.steps.filter(({ tool, goalReceiptRead }) =>
              tool === "sentinel_path" &&
              goalReceiptRead?.args.graph === "provenance"
            );
          assertEquals(exactPaths?.length, 2);
          for (const step of exactPaths ?? []) {
            assert(step.plannerProvenancePath);
            assertEquals(
              createHash("sha256").update(step.plannerProvenancePath).digest(
                "hex",
              ),
              step.goalReceiptRead?.sha256,
            );
          }
          await verifyHistoricalWorkerReads(
            dir,
            path,
            assessment,
            "Recovered exact pinned sources.",
            [0, 4, 5, 6, 7, 8, 9, 10, 11, 3, 2, 1],
          );
          return;
        }
        if (savedWorkflow) {
          assertEquals(
            hooks.filter((line) => line.startsWith("resume_saved_workflow:"))
              .slice(0, 2),
            [
              "resume_saved_workflow:prior_pre",
              "resume_saved_workflow:prior_post",
            ],
          );
          await verifyHistoricalWorkerReads(
            dir,
            path,
            assessment,
            "Recovered the exact historical evidence.",
            [0],
          );
          return;
        }
        if (priorAssigned) {
          assertEquals(
            hooks.filter((line) => /:prior_(pre|post)$/.test(line)),
            [
              "interrupt_prior_assigned:prior_pre",
              "interrupt_prior_assigned:prior_pre",
              "interrupt_prior_assigned:prior_post",
              "resume_prior_assigned:prior_pre",
              "resume_prior_assigned:prior_post",
            ],
          );
          await verifyHistoricalWorkerReads(
            dir,
            path,
            assessment,
            "Recovered the exact historical evidence.",
            [0],
          );
          return;
        }
        if (
          phase === "resume_finding_batch" || phase === "resume_finding_partial"
        ) {
          assert(assessment.plan.runId);
          const facts = listSentinelPlannerGraphFacts(path, {
            caseId: "main",
            runId: assessment.plan.runId,
            evidenceRevision: assessment.revision,
          });
          assertEquals(facts.length, 1);
          const db = new DatabaseSync(database);
          try {
            const rows = db.prepare(
              "SELECT taskId, note FROM adaptive_events WHERE event = 'model_mutation_settled'",
            ).all();
            if (phase === "resume_finding_partial") {
              assertEquals(rows, []);
              assertEquals(
                hooks.filter((line) => line.startsWith(`${phase}:`)),
                [],
              );
              assertEquals(
                hooks.filter((line) => line.endsWith(":finding_committed")),
                [],
              );
            } else {
              assertEquals(rows.length, 1);
              const receipts = JSON.parse(String(rows[0].note));
              assertEquals(receipts[0], facts[0].id);
              const finding = readSentinelWorkerFindingWriteReceipt(path, {
                caseId: "main",
                runId: assessment.plan.runId,
                evidenceRevision: assessment.revision,
                taskId: String(rows[0].taskId),
                targetId: "delivery",
              }, "15673bf0-5479-4f75-93c9-1f144e97eee9");
              assertEquals(receipts[1], finding?.id);
              assertEquals(
                hooks.filter((line) => line.endsWith(":finding_committed"))
                  .length,
                1,
              );
              assertEquals(
                hooks.filter((line) => line.endsWith(":finding_reauthorized"))
                  .length,
                1,
              );
            }
          } finally {
            db.close();
          }
          return;
        }
        if (trafficPhase) {
          const links = listSentinelFindingTrafficLinks(path, {
            assetId,
            evidenceRevision: assessment.revision,
          });
          assertEquals(
            links.length,
            phase === "resume_traffic_listing" ? 2 : 1,
          );
          const attached = links.find((link) => link.trafficId === trafficId);
          assertEquals(attached?.reportVersion, 1);
          if (phase === "resume_traffic_unavailable") {
            assertEquals(
              hooks.filter((line) => line.startsWith(`${phase}:`)),
              [],
            );
            return;
          }
          assertEquals(hooks.filter((line) => line.endsWith(":traffic_read")), [
            `${phase.replace("resume_", "interrupt_")}:traffic_read`,
            `${phase}:traffic_read`,
          ]);
          assertEquals(
            hooks.filter((line) => line.endsWith(":traffic_attachment")),
            [
              `${phase.replace("resume_", "interrupt_")}:traffic_attachment`,
              `${phase}:traffic_attachment`,
            ],
          );
          if (phase === "resume_traffic_listing") {
            const linkedPage = readAdaptiveSentinel(path, assessment)
              ?.modelReviews
              .flatMap(({ steps }) => steps)
              .find(({ trafficLinks }) => trafficLinks)?.trafficLinks;
            assertEquals(
              linkedPage?.linkIds,
              links.filter(({ trafficId }) => trafficId === historicalTrafficId)
                .map(({ id }) => id),
            );
            assertEquals(linkedPage?.nextOffset, null);
            assert(hooks.includes("interrupt_traffic_listing:traffic_listing"));
            assertEquals(
              hooks.filter((line) =>
                line === "resume_traffic_listing:traffic_listing"
              ),
              ["resume_traffic_listing:traffic_listing"],
            );
            const db = new DatabaseSync(database);
            try {
              assertEquals(
                db.prepare(
                  "SELECT COUNT(*) AS count FROM adaptive_traffic_links_batch_receipts",
                ).get()?.count,
                0,
              );
            } finally {
              db.close();
            }
          }
          if (phase === "resume_traffic_search") {
            const search = readAdaptiveSentinel(path, assessment)?.modelReviews
              .flatMap(({ steps }) => steps)
              .find(({ trafficSearch }) => trafficSearch);
            assert(search?.trafficSearchPage);
            assertEquals(
              search.trafficSearchPage.sha256,
              search.trafficSearch?.sha256,
            );
            assertEquals(
              search.trafficSearchPage.revision,
              assessment.revision,
            );
            assertEquals(
              hooks.filter((line) => line.endsWith(":traffic_search")),
              [
                "interrupt_traffic_search:traffic_search",
                "resume_traffic_search:traffic_search",
              ],
            );
          }
          return;
        }
        if (findingPhase && !recheckProof) {
          assertEquals(
            hooks.filter((line) => line.endsWith(":finding_committed")),
            [
              `${phase.replace("resume_", "interrupt_")}:finding_committed`,
            ],
          );
          assertEquals(
            hooks.filter((line) => line.endsWith(":finding_reauthorized")),
            [
              `${phase}:finding_reauthorized`,
            ],
          );
          const db = new DatabaseSync(database);
          try {
            const settled = db.prepare(
              "SELECT taskId, note FROM adaptive_events WHERE event = 'model_mutation_settled' AND note IS NOT NULL",
            ).get();
            assert(typeof settled?.taskId === "string");
            assert(assessment.plan.runId);
            const receipt = readSentinelWorkerFindingWriteReceipt(path, {
              caseId: "main",
              runId: assessment.plan.runId,
              evidenceRevision: assessment.revision,
              taskId: settled.taskId,
              targetId: "delivery",
            }, "15673bf0-5479-4f75-93c9-1f144e97eee9");
            assertEquals(receipt?.id, settled.note);
            if (phase === "resume_recheck_batch") {
              assertEquals(
                db.prepare(
                  "SELECT COUNT(*) AS count FROM adaptive_recheck_context_batch_receipts",
                ).get()?.count,
                0,
              );
              assert(hooks.includes("interrupt_recheck_batch:recheck_context"));
              assertEquals(
                hooks.filter((line) =>
                  line === "resume_recheck_batch:recheck_context"
                ),
                ["resume_recheck_batch:recheck_context"],
              );
            }

            assertEquals(
              receipt?.kind,
              phase === "resume_amendment"
                ? "report_amendment"
                : phase === "resume_recheck_batch"
                ? "recheck"
                : phase.slice(7),
            );
          } finally {
            db.close();
          }
          return;
        }
        if (peerProof || taskProof || recheckProof) {
          if (taskProof) {
            const database = new DatabaseSync(
              join(dirname(path), "sentinel-adaptive.db"),
            );
            try {
              const retained = database.prepare(
                "SELECT count(*) AS count FROM adaptive_observation_search_batch_receipts",
              ).get();
              assertEquals(retained?.count, 0);
            } finally {
              database.close();
            }
          }
          const saved = readSentinelGoalCompletionForState(path, assessment);
          assertEquals(saved?.status, "open");
          assertEquals(saved?.observations.length, 1);
          assertEquals(
            saved?.observations[0].evidence[0].reference,
            peerFactId,
          );
          const interrupted = recheckDenied
            ? "interrupt_recheck_goal_proof"
            : phase.replace("resume_", "interrupt_");
          if (recheckDenied) {
            assert(!hooks.includes(`${phase}:denied_replay_leak`));
            assertEquals(
              hooks.filter((line) =>
                line.startsWith(`${phase}:`) &&
                !line.endsWith(":fresh_provider")
              ),
              [
                `${phase}:peer_fact_pre`,
                `${phase}:peer_fact_pre`,
                `${phase}:peer_fact_pre`,
                `${phase}:peer_fact_post_denied`,
              ],
            );
            return;
          }
          const evidenceHooks = (
            name: string,
          ) => [`${name}:peer_fact_pre`, `${name}:peer_fact_post`];
          assertEquals(
            hooks.filter((line) => /:peer_fact_(pre|post)$/.test(line)),
            [
              ...evidenceHooks(interrupted),
              ...(taskProof
                ? [...evidenceHooks(interrupted), ...evidenceHooks(interrupted)]
                : recheckProof
                ? [...evidenceHooks(interrupted), ...evidenceHooks(interrupted)]
                : peerProof
                ? evidenceHooks(interrupted)
                : []),
              ...(taskProof
                ? [
                  `${phase}:peer_fact_pre`,
                  `${phase}:peer_fact_pre`,
                  `${phase}:peer_fact_pre`,
                  `${phase}:peer_fact_post`,
                  `${phase}:peer_fact_post`,
                  `${phase}:peer_fact_post`,
                ]
                : recheckProof
                ? [
                  ...Array(3).fill(`${phase}:peer_fact_pre`),
                  ...Array(3).fill(`${phase}:peer_fact_post`),
                ]
                : peerProof
                ? [
                  `${phase}:peer_fact_pre`,
                  `${phase}:peer_fact_pre`,
                  `${phase}:peer_fact_post`,
                  `${phase}:peer_fact_post`,
                ]
                : evidenceHooks(phase)),
            ],
          );
          if (taskProof) {
            const published = JSON.parse(
              await Deno.readTextFile(join(dir, "peer-goal-workflow")),
            );
            const provenance = readSentinelProvenance(
              path,
              assessment.revision,
            );
            const trace = provenance?.graph.searchReviewSteps(
              "sentinel_intermediate_workflow_observation",
            ).find(({ target }) => target === published.id);
            assert(trace);
            assertEquals(
              trace.intermediateWorkflowObservation?.sourceTaskId,
              published.taskId,
              JSON.stringify(trace),
            );
            assertEquals(
              trace.intermediateWorkflowObservation?.sourceStepIndex,
              published.stepIndex,
            );
            assertEquals(
              provenance?.graph.inspect(trace.targetRef!)?.node.sourceId,
              published.id,
            );
          }
          if (taskProof) {
            await verifyHistoricalWorkerReads(
              dir,
              path,
              assessment,
              "Recovered the worker goal proof.",
              [2, 3, 5],
            );
          }
          if (taskProof) {
            assertEquals(
              hooks.filter((line) => /:intermediate_(pre|post)$/.test(line)),
              [
                `${interrupted}:intermediate_pre`,
                `${interrupted}:intermediate_post`,
                `${interrupted}:intermediate_pre`,
                `${interrupted}:intermediate_post`,
                `${phase}:intermediate_pre`,
                `${phase}:intermediate_pre`,
                `${phase}:intermediate_post`,
                `${phase}:intermediate_post`,
              ],
            );
          }
          if (taskProof) {
            assertEquals(
              hooks.filter((line) =>
                line.endsWith(":trace_pre") || line.endsWith(":trace_post")
              ),
              [
                `${interrupted}:trace_pre`,
                `${interrupted}:trace_post`,
                `${phase}:trace_pre`,
                `${phase}:trace_post`,
              ],
            );
          }
          assertEquals(
            hooks.filter((line) => line.endsWith(":goal_proof_result")),
            [`${interrupted}:goal_proof_result`, `${phase}:goal_proof_result`],
          );
          return;
        }
        if (phase === "resume_goal_proof") {
          assertEquals(
            hooks.filter((line) => /:case_hints_(pre|post)$/.test(line)),
            [
              "interrupt_goal_proof:case_hints_pre",
              "interrupt_goal_proof:case_hints_post",
              "resume_goal_proof:case_hints_pre",
              "resume_goal_proof:case_hints_post",
            ],
          );
          assertEquals(
            hooks.filter((line) => /:goal_state_(pre|post)$/.test(line)),
            [
              "interrupt_goal_proof:goal_state_pre",
              "interrupt_goal_proof:goal_state_post",
              "resume_goal_proof:goal_state_pre",
              "resume_goal_proof:goal_state_post",
            ],
          );
          const trace = readAdaptiveSentinel(path, assessment)?.modelReviews
            .flatMap(({ steps }) => steps)
            .find(({ tool }) => tool === "sentinel_prove_goal");
          assertEquals(
            trace?.goalProofRequestId,
            "15673bf0-5479-4f75-93c9-1f144e97eee9",
          );
          const saved = readSentinelGoalCompletionForState(path, assessment);
          assertEquals(saved?.status, "awaiting_confirmation");
          assertEquals(saved?.observations.length, 2);
          const proof = saved?.observations.find(({ criterionId }) =>
            criterionId === "pipeline-review/worker-proof"
          );
          assertEquals(proof?.evidence.length, 1);
          assertEquals(
            hooks.filter((line) => line.endsWith(":goal_proof_result")),
            [
              "interrupt_goal_proof:goal_proof_result",
              "resume_goal_proof:goal_proof_result",
            ],
          );
          await verifyHistoricalWorkerReads(
            dir,
            path,
            assessment,
            "Recovered the worker goal proof.",
            [0, 1],
          );
          return;
        }
        if (phase === "resume_goal_proposal") {
          assert(assessment.plan.runId);
          const proposals = readSentinelWorkerGoalProposals(
            path,
            assessment.plan.runId,
            assessment.revision,
          );
          assertEquals(proposals.length, 1);
          const { acceptedRevision, ...proposal } = proposals[0];
          assertEquals(acceptedRevision, null);
          assertEquals(
            readSentinelWorkerGoalProposalReceipt(
              path,
              proposal,
              "15673bf0-5479-4f75-93c9-1f144e97eee9",
            ),
            proposal,
          );
          assertEquals(
            readSentinelWorkerGoalProposalReceipt(path, {
              ...proposal,
              targetId: "another",
            }, "15673bf0-5479-4f75-93c9-1f144e97eee9"),
            undefined,
          );
          assertEquals(
            hooks.filter((line) => line.endsWith(":goal_proposal_result")),
            [
              "interrupt_goal_proposal:goal_proposal_result",
              "resume_goal_proposal:goal_proposal_result",
            ],
          );
          return;
        }
        if (discovery) {
          if (!discoveryWithdrawn) {
            const trace = readAdaptiveSentinel(path, assessment)?.modelReviews
              .flatMap(({ steps }) => steps)
              .find(({ tool }) => tool === "sentinel_submit_asset_discovery");
            assertEquals(
              trace?.assetDiscoveryRequestId,
              "15673bf0-5479-4f75-93c9-1f144e97eee9",
            );
          }
          const store = openSentinelAssetDiscoveryStore(dir);
          try {
            const receipt = store.readProposalReceipt(
              "15673bf0-5479-4f75-93c9-1f144e97eee9",
            );
            assert(receipt);
            assertEquals(receipt.status, "pending");
            assertEquals(store.get(receipt.id)?.status, "approved");
            assertEquals(
              store.history(receipt.id).map(({ status }) => status),
              ["pending", "approved"],
            );
          } finally {
            store.close();
          }
          if (discoveryWithdrawn) {
            assertEquals(hooks.filter((line) => line.startsWith(`${phase}:`)), [
              `${phase}:pre_tool`,
              `${phase}:discovery_read_pre`,
              `${phase}:discovery_read_pre`,
              `${phase}:post_allow`,
              `${phase}:discovery_read_post`,
              `${phase}:discovery_read_post`,
              `${phase}:discovery_result`,
            ]);
            return;
          }
          assertEquals(
            hooks.filter((line) => /:discovery_read_(pre|post)$/.test(line)),
            [
              "interrupt_discovery:discovery_read_pre",
              "interrupt_discovery:discovery_read_post",
              "interrupt_discovery:discovery_read_pre",
              "interrupt_discovery:discovery_read_post",
              "interrupt_discovery:discovery_read_pre",
              "interrupt_discovery:discovery_read_post",
              "resume_discovery:discovery_read_pre",
              "resume_discovery:discovery_read_pre",
              "resume_discovery:discovery_read_pre",
              "resume_discovery:discovery_read_post",
              "resume_discovery:discovery_read_post",
              "resume_discovery:discovery_read_post",
            ],
          );
          assertEquals(
            hooks.filter((line) => line.endsWith(":discovery_result")),
            [
              "interrupt_discovery:discovery_result",
              "resume_discovery:discovery_result",
            ],
          );
          return;
        }
        if (nativeExecution) {
          const restartHooks = hooks.filter((line) =>
            line.startsWith(`${phase}:`)
          );
          assertEquals(
            restartHooks.filter((line) =>
              line.endsWith(":native_metadata_policy")
            ),
            [`${phase}:native_metadata_policy`],
          );
          assertEquals(
            restartHooks.filter((line) => line.endsWith(":probe_metadata")),
            [`${phase}:probe_metadata`],
          );
          assertEquals(
            restartHooks.includes(`${phase}:provider`),
            !executionDenied,
          );
          assert(!restartHooks.includes(`${phase}:denied_replay_leak`));
          assert(!restartHooks.includes(`${phase}:denied_replay_leak`));
          assertEquals(transport, "");
          return;
        }
        if (executionEvidence) {
          const restartHooks = hooks.filter((line) =>
            line.startsWith(`${phase}:`)
          );
          assertEquals(
            restartHooks.filter((line) => line.endsWith(":source_pre")),
            [`${phase}:source_pre`],
          );
          assertEquals(
            restartHooks.filter((line) =>
              line.endsWith(":source_authorization")
            ),
            [`${phase}:source_authorization`],
          );
          assertEquals(
            restartHooks.filter((line) => line.endsWith(":source_post")),
            !executionDenied ? [`${phase}:source_post`] : [],
          );
          assertEquals(
            restartHooks.includes(`${phase}:provider`),
            !executionDenied,
          );
          if (executionFollowup) {
            const journal = openSentinelWorkerFindingStore(path);
            try {
              const records = journal.list(assessment.revision);
              const checks = records.filter((record) =>
                record.kind === "recheck"
              );
              assertEquals(checks.length, 1);
              assertEquals(checks[0].taskId, followupTaskId);
              assertEquals(
                checks[0].findingId,
                JSON.parse(
                  await Deno.readTextFile(join(dir, "followup-finding")),
                ).id,
              );
              assert(
                readAdaptiveSentinel(path, assessment)?.modelReviews.some((
                  { taskId, summary },
                ) =>
                  taskId === followupTaskId &&
                  summary === "Recovered the exact finding and recheck."
                ),
              );
              assertEquals(checks[0].evidenceId, receiptNode);
              assertEquals(checks[0].outcome, "pass");
              const handler = createTidepoolSentinelHandler(
                { baseDir: dir, config: {} } as BootstrapResult,
              );
              const replies: Record<string, unknown>[] = [];
              const socket = {
                readyState: WebSocket.OPEN,
                send: (value: string) => replies.push(JSON.parse(value)),
              } as unknown as WebSocket;
              const lineage = {
                type: "worker_recheck_lineage",
                caseId: "main",
                revision: assessment.revision,
                taskId: followupTaskId,
                requestId: 42,
              };
              await handler(lineage, socket);
              assertEquals(replies[0], {
                topic: "sentinel",
                type: "sentinel_worker_recheck_lineage",
                caseId: "main",
                requestId: 42,
                taskId: followupTaskId,
                evidenceRevision: assessment.revision,
                evidenceId: receiptNode,
                finding: records.find((record) =>
                  record.id === checks[0].findingId
                ),
                rechecks: checks,
              });
              await handler(
                { ...lineage, revision: assessment.revision + 1 },
                socket,
              );
              assertEquals(replies[1]?.type, "error");
              assertEquals(replies[1]?.finding, undefined);
            } finally {
              journal.close();
            }
          }
          if (executionFinding) {
            assertEquals(
              restartHooks.filter((line) =>
                line.endsWith(":finding_response_check")
              ),
              [`${phase}:finding_response_check`],
            );
            const journal = openSentinelWorkerFindingStore(path);
            try {
              const records = journal.list(assessment.revision);
              assertEquals(records.length, 1);
              assertEquals(records[0].targetId, assetId);
              assertEquals(records[0].evidenceId, receiptNode);
            } finally {
              journal.close();
            }
          }
          return;
        }
        if (graphPhase) {
          assert(assessment.plan.runId);
          const facts = listSentinelPlannerGraphFacts(path, {
            caseId: "main",
            runId: assessment.plan.runId,
            evidenceRevision: assessment.revision,
          });
          assertEquals(facts.length, 1);
          assertEquals(facts[0].relationship, {
            from: "pipeline-record",
            to: "delivery",
            relation: "observed_on",
          });
          assertEquals(facts[0].sourceStepIndex, 0);
          if (
            phase === "resume_graph_unproven" ||
            phase === "resume_graph_batch_corrupt"
          ) {
            assertEquals(
              hooks.filter((line) => line.startsWith(`${phase}:`)),
              [],
            );
            return;
          }
          assertEquals(
            hooks.filter((line) => line === `${phase}:pre_tool`).length,
            1,
          );
          assertEquals(
            hooks.filter((line) => line === `${phase}:post_allow`).length,
            1,
          );
          if (
            phase === "resume_graph_mutation" || phase === "resume_graph_batch"
          ) {
            assertEquals(
              hooks.filter((line) => line.endsWith(":graph_committed")),
              [`${phase.replace("resume_", "interrupt_")}:graph_committed`],
            );
            assertEquals(
              hooks.filter((line) => line.endsWith(":graph_reauthorized")),
              [`${phase}:graph_reauthorized`],
            );
          }
          if (phase === "resume_graph_batch") {
            const db = new DatabaseSync(database);
            try {
              assertEquals(
                db.prepare(
                  "SELECT COUNT(*) AS count FROM adaptive_assigned_target_batch_receipts",
                ).get()?.count,
                0,
              );
              assertEquals(
                db.prepare(
                  "SELECT note FROM adaptive_events WHERE event = 'model_mutation_settled'",
                ).get()?.note,
                facts[0].id,
              );
            } finally {
              db.close();
            }
          }
          return;
        }
        if (phase === "resume_workflow_unapproved") {
          assertEquals(
            hooks.filter((line) => line.startsWith(`${phase}:`)),
            [],
          );
          const db = new DatabaseSync(database);
          try {
            assertEquals(
              db.prepare(
                "SELECT COUNT(*) AS count FROM adaptive_workflow_observations",
              ).get()?.count,
              1,
            );
            assertEquals(
              db.prepare(
                "SELECT COUNT(*) AS count FROM adaptive_events WHERE event = 'model_mutation_settled'",
              ).get()?.count,
              0,
            );
          } finally {
            db.close();
          }
          return;
        }
        if (
          phase === "resume_workflow_batch" || phase === "resume_first_batch"
        ) {
          assertEquals(
            hooks.filter((line) => line.endsWith(":mutation_committed")),
            [
              `${phase.replace("resume_", "interrupt_")}:mutation_committed`,
            ],
          );
          assertEquals(
            hooks.filter((line) => line.endsWith(":publication_reauthorized")),
            [
              `${phase}:publication_reauthorized`,
            ],
          );
          assertEquals(
            hooks.filter((line) => line.endsWith(":probe_metadata")),
            [
              `${phase}:probe_metadata`,
            ],
          );
          const db = new DatabaseSync(database);
          try {
            const observations = db.prepare(
              "SELECT id, stepIndex FROM adaptive_workflow_observations",
            ).all();
            assertEquals(observations.length, 1);
            assertEquals(
              observations[0].stepIndex,
              phase === "resume_first_batch" ? 0 : 1,
            );
            assertEquals(
              db.prepare(
                "SELECT note FROM adaptive_events WHERE event = 'model_mutation_settled'",
              ).get()?.note,
              observations[0].id,
            );
          } finally {
            db.close();
          }
          return;
        }
        if (phase === "resume_mutation" || phase === "resume_unproven") {
          assertEquals(
            hooks.filter((line) => line.endsWith(":mutation_committed")),
            ["interrupt_mutation:mutation_committed"],
          );
          assertEquals(
            hooks.filter((line) => line.startsWith(`${phase}:`)),
            phase === "resume_unproven" ? [] : [
              "resume_mutation:pre_tool",
              "resume_mutation:post_allow",
              "resume_mutation:publication_reauthorized",
              "resume_mutation:pre_metadata",
              "resume_mutation:resolve_credential",
              "resume_mutation:probe_metadata",
              "resume_mutation:provider",
              "resume_mutation:output_internal",
            ],
          );
          const db = new DatabaseSync(database);
          try {
            assertEquals(
              db.prepare(
                "SELECT COUNT(*) AS count FROM adaptive_workflow_observations",
              ).get()?.count,
              1,
            );
            assertEquals(
              db.prepare(
                "SELECT event FROM adaptive_events WHERE event LIKE 'model_mutation_%' ORDER BY rowid",
              ).all().map(({ event }) => event),
              phase === "resume_unproven"
                ? ["model_mutation_pending"]
                : ["model_mutation_pending", "model_mutation_settled"],
            );
          } finally {
            db.close();
          }
          return;
        }
        if (phase === "resume_mixed" || phase === "resume_multi") {
          assertEquals(hooks.filter((line) => line.startsWith(`${phase}:`)), [
            `${phase}:pre_target`,
            `${phase}:pre_tool`,
            `${phase}:post_target`,
            `${phase}:post_allow`,
            `${phase}:pre_metadata`,
            `${phase}:resolve_credential`,
            `${phase}:probe_metadata`,
            `${phase}:provider`,
            `${phase}:output_internal`,
          ]);
          return;
        }
        if (phase === "resume_assigned") {
          assertEquals(hooks, [
            "interrupt_assigned:provider",
            "interrupt_assigned:pre_tool",
            "interrupt_assigned:post_allow",
            "interrupt_assigned:provider",
            "resume_assigned:pre_tool",
            "resume_assigned:post_allow",
            "resume_assigned:provider",
            "resume_assigned:output_internal",
          ]);
          await verifyHistoricalWorkerReads(
            dir,
            path,
            assessment,
            "Resumed with the saved assignment target.",
            [0],
          );
          return;
        }
        assertEquals(hooks.filter((line) => line.startsWith("interrupt:")), [
          "interrupt:provider",
          "interrupt:pre_tool",
          "interrupt:pre_outbound",
          "interrupt:resolve_credential",
          "interrupt:post_allow",
          "interrupt:provider",
        ]);
        const restartHooks = hooks.filter((line) =>
          line.startsWith(`${phase}:`)
        );
        if (phase === "blocked_pre") {
          assertEquals(restartHooks, ["blocked_pre:pre_tool"]);
        } else if (phase === "blocked") {
          assertEquals(restartHooks, [
            "blocked:pre_tool",
            "blocked:post_deny",
          ]);
        } else if (phase === "revoked" || phase === "missing_credential") {
          assertEquals(restartHooks, [
            `${phase}:pre_tool`,
            `${phase}:post_allow`,
            `${phase}:pre_metadata`,
            `${phase}:resolve_credential`,
            ...(phase === "revoked" ? ["revoked:probe_metadata"] : []),
          ]);
        } else if (phase === "resume") {
          assertEquals(restartHooks, [
            "resume:pre_tool",
            "resume:post_allow",
            "resume:pre_metadata",
            "resume:resolve_credential",
            "resume:probe_metadata",
            "resume:provider",
            "resume:output_internal",
          ]);
        }
      } finally {
        if (child) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The child already exited.
          }
          await child.status;
        }
        await Deno.remove(dir, { recursive: true });
      }
    },
  });
}
