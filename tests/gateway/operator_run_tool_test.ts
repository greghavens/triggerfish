import { captureStoppedSentinelCaseArtifacts } from "../../src/sentinel/case_archive_capture.ts";
import type { OwnerAgentRecoveryExecutor } from "../../src/gateway/chat_session_config.ts";
import { buildWorkflowRecoveryExecutor } from "../../src/gateway/startup/factory/agent_recovery.ts";
import { createMemorySecretStore } from "../../src/core/secrets/mod.ts";
import { notifyCommittedEvidence } from "../../src/core/evidence_task_progression.ts";
import { buildSubagentFactory } from "../../src/gateway/startup/factory/subagent.ts";
import { bindScheduledAgent } from "../../src/scheduler/service_execution.ts";
import type {
  OrchestratorFactory,
  SchedulerServiceConfig,
} from "../../src/scheduler/service_types.ts";
import { DatabaseSync } from "node:sqlite";
import { openSentinelAssetDiscoveryStore } from "../../src/sentinel/asset_discovery_store.ts";
import { digestSentinelSnapshot } from "../../src/sentinel/shared_inventory.ts";
import {
  openSentinelFindingTrafficLinks,
  sentinelFindingTrafficEvidenceVersion,
} from "../../src/sentinel/finding_traffic_links.ts";
import {
  readProjectedSentinelTrafficReceipt,
  reopenProjectedSentinelTrafficPage,
} from "../../src/gateway/sentinel_traffic_tool.ts";
import { createSentinelLiveWorkflowReader } from "../../src/gateway/sentinel_live_workflow.ts";
import { routeHostRequest } from "../../src/tools/tidepool/host/host_server.ts";
import { createHash } from "node:crypto";
import type { SentinelReadTrace } from "../../src/gateway/sentinel_agent.ts";
import { sentinelExecutionEvidenceFile } from "../../src/sentinel/case_execution_evidence.ts";
import { createSentinelSubagent } from "../../src/gateway/sentinel_agent.ts";
import {
  openSentinelAdaptiveStore,
  sentinelAdaptiveTaskId,
} from "../../src/sentinel/adaptive_store.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { ingestSentinelTraffic } from "../../src/cli/commands/sentinel_traffic.ts";
import { readSentinelTrafficReceiptPage } from "../../src/sentinel/traffic_receipts.ts";
import { openSentinelWorkerFindingStore } from "../../src/sentinel/worker_finding_store.ts";
import { openOperatorRunLinkStore } from "../../src/core/operator_runs.ts";
import { AgentRecoveryStore } from "../../src/core/agent_recovery_store.ts";
import { computeContentHash } from "../../src/core/session/lineage_serde.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import {
  openExecutionTraces,
  scopedExecutionChecklistStorage,
} from "../../src/core/execution_traces.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import { withVerifiedRunArchive } from "../../src/core/run_archive.ts";
import { createTodoManager } from "../../src/tools/todo_manager.ts";
import {
  createProviderRegistry,
  listEffectiveModelProfiles,
} from "../../src/agent/llm.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import {
  type ChannelId,
  createSession,
  updateTaint,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  readAdaptiveSentinel,
  readSentinelCaseHints,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { startSentinelAssessmentCoordinator } from "../../src/gateway/sentinel_assessment_service.ts";
import {
  ensureSentinelFormalGoalContract,
  registerSentinelGoalCompletion,
  reportSentinelGoalCompletion,
} from "../../src/gateway/sentinel_goal_completion.ts";
import { createWorkflowObservationVerifier } from "../../src/gateway/scheduled_observation_tool.ts";
import { digestSentinelGoalProposal } from "../../src/sentinel/formal_goals.ts";
import { GoalCompletionStore } from "../../src/core/goal_completion.ts";
import { createOperatorWorkflowJournal } from "../../src/gateway/operator_workflow_journal.ts";
import { createOperatorWorkflowRuns } from "../../src/gateway/operator_workflow_runs.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { renderSentinelProvenanceJson } from "../../src/sentinel/assessment_export.ts";
import {
  applySentinelFormalGoals,
  readSentinelAssessment,
  readSentinelAssessmentRevision,
  readSentinelEmptyCreationDigest,
  readSentinelOperatingConstraints,
  refreshSentinelAssessment,
  resumeSentinelAssessment,
  SENTINEL_ASSESSMENT_TIMED_OUT,
  startSentinelAssessment,
  stopSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { createWorkflowRunRegistry } from "../../src/workflow/registry.ts";
import { subscribeCommittedEvidence } from "../../src/core/evidence_task_progression.ts";

const tool = "operator_runs";
const answer = "The requested operator run check finished.";
const hiddenEvidence = "internal-use-only evidence body";
const plan = {
  id: "safe-local-check",
  classification: "INTERNAL" as const,
  steps: [{ id: "wait-at-boundary", waitSeconds: 0.8 }, { id: "record" }],
};

async function until(condition: () => boolean) {
  const abort = Date.now() + 3000;
  while (!condition() && Date.now() < abort) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert(condition(), "The operator workflow did not reach its intended state");
}

type Turn = (
  args: Record<string, unknown> | string,
  message?: string,
) => Promise<{
  result: string;
  response?: string;
  error?: string;
}>;

Deno.test("owner socket controls exact Sentinel and configured workflow runs through policy", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir, "published");
  const confirmations: string[] = [];
  // Simulate a process exit after publication or installation, before the receipt commits.
  const leaveArchiveActionPending = (baseDir: string, requestId: string) => {
    const db = new DatabaseSync(
      join(baseDir, "data", "run-archives", "actions.db"),
    );
    try {
      const update = db.prepare(
        "UPDATE run_archive_actions SET status = 'pending', token = ? WHERE requestId = ? AND status = 'succeeded'",
      ).run(crypto.randomUUID(), requestId);
      assertEquals(Number(update.changes), 1);
    } finally {
      db.close();
    }
  };
  let approved = true;
  let sentinelModelAccess = true;
  let duringConfirmation: (() => void) | undefined;
  let denyArchiveTarget: string | undefined;
  const evaluated: { hook: string; taint: string; target?: unknown }[] = [];
  let denied: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | "PRE_OUTPUT" | undefined;
  let allowTracePayload = true;
  let allowRetrySource = true;
  let allowWorkflowMetadata = true;
  let workflowMetadataCalls = 0;
  const workflowMetadataRuns = [{
    id: 123,
    status: "completed",
    conclusion: "success",
  }];
  const savedWorkflowReader = createSentinelLiveWorkflowReader({
    scopes: [{
      case: "trace-search-right",
      asset: "peer-asset",
      owner: "owner",
      repo: "repo",
      workflow_id: 22,
    }],
    resolveToken: () => Promise.resolve("synthetic"),
    ssrfChecker: () => Promise.resolve({ ok: true, value: "192.0.2.1" }),
    readRuns: () => {
      throw new Error("Reopening a result must never read runs");
    },
    verifyAccess: () => {
      workflowMetadataCalls++;
      return Promise.resolve(allowWorkflowMetadata);
    },
  });
  let originalToolInvocations = 0;
  let denyTrafficHintSource = false;
  let denyTraceSource: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | undefined;
  const traceSourceChecks: string[] = [];
  const workflowPayload = {
    kind: "github_actions_status" as const,
    repo: "owner/repo",
    repositoryId: 8642,
    workflow: "22",
    runs: [{
      id: 123,
      status: "completed",
      conclusion: "success",
      created_at: "2025-01-01T00:00:00.000Z",
    }],
  };
  const exactActionsPayload = {
    kind: "github_actions_run_status",
    repo: workflowPayload.repo,
    repositoryId: workflowPayload.repositoryId,
    id: 123,
    attempt: 2,
    status: "completed",
    conclusion: "cancelled",
  } as const;
  const attemptFailure = {
    ...exactActionsPayload,
    id: 404,
    attempt: 1,
    conclusion: "failure",
  } as const;
  const attemptSuccess = {
    ...attemptFailure,
    attempt: 2,
    conclusion: "success",
  } as const;
  const otherWorkflowAttempt = {
    ...attemptSuccess,
    id: 405,
  } as const;
  const repositoryPayload = {
    kind: "github_repository_status" as const,
    repo: workflowPayload.repo,
    repositoryId: workflowPayload.repositoryId,
    visibility: "private",
  } as const;
  const publicRepositoryPayload = {
    ...repositoryPayload,
    visibility: "public",
  } as const;
  const pullPayload = {
    kind: "github_pull_status",
    repo: workflowPayload.repo,
    repositoryId: workflowPayload.repositoryId,
    number: 12,
    state: "open",
    mergeable: null,
  } as const;
  const releasePayload = {
    kind: "github_release_status",
    repo: workflowPayload.repo,
    repositoryId: workflowPayload.repositoryId,
    releases: [{
      id: 21,
      prerelease: false,
      published_at: "2025-01-01T00:00:00Z",
    }],
  } as const;
  const branchPayload = {
    kind: "github_branch_protection",
    repo: workflowPayload.repo,
    repositoryId: workflowPayload.repositoryId,
    protectedCount: 1,
    unprotectedCount: 2,
    approvedBranches: [{ name: "main", protected: true }],
  } as const;
  const runs = createWorkflowRunRegistry();
  const journalPath = join(baseDir, "operator-workflows.db");
  const workflows = createOperatorWorkflowRuns(runs, [plan], journalPath);
  const unrelated = crypto.randomUUID();
  runs.registerRun({
    runId: unrelated,
    workflowName: "unrelated",
    taint: "PUBLIC",
  });
  let activeRunId: string | undefined;
  let pausedRunId: string | undefined;

  async function withGateway(
    run: (turn: Turn) => Promise<void>,
    adapter = workflows,
    recovery?: {
      session: ReturnType<typeof createSession>;
      execute: OwnerAgentRecoveryExecutor;
    },
  ) {
    const providerRegistry = createProviderRegistry();
    let next: Record<string, unknown> | undefined;
    let serial = 0;
    let lastToolId: string | undefined;
    let result = "";
    providerRegistry.register({
      name: "operator-fixture",
      model: "fixture-default",
      supportsStreaming: false,
      complete(messages, tools) {
        assert(
          tools?.some((item) =>
            (item as { function?: { name?: string } }).function?.name === tool
          ),
        );
        const usage = { inputTokens: 1, outputTokens: 1 };
        if (next) {
          const args = next;
          next = undefined;
          lastToolId = `operator-${++serial}`;
          return Promise.resolve({
            content: "",
            usage,
            toolCalls: [{
              id: lastToolId,
              type: "function",
              function: { name: tool, arguments: JSON.stringify(args) },
            }],
          });
        }
        const frame = messages.findLast(({ role }) => role === "tool");
        assert(frame);
        result = String(frame.content);
        return Promise.resolve({ content: answer, usage, toolCalls: [] });
      },
    });
    providerRegistry.setDefault("operator-fixture");
    const primary = providerRegistry.getDefault()!;
    providerRegistry.registerClassificationOverride("INTERNAL", {
      ...primary,
      name: "internal-fixture",
      model: "fixture-internal",
    });
    providerRegistry.registerClassificationOverride("CONFIDENTIAL", {
      ...primary,
      name: "private-fixture",
      model: "fixture-private",
    });
    const hookRunner: HookRunner = {
      evaluateHook(hook, { session, input, auditInput }) {
        const runTool = input.tool_name === tool ||
          (input.tool_call as { name?: string } | undefined)?.name === tool;
        const call = input.tool_call as
          | { args?: Record<string, unknown> }
          | undefined;
        if (
          hook === "PRE_TOOL_CALL" && runTool &&
          (call?.args?.action === "finding_recheck_candidates" ||
            call?.args?.action === "case_execution_evidence" ||
            call?.args?.action === "finding_recheck_sources" ||
            call?.args?.action === "search_case_traces" ||
            call?.args?.action === "finding_groups" ||
            call?.args?.action === "finding_asset_tree" ||
            call?.args?.action === "list_trace_workers" ||
            call?.args?.action === "worker_trace_result" ||
            call?.args?.action === "archive_catalog")
        ) {
          assertEquals(input.operation_type, "read");
          assertEquals(auditInput?.operation_type, "read");
        }
        if (
          denyArchiveTarget && hook === "PRE_TOOL_CALL" && runTool &&
          (call?.args?.action === "archive" ||
            call?.args?.action === "archive_history") &&
          call.args.id === denyArchiveTarget
        ) {
          return Promise.resolve({
            allowed: false,
            action: "BLOCK",
            ruleId: null,
            duration: 0,
          });
        }
        if (
          denyTrafficHintSource && hook === "PRE_TOOL_CALL" &&
          runTool && call?.args?.action === "traffic_get"
        ) {
          return Promise.resolve({
            allowed: false,
            action: "BLOCK",
            ruleId: null,
            duration: 0,
          });
        }
        const workflowSource =
          input.tool_name === "sentinel_live_workflow_status";
        if (workflowSource && hook === "PRE_TOOL_CALL") {
          assertEquals(input.sentinel_case_id, "trace-search-right");
          assertEquals(
            input.url,
            "https://api.github.com/repos/owner/repo/actions/workflows/22",
          );
        }
        const traceSource = [
          input.tool_name,
          (input.tool_call as { name?: string } | undefined)?.name,
        ]
          .some((name) =>
            name === "github_actions" || name === "github_repos" ||
            name === "github_pulls"
          );
        const trafficSource = input.tool_name === "sentinel_traffic_get" ||
          input.tool_name === "sentinel_traffic_search" ||
          input.tool_name === "sentinel_finding_traffic_links" ||
          input.tool_name === "sentinel_attach_finding_traffic" ||
          input.tool_name === "sentinel_report_finding" ||
          input.tool_name === "sentinel_record_finding_recheck" ||
          input.tool_name === "sentinel_update_finding_report" ||
          input.tool_name === "sentinel_submit_asset_discovery";
        if (traceSource || workflowSource || trafficSource) {
          traceSourceChecks.push(hook);
          assert(!Object.hasOwn(auditInput ?? {}, "tool_response"));
          if (hook === denyTraceSource) {
            return Promise.resolve({
              allowed: false,
              action: "BLOCK",
              ruleId: null,
              duration: 0,
            });
          }
        }
        const applies = runTool || hook === "PRE_OUTPUT";
        if (applies) {
          evaluated.push({
            hook,
            taint: session.taint,
            target: input.target_classification,
          });
          if (hook === "POST_TOOL_RESPONSE") {
            assert(!Object.hasOwn(auditInput ?? {}, "tool_response"));
            if (
              typeof input.tool_response === "string" &&
              input.tool_response.startsWith("{")
            ) {
              assertEquals(
                JSON.parse(input.tool_response)._classification,
                "INTERNAL",
              );
              assertEquals(session.taint, "INTERNAL");
            }
          }
        }
        const allowed = !applies || hook !== denied;
        return Promise.resolve({
          allowed,
          action: allowed ? "ALLOW" : "BLOCK",
          ruleId: null,
          duration: 0,
        });
      },
    };
    const chatSession = createChatSession({
      session: recovery?.session ?? createSession({
        userId: "owner" as UserId,
        channelId: "test" as ChannelId,
        bumpersEnabled: false,
      }),
      recoverAgentTurn: recovery?.execute,
      providerRegistry,
      hookRunner,
      tools: [{
        name: "github_pulls",
        description: "Fixture pull request source.",
        parameters: {},
      }, {
        name: "github_repos",
        description: "Fixture repository source.",
        parameters: {},
      }, {
        name: "github_actions",
        description: "Fixture registered GitHub Actions policy source.",
        parameters: {},
      }],
      toolExecutor: () => {
        originalToolInvocations++;
        return Promise.reject(
          new Error("Recorded payload reopen must not execute GitHub."),
        );
      },
      enableStreaming: false,
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir,
        readLiveWorkflow: savedWorkflowReader,
        sentinelModelAccess,
        sentinelGatewayWorkerLimit: 3,
        workflows: adapter,
        profiles: (ceiling) =>
          listEffectiveModelProfiles(providerRegistry, ceiling),
        authorizeExecutionTracePayload: (payload, classification) => {
          assertEquals(
            payload,
            payload.kind === "github_repository_status"
              ? payload.visibility === "public"
                ? publicRepositoryPayload
                : repositoryPayload
              : payload.kind === "github_pull_status"
              ? pullPayload
              : payload.kind === "github_release_status"
              ? releasePayload
              : payload.kind === "github_branch_protection"
              ? branchPayload
              : payload.kind === "github_actions_run_status"
              ? [
                exactActionsPayload,
                attemptFailure,
                attemptSuccess,
                otherWorkflowAttempt,
              ]
                .find(({ id, attempt }) =>
                  id === payload.id && attempt === payload.attempt
                )
              : workflowPayload,
          );
          assertEquals(classification, "INTERNAL");
          return Promise.resolve(
            allowTracePayload &&
              (allowRetrySource ||
                payload.kind !== "github_actions_run_status" ||
                payload.id !== attemptSuccess.id ||
                payload.attempt !== attemptSuccess.attempt),
          );
        },
        confirm(message) {
          confirmations.push(message);
          duringConfirmation?.();
          return Promise.resolve(approved);
        },
      }),
    });
    const token = crypto.randomUUID();
    const server = createGatewayServer({ port: 0, token, chatSession });
    const { port } = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    const tidepoolState = {
      clients: new Set<WebSocket>(),
      server: null,
      currentTree: null,
      resolvedPort: 0,
      cachedHtml: null,
      sessionKey: token,
      lastMcpConnected: -1,
      lastMcpConfigured: 0,
      socketCleanupCallbacks: [],
      canvasRenders: [],
    };
    let tidepoolServer: Deno.HttpServer<Deno.NetAddr> | undefined;
    let tidepoolSocket: WebSocket | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      await run(async (args, message) => {
        if (typeof args === "string" && !tidepoolSocket) {
          tidepoolServer = Deno.serve(
            { hostname: "127.0.0.1", port: 0, onListen() {} },
            (request) => routeHostRequest(request, tidepoolState, chatSession),
          );
          tidepoolSocket = new WebSocket(
            `ws://127.0.0.1:${tidepoolServer.addr.port}/?key=${token}`,
          );
          const client = tidepoolSocket;
          await new Promise<void>((resolve, reject) => {
            client.addEventListener("open", () => resolve(), { once: true });
            client.addEventListener("error", reject, { once: true });
          });
        }
        const client = typeof args === "string" ? tidepoolSocket! : socket;
        next = typeof args === "string" ? undefined : args;
        result = "";
        const done = Promise.withResolvers<Awaited<ReturnType<Turn>>>();
        let response: string | undefined;
        let error: string | undefined;
        const timer = setTimeout(
          () => done.reject(new Error("No gateway turn_end")),
          3000,
        );
        function receive({ data }: MessageEvent) {
          const event = JSON.parse(data);
          if (
            typeof args === "string" &&
            (event.type === "response" || event.type === "error") &&
            event.sentinelRecheckCommand !== args
          ) {
            done.reject(
              new Error("Recheck response did not match its command"),
            );
          }
          if (event.type === "response") response = event.text;
          if (event.type === "error") error = event.message;
          if (event.type === "turn_end") {
            done.resolve({ result, response, error });
          }
        }
        client.addEventListener("message", receive);
        client.send(
          JSON.stringify({
            type: "message",
            content: typeof args === "string"
              ? args
              : message ?? "Use the requested operator run control.",
          }),
        );
        return done.promise.finally(() => {
          clearTimeout(timer);
          client.removeEventListener("message", receive);
        });
      });
    } finally {
      tidepoolSocket?.close();
      await tidepoolServer?.shutdown();
      socket.close();
      await server.stop();
    }
  }

  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{
          id: "private-evidence",
          kind: "evidence",
          label: hiddenEvidence,
        }],
        edges: [],
      }),
    );
    const peerPath = resolveSentinelCasePath(baseDir, "another-case");
    await Deno.mkdir(dirname(peerPath), { recursive: true });
    await Deno.writeTextFile(
      peerPath,
      JSON.stringify({
        version: 1,
        nodes: [
          {
            id: "peer-only",
            kind: "finding",
            label: "Other case finding",
            severity: "low",
          },
          {
            id: "peer-asset",
            kind: "asset",
            label: "Other case asset",
            organization: { id: "peer-ops", label: "Operations" },
          },
          {
            id: "peer-unselected",
            kind: "asset",
            label: "Outside selection",
            organization: { id: "peer-other", label: "Other team" },
          },
        ],
        edges: [{ from: "peer-only", to: "peer-asset", relation: "affects" }],
      }),
    );
    const trafficSecret = "private-fixture-token";
    await ingestSentinelTraffic(
      new Blob([
        [60_000, 90_000].map((age) =>
          JSON.stringify({
            startedDateTime: new Date(Date.now() - age).toISOString(),
            request: {
              url: `https://peer.example/private?token=${trafficSecret}`,
              method: "GET",
            },
            response: { status: 403 },
          })
        ).join("\n"),
      ]).stream(),
      "operator-fixture",
      peerPath,
    );
    const peer = {
      kind: "sentinel",
      id: "another-case",
      revision: startSentinelAssessment(peerPath).revision,
    };
    let sentinelRevision: number | undefined;
    let linkReceipt: unknown;
    let assignmentRequest: Record<string, unknown> | undefined;
    let assignmentReceipt: unknown;
    const interruptedRequest = {
      kind: "workflow",
      id: plan.id,
      requestId: crypto.randomUUID(),
    };
    const sentinel = { kind: "sentinel", id: "published" };
    const configured = {
      kind: "workflow",
      id: plan.id,
      requestId: crypto.randomUUID(),
    };
    const traceScope = {
      role: "delegated" as const,
      sessionId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
    };
    const confidentialScope = { ...traceScope, runId: crypto.randomUUID() };
    const tracesStore = openExecutionTraces(
      join(baseDir, "execution-traces.db"),
    );
    try {
      assert(tracesStore.admit(traceScope));
      assert(tracesStore.admit(confidentialScope));
      assert(tracesStore.append(traceScope, {
        ordinal: 1,
        tool: "read_file",
        classification: "INTERNAL",
        outcome: "returned",
      }));
      assert(tracesStore.append(traceScope, {
        ordinal: 2,
        tool: "github_actions",
        classification: "INTERNAL",
        outcome: "returned",
      }, workflowPayload));
      assert(tracesStore.append(confidentialScope, {
        ordinal: 1,
        tool: "hidden_tool",
        classification: "CONFIDENTIAL",
        outcome: "blocked",
      }));
    } finally {
      tracesStore.close();
    }
    await withGateway(async (turn) => {
      denied = "PRE_TOOL_CALL";
      const withoutApproval = await turn({ action: "start", ...sentinel });
      assert(withoutApproval.result);
      assertEquals(confirmations, []);
      assertEquals(readSentinelAssessment(path), undefined);
      assertEquals(
        evaluated.filter(({ hook }) => hook === "POST_TOOL_RESPONSE"),
        [],
      );
      assert((await turn({ action: "start", ...configured })).result);
      assertEquals(workflows.list(), []);
      assertEquals(confirmations, []);
      denied = undefined;
      approved = false;
      assertStringIncludes(
        (await turn({ action: "start", ...sentinel })).result,
        "operator declined",
      );
      assertEquals(readSentinelAssessment(path), undefined);
      assertEquals(confirmations.length, 1);
      approved = true;

      const profilesAction = { action: "profiles" };
      const profiles = (await turn(profilesAction)).result;
      assertEquals(JSON.parse(profiles).profiles, [
        {
          classification: "PUBLIC",
          provider: "operator-fixture",
          model: "fixture-default",
        },
        {
          classification: "INTERNAL",
          provider: "internal-fixture",
          model: "fixture-internal",
        },
      ]);
      assert(!profiles.includes("fixture-private"));
      denied = "PRE_TOOL_CALL";
      assert(!(await turn(profilesAction)).result.includes("fixture-internal"));
      denied = "POST_TOOL_RESPONSE";
      assertEquals(
        (await turn(profilesAction)).result,
        "Tool response withheld by policy.",
      );
      denied = "PRE_OUTPUT";
      const blockedProfiles = await turn(profilesAction);
      assertEquals(blockedProfiles.response, undefined);
      assert(blockedProfiles.error);
      denied = undefined;

      const started =
        JSON.parse((await turn({ action: "start", ...sentinel })).result).run;
      assertEquals(started.status, "running");
      sentinelRevision = started.ref.revision;
      assert(sentinelRevision);
      const exact = { ...sentinel, revision: sentinelRevision };
      const displayRequest = {
        action: "set_display",
        ...exact,
        runId: started.details.runId,
        requestId: crypto.randomUUID(),
        expectedVersion: 0,
        title: "Priority control review",
        pinned: true,
      };
      const displayApprovals = confirmations.length;
      denied = "PRE_TOOL_CALL";
      await turn(displayRequest);
      assertEquals(confirmations.length, displayApprovals);
      denied = undefined;
      const display = JSON.parse((await turn(displayRequest)).result);
      assertEquals(display.display.title, displayRequest.title);
      assertEquals(display.display.version, 1);
      assert(typeof display.display.pinnedAt === "string");
      assertEquals(confirmations.length, displayApprovals + 1);
      assertStringIncludes(
        (await turn({ ...displayRequest, requestId: crypto.randomUUID() }))
          .result,
        "unavailable",
      );
      assertStringIncludes(
        (await turn({ ...displayRequest, title: "Changed retry" })).result,
        "unavailable",
      );
      await withGateway(async (reconnected) => {
        const list = { action: "list", kind: "sentinel" };
        const first = JSON.parse((await reconnected(list)).result).runs[0];
        assertEquals(first.ref, started.ref);
        assertEquals(first.label, displayRequest.title);
        assertEquals(first.details.pinnedAt, display.display.pinnedAt);
        denied = "POST_TOOL_RESPONSE";
        assertEquals(
          (await reconnected(list)).result,
          "Tool response withheld by policy.",
        );
        denied = "PRE_OUTPUT";
        assertEquals((await reconnected(list)).response, undefined);
        denied = undefined;
        assertEquals(
          JSON.parse((await reconnected(displayRequest)).result),
          display,
        );
        assertEquals(confirmations.length, displayApprovals + 1);
        assertEquals(
          JSON.parse(
            (await reconnected({ action: "inspect", ...exact })).result,
          )
            .run.label,
          started.label,
        );
        const unpinned = JSON.parse(
          (await reconnected({
            ...displayRequest,
            requestId: crypto.randomUUID(),
            expectedVersion: 1,
            title: undefined,
            pinned: false,
          })).result,
        ).display;
        assertEquals(unpinned.title, displayRequest.title);
        assertEquals(unpinned.pinnedAt, undefined);
      });
      const tracesAction = {
        action: "execution_traces",
        traceRole: "delegated",
      };
      const traceRuns = JSON.parse((await turn(tracesAction)).result).page.runs;
      assertEquals(
        traceRuns.map(({ scope }: { scope: { runId: string } }) => scope.runId),
        [traceScope.runId],
      );
      const trace = JSON.parse(
        (await turn({ ...tracesAction, id: traceScope.runId, ordinal: 1 }))
          .result,
      );
      assertEquals(trace.step.tool, "read_file");
      assertEquals(trace.step.outcome, "returned");
      assertStringIncludes(
        (await turn({ ...tracesAction, id: confidentialScope.runId })).result,
        "unavailable",
      );
      assertStringIncludes(
        (await turn({
          ...tracesAction,
          traceRole: "scheduled",
          id: traceScope.runId,
        })).result,
        "unavailable",
      );

      const metadataOnly = JSON.parse(
        (await turn({ ...tracesAction, id: traceScope.runId, ordinal: 2 }))
          .result,
      );
      assertEquals(metadataOnly.step.tool, "github_actions");
      assert(!JSON.stringify(metadataOnly).includes(workflowPayload.repo));
      const search = {
        action: "execution_traces",
        query: "returned",
        limit: 1,
      };
      const firstMatch = JSON.parse((await turn(search)).result).page;
      assertEquals(firstMatch.matches.map(({ id }: { id: string }) => id), [
        metadataOnly.step.id,
      ]);
      assert(typeof firstMatch.nextCursor === "string");
      const nextMatch = JSON.parse(
        (await turn({
          ...search,
          cursor: firstMatch.nextCursor,
        })).result,
      ).page;
      assertEquals(nextMatch.matches.map(({ id }: { id: string }) => id), [
        trace.step.id,
      ]);
      assertEquals(nextMatch.nextCursor, null);
      denied = "PRE_TOOL_CALL";
      assert(!(await turn(search)).result.includes(metadataOnly.step.id));
      denied = "POST_TOOL_RESPONSE";
      assertEquals(
        (await turn(search)).result,
        "Tool response withheld by policy.",
      );
      denied = "PRE_OUTPUT";
      const blockedSearch = await turn(search);
      assertEquals(blockedSearch.response, undefined);
      assert(blockedSearch.error);
      denied = undefined;
      for (const changed of [{ query: "read" }, { traceRole: "scheduled" }]) {
        assertStringIncludes(
          (await turn({ ...search, ...changed, cursor: firstMatch.nextCursor }))
            .result,
          "unavailable",
        );
      }
      assertEquals(
        JSON.parse((await turn({ ...search, query: "hidden_tool" })).result)
          .page.matches,
        [],
      );
      assertStringIncludes(
        (await turn({
          ...tracesAction,
          id: confidentialScope.runId,
          query: "hidden_tool",
        })).result,
        "unavailable",
      );
      assert(!Object.hasOwn(metadataOnly.step, "payload"));
      const tracePage = JSON.parse(
        (await turn({ ...tracesAction, id: traceScope.runId })).result,
      );
      assertEquals(
        tracePage.page.steps.map(({ tool }: { tool: string }) => tool),
        [
          "read_file",
          "github_actions",
        ],
      );
      assert(!JSON.stringify(tracePage).includes(workflowPayload.repo));
      const payloadAction = {
        action: "execution_trace_payload",
        traceRole: "delegated",
        id: traceScope.runId,
        ordinal: 2,
      };
      const reopenedTrace = JSON.parse((await turn(payloadAction)).result);
      assertEquals(reopenedTrace.payload, workflowPayload);
      assertEquals(traceSourceChecks, ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"]);
      const payloadSearch = {
        action: "execution_trace_payload",
        traceRole: "delegated",
        id: traceScope.runId,
        query: workflowPayload.repo,
      };
      const matchingPayload = JSON.parse((await turn(payloadSearch)).result);
      assertEquals(
        matchingPayload.page.matches.map(({ id }: { id: string }) => id),
        [
          reopenedTrace.step.id,
        ],
      );
      assert(!JSON.stringify(matchingPayload).includes(workflowPayload.repo));
      assertEquals(
        JSON.parse(
          (await turn({
            ...payloadSearch,
            query: "irrelevant-result",
          })).result,
        ).page.matches,
        [],
      );
      allowTracePayload = false;
      assertStringIncludes((await turn(payloadAction)).result, "unavailable");
      assertEquals(
        JSON.parse((await turn(payloadSearch)).result).page.matches,
        [],
      );
      allowTracePayload = true;
      for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"] as const) {
        denyTraceSource = hook;
        const result = (await turn(payloadAction)).result;
        assertStringIncludes(result, "unavailable");
        assert(!result.includes(workflowPayload.repo));
        assertEquals(
          JSON.parse((await turn(payloadSearch)).result).page.matches,
          [],
        );
      }
      denyTraceSource = undefined;
      assertStringIncludes(
        (await turn({ ...payloadAction, traceRole: "scheduled" })).result,
        "unavailable",
      );
      assertStringIncludes(
        (await turn({ ...payloadAction, ordinal: 1 })).result,
        "unavailable",
      );
      assertEquals(originalToolInvocations, 0);

      const inspection = await turn({ action: "inspect", ...exact });
      assertEquals(JSON.parse(inspection.result).run.ref, exact);
      assert(!inspection.result.includes(hiddenEvidence));
      assert(!inspection.result.includes("private-evidence"));
      const graph = JSON.parse(
        (await turn({ action: "graph", ...exact, query: "private-evidence" }))
          .result,
      );
      assertEquals(graph.run, exact);
      assertEquals(graph.page.revision, sentinelRevision);
      assertEquals(graph.page.nodes.map(({ id }: { id: string }) => id), [
        "evidence:private-evidence",
      ]);
      const node = JSON.parse(
        (await turn({
          action: "node",
          ...exact,
          node: "evidence:private-evidence",
        })).result,
      );
      assertEquals(node.page.node.id, "evidence:private-evidence");
      assertStringIncludes(
        (await turn({
          action: "node",
          ...peer,
          node: "evidence:private-evidence",
        })).result,
        "unavailable",
      );
      const peerFindings = JSON.parse(
        (await turn({
          action: "findings",
          ...peer,
          query: "peer-only",
        })).result,
      );
      assertEquals(
        peerFindings.page.nodes.map(({ id }: { id: string }) => id),
        ["finding:peer-only"],
      );
      const traffic = readSentinelTrafficReceiptPage(peerPath, peer.revision)
        ?.receipts[0];
      assert(traffic);
      const trafficHint = {
        action: "hint",
        ...peer,
        requestId: crypto.randomUUID(),
        note: "Review the recorded response on this asset.",
        assetIds: [traffic.assetIds[0]],
        trafficReference: {
          evidenceId: traffic.evidenceId,
          digest: traffic.digest,
        },
      };
      const trafficApprovals = confirmations.length;
      assertStringIncludes(
        (await turn({
          ...trafficHint,
          trafficReference: {
            ...trafficHint.trafficReference,
            digest: "0".repeat(64),
          },
        })).result,
        "unavailable",
      );
      assertStringIncludes(
        (await turn({ ...trafficHint, assetIds: ["peer-asset"] })).result,
        "unavailable",
      );
      assertStringIncludes(
        (await turn({ ...trafficHint, revision: peer.revision + 1 })).result,
        "unavailable",
      );
      denyTrafficHintSource = true;
      assertStringIncludes((await turn(trafficHint)).result, "unavailable");
      denyTrafficHintSource = false;
      assertEquals(confirmations.length, trafficApprovals);
      const trafficHintResult = (await turn(trafficHint)).result;
      assert(
        !trafficHintResult.startsWith("Error:"),
        JSON.stringify({
          trafficHintResult,
          approvals: confirmations.length - trafficApprovals,
        }),
      );
      assertEquals(JSON.parse(trafficHintResult).run.ref, peer);
      assertEquals(JSON.parse((await turn(trafficHint)).result).run.ref, peer);
      assertEquals(confirmations.length, trafficApprovals + 1);
      const [trafficHintReceipt] = readSentinelCaseHints(peerPath, 10);
      assertEquals(
        trafficHintReceipt.trafficReference,
        trafficHint.trafficReference,
      );
      let plannerHints: unknown;
      let planClock = 100_000;
      let caseWidePlannerHints: unknown;
      const trafficPlanner = createSentinelModelPlanner(
        peerPath,
        (_state, taskId) => ({
          execute(message, send) {
            if (!taskId) {
              assert(typeof message === "string");
              assert(!message.includes(trafficSecret));
              const input = JSON.parse(message.split("\n").at(-1)!);
              plannerHints = input.operatorAssetHints;
              caseWidePlannerHints = input.operatorHints;
            }
            send({
              type: "response",
              text: '{"assignments":[],"prioritize":[]}',
              taint: "INTERNAL",
            });
            return Promise.resolve();
          },
          clear() {},
        }),
        undefined,
        () => planClock,
      );
      try {
        trafficPlanner.advance(readSentinelAssessment(peerPath)!);
        await until(() => plannerHints !== undefined);
        assertEquals(plannerHints, [{
          id: trafficHintReceipt.id,
          text: trafficHint.note,
          assetIds: trafficHint.assetIds,
          trafficReference: trafficHint.trafficReference,
        }]);
        await until(() => !trafficPlanner.hasInFlightWork());
        planClock += 61_000;
        const runId = readSentinelAssessment(peerPath)?.plan.runId;
        assert(runId);
        const group = {
          action: "hint_batch",
          ...peer,
          runId,
          requestId: crypto.randomUUID(),
          hints: [
            { note: "Use the published review checklist." },
            {
              note: "Compare the selected saved transaction.",
              assetIds: trafficHint.assetIds,
              trafficReference: trafficHint.trafficReference,
            },
          ],
        };
        const notifications: string[] = [];
        const unsubscribe = subscribeCommittedEvidence(peer.id, (event) => {
          if (event.run_id !== runId || event.revision !== peer.revision) {
            return;
          }
          notifications.push(event.observation_id);
          trafficPlanner.advance(readSentinelAssessment(peerPath)!);
        });
        try {
          const beforeBatch = confirmations.length;
          denied = "PRE_TOOL_CALL";
          await turn(group);
          denied = undefined;
          denyTrafficHintSource = true;
          assertStringIncludes((await turn(group)).result, "unavailable");
          denyTrafficHintSource = false;
          assertStringIncludes(
            (await turn({
              ...group,
              hints: [group.hints[0], {
                note: "Outside the case",
                assetIds: ["foreign-asset"],
              }],
            })).result,
            "unavailable",
          );
          assertEquals(confirmations.length, beforeBatch);
          approved = false;
          assertStringIncludes((await turn(group)).result, "operator declined");
          approved = true;
          assertEquals(readSentinelCaseHints(peerPath, 10), [
            trafficHintReceipt,
          ]);
          assertEquals(notifications, []);
          const committed = JSON.parse((await turn(group)).result).receipt;
          assertEquals(committed.requestId, group.requestId);
          assertEquals(committed.hintIds.length, 2);
          const [savedTraffic, savedCaseWide] = readSentinelCaseHints(
            peerPath,
            10,
          );
          assertEquals([savedCaseWide.id, savedTraffic.id], committed.hintIds);
          assertEquals(savedCaseWide.text, group.hints[0].note);
          assertEquals(
            savedTraffic.trafficReference,
            trafficHint.trafficReference,
          );
          await until(() =>
            Array.isArray(caseWidePlannerHints) &&
            caseWidePlannerHints.includes(group.hints[0].note)
          );
          assertEquals(
            (plannerHints as { id: number }[])[0].id,
            savedTraffic.id,
          );
          await withGateway(async (reopenTurn) => {
            assertEquals(
              JSON.parse((await reopenTurn(group)).result).receipt,
              committed,
            );
            assertStringIncludes(
              (await reopenTurn({
                ...group,
                hints: [...group.hints].reverse(),
              })).result,
              "unavailable",
            );
          });
          assertEquals(confirmations.length, beforeBatch + 2);
          assertEquals(notifications, [
            `operator-hint-batch:${group.requestId}`,
          ]);
        } finally {
          unsubscribe();
        }
      } finally {
        trafficPlanner.stop();
      }
      let reportTime = Date.now();
      const journal = openSentinelWorkerFindingStore(
        peerPath,
        () => reportTime++,
      );
      const { original, later } = (() => {
        try {
          const original = journal.recordFinding({
            caseId: peer.id,
            runId: readSentinelAssessment(peerPath)!.plan.runId!,
            evidenceRevision: peer.revision,
            taskId: "fixture-assigned-review",
            targetId: traffic.assetIds[0],
            graphFindingId: "peer-only",
            controlId: "fixture-control",
            evidenceId: "fixture-evidence",
            snapshotDigest: "a".repeat(64),
            evaluatedAt: "2026-01-02T00:00:00.000Z",
            observedAt: "2026-01-01T00:00:00.000Z",
            validUntil: "2026-02-01T00:00:00.000Z",
            requestId: crypto.randomUUID(),
            title: "Worker finding",
            summary: "Read-only scoped evidence",
          });
          const later = journal.recordFinding({
            ...original,
            title: "Second worker finding",
            requestId: crypto.randomUUID(),
          });
          return { original, later };
        } finally {
          journal.close();
        }
      })();
      const grouped = { action: "finding_groups", scopes: [exact, peer] };
      const findingGroups = JSON.parse((await turn(grouped)).result);
      assertEquals(findingGroups.findingTotal, 3);
      assertEquals(
        findingGroups.groups.map(
          (
            { total, imported, worker, nextOffset }: Record<string, number>,
          ) => [total, imported, worker, nextOffset],
        ),
        [[0, 0, 0, null], [3, 1, 2, 1]],
      );
      assertEquals(findingGroups.groups[1].entries[0].id, "peer-only");
      assertEquals(findingGroups.groups[1].revision, peer.revision);
      const faceted = { ...grouped, includeFacets: true };
      const facetedGroups = JSON.parse((await turn(faceted)).result).groups;
      assertEquals(facetedGroups[1].facets.total, 3);
      assertEquals(facetedGroups[1].facets.disposition.open, 3);
      assertEquals(facetedGroups[1].facets.severity.unknown, 2);
      assertEquals(facetedGroups[1].facets.categories, []);
      const { facets: _facets, ...plainGroup } = facetedGroups[1];
      assertEquals(plainGroup, findingGroups.groups[1]);
      const filteredRequest = {
        ...faceted,
        findingFilter: { kind: "worker", query: "  WORKER finding  " },
      };
      const scopedFiltered = JSON.parse((await turn(filteredRequest)).result);
      assertEquals(scopedFiltered.findingTotal, 2);
      assertEquals(scopedFiltered.groups[1].entries[0].id, original.id);
      assertEquals(scopedFiltered.groups[1].nextOffset, 1);
      assertEquals(scopedFiltered.groups[1].facets.total, 2);
      assertEquals(scopedFiltered.groups[1].facets.severity.unknown, 2);
      const secondFiltered = JSON.parse(
        (await turn({
          ...filteredRequest,
          scopes: [{ ...peer, offset: 1 }],
        })).result,
      ).groups[0];
      assertEquals(secondFiltered.entries[0].id, later.id);
      assertEquals(secondFiltered.facets.total, 2);
      assertEquals(secondFiltered.nextOffset, null);
      const orderedRequest = { ...filteredRequest, findingOrder: "time" };
      const orderedFindings = JSON.parse((await turn(orderedRequest)).result);
      assertEquals(
        orderedFindings.groups.map(({ caseId }: { caseId: string }) => caseId),
        [peer.id, exact.id],
      );
      assertEquals(orderedFindings.groups[0].entries[0].id, later.id);
      assertEquals(orderedFindings.groups[0].latestFoundAt, later.recordedAt);
      assertEquals(orderedFindings.groups[0].facets.total, 2);
      const nextOrdered = JSON.parse(
        (await turn({
          ...orderedRequest,
          scopes: [{ ...peer, offset: 1 }],
        })).result,
      ).groups[0];
      assertEquals(nextOrdered.entries[0].id, original.id);
      assertEquals(nextOrdered.nextOffset, null);
      const literal = JSON.parse(
        (await turn({
          ...filteredRequest,
          findingFilter: { query: "%Worker" },
        })).result,
      );
      assertEquals(literal.findingTotal, 0);
      assertStringIncludes(
        (await turn({
          ...filteredRequest,
          findingFilter: { unsupported: true },
        })).result,
        "unavailable",
      );
      denied = "PRE_TOOL_CALL";
      const hiddenFacets = await turn(faceted);
      assert(!hiddenFacets.result.includes('"facets"'));
      denied = undefined;
      const followGroup = {
        ...grouped,
        scopes: [{ ...peer, offset: 1 }],
        limit: 2,
      };
      await withGateway(async (reconnected) => {
        const { findingTotal, groups } = JSON.parse(
          (await reconnected(followGroup)).result,
        );
        assertEquals(findingTotal, 3);
        assertEquals(groups.length, 1);
        assertEquals(groups[0].runId, original.runId);
        assertEquals(groups[0].entries.map(({ id }: { id: string }) => id), [
          original.id,
          later.id,
        ]);
        assertEquals(groups[0].entries[0].taskId, original.taskId);
        assertEquals(groups[0].nextOffset, null);
      });
      for (
        const invalid of [
          { ...grouped, scopes: [] },
          { ...grouped, scopes: [peer, peer] },
          { ...grouped, scopes: [peer, { ...exact, revision: 9_999 }] },
          { ...grouped, scopes: [peer, { id: "unknown-case", revision: 1 }] },
        ]
      ) {
        const { result } = await turn(invalid);
        assertStringIncludes(result, "unavailable");
        assert(!result.includes("peer-only"));
      }
      denied = "PRE_TOOL_CALL";
      assert(!(await turn(grouped)).result.includes("peer-only"));
      denied = "POST_TOOL_RESPONSE";
      assertEquals(
        (await turn(grouped)).result,
        "Tool response withheld by policy.",
      );
      denied = "PRE_OUTPUT";
      assertEquals((await turn(grouped)).response, undefined);
      denied = undefined;
      const workerTree = JSON.parse(
        (await turn({
          action: "finding_asset_tree",
          ...peer,
          findingIds: [original.id],
        })).result,
      ).tree;
      assertEquals(workerTree.findingTotal, 1);
      assert(
        workerTree.nodes.some((
          { id, direct }: { id: string; direct: number },
        ) => id === original.targetId && direct === 1),
      );
      const treeCase = "finding-hierarchy";
      const treePath = resolveSentinelCasePath(baseDir, treeCase);
      await Deno.mkdir(dirname(treePath), { recursive: true });
      await Deno.writeTextFile(
        treePath,
        JSON.stringify({
          version: 1,
          nodes: [
            {
              id: "root",
              kind: "asset",
              label: "Authorized root",
              assetType: "root_domain",
            },
            {
              id: "service",
              kind: "asset",
              label: "Authorized service",
              assetType: "service",
              parentId: "root",
            },
            ...["application-a", "application-b", "private-parent"].map((
              id,
            ) => ({
              id,
              kind: "asset",
              label: id,
              assetType: "application",
              parentId: "service",
            })),
            {
              id: "endpoint",
              kind: "asset",
              label: "Detached by scope",
              assetType: "endpoint",
              parentId: "private-parent",
            },
            {
              id: "selected-finding",
              kind: "finding",
              label: "Shared failure",
              severity: "high",
            },
            {
              id: "outside-finding",
              kind: "finding",
              label: "Excluded failure",
              severity: "high",
            },
          ],
          edges: [
            "application-a",
            "application-b",
            "endpoint",
            "private-parent",
          ].map((to) => ({
            from: "selected-finding",
            to,
            relation: "affects",
          })).concat([{
            from: "outside-finding",
            to: "private-parent",
            relation: "affects",
          }]),
        }),
      );
      const treeAssessment = startSentinelAssessment(treePath);
      const treeRun = {
        kind: "sentinel",
        id: treeCase,
        revision: treeAssessment.revision,
      };
      const chooseTree = {
        action: "finding_asset_tree",
        ...treeRun,
        findingIds: ["selected-finding"],
      };
      const treeGrant = {
        action: "set_case_membership",
        ...treeRun,
        runId: treeAssessment.plan.runId,
        allowedAssetIds: [
          "root",
          "service",
          "application-a",
          "application-b",
          "endpoint",
        ],
        expectedVersion: 0,
        requestId: crypto.randomUUID(),
      };
      assertEquals(JSON.parse((await turn(treeGrant)).result).version, 1);
      const groupedTree = JSON.parse((await turn(chooseTree)).result).tree;
      assertEquals(groupedTree.findingTotal, 1);
      assertEquals(groupedTree.nodes.map(({ id }: { id: string }) => id), [
        "application-a",
        "application-b",
        "endpoint",
        "root",
        "service",
      ]);
      assertEquals(groupedTree.nodes[0].parentId, "service");
      assertEquals(groupedTree.nodes[1].parentId, "service");
      assertEquals(groupedTree.nodes[2].parentId, undefined);
      assertEquals(groupedTree.nodes[3].aggregate, 1);
      assertEquals(groupedTree.nodes[4].aggregate, 1);
      assertEquals(groupedTree.nodes[4].direct, 0);
      assert(!JSON.stringify(groupedTree).includes("private-parent"));
      for (
        const findingIds of [["outside-finding"], [
          "selected-finding",
          "unknown-finding",
        ]]
      ) {
        const rejected = (await turn({ ...chooseTree, findingIds })).result;
        assertStringIncludes(rejected, "unavailable");
        assert(!rejected.includes("application-a"));
      }
      denied = "PRE_TOOL_CALL";
      assert(!(await turn(chooseTree)).result.includes("application-a"));
      denied = "POST_TOOL_RESPONSE";
      assertEquals(
        (await turn(chooseTree)).result,
        "Tool response withheld by policy.",
      );
      denied = "PRE_OUTPUT";
      assertEquals((await turn(chooseTree)).response, undefined);
      denied = undefined;
      await withGateway(async (reconnected) => {
        assertEquals(
          JSON.parse((await reconnected(chooseTree)).result).tree,
          groupedTree,
        );
        assertEquals(
          JSON.parse(
            (await reconnected({
              ...treeGrant,
              allowedAssetIds: [
                "root",
                "application-a",
                "application-b",
                "endpoint",
              ],
              requestId: crypto.randomUUID(),
              expectedVersion: 1,
            })).result,
          ).version,
          2,
        );
        const tightened =
          JSON.parse((await reconnected(chooseTree)).result).tree;
        assertEquals(tightened.nodes.map(({ id }: { id: string }) => id), [
          "application-a",
          "application-b",
          "endpoint",
        ]);
        assert(
          tightened.nodes.every(({ parentId }: { parentId?: string }) =>
            parentId === undefined
          ),
        );
      });
      const savedRatingSnapshot = treeAssessment.result?.sharedGraph.snapshot;
      assert(savedRatingSnapshot);
      const ratingJournal = openSentinelWorkerFindingStore(treePath);
      const seedRating = (targetId: string) =>
        ratingJournal.recordFinding({
          ...original,
          caseId: treeCase,
          runId: treeAssessment.plan.runId!,
          evidenceRevision: treeAssessment.revision,
          targetId,
          snapshotDigest: digestSentinelSnapshot(savedRatingSnapshot),
          requestId: crypto.randomUUID(),
        });
      const ratedFinding = seedRating("application-a");
      const unratedOutside = seedRating("private-parent");
      ratingJournal.close();
      const savedTreeGraph = JSON.parse(await Deno.readTextFile(treePath));
      savedTreeGraph.nodes.push({
        id: "additional-evidence",
        kind: "evidence",
        label: "Next retained revision",
      });
      await Deno.writeTextFile(treePath, JSON.stringify(savedTreeGraph));
      const afterRatingRefresh = refreshSentinelAssessment(treePath);
      assert(
        afterRatingRefresh &&
          afterRatingRefresh.revision > treeAssessment.revision,
      );
      const correction = {
        action: "amend_finding_report",
        ...treeRun,
        revision: afterRatingRefresh.revision,
        receiptId: ratedFinding.id,
        reportVersion: 1,
        evidenceVersion: sentinelFindingTrafficEvidenceVersion(
          treePath,
          afterRatingRefresh.revision,
          ratedFinding.id,
        ).digest,
        severity: "high",
        findingCategory: "  Access control  ",
        disposition: "confirmed",
        requestId: crypto.randomUUID(),
      };
      const beforeRating = confirmations.length;
      denied = "PRE_TOOL_CALL";
      await turn(correction);
      assertEquals(confirmations.length, beforeRating);
      denied = undefined;
      for (
        const change of [
          {
            ...correction,
            receiptId: unratedOutside.id,
            evidenceVersion: sentinelFindingTrafficEvidenceVersion(
              treePath,
              afterRatingRefresh.revision,
              unratedOutside.id,
            ).digest,
          },
          { ...correction, revision: treeAssessment.revision },
          { ...correction, evidenceVersion: "a".repeat(64) },
          { ...correction, severity: "unrated" },
          { ...correction, disposition: "invented" },
          {
            ...correction,
            severity: undefined,
            findingCategory: "Invalid\ncategory",
          },
        ]
      ) {
        assertStringIncludes((await turn(change)).result, "unavailable");
      }
      assertEquals(confirmations.length, beforeRating);
      const rated = JSON.parse((await turn(correction)).result).amendment;
      assertEquals(rated.severity, "high");
      assertEquals(rated.findingCategory, "Access control");
      assertEquals(rated.disposition, "confirmed");
      assertStringIncludes(confirmations.at(-1)!, "unreviewed → confirmed");
      assertEquals(rated.title, ratedFinding.title);
      assertEquals(rated.summary, ratedFinding.summary);
      assertStringIncludes(confirmations.at(-1)!, "unrated → high");
      assertStringIncludes(confirmations.at(-1)!, '(none) → "Access control"');
      assertEquals(confirmations.length, beforeRating + 1);
      const reportRead = {
        action: "finding_report",
        ...treeRun,
        revision: afterRatingRefresh.revision,
        receiptId: ratedFinding.id,
      };
      await withGateway(async (reconnected) => {
        assertEquals(
          JSON.parse((await reconnected(correction)).result).amendment,
          rated,
        );
        assertEquals(confirmations.length, beforeRating + 1);
        assertStringIncludes(
          (await reconnected({ ...correction, requestId: crypto.randomUUID() }))
            .result,
          "unavailable",
        );
        const current =
          JSON.parse((await reconnected(reportRead)).result).report;
        assertEquals(current.severity, "high");
        assertEquals(current.findingCategory, "Access control");
        assertEquals(current.disposition, "confirmed");
        assertEquals(current.sourceReceiptId, rated.id);
        const originalVersion = JSON.parse(
          (await reconnected({ ...reportRead, reportVersion: 1 })).result,
        ).report;
        assertEquals(originalVersion.severity, undefined);
        assertEquals(originalVersion.findingCategory, undefined);
        assertEquals(originalVersion.disposition, undefined);
        assertEquals(originalVersion.sourceReceiptId, ratedFinding.id);
        const old = JSON.parse(
          (await reconnected({
            ...reportRead,
            revision: treeAssessment.revision,
          })).result,
        ).report;
        assertEquals(old.sourceReceiptId, ratedFinding.id);
        assertEquals(old.severity, undefined);
        assertEquals(old.findingCategory, undefined);
        assertEquals(old.disposition, undefined);
        const clearCategory = {
          ...correction,
          severity: undefined,
          findingCategory: "",
          disposition: undefined,
          reportVersion: 2,
          requestId: crypto.randomUUID(),
        };
        const cleared =
          JSON.parse((await reconnected(clearCategory)).result).amendment;
        assertEquals(cleared.findingCategory, "");
        const uncategorized =
          JSON.parse((await reconnected(reportRead)).result).report;
        assertEquals(uncategorized.findingCategory, undefined);
        assertEquals(uncategorized.severity, "high");
        assertEquals(uncategorized.disposition, "confirmed");
        const archivedCategory = JSON.parse(
          (await reconnected({ ...reportRead, reportVersion: 2 })).result,
        ).report;
        assertEquals(archivedCategory.findingCategory, "Access control");
        assertEquals(archivedCategory.sourceReceiptId, rated.id);
        const beforeTriage = readSentinelAssessment(treePath);
        const triage = {
          ...correction,
          severity: undefined,
          findingCategory: undefined,
          disposition: "resolved",
          reportVersion: 3,
          requestId: crypto.randomUUID(),
        };
        const resolution =
          JSON.parse((await reconnected(triage)).result).amendment;
        assertEquals(resolution.disposition, "resolved");
        assertEquals(resolution.version, 4);
        assertEquals(readSentinelAssessment(treePath), beforeTriage);
        const history = JSON.parse(
          (await reconnected({
            ...reportRead,
            action: "finding_report_history",
          })).result,
        ).page;
        assertEquals(
          history.versions.map(({ disposition }: { disposition?: string }) =>
            disposition
          ),
          ["resolved", undefined, "confirmed", undefined],
        );
        assertEquals(
          JSON.parse((await reconnected(triage)).result).amendment,
          resolution,
        );
        denied = "POST_TOOL_RESPONSE";
        assertEquals(
          (await reconnected(reportRead)).result,
          "Tool response withheld by policy.",
        );
        denied = "PRE_OUTPUT";
        assertEquals((await reconnected(reportRead)).response, undefined);
        denied = undefined;
      });
      assert(stopSentinelAssessment(treePath));
      await Deno.remove(dirname(treePath), { recursive: true });
      const receiptAction = {
        action: "finding_receipt",
        ...peer,
        receiptId: original.id,
      };
      const listReceipts = { action: "finding_receipts", ...peer, limit: 1 };
      const firstReceiptPage = JSON.parse((await turn(listReceipts)).result);
      assertEquals(firstReceiptPage.run, peer);
      assertEquals(
        firstReceiptPage.page.records.map(({ id }: { id: string }) => id),
        [later.id],
      );
      assertEquals(firstReceiptPage.page.nextCursor, later.id);
      const continuation = { ...listReceipts, cursor: later.id };
      const secondReceiptPage = JSON.parse((await turn(continuation)).result);
      assertEquals(
        secondReceiptPage.page.records.map(({ id }: { id: string }) => id),
        [original.id],
      );
      assertEquals(secondReceiptPage.page.nextCursor, null);
      assertStringIncludes(
        (await turn({ ...continuation, ...exact })).result,
        "unavailable",
      );
      denied = "POST_TOOL_RESPONSE";
      assertEquals(
        (await turn(listReceipts)).result,
        "Tool response withheld by policy.",
      );
      denied = undefined;
      const opened = JSON.parse((await turn(receiptAction)).result);
      assertEquals(opened.run, peer);
      assertEquals(opened.record, original);
      assertStringIncludes(
        (await turn({ ...receiptAction, ...exact })).result,
        "unavailable",
      );
      denied = "PRE_TOOL_CALL";
      assert(!(await turn(receiptAction)).result.includes(original.id));
      denied = "POST_TOOL_RESPONSE";
      assertEquals(
        (await turn(receiptAction)).result,
        "Tool response withheld by policy.",
      );
      denied = "PRE_OUTPUT";
      const blockedReceipt = await turn(receiptAction);
      assertEquals(blockedReceipt.response, undefined);
      assert(blockedReceipt.error);
      denied = undefined;
      const candidates = {
        ...receiptAction,
        action: "finding_traffic_candidates",
        limit: 1,
      };
      const discovery = (await turn(candidates)).result;
      const candidatePage = JSON.parse(discovery).page;
      const [candidate] = candidatePage.receipts;
      assertEquals(candidate.evidenceId, traffic.evidenceId);
      assertEquals(candidate.assetIds, [original.targetId]);
      assert(!discovery.includes(trafficSecret));
      assert(!discovery.includes("/private"));
      assert(candidatePage.nextCursor);
      const nextCandidates = {
        ...candidates,
        cursor: candidatePage.nextCursor,
      };
      const nextCandidatePage =
        JSON.parse((await turn(nextCandidates)).result).page;
      assertEquals(nextCandidatePage.receipts.length, 1);
      assert(nextCandidatePage.receipts[0].evidenceId !== candidate.evidenceId);
      assertEquals(nextCandidatePage.nextCursor, null);
      assertStringIncludes(
        (await turn({ ...nextCandidates, status: 200 })).result,
        "unavailable",
      );
      assertStringIncludes(
        (await turn({ ...candidates, ...exact })).result,
        "unavailable",
      );
      denied = "POST_TOOL_RESPONSE";
      assertEquals(
        (await turn(candidates)).result,
        "Tool response withheld by policy.",
      );
      denied = undefined;
      const attachTraffic = {
        ...receiptAction,
        action: "attach_finding_traffic",
        reportVersion: 1,
        evidenceId: candidate.evidenceId,
        digest: candidate.digest,
        evidenceRole: "baseline",
        evidenceNote: "Retained comparison before remediation.",
        requestId: crypto.randomUUID(),
      };
      const beforeTraffic = confirmations.length;
      denied = "PRE_TOOL_CALL";
      assert(!(await turn(attachTraffic)).result.includes(traffic.digest));
      assertEquals(confirmations.length, beforeTraffic);
      denied = undefined;
      approved = false;
      assertStringIncludes((await turn(attachTraffic)).result, "declined");
      approved = true;
      assertEquals(
        JSON.parse(
          (await turn({
            ...receiptAction,
            action: "finding_traffic",
          })).result,
        ).page.links,
        [],
      );
      const trafficLink = JSON.parse((await turn(attachTraffic)).result).link;
      assertEquals(trafficLink.authority, { kind: "operator" });
      assertEquals(trafficLink.evidenceRole, "baseline");
      assertEquals(trafficLink.evidenceNote, attachTraffic.evidenceNote);
      assertStringIncludes(confirmations.at(-1)!, attachTraffic.evidenceNote);
      assertEquals(
        JSON.parse((await turn(attachTraffic)).result).link,
        trafficLink,
      );
      const trafficAction = { ...receiptAction, action: "finding_traffic" };
      const batchFindingJournal = openSentinelWorkerFindingStore(peerPath);
      const batchFinding = batchFindingJournal.recordFinding({
        ...original,
        title: "Atomic retained traffic batch",
        requestId: crypto.randomUUID(),
      });
      batchFindingJournal.close();
      const batchTraffic = {
        ...trafficAction,
        action: "attach_finding_traffic_batch",
        receiptId: batchFinding.id,
        reportVersion: 1,
        requestId: crypto.randomUUID(),
        trafficRefs: [
          {
            evidenceId: candidate.evidenceId,
            digest: candidate.digest,
            evidenceRole: "proof",
            evidenceNote: "First retained result.",
          },
          {
            evidenceId: nextCandidatePage.receipts[0].evidenceId,
            digest: nextCandidatePage.receipts[0].digest,
            evidenceRole: "supporting",
            evidenceNote: "Second retained result.",
          },
        ],
      };
      const batchRead = { ...trafficAction, receiptId: batchFinding.id };
      const batchApprovals = confirmations.length;
      denied = "PRE_TOOL_CALL";
      await turn(batchTraffic);
      denied = undefined;
      for (
        const rejected of [
          { ...batchTraffic, ...exact },
          { ...batchTraffic, reportVersion: 2 },
          {
            ...batchTraffic,
            trafficRefs: [
              batchTraffic.trafficRefs[0],
              { ...batchTraffic.trafficRefs[1], digest: "a".repeat(64) },
            ],
          },
        ]
      ) assertStringIncludes((await turn(rejected)).result, "unavailable");
      assertEquals(confirmations.length, batchApprovals);
      assertEquals(JSON.parse((await turn(batchRead)).result).page.links, []);
      const savedBatch = JSON.parse((await turn(batchTraffic)).result).links;
      assertEquals(
        savedBatch.map(({ trafficId }: { trafficId: string }) => trafficId),
        batchTraffic.trafficRefs.map(({ evidenceId }) => evidenceId),
      );
      assertEquals(
        savedBatch.map(({ evidenceNote }: { evidenceNote: string }) =>
          evidenceNote
        ),
        batchTraffic.trafficRefs.map(({ evidenceNote }) => evidenceNote),
      );
      assertEquals(confirmations.length, batchApprovals + 1);
      await withGateway(async (reconnected) => {
        assertEquals(
          JSON.parse((await reconnected(batchTraffic)).result).links,
          savedBatch,
        );
        const changedRefs = batchTraffic.trafficRefs.map((ref) => ({
          ...ref,
          evidenceNote: "Do not overwrite a retained note.",
        }));
        assertStringIncludes(
          (await reconnected({ ...batchTraffic, trafficRefs: changedRefs }))
            .result,
          "unavailable",
        );
        assertEquals(confirmations.length, batchApprovals + 1);
        const distinctRequest = JSON.parse(
          (await reconnected({
            ...batchTraffic,
            requestId: crypto.randomUUID(),
            trafficRefs: changedRefs,
          })).result,
        ).links;
        assertEquals(distinctRequest, savedBatch);
        const retained = JSON.parse((await reconnected(batchRead)).result).page;
        assertEquals(retained.links.map(({ id }: { id: string }) => id), [
          savedBatch[1].id,
          savedBatch[0].id,
        ]);
        denied = "POST_TOOL_RESPONSE";
        assertEquals(
          (await reconnected(batchTraffic)).result,
          "Tool response withheld by policy.",
        );
        denied = "PRE_OUTPUT";
        assertEquals((await reconnected(batchTraffic)).response, undefined);
        denied = undefined;
        assertEquals(confirmations.length, batchApprovals + 2);
      });
      assertEquals(JSON.parse((await turn(trafficAction)).result).page.links, [
        trafficLink,
      ]);
      const followLink = { ...trafficAction, trafficLinkId: trafficLink.id };
      const openingVersion =
        JSON.parse((await turn(trafficAction)).result).page.evidenceVersion;
      const annotateTraffic = {
        ...followLink,
        action: "annotate_finding_traffic",
        evidenceVersion: openingVersion,
        reportVersion: 1,
        evidenceRole: "supporting",
        evidenceNote: "Reclassified this retained comparison.",
        requestId: crypto.randomUUID(),
      };
      const beforeAnnotation = confirmations.length;
      denied = "PRE_TOOL_CALL";
      await turn(annotateTraffic);
      assertEquals(confirmations.length, beforeAnnotation);
      denied = undefined;
      assertStringIncludes(
        (await turn({ ...annotateTraffic, ...exact })).result,
        "unavailable",
      );
      const annotated =
        JSON.parse((await turn(annotateTraffic)).result).amendment;
      assertEquals(annotated.evidenceRole, "supporting");
      assertEquals(annotated.evidenceNote, annotateTraffic.evidenceNote);
      assertEquals(annotated.evidenceVersion, openingVersion);
      assertEquals(confirmations.length, beforeAnnotation + 1);
      await withGateway(async (reconnected) => {
        assertEquals(
          JSON.parse((await reconnected(annotateTraffic)).result).amendment,
          annotated,
        );
        assertEquals(confirmations.length, beforeAnnotation + 1);
        assertStringIncludes(
          (await reconnected({
            ...annotateTraffic,
            requestId: crypto.randomUUID(),
          })).result,
          "unavailable",
        );
        const updated =
          JSON.parse((await reconnected(trafficAction)).result).page;
        assertEquals(updated.links, [trafficLink]);
        assertEquals(updated.annotations, [annotated]);
        assert(updated.evidenceVersion !== openingVersion);
        const reviewed = JSON.parse((await reconnected(followLink)).result);
        assertEquals(reviewed.link, trafficLink);
        assertEquals(reviewed.annotations, [annotated]);
        assertStringIncludes(
          (await reconnected({
            ...receiptAction,
            action: "amend_finding_report",
            evidenceVersion: openingVersion,
            reportVersion: 1,
            title: "Stale traffic report",
            summary: "This report must not replace newer attachment metadata.",
            requestId: crypto.randomUUID(),
          })).result,
          "unavailable",
        );
        assertEquals(confirmations.length, beforeAnnotation + 1);
        denied = "POST_TOOL_RESPONSE";
        assertEquals(
          (await reconnected(followLink)).result,
          "Tool response withheld by policy.",
        );
        denied = "PRE_OUTPUT";
        assertEquals((await reconnected(followLink)).response, undefined);
        denied = undefined;
      });
      const secondLink = JSON.parse(
        (await turn({
          ...attachTraffic,
          evidenceId: nextCandidatePage.receipts[0].evidenceId,
          digest: nextCandidatePage.receipts[0].digest,
          evidenceNote: "Temporary attachment used to review ordering.",
          requestId: crypto.randomUUID(),
        })).result,
      ).link;
      const unordered = JSON.parse((await turn(trafficAction)).result).page;
      assertEquals(unordered.links.map(({ id }: { id: string }) => id), [
        secondLink.id,
        trafficLink.id,
      ]);
      const reorderTraffic = {
        ...trafficAction,
        action: "reorder_finding_traffic",
        reportVersion: 1,
        evidenceVersion: unordered.evidenceVersion,
        trafficLinkIds: [trafficLink.id, secondLink.id],
        requestId: crypto.randomUUID(),
      };
      const beforeReorder = confirmations.length;
      denied = "PRE_TOOL_CALL";
      await turn(reorderTraffic);
      assertEquals(confirmations.length, beforeReorder);
      denied = undefined;
      for (
        const change of [
          { ...reorderTraffic, trafficLinkIds: [trafficLink.id] },
          {
            ...reorderTraffic,
            trafficLinkIds: [trafficLink.id, trafficLink.id],
          },
          { ...reorderTraffic, ...exact },
        ]
      ) assertStringIncludes((await turn(change)).result, "unavailable");
      assertEquals(confirmations.length, beforeReorder);
      const orderDecision =
        JSON.parse((await turn(reorderTraffic)).result).amendment;
      const ordered = JSON.parse((await turn(trafficAction)).result).page;
      assertEquals(
        ordered.links.map(({ id }: { id: string }) => id),
        reorderTraffic.trafficLinkIds,
      );
      assert(ordered.evidenceVersion !== unordered.evidenceVersion);
      const orderedPage =
        JSON.parse((await turn({ ...trafficAction, limit: 1 })).result).page;
      assertEquals(orderedPage.links[0].id, trafficLink.id);
      assertEquals(orderedPage.nextOffset, 1);
      const orderedTail = JSON.parse(
        (await turn({
          ...trafficAction,
          limit: 1,
          offset: orderedPage.nextOffset,
        })).result,
      ).page;
      assertEquals(orderedTail.links[0].id, secondLink.id);
      assertEquals(orderedTail.nextOffset, null);
      await withGateway(async (reconnected) => {
        assertEquals(
          JSON.parse((await reconnected(reorderTraffic)).result).amendment,
          orderDecision,
        );
        assertEquals(confirmations.length, beforeReorder + 1);
        const withdrawal = {
          ...trafficAction,
          action: "withdraw_finding_traffic",
          trafficLinkId: secondLink.id,
          reportVersion: 1,
          evidenceVersion: ordered.evidenceVersion,
          requestId: crypto.randomUUID(),
        };
        assertStringIncludes(
          (await reconnected({
            ...withdrawal,
            evidenceVersion: unordered.evidenceVersion,
          })).result,
          "unavailable",
        );
        const decision =
          JSON.parse((await reconnected(withdrawal)).result).amendment;
        assertEquals(decision.linkId, secondLink.id);
        const active =
          JSON.parse((await reconnected(trafficAction)).result).page;
        assertEquals(active.links.map(({ id }: { id: string }) => id), [
          trafficLink.id,
        ]);
        assert(active.evidenceVersion !== ordered.evidenceVersion);
        assertEquals(
          JSON.parse((await reconnected(withdrawal)).result).amendment,
          decision,
        );
        const exactWithdrawn = {
          ...trafficAction,
          trafficLinkId: secondLink.id,
        };
        assertStringIncludes(
          (await reconnected(exactWithdrawn)).result,
          "unavailable",
        );
        const retained = JSON.parse(
          (await reconnected({ ...exactWithdrawn, includeWithdrawn: true }))
            .result,
        );
        assertEquals(retained.link, secondLink);
        assertEquals(retained.withdrawal, decision);
        assertStringIncludes(
          (await reconnected({
            ...exactWithdrawn,
            includeWithdrawn: true,
            payloadPart: "response_body",
          })).result,
          "unavailable",
        );
        denied = "POST_TOOL_RESPONSE";
        assertEquals(
          (await reconnected({ ...exactWithdrawn, includeWithdrawn: true }))
            .result,
          "Tool response withheld by policy.",
        );
        denied = "PRE_OUTPUT";
        assertEquals(
          (await reconnected({ ...exactWithdrawn, includeWithdrawn: true }))
            .response,
          undefined,
        );
        denied = undefined;
      });
      const largeJournal = openSentinelFindingTrafficLinks(peerPath);
      const largeIds: string[] = [];
      try {
        for (let index = 0; index < 35; index++) {
          const generated = largeJournal.record({
            ...trafficLink,
            findingId: later.id,
            evidenceNote: `Reviewed attachment ${index}`,
            requestId: crypto.randomUUID(),
          }, () => true);
          assert(generated);
          largeIds.push(generated.id);
        }
      } finally {
        largeJournal.close();
      }
      const largeList = { ...trafficAction, receiptId: later.id };
      const beforeLarge = JSON.parse((await turn(largeList)).result).page;
      const completeOrder = {
        ...largeList,
        action: "reorder_finding_traffic",
        reportVersion: 1,
        evidenceVersion: beforeLarge.evidenceVersion,
        trafficLinkIds: largeIds,
        requestId: crypto.randomUUID(),
      };
      const beforeLargeApproval = confirmations.length;
      assertStringIncludes(
        (await turn({
          ...completeOrder,
          trafficLinkIds: largeIds.slice(0, -1),
        })).result,
        "unavailable",
      );
      assertEquals(confirmations.length, beforeLargeApproval);
      const largeReceipt =
        JSON.parse((await turn(completeOrder)).result).amendment;
      assertEquals(largeReceipt.linkCount, 35);
      assertEquals(largeReceipt.linkIds, undefined);
      assertStringIncludes(confirmations.at(-1)!, largeReceipt.orderDigest);
      assert(confirmations.at(-1)!.length < 1_500);
      const afterLarge = JSON.parse((await turn(largeList)).result).page;
      assertEquals(afterLarge.links[0].id, largeIds[0]);
      const moveOne = {
        ...largeList,
        action: "reorder_finding_traffic",
        reportVersion: 1,
        evidenceVersion: afterLarge.evidenceVersion,
        moveTrafficLinkId: largeIds.at(-1),
        beforeTrafficLinkId: largeIds[0],
        requestId: crypto.randomUUID(),
      };
      assertStringIncludes(
        (await turn({
          ...moveOne,
          evidenceVersion: beforeLarge.evidenceVersion,
        })).result,
        "unavailable",
      );
      const moved = JSON.parse((await turn(moveOne)).result).amendment;
      assertEquals(moved.linkCount, 35);
      assert(moved.orderDigest !== largeReceipt.orderDigest);
      await withGateway(async (reconnected) => {
        assertEquals(
          JSON.parse((await reconnected(completeOrder)).result).amendment,
          largeReceipt,
        );
        assertEquals(
          JSON.parse((await reconnected(moveOne)).result).amendment,
          moved,
        );
        assertEquals(confirmations.length, beforeLargeApproval + 2);
        const readOrder = {
          ...largeList,
          action: "finding_traffic_set_receipt",
          trafficSetReceiptId: largeReceipt.id,
        };
        const firstAuditPage = JSON.parse(
          (await reconnected(readOrder)).result,
        );
        const secondAuditPage = JSON.parse(
          (await reconnected({
            ...readOrder,
            offset: firstAuditPage.page.nextOffset,
          })).result,
        );
        assertEquals(
          firstAuditPage.receipt.orderDigest,
          largeReceipt.orderDigest,
        );
        assertEquals([
          ...firstAuditPage.page.linkIds,
          ...secondAuditPage.page.linkIds,
        ], largeIds);
        assertEquals(secondAuditPage.page.nextOffset, null);
        const current = JSON.parse(
          (await reconnected({
            ...readOrder,
            trafficSetReceiptId: moved.id,
            limit: 40,
          })).result,
        );
        assertEquals(current.page.linkIds, [
          largeIds.at(-1),
          ...largeIds.slice(0, -1),
        ]);
        assertStringIncludes(
          (await reconnected({ ...readOrder, receiptId: original.id })).result,
          "unavailable",
        );
        denied = "POST_TOOL_RESPONSE";
        assertEquals(
          (await reconnected(readOrder)).result,
          "Tool response withheld by policy.",
        );
        denied = "PRE_OUTPUT";
        assertEquals((await reconnected(readOrder)).response, undefined);
        denied = undefined;
      });
      const trafficResult = (await turn(followLink)).result;
      assertEquals(JSON.parse(trafficResult).receipt.digest, traffic.digest);
      assert(!trafficResult.includes(trafficSecret));
      assert(!trafficResult.includes("/private"));
      assertStringIncludes(
        (await turn({ ...followLink, ...exact })).result,
        "unavailable",
      );
      assertStringIncludes(
        (await turn({ ...followLink, receiptId: later.id })).result,
        "unavailable",
      );
      denied = "POST_TOOL_RESPONSE";
      assertEquals(
        (await turn(followLink)).result,
        "Tool response withheld by policy.",
      );
      denied = undefined;
      const localFindings = JSON.parse(
        (await turn({
          action: "findings",
          ...exact,
          query: "peer-only",
        })).result,
      );
      assertEquals(localFindings.page.nodes, []);
      const traces = JSON.parse(
        (await turn({ action: "traces", ...exact })).result,
      );
      assertEquals(traces.page.revision, sentinelRevision);
      assertEquals(traces.page.totalSteps, 0);
      assertStringIncludes(
        (await turn({ action: "traces", ...sentinel })).result,
        "unavailable",
      );
      const standaloneSearchCase = async (id: string, source: string) => {
        const casePath = resolveSentinelCasePath(baseDir, id);
        await Deno.mkdir(dirname(casePath), { recursive: true });
        await Deno.copyFile(source, casePath);
        const revision = startSentinelAssessment(casePath).revision;
        return { casePath, run: { kind: "sentinel", id, revision } };
      };
      const searchLeft = await standaloneSearchCase("trace-search-left", path);
      const searchRight = await standaloneSearchCase(
        "trace-search-right",
        peerPath,
      );
      const seedReviewSteps = (
        casePath: string,
        target: string,
        label: string,
        extra: (taskId: string) => SentinelReadTrace[] = () => [],
      ) => {
        const state = readSentinelAssessment(casePath)!;
        advanceAdaptiveSentinel(casePath, state);
        const store = openSentinelAdaptiveStore(
          join(dirname(casePath), "sentinel-adaptive.db"),
        );
        try {
          const revision = store.activeRevision();
          assert(revision);
          store.sync(revision, [{
            kind: "trace",
            nodeId: target,
            depth: 7,
            reason: MODEL_ASSIGNMENT_REASON,
          }], revision);
          advanceAdaptiveSentinel(casePath, state);
          const claim = store.claimModelReview(
            revision,
            MODEL_ASSIGNMENT_REASON,
            ({ nodeId, depth }) => nodeId === target && depth === 7,
          );
          assert(claim);
          assert(store.finishModelReview(revision, claim.task.id, claim.token, {
            note: "Reviewed the search fixture.",
            steps: [
              ...[0, 1].map((index) => ({
                tool: "sentinel_report",
                target: label + "-" + index,
                outcome: "returned" as const,
              })),
              ...(target === "peer-asset"
                ? [{
                  tool: "sentinel_live_workflow_status",
                  target,
                  outcome: "returned" as const,
                  githubWorkflowRead: {
                    repository: "owner/repo",
                    workflowId: 22,
                    connectorId: "github-actions",
                    evidenceRevision: state.revision,
                    observedAt: new Date().toISOString(),
                    resultSha256: createHash("sha256").update(
                      JSON.stringify(workflowMetadataRuns),
                    ).digest("hex"),
                    runs: workflowMetadataRuns,
                  },
                }]
                : []),
              ...extra(claim.task.id),
            ],
          }));
          return claim.task.id;
        } finally {
          store.close();
        }
      };
      const localTraceTask = seedReviewSteps(
        searchLeft.casePath,
        "private-evidence",
        "search-fixture-local",
      );
      const otherTraceTask = seedReviewSteps(
        searchRight.casePath,
        "peer-asset",
        "search-fixture-peer",
      );
      const exactWorkflowResult = {
        action: "worker_trace_result",
        ...searchRight.run,
        taskId: otherTraceTask,
        stepIndices: [2],
      };
      const retainedWorkflow = JSON.parse(
        (await turn(exactWorkflowResult)).result,
      );
      assertEquals(retainedWorkflow.result.runs, workflowMetadataRuns);
      assertEquals(retainedWorkflow.result.targetId, "peer-asset");
      assertEquals(workflowMetadataCalls, 1);
      denyTraceSource = "PRE_TOOL_CALL";
      assertStringIncludes(
        (await turn(exactWorkflowResult)).result,
        "unavailable",
      );
      assertEquals(workflowMetadataCalls, 1);
      denyTraceSource = "POST_TOOL_RESPONSE";
      assertStringIncludes(
        (await turn(exactWorkflowResult)).result,
        "unavailable",
      );
      assertEquals(workflowMetadataCalls, 2);
      denyTraceSource = undefined;
      allowWorkflowMetadata = false;
      assertStringIncludes(
        (await turn(exactWorkflowResult)).result,
        "unavailable",
      );
      const beforeDiscovery = workflowMetadataCalls;
      const metadata = JSON.parse(
        (await turn({ ...exactWorkflowResult, action: "traces" })).result,
      );
      const [step] = metadata.page.steps;
      assertEquals(step.tool, "sentinel_live_workflow_status");
      assertEquals(step.githubWorkflowRead, undefined);
      const reviewNode = JSON.parse(
        (await turn({
          ...searchRight.run,
          action: "node",
          node: step.reviewId,
        })).result,
      );
      assertEquals(reviewNode.page.node.id, step.reviewId);
      for (const projection of [metadata, reviewNode]) {
        const encoded = JSON.stringify(projection);
        assert(!encoded.includes("githubWorkflowRead"));
        assert(!encoded.includes("owner/repo"));
      }
      assertEquals(workflowMetadataCalls, beforeDiscovery);
      allowWorkflowMetadata = true;
      const trafficTarget = traffic.assetIds[0];
      const retainedTraffic = readProjectedSentinelTrafficReceipt(
        peerPath,
        peer.id,
        peer.revision,
        traffic,
        trafficTarget,
      );
      assert(retainedTraffic);
      const pageArgs = { revision: peer.revision, status: 403, limit: 1 };
      const firstPage = reopenProjectedSentinelTrafficPage(
        peerPath,
        peer.id,
        peer.revision,
        pageArgs,
        trafficTarget,
      );
      assert(firstPage);
      const cursor = JSON.parse(firstPage).nextCursor;
      assert(typeof cursor === "string");
      const nextArgs = { ...pageArgs, cursor };
      const secondPage = reopenProjectedSentinelTrafficPage(
        peerPath,
        peer.id,
        peer.revision,
        nextArgs,
        trafficTarget,
      );
      assert(secondPage);
      const traceSearchStep = (
        args: typeof pageArgs,
        text: string,
      ): SentinelReadTrace => ({
        tool: "sentinel_traffic_search",
        outcome: "returned",
        trafficSearch: {
          args,
          sha256: createHash("sha256").update(text).digest("hex"),
        },
      });
      const linkPage = {
        _classification: "INTERNAL",
        caseId: peer.id,
        evidenceRevision: peer.revision,
        links: [trafficLink],
        nextOffset: null,
      };
      let discoveryReceipt:
        | { id: string; status: string; claim: unknown }
        | undefined;
      const findingResults: unknown[] = [];
      let expectedAttachment: unknown;
      const trafficTask = seedReviewSteps(
        peerPath,
        trafficTarget,
        "retained-traffic",
        (taskId) => {
          const store = openSentinelFindingTrafficLinks(peerPath);
          let attachment;
          try {
            attachment = store.record({
              caseId: peer.id,
              evidenceRevision: peer.revision,
              assetId: trafficTarget,
              findingId: later.id,
              reportVersion: 1,
              trafficId: traffic.evidenceId,
              trafficSource: traffic.family,
              trafficDigest: traffic.digest,
              authority: { kind: "assignment", taskId },
              requestId: crypto.randomUUID(),
            }, () => true);
          } finally {
            store.close();
          }
          assert(attachment);
          expectedAttachment = attachment;
          const findings = openSentinelWorkerFindingStore(peerPath);
          let writes: SentinelReadTrace[];
          try {
            const finding = findings.recordFinding({
              ...original,
              taskId,
              requestId: crypto.randomUUID(),
            });
            const recheck = findings.recordRecheck({
              ...finding,
              findingId: original.id,
              evidenceId: "fixture-recheck-evidence",
              outcome: "pass",
              observedAt: "2026-01-01T12:00:00.000Z",
              requestId: crypto.randomUUID(),
            });
            const amendment = findings.updateFindingReport({
              ...finding,
              findingId: finding.id,
              expectedVersion: 1,
              title: "Updated report",
              requestId: crypto.randomUUID(),
            });
            assert(amendment);
            findingResults.push(
              { _classification: "INTERNAL", record: finding },
              { _classification: "INTERNAL", record: recheck },
              { _classification: "INTERNAL", amendment },
            );
            writes = [
              {
                tool: "sentinel_report_finding",
                outcome: "returned",
                target: finding.id,
              },
              {
                tool: "sentinel_record_finding_recheck",
                outcome: "returned",
                target: recheck.id,
              },
              {
                tool: "sentinel_update_finding_report",
                outcome: "returned",
                target: amendment.id,
              },
              {
                tool: "sentinel_report_finding",
                outcome: "returned",
                target: original.id,
              },
            ];
          } finally {
            findings.close();
          }
          const discoveryRequestId = crypto.randomUUID();
          const snapshot = readSentinelAssessment(peerPath)?.result?.sharedGraph
            .snapshot;
          assert(snapshot);
          const discoveries = openSentinelAssetDiscoveryStore(baseDir);
          try {
            const saved = discoveries.propose({
              sourceCaseId: peer.id,
              taskId,
              evidenceRevision: peer.revision,
              sourceDigest: digestSentinelSnapshot(snapshot),
              claim: {
                kind: "asset",
                assetId: trafficTarget,
                evidenceId: traffic.evidenceId,
              },
            }, discoveryRequestId);
            discoveryReceipt = {
              id: saved.id,
              status: saved.status,
              claim: saved.claim,
            };
            writes.push({
              tool: "sentinel_submit_asset_discovery",
              outcome: "returned",
              target: saved.id,
              assetDiscoveryRequestId: discoveryRequestId,
              resultSha256: createHash("sha256").update(
                JSON.stringify(discoveryReceipt),
              ).digest("hex"),
            });
          } finally {
            discoveries.close();
          }
          return [
            {
              tool: "sentinel_traffic_get",
              outcome: "returned",
              trafficRead: {
                revision: peer.revision,
                evidenceId: traffic.evidenceId,
                digest: traffic.digest,
                sha256: createHash("sha256").update(
                  JSON.stringify(retainedTraffic),
                )
                  .digest("hex"),
              },
            },
            traceSearchStep(pageArgs, firstPage),
            traceSearchStep(nextArgs, secondPage),
            traceSearchStep(nextArgs, firstPage),
            {
              tool: "sentinel_finding_traffic_links",
              outcome: "returned",
              trafficLinks: {
                args: { revision: peer.revision, findingId: original.id },
                linkIds: [trafficLink.id],
                nextOffset: null,
                sha256: createHash("sha256").update(JSON.stringify(linkPage))
                  .digest("hex"),
              },
            },
            {
              tool: "sentinel_attach_finding_traffic",
              target: attachment.id,
              outcome: "returned",
              resultSha256: createHash("sha256").update(JSON.stringify({
                _classification: "INTERNAL",
                link: attachment,
              })).digest("hex"),
            },
            {
              tool: "sentinel_attach_finding_traffic",
              target: trafficLink.id,
              outcome: "returned",
            },
            ...writes,
          ];
        },
      );
      const trafficStep = {
        action: "worker_trace_result",
        ...peer,
        taskId: trafficTask,
        stepIndices: [2],
      };
      const trafficResultRead = JSON.parse((await turn(trafficStep)).result);
      assertEquals(trafficResultRead.result, retainedTraffic);
      assert(!JSON.stringify(trafficResultRead).includes(trafficSecret));
      for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"] as const) {
        denyTraceSource = hook;
        try {
          assertStringIncludes((await turn(trafficStep)).result, "unavailable");
        } finally {
          denyTraceSource = undefined;
        }
      }
      const trafficPageStep = { ...trafficStep, stepIndices: [4] };
      assertEquals(
        JSON.parse((await turn({ ...trafficStep, stepIndices: [3] })).result)
          .result,
        JSON.parse(firstPage),
      );
      assertEquals(
        JSON.parse((await turn(trafficPageStep)).result).result,
        JSON.parse(secondPage),
      );
      assertStringIncludes(
        (await turn({ ...trafficStep, stepIndices: [5] })).result,
        "unavailable",
      );
      for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"] as const) {
        denyTraceSource = hook;
        try {
          assertStringIncludes(
            (await turn(trafficPageStep)).result,
            "unavailable",
          );
        } finally {
          denyTraceSource = undefined;
        }
      }
      const linkStep = { ...trafficStep, stepIndices: [6] };
      assertEquals(JSON.parse((await turn(linkStep)).result).result, linkPage);
      const secondTrafficReceipt = nextCandidatePage.receipts[0];
      const newerLink = JSON.parse(
        (await turn({
          ...attachTraffic,
          requestId: crypto.randomUUID(),
          evidenceId: secondTrafficReceipt.evidenceId,
          digest: secondTrafficReceipt.digest,
        })).result,
      ).link;
      assert(newerLink && newerLink.id !== trafficLink.id);
      assertEquals(
        JSON.parse((await turn(trafficAction)).result).page.links.map((
          { id }: { id: string },
        ) => id),
        [trafficLink.id, newerLink.id],
      );
      assertEquals(JSON.parse((await turn(linkStep)).result).result, linkPage);
      for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"] as const) {
        denyTraceSource = hook;
        try {
          assertStringIncludes((await turn(linkStep)).result, "unavailable");
        } finally {
          denyTraceSource = undefined;
        }
      }
      const attachmentStep = { ...trafficStep, stepIndices: [7] };
      assertEquals(JSON.parse((await turn(attachmentStep)).result).result, {
        _classification: "INTERNAL",
        link: expectedAttachment,
      });
      assertStringIncludes(
        (await turn({ ...trafficStep, stepIndices: [8] })).result,
        "unavailable",
      );
      for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"] as const) {
        denyTraceSource = hook;
        try {
          assertStringIncludes(
            (await turn(attachmentStep)).result,
            "unavailable",
          );
        } finally {
          denyTraceSource = undefined;
        }
      }
      for (const [index, result] of findingResults.entries()) {
        const request = { ...trafficStep, stepIndices: [9 + index] };
        assertEquals(JSON.parse((await turn(request)).result).result, result);
        for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"] as const) {
          denyTraceSource = hook;
          try {
            assertStringIncludes((await turn(request)).result, "unavailable");
          } finally {
            denyTraceSource = undefined;
          }
        }
      }
      assertStringIncludes(
        (await turn({ ...trafficStep, stepIndices: [12] })).result,
        "unavailable",
      );
      const discoveryStep = { ...trafficStep, stepIndices: [13] };
      assert(discoveryReceipt);
      assertEquals(
        JSON.parse((await turn(discoveryStep)).result).result,
        discoveryReceipt,
      );
      const discoveries = openSentinelAssetDiscoveryStore(baseDir);
      try {
        const accepted = discoveries.approve(discoveryReceipt.id, 1);
        assertEquals(accepted?.status, "approved");
      } finally {
        discoveries.close();
      }
      assertEquals(
        JSON.parse((await turn(discoveryStep)).result).result,
        discoveryReceipt,
      );
      for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"] as const) {
        denyTraceSource = hook;
        try {
          assertStringIncludes(
            (await turn(discoveryStep)).result,
            "unavailable",
          );
        } finally {
          denyTraceSource = undefined;
        }
      }
      const listWorkers = { action: "list_trace_workers", ...searchLeft.run };
      const workers = JSON.parse((await turn(listWorkers)).result);
      assertEquals(workers.run, searchLeft.run);
      assertEquals(workers.page.totalWorkers, 1);
      assertEquals(
        workers.page.workers.map(({ taskId, stepCount }: {
          taskId: string;
          stepCount: number;
        }) => ({ taskId, stepCount })),
        [{ taskId: localTraceTask, stepCount: 2 }],
      );
      assertEquals(workers.page.nextOffset, null);
      assert(!JSON.stringify(workers).includes(otherTraceTask));
      for (const filters of [{ offset: 1 }, { query: otherTraceTask }]) {
        const empty = JSON.parse(
          (await turn({ ...listWorkers, ...filters })).result,
        );
        assertEquals(empty.page.workers, []);
      }
      assertStringIncludes(
        (await turn({
          ...listWorkers,
          revision: searchLeft.run.revision + 1,
        })).result,
        "unavailable",
      );
      denied = "POST_TOOL_RESPONSE";
      assertEquals(
        (await turn(listWorkers)).result,
        "Tool response withheld by policy.",
      );
      denied = undefined;
      const searchCases = {
        action: "search_case_traces",
        query: "search-fixture",
        scopes: [
          { id: searchLeft.run.id, revision: searchLeft.run.revision },
          {
            id: searchRight.run.id,
            revision: searchRight.run.revision,
            offset: 1,
          },
        ],
      };
      const searchResult = JSON.parse((await turn(searchCases)).result);
      assertEquals(searchResult.pages.map(({ run }: { run: unknown }) => run), [
        searchLeft.run,
        searchRight.run,
      ]);
      assertEquals(
        searchResult.pages.map((
          { page }: { page: { steps: { taskId: string; index: number }[] } },
        ) => page.steps.map(({ taskId, index }) => [taskId, index])),
        [[[localTraceTask, 0]], [[otherTraceTask, 1]]],
      );
      assertEquals(searchResult.pages[0].page.nextOffset, 1);
      const exactStep = JSON.parse(
        (await turn({
          action: "traces",
          ...searchRight.run,
          taskId: otherTraceTask,
          stepIndices: [1],
        })).result,
      );
      assertEquals(exactStep.page.steps, searchResult.pages[1].page.steps);
      assertEquals(
        JSON.parse(
          (await turn({
            ...searchCases,
            scopes: searchCases.scopes.slice(0, 1),
          })).result,
        ).pages.length,
        1,
      );
      for (
        const second of [
          { id: "unknown-case", revision: 1 },
          { id: searchRight.run.id, revision: searchRight.run.revision + 99 },
          searchCases.scopes[0],
        ]
      ) {
        const invalid = await turn({
          ...searchCases,
          scopes: [searchCases.scopes[0], second],
        });
        assertStringIncludes(invalid.result, "unavailable");
        assert(!invalid.result.includes(localTraceTask));
      }
      denied = "PRE_TOOL_CALL";
      assert(!(await turn(searchCases)).result.includes(localTraceTask));
      denied = "POST_TOOL_RESPONSE";
      assertEquals(
        (await turn(searchCases)).result,
        "Tool response withheld by policy.",
      );
      denied = "PRE_OUTPUT";
      const blockedCaseSearch = await turn(searchCases);
      assertEquals(blockedCaseSearch.response, undefined);
      assert(blockedCaseSearch.error);
      denied = undefined;
      const hint = {
        action: "hint",
        ...exact,
        requestId: crypto.randomUUID(),
        note: "Focus on the retained defensive evidence.",
      };
      assertEquals(JSON.parse((await turn(hint)).result).run.ref, exact);
      assertEquals(JSON.parse((await turn(hint)).result).run.ref, exact);
      assertEquals(readSentinelCaseHints(path, 10).map(({ text }) => text), [
        hint.note,
      ]);
      assertStringIncludes(
        (await turn({ ...hint, note: "Different duplicate hint" })).result,
        "unavailable",
      );
      assertEquals(
        JSON.parse((await turn({ action: "pause", ...exact })).result).run
          .status,
        "paused",
      );
      assertStringIncludes(
        (await turn({
          action: "resume",
          ...exact,
          revision: sentinelRevision + 1,
        })).result,
        "unavailable",
      );
      assertEquals(readSentinelAssessment(path)?.paused, true);
      const { runId, adaptiveRevision } = JSON.parse(inspection.result).run
        .details;
      assignmentRequest = {
        action: "assign",
        ...exact,
        runId,
        adaptiveRevision,
        requestId: crypto.randomUUID(),
        taskKind: "trace",
        node: "private-evidence",
      };
      const assignments = () => {
        const state = readSentinelAssessment(path)!;
        return readAdaptiveSentinel(path, state)?.tasks.filter(({ kind }) =>
          kind === "trace"
        ) ?? [];
      };
      const beforeAssignment = assignments();
      const confirmationCount = confirmations.length;
      denied = "PRE_TOOL_CALL";
      assert((await turn(assignmentRequest)).result);
      assertEquals(confirmations.length, confirmationCount);
      assertEquals(assignments(), beforeAssignment);
      denied = undefined;
      const assigned = JSON.parse((await turn(assignmentRequest)).result);
      assignmentReceipt = assigned.receipt;
      assertEquals(assigned.receipt.disposition, "enqueued");
      assertEquals(assigned.receipt.nodeId, "private-evidence");
      assertEquals(assignments().map(({ id }) => id), [
        assigned.receipt.taskId,
      ]);
      assertEquals(assignments()[0].status, "queued");
      assertEquals(
        JSON.parse((await turn(assignmentRequest)).result).receipt,
        assignmentReceipt,
      );
      assertStringIncludes(
        (await turn({ ...assignmentRequest, taskKind: "review_evidence" }))
          .result,
        "unavailable",
      );
      assertEquals(assignments().length, 1);
      assertEquals(confirmations.length, confirmationCount + 1);
      const dependencyStore = openSentinelAdaptiveStore(
        join(dirname(path), "sentinel-adaptive.db"),
      );
      let dependencyTaskId: string;
      try {
        const target = dependencyStore.sync(adaptiveRevision, [{
          kind: "impact",
          nodeId: "private-evidence",
          depth: 9,
          plannerRound: { identity: adaptiveRevision, attempt: 1 },
        }], adaptiveRevision).find(({ kind, depth }) =>
          kind === "impact" && depth === 9
        );
        assert(target);
        dependencyTaskId = target.id;
        assert(dependencyStore.recommendDependencyChanges(adaptiveRevision, [{
          id: target.id,
          prerequisites: [assigned.receipt.taskId],
          reason: "Inspect the prerequisite evidence first.",
        }]));
      } finally {
        dependencyStore.close();
      }
      const taskRead = { ...exact, action: "tasks", taskId: dependencyTaskId };
      const proposed = JSON.parse((await turn(taskRead)).result).tasks[0];
      assertEquals(proposed.prerequisites, []);
      assertEquals(proposed.dependencyProposal.prerequisites, [
        assigned.receipt.taskId,
      ]);
      const apply = {
        ...taskRead,
        action: "apply_task_dependencies",
        proposalId: proposed.dependencyProposal.id,
      };
      const beforeApply = confirmations.length;
      denied = "PRE_TOOL_CALL";
      await turn(apply);
      assertEquals(confirmations.length, beforeApply);
      denied = undefined;
      assertEquals(JSON.parse((await turn(apply)).result).decision, "applied");
      assertEquals(
        JSON.parse((await turn(taskRead)).result).tasks[0].prerequisites,
        [assigned.receipt.taskId],
      );
      assertStringIncludes((await turn(apply)).result, "unavailable");
      assertEquals(confirmations.length, beforeApply + 1);
      const dismissStore = openSentinelAdaptiveStore(
        join(dirname(path), "sentinel-adaptive.db"),
      );
      try {
        assert(dismissStore.recommendDependencyChanges(adaptiveRevision, [{
          id: dependencyTaskId,
          prerequisites: [],
          reason: "Remove the prerequisite.",
        }]));
      } finally {
        dismissStore.close();
      }
      const removal =
        JSON.parse((await turn(taskRead)).result).tasks[0].dependencyProposal;
      assertEquals(
        JSON.parse(
          (await turn({
            ...taskRead,
            action: "dismiss_task_dependencies",
            proposalId: removal.id,
          })).result,
        ).decision,
        "dismissed",
      );
      const unchanged = JSON.parse((await turn(taskRead)).result).tasks[0];
      assertEquals(unchanged.prerequisites, [assigned.receipt.taskId]);
      assertEquals(unchanged.dependencyProposal, undefined);
      const priority = { ...taskRead, action: "prioritize_task" };
      assertEquals(
        JSON.parse((await turn(priority)).result).action,
        "prioritize_task",
      );
      assertEquals(
        JSON.parse((await turn(taskRead)).result).tasks[0].prioritized,
        true,
      );
      assertStringIncludes((await turn(priority)).result, "unavailable");
      assertEquals(
        JSON.parse(
          (await turn({
            ...priority,
            action: "withdraw_task_priority",
          })).result,
        ).action,
        "withdraw_task_priority",
      );
      assertEquals(
        JSON.parse((await turn(taskRead)).result).tasks[0].prioritized,
        false,
      );
      const queueStore = openSentinelAdaptiveStore(
        join(dirname(path), "sentinel-adaptive.db"),
      );
      let childId: string;
      let failedId: string;
      try {
        const tasks = queueStore.sync(adaptiveRevision, [
          {
            kind: "impact",
            nodeId: "private-evidence",
            depth: 10,
            prerequisites: [dependencyTaskId],
          },
          { kind: "trace", nodeId: "private-evidence", depth: 10 },
        ], adaptiveRevision);
        const child = tasks.find(({ kind, depth }) =>
          kind === "impact" && depth === 10
        );
        const failed = tasks.find(({ kind, depth }) =>
          kind === "trace" && depth === 10
        );
        assert(child && failed);
        childId = child.id;
        failedId = failed.id;
        const excluded = new Set(
          queueStore.list(adaptiveRevision).filter(({ id }) => id !== failedId)
            .map(({ id }) => id),
        );
        const lease = queueStore.claim(adaptiveRevision, 60, excluded);
        assert(lease);
        queueStore.fail({
          taskId: failedId,
          leaseToken: lease.leaseToken,
          note: "Fixture failure.",
        });
      } finally {
        queueStore.close();
      }
      const cancelled = JSON.parse(
        (await turn({ ...taskRead, action: "cancel_task" })).result,
      );
      assertEquals(cancelled.affectedTaskIds, [dependencyTaskId, childId]);
      assertEquals(
        JSON.parse((await turn({ ...taskRead, taskId: childId })).result)
          .tasks[0].status,
        "cancelled",
      );
      assertEquals(
        JSON.parse(
          (await turn({ ...taskRead, taskId: assigned.receipt.taskId })).result,
        ).tasks[0].status,
        "queued",
      );
      const retry = { ...taskRead, action: "retry_task", taskId: failedId };
      assertEquals(JSON.parse((await turn(retry)).result).action, "retry_task");
      assertEquals(
        JSON.parse((await turn({ ...taskRead, taskId: failedId })).result)
          .tasks[0].status,
        "queued",
      );
      assertStringIncludes((await turn(retry)).result, "unavailable");
      let reviewClock = Date.now() - 120_000;
      const reviewStore = openSentinelAdaptiveStore(
        join(dirname(path), "sentinel-adaptive.db"),
        () => reviewClock,
      );
      let reviewTaskId: string;
      try {
        const task = reviewStore.sync(adaptiveRevision, [{
          kind: "impact",
          depth: 8,
          nodeId: "private-evidence",
          reason: MODEL_ASSIGNMENT_REASON,
        }], adaptiveRevision).find(({ kind, depth }) =>
          kind === "impact" && depth === 8
        );
        assert(task);
        reviewTaskId = task.id;
        const exclude = new Set(
          reviewStore.list(adaptiveRevision).filter(({ id }) =>
            id !== reviewTaskId
          ).map(({ id }) => id),
        );
        const initial = reviewStore.claim(adaptiveRevision, 60, exclude);
        assert(initial);
        assert(
          reviewStore.complete({
            taskId: reviewTaskId,
            leaseToken: initial.leaseToken,
            observation: {},
          }),
        );
        for (let attempt = 0; attempt < 2; attempt++) {
          const review = reviewStore.claimModelReview(
            adaptiveRevision,
            MODEL_ASSIGNMENT_REASON,
            ({ id }) => id === reviewTaskId,
          );
          assert(review);
          assert(
            reviewStore.finishModelReview(
              adaptiveRevision,
              reviewTaskId,
              review.token,
              "failed",
            ),
          );
          reviewClock += 15_000;
        }
      } finally {
        reviewStore.close();
      }
      const modelTask = { ...taskRead, taskId: reviewTaskId };
      const retryReview = { ...modelTask, action: "retry_model_review" };
      assertEquals(
        JSON.parse((await turn(modelTask)).result).tasks[0].modelReview,
        {
          attempts: 2,
          retryable: true,
          status: "exhausted",
        },
      );
      const beforeModelRetry = confirmations.length;
      sentinelModelAccess = false;
      await withGateway(async (disabledTurn) => {
        assertStringIncludes(
          (await disabledTurn(retryReview)).result,
          "unavailable",
        );
      });
      sentinelModelAccess = true;
      assertEquals(confirmations.length, beforeModelRetry);
      assertEquals(
        JSON.parse((await turn(retryReview)).result).action,
        "retry_model_review",
      );
      assertEquals(
        JSON.parse((await turn(modelTask)).result).tasks[0].modelReview,
        {
          attempts: 2,
          retryable: false,
          status: "retry_pending",
        },
      );
      assertStringIncludes((await turn(retryReview)).result, "unavailable");
      assertEquals(confirmations.length, beforeModelRetry + 1);
      const capacity = { ...exact, action: "worker_limit" };
      const setCapacity = { ...capacity, action: "set_worker_limit", limit: 1 };
      const defaults = JSON.parse((await turn(capacity)).result);
      assertEquals(defaults.caseLimit, null);
      assertEquals(defaults.effectiveLimit, 3);
      const beforeCapacity = confirmations.length;
      assertStringIncludes(
        (await turn({ ...setCapacity, limit: 4 })).result,
        "unavailable",
      );
      assertEquals(confirmations.length, beforeCapacity);
      duringConfirmation = () => {
        const journal = openSentinelAdaptiveStore(
          join(dirname(path), "sentinel-adaptive.db"),
        );
        try {
          journal.setWorkerLimit(2);
        } finally {
          journal.close();
        }
      };
      try {
        assertStringIncludes((await turn(setCapacity)).result, "unavailable");
      } finally {
        duringConfirmation = undefined;
      }
      assertEquals(JSON.parse((await turn(capacity)).result).caseLimit, 2);
      const limited = JSON.parse((await turn(setCapacity)).result);
      assertEquals(limited.effectiveLimit, 1);
      assertEquals(JSON.parse((await turn(setCapacity)).result), limited);
      assertEquals(confirmations.length, beforeCapacity + 2);
      await withGateway(async (reconnected) => {
        assertEquals(JSON.parse((await reconnected(capacity)).result), limited);
        assertEquals(
          JSON.parse(
            (await reconnected({ ...capacity, action: "reset_worker_limit" }))
              .result,
          ).effectiveLimit,
          3,
        );
      });

      assertEquals(
        JSON.parse((await turn({ action: "resume", ...exact })).result).run
          .status,
        "running",
      );

      const localInventory = JSON.parse(
        (await turn({
          action: "inventory",
          ...peer,
        })).result,
      ).page;
      assertEquals(localInventory.assets.map(({ id }: { id: string }) => id), [
        traffic.assetIds[0],
        "peer-asset",
        "peer-unselected",
      ]);
      const organizations = JSON.parse(
        (await turn({
          action: "inventory",
          ...peer,
          view: "organizations",
          organizationId: "peer-ops",
        })).result,
      ).page.organizations;
      assertEquals(organizations, [{
        id: "peer-ops",
        label: "Operations",
        assetCount: 1,
      }]);
      const peerRunId = JSON.parse(
        (await turn({
          action: "inspect",
          ...peer,
        })).result,
      ).run.details.runId;
      const membership = {
        ...peer,
        runId: peerRunId,
        organizationId: "peer-ops",
      };
      const preview = JSON.parse(
        (await turn({
          action: "preview_membership",
          ...membership,
        })).result,
      );
      assertEquals(preview.membership.assetIds, ["peer-asset"]);
      assertEquals(
        preview.membership.snapshotDigest,
        localInventory.snapshotDigest,
      );
      assertStringIncludes(
        (await turn({
          action: "preview_membership",
          ...membership,
          organizationId: "other-workspace",
        })).result,
        "unavailable",
      );
      const updateMembership = {
        action: "set_case_membership",
        ...membership,
        expectedVersion: 0,
        requestId: crypto.randomUUID(),
      };
      const beforeMembership = confirmations.length;
      denied = "PRE_TOOL_CALL";
      assert((await turn(updateMembership)).result);
      assertEquals(confirmations.length, beforeMembership);
      assertEquals(readSentinelOperatingConstraints(peerPath), undefined);
      denied = undefined;
      const applied = JSON.parse((await turn(updateMembership)).result);
      assertEquals(applied.version, 1);
      assertEquals(applied.sourceDigest, preview.membership.snapshotDigest);
      assertEquals(
        JSON.parse((await turn(updateMembership)).result),
        applied,
      );
      assertEquals(confirmations.length, beforeMembership + 1);
      assertStringIncludes((await turn(trafficHint)).result, "unavailable");
      assertEquals(confirmations.length, beforeMembership + 1);

      duringConfirmation = () => {
        const snapshot = JSON.parse(Deno.readTextFileSync(peerPath));
        snapshot.nodes.push({
          id: "later-asset",
          kind: "asset",
          label: "Later publication",
          organization: { id: "peer-ops", label: "Operations" },
        });
        Deno.writeTextFileSync(peerPath, JSON.stringify(snapshot));
        refreshSentinelAssessment(peerPath);
      };
      assertStringIncludes(
        (await turn({
          ...updateMembership,
          expectedVersion: 1,
          requestId: crypto.randomUUID(),
        })).result,
        "unavailable",
      );
      duringConfirmation = undefined;
      const nextPeer = readSentinelAssessment(peerPath);
      assert(nextPeer);
      assertStringIncludes((await turn(trafficHint)).result, "unavailable");

      assertEquals(
        JSON.parse((await turn(receiptAction)).result).record,
        original,
      );
      assertStringIncludes(
        (await turn({ ...receiptAction, revision: nextPeer.revision })).result,
        "unavailable",
      );
      assertStringIncludes(
        (await turn({ ...continuation, revision: nextPeer.revision })).result,
        "unavailable",
      );
      assertEquals(
        JSON.parse((await turn(followLink)).result).receipt.digest,
        traffic.digest,
      );
      assertStringIncludes(
        (await turn({ ...followLink, revision: nextPeer.revision })).result,
        "unavailable",
      );
      assert(nextPeer.revision > peer.revision);
      const rechecks = openSentinelWorkerFindingStore(peerPath);
      try {
        const recheck = rechecks.recordRecheck({
          ...original,
          findingId: original.id,
          outcome: "pass",
          evidenceRevision: nextPeer.revision,
          evidenceId: "fixture-passing-evidence",
          taskId: "fixture-recheck-review",
          observedAt: "2026-01-02T00:00:00.000Z",
          requestId: crypto.randomUUID(),
        });
        assertEquals(
          JSON.parse(
            (await turn({
              ...receiptAction,
              revision: nextPeer.revision,
              receiptId: recheck.id,
            })).result,
          ).record,
          recheck,
        );
        const amendReport = () =>
          rechecks.updateFindingReport({
            caseId: original.caseId,
            runId: original.runId,
            targetId: original.targetId,
            evidenceRevision: nextPeer.revision,
            taskId: recheck.taskId,
            requestId: crypto.randomUUID(),
            findingId: original.id,
            expectedVersion: 1,
            title: "Updated finding",
            summary: "Retained remediation evidence was reviewed.",
          });
        const edited: { amendment?: ReturnType<typeof amendReport> } = {};
        duringConfirmation = () => {
          edited.amendment = amendReport();
        };
        const currentTraffic = readSentinelTrafficReceiptPage(
          peerPath,
          nextPeer.revision,
        )?.receipts[0];
        assert(currentTraffic);
        const staleAttachment = {
          ...attachTraffic,
          revision: nextPeer.revision,
          requestId: crypto.randomUUID(),
          evidenceId: currentTraffic.evidenceId,
          digest: currentTraffic.digest,
          recheckId: recheck.id,
        };
        assertStringIncludes(
          (await turn(staleAttachment)).result,
          "unavailable",
        );
        duringConfirmation = undefined;
        const { amendment } = edited;
        assert(amendment);
        const attachedRecheck = JSON.parse(
          (await turn({
            ...staleAttachment,
            reportVersion: 2,
          })).result,
        ).link;
        assertEquals(attachedRecheck.recheckId, recheck.id);
        assertEquals(attachedRecheck.reportVersion, 2);
        const reportAction = {
          ...receiptAction,
          action: "finding_report",
          revision: nextPeer.revision,
        };
        const current = JSON.parse((await turn(reportAction)).result).report;
        assertEquals(current, {
          findingId: original.id,
          version: 2,
          latestVersion: 2,
          sourceReceiptId: amendment.id,
          evidenceRevision: nextPeer.revision,
          taskId: recheck.taskId,
          title: amendment.title,
          summary: amendment.summary,
          remediation: { status: "unknown", asOfRevision: nextPeer.revision },
        });
        const prior = JSON.parse(
          (await turn({
            ...reportAction,
            reportVersion: 1,
          })).result,
        ).report;
        assertEquals(prior.sourceReceiptId, original.id);
        assertEquals(prior.summary, original.summary);
        const archived = { ...reportAction, revision: peer.revision };
        assertEquals(
          JSON.parse((await turn(archived)).result).report.version,
          1,
        );
        assertStringIncludes(
          (await turn({ ...archived, reportVersion: 2 })).result,
          "unavailable",
        );
        assertStringIncludes(
          (await turn({ ...reportAction, ...exact })).result,
          "unavailable",
        );
        const historyAction = {
          ...reportAction,
          action: "finding_report_history",
          limit: 1,
        };
        const first = JSON.parse((await turn(historyAction)).result).page;
        assertEquals(first.latestVersion, 2);
        assertEquals(first.versions, [{
          version: 2,
          sourceReceiptId: amendment.id,
          evidenceRevision: nextPeer.revision,
          taskId: recheck.taskId,
          authority: "worker",
          recordedAt: amendment.recordedAt,
        }]);
        assert(typeof first.nextCursor === "string");
        assertEquals(
          JSON.parse(
            (await turn({
              ...reportAction,
              reportVersion: first.versions[0].version,
            })).result,
          ).report.sourceReceiptId,
          first.versions[0].sourceReceiptId,
        );
        assertStringIncludes(
          (await turn({
            ...historyAction,
            revision: peer.revision,
            cursor: first.nextCursor,
          })).result,
          "unavailable",
        );
        assertStringIncludes(
          (await turn({ ...historyAction, ...exact, cursor: first.nextCursor }))
            .result,
          "unavailable",
        );
        const otherFinding = rechecks.recordFinding({
          ...original,
          evidenceRevision: nextPeer.revision,
          requestId: crypto.randomUUID(),
          title: "Separate finding in the same case",
        });
        assert(otherFinding.id !== original.id);
        assertStringIncludes(
          (await turn({
            ...historyAction,
            receiptId: otherFinding.id,
            cursor: first.nextCursor,
          })).result,
          "unavailable",
        );
        assertStringIncludes(
          (await turn({
            ...historyAction,
            cursor: first.nextCursor.replace(
              /.$/,
              first.nextCursor.endsWith("0") ? "1" : "0",
            ),
          })).result,
          "unavailable",
        );
        const newer = rechecks.updateFindingReport({
          ...amendment,
          expectedVersion: 2,
          requestId: crypto.randomUUID(),
          title: "A newer same-revision report version",
        });
        assertEquals(newer.version, 3);
        const second = JSON.parse(
          (await turn({
            ...historyAction,
            cursor: first.nextCursor,
          })).result,
        ).page;
        assertEquals(second.latestVersion, 2);
        assertEquals(second.versions, [{
          version: 1,
          sourceReceiptId: original.id,
          evidenceRevision: peer.revision,
          taskId: original.taskId,
          authority: "worker",
          recordedAt: original.recordedAt,
          evidenceId: original.evidenceId,
        }]);
        assertEquals(second.nextCursor, null);
        assertEquals(
          JSON.parse((await turn(historyAction)).result).page.latestVersion,
          3,
        );
      } finally {
        rechecks.close();
      }
      assertEquals(readSentinelOperatingConstraints(peerPath)?.version, 1);
      const currentMembership = JSON.parse(
        (await turn({
          action: "inventory",
          ...peer,
          revision: nextPeer.revision,
          scope: "membership",
        })).result,
      ).page;
      assertEquals(
        currentMembership.assets.map(({ id }: { id: string }) => id),
        ["peer-asset"],
      );
      const historicalInventory = JSON.parse(
        (await turn({
          action: "inventory",
          ...peer,
          scope: "membership",
          view: "coverage",
          coverageGap: "unreviewed",
        })).result,
      ).page;
      assertEquals(
        historicalInventory.assets.map(
          ({ asset }: { asset: { id: string } }) => asset.id,
        ),
        ["peer-asset"],
      );
      const currentVerificationGaps = JSON.parse(
        (await turn({
          action: "inventory",
          ...peer,
          scope: "membership",
          view: "coverage",
          coverageGap: "missing_current_verification",
          asOf: "2026-11-25T00:00:00.000Z",
        })).result,
      ).page;
      assertEquals(
        currentVerificationGaps.assets.map(
          ({ asset }: { asset: { id: string } }) => asset.id,
        ),
        ["peer-asset"],
      );
      const selectedArchive = readSentinelAssessmentRevision(
        peerPath,
        peer.revision,
      );
      assert(selectedArchive);
      const archive = JSON.parse(renderSentinelProvenanceJson(
        peer.id,
        selectedArchive,
        undefined,
        peerPath,
      ));
      assertEquals(archive.operatingConstraints.membership, preview.membership);
      const launched =
        JSON.parse((await turn({ action: "start", ...configured })).result).run;
      const workflowId = launched.ref.id;
      assert(typeof workflowId === "string" && workflowId !== plan.id);
      activeRunId = workflowId;
      const workflow = { kind: "workflow", id: workflowId };
      assertEquals(
        JSON.parse((await turn({ action: "pause", ...workflow })).result).run
          .status,
        "paused",
      );
      const workflowTrace = { action: "traces", ...workflow };
      const initialTrace = JSON.parse(
        (await turn({ ...workflowTrace, limit: 1 })).result,
      ).page;
      assertEquals(
        initialTrace.events.map(({ event }: { event: string }) => event),
        ["admitted"],
      );
      assert(typeof initialTrace.nextCursor === "string");
      const nextTrace = JSON.parse(
        (await turn({
          ...workflowTrace,
          cursor: initialTrace.nextCursor,
          limit: 3,
        })).result,
      ).page;
      assert(
        nextTrace.events.some(({ event }: { event: string }) =>
          event === "paused"
        ),
      );
      assertStringIncludes(
        (await turn({
          ...workflowTrace,
          id: unrelated,
          cursor: initialTrace.nextCursor,
        })).result,
        "unavailable",
      );
      const mixedSearch = {
        action: "search_case_traces",
        query: "",
        scopes: [searchCases.scopes[0], { ...workflow }],
      };
      const mixedFirst = JSON.parse((await turn(mixedSearch)).result).pages;
      assertEquals(mixedFirst[0].page.steps[0].taskId, localTraceTask);
      assertEquals(mixedFirst[1], { run: workflow, page: initialTrace });
      const mixedNext = {
        ...mixedSearch,
        limit: 3,
        scopes: [
          { ...searchCases.scopes[0], offset: 1 },
          { ...workflow, cursor: initialTrace.nextCursor },
        ],
      };
      const mixedPages = JSON.parse((await turn(mixedNext)).result).pages;
      assertEquals(mixedPages[0].page.steps[0].index, 1);
      assertEquals(mixedPages[1].page, nextTrace);
      const paused = mixedPages[1].page.events.find((
        { event }: { event: string },
      ) => event === "paused");
      assertEquals(
        JSON.parse(
          (await turn({
            ...workflowTrace,
            sequence: paused.sequence,
          })).result,
        ).page.events,
        [paused],
      );
      for (
        const request of [
          { ...mixedNext, query: "paused" },
          {
            ...mixedNext,
            scopes: [mixedNext.scopes[0], { ...workflow, id: unrelated }],
          },
        ]
      ) {
        const response = (await turn(request)).result;
        assertStringIncludes(response, "unavailable");
        assert(!response.includes(localTraceTask));
      }
      const filtered =
        JSON.parse((await turn({ ...mixedSearch, query: "paused" })).result)
          .pages;
      assertEquals(filtered[0].page.steps, []);
      assertEquals(filtered[1].page.events, [paused]);
      denied = "POST_TOOL_RESPONSE";
      assertEquals(
        (await turn(workflowTrace)).result,
        "Tool response withheld by policy.",
      );
      denied = "PRE_OUTPUT";
      const blockedTrace = await turn(workflowTrace);
      assertEquals(blockedTrace.response, undefined);
      assert(blockedTrace.error);
      denied = undefined;
      const link = {
        action: "link",
        ...exact,
        targetKind: "workflow",
        targetId: workflowId,
        requestId: crypto.randomUUID(),
      };
      const beforeLink = confirmations.length;
      linkReceipt = JSON.parse((await turn(link)).result).link;
      assert(linkReceipt);
      assertEquals(JSON.parse((await turn(link)).result).link, linkReceipt);
      assertEquals(confirmations.length, beforeLink + 1);
      assertStringIncludes(
        (await turn({
          ...link,
          revision: undefined,
          requestId: crypto.randomUUID(),
        })).result,
        "unavailable",
      );
      const queried = JSON.parse(
        (await turn({ action: "inspect", ...workflow })).result,
      );
      assertEquals(queried.links, [linkReceipt]);
      assertEquals(queried.run.ref, workflow);
      assertEquals(Object.keys(queried.run.details).sort(), [
        "currentStep",
        "steps",
      ]);
      assert(
        queried.run.details.steps.every((step: object) =>
          Object.keys(step).sort().join(",") === "id,status"
        ),
      );
      assertStringIncludes(
        (await turn({ action: "inspect", kind: "workflow", id: unrelated }))
          .result,
        "unavailable",
      );
      const list = await turn({ action: "list" });
      assert(!list.result.includes(hiddenEvidence));
      assert(!list.result.includes(unrelated));
      assertEquals(
        JSON.parse(list.result).runs.map(({ ref }: { ref: { id: string } }) =>
          ref.id
        ).sort(),
        [
          workflowId,
          plan.id,
          sentinel.id,
          peer.id,
          searchLeft.run.id,
          searchRight.run.id,
        ].sort(),
      );

      denied = "POST_TOOL_RESPONSE";
      assertEquals(
        (await turn({ action: "inspect", ...exact })).result,
        "Tool response withheld by policy.",
      );
      denied = "PRE_OUTPUT";
      const blocked = await turn({ action: "inspect", ...exact });
      assertEquals(JSON.parse(blocked.result).run.ref, exact);
      assertEquals(blocked.response, undefined);
      assert(blocked.error);
      assertEquals(evaluated.at(-1), {
        hook: "PRE_OUTPUT",
        taint: "INTERNAL",
        target: "INTERNAL",
      });
      denied = undefined;

      assertEquals(
        JSON.parse((await turn({ action: "resume", ...workflow })).result).run
          .status,
        "running",
      );
      await until(() => workflows.inspect(workflowId)?.status === "completed");
      const pending = JSON.parse(
        (await turn({ action: "start", ...interruptedRequest })).result,
      ).run;
      pausedRunId = pending.ref.id;
      assert(pausedRunId);
      assertEquals(
        JSON.parse(
          (await turn({ action: "pause", kind: "workflow", id: pausedRunId }))
            .result,
        ).run.status,
        "paused",
      );
    });

    const restarted = createOperatorWorkflowRuns(createWorkflowRunRegistry(), [
      plan,
    ], journalPath);
    await withGateway(async (turn) => {
      assert(sentinelRevision && activeRunId);
      const exact = { ...sentinel, revision: sentinelRevision };
      const sentinelView = JSON.parse(
        (await turn({ action: "inspect", ...exact })).result,
      );
      assertEquals(sentinelView.run.ref, exact);
      assertEquals(sentinelView.links, [linkReceipt]);
      assert(assignmentRequest);
      const approvalsBeforeReplay = confirmations.length;
      assertEquals(
        JSON.parse((await turn(assignmentRequest)).result).receipt,
        assignmentReceipt,
      );
      assertEquals(confirmations.length, approvalsBeforeReplay);
      const workflow = { kind: "workflow", id: activeRunId };
      const workflowView = JSON.parse(
        (await turn({ action: "inspect", ...workflow })).result,
      );
      assertEquals(workflowView.run.ref, workflow);
      assertEquals(workflowView.run.status, "completed");
      const trace = JSON.parse(
        (await turn({ action: "traces", ...workflow })).result,
      ).page;
      assertEquals(trace.events.at(-1).event, "completed");
      const step = trace.events.find(
        ({ event }: { event: string }) => event === "step_completed",
      );
      assert(step);
      const workflowSearch = {
        action: "traces",
        ...workflow,
        query: "STEP_COMPLETED",
        limit: 1,
      };
      const firstWorkflowMatch =
        JSON.parse((await turn(workflowSearch)).result).page;
      assertEquals(firstWorkflowMatch.events, [step]);
      assert(typeof firstWorkflowMatch.nextCursor === "string");
      const remainingWorkflowMatches = JSON.parse(
        (await turn({
          ...workflowSearch,
          cursor: firstWorkflowMatch.nextCursor,
        })).result,
      ).page;
      assertEquals(
        remainingWorkflowMatches.events.map(
          ({ stepId }: { stepId: string }) => stepId,
        ),
        ["record"],
      );
      assertStringIncludes(
        (await turn({
          ...workflowSearch,
          query: "record",
          cursor: firstWorkflowMatch.nextCursor,
        })).result,
        "unavailable",
      );
      assertEquals(
        JSON.parse(
          (await turn({
            action: "traces",
            ...workflow,
            sequence: step.sequence,
          })).result,
        ).page.events,
        [step],
      );
      assertStringIncludes(
        (await turn({
          action: "traces",
          ...workflow,
          sequence: 300,
        })).result,
        "unavailable",
      );

      assertEquals(workflowView.links, [linkReceipt]);
      const repeated =
        JSON.parse((await turn({ action: "start", ...configured })).result).run;
      assertEquals(repeated.ref, workflow);
      assert(pausedRunId);
      const pausedRef = { kind: "workflow", id: pausedRunId };
      const interrupted =
        JSON.parse((await turn({ action: "inspect", ...pausedRef })).result)
          .run;
      assertEquals(interrupted.ref, pausedRef);
      assertEquals(interrupted.status, "interrupted");
      const repeatedPending = JSON.parse(
        (await turn({ action: "start", ...interruptedRequest })).result,
      ).run;
      assertEquals(repeatedPending.ref, pausedRef);
      assertEquals(repeatedPending.status, "interrupted");
      assertEquals(
        restarted.list().map(({ runId }) => runId).sort(),
        [activeRunId, pausedRunId].sort(),
      );
      assertStringIncludes(
        (await turn({ action: "resume", ...pausedRef })).result,
        "unavailable",
      );
      const journal = createOperatorWorkflowJournal(journalPath);
      const prior = journal.readRequest(configured.requestId);
      assert(prior);
      const recoveryId = crypto.randomUUID();
      const at = new Date().toISOString();
      assert(
        journal.admit({
          ...prior,
          runId: recoveryId,
          requestId: crypto.randomUUID(),
          status: "running",
          startedAt: at,
          completedAt: null,
          stepStatuses: '["pending","pending"]',
        }).admitted,
      );
      journal.update(recoveryId, "running", null, '["running","pending"]', {
        event: "step_started",
        stepId: plan.steps[0].id,
        at,
      });
      journal.update(recoveryId, "running", null, '["completed","pending"]', {
        event: "step_completed",
        stepId: plan.steps[0].id,
        at,
      });
      const recoveryRef = { kind: "workflow", id: recoveryId };
      const archiveId = crypto.randomUUID();
      const archive = {
        action: "archive",
        ...recoveryRef,
        requestId: archiveId,
      };
      const beforeArchive = confirmations.length;
      denied = "PRE_TOOL_CALL";
      await turn(archive);
      assertEquals(confirmations.length, beforeArchive);
      denied = undefined;
      const archived = JSON.parse((await turn(archive)).result).receipt;
      assertEquals(archived.status, "succeeded");
      assertEquals(confirmations.length, beforeArchive + 1);
      assertEquals(JSON.parse((await turn(archive)).result).receipt, archived);
      leaveArchiveActionPending(baseDir, archiveId);
      await withGateway(async (reconnected) => {
        const recovered =
          JSON.parse((await reconnected(archive)).result).receipt;
        assertEquals(recovered.status, "succeeded");
        assertEquals(recovered.archiveDigest, archived.archiveDigest);
        assertEquals(confirmations.length, beforeArchive + 1);
      }, restarted);

      const originalTrace = restarted.traces(recoveryId, "INTERNAL", {
        sequence: 3,
      });
      const receiving = createOperatorWorkflowRuns(
        createWorkflowRunRegistry(),
        [plan],
        join(baseDir, "receiving-workflows.db"),
      );
      const restore = {
        action: "restore",
        ...recoveryRef,
        archiveId,
        requestId: crypto.randomUUID(),
      };
      assertEquals(
        JSON.parse(
          (await turn({
            ...restore,
            requestId: crypto.randomUUID(),
          })).result,
        ).receipt.status,
        "failed",
      );
      await withGateway(async (restoreTurn) => {
        const artifact = join(
          baseDir,
          "data",
          "run-archives",
          archiveId,
          "workflow.json",
        );
        const content = await Deno.readTextFile(artifact);
        await Deno.writeTextFile(artifact, "{}");
        assertEquals(
          JSON.parse(
            (await restoreTurn({
              ...restore,
              requestId: crypto.randomUUID(),
            })).result,
          ).receipt.status,
          "failed",
        );
        assertEquals(receiving.inspect(recoveryId), undefined);
        await Deno.writeTextFile(artifact, content);
        const restored =
          JSON.parse((await restoreTurn(restore)).result).receipt;
        assertEquals(restored.status, "succeeded");
        assertEquals(
          JSON.parse((await restoreTurn(restore)).result).receipt,
          restored,
        );
        leaveArchiveActionPending(baseDir, restore.requestId);
        const beforeRetry = confirmations.length;
        await withGateway(async (reconnected) => {
          const retried =
            JSON.parse((await reconnected(restore)).result).receipt;
          assertEquals(retried.status, "succeeded");
          assertEquals(retried.requestId, restored.requestId);
          assertEquals(confirmations.length, beforeRetry);
        }, receiving);
        assertEquals(receiving.inspect(recoveryId)?.status, "paused");
        assertEquals(
          JSON.parse(
            (await restoreTurn({
              action: "traces",
              ...recoveryRef,
              sequence: 3,
            })).result,
          ).page,
          originalTrace,
        );
        await restoreTurn({ action: "resume", ...recoveryRef });
        await until(() =>
          receiving.inspect(recoveryId)?.status === "completed"
        );
        const events = receiving.traces(recoveryId, "INTERNAL", { limit: 20 })
          ?.events;
        assertEquals(
          events?.filter((event) =>
            event.event === "step_completed" &&
            event.stepId === plan.steps[0].id
          ).length,
          1,
        );
      }, receiving);
      await turn({ action: "resume", ...recoveryRef });
      await until(() => restarted.inspect(recoveryId)?.status === "completed");
      const recovered = restarted.traces(recoveryId, "INTERNAL", { limit: 20 });
      assertEquals(
        recovered?.events.flatMap((event) =>
          "stepId" in event ? [[event.event, event.stepId]] : []
        ),
        [
          ["step_started", plan.steps[0].id],
          ["step_completed", plan.steps[0].id],
          ["step_started", plan.steps[1].id],
          ["step_completed", plan.steps[1].id],
        ],
      );

      const runId = sentinelView.run.details.runId;
      assert(typeof runId === "string");
      const scope = { ...exact, runId };
      const read = { action: "constraints", ...scope };
      const narrow = {
        action: "narrow_constraints",
        ...scope,
        expectedVersion: 0,
        deniedKinds: ["impact"],
        requestId: crypto.randomUUID(),
      };
      assertEquals(JSON.parse((await turn(read)).result).version, 0);
      denied = "PRE_TOOL_CALL";
      const beforeConstraints = confirmations.length;
      await turn(narrow);
      assertEquals(confirmations.length, beforeConstraints);
      assertEquals(readSentinelOperatingConstraints(path, runId), undefined);
      denied = undefined;
      approved = false;
      assertStringIncludes((await turn(narrow)).result, "operator declined");
      assertEquals(readSentinelOperatingConstraints(path, runId), undefined);
      approved = true;
      assertStringIncludes(
        (await turn({ ...narrow, runId: crypto.randomUUID() })).result,
        "unavailable",
      );
      assertStringIncludes(
        (await turn({ ...narrow, deniedKinds: ["run_command"] })).result,
        "unavailable",
      );
      assertStringIncludes(
        (await turn({ ...narrow, allowedAssetIds: ["unknown-asset"] })).result,
        "unavailable",
      );
      const accepted = JSON.parse((await turn(narrow)).result).record;
      assertEquals(accepted.version, 1);
      assertEquals(accepted.constraints, { deniedKinds: ["impact"] });
      assertEquals(JSON.parse((await turn(narrow)).result).record, accepted);
      assertEquals(
        JSON.parse((await turn({ ...read, version: 1 })).result).history,
        [accepted],
      );
      const restored = JSON.parse(
        (await turn({
          ...narrow,
          expectedVersion: 1,
          requestId: crypto.randomUUID(),
          deniedKinds: [],
        })).result,
      ).record;
      assertEquals(restored.version, 2);
      assertEquals(restored.constraints, { deniedKinds: [] });
      assertEquals(readSentinelOperatingConstraints(path, runId), restored);
      denied = "POST_TOOL_RESPONSE";
      assertEquals(
        (await turn(read)).result,
        "Tool response withheld by policy.",
      );
      denied = "PRE_OUTPUT";
      const blockedConstraints = await turn(read);
      assertEquals(blockedConstraints.response, undefined);
      assert(blockedConstraints.error);
      denied = undefined;

      const changed = JSON.parse(await Deno.readTextFile(path));
      changed.nodes.push({
        id: "new-evidence",
        kind: "evidence",
        label: "New retained record",
      });
      duringConfirmation = () => {
        Deno.writeTextFileSync(path, JSON.stringify(changed));
        assert(
          (refreshSentinelAssessment(path)?.revision ?? 0) > sentinelRevision!,
        );
      };
      try {
        assertStringIncludes(
          (await turn({
            ...narrow,
            expectedVersion: 2,
            requestId: crypto.randomUUID(),
            deniedKinds: ["impact", "trace"],
          })).result,
          "unavailable",
        );
      } finally {
        duringConfirmation = undefined;
      }
      assertEquals(readSentinelOperatingConstraints(path, runId)?.version, 2);
      assertEquals(JSON.parse((await turn(read)).result).history, [
        restored,
        accepted,
      ]);
      const spawn = {
        action: "spawn",
        ...exact,
        targetKind: "workflow",
        targetId: plan.id,
        requestId: crypto.randomUUID(),
      };
      const initialChildren = restarted.list().length;
      const initialApprovals = confirmations.length;
      denied = "PRE_TOOL_CALL";
      await turn(spawn);
      assertEquals(confirmations.length, initialApprovals);
      assertEquals(restarted.list().length, initialChildren);
      denied = undefined;

      const collision = { ...spawn, requestId: crypto.randomUUID() };
      duringConfirmation = () => {
        const journal = openOperatorRunLinkStore(
          join(baseDir, "operator-run-links.db"),
        );
        try {
          journal.record({
            scope: "workspace-operator",
            operatorId: "owner",
            requestId: collision.requestId,
            left: { kind: "sentinel", id: exact.id, revision: exact.revision },
            right: { kind: "workflow", id: workflow.id },
          });
        } finally {
          journal.close();
        }
      };
      try {
        assertStringIncludes((await turn(collision)).result, "unavailable");
      } finally {
        duringConfirmation = undefined;
      }
      assertEquals(restarted.list().length, initialChildren);

      const linked = JSON.parse((await turn(spawn)).result);
      assertEquals(linked.run.label, plan.id);
      assertEquals(linked.link.left, exact);
      assertEquals(linked.link.right, linked.run.ref);
      assertEquals(restarted.list().length, initialChildren + 1);
      const approvalsAfterCreation = confirmations.length;
      assertEquals(JSON.parse((await turn(spawn)).result).link, linked.link);
      assertEquals(confirmations.length, approvalsAfterCreation);
      assertStringIncludes(
        (await turn({ ...spawn, id: peer.id, revision: peer.revision })).result,
        "unavailable",
      );
      await until(() =>
        restarted.inspect(linked.run.ref.id)?.status === "completed"
      );
      const reopenedWorkflows = createOperatorWorkflowRuns(
        createWorkflowRunRegistry(),
        [plan],
        journalPath,
      );
      await withGateway(async (reopenTurn) => {
        const reopened = JSON.parse((await reopenTurn(spawn)).result);
        assertEquals(reopened.link, linked.link);
        assertEquals(reopened.run.status, "completed");
        assertEquals(confirmations.length, approvalsAfterCreation);
        const child = JSON.parse(
          (await reopenTurn({ action: "inspect", ...linked.run.ref })).result,
        );
        assertEquals(child.links, [linked.link]);
      }, reopenedWorkflows);

      const templateCategoryId = crypto.randomUUID();
      const templateCategoryTitle = "Template assessments";
      const firstTemplateCategory = JSON.parse(
        (await turn({
          action: "create_run_category",
          title: templateCategoryTitle,
          requestId: templateCategoryId,
        })).result,
      ).receipt.category;
      assertEquals(firstTemplateCategory, {
        id: templateCategoryId,
        version: 1,
        title: templateCategoryTitle,
      });
      const templateCategory = { id: templateCategoryId, version: 1 };
      const templateId = crypto.randomUUID();
      const saveTemplate = {
        action: "set_assessment_template",
        templateId,
        templateVersion: 0,
        requestId: crypto.randomUUID(),
        title: "Review configuration",
        category: templateCategory,
        childDescription: "Configuration baseline review",
        childGoal: "Compare approved configuration to the baseline.",
      };
      const beforeTemplateApproval = confirmations.length;
      denied = "PRE_TOOL_CALL";
      await turn(saveTemplate);
      denied = undefined;
      assertEquals(confirmations.length, beforeTemplateApproval);
      approved = false;
      try {
        assertStringIncludes(
          (await turn(saveTemplate)).result,
          "operator declined",
        );
      } finally {
        approved = true;
      }
      assertEquals(
        JSON.parse((await turn({ action: "assessment_templates" })).result)
          .templates,
        [],
      );
      const firstTemplate =
        JSON.parse((await turn(saveTemplate)).result).template;
      assertEquals(firstTemplate.version, 1);
      assertEquals(
        JSON.parse((await turn(saveTemplate)).result).template,
        firstTemplate,
      );
      const templateSelection = {
        action: "spawn",
        ...exact,
        targetKind: "sentinel",
        initialGraph: "empty",
        templateId,
        templateVersion: 1,
      };
      const firstTemplateStart = {
        ...templateSelection,
        targetId: "template-run-one",
        requestId: crypto.randomUUID(),
      };
      const templatedRun = JSON.parse((await turn(firstTemplateStart)).result);
      assertEquals(templatedRun.run.label, firstTemplate.description);
      assertEquals(templatedRun.template, { id: templateId, version: 1 });
      assertEquals(
        readSentinelAssessment(
          resolveSentinelCasePath(baseDir, firstTemplateStart.targetId),
        )?.plan.goal,
        firstTemplate.objective,
      );
      assertEquals(
        JSON.parse(confirmations.at(-1)!.split("\n").at(-1)!).template,
        firstTemplate,
      );
      assertEquals(firstTemplate.category, firstTemplateCategory);
      assertEquals(templatedRun.admissionCategory, firstTemplateCategory);
      const renameTemplateCategory = JSON.parse(
        (await turn({
          action: "rename_run_category",
          categoryId: templateCategoryId,
          expectedVersion: 1,
          requestId: crypto.randomUUID(),
          title: "Updated assessment group",
        })).result,
      ).receipt.category;
      assertEquals(renameTemplateCategory.version, 2);
      const staleTemplateStart = {
        ...firstTemplateStart,
        requestId: crypto.randomUUID(),
        targetId: "stale-template-category",
      };
      assertStringIncludes(
        (await turn(staleTemplateStart)).result,
        "unavailable",
      );
      assertEquals(
        readSentinelAssessment(
          resolveSentinelCasePath(baseDir, staleTemplateStart.targetId),
        ),
        undefined,
      );
      const changeTemplate = {
        ...saveTemplate,
        templateVersion: 1,
        requestId: crypto.randomUUID(),
        childGoal: "Review configuration drift against the baseline.",
        category: { id: templateCategoryId, version: 2 },
      };
      const secondTemplate =
        JSON.parse((await turn(changeTemplate)).result).template;
      assertEquals(secondTemplate.version, 2);
      assertStringIncludes(
        (await turn({ ...saveTemplate, requestId: crypto.randomUUID() }))
          .result,
        "unavailable",
      );
      assertStringIncludes(
        (await turn({
          ...templateSelection,
          targetId: "template-stale-run",
          requestId: crypto.randomUUID(),
        })).result,
        "unavailable",
      );
      assertStringIncludes(
        (await turn({
          ...firstTemplateStart,
          templateVersion: 2,
        })).result,
        "unavailable",
      );
      await withGateway(async (afterTemplateRestart) => {
        const beforeReplay = confirmations.length;
        assertEquals(
          JSON.parse((await afterTemplateRestart(firstTemplateStart)).result),
          templatedRun,
        );
        assertEquals(confirmations.length, beforeReplay);
        assertEquals(
          JSON.parse(
            (await afterTemplateRestart({ action: "assessment_templates" }))
              .result,
          ).templates,
          [secondTemplate],
        );
        const second = {
          ...templateSelection,
          templateVersion: 2,
          requestId: crypto.randomUUID(),
          targetId: "template-run-two",
        };
        assertEquals(
          JSON.parse((await afterTemplateRestart(second)).result).run.label,
          secondTemplate.description,
        );
        assertEquals(
          readSentinelAssessment(
            resolveSentinelCasePath(baseDir, second.targetId),
          )?.plan.goal,
          secondTemplate.objective,
        );
      }, reopenedWorkflows);

      const withdrawal = {
        action: "withdraw_assessment_template",
        templateId,
        templateVersion: 2,
        requestId: crypto.randomUUID(),
      };
      const beforeWithdrawal = confirmations.length;
      denied = "PRE_TOOL_CALL";
      await turn(withdrawal);
      denied = undefined;
      assertEquals(confirmations.length, beforeWithdrawal);
      assertStringIncludes(
        (await turn({ ...withdrawal, templateVersion: 1 })).result,
        "unavailable",
      );
      assertEquals(confirmations.length, beforeWithdrawal);
      approved = false;
      try {
        assertStringIncludes(
          (await turn(withdrawal)).result,
          "operator declined",
        );
      } finally {
        approved = true;
      }
      assertEquals(
        JSON.parse((await turn({ action: "assessment_templates" })).result)
          .templates,
        [secondTemplate],
      );
      const withdrawalReceipt =
        JSON.parse((await turn(withdrawal)).result).withdrawal;
      assertEquals(withdrawalReceipt.id, templateId);
      assertEquals(withdrawalReceipt.version, 2);
      assertEquals(
        JSON.parse(confirmations.at(-1)!.split("\n").at(-1)!).template,
        secondTemplate,
      );
      const afterWithdrawal = confirmations.length;
      await withGateway(async (afterTemplateRestart) => {
        assertEquals(
          JSON.parse((await afterTemplateRestart(withdrawal)).result)
            .withdrawal,
          withdrawalReceipt,
        );
        assertEquals(
          JSON.parse(
            (await afterTemplateRestart({ action: "assessment_templates" }))
              .result,
          ).templates,
          [],
        );
        assertEquals(
          JSON.parse((await afterTemplateRestart(firstTemplateStart)).result),
          templatedRun,
        );
        assertStringIncludes(
          (await afterTemplateRestart({
            ...templateSelection,
            templateVersion: 2,
            requestId: crypto.randomUUID(),
            targetId: "withdrawn-template-run",
          })).result,
          "unavailable",
        );
        assertStringIncludes(
          (await afterTemplateRestart({
            ...changeTemplate,
            templateVersion: 2,
            requestId: crypto.randomUUID(),
          })).result,
          "unavailable",
        );
        assertEquals(confirmations.length, afterWithdrawal);
      }, reopenedWorkflows);

      const direct = {
        ...exact,
        action: "spawn",
        targetKind: "sentinel",
        targetId: "direct-categorized-child",
        initialGraph: "empty",
        requestId: crypto.randomUUID(),
        category: { id: templateCategoryId, version: 2 },
      };
      const linkedWithCategory = JSON.parse((await turn(direct)).result);
      assertEquals(
        linkedWithCategory.admissionCategory,
        renameTemplateCategory,
      );
      const linkJournal = openOperatorRunLinkStore(
        join(baseDir, "operator-run-links.db"),
      );
      try {
        assertEquals(
          linkJournal.categories.forRun({
            kind: "sentinel",
            id: direct.targetId,
            runId: linkedWithCategory.run.details.runId,
          }),
          renameTemplateCategory,
        );
      } finally {
        linkJournal.close();
      }
      const removedCategory = JSON.parse(
        (await turn({
          action: "delete_run_category",
          categoryId: templateCategoryId,
          expectedVersion: 2,
          requestId: crypto.randomUUID(),
        })).result,
      ).receipt;
      assertEquals(removedCategory.categoryId, templateCategoryId);
      await withGateway(async (afterCategoryRestart) => {
        assertEquals(
          JSON.parse((await afterCategoryRestart(direct)).result),
          linkedWithCategory,
        );
      }, reopenedWorkflows);

      const childCase = "linked-sentinel";
      const childPath = resolveSentinelCasePath(baseDir, childCase);
      await Deno.mkdir(dirname(childPath), { recursive: true });
      const childGraph = {
        version: 1,
        nodes: [{
          id: "child-asset",
          kind: "asset",
          label: "Child fixture asset",
          organization: { id: "logging", label: "Logging team" },
        }, {
          id: "other-child-asset",
          kind: "asset",
          label: "Other asset",
          organization: { id: "other", label: "Other team" },
        }],
        edges: [],
      };
      await Deno.writeTextFile(childPath, JSON.stringify(childGraph));
      const childDescription = "Child logging review";
      const childGoal = "Verify logging coverage on the child asset.";
      const seedTask = { kind: "trace", nodeId: "child-asset" };
      const childCriterion = {
        id: "logging-trace",
        description: "Trace the child asset's logging evidence.",
        source: "adaptive_task" as const,
        reference: "task:trace:1:child-asset",
      };
      const goalProposal = {
        goals: [{
          id: "child-logging-proof",
          title: "Verify child logging",
          policy: "operator" as const,
          criteria: [childCriterion],
        }],
        initialConstraints: { deniedKinds: ["impact"] as const },
      };
      const sentinelSpawn = {
        ...spawn,
        childGoal,
        childDescription,
        goalProposal,
        organizationId: "logging",
        seedTask,
        targetKind: "sentinel",
        targetId: childCase,
        requestId: crypto.randomUUID(),
      };
      const beforeChildGoalApproval = confirmations.length;
      for (
        const invalid of [
          { ...spawn, childGoal },
          { ...spawn, childDescription },
          { ...spawn, goalProposal },
          { ...spawn, organizationId: "logging" },
          { ...sentinelSpawn, organizationId: "missing" },
          { ...spawn, seedTask },
          { ...sentinelSpawn, childDescription: " " },
          { ...sentinelSpawn, childDescription: "Review\nLogging" },
          { ...sentinelSpawn, childDescription: "x".repeat(161) },
          { ...sentinelSpawn, seedTask: { ...seedTask, kind: "run_command" } },
          { ...sentinelSpawn, seedTask: { ...seedTask, command: "fixture" } },
          { ...sentinelSpawn, childGoal: " " },
          { ...sentinelSpawn, childGoal: "x".repeat(501) },
        ]
      ) {
        assertStringIncludes((await turn(invalid)).result, "unavailable");
      }
      assertEquals(confirmations.length, beforeChildGoalApproval);
      denied = "PRE_TOOL_CALL";
      await turn(sentinelSpawn);
      assertEquals(confirmations.length, beforeChildGoalApproval);
      assertEquals(readSentinelAssessment(childPath), undefined);
      denied = undefined;
      approved = false;
      assertStringIncludes(
        (await turn(sentinelSpawn)).result,
        "operator declined",
      );
      assertEquals(readSentinelAssessment(childPath), undefined);
      approved = true;
      assertStringIncludes(
        (await turn({
          ...sentinelSpawn,
          seedTask: { ...seedTask, nodeId: "asset-outside-child-case" },
        })).result,
        "unavailable",
      );
      assertEquals(readSentinelAssessment(childPath), undefined);
      assertStringIncludes(
        (await turn({
          ...sentinelSpawn,
          seedTask: { ...seedTask, nodeId: "other-child-asset" },
        })).result,
        "unavailable",
      );
      assertEquals(readSentinelAssessment(childPath), undefined);
      assertStringIncludes(
        (await turn({
          ...sentinelSpawn,
          goalProposal: {
            ...goalProposal,
            initialConstraints: { deniedKinds: ["trace"] },
          },
        })).result,
        "unavailable",
      );
      assertEquals(readSentinelAssessment(childPath), undefined);
      duringConfirmation = () => {
        Deno.writeTextFileSync(
          childPath,
          JSON.stringify({
            ...childGraph,
            nodes: [{
              ...childGraph.nodes[0],
              label: "Changed after approval",
            }],
          }),
        );
      };
      try {
        assertStringIncludes((await turn(sentinelSpawn)).result, "unavailable");
      } finally {
        duringConfirmation = undefined;
      }
      assertEquals(readSentinelAssessment(childPath), undefined);
      const sentinelCollision = {
        ...sentinelSpawn,
        requestId: crypto.randomUUID(),
      };
      duringConfirmation = () => {
        const journal = openOperatorRunLinkStore(
          join(baseDir, "operator-run-links.db"),
        );
        try {
          journal.record({
            scope: "workspace-operator",
            operatorId: "owner",
            requestId: sentinelCollision.requestId,
            left: linked.link.left,
            right: linked.link.right,
          });
        } finally {
          journal.close();
        }
      };
      try {
        assertStringIncludes(
          (await turn(sentinelCollision)).result,
          "unavailable",
        );
      } finally {
        duringConfirmation = undefined;
      }
      assertEquals(readSentinelAssessment(childPath), undefined);
      const linkedSentinel = JSON.parse((await turn(sentinelSpawn)).result);
      assertEquals(linkedSentinel.run.status, "running");
      assertEquals(linkedSentinel.run.label, childDescription);
      assertEquals(linkedSentinel.run.ref, {
        kind: "sentinel",
        id: childCase,
        revision: 1,
      });
      assertEquals(linkedSentinel.link.origin, "spawn");
      assertEquals(linkedSentinel.link.left, linkedSentinel.run.ref);
      assertEquals(linkedSentinel.link.right, exact);
      const childApproval = JSON.parse(
        confirmations.at(-1)!.split("\n").at(-1)!,
      );
      assertEquals(childApproval.childGoal, childGoal);
      assertEquals(childApproval.childDescription, childDescription);
      assertEquals(childApproval.goalApproval.goals, goalProposal.goals);
      assertEquals(childApproval.membership.selector, {
        kind: "organization",
        organizationId: "logging",
      });
      assertEquals(childApproval.membership.assetIds, ["child-asset"]);
      assertEquals(childApproval.seedTask, seedTask);
      const childState = readSentinelAssessment(childPath);
      assert(childState);
      assertEquals(childState.plan.goal, childGoal);
      assertEquals(childState.plan.childDescription, childDescription);
      assertEquals(childState.plan.formalGoals, goalProposal.goals);
      const initialPolicy = readSentinelOperatingConstraints(
        childPath,
        childState.plan.runId,
      );
      assertEquals(
        initialPolicy?.constraints.deniedKinds,
        goalProposal.initialConstraints.deniedKinds,
      );
      assertEquals(initialPolicy?.constraints.allowedAssetIds, ["child-asset"]);
      assertEquals(initialPolicy?.membership, childApproval.membership);
      assertEquals(initialPolicy?.version, 1);
      assert(readSentinelAssessment(path)?.plan.goal !== childGoal);
      const anchoredHint = {
        action: "hint",
        ...linkedSentinel.run.ref,
        requestId: crypto.randomUUID(),
        note: "Review logging on this asset first.",
        assetIds: ["child-asset"],
      };
      const noAnchorApproval = confirmations.length;
      for (const id of ["other-child-asset", "asset-from-another-case"]) {
        assertStringIncludes(
          (await turn({ ...anchoredHint, assetIds: [id] })).result,
          "unavailable",
        );
      }
      assertEquals(confirmations.length, noAnchorApproval);
      approved = false;
      assertStringIncludes(
        (await turn(anchoredHint)).result,
        "operator declined",
      );
      approved = true;
      assertEquals(readSentinelCaseHints(childPath, 10), []);
      assertEquals(
        JSON.parse((await turn(anchoredHint)).result).run.ref,
        linkedSentinel.run.ref,
      );
      const [savedAnchor] = readSentinelCaseHints(childPath, 10);
      assertEquals(savedAnchor.assetIds, anchoredHint.assetIds);
      assertEquals(
        readSentinelCaseHints(
          childPath,
          10,
          undefined,
          childState.revision,
          true,
        ),
        [],
      );
      assertEquals(
        JSON.parse(confirmations.at(-1)!.split("\n").at(-1)!).assetIds,
        anchoredHint.assetIds,
      );

      const readSeed = () =>
        readAdaptiveSentinel(childPath, childState)?.tasks.filter(
          (task) =>
            task.kind === seedTask.kind && task.nodeId === seedTask.nodeId,
        );
      const [committedSeed, ...duplicateSeeds] = readSeed() ?? [];
      assert(committedSeed);
      assertEquals(duplicateSeeds, []);
      assertEquals(committedSeed.status, "completed");
      assertEquals(committedSeed.attempts, 1);
      let plannerObjective: string | undefined;
      let initialInvestigations: unknown;
      let initialGoalCompletion: unknown;
      let initialPlannerRestrictions: unknown;
      let initialAssetHints: unknown;
      const childPlanner = createSentinelModelPlanner(
        childPath,
        (_state, taskId) => ({
          execute(message, send) {
            if (!taskId) {
              assert(typeof message === "string");
              const initialPlan = JSON.parse(message.split("\n").at(-1)!);
              plannerObjective = initialPlan.goal;
              initialInvestigations = initialPlan.currentInvestigations;
              initialGoalCompletion = initialPlan.goalCompletion;
              initialAssetHints = initialPlan.operatorAssetHints;
              initialPlannerRestrictions = initialPlan.operatingConstraints
                ?.restrictions;
            }
            send({
              type: "response",
              text: taskId
                ? '{"summary":"Reviewed the child evidence.","followUps":[]}'
                : '{"assignments":[],"prioritize":[]}',
              taint: "INTERNAL",
            });
            return Promise.resolve();
          },
          clear() {},
        }),
      );
      try {
        childPlanner.advance(childState);
        await until(() => plannerObjective !== undefined);
        assertEquals(plannerObjective, childGoal);
        assertEquals(initialPlannerRestrictions, initialPolicy?.constraints);
        assertEquals(initialAssetHints, [{
          id: savedAnchor.id,
          text: anchoredHint.note,
          assetIds: anchoredHint.assetIds,
        }]);
        assert(
          JSON.stringify(initialGoalCompletion).includes(
            childCriterion.reference,
          ),
        );
        assert(Array.isArray(initialInvestigations));
        assert(
          initialInvestigations.some(({ id, status }) =>
            id === committedSeed.id && status === "completed"
          ),
        );
        await until(() => !childPlanner.hasInFlightWork());
      } finally {
        childPlanner.stop();
      }
      const linkedProvenance = JSON.parse(renderSentinelProvenanceJson(
        childCase,
        childState,
        readAdaptiveSentinel(childPath, childState, "revision") ?? undefined,
        childPath,
      ));
      assertEquals(linkedProvenance.planningHints, [savedAnchor]);
      const lastApproval = confirmations.length;
      await withGateway(async (reopenTurn) => {
        const reopened = JSON.parse((await reopenTurn(sentinelSpawn)).result);
        assertEquals(reopened.link, linkedSentinel.link);
        assertEquals(reopened.run.label, childDescription);
        assertEquals(
          reopened.run.details.runId,
          linkedSentinel.run.details.runId,
        );
        for (
          const different of [
            { ...sentinelSpawn, childGoal: "Check a different control." },
            { ...sentinelSpawn, childGoal: undefined },
            { ...sentinelSpawn, childDescription: undefined },
            { ...sentinelSpawn, childDescription: childDescription + "." },
            { ...sentinelSpawn, goalProposal: undefined },
            { ...sentinelSpawn, organizationId: undefined },
            { ...sentinelSpawn, organizationId: "other" },
            {
              ...sentinelSpawn,
              goalProposal: {
                ...goalProposal,
                initialConstraints: {
                  deniedKinds: ["verify_control_coverage"],
                },
              },
            },
            { ...sentinelSpawn, seedTask: undefined },
            { ...sentinelSpawn, seedTask: { ...seedTask, kind: "impact" } },
          ]
        ) {
          assertStringIncludes(
            (await reopenTurn(different)).result,
            "unavailable",
          );
        }
        assertEquals(
          JSON.parse((await reopenTurn(anchoredHint)).result).run.ref,
          linkedSentinel.run.ref,
        );
        assertStringIncludes(
          (await reopenTurn({ ...anchoredHint, note: "Changed hint." })).result,
          "unavailable",
        );
        assertEquals(confirmations.length, lastApproval);
        assertEquals(readSentinelCaseHints(childPath, 10), [savedAnchor]);
        advanceAdaptiveSentinel(childPath, childState);
        assertEquals(readSeed(), [committedSeed]);
        assertEquals(
          readSentinelOperatingConstraints(childPath, childState.plan.runId),
          initialPolicy,
        );
        assertStringIncludes(
          (await reopenTurn({
            ...sentinelSpawn,
            requestId: crypto.randomUUID(),
          })).result,
          "unavailable",
        );
      }, reopenedWorkflows);

      const emptyCase = "linked-empty-case";
      const emptyPath = resolveSentinelCasePath(baseDir, emptyCase);
      const emptySpawn = {
        ...spawn,
        targetKind: "sentinel",
        targetId: emptyCase,
        initialGraph: "empty",
        childGoal: "Review evidence once it is published.",
        inventoryCoverageEnabled: false,
        requestId: crypto.randomUUID(),
      };
      const beforeEmptyApproval = confirmations.length;
      assertStringIncludes(
        (await turn({ ...emptySpawn, initialGraph: undefined })).result,
        "unavailable",
      );
      assertStringIncludes(
        (await turn({ ...spawn, initialGraph: "empty" })).result,
        "unavailable",
      );
      assertStringIncludes(
        (await turn({
          ...emptySpawn,
          initialGraph: {
            version: 1,
            nodes: [{ id: "unexpected" }],
            edges: [],
          },
        })).result,
        "unavailable",
      );
      assertEquals(confirmations.length, beforeEmptyApproval);
      approved = false;
      assertStringIncludes(
        (await turn(emptySpawn)).result,
        "operator declined",
      );
      assertEquals(readSentinelAssessment(emptyPath), undefined);
      await assertRejects(
        () => Deno.lstat(dirname(emptyPath)),
        Deno.errors.NotFound,
      );
      approved = true;
      const emptyRun = JSON.parse((await turn(emptySpawn)).result);
      assertEquals(emptyRun.run.details.inventoryCoverageEnabled, false);
      assertEquals(
        readSentinelAssessment(emptyPath)?.plan.inventoryCoverageEnabled,
        false,
      );
      assertStringIncludes(
        confirmations.at(-1) ?? "",
        '"inventoryCoverageEnabled":false',
      );
      assertEquals(emptyRun.run.ref, {
        kind: "sentinel",
        id: emptyCase,
        revision: 1,
      });
      assertEquals(
        readSentinelAssessment(emptyPath)?.result?.sharedGraph.snapshot?.nodes,
        [],
      );
      assertEquals(JSON.parse(await Deno.readTextFile(emptyPath)), {
        version: 1,
        nodes: [],
        edges: [],
      });
      assertEquals(
        JSON.parse(confirmations.at(-1)!.split("\n").at(-1)!).initialGraph,
        "empty",
      );
      const creationDigest = readSentinelEmptyCreationDigest(emptyPath, 1);
      assert(creationDigest);
      const stage = join(
        baseDir,
        "data",
        "sentinel-linked-staging",
        creationDigest,
      );
      await Deno.rename(dirname(emptyPath), stage);
      const emptyApprovals = confirmations.length;
      await withGateway(async (restartTurn) => {
        assertStringIncludes(
          (await restartTurn({ ...emptySpawn, childGoal: "A changed goal." }))
            .result,
          "unavailable",
        );
        await assertRejects(
          () => Deno.lstat(dirname(emptyPath)),
          Deno.errors.NotFound,
        );
        const retry = JSON.parse((await restartTurn(emptySpawn)).result);
        await assertRejects(() => Deno.lstat(stage), Deno.errors.NotFound);
        assertEquals(retry.link, emptyRun.link);
        assertEquals(retry.run.details.runId, emptyRun.run.details.runId);
        assertEquals(retry.run.details.inventoryCoverageEnabled, false);
        const result = JSON.parse(
          (await restartTurn({
            ...emptyRun.run.ref,
            action: "inventory",
            view: "coverage",
          })).result,
        );
        assertEquals(result.page.enabled, false);
        assertEquals(result.page.assets, undefined);
        assertStringIncludes(
          (await restartTurn({ ...emptySpawn, inventoryCoverageEnabled: true }))
            .result,
          "unavailable",
        );
        assertStringIncludes(
          (await restartTurn({ ...emptySpawn, initialGraph: undefined }))
            .result,
          "unavailable",
        );
        assertEquals(confirmations.length, emptyApprovals);
      }, reopenedWorkflows);

      const exactDiscoveryParent = emptyRun.link.left.id === emptyCase
        ? emptyRun.link.right
        : emptyRun.link.left;
      const discoverChild = async (request: Turn) =>
        JSON.parse(
          (await request({ action: "list", kind: "sentinel" })).result,
        ).runs.find(({ ref }: { ref: { id: string } }) => ref.id === emptyCase);
      let terminalDiscovery: unknown;
      await withGateway(async (restartTurn) => {
        const running = await discoverChild(restartTurn);
        assert(
          running,
          "The linked case must be discoverable in the owner run list",
        );
        assertEquals(running.details.goal, emptySpawn.childGoal);
        assertEquals(running.details.parent, exactDiscoveryParent);
        assertEquals(running.details.modelProfile, null);
        assert(Number.isSafeInteger(running.details.elapsedSeconds));
        assertEquals(running.completedAt, undefined);
        assertEquals(
          JSON.parse(
            (await restartTurn({
              action: "pause",
              ...emptyRun.run.ref,
            })).result,
          ).run.status,
          "paused",
        );
        const paused = await discoverChild(restartTurn);
        assertEquals(paused.startedAt, running.startedAt);
        assert(typeof paused.details.elapsedThrough === "string");
        assertEquals(paused.completedAt, undefined);
        assertEquals(
          JSON.parse(
            (await restartTurn({
              action: "resume",
              ...emptyRun.run.ref,
            })).result,
          ).run.status,
          "running",
        );
        assertEquals(
          JSON.parse(
            (await restartTurn({
              action: "cancel",
              ...emptyRun.run.ref,
              runId: emptyRun.run.details.runId,
            })).result,
          ).run.status,
          "stopped",
        );
        const stopped = await discoverChild(restartTurn);
        assertEquals(stopped.startedAt, running.startedAt);
        assert(stopped.completedAt >= stopped.startedAt);
        assertEquals(
          stopped.details.elapsedSeconds,
          Math.floor(
            (Date.parse(stopped.completedAt) - Date.parse(stopped.startedAt)) /
              1000,
          ),
        );
        terminalDiscovery = stopped;
      }, reopenedWorkflows);
      await withGateway(async (restartTurn) => {
        assertEquals(await discoverChild(restartTurn), terminalDiscovery);
      }, reopenedWorkflows);
      assertEquals(exactDiscoveryParent.kind, "sentinel");
      const parentDirectory = dirname(
        resolveSentinelCasePath(baseDir, exactDiscoveryParent.id),
      );
      const unavailableParentDirectory = join(
        baseDir,
        "temporarily-unavailable-parent",
      );
      await Deno.rename(parentDirectory, unavailableParentDirectory);
      try {
        await withGateway(async (restartTurn) => {
          const undisclosedParent = await discoverChild(restartTurn);
          assertEquals(undisclosedParent.details.goal, emptySpawn.childGoal);
          assertEquals(undisclosedParent.details.parent, undefined);
        }, reopenedWorkflows);
      } finally {
        await Deno.rename(unavailableParentDirectory, parentDirectory);
      }
      const metadataArchiveId = crypto.randomUUID();
      await withGateway(async (restartTurn) => {
        const response = JSON.parse(
          (await restartTurn({
            action: "archive",
            ...emptyRun.run.ref,
            runId: emptyRun.run.details.runId,
            requestId: metadataArchiveId,
          })).result,
        );
        assertEquals(response.receipt.status, "succeeded");
      }, reopenedWorkflows);
      await Deno.rename(
        dirname(emptyPath),
        join(baseDir, "old-discovery-child"),
      );
      await withGateway(async (restartTurn) => {
        const response = JSON.parse(
          (await restartTurn({
            action: "restore",
            ...emptyRun.run.ref,
            runId: emptyRun.run.details.runId,
            archiveId: metadataArchiveId,
            requestId: crypto.randomUUID(),
          })).result,
        );
        assertEquals(response.receipt.status, "succeeded");
        const after = await discoverChild(restartTurn);
        const before = terminalDiscovery as {
          startedAt: string;
          completedAt: string;
          details: { elapsedSeconds: number };
        };
        assertEquals(after.status, "paused");
        assertEquals(after.startedAt, before.startedAt);
        assertEquals(after.details.elapsedThrough, before.completedAt);
        assertEquals(
          after.details.elapsedSeconds,
          before.details.elapsedSeconds,
        );
        assertEquals(after.details.parent, exactDiscoveryParent);
      }, reopenedWorkflows);

      const collisionCase = "linked-empty-collision";
      const collisionPath = resolveSentinelCasePath(baseDir, collisionCase);
      const collisionGraph = JSON.stringify(childGraph);
      duringConfirmation = () => {
        Deno.mkdirSync(dirname(collisionPath));
        Deno.writeTextFileSync(collisionPath, collisionGraph);
      };
      try {
        assertStringIncludes(
          (await turn({
            ...emptySpawn,
            targetId: collisionCase,
            requestId: crypto.randomUUID(),
          })).result,
          "unavailable",
        );
      } finally {
        duringConfirmation = undefined;
      }
      assertEquals(Deno.readTextFileSync(collisionPath), collisionGraph);
      assertEquals(readSentinelAssessment(collisionPath), undefined);

      const retryCase = "graph-retry-batch";
      const retryPath = resolveSentinelCasePath(baseDir, retryCase);
      await Deno.mkdir(dirname(retryPath), { recursive: true });
      await Deno.writeTextFile(retryPath, JSON.stringify(childGraph));
      const retryState = startSentinelAssessment(retryPath, {
        goal: "Review local graph.",
      });
      const retryRevision = adaptiveRevision(retryState);
      const retryRunId = retryState.plan.runId!;
      const retryRunRef = {
        kind: "sentinel",
        id: retryCase,
        revision: retryState.revision,
      };
      const firstRetry = {
        kind: "trace" as const,
        nodeId: "child-asset",
        depth: 1,
      };
      const secondRetry = {
        kind: "impact" as const,
        nodeId: "other-child-asset",
        depth: 1,
      };
      const firstRetryId = sentinelAdaptiveTaskId(retryRevision, firstRetry);
      const secondRetryId = sentinelAdaptiveTaskId(retryRevision, secondRetry);
      const dependent = {
        kind: "impact" as const,
        nodeId: "child-asset",
        depth: 1,
        prerequisites: [firstRetryId, secondRetryId],
      };
      const dependentId = sentinelAdaptiveTaskId(retryRevision, dependent);
      const storePath = join(dirname(retryPath), "sentinel-adaptive.db");
      const retryStore = openSentinelAdaptiveStore(storePath);
      try {
        retryStore.sync(
          retryRevision,
          [firstRetry, secondRetry, dependent],
          undefined,
          {
            number: retryState.revision,
            goal: { id: retryRunId, label: retryState.plan.goal! },
          },
        );
        for (const ignored of [secondRetryId, firstRetryId]) {
          const leased = retryStore.claim(
            retryRevision,
            60,
            new Set([ignored]),
          );
          assert(leased);
          retryStore.fail({
            taskId: leased.task.id,
            leaseToken: leased.leaseToken,
            note: "Transient graph read failure fixture.",
          });
        }
      } finally {
        retryStore.close();
      }
      const currentRetryStates = () => {
        const store = openSentinelAdaptiveStore(storePath);
        try {
          return Object.fromEntries(
            store.list(retryRevision).map(({ id, status }) => [id, status]),
          );
        } finally {
          store.close();
        }
      };
      const initiallyFailed = {
        [firstRetryId]: "failed",
        [secondRetryId]: "failed",
        [dependentId]: "queued",
      };
      assertEquals(currentRetryStates(), initiallyFailed);
      assertEquals(
        JSON.parse((await turn({ action: "pause", ...retryRunRef })).result).run
          .status,
        "paused",
      );
      const retryRequest = {
        action: "retry_graph_tasks",
        ...retryRunRef,
        runId: retryRunId,
        adaptiveRevision: retryRevision,
        requestId: crypto.randomUUID(),
        taskIds: [firstRetryId, secondRetryId],
      };
      const beforeRetryReview = confirmations.length;
      denied = "PRE_TOOL_CALL";
      await turn(retryRequest);
      denied = undefined;
      assertStringIncludes(
        (await turn({ ...retryRequest, taskIds: [firstRetryId, dependentId] }))
          .result,
        "unavailable",
      );
      assertEquals(confirmations.length, beforeRetryReview);
      assertEquals(currentRetryStates(), initiallyFailed);
      approved = false;
      assertStringIncludes(
        (await turn(retryRequest)).result,
        "operator declined",
      );
      approved = true;
      assertEquals(currentRetryStates(), initiallyFailed);
      duringConfirmation = () => {
        assert(
          resumeSentinelAssessment(retryPath, undefined, retryState.revision),
        );
      };
      try {
        assertStringIncludes((await turn(retryRequest)).result, "unavailable");
      } finally {
        duringConfirmation = undefined;
      }
      assertEquals(currentRetryStates(), initiallyFailed);
      assertEquals(
        JSON.parse((await turn({ action: "pause", ...retryRunRef })).result).run
          .status,
        "paused",
      );
      const retryReceipt =
        JSON.parse((await turn(retryRequest)).result).receipt;
      assertEquals(retryReceipt.paused, true);
      assertEquals(retryReceipt.constraintsVersion, 0);
      assertEquals(retryReceipt.taskIds, [...retryRequest.taskIds].sort());
      assertEquals(
        retryReceipt.tasks.map(({ attempts }: { attempts: number }) =>
          attempts
        ),
        [1, 1],
      );
      assertEquals(currentRetryStates(), {
        [firstRetryId]: "queued",
        [secondRetryId]: "queued",
        [dependentId]: "queued",
      });
      await withGateway(async (restartTurn) => {
        const beforeRetryReplay = confirmations.length;
        assertEquals(
          JSON.parse((await restartTurn(retryRequest)).result).receipt,
          retryReceipt,
        );
        assertStringIncludes(
          (await restartTurn({ ...retryRequest, taskIds: [firstRetryId] }))
            .result,
          "unavailable",
        );
        assertEquals(confirmations.length, beforeRetryReplay);
        assertEquals(
          JSON.parse(
            (await restartTurn({ action: "resume", ...retryRunRef })).result,
          ).run.status,
          "running",
        );
        assertEquals(currentRetryStates(), {
          [firstRetryId]: "completed",
          [secondRetryId]: "completed",
          [dependentId]: "completed",
        });
      }, reopenedWorkflows);

      const priorityCase = "selected-assignment-priority";
      const priorityPath = resolveSentinelCasePath(baseDir, priorityCase);
      await Deno.mkdir(dirname(priorityPath), { recursive: true });
      await Deno.writeTextFile(
        priorityPath,
        JSON.stringify({
          ...childGraph,
          nodes: [
            ...childGraph.nodes,
            ...["rank-a", "rank-b", "rank-low", "rank-default"].map((id) => ({
              id,
              kind: "asset",
              label: id,
            })),
          ],
        }),
      );
      const priorityState = startSentinelAssessment(priorityPath, {
        goal: "Review local graph.",
      });
      const priorityRevision = adaptiveRevision(priorityState);
      const priorityRef = {
        kind: "sentinel",
        id: priorityCase,
        revision: priorityState.revision,
      };
      const ordinary = {
        kind: "trace" as const,
        nodeId: "child-asset",
        depth: 2,
      };
      const ordinaryId = sentinelAdaptiveTaskId(priorityRevision, ordinary);
      const blockedPriority = {
        kind: "trace" as const,
        nodeId: "other-child-asset",
        depth: 2,
        prerequisites: [ordinaryId],
      };
      const blockedPriorityId = sentinelAdaptiveTaskId(
        priorityRevision,
        blockedPriority,
      );
      const priorityStorePath = join(
        dirname(priorityPath),
        "sentinel-adaptive.db",
      );
      const priorityStore = openSentinelAdaptiveStore(priorityStorePath);
      try {
        priorityStore.sync(
          priorityRevision,
          [ordinary, blockedPriority],
          undefined,
          {
            number: priorityState.revision,
            goal: {
              id: priorityState.plan.runId!,
              label: priorityState.plan.goal!,
            },
          },
        );
      } finally {
        priorityStore.close();
      }
      assertEquals(
        JSON.parse((await turn({ action: "pause", ...priorityRef })).result).run
          .status,
        "paused",
      );
      const priorityRequest = {
        action: "assign",
        ...priorityRef,
        runId: priorityState.plan.runId,
        adaptiveRevision: priorityRevision,
        requestId: crypto.randomUUID(),
        taskKind: "impact",
        node: "other-child-asset",
        prioritizeNext: true,
      };
      const beforePriorityApproval = confirmations.length;
      denied = "PRE_TOOL_CALL";
      await turn(priorityRequest);
      denied = undefined;
      assertEquals(confirmations.length, beforePriorityApproval);
      approved = false;
      assertStringIncludes(
        (await turn(priorityRequest)).result,
        "operator declined",
      );
      approved = true;
      const preferred =
        JSON.parse((await turn(priorityRequest)).result).receipt;
      assertEquals(preferred.prioritizeNext, true);
      assertEquals(
        JSON.parse(confirmations.at(-1)!.split("\n").at(-1)!).prioritizeNext,
        true,
      );
      const heldPriority = JSON.parse(
        (await turn({
          ...priorityRequest,
          taskKind: "trace",
          requestId: crypto.randomUUID(),
        })).result,
      ).receipt;
      assertEquals(heldPriority.taskId, blockedPriorityId);
      const rankRequest = (node: string, priorityRank: number) => ({
        ...priorityRequest,
        node,
        priorityRank,
        prioritizeNext: undefined,
        requestId: crypto.randomUUID(),
      });
      const rankedRequests = [
        rankRequest("rank-a", 8),
        rankRequest("rank-b", 8),
        rankRequest("rank-low", 1),
        rankRequest("rank-default", 0),
      ];
      const beforeInvalidRank = confirmations.length;
      assertStringIncludes(
        (await turn(rankRequest("rank-a", 11))).result,
        "unavailable",
      );
      assertEquals(confirmations.length, beforeInvalidRank);
      const ranked: { taskId: string; priorityRank: number }[] = [];
      for (const request of rankedRequests) {
        ranked.push(JSON.parse((await turn(request)).result).receipt);
      }
      assertEquals(ranked.map(({ priorityRank }) => priorityRank), [
        8,
        8,
        1,
        5,
      ]);
      const originalPriorityApproval = confirmations.length;
      await withGateway(async (priorityTurn) => {
        assertEquals(
          JSON.parse((await priorityTurn(priorityRequest)).result).receipt,
          preferred,
        );
        assertStringIncludes(
          (await priorityTurn({
            ...priorityRequest,
            prioritizeNext: undefined,
          })).result,
          "unavailable",
        );
        assertEquals(
          JSON.parse((await priorityTurn(rankedRequests[0])).result).receipt,
          ranked[0],
        );
        assertStringIncludes(
          (await priorityTurn({ ...rankedRequests[0], priorityRank: 9 }))
            .result,
          "unavailable",
        );
        assertEquals(confirmations.length, originalPriorityApproval);
        assertEquals(
          JSON.parse(
            (await priorityTurn({ action: "resume", ...priorityRef })).result,
          ).run.status,
          "running",
        );
      }, restarted);
      const completedPriority = openSentinelAdaptiveStore(priorityStorePath);
      try {
        assertEquals(
          completedPriority.history(priorityRevision).filter(({ event }) =>
            event === "claimed"
          ).reverse().map(({ taskId }) => taskId),
          [
            preferred.taskId,
            ranked[0].taskId,
            ranked[1].taskId,
            ordinaryId,
            blockedPriorityId,
            ranked[3].taskId,
            ranked[2].taskId,
          ],
        );
      } finally {
        completedPriority.close();
      }

      const atomicCase = "atomic-assignment-case";
      const atomicPath = resolveSentinelCasePath(baseDir, atomicCase);
      await Deno.mkdir(dirname(atomicPath), { recursive: true });
      await Deno.writeTextFile(atomicPath, JSON.stringify(childGraph));
      const atomicState = startSentinelAssessment(atomicPath, {
        goal: "Review local assets.",
      });
      const atomicRevision = adaptiveRevision(atomicState);
      const atomicRef = {
        kind: "sentinel",
        id: atomicCase,
        revision: atomicState.revision,
      };
      const atomicStorePath = join(dirname(atomicPath), "sentinel-adaptive.db");
      const atomicStore = openSentinelAdaptiveStore(atomicStorePath);
      const priorTask = {
        kind: "impact" as const,
        nodeId: "other-child-asset",
        depth: 2,
      };
      const priorTaskId = sentinelAdaptiveTaskId(atomicRevision, priorTask);
      try {
        atomicStore.sync(atomicRevision, [priorTask], undefined, {
          number: atomicState.revision,
          goal: { id: atomicState.plan.runId!, label: atomicState.plan.goal! },
        });
        const priorClaim = atomicStore.claim(atomicRevision);
        assert(priorClaim);
        atomicStore.complete({
          taskId: priorClaim.task.id,
          leaseToken: priorClaim.leaseToken,
          observation: { relatedNodeIds: ["other-child-asset"] },
        });
      } finally {
        atomicStore.close();
      }
      assertEquals(
        JSON.parse((await turn({ action: "pause", ...atomicRef })).result).run
          .status,
        "paused",
      );
      const atomicControl = {
        action: "assign_batch",
        ...atomicRef,
        runId: atomicState.plan.runId,
        adaptiveRevision: atomicRevision,
        requestId: crypto.randomUUID(),
        assignments: [
          { taskKind: "trace", node: "child-asset" },
          {
            taskKind: "impact",
            node: "other-child-asset",
            prioritizeNext: true,
          },
        ],
      };
      const atomicTasks = () => {
        const store = openSentinelAdaptiveStore(atomicStorePath);
        try {
          return store.list(atomicRevision);
        } finally {
          store.close();
        }
      };
      const atomicBefore = confirmations.length;
      denied = "PRE_TOOL_CALL";
      await turn(atomicControl);
      denied = undefined;
      assertEquals(confirmations.length, atomicBefore);
      assertStringIncludes(
        (await turn({
          ...atomicControl,
          assignments: [atomicControl.assignments[0], {
            taskKind: "trace",
            node: "foreign-asset",
          }],
        })).result,
        "unavailable",
      );
      assertEquals(confirmations.length, atomicBefore);
      approved = false;
      assertStringIncludes(
        (await turn(atomicControl)).result,
        "operator declined",
      );
      approved = true;
      assertEquals(atomicTasks().map(({ id }) => id), [priorTaskId]);

      // The journal rejects the second member's priority change on a completed task.
      // The first write and its receipt must roll back with it.
      assertStringIncludes((await turn(atomicControl)).result, "unavailable");
      assertEquals(atomicTasks().map(({ id }) => id), [priorTaskId]);
      const validAtomic = {
        ...atomicControl,
        assignments: [
          atomicControl.assignments[0],
          { taskKind: "trace", node: "other-child-asset", priorityRank: 9 },
        ],
      };
      const batchAssignmentReceipt =
        JSON.parse((await turn(validAtomic)).result).receipt;
      assertEquals(batchAssignmentReceipt.receipts.length, 2);
      assertEquals(
        batchAssignmentReceipt.receipts.map((
          { disposition }: { disposition: string },
        ) => disposition),
        [
          "enqueued",
          "enqueued",
        ],
      );
      assertEquals(atomicTasks().length, 3);
      const afterBatchReview = confirmations.length;
      await withGateway(async (batchTurn) => {
        assertEquals(
          JSON.parse((await batchTurn(validAtomic)).result).receipt,
          batchAssignmentReceipt,
        );
        assertStringIncludes(
          (await batchTurn({
            ...validAtomic,
            assignments: [...validAtomic.assignments].reverse(),
          })).result,
          "unavailable",
        );
        assertEquals(confirmations.length, afterBatchReview);
        assertEquals(
          JSON.parse(
            (await batchTurn({ action: "resume", ...atomicRef })).result,
          ).run.status,
          "running",
        );
        assertEquals(atomicTasks().map(({ status }) => status), [
          "completed",
          "completed",
          "completed",
        ]);
      }, restarted);

      const batchCase = "reviewed-batch-case";
      const batchPath = resolveSentinelCasePath(baseDir, batchCase);
      await Deno.mkdir(dirname(batchPath), { recursive: true });
      await Deno.writeTextFile(batchPath, JSON.stringify(childGraph));
      const batchCaseStart = startSentinelAssessment(batchPath);
      const batchCaseRef = {
        kind: "sentinel",
        id: batchCase,
        revision: batchCaseStart.revision,
        runId: batchCaseStart.plan.runId,
      };
      const batchWorkflow = JSON.parse(
        (await turn({
          action: "start",
          ...configured,
          requestId: crypto.randomUUID(),
        })).result,
      ).run.ref;
      const missingWorkflow = { kind: "workflow", id: crypto.randomUUID() };
      const pauseBatch = {
        action: "pause_runs",
        requestId: crypto.randomUUID(),
        runTargets: [batchCaseRef, batchWorkflow, missingWorkflow],
      };
      const originalBatchApproval = confirmations.length;
      denied = "PRE_TOOL_CALL";
      await turn(pauseBatch);
      denied = undefined;
      assertEquals(confirmations.length, originalBatchApproval);
      assertEquals(readSentinelAssessment(batchPath)?.paused, false);
      assertEquals(
        restarted.inspect(batchWorkflow.id)?.status,
        "running",
      );
      approved = false;
      assertStringIncludes(
        (await turn(pauseBatch)).result,
        "operator declined",
      );
      approved = true;
      assertEquals(readSentinelAssessment(batchPath)?.paused, false);
      assertEquals(
        restarted.inspect(batchWorkflow.id)?.status,
        "running",
      );
      duringConfirmation = () => {
        Deno.writeTextFileSync(
          batchPath,
          JSON.stringify({
            ...childGraph,
            nodes: childGraph.nodes.map((node) => ({
              ...node,
              label: node.label + " updated",
            })),
          }),
        );
        assertEquals(refreshSentinelAssessment(batchPath)?.revision, 2);
      };
      let pausedBatch;
      try {
        pausedBatch = JSON.parse((await turn(pauseBatch)).result);
      } finally {
        duringConfirmation = undefined;
      }
      assertEquals(
        pausedBatch.items.map(({ status }: { status: string }) => status),
        [
          "stale",
          "applied",
          "unavailable",
        ],
      );
      assertEquals(readSentinelAssessment(batchPath)?.paused, false);
      const reviewedBatchApproval = confirmations.length;
      await withGateway(async (restartTurn) => {
        assertEquals(
          JSON.parse((await restartTurn(pauseBatch)).result),
          pausedBatch,
        );
        assertStringIncludes(
          (await restartTurn({ ...pauseBatch, runTargets: [batchWorkflow] }))
            .result,
          "unavailable",
        );
        assertEquals(confirmations.length, reviewedBatchApproval);
        const exactBatchRef = { ...batchCaseRef, revision: 2 };
        const secondPause = JSON.parse(
          (await restartTurn({
            action: "pause_runs",
            requestId: crypto.randomUUID(),
            runTargets: [exactBatchRef, batchWorkflow],
          })).result,
        );
        assertEquals(
          secondPause.items.map(({ status }: { status: string }) => status),
          [
            "applied",
            "unchanged",
          ],
        );
        assertEquals(readSentinelAssessment(batchPath)?.paused, true);
        const resumeBatch = {
          action: "resume_runs",
          requestId: crypto.randomUUID(),
          runTargets: [exactBatchRef, batchWorkflow],
        };
        const resumedBatch = JSON.parse(
          (await restartTurn(resumeBatch)).result,
        );
        assertEquals(
          resumedBatch.items.map(({ status }: { status: string }) => status),
          [
            "applied",
            "applied",
          ],
        );
        assertEquals(readSentinelAssessment(batchPath)?.paused, false);

        // Simulate a committed transition whose receipt update was interrupted.
        const journal = new DatabaseSync(
          join(baseDir, "operator-run-links.db"),
        );
        try {
          const raw = journal.prepare(
            "SELECT record FROM run_control_batches WHERE requestId = ?",
          ).get(resumeBatch.requestId)?.record;
          assert(typeof raw === "string");
          const receipt = JSON.parse(raw);
          receipt.items[0].status = "pending";
          delete receipt.items[0].resultRef;
          journal.prepare(
            "UPDATE run_control_batches SET record = ? WHERE requestId = ?",
          )
            .run(JSON.stringify(receipt), resumeBatch.requestId);
        } finally {
          journal.close();
        }
        assertEquals(
          JSON.parse(
            (await restartTurn({
              action: "pause",
              kind: "sentinel",
              id: batchCase,
              revision: 2,
            })).result,
          ).run.status,
          "paused",
        );
        const pendingBatch = JSON.parse(
          (await restartTurn(resumeBatch)).result,
        );
        assertEquals(pendingBatch.items[0].status, "pending");
        assertEquals(readSentinelAssessment(batchPath)?.paused, true);
        assertEquals(
          JSON.parse(
            (await restartTurn({
              action: "resume",
              kind: "sentinel",
              id: batchCase,
              revision: 2,
            })).result,
          ).run.status,
          "running",
        );
        const observedBatch = JSON.parse(
          (await restartTurn(resumeBatch)).result,
        );
        assertEquals(observedBatch.items[0].status, "observed");
      }, restarted);

      const createCategory = {
        action: "create_run_category",
        title: "Local investigations",
        requestId: crypto.randomUUID(),
      };
      const beforeCategoryReview = confirmations.length;
      denied = "PRE_TOOL_CALL";
      await turn(createCategory);
      denied = undefined;
      assertEquals(confirmations.length, beforeCategoryReview);
      approved = false;
      assertStringIncludes(
        (await turn(createCategory)).result,
        "operator declined",
      );
      approved = true;
      const emptyTaxonomy = JSON.parse(
        (await turn({ action: "run_categories" })).result,
      );
      assertEquals(emptyTaxonomy.categories, []);
      const category =
        JSON.parse((await turn(createCategory)).result).receipt.category;
      assertEquals(category.title, createCategory.title);
      assertEquals(category.version, 1);
      const catalogApproval = confirmations.length;
      assertStringIncludes(
        (await turn({
          ...createCategory,
          title: createCategory.title.toLowerCase(),
          requestId: crypto.randomUUID(),
        })).result,
        "unavailable",
      );
      assertEquals(confirmations.length, catalogApproval);

      const staleCategoryMove = {
        action: "categorize_runs",
        categoryId: category.id,
        expectedVersion: 1,
        requestId: crypto.randomUUID(),
        runTargets: [{ ...batchCaseRef, revision: 2 }, batchWorkflow],
      };
      duringConfirmation = () => {
        Deno.writeTextFileSync(batchPath, JSON.stringify(childGraph));
        assertEquals(refreshSentinelAssessment(batchPath)?.revision, 3);
      };
      try {
        assertStringIncludes(
          (await turn(staleCategoryMove)).result,
          "unavailable",
        );
      } finally {
        duringConfirmation = undefined;
      }
      const workflowBeforeCategory = JSON.parse(
        (await turn({
          action: "list",
          kind: "workflow",
        })).result,
      ).runs.find(({ ref }: { ref: { id: string } }) =>
        ref.id === batchWorkflow.id
      );
      assert(workflowBeforeCategory);
      assertEquals(workflowBeforeCategory.category, undefined);
      const exactCategoryTarget = { ...batchCaseRef, revision: 3 };
      const moveCategory = {
        ...staleCategoryMove,
        runTargets: [exactCategoryTarget, batchWorkflow],
      };
      const moveReceipt = JSON.parse((await turn(moveCategory)).result).receipt;
      assertEquals(moveReceipt.affected, 2);
      const renamed = JSON.parse(
        (await turn({
          action: "rename_run_category",
          categoryId: category.id,
          expectedVersion: 1,
          requestId: crypto.randomUUID(),
          title: "Verified local reviews",
        })).result,
      ).receipt.category;
      assertEquals(renamed.version, 2);
      assertEquals(renamed.id, category.id);
      await withGateway(async (categoryTurn) => {
        const existingApproval = confirmations.length;
        assertEquals(
          JSON.parse((await categoryTurn(moveCategory)).result).receipt,
          moveReceipt,
        );
        assertEquals(confirmations.length, existingApproval);
        for (const target of [exactCategoryTarget, batchWorkflow]) {
          const listed = JSON.parse(
            (await categoryTurn({ action: "list", kind: target.kind }))
              .result,
          ).runs;
          const displayed = listed.find(({ ref }: { ref: { id: string } }) =>
            ref.id === target.id
          );
          assertEquals(displayed.category, renamed);
        }
        const taxonomy = JSON.parse(
          (await categoryTurn({ action: "run_categories" })).result,
        );
        assertEquals(taxonomy.categories, [renamed]);
        const cleared = JSON.parse(
          (await categoryTurn({
            action: "clear_run_categories",
            requestId: crypto.randomUUID(),
            runTargets: [batchWorkflow],
          })).result,
        ).receipt;
        assertEquals(cleared.affected, 1);
        const deleted = JSON.parse(
          (await categoryTurn({
            action: "delete_run_category",
            categoryId: category.id,
            expectedVersion: 2,
            requestId: crypto.randomUUID(),
          })).result,
        ).receipt;
        assertEquals(deleted.affected, 1);
        assertEquals(
          JSON.parse((await categoryTurn({ action: "run_categories" })).result)
            .categories,
          [],
        );
        for (const target of [exactCategoryTarget, batchWorkflow]) {
          const listed = JSON.parse(
            (await categoryTurn({ action: "list", kind: target.kind }))
              .result,
          ).runs;
          const displayed = listed.find(({ ref }: { ref: { id: string } }) =>
            ref.id === target.id
          );
          assert(displayed);
          assertEquals(displayed.category, undefined);
        }
      }, restarted);

      const cancelSentinel = {
        action: "cancel",
        ...linkedSentinel.run.ref,
        runId: linkedSentinel.run.details.runId,
      };
      duringConfirmation = () => {
        Deno.writeTextFileSync(childPath, JSON.stringify(childGraph));
        assert(refreshSentinelAssessment(childPath)?.revision === 2);
      };
      try {
        assertStringIncludes(
          (await turn(cancelSentinel)).result,
          "unavailable",
        );
      } finally {
        duringConfirmation = undefined;
      }
      assert(readSentinelAssessment(childPath)?.active);
      for (const revision of [1, 2]) {
        const titled = JSON.parse(
          (await turn({
            action: "inspect",
            ...linkedSentinel.run.ref,
            revision,
          })).result,
        ).run;
        assertEquals(titled.label, childDescription);
      }
      const newestCancel = { ...cancelSentinel, revision: 2 };
      assertEquals(
        JSON.parse((await turn(newestCancel)).result).run.status,
        "stopped",
      );
      const cancelApprovals = confirmations.length;
      assertEquals(
        JSON.parse((await turn(newestCancel)).result).run.status,
        "stopped",
      );
      assertEquals(confirmations.length, cancelApprovals);
      assertEquals(readSentinelAssessment(childPath)?.active, false);

      const archiveParent = {
        ...linkedSentinel.run.ref,
        revision: 2,
        runId: readSentinelAssessment(childPath)!.plan.runId!,
      };
      const archiveLeafId = "archive-batch-leaf";
      const spawnedLeaf = JSON.parse(
        (await turn({
          action: "spawn",
          kind: "sentinel",
          id: archiveParent.id,
          revision: archiveParent.revision,
          targetKind: "sentinel",
          targetId: archiveLeafId,
          initialGraph: "empty",
          requestId: crypto.randomUUID(),
        })).result,
      ).run;
      const archiveLeaf = {
        ...spawnedLeaf.ref,
        runId: spawnedLeaf.details.runId,
      };
      assertEquals(
        JSON.parse(
          (await turn({
            action: "cancel",
            ...archiveLeaf,
          })).result,
        ).run.status,
        "stopped",
      );
      const unavailableArchive = {
        kind: "sentinel",
        id: "archive-batch-missing",
        revision: 1,
        runId: crypto.randomUUID(),
      };
      const changingId = "archive-batch-changing";
      const changingPath = resolveSentinelCasePath(baseDir, changingId);
      await Deno.mkdir(dirname(changingPath), { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(changingPath, JSON.stringify(childGraph));
      const changing = startSentinelAssessment(changingPath);
      const changingTarget = {
        kind: "sentinel",
        id: changingId,
        revision: changing.revision,
        runId: changing.plan.runId!,
      };
      stopSentinelAssessment(changingPath);
      const archiveBatch = {
        action: "archive_runs",
        requestId: crypto.randomUUID(),
        runTargets: [
          archiveParent,
          unavailableArchive,
          archiveLeaf,
          changingTarget,
        ],
      };
      const beforeArchiveBatch = confirmations.length;
      denied = "PRE_TOOL_CALL";
      await turn(archiveBatch);
      denied = undefined;
      assertEquals(confirmations.length, beforeArchiveBatch);
      duringConfirmation = () => {
        startSentinelAssessment(changingPath);
      };
      const batch = JSON.parse((await turn(archiveBatch)).result);
      duringConfirmation = undefined;
      assertEquals(confirmations.length, beforeArchiveBatch + 1);
      assertEquals(
        JSON.parse(confirmations.at(-1)!.split("\n").at(-1)!).targets,
        [archiveLeaf, archiveParent, changingTarget],
      );
      assertEquals(
        batch.outcomes.map(({ status }: { status: string }) => status),
        ["succeeded", "unavailable", "succeeded", "unavailable"],
      );
      assertEquals(batch.outcomes[1], {
        target: unavailableArchive,
        status: "unavailable",
      });
      await withGateway(async (reconnected) => {
        assertEquals(
          JSON.parse((await reconnected(archiveBatch)).result),
          batch,
        );
        assertStringIncludes(
          (await reconnected({
            ...archiveBatch,
            runTargets: [archiveParent],
          })).result,
          "unavailable",
        );
        assertEquals(confirmations.length, beforeArchiveBatch + 1);
        for (const outcome of [batch.outcomes[0], batch.outcomes[2]]) {
          const history = JSON.parse(
            (await reconnected({
              action: "archive_history",
              ...outcome.target,
            })).result,
          );
          assertEquals(history.records[0], outcome.receipt);
        }
      }, reopenedWorkflows);

      const restoreParent = {
        ...archiveParent,
        archiveId: batch.outcomes[0].receipt.archiveId,
      };
      const restoreLeaf = {
        ...archiveLeaf,
        archiveId: batch.outcomes[2].receipt.archiveId,
      };
      const missingRestore = {
        ...unavailableArchive,
        archiveId: crypto.randomUUID(),
      };
      const leafPath = resolveSentinelCasePath(baseDir, archiveLeaf.id);
      await Deno.rename(
        dirname(leafPath),
        join(baseDir, "detached-batch-leaf"),
      );
      await Deno.rename(
        dirname(childPath),
        join(baseDir, "detached-batch-parent"),
      );
      await withGateway(async (reconnected) => {
        const lookup = {
          action: "archive_catalog",
          query: "ARCHIVE-BATCH-LEAF",
          archiveStatus: "succeeded",
          archiveId: restoreLeaf.archiveId,
        };
        const exact = JSON.parse((await reconnected(lookup)).result);
        assertEquals(exact.archives, [{
          archiveId: restoreLeaf.archiveId,
          identity: batch.outcomes[2].receipt.identity,
          status: "succeeded",
          createdAt: batch.outcomes[2].receipt.createdAt,
          updatedAt: batch.outcomes[2].receipt.updatedAt,
        }]);
        assertEquals(exact.nextCursor, null);
        assertEquals(exact._classification, "INTERNAL");
        assertEquals(
          JSON.parse(
            (await reconnected({ ...lookup, restoreStatus: "succeeded" }))
              .result,
          ).archives,
          [],
        );
        assertEquals(readSentinelAssessment(leafPath), undefined);
        const first = {
          action: "archive_catalog",
          archiveStatus: "succeeded",
          limit: 1,
        };
        const firstPage = JSON.parse((await reconnected(first)).result);
        assertEquals(firstPage.archives[0].archiveId, restoreParent.archiveId);
        assert(firstPage.nextCursor);
        const continuation = { ...first, cursor: firstPage.nextCursor };
        const secondPage = JSON.parse((await reconnected(continuation)).result);
        assertEquals(secondPage.archives[0].archiveId, restoreLeaf.archiveId);
        assertStringIncludes(
          (await reconnected({ ...continuation, query: "different" })).result,
          "unavailable",
        );
        assertEquals(
          JSON.parse(
            (await reconnected({
              ...lookup,
              archiveStatus: "failed",
            })).result,
          ).archives,
          [],
        );
        denyArchiveTarget = archiveLeaf.id;
        try {
          assertEquals(
            JSON.parse((await reconnected(lookup)).result).archives,
            [],
          );
          const next = JSON.parse((await reconnected(continuation)).result);
          assert(
            next.archives.every(({ archiveId }: { archiveId: string }) =>
              archiveId !== restoreLeaf.archiveId
            ),
          );
        } finally {
          denyArchiveTarget = undefined;
        }
      }, reopenedWorkflows);
      const restoreBatch = {
        action: "restore_runs",
        requestId: crypto.randomUUID(),
        runTargets: [restoreLeaf, missingRestore, restoreParent],
      };
      const beforeRestoreBatch = confirmations.length;
      let restoredBatch: unknown;
      await withGateway(async (reconnected) => {
        denied = "PRE_TOOL_CALL";
        await reconnected(restoreBatch);
        denied = undefined;
        assertEquals(confirmations.length, beforeRestoreBatch);
        assertEquals(readSentinelAssessment(childPath), undefined);
        assertEquals(readSentinelAssessment(leafPath), undefined);
        const restored = JSON.parse((await reconnected(restoreBatch)).result);
        restoredBatch = restored;
        assertEquals(
          JSON.parse(confirmations.at(-1)!.split("\n").at(-1)!).targets,
          [restoreParent, restoreLeaf],
        );
        assertEquals(
          restored.outcomes.map(({ status }: { status: string }) => status),
          ["succeeded", "unavailable", "succeeded"],
        );
        assertEquals(restored.outcomes[1], {
          target: missingRestore,
          status: "unavailable",
        });
        assertEquals(readSentinelAssessment(childPath)?.paused, true);
        assertEquals(readSentinelAssessment(leafPath)?.paused, true);
        assertEquals(
          readSentinelAssessment(leafPath)?.plan.spawnParent,
          {
            kind: "sentinel",
            id: archiveParent.id,
            revision: archiveParent.revision,
          },
        );
      }, reopenedWorkflows);
      await withGateway(async (reconnected) => {
        assertEquals(
          JSON.parse((await reconnected(restoreBatch)).result),
          restoredBatch,
        );
        assertStringIncludes(
          (await reconnected({
            ...restoreBatch,
            runTargets: [restoreLeaf],
          })).result,
          "unavailable",
        );
        const collision = JSON.parse(
          (await reconnected({
            ...restoreBatch,
            requestId: crypto.randomUUID(),
          })).result,
        );
        assert(
          collision.outcomes.every(({ status }: { status: string }) =>
            status === "unavailable"
          ),
        );
        assertEquals(confirmations.length, beforeRestoreBatch + 1);
        const restoredCatalog = {
          action: "archive_catalog",
          archiveStatus: "succeeded",
          restoreStatus: "succeeded",
          limit: 1,
        };
        const first = JSON.parse((await reconnected(restoredCatalog)).result);
        assert(first.nextCursor);
        const second = JSON.parse(
          (await reconnected({
            ...restoredCatalog,
            cursor: first.nextCursor,
          })).result,
        );
        assertEquals(
          [first.archives[0].archiveId, second.archives[0].archiveId],
          [restoreParent.archiveId, restoreLeaf.archiveId],
        );
        const leafHistory = JSON.parse(
          (await reconnected({
            action: "archive_history",
            ...archiveLeaf,
          })).result,
        );
        const restore = leafHistory.records.find(
          (record: { action: string }) => record.action === "restore",
        );
        assertEquals(second.archives[0].latestRestore, {
          status: "succeeded",
          createdAt: restore.createdAt,
          updatedAt: restore.updatedAt,
        });
        assert(!JSON.stringify(second).includes(restore.requestId));
        assertStringIncludes(
          (await reconnected({
            ...restoredCatalog,
            cursor: first.nextCursor,
            restoreStatus: "failed",
          })).result,
          "unavailable",
        );
        const exact = { ...restoredCatalog, archiveId: restoreLeaf.archiveId };
        denyArchiveTarget = restoreLeaf.id;
        try {
          assertEquals(
            JSON.parse((await reconnected(exact)).result).archives,
            [],
          );
        } finally {
          denyArchiveTarget = undefined;
        }
      }, reopenedWorkflows);

      const deadlineCase = "deadline-child";
      const deadlinePath = resolveSentinelCasePath(baseDir, deadlineCase);
      await Deno.mkdir(dirname(deadlinePath), { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(deadlinePath, JSON.stringify(childGraph));
      const deadlineSpawn = {
        ...sentinelSpawn,
        goalProposal: undefined,
        organizationId: undefined,
        targetId: deadlineCase,
        requestId: crypto.randomUUID(),
        timeoutSeconds: 2,
      };
      const deadline = JSON.parse((await turn(deadlineSpawn)).result).run;
      assertEquals(deadline.status, "running");
      assertEquals(deadline.details.timeoutSeconds, 2);
      assert(deadline.details.deadlineAt > Date.now());
      const confirmedTimeout = confirmations.length;
      assertStringIncludes(
        (await turn({ ...deadlineSpawn, timeoutSeconds: 3 })).result,
        "unavailable",
      );
      assertEquals(confirmations.length, confirmedTimeout);
      const lifecycle = { ...deadline.ref };
      let adaptiveStarted = false;
      let adaptiveStopped = false;
      const coordinator = startSentinelAssessmentCoordinator({
        snapshotPath: deadlinePath,
        advanceAdaptive() {
          adaptiveStarted = true;
        },
        stopAdaptive() {
          adaptiveStopped = adaptiveStarted;
        },
      });
      try {
        await withGateway(async (restartTurn) => {
          const retried =
            JSON.parse((await restartTurn(deadlineSpawn)).result).run;
          assertEquals(retried.details.deadlineAt, deadline.details.deadlineAt);
          assertEquals(confirmations.length, confirmedTimeout);
          assertEquals(
            JSON.parse(
              (await restartTurn({ ...lifecycle, action: "pause" })).result,
            ).run.status,
            "paused",
          );
          assertEquals(
            JSON.parse(
              (await restartTurn({ ...lifecycle, action: "resume" })).result,
            ).run.status,
            "running",
          );
          // Observe the coordinator's persisted transition without triggering it from a read.
          const db = new DatabaseSync(
            join(dirname(deadlinePath), "sentinel-assessment.db"),
            { readOnly: true },
          );
          try {
            await until(() =>
              db.prepare("SELECT active FROM assessment WHERE id = 1").get()
                  ?.active === SENTINEL_ASSESSMENT_TIMED_OUT && adaptiveStopped
            );
          } finally {
            db.close();
          }
          const inspected = JSON.parse(
            (await restartTurn({ ...lifecycle, action: "inspect" })).result,
          ).run;
          assertEquals(inspected.status, "timed_out");
          assertEquals(
            inspected.details.deadlineAt,
            deadline.details.deadlineAt,
          );
          assertStringIncludes(
            (await restartTurn({ ...lifecycle, action: "resume" })).result,
            "unavailable",
          );
          const archiveId = crypto.randomUUID();
          const archiveRef = { ...lifecycle, runId: inspected.details.runId };
          const archived = JSON.parse(
            (await restartTurn({
              ...archiveRef,
              action: "archive",
              requestId: archiveId,
            })).result,
          );
          assertEquals(archived.receipt.status, "succeeded");
          await Deno.rename(
            dirname(deadlinePath),
            join(baseDir, "prior-deadline-case"),
          );
          const restoredDeadline = JSON.parse(
            (await restartTurn({
              ...archiveRef,
              action: "restore",
              archiveId,
              requestId: crypto.randomUUID(),
            })).result,
          );
          assertEquals(restoredDeadline.receipt.status, "succeeded");
          const restoredRun = JSON.parse(
            (await restartTurn({ ...lifecycle, action: "inspect" })).result,
          ).run;
          assertEquals(restoredRun.label, childDescription);
          assertEquals(restoredRun.status, "timed_out");
          assertEquals(
            restoredRun.details.deadlineAt,
            deadline.details.deadlineAt,
          );
        }, reopenedWorkflows);
      } finally {
        coordinator.stop();
      }

      for (
        const scenario of ["verified", "operator", "late", "missing"] as const
      ) {
        const caseId = `deadline-goal-${scenario}`;
        const casePath = resolveSentinelCasePath(baseDir, caseId);
        await Deno.mkdir(dirname(casePath), { recursive: true, mode: 0o700 });
        await Deno.writeTextFile(
          casePath,
          JSON.stringify({
            ...childGraph,
            nodes: [
              ...childGraph.nodes,
              {
                id: "proof",
                kind: "evidence",
                label: "Committed defensive check",
              },
            ],
            edges: [
              {
                from: "child-asset",
                to: "other-child-asset",
                relation: "depends_on",
              },
              { from: "proof", to: "child-asset", relation: "observed_on" },
            ],
          }),
        );
        const started = JSON.parse(
          (await turn({
            ...sentinelSpawn,
            goalProposal: undefined,
            organizationId: undefined,
            targetId: caseId,
            requestId: crypto.randomUUID(),
            timeoutSeconds: 30,
          })).result,
        ).run;

        if (scenario === "verified") {
          const restricted = JSON.parse(
            (await turn({
              ...started.ref,
              action: "narrow_constraints",
              runId: started.details.runId,
              requestId: crypto.randomUUID(),
              expectedVersion: 0,
              deniedKinds: [],
              allowedAssetIds: ["child-asset"],
            })).result,
          );
          assertEquals(restricted.record.version, 1);
        }
        const cutoff = started.details.deadlineAt;
        const policy = scenario === "operator" ? "operator" : "automatic";
        const reference = scenario === "missing" ? "missing-proof" : "proof";
        const registration = registerSentinelGoalCompletion(casePath, [{
          id: "review",
          description: "Verify the exact committed defensive record.",
          source: "graph_evidence",
          reference,
        }], policy);
        const contract = new GoalCompletionStore(
          join(dirname(casePath), "sentinel-goal-completion.db"),
          () => scenario === "late" ? cutoff + 1 : cutoff - 1,
        );
        try {
          // Seed the interrupted boundary after the durable decision, before
          // the assessment lifecycle write. The coordinator re-verifies it.
          assertEquals(
            contract.report(registration.scope, [{
              criterionId: "review",
              evidence: [{
                source: "graph_evidence",
                reference,
                detail: "Committed defensive check",
              }],
            }], () => true).status,
            policy === "operator" ? "awaiting_confirmation" : "completed",
          );
        } finally {
          contract.close();
        }
        assert(
          refreshSentinelAssessment(casePath, undefined, new Date(cutoff + 1))
            ?.deadlineReviewPending,
        );

        await withGateway(async (restartTurn) => {
          const inspect = { ...started.ref, action: "inspect" };
          assertEquals(
            JSON.parse((await restartTurn(inspect)).result).run.status,
            "settling_timeout",
          );
          let dispatched = 0;
          const coordinator = startSentinelAssessmentCoordinator({
            snapshotPath: casePath,
            advanceAdaptive: () => {
              dispatched++;
            },
            createWorker: () => {
              dispatched++;
              throw new Error("A settled deadline cannot create a worker");
            },
          });
          try {
            const settled = JSON.parse((await restartTurn(inspect)).result).run;
            assertEquals(
              settled.status,
              scenario === "verified" ? "completed" : "timed_out",
            );
            const state = readSentinelAssessment(casePath);
            assertEquals(state?.deadlineReviewPending, undefined);
            assertEquals(
              state?.completion?.at,
              scenario === "verified"
                ? new Date(cutoff).toISOString()
                : undefined,
            );
            const after = JSON.parse((await restartTurn(inspect)).result).run;
            assertEquals(after, settled);
            assertEquals(dispatched, 0);
            const followup = {
              ...started.ref,
              action: "completed_graph_followup",
              runId: started.details.runId,
              requestId: crypto.randomUUID(),
              taskKind: "trace",
              node: "child-asset",
            };
            if (scenario === "verified") {
              const beforeFollowupApproval = confirmations.length;
              for (
                const invalid of [
                  { ...followup, node: "proof" },
                  { ...followup, node: "foreign-asset" },
                  { ...followup, node: "other-child-asset" },
                  { ...followup, taskKind: "review_evidence" },
                  { ...followup, runId: crypto.randomUUID() },
                  { ...followup, revision: started.ref.revision + 1 },
                ]
              ) {
                assertStringIncludes(
                  (await restartTurn(invalid)).result,
                  "unavailable",
                );
              }
              denied = "PRE_TOOL_CALL";
              await restartTurn(followup);
              denied = undefined;
              assertEquals(confirmations.length, beforeFollowupApproval);
              approved = false;
              assertStringIncludes(
                (await restartTurn(followup)).result,
                "operator declined",
              );
              approved = true;
              const result = JSON.parse((await restartTurn(followup)).result);
              assertEquals(result.receipt.nodeId, followup.node);
              assertEquals(result.receipt.runId, followup.runId);
              assertEquals(result.receipt.constraintsVersion, 1);
              assert(
                !JSON.stringify(result.receipt.observation).includes(
                  "other-child-asset",
                ),
              );

              assertEquals(
                result.receipt.evidenceRevision,
                started.ref.revision,
              );
              assert(
                result.receipt.observation.relatedNodeIds.includes(
                  followup.node,
                ),
              );
              assertEquals(
                readSentinelAssessment(casePath)?.completion,
                state?.completion,
              );
              assertEquals(
                JSON.parse((await restartTurn(inspect)).result).run,
                settled,
              );
              assertEquals(dispatched, 0);
              const approvedCount = confirmations.length;
              await withGateway(async (reopenTurn) => {
                assertEquals(
                  JSON.parse((await reopenTurn(followup)).result),
                  result,
                );
                assertStringIncludes(
                  (await reopenTurn({ ...followup, taskKind: "impact" }))
                    .result,
                  "unavailable",
                );
                assertEquals(confirmations.length, approvedCount);
                assertEquals(
                  readSentinelAssessment(casePath)?.completion,
                  state?.completion,
                );
              }, reopenedWorkflows);
            } else {
              const rejected = (await restartTurn(followup)).result;
              assertStringIncludes(rejected, "unavailable");
            }
          } finally {
            coordinator.stop();
          }
        }, reopenedWorkflows);
      }

      const enrollmentCase = "exact-goal-workflow";
      const enrollmentPath = resolveSentinelCasePath(baseDir, enrollmentCase);
      await Deno.mkdir(dirname(enrollmentPath), { recursive: true });
      await Deno.writeTextFile(
        enrollmentPath,
        JSON.stringify({
          ...childGraph,
          nodes: [...childGraph.nodes, {
            kind: "evidence",
            id: "verified-record",
            label: "Verified review record",
          }],
          edges: [{
            from: "verified-record",
            to: "child-asset",
            relation: "observed_on",
          }],
        }),
      );
      const formal = [{
        id: "local-check",
        title: "Review the verified record",
        policy: "automatic" as const,
        criteria: [{
          id: "record",
          description: "Verify the exact published record",
          source: "graph_evidence" as const,
          reference: "verified-record",
        }],
      }];
      const enrolledState = applySentinelFormalGoals(enrollmentPath, {
        mode: "start",
        requestId: crypto.randomUUID(),
        goals: formal,
        proposalDigest: digestSentinelGoalProposal(formal),
      }).state;
      const goalContract = ensureSentinelFormalGoalContract(
        enrollmentPath,
        enrolledState,
      );
      const enrollmentRunId = enrolledState.plan.runId;
      assert(goalContract && enrollmentRunId);
      const goalEnrollmentRequirement = {
        case: enrollmentCase,
        run_id: enrollmentRunId,
        revision: enrolledState.revision,
        goal_id: formal[0].id,
      };
      const enrolledPlan = {
        id: "future-verified-local-report",
        classification: "INTERNAL" as const,
        steps: [
          { id: "verified-record", satisfiedBy: goalEnrollmentRequirement },
          { id: "record-report" },
        ],
      };
      const latePlan = { ...enrolledPlan, id: "late-local-report" };
      const enrollmentJournal = join(baseDir, "goal-enrollment-workflows.db");
      const workflowVerifier = createWorkflowObservationVerifier(baseDir);
      const buildGoalAdapter = () =>
        createOperatorWorkflowRuns(
          createWorkflowRunRegistry(),
          [enrolledPlan, latePlan],
          enrollmentJournal,
          workflowVerifier,
        );
      const pendingAdapter = buildGoalAdapter();
      const enrollment = {
        action: "enroll_goal_workflow",
        kind: "sentinel",
        id: enrollmentCase,
        runId: enrollmentRunId,
        revision: enrolledState.revision,
        goalId: formal[0].id,
        targetId: enrolledPlan.id,
        requestId: crypto.randomUUID(),
      };
      const pendingMonitor = pendingAdapter.startGoalEnrollmentMonitor(50);
      try {
        await withGateway(async (ownerTurn) => {
          const beforeEnrollment = confirmations.length;
          denied = "PRE_TOOL_CALL";
          await ownerTurn(enrollment);
          denied = undefined;
          assertEquals(confirmations.length, beforeEnrollment);
          assertStringIncludes(
            (await ownerTurn({ ...enrollment, goalId: "unmatched" })).result,
            "unavailable",
          );
          approved = false;
          assertStringIncludes(
            (await ownerTurn(enrollment)).result,
            "operator declined",
          );
          approved = true;
          assertEquals(pendingAdapter.list(), []);
          const saved =
            JSON.parse((await ownerTurn(enrollment)).result).enrollment;
          const reviewedCount = confirmations.length;
          assertEquals(
            JSON.parse((await ownerTurn(enrollment)).result).enrollment,
            saved,
          );
          assertEquals(confirmations.length, reviewedCount);
          assertEquals(saved.workflowRunId, undefined);
          assertEquals(pendingAdapter.list(), []);
        }, pendingAdapter);
      } finally {
        pendingMonitor.stop();
      }
      assert(
        reportSentinelGoalCompletion(enrollmentPath, goalContract.scope, [{
          criterionId: "local-check/record",
          evidence: [{
            source: "graph_evidence",
            reference: "verified-record",
            detail: "Reviewed the exact published evidence.",
          }],
        }]).assessmentCompleted,
      );
      const recoveredGoalAdapter = buildGoalAdapter();
      const recoveredMonitor = recoveredGoalAdapter.startGoalEnrollmentMonitor(
        50,
      );
      try {
        await withGateway(async (ownerTurn) => {
          await until(() =>
            recoveredGoalAdapter.list()[0]?.status === "completed"
          );
          const run = recoveredGoalAdapter.list()[0];
          const restoredEnrollment =
            JSON.parse((await ownerTurn(enrollment)).result).enrollment;
          assertEquals(restoredEnrollment.workflowRunId, run.runId);
          const trace = JSON.parse(
            (await ownerTurn({
              action: "traces",
              kind: "workflow",
              id: run.runId,
            })).result,
          ).page;
          const proof = trace.events.find(({ event }: { event: string }) =>
            event === "step_satisfied"
          );
          assertEquals(
            proof.evidence,
            await workflowVerifier(goalEnrollmentRequirement),
          );
          const approvalCount = confirmations.length;
          assertStringIncludes(
            (await ownerTurn({
              ...enrollment,
              targetId: latePlan.id,
              requestId: crypto.randomUUID(),
            })).result,
            "unavailable",
          );
          assertEquals(confirmations.length, approvalCount);
          assertEquals(recoveredGoalAdapter.list().map(({ runId }) => runId), [
            run.runId,
          ]);
        }, recoveredGoalAdapter);
      } finally {
        recoveredMonitor.stop();
      }

      const cancelRegistry = createWorkflowRunRegistry();
      const cancelAdapter = createOperatorWorkflowRuns(
        cancelRegistry,
        [plan],
        journalPath,
      );
      let cancelledRef: { kind: string; id: string } | undefined;
      await withGateway(async (cancelTurn) => {
        const started = JSON.parse(
          (await cancelTurn({
            action: "start",
            ...configured,
            requestId: crypto.randomUUID(),
          })).result,
        ).run;
        cancelledRef = started.ref;
        const cancelled = { action: "cancel", ...started.ref };
        denied = "PRE_TOOL_CALL";
        await cancelTurn(cancelled);
        assertEquals(cancelAdapter.inspect(started.ref.id)?.status, "running");
        denied = undefined;
        assertEquals(
          JSON.parse(
            (await cancelTurn({
              action: "pause",
              ...started.ref,
            })).result,
          ).run.status,
          "paused",
        );
        assertEquals(
          JSON.parse((await cancelTurn(cancelled)).result).run.status,
          "cancelled",
        );
        const approvalCount = confirmations.length;
        assertEquals(
          JSON.parse((await cancelTurn(cancelled)).result).run.status,
          "cancelled",
        );
        assertEquals(confirmations.length, approvalCount);
        await until(() => cancelRegistry.getActiveRun(started.ref.id) === null);
      }, cancelAdapter);
      assert(cancelledRef);
      const cancelledAdapter = createOperatorWorkflowRuns(
        createWorkflowRunRegistry(),
        [plan],
        journalPath,
      );
      const interruptedCancel = { kind: "workflow", id: crypto.randomUUID() };
      assert(
        journal.admit({
          ...prior,
          runId: interruptedCancel.id,
          requestId: crypto.randomUUID(),
          status: "running",
          completedAt: null,
          stepStatuses: '["completed","pending"]',
        }).admitted,
      );
      await withGateway(async (cancelTurn) => {
        const page = JSON.parse(
          (await cancelTurn({ action: "traces", ...cancelledRef })).result,
        ).page;
        assertEquals(
          page.events.filter(({ event }: { event: string }) =>
            event === "cancelled"
          ).length,
          1,
        );
        assert(
          !page.events.some(({ stepId }: { stepId?: string }) =>
            stepId === "record"
          ),
        );
        assertStringIncludes(
          (await cancelTurn({ action: "resume", ...cancelledRef })).result,
          "unavailable",
        );
        const interruptedOutcome = JSON.parse(
          (await cancelTurn({
            action: "cancel",
            ...interruptedCancel,
          })).result,
        ).run;
        assertEquals(interruptedOutcome.status, "cancelled");
        assertEquals(interruptedOutcome.details.steps[0].status, "completed");
        assertEquals(interruptedOutcome.details.steps[1].status, "pending");
        const receiving = createOperatorWorkflowRuns(
          createWorkflowRunRegistry(),
          [plan],
          join(baseDir, "terminal-workflows.db"),
        );
        const failedRun = { kind: "workflow", id: crypto.randomUUID() };
        assert(
          journal.admit({
            ...prior,
            runId: failedRun.id,
            requestId: crypto.randomUUID(),
            status: "running",
            completedAt: null,
            stepStatuses: '["pending","pending"]',
          }).admitted,
        );
        const failedAt = new Date().toISOString();
        journal.update(
          failedRun.id,
          "failed",
          failedAt,
          '["failed","pending"]',
          {
            event: "failed",
            at: failedAt,
          },
        );
        const alias = {
          action: "link",
          ...exact,
          targetKind: "workflow",
          targetId: linked.run.ref.id,
          requestId: crypto.randomUUID(),
        };
        assertEquals(
          JSON.parse((await cancelTurn(alias)).result).link,
          linked.link,
        );
        for (const ref of [cancelledRef!, linked.run.ref, failedRun]) {
          const traceRequest = { action: "traces", ...ref, limit: 20 };
          const originalTrace =
            JSON.parse((await cancelTurn(traceRequest)).result).page;
          const original =
            JSON.parse((await cancelTurn({ action: "inspect", ...ref })).result)
              .run;
          const archiveId = crypto.randomUUID();
          const exportReceipt = JSON.parse(
            (await cancelTurn({
              action: "archive",
              ...ref,
              requestId: archiveId,
            })).result,
          ).receipt;
          assertEquals(exportReceipt.status, "succeeded");
          const linkedChild = ref.id === linked.run.ref.id;
          const linkPath = join(baseDir, "operator-run-links.db");
          const originalLinkPath = join(baseDir, "original-operator-links.db");
          if (linkedChild) {
            await Deno.rename(linkPath, originalLinkPath);
            const conflict = openOperatorRunLinkStore(linkPath);
            try {
              conflict.record({
                scope: "workspace-operator",
                operatorId: "owner",
                requestId: alias.requestId,
                left: {
                  kind: "sentinel",
                  id: exact.id,
                  revision: exact.revision,
                },
                right: { kind: "workflow", id: workflow.id },
              });
            } finally {
              conflict.close();
            }
          }
          await withGateway(async (restoreTurn) => {
            if (linkedChild) {
              const rejected = JSON.parse(
                (await restoreTurn({
                  action: "restore",
                  ...ref,
                  archiveId,
                  requestId: crypto.randomUUID(),
                })).result,
              ).receipt;
              assertEquals(rejected.status, "failed");
              assertEquals(receiving.inspect(ref.id), undefined);
              await Deno.rename(
                linkPath,
                join(baseDir, "conflicting-operator-links.db"),
              );
            }
            const receipt = JSON.parse(
              (await restoreTurn({
                action: "restore",
                ...ref,
                archiveId,
                requestId: crypto.randomUUID(),
              })).result,
            ).receipt;
            assertEquals(receipt.status, "succeeded");
            assertEquals(
              JSON.parse(
                (await restoreTurn({ action: "inspect", ...ref })).result,
              ).run,
              original,
            );
            assertEquals(
              JSON.parse((await restoreTurn(traceRequest)).result).page,
              originalTrace,
            );
            assertStringIncludes(
              (await restoreTurn({ action: "resume", ...ref })).result,
              "unavailable",
            );
            if (linkedChild) {
              const restored = JSON.parse(
                (await restoreTurn({ action: "inspect", ...ref })).result,
              );
              assertEquals(restored.links, [linked.link]);
              const before = confirmations.length;
              assertEquals(
                JSON.parse((await restoreTurn(alias)).result).link,
                linked.link,
              );
              assertEquals(confirmations.length, before);
            }
          }, receiving);
          if (linkedChild) {
            await Deno.rename(
              linkPath,
              join(baseDir, "restored-operator-links.db"),
            );
            await Deno.rename(originalLinkPath, linkPath);
          }
        }
      }, cancelledAdapter);

      const goalRun = (await turn({
        action: "inspect",
        kind: "sentinel",
        id: peer.id,
      })).result;
      const currentGoalRef = JSON.parse(goalRun).run.ref;
      const goalRunId = JSON.parse(goalRun).run.details.runId;
      const goal = {
        id: "peer-review",
        title: "Review retained peer controls",
        policy: "operator",
        criteria: [{
          id: "record",
          description: "Read the retained record",
          source: "graph_evidence",
          reference: "peer-only",
        }],
      };
      const appendGoals = {
        action: "append_goals",
        ...currentGoalRef,
        runId: goalRunId,
        requestId: crypto.randomUUID(),
        goals: [goal],
      };
      assertEquals(
        JSON.parse((await turn({ action: "goals", ...currentGoalRef })).result)
          .goals,
        [],
      );
      const beforeGoalApproval = confirmations.length;
      denied = "PRE_TOOL_CALL";
      await turn(appendGoals);
      assertEquals(confirmations.length, beforeGoalApproval);
      assertEquals(
        readSentinelAssessment(peerPath)?.revision,
        currentGoalRef.revision,
      );
      denied = undefined;
      const appendReceipt =
        JSON.parse((await turn(appendGoals)).result).receipt;
      const appendedRef = {
        ...currentGoalRef,
        revision: appendReceipt.appliedRevision,
      };
      const reviseGoals = {
        ...appendGoals,
        ...appendedRef,
        action: "revise_goals",
        requestId: crypto.randomUUID(),
        goals: [{
          ...goal,
          title: "Review the revised peer criteria",
          criteria: [{
            ...goal.criteria[0],
            description: "Verify the exact evidence link",
          }],
        }],
      };
      const revisedReceipt =
        JSON.parse((await turn(reviseGoals)).result).receipt;
      const revisedRef = {
        ...appendedRef,
        revision: revisedReceipt.appliedRevision,
      };
      assertEquals(revisedRef.revision, appendedRef.revision + 1);
      assertEquals(
        readSentinelAssessment(peerPath)?.plan.formalGoals,
        reviseGoals.goals,
      );
      assertStringIncludes(
        (await turn({
          ...reviseGoals,
          revision: appendedRef.revision,
          requestId: crypto.randomUUID(),
        })).result,
        "unavailable",
      );
      const goalApprovalCount = confirmations.length;
      await withGateway(async (reopenTurn) => {
        const prior =
          JSON.parse((await reopenTurn(reviseGoals)).result).receipt;
        assertEquals(prior.appliedRevision, revisedRef.revision);
        assertEquals(prior.duplicate, true);
        assertEquals(confirmations.length, goalApprovalCount);
        const getCriteria = async (ref: Record<string, unknown>) =>
          JSON.parse(
            (await reopenTurn({ action: "goals", ...ref, goalId: goal.id }))
              .result,
          ).criteria;
        assertEquals(await getCriteria(appendedRef), goal.criteria);
        assertEquals(
          await getCriteria(revisedRef),
          reviseGoals.goals[0].criteria,
        );
        denied = "POST_TOOL_RESPONSE";
        assertEquals(
          (await reopenTurn({ action: "goals", ...revisedRef })).result,
          "Tool response withheld by policy.",
        );
        denied = "PRE_OUTPUT";
        assert((await reopenTurn({ action: "goals", ...revisedRef })).error);
        denied = undefined;
      }, restarted);

      const tracePath = join(baseDir, "execution-traces.db");
      const traceJournal = openExecutionTraces(tracePath);
      const scheduled = { ...traceScope, role: "scheduled" as const };
      const interruptedScope = { ...traceScope, runId: crypto.randomUUID() };
      const pendingScheduledScope = {
        ...scheduled,
        runId: crypto.randomUUID(),
      };
      const scheduledRecoveryKey = await computeContentHash(JSON.stringify([
        pendingScheduledScope.sessionId,
        pendingScheduledScope.runId,
      ]));
      const recoveryKey = await computeContentHash(JSON.stringify([
        interruptedScope.sessionId,
        interruptedScope.runId,
      ]));
      const recoveryPath = join(baseDir, "agent-recovery.db");
      const recovery = new AgentRecoveryStore(recoveryPath);
      try {
        const binding = "a".repeat(64);
        assert(recovery.begin(scheduledRecoveryKey, binding));
        assert(
          recovery.beginBatch(scheduledRecoveryKey, binding, 1, 0, false, true),
        );
        assert(recovery.begin(recoveryKey, binding));
        assert(recovery.beginBatch(recoveryKey, binding, 1));
        assert(recovery.commitBatch(recoveryKey, binding, 1, {
          history: [
            {
              role: "user",
              content: "[Original request supplied again at resume]",
            },
            { role: "assistant", content: " " },
            { role: "user", content: "Verified fixture status" },
          ],
          completedIterations: 1,
          tokenUsage: { inputTokens: 1, outputTokens: 1 },
          nudgeCount: 0,
          eosRetries: 0,
          toolCallCounts: [],
        }, [{
          name: "github_actions",
          callId: "1:0",
          args: { action: "list_runs", repo: workflowPayload.repo },
          classification: "INTERNAL",
          resultSha256: await computeContentHash("Verified fixture status"),
        }]));
      } finally {
        recovery.close();
      }
      try {
        assert(traceJournal.admit(interruptedScope));
        assert(traceJournal.admit(pendingScheduledScope));
        assert(traceJournal.append(interruptedScope, {
          ordinal: 1,
          tool: "github_actions",
          classification: "INTERNAL",
          outcome: "returned",
        }, workflowPayload));
        assert(traceJournal.append(traceScope, {
          ordinal: 3,
          tool: "github_repos",
          classification: "INTERNAL",
          outcome: "returned",
        }, repositoryPayload));
        assert(traceJournal.append(traceScope, {
          ordinal: 4,
          tool: "github_pulls",
          classification: "INTERNAL",
          outcome: "returned",
        }, pullPayload));
        assert(traceJournal.append(traceScope, {
          ordinal: 5,
          tool: "github_repos",
          classification: "INTERNAL",
          outcome: "returned",
        }, releasePayload));
        assert(traceJournal.append(traceScope, {
          ordinal: 6,
          tool: "github_repos",
          classification: "INTERNAL",
          outcome: "returned",
        }, branchPayload));
        assert(traceJournal.append(traceScope, {
          ordinal: 7,
          tool: "github_actions",
          classification: "INTERNAL",
          outcome: "returned",
        }, exactActionsPayload));
        assert(traceJournal.finish(traceScope, "completed"));
        assert(traceJournal.finish(confidentialScope, "completed"));
        assert(traceJournal.admit(scheduled));
        assert(traceJournal.append(scheduled, {
          ordinal: 1,
          tool: "read_file",
          classification: "INTERNAL",
          outcome: "returned",
        }));
        for (const ordinal of [2, 3]) {
          assert(traceJournal.append(scheduled, {
            ordinal,
            tool: "github_actions",
            classification: "INTERNAL",
            outcome: "returned",
          }, workflowPayload));
        }
        assert(traceJournal.finish(scheduled, "failed"));
      } finally {
        traceJournal.close();
      }
      const delegatedRef = { kind: traceScope.role, id: traceScope.runId };
      const scheduledRef = { kind: scheduled.role, id: scheduled.runId };
      for (
        const [ref, status] of [[delegatedRef, "completed"], [
          scheduledRef,
          "failed",
        ]] as const
      ) {
        const query = { action: "list", kind: ref.kind, limit: 1 };
        const firstPage = JSON.parse((await turn(query)).result);
        if (ref.kind === "delegated" && firstPage.nextCursor) {
          assertStringIncludes(
            (await turn({
              ...query,
              kind: "scheduled",
              cursor: firstPage.nextCursor,
            })).result,
            "unavailable",
          );
        }
        const runs = [...firstPage.runs];
        let cursor = firstPage.nextCursor;
        while (cursor !== null && runs.length < 15) {
          const page = JSON.parse((await turn({ ...query, cursor })).result);
          runs.push(...page.runs);
          cursor = page.nextCursor;
        }
        assert(!runs.some((run) => run.ref.id === confidentialScope.runId));
        const retained = runs.find((run) => run.ref.id === ref.id);
        assert(retained);
        const detail = JSON.parse(
          (await turn({ action: "inspect", ...ref })).result,
        );
        assertEquals(detail.run, retained);
        assertEquals(detail.run.status, status);
        assert(!JSON.stringify(detail).includes("sessionId"));
      }
      for (
        const ref of [
          { ...scheduledRef, id: confidentialScope.runId },
          { ...delegatedRef, id: confidentialScope.runId },
        ]
      ) {
        assertStringIncludes(
          (await turn({ action: "inspect", ...ref })).result,
          "unavailable",
        );
      }
      const inspectScheduled = { action: "inspect", ...scheduledRef };
      denied = "PRE_TOOL_CALL";
      assert(!(await turn(inspectScheduled)).result.includes(scheduledRef.id));
      denied = "POST_TOOL_RESPONSE";
      assertEquals(
        (await turn(inspectScheduled)).result,
        "Tool response withheld by policy.",
      );
      denied = "PRE_OUTPUT";
      assert((await turn(inspectScheduled)).error);
      denied = undefined;
      await withGateway(async (reopen) => {
        const pendingInspect = {
          action: "inspect",
          kind: "scheduled",
          id: pendingScheduledScope.runId,
        };
        const pending = JSON.parse((await reopen(pendingInspect)).result);
        assertEquals(pending.run.status, "running");
        assertEquals(pending.recovery, {
          status: "pending",
          committedBatch: 0,
          pendingBatch: 1,
          pauseRequested: false,
          nextAction: "authorize_dispatch",
        });
        const delegatedInspect = {
          action: "inspect",
          kind: "delegated",
          id: interruptedScope.runId,
        };
        const delegated = JSON.parse((await reopen(delegatedInspect)).result);
        assertEquals(delegated.recovery, {
          status: "ready",
          committedBatch: 1,
        });
        assert(!JSON.stringify(delegated).includes("Verified fixture status"));
        assert(!JSON.stringify(delegated).includes(workflowPayload.repo));
        assert(!JSON.stringify(pending).includes(scheduledRecoveryKey));
        assertStringIncludes(
          (await reopen({ ...pendingInspect, kind: "delegated" })).result,
          "unavailable",
        );
        const priorPauseReviews = confirmations.length;
        duringConfirmation = () => {
          denied = "PRE_TOOL_CALL";
        };
        try {
          assertStringIncludes(
            (await reopen({ ...pendingInspect, action: "pause" })).result,
            "unavailable",
          );
        } finally {
          duringConfirmation = undefined;
          denied = undefined;
        }
        assertEquals(confirmations.length, priorPauseReviews + 1);
        assertEquals(
          JSON.parse((await reopen(pendingInspect)).result).recovery,
          pending.recovery,
        );
        denied = "PRE_TOOL_CALL";
        assert(
          !(await reopen(pendingInspect)).result.includes("authorize_dispatch"),
        );
        denied = "POST_TOOL_RESPONSE";
        assertEquals(
          (await reopen(pendingInspect)).result,
          "Tool response withheld by policy.",
        );
        denied = "PRE_OUTPUT";
        assert((await reopen(delegatedInspect)).error);
        denied = undefined;
      }, restarted);
      const backgroundLink = {
        action: "link",
        ...delegatedRef,
        targetKind: scheduledRef.kind,
        targetId: scheduledRef.id,
        requestId: crypto.randomUUID(),
      };
      const beforeBackgroundLink = confirmations.length;
      denied = "PRE_TOOL_CALL";
      assert(!(await turn(backgroundLink)).result.includes(scheduledRef.id));
      denied = undefined;
      assertStringIncludes(
        (await turn({
          ...backgroundLink,
          id: confidentialScope.runId,
        })).result,
        "unavailable",
      );
      assertEquals(confirmations.length, beforeBackgroundLink);
      const linkedBackground =
        JSON.parse((await turn(backgroundLink)).result).link;
      assertEquals(confirmations.length, beforeBackgroundLink + 1);
      assertEquals(
        JSON.parse((await turn(backgroundLink)).result).link,
        linkedBackground,
      );
      assertEquals(confirmations.length, beforeBackgroundLink + 1);
      await withGateway(async (reopen) => {
        for (const ref of [delegatedRef, scheduledRef]) {
          const detail = JSON.parse(
            (await reopen({ action: "inspect", ...ref })).result,
          );
          assert(
            detail.links.some(({ id }: { id: string }) =>
              id === linkedBackground.id
            ),
          );
        }
        assertEquals(
          JSON.parse((await reopen(backgroundLink)).result).link,
          linkedBackground,
        );
        assertEquals(confirmations.length, beforeBackgroundLink + 1);
      }, restarted);
      const hostedTraceSearch = {
        action: "search_case_traces",
        query: "",
        scopes: [
          {
            id: "trace-search-left",
            revision: readSentinelAssessment(
              resolveSentinelCasePath(baseDir, "trace-search-left"),
            )!.revision,
          },
          delegatedRef,
          scheduledRef,
        ],
      };
      const hostedPages =
        JSON.parse((await turn(hostedTraceSearch)).result).pages;
      assertEquals(
        hostedPages[0].page.steps[0].target,
        "search-fixture-local-0",
      );
      assertEquals(
        hostedPages.slice(1).map(({ run }: { run: unknown }) => run),
        [
          delegatedRef,
          scheduledRef,
        ],
      );
      assertEquals(hostedPages[1].page.steps[0].ordinal, 1);
      assertEquals(hostedPages[2].page.steps[0].tool, "read_file");
      const scheduledCursor = hostedPages[2].page.nextCursor;
      assert(typeof scheduledCursor === "string");
      const scheduledPage = JSON.parse(
        (await turn({
          ...hostedTraceSearch,
          scopes: [delegatedRef, { ...scheduledRef, cursor: scheduledCursor }],
        })).result,
      ).pages[1].page;
      const exactScheduled = JSON.parse(
        (await turn({
          action: "execution_traces",
          traceRole: "scheduled",
          id: scheduledRef.id,
          ordinal: 2,
        })).result,
      ).step;
      assertEquals(scheduledPage.steps, [exactScheduled]);
      const hostedMatches = JSON.parse(
        (await turn({
          ...hostedTraceSearch,
          query: "github_actions",
        })).result,
      ).pages;
      for (const { page } of hostedMatches.slice(1)) {
        assertEquals(page.matches[0].tool, "github_actions");
        assert(!JSON.stringify(page).includes(workflowPayload.repo));
      }
      for (
        const scope of [
          { ...delegatedRef, cursor: scheduledCursor },
          { ...delegatedRef, id: confidentialScope.runId },
        ]
      ) {
        const blocked = await turn({
          ...hostedTraceSearch,
          scopes: [hostedTraceSearch.scopes[0], scope],
        });
        assertStringIncludes(blocked.result, "unavailable");
        assert(!blocked.result.includes("search-fixture-local-0"));
      }
      const restores: {
        restore: Record<string, unknown>;
        inspect: Record<string, unknown>;
        saved: unknown;
        scope: typeof traceScope | typeof scheduled;
        checklist: Awaited<
          ReturnType<ReturnType<typeof createTodoManager>["read"]>
        >;
      }[] = [];
      const checklistFor = (scope: typeof traceScope | typeof scheduled) =>
        createTodoManager({
          agentId: `recovery-${scope.sessionId}`,
          storage: scopedExecutionChecklistStorage(
            tracePath,
            scope,
            createMemoryStorage(),
          ),
          getClassification: () => "INTERNAL",
        });
      for (const scope of [traceScope, scheduled, interruptedScope]) {
        const exact = { kind: scope.role, id: scope.runId };
        const checklist = await checklistFor(scope).write([{
          id: "fixture-archive-task",
          content: `Review ${scope.role} checklist evidence`,
          status: scope === interruptedScope ? "pending" : "completed",
          priority: "high",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        }]);
        const requestId = crypto.randomUUID();
        const archive = { action: "archive", ...exact, requestId };
        const receipt = JSON.parse((await turn(archive)).result).receipt;
        assertEquals(receipt.status, "succeeded");
        assertEquals(JSON.parse((await turn(archive)).result).receipt, receipt);
        const inspect = {
          action: "execution_traces",
          traceRole: scope.role,
          id: scope.runId,
          ordinal: 1,
        };
        const saved = JSON.parse((await turn(inspect)).result);
        const restore = {
          action: "restore",
          ...exact,
          archiveId: requestId,
          requestId: crypto.randomUUID(),
        };
        assertEquals(
          JSON.parse(
            (await turn({
              ...restore,
              requestId: crypto.randomUUID(),
            })).result,
          ).receipt.status,
          "failed",
        );
        restores.push({ restore, inspect, saved, scope, checklist });
      }
      const hiddenArchive = {
        action: "archive",
        kind: "delegated",
        id: confidentialScope.runId,
        requestId: crypto.randomUUID(),
      };
      const crossRole = JSON.parse(
        (await turn({ action: "execution_traces", query: "READ_FILE" })).result,
      ).page;
      assertEquals(
        crossRole.matches.map(({ role }: { role: string }) => role),
        ["scheduled", "delegated"],
      );
      const resultSearch = {
        action: "execution_trace_payload",
        traceRole: "scheduled",
        id: scheduled.runId,
        query: workflowPayload.runs[0].conclusion,
        limit: 1,
      };
      const page = JSON.parse((await turn(resultSearch)).result).page;
      assertEquals(page.matches[0]?.ordinal, 3);
      assert(typeof page.nextCursor === "string");
      allowTracePayload = false;
      const revokedPage = JSON.parse((await turn(resultSearch)).result).page;
      assertEquals(revokedPage.matches, []);
      assertEquals(revokedPage.nextCursor, page.nextCursor);
      allowTracePayload = true;
      const next = JSON.parse(
        (await turn({
          ...resultSearch,
          cursor: page.nextCursor,
        })).result,
      ).page;
      assertEquals(next.matches[0]?.ordinal, 2);
      assertEquals(next.nextCursor, null);
      const allMatches: string[] = [];
      let allCursor: string | undefined;
      for (let index = 0; index < 5; index++) {
        const page = JSON.parse(
          (await turn({
            action: resultSearch.action,
            query: resultSearch.query,
            ...(allCursor && { cursor: allCursor }),
          })).result,
        ).page;
        allMatches.push(
          ...page.matches.map(({ runId }: { runId: string }) => runId),
        );
        allCursor = page.nextCursor ?? undefined;
        if (!allCursor) break;
      }
      assertEquals(allCursor, undefined);
      assertEquals(allMatches, [
        scheduled.runId,
        scheduled.runId,
        interruptedScope.runId,
        traceScope.runId,
      ]);
      assertEquals(
        JSON.parse((await turn(hiddenArchive)).result).receipt.status,
        "failed",
      );
      await Deno.rename(tracePath, join(baseDir, "original-traces.db"));
      await Deno.rename(recoveryPath, join(baseDir, "original-recovery.db"));
      await withGateway(async (restoreTurn) => {
        const first = restores[0];
        const archiveDir = join(
          baseDir,
          "data",
          "run-archives",
          String(first.restore.archiveId),
        );
        const archivedTrace = join(archiveDir, "execution-trace.json");
        const archivedManifest = join(archiveDir, "manifest.json");
        const sourceTrace = await Deno.readTextFile(archivedTrace);
        const sourceManifest = await Deno.readTextFile(archivedManifest);
        const hash = (data: string) =>
          createHash("sha256").update(data).digest("hex");
        const sourceDigest = hash(JSON.stringify(JSON.parse(sourceManifest)));
        const forged = JSON.parse(sourceTrace);
        const forgedTodos = JSON.parse(forged.checklist.contents);
        forgedTodos.todos[0].content = "Bearer invalid-credential-fixture";
        forged.checklist.contents = JSON.stringify(forgedTodos);
        const forgedTrace = JSON.stringify(forged);
        const forgedManifest = JSON.parse(sourceManifest);
        forgedManifest.artifacts[0].bytes =
          new TextEncoder().encode(forgedTrace).length;
        forgedManifest.artifacts[0].sha256 = hash(forgedTrace);
        const forgedManifestText = JSON.stringify(forgedManifest);
        const actions = new DatabaseSync(
          join(baseDir, "data", "run-archives", "actions.db"),
        );
        try {
          const setDigest = actions.prepare(
            "UPDATE run_archive_actions SET archiveDigest = ? WHERE requestId = ?",
          );
          await Deno.writeTextFile(archivedTrace, forgedTrace);
          await Deno.writeTextFile(archivedManifest, forgedManifestText);
          assertEquals(
            setDigest.run(
              hash(forgedManifestText),
              String(first.restore.archiveId),
            ).changes,
            1,
          );
          assertEquals(
            await withVerifiedRunArchive(
              archiveDir,
              dirname(archiveDir),
              { permittedNames: ["execution-trace.json"] },
              ({ manifest }) => hash(JSON.stringify(manifest)),
            ),
            hash(forgedManifestText),
          );
          assertEquals(
            JSON.parse(
              (await restoreTurn({
                ...first.restore,
                requestId: crypto.randomUUID(),
              })).result,
            ).receipt.status,
            "failed",
          );
          assertEquals((await checklistFor(first.scope).read()).todos, []);
          assertStringIncludes(
            (await restoreTurn(first.inspect)).result,
            "unavailable",
          );
          await Deno.writeTextFile(archivedTrace, sourceTrace);
          await Deno.writeTextFile(archivedManifest, sourceManifest);
          assertEquals(
            setDigest.run(sourceDigest, String(first.restore.archiveId))
              .changes,
            1,
          );
        } finally {
          actions.close();
        }
        const conflictingChecklist = await checklistFor(first.scope).write([{
          ...first.checklist.todos[0],
          content: "Existing destination checklist",
        }]);
        assertEquals(
          JSON.parse(
            (await restoreTurn({
              ...first.restore,
              requestId: crypto.randomUUID(),
            }))
              .result,
          ).receipt.status,
          "failed",
        );
        assertEquals(
          await checklistFor(first.scope).read(),
          conflictingChecklist,
        );
        assertStringIncludes(
          (await restoreTurn(first.inspect)).result,
          "unavailable",
        );
        const conflictedDestination = new DatabaseSync(tracePath);
        try {
          assertEquals(
            conflictedDestination.prepare(
              "DELETE FROM execution_checklists WHERE role=? AND sessionId=? AND runId=?",
            ).run(first.scope.role, first.scope.sessionId, first.scope.runId)
              .changes,
            1,
          );
        } finally {
          conflictedDestination.close();
        }
        const interrupted = restores.at(-1)!;
        const collision = new AgentRecoveryStore(recoveryPath);
        try {
          assert(collision.begin(recoveryKey, "b".repeat(64)));
          const rejected = await restoreTurn({
            ...interrupted.restore,
            requestId: crypto.randomUUID(),
          });
          assertEquals(JSON.parse(rejected.result).receipt.status, "failed");
          assertStringIncludes(
            (await restoreTurn(interrupted.inspect)).result,
            "unavailable",
          );
          assertEquals(collision.read(recoveryKey)?.binding, "b".repeat(64));
        } finally {
          collision.close();
        }
        await Deno.rename(recoveryPath, join(baseDir, "collision-recovery.db"));
        for (const { restore, inspect, saved, scope, checklist } of restores) {
          assertEquals(
            JSON.parse((await restoreTurn(restore)).result).receipt.status,
            "succeeded",
          );
          leaveArchiveActionPending(baseDir, String(restore.requestId));
          const beforeRetry = confirmations.length;
          assertEquals(
            JSON.parse((await restoreTurn(restore)).result).receipt.status,
            "succeeded",
          );
          assertEquals(confirmations.length, beforeRetry);
          assertEquals(JSON.parse((await restoreTurn(inspect)).result), saved);
          assertEquals(await checklistFor(scope).read(), checklist);
        }
        const restoredRecovery = new AgentRecoveryStore(recoveryPath);
        try {
          const checkpoint = restoredRecovery.read(recoveryKey);
          assert(checkpoint?.status === "paused");
          assertEquals(checkpoint.checkpoint?.completedIterations, 1);
          assertEquals(
            restoredRecovery.beginBatch(recoveryKey, checkpoint.binding, 2),
            false,
          );
        } finally {
          restoredRecovery.close();
        }
        const payload = {
          action: "execution_trace_payload",
          traceRole: "delegated",
          id: traceScope.runId,
          ordinal: 2,
        };
        allowTracePayload = false;
        assertStringIncludes(
          (await restoreTurn(payload)).result,
          "unavailable",
        );
        allowTracePayload = true;
        assertEquals(
          JSON.parse((await restoreTurn(payload)).result).payload,
          workflowPayload,
        );
        const repositoryAction = { ...payload, ordinal: 3 };
        traceSourceChecks.length = 0;
        assertEquals(
          JSON.parse((await restoreTurn(repositoryAction)).result).payload,
          repositoryPayload,
        );
        assertEquals(traceSourceChecks, [
          "PRE_TOOL_CALL",
          "POST_TOOL_RESPONSE",
        ]);
        for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"] as const) {
          denyTraceSource = hook;
          assertStringIncludes(
            (await restoreTurn(repositoryAction)).result,
            "unavailable",
          );
        }
        const pullAction = { ...payload, ordinal: 4 };
        denyTraceSource = undefined;
        traceSourceChecks.length = 0;
        assertEquals(
          JSON.parse((await restoreTurn(pullAction)).result).payload,
          pullPayload,
        );
        assertEquals(traceSourceChecks, [
          "PRE_TOOL_CALL",
          "POST_TOOL_RESPONSE",
        ]);
        for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"] as const) {
          denyTraceSource = hook;
          assertStringIncludes(
            (await restoreTurn(pullAction)).result,
            "unavailable",
          );
        }
        const releaseAction = { ...payload, ordinal: 5 };
        denyTraceSource = undefined;
        traceSourceChecks.length = 0;
        assertEquals(
          JSON.parse((await restoreTurn(releaseAction)).result).payload,
          releasePayload,
        );
        assertEquals(traceSourceChecks, [
          "PRE_TOOL_CALL",
          "POST_TOOL_RESPONSE",
        ]);
        for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"] as const) {
          denyTraceSource = hook;
          assertStringIncludes(
            (await restoreTurn(releaseAction)).result,
            "unavailable",
          );
        }
        const branchAction = { ...payload, ordinal: 6 };
        denyTraceSource = undefined;
        traceSourceChecks.length = 0;
        assertEquals(
          JSON.parse((await restoreTurn(branchAction)).result).payload,
          branchPayload,
        );
        assertEquals(traceSourceChecks, [
          "PRE_TOOL_CALL",
          "POST_TOOL_RESPONSE",
        ]);
        for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"] as const) {
          denyTraceSource = hook;
          assertStringIncludes(
            (await restoreTurn(branchAction)).result,
            "unavailable",
          );
        }
        denyTraceSource = undefined;
        const exactActions = { ...payload, ordinal: 7 };
        traceSourceChecks.length = 0;
        assertEquals(
          JSON.parse((await restoreTurn(exactActions)).result).payload,
          exactActionsPayload,
        );
        assertEquals(traceSourceChecks, [
          "PRE_TOOL_CALL",
          "POST_TOOL_RESPONSE",
        ]);
        for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"] as const) {
          denyTraceSource = hook;
          assertStringIncludes(
            (await restoreTurn(exactActions)).result,
            "unavailable",
          );
        }
        denyTraceSource = undefined;
        const exactActionsSearch = {
          action: "execution_trace_payload",
          traceRole: "delegated",
          id: traceScope.runId,
          query: "cancelled",
        };
        assertEquals(
          JSON.parse((await restoreTurn(exactActionsSearch)).result).page
            .matches
            .map(({ ordinal }: { ordinal: number }) => ordinal),
          [7],
        );
        assertEquals(originalToolInvocations, 0);
        const namedSearch = {
          action: "execution_trace_payload",
          traceRole: "delegated",
          id: traceScope.runId,
          query: "main",
          limit: 2,
        };
        const allowedPage =
          JSON.parse((await restoreTurn(namedSearch)).result).page;
        assertEquals(
          allowedPage.matches.map(({ ordinal }: { ordinal: number }) =>
            ordinal
          ),
          [6],
        );
        allowTracePayload = false;
        const unavailablePage =
          JSON.parse((await restoreTurn(namedSearch)).result).page;
        assertEquals(unavailablePage.matches, []);
        assertEquals(unavailablePage.nextCursor, allowedPage.nextCursor);
        allowTracePayload = true;
        denyTraceSource = undefined;
        const evidenceCase = "branch-evidence";
        const evidencePath = resolveSentinelCasePath(baseDir, evidenceCase);
        await Deno.mkdir(dirname(evidencePath), { recursive: true });
        await Deno.writeTextFile(
          evidencePath,
          JSON.stringify({
            version: 1,
            nodes: [
              { id: "repo-asset", kind: "asset", label: "Repository" },
              {
                id: "branch-finding",
                kind: "finding",
                label: "Branch control review",
                severity: "low",
              },
              {
                id: "branch-control",
                kind: "control",
                label: "Required branch protection",
              },
            ],
            edges: [
              { from: "branch-finding", to: "repo-asset", relation: "affects" },
              {
                from: "branch-control",
                to: "branch-finding",
                relation: "mitigates",
              },
            ],
          }),
        );
        const visibilityCase = "visibility-evidence";
        const visibilityPath = resolveSentinelCasePath(baseDir, visibilityCase);
        await Deno.mkdir(dirname(visibilityPath), { recursive: true });
        await Deno.writeTextFile(
          visibilityPath,
          JSON.stringify({
            version: 1,
            nodes: [
              { id: "private-repo", kind: "asset", label: "Repository" },
              {
                id: "visibility-finding",
                kind: "finding",
                label: "Exposure",
                severity: "low",
              },
              {
                id: "private-control",
                kind: "control",
                label: "Private repository required",
              },
              {
                id: "workflow-control",
                kind: "control",
                label: "Workflow must succeed",
              },
              {
                id: "attempt-control",
                kind: "control",
                label: "Retry must succeed",
              },
            ],
            edges: [
              {
                from: "visibility-finding",
                to: "private-repo",
                relation: "affects",
              },
              {
                from: "private-control",
                to: "visibility-finding",
                relation: "mitigates",
              },
              {
                from: "workflow-control",
                to: "visibility-finding",
                relation: "mitigates",
              },
              {
                from: "attempt-control",
                to: "visibility-finding",
                relation: "mitigates",
              },
            ],
          }),
        );
        const visibility = startSentinelAssessment(visibilityPath);
        const attachVisibility = {
          action: "attach_repository_visibility_evidence",
          kind: "sentinel",
          id: visibilityCase,
          revision: visibility.revision,
          node: "private-repo",
          controlId: "private-control",
          runId: visibility.plan.runId,
          traceRole: "delegated",
          traceRunId: traceScope.runId,
          ordinal: 3,
          validUntil: new Date(Date.now() + 60_000).toISOString(),
        };
        const beforeVisibilityApproval = confirmations.length;
        assertStringIncludes(
          (await restoreTurn({ ...attachVisibility, ordinal: 6 })).result,
          "unavailable",
        );
        assertEquals(confirmations.length, beforeVisibilityApproval);
        denyTraceSource = "POST_TOOL_RESPONSE";
        try {
          assertStringIncludes(
            (await restoreTurn(attachVisibility)).result,
            "unavailable",
          );
        } finally {
          denyTraceSource = undefined;
        }
        assertEquals(confirmations.length, beforeVisibilityApproval);
        assertEquals(
          readSentinelAssessment(visibilityPath)?.revision,
          visibility.revision,
        );
        const visibilityReceipt =
          JSON.parse((await restoreTurn(attachVisibility)).result).receipt;
        assertEquals(visibilityReceipt.verification.outcome, "pass");
        assertEquals(visibilityReceipt.executionSource.ordinal, 3);
        assertEquals(
          JSON.parse((await restoreTurn(attachVisibility)).result).receipt,
          visibilityReceipt,
        );
        assertEquals(confirmations.length, beforeVisibilityApproval + 1);
        const verifiedVisibility = readSentinelAssessment(visibilityPath);
        assert(
          verifiedVisibility &&
            verifiedVisibility.revision > visibility.revision,
        );
        const visibilityGraph = verifiedVisibility.result?.sharedGraph.snapshot;
        assert(
          visibilityGraph?.edges.some(({ from, to, relation }) =>
            from === visibilityReceipt.evidenceId && to === "private-control" &&
            relation === "verifies"
          ),
        );
        const reopenedVisibility = JSON.parse(
          (await restoreTurn({
            action: "case_execution_evidence",
            kind: "sentinel",
            id: visibilityCase,
            revision: verifiedVisibility.revision,
            node: visibilityReceipt.evidenceId,
          })).result,
        ).evidence;
        assertEquals(reopenedVisibility.payload, repositoryPayload);
        assertEquals(
          reopenedVisibility.resultSha256,
          visibilityReceipt.executionSource.resultSha256,
        );
        const visibilityScope = { ...traceScope, runId: crypto.randomUUID() };
        const appendVisibility = (
          ordinal: number,
          payload: typeof repositoryPayload | typeof publicRepositoryPayload,
        ) => {
          const history = openExecutionTraces(tracePath);
          try {
            if (ordinal === 1) assert(history.admit(visibilityScope));
            assert(history.append(visibilityScope, {
              ordinal,
              tool: "github_repos",
              classification: "INTERNAL",
              outcome: "returned",
            }, payload));
          } finally {
            history.close();
          }
        };
        appendVisibility(1, publicRepositoryPayload);
        const failedVisibility = JSON.parse(
          (await restoreTurn({
            ...attachVisibility,
            revision: verifiedVisibility.revision,
            traceRunId: visibilityScope.runId,
            ordinal: 1,
          })).result,
        ).receipt;
        assertEquals(failedVisibility.verification.outcome, "fail");
        const failedVisibilityState = readSentinelAssessment(visibilityPath)!;
        const visibilityJournal = openSentinelWorkerFindingStore(
          visibilityPath,
        );
        let visibilityFinding;
        try {
          visibilityFinding = visibilityJournal.recordFinding({
            caseId: visibilityCase,
            runId: visibility.plan.runId!,
            evidenceRevision: failedVisibilityState.revision,
            taskId: "prior-visibility-review",
            targetId: "private-repo",
            graphFindingId: "visibility-finding",
            controlId: "private-control",
            evidenceId: failedVisibility.evidenceId,
            snapshotDigest: "a".repeat(64),
            observedAt: failedVisibility.verification.observedAt,
            evaluatedAt: failedVisibilityState.updatedAt,
            validUntil: attachVisibility.validUntil,
            requestId: crypto.randomUUID(),
            title: "Public repository",
            summary: "The control requires private visibility.",
          });
        } finally {
          visibilityJournal.close();
        }
        assert(visibilityFinding);
        appendVisibility(2, repositoryPayload);
        const visibilitySources = JSON.parse(
          (await restoreTurn({
            action: "finding_recheck_sources",
            kind: "sentinel",
            id: visibilityCase,
            revision: failedVisibilityState.revision,
            receiptId: visibilityFinding.id,
            traceRole: "delegated",
            traceRunId: visibilityScope.runId,
            validUntil: attachVisibility.validUntil,
          })).result,
        );
        assertEquals(
          visibilitySources.candidates.map(({ attachment }: {
            attachment: { action: string; ordinal: number };
          }) => [attachment.action, attachment.ordinal]),
          [["attach_repository_visibility_evidence", 2]],
        );
        const privateReceipt = JSON.parse(
          (await restoreTurn({
            ...attachVisibility,
            revision: failedVisibilityState.revision,
            traceRunId: visibilityScope.runId,
            ordinal: 2,
          })).result,
        ).receipt;
        const passingVisibility = readSentinelAssessment(visibilityPath)!;
        advanceAdaptiveSentinel(visibilityPath, passingVisibility);
        const visibilityRef = {
          kind: "sentinel",
          id: visibilityCase,
          revision: passingVisibility.revision,
        };
        const candidates = JSON.parse(
          (await restoreTurn({
            ...visibilityRef,
            action: "finding_recheck_candidates",
            receiptId: visibilityFinding.id,
          })).result,
        );
        assertEquals(candidates.candidates, [{
          nodeId: privateReceipt.evidenceId,
          resultSha256: privateReceipt.executionSource.resultSha256,
        }]);
        const visibilityAssignment = {
          ...visibilityRef,
          action: "assign",
          runId: candidates.runId,
          adaptiveRevision: candidates.adaptiveRevision,
          requestId: crypto.randomUUID(),
          node: privateReceipt.evidenceId,
          taskKind: "review_evidence",
          recheckFindingId: visibilityFinding.id,
        };
        const recoverySession = createSession({
          userId: "owner" as UserId,
          channelId: "test" as ChannelId,
          bumpersEnabled: false,
        });
        let evidenceAccess = true;
        let sourceChecks = 0;
        const recover = buildWorkflowRecoveryExecutor(
          { agent_recovery: { sentinel_assignment_cases: [visibilityCase] } },
          baseDir,
          createMemorySecretStore(),
          undefined,
          undefined,
          true,
          {
            authorizeExecutionTracePayload(payload) {
              sourceChecks++;
              assertEquals(payload, repositoryPayload);
              return Promise.resolve(evidenceAccess);
            },
          },
        );
        assert(recover);
        const executionId = crypto.randomUUID();
        const recoveryMessage =
          `/recover ${executionId} Queue the exact remediation check.`;
        const before = confirmations.length;
        await withGateway(
          async (control) => {
            const interrupted = await control(
              visibilityAssignment,
              recoveryMessage,
            );
            assertStringIncludes(interrupted.error ?? "", "checkpoint");
          },
          workflows,
          {
            session: recoverySession,
            execute: (id, orch, options, control, context) =>
              recover(
                id,
                {
                  executeAgentTurn: (options) =>
                    orch.executeAgentTurn({
                      ...options,
                      onToolBatchCheckpoint: () =>
                        Promise.reject(new Error("fixture interruption")),
                    }),
                },
                options,
                control,
                context,
              ),
          },
        );
        assertEquals(confirmations.length, before + 1);
        evidenceAccess = false;
        await withGateway(
          async (control) => {
            const blocked = await control(
              visibilityAssignment,
              recoveryMessage,
            );
            assertStringIncludes(blocked.error ?? "", "uncertain outcome");
            assertEquals(blocked.result, "");
          },
          workflows,
          { session: recoverySession, execute: recover },
        );
        assertEquals(sourceChecks, 1);
        evidenceAccess = true;
        let queuedVisibility:
          | { nodeId: string; recheckFindingId: string }
          | undefined;
        await withGateway(
          async (control) => {
            const resumed = await control(
              visibilityAssignment,
              recoveryMessage,
            );
            assertEquals(resumed.error, undefined);
            queuedVisibility = JSON.parse(resumed.result).receipt;
          },
          workflows,
          { session: recoverySession, execute: recover },
        );
        assert(queuedVisibility);
        assertEquals(queuedVisibility.nodeId, privateReceipt.evidenceId);
        assertEquals(queuedVisibility.recheckFindingId, visibilityFinding.id);
        assertEquals(confirmations.length, before + 1);
        const workflowControl = {
          ...attachVisibility,
          revision: passingVisibility.revision,
          action: "attach_workflow_control_evidence",
          controlId: "workflow-control",
          ordinal: 2,
        };
        assertStringIncludes(
          (await restoreTurn({ ...workflowControl, ordinal: 3 })).result,
          "unavailable",
        );
        const attachedWorkflow = JSON.parse(
          (await restoreTurn(workflowControl)).result,
        ).receipt;
        assertEquals(attachedWorkflow.verification.outcome, "pass");
        const workflowRevision = readSentinelAssessment(visibilityPath)!;
        const workflowEvidence = JSON.parse(
          (await restoreTurn({
            ...visibilityRef,
            revision: workflowRevision.revision,
            action: "case_execution_evidence",
            node: attachedWorkflow.evidenceId,
          })).result,
        ).evidence;
        assertEquals(workflowEvidence.payload, workflowPayload);
        assertStringIncludes(confirmations.at(-1)!, '"workflow":"22"');
        const historicalScopes = {
          failure: { ...traceScope, runId: crypto.randomUUID() },
          retries: { ...scheduled, runId: crypto.randomUUID() },
        };
        const appendAttempt = (
          scope: typeof historicalScopes[keyof typeof historicalScopes],
          ordinal: number,
          payload:
            | typeof attemptFailure
            | typeof attemptSuccess
            | typeof otherWorkflowAttempt,
        ) => {
          const history = openExecutionTraces(tracePath);
          try {
            if (ordinal === 1) assert(history.admit(scope));
            const step = history.append(scope, {
              ordinal,
              tool: "github_actions",
              classification: "INTERNAL",
              outcome: "returned",
            }, payload);
            assert(step);
            return step;
          } finally {
            history.close();
          }
        };
        appendAttempt(historicalScopes.failure, 1, attemptFailure);
        const attemptRequest = {
          ...workflowControl,
          action: "attach_workflow_attempt_evidence",
          revision: workflowRevision.revision,
          controlId: "attempt-control",
          traceRunId: historicalScopes.failure.runId,
          ordinal: 1,
        };
        assertStringIncludes(
          (await restoreTurn({
            ...attemptRequest,
            traceRunId: traceScope.runId,
            ordinal: 7,
          })).result,
          "unavailable",
        );
        const failedAttempt =
          JSON.parse((await restoreTurn(attemptRequest)).result).receipt;
        assertEquals(failedAttempt.verification.outcome, "fail");
        const failedAttemptState = readSentinelAssessment(visibilityPath)!;
        const attemptFindingStore = openSentinelWorkerFindingStore(
          visibilityPath,
        );
        let attemptFinding;
        try {
          attemptFinding = attemptFindingStore.recordFinding({
            caseId: visibilityCase,
            runId: visibility.plan.runId!,
            evidenceRevision: failedAttemptState.revision,
            taskId: "prior-attempt-review",
            targetId: "private-repo",
            graphFindingId: "visibility-finding",
            controlId: "attempt-control",
            evidenceId: failedAttempt.evidenceId,
            snapshotDigest: digestSentinelSnapshot(
              failedAttemptState.result!.sharedGraph.snapshot!,
            ),
            observedAt: failedAttempt.verification.observedAt,
            evaluatedAt: failedAttemptState.updatedAt,
            validUntil: attemptRequest.validUntil,
            requestId: crypto.randomUUID(),
            title: "Earlier workflow attempt failed",
            summary: "Verify the next attempt of the same run.",
          });
        } finally {
          attemptFindingStore.close();
        }
        assert(attemptFinding);
        appendAttempt(historicalScopes.retries, 1, otherWorkflowAttempt);
        const retryRequest = {
          ...attemptRequest,
          revision: failedAttemptState.revision,
          traceRunId: historicalScopes.retries.runId,
          traceRole: "scheduled",
        };
        const foreignAttempt = JSON.parse(
          (await restoreTurn(retryRequest)).result,
        ).receipt;
        assertEquals(foreignAttempt.verification.outcome, "pass");
        const foreignState = readSentinelAssessment(visibilityPath)!;
        advanceAdaptiveSentinel(visibilityPath, foreignState);
        const findAttempts = {
          action: "finding_recheck_candidates",
          kind: "sentinel",
          id: visibilityCase,
          revision: foreignState.revision,
          receiptId: attemptFinding.id,
        };
        assertEquals(
          JSON.parse((await restoreTurn(findAttempts)).result).candidates,
          [],
        );
        const sourceStep = appendAttempt(
          historicalScopes.retries,
          2,
          attemptSuccess,
        );
        const approvedRetry = {
          ...retryRequest,
          revision: foreignState.revision,
          ordinal: 2,
        };
        const sourceQuery = {
          ...findAttempts,
          action: "finding_recheck_sources",
          traceRole: "scheduled",
          traceRunId: historicalScopes.retries.runId,
          validUntil: approvedRetry.validUntil,
          limit: 1,
        };
        const beforeDiscovery = confirmations.length;
        const firstSources = JSON.parse(
          (await restoreTurn(sourceQuery)).result,
        );
        assertEquals(firstSources.candidates, []);
        assert(typeof firstSources.nextCursor === "string");
        const continuation = {
          ...sourceQuery,
          cursor: firstSources.nextCursor,
        };
        assertStringIncludes(
          (await restoreTurn({
            ...continuation,
            revision: failedAttemptState.revision,
          })).result,
          "unavailable",
        );
        assertStringIncludes(
          (await restoreTurn({
            ...continuation,
            validUntil: new Date(Date.parse(sourceQuery.validUntil) + 1000)
              .toISOString(),
          })).result,
          "unavailable",
        );
        allowRetrySource = false;
        const withheldSources = JSON.parse(
          (await restoreTurn(continuation)).result,
        );
        assertEquals(withheldSources.candidates, []);
        allowRetrySource = true;
        const eligibleSources = JSON.parse(
          (await restoreTurn(continuation)).result,
        );
        assertEquals(eligibleSources.nextCursor, null);
        assertEquals(eligibleSources.candidates.length, 1);
        const selectedSource = eligibleSources.candidates[0];
        assertEquals(selectedSource.attachment, approvedRetry);
        assertEquals(selectedSource.executionSource.receiptId, sourceStep.id);
        assertEquals(selectedSource.verification.outcome, "pass");
        assert(!Object.hasOwn(selectedSource, "payload"));
        assertEquals(confirmations.length, beforeDiscovery);
        assertEquals(
          readSentinelAssessment(visibilityPath)?.revision,
          foreignState.revision,
        );
        denyTraceSource = "PRE_TOOL_CALL";
        assertStringIncludes(
          (await restoreTurn(approvedRetry)).result,
          "unavailable",
        );
        denyTraceSource = undefined;
        const verifiedAttempt =
          JSON.parse((await restoreTurn(selectedSource.attachment)).result)
            .receipt;
        assertEquals(verifiedAttempt.evidenceId, selectedSource.evidenceId);
        assertEquals(verifiedAttempt.executionSource.receiptId, sourceStep.id);
        assertEquals(verifiedAttempt.executionSource.role, "scheduled");
        assertEquals(verifiedAttempt.verification.outcome, "pass");
        assertStringIncludes(confirmations.at(-1)!, '"attempt":2');
        const attemptState = readSentinelAssessment(visibilityPath)!;
        advanceAdaptiveSentinel(visibilityPath, attemptState);
        const attemptCandidates = JSON.parse(
          (await restoreTurn({
            ...findAttempts,
            revision: attemptState.revision,
          })).result,
        );
        assertEquals(attemptCandidates.candidates, [{
          nodeId: verifiedAttempt.evidenceId,
          resultSha256: verifiedAttempt.executionSource.resultSha256,
        }]);
        const assignment = JSON.parse(
          (await restoreTurn({
            action: "assign",
            kind: "sentinel",
            id: visibilityCase,
            revision: attemptState.revision,
            taskKind: "review_evidence",
            node: verifiedAttempt.evidenceId,
            recheckFindingId: attemptFinding.id,
            runId: attemptCandidates.runId,
            adaptiveRevision: attemptCandidates.adaptiveRevision,
            requestId: crypto.randomUUID(),
          })).result,
        ).receipt;
        assertEquals(assignment.recheckFindingId, attemptFinding.id);
        advanceAdaptiveSentinel(visibilityPath, attemptState);
        const assignmentStore = openSentinelAdaptiveStore(
          join(dirname(visibilityPath), "sentinel-adaptive.db"),
        );
        try {
          const task = assignmentStore.list(attemptCandidates.adaptiveRevision)
            .find(({ id }) => id === assignment.taskId);
          assert(task?.reason);
          const claim = assignmentStore.claimModelReview(
            attemptCandidates.adaptiveRevision,
            task.reason,
            ({ id }) => id === task.id,
          );
          assert(claim);
          const provider = createProviderRegistry();
          let checkedAttempt: unknown;
          provider.register({
            name: "exact-workflow-attempt-worker",
            supportsStreaming: false,
            complete(messages) {
              const replies = messages.filter(({ role }) => role === "tool");
              const usage = { inputTokens: 1, outputTokens: 1 };
              if (replies.length === 2) {
                checkedAttempt = JSON.parse(String(replies[1].content)).record;
                return Promise.resolve({
                  content: "The exact retry check is recorded.",
                  toolCalls: [],
                  usage,
                });
              }
              if (replies.length === 1) {
                assertEquals(
                  JSON.parse(String(replies[0].content)).evidence.payload,
                  attemptSuccess,
                );
              }
              const isRecheck = replies.length === 1;
              return Promise.resolve({
                content: "",
                toolCalls: [{
                  id: `attempt-${replies.length}`,
                  type: "function",
                  function: {
                    name: isRecheck
                      ? "sentinel_record_finding_recheck"
                      : "sentinel_assigned_execution_evidence",
                    arguments: JSON.stringify(
                      isRecheck
                        ? {
                          findingId: attemptFinding.id,
                          evidenceId: verifiedAttempt.evidenceId,
                          requestId: crypto.randomUUID(),
                          summary:
                            "The higher attempt of the same run succeeded.",
                        }
                        : { node: verifiedAttempt.evidenceId },
                    ),
                  },
                }],
                usage,
              });
            },
          });
          provider.setDefault("exact-workflow-attempt-worker");
          const review = createSentinelSubagent({
            snapshotPath: visibilityPath,
            sharedInventoryBaseDir: baseDir,
            authorizeExecutionTracePayload(payload) {
              assertEquals(payload, attemptSuccess);
              return Promise.resolve(true);
            },
            assessmentRevision: attemptState.revision,
            assignedTaskId: claim.task.id,
            assignedTaskLeaseToken: claim.token,
            providerRegistry: provider,
            hookRunner: {
              evaluateHook: () =>
                Promise.resolve({
                  allowed: true,
                  action: "ALLOW",
                  ruleId: null,
                  duration: 0,
                }),
            },
            allowModelAccess: true,
          });
          try {
            await review.execute("Record the exact passing attempt.", () => {});
          } finally {
            review.clear();
          }
          assert(checkedAttempt && typeof checkedAttempt === "object");
          assertEquals(
            {
              findingId: (checkedAttempt as { findingId: string }).findingId,
              outcome: (checkedAttempt as { outcome: string }).outcome,
              evidenceId: (checkedAttempt as { evidenceId: string }).evidenceId,
            },
            {
              findingId: attemptFinding.id,
              outcome: "pass",
              evidenceId: verifiedAttempt.evidenceId,
            },
          );
        } finally {
          assignmentStore.close();
        }
        const reopenedAttempt = JSON.parse(
          (await restoreTurn({
            action: "case_execution_evidence",
            kind: "sentinel",
            id: visibilityCase,
            revision: attemptState.revision,
            node: verifiedAttempt.evidenceId,
          })).result,
        ).evidence;
        assertEquals(reopenedAttempt.payload, attemptSuccess);
        assertEquals(reopenedAttempt.receiptId, sourceStep.id);
        const initialEvidence = startSentinelAssessment(evidencePath);
        const attach = {
          action: "attach_branch_evidence",
          kind: "sentinel",
          id: evidenceCase,
          revision: initialEvidence.revision,
          node: "repo-asset",
          controlId: "branch-control",
          branch: "main",
          runId: initialEvidence.plan.runId,
          traceRole: "delegated",
          traceRunId: traceScope.runId,
          ordinal: 6,
          validUntil: new Date(Date.now() + 60_000).toISOString(),
        };
        allowTracePayload = false;
        assertStringIncludes((await restoreTurn(attach)).result, "unavailable");
        allowTracePayload = true;
        assertStringIncludes(
          (await restoreTurn({ ...attach, branch: "unapproved" })).result,
          "unavailable",
        );
        assertStringIncludes(
          (await restoreTurn({ ...attach, controlId: "foreign-control" }))
            .result,
          "unavailable",
        );
        approved = false;
        assertStringIncludes((await restoreTurn(attach)).result, "declined");
        approved = true;
        const attached = JSON.parse((await restoreTurn(attach)).result).receipt;
        assertEquals(
          JSON.parse((await restoreTurn(attach)).result).receipt,
          attached,
        );
        const newEvidence = readSentinelAssessment(evidencePath);
        assert(newEvidence && newEvidence.revision > initialEvidence.revision);
        const graph = newEvidence.result?.sharedGraph.snapshot;
        const imported = graph?.nodes.find(({ id }) =>
          id === attached.evidenceId
        );
        assert(imported?.kind === "evidence");
        assertEquals(imported.executionSource, attached.executionSource);
        assertEquals(imported.controlVerification?.outcome, "pass");
        assertEquals(imported.executionSource?.ordinal, 6);
        assertEquals(
          graph?.edges.filter(({ from }) => from === attached.evidenceId),
          [
            {
              from: attached.evidenceId,
              to: "repo-asset",
              relation: "observed_on",
            },
            {
              from: attached.evidenceId,
              to: "branch-control",
              relation: "verifies",
            },
          ],
        );
        const revision = adaptiveRevision(newEvidence);
        advanceAdaptiveSentinel(evidencePath, newEvidence);
        const assessment = openSentinelAdaptiveStore(
          join(dirname(evidencePath), "sentinel-adaptive.db"),
        );
        try {
          assessment.sync(revision, [{
            kind: "trace",
            nodeId: attach.node,
            depth: 7,
            reason: MODEL_ASSIGNMENT_REASON,
          }], revision);
          advanceAdaptiveSentinel(evidencePath, newEvidence);
          const claim = assessment.claimModelReview(
            revision,
            MODEL_ASSIGNMENT_REASON,
            (task) => task.depth === 7,
          );
          assert(claim);
          const workerRegistry = createProviderRegistry();
          const workerHooks: string[] = [];
          let allowSource = false;
          let sourceAuthorizations = 0;
          let modelCalls = 0;
          let seenEvidence: unknown;
          let seenFact:
            | { relationship: unknown; controlVerification: unknown }
            | undefined;
          workerRegistry.register({
            name: "branch-case-fixture",
            supportsStreaming: false,
            complete(messages) {
              modelCalls++;
              const results = messages.filter(({ role }) => role === "tool");
              const usage = { inputTokens: 1, outputTokens: 1 };
              if (results.length === 3) {
                seenFact = JSON.parse(String(results[2].content));
                return Promise.resolve({
                  content: "Recorded the approved control.",
                  usage,
                  toolCalls: [],
                });
              }
              if (results.length === 2) {
                const result = String(results[1].content);
                if (!allowSource) {
                  assert(result.startsWith("Error:"));
                  return Promise.resolve({
                    content: "Source denied.",
                    usage,
                    toolCalls: [],
                  });
                }
                const value = JSON.parse(result);
                assertEquals(
                  value.evidence.receiptId,
                  attached.executionSource.receiptId,
                );
                assertEquals(value.evidenceRevision, newEvidence.revision);
                seenEvidence = value.evidence;
              }
              if (results.length === 1) {
                const view = JSON.parse(String(results[0].content));
                assertEquals(
                  view.linked.find(({ id }: { id: string }) =>
                    id === attached.evidenceId
                  ).executionSource,
                  attached.executionSource,
                );
              }
              return Promise.resolve({
                content: "",
                usage,
                toolCalls: [{
                  id: `branch-fact-${results.length}`,
                  type: "function",
                  function: {
                    name: results.length === 1
                      ? "sentinel_assigned_execution_evidence"
                      : results.length === 2
                      ? "sentinel_publish_graph_fact"
                      : "sentinel_assigned_target",
                    arguments: results.length === 1
                      ? JSON.stringify({ node: attached.evidenceId })
                      : results.length === 2
                      ? JSON.stringify({
                        from: attached.evidenceId,
                        to: attach.controlId,
                        relation: "verifies",
                        requestId: crypto.randomUUID(),
                      })
                      : "{}",
                  },
                }],
              });
            },
          });
          workerRegistry.setDefault("branch-case-fixture");
          const newWorker = () =>
            createSentinelSubagent({
              snapshotPath: evidencePath,
              sharedInventoryBaseDir: baseDir,
              authorizeExecutionTracePayload: () => {
                sourceAuthorizations++;
                return Promise.resolve(true);
              },
              assessmentRevision: newEvidence.revision,
              assignedTaskId: claim.task.id,
              assignedTaskLeaseToken: claim.token,
              providerRegistry: workerRegistry,
              allowModelAccess: true,
              hookRunner: {
                evaluateHook: (phase, { input }) => {
                  workerHooks.push(`${phase}:${input.tool_name ?? ""}`);
                  const denied = phase === "PRE_TOOL_CALL" &&
                    input.tool_name === "github_repos" && !allowSource;
                  return Promise.resolve({
                    allowed: !denied,
                    action: denied ? "BLOCK" : "ALLOW",
                    ruleId: null,
                    duration: 0,
                  });
                },
              },
            });
          const worker = newWorker();
          const question = "Cite the approved control observation.";
          const promptDigest = createHash("sha256").update(question).digest(
            "hex",
          );
          const checkpointScope = [
            revision,
            claim.task.id,
            claim.token,
            newEvidence.revision,
            promptDigest,
          ] as const;
          const abort = new AbortController();
          const workerBoundary = () => Promise.resolve({});
          const steps: SentinelReadTrace[] = [];
          const checkpoints: boolean[] = [];
          try {
            await worker.execute("Check denied source.", () => {});
            assertEquals(sourceAuthorizations, 0);
            worker.clear();
            allowSource = true;
            await worker.execute(
              question,
              () => {},
              abort.signal,
              (step) => {
                steps.push(step);
                assessment.recordModelReviewProgress(
                  revision,
                  claim.task.id,
                  claim.token,
                  steps,
                );
              },
              true,
              {
                workerBoundary,
                onToolBatchCheckpoint(checkpoint) {
                  checkpoints.push(
                    assessment.recordLeasedWorkerCheckpoint(
                      ...checkpointScope,
                      checkpoint,
                    ),
                  );
                  if (checkpoint.completedIterations === 2) abort.abort();
                  return Promise.resolve();
                },
              },
            );
          } finally {
            worker.clear();
          }
          assert(abort.signal.aborted, JSON.stringify({ steps, checkpoints }));
          assertEquals(checkpoints, [true, true], JSON.stringify(steps));
          assertEquals(sourceAuthorizations, 1);
          assertEquals(seenEvidence, undefined);
          const stepIndex = steps.findIndex(({ tool, outcome }) =>
            tool === "sentinel_assigned_execution_evidence" &&
            outcome === "returned"
          );
          assert(stepIndex >= 0);
          const resultRequest = {
            action: "worker_trace_result",
            kind: "sentinel",
            id: evidenceCase,
            revision: newEvidence.revision,
            taskId: claim.task.id,
            stepIndices: [stepIndex],
          };
          const reopenedResult = JSON.parse(
            (await restoreTurn(resultRequest)).result,
          );
          assertEquals(reopenedResult.result.evidence.payload, branchPayload);
          assertEquals(
            reopenedResult.result.evidence.resultSha256,
            attached.executionSource.resultSha256,
          );
          assertEquals(reopenedResult.result.evidenceId, attached.evidenceId);
          for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"] as const) {
            denyTraceSource = hook;
            try {
              assertStringIncludes(
                (await restoreTurn(resultRequest)).result,
                "unavailable",
              );
            } finally {
              denyTraceSource = undefined;
            }
          }
          assertStringIncludes(
            (await restoreTurn({
              ...resultRequest,
              taskId: `adaptive:${"0".repeat(64)}`,
            })).result,
            "unavailable",
          );
          const reopened = openSentinelAdaptiveStore(
            join(dirname(evidencePath), "sentinel-adaptive.db"),
          );
          const resume = (() => {
            try {
              assertEquals(
                reopened.readLeasedWorkerCheckpoint(
                  revision,
                  claim.task.id,
                  claim.token,
                  newEvidence.revision + 1,
                  promptDigest,
                ),
                undefined,
              );
              return reopened.readLeasedWorkerCheckpoint(...checkpointScope);
            } finally {
              reopened.close();
            }
          })();
          assert(resume);
          assertEquals(resume.completedIterations, 2);
          const beforeResume = modelCalls;
          const deniedWorker = newWorker();
          allowSource = false;
          try {
            await deniedWorker.execute(
              question,
              () => {},
              undefined,
              undefined,
              undefined,
              { resume, workerBoundary },
            );
          } finally {
            deniedWorker.clear();
          }
          assertEquals(modelCalls, beforeResume);
          assertEquals(sourceAuthorizations, 1);

          allowSource = true;
          const recovered = newWorker();
          const dispatched: string[] = [];
          try {
            await recovered.execute(
              question,
              () => {},
              undefined,
              ({ tool }) => dispatched.push(tool),
              undefined,
              { resume, workerBoundary },
            );
          } finally {
            recovered.clear();
          }
          assertEquals(dispatched, ["sentinel_publish_graph_fact"]);
          assertEquals(sourceAuthorizations, 2);
          assert(seenEvidence);
          assert(
            workerHooks.includes(
              "PRE_TOOL_CALL:sentinel_assigned_execution_evidence",
            ),
          );
          assert(
            workerHooks.includes(
              "POST_TOOL_RESPONSE:sentinel_assigned_execution_evidence",
            ),
          );
          assert(workerHooks.includes("POST_TOOL_RESPONSE:github_repos"));
          assert(workerHooks.includes("PRE_OUTPUT:"));
          assert(seenFact);
          assertEquals(seenFact.relationship, {
            from: attached.evidenceId,
            to: attach.controlId,
            relation: "verifies",
          });
          assertEquals(seenFact.controlVerification, attached.verification);
        } finally {
          assessment.close();
        }
        const attachedScope = {
          kind: "sentinel",
          id: evidenceCase,
          revision: newEvidence.revision,
        };
        const evidenceRead = {
          action: "case_execution_evidence",
          ...attachedScope,
          node: attached.evidenceId,
        };
        const reopenedEvidence =
          JSON.parse((await restoreTurn(evidenceRead)).result).evidence;
        assertEquals(reopenedEvidence.payload, branchPayload);
        assertEquals(
          reopenedEvidence.receiptId,
          attached.executionSource.receiptId,
        );
        assertEquals(
          reopenedEvidence.resultSha256,
          attached.executionSource.resultSha256,
        );
        assertStringIncludes(
          (await restoreTurn({
            ...evidenceRead,
            revision: initialEvidence.revision,
          })).result,
          "unavailable",
        );
        const priorAdaptive = readAdaptiveSentinel(evidencePath, newEvidence);
        assert(priorAdaptive);
        const pendingStore = openSentinelAdaptiveStore(
          join(dirname(evidencePath), "sentinel-adaptive.db"),
        );
        const pending = (() => {
          try {
            const tasks = pendingStore.sync(priorAdaptive.revision, [{
              kind: "trace",
              nodeId: "branch-finding",
              depth: 2,
              reason: "Assigned by the operator in Tidepool.",
            }], priorAdaptive.revision);
            const task = tasks.find(({ nodeId, kind }) =>
              nodeId === "branch-finding" && kind === "trace"
            );
            assert(task && task.status === "queued");
            return task;
          } finally {
            pendingStore.close();
          }
        })();
        const observations: {
          read: Record<string, unknown>;
          original: unknown;
        }[] = [];
        const observationAction = {
          action: "attach_execution_evidence",
          ...attachedScope,
          runId: newEvidence.plan.runId,
          node: attach.node,
          traceRole: attach.traceRole,
          traceRunId: attach.traceRunId,
          ordinal: 2,
        };
        assertStringIncludes(
          (await restoreTurn({
            ...observationAction,
            controlId: attach.controlId,
          })).result,
          "unavailable",
        );
        for (
          const [ordinal, expected] of [
            [2, workflowPayload],
            [3, repositoryPayload],
            [4, pullPayload],
            [5, releasePayload],
          ] as const
        ) {
          const before = readSentinelAssessment(evidencePath)!;
          const request = {
            ...observationAction,
            revision: before.revision,
            ordinal,
          };
          const saved = JSON.parse((await restoreTurn(request)).result).receipt;
          assert(saved.executionSource.recordedAt);
          assertEquals(saved.verification, undefined);
          assertEquals(
            JSON.parse((await restoreTurn(request)).result).receipt,
            saved,
          );
          const state = readSentinelAssessment(evidencePath)!;
          assertEquals(state.revision, before.revision + 1);
          const graph = state.result?.sharedGraph.snapshot;
          assertEquals(
            graph?.edges.filter(({ from }) => from === saved.evidenceId),
            [{
              from: saved.evidenceId,
              to: attach.node,
              relation: "observed_on",
            }],
          );
          const read = {
            ...evidenceRead,
            revision: state.revision,
            node: saved.evidenceId,
          };
          const original =
            JSON.parse((await restoreTurn(read)).result).evidence;
          assertEquals(original.payload, expected);
          observations.push({ read, original });
        }
        const readyToArchive = readSentinelAssessment(evidencePath)!;
        const archiveScope = {
          ...attachedScope,
          revision: readyToArchive.revision,
        };
        stopSentinelAssessment(evidencePath);
        const archiveId = crypto.randomUUID();
        const archival = JSON.parse(
          (await restoreTurn({
            action: "archive",
            ...archiveScope,
            runId: newEvidence.plan.runId,
            requestId: archiveId,
          })).result,
        ).receipt;
        assertEquals(archival.status, "succeeded");
        await Deno.rename(
          dirname(evidencePath),
          join(baseDir, "detached-branch-case"),
        );
        await Deno.rename(tracePath, join(baseDir, "detached-source-runs.db"));
        const artifact = join(
          baseDir,
          "data",
          "run-archives",
          archiveId,
          sentinelExecutionEvidenceFile,
        );
        const availableBundle = await Deno.readTextFile(artifact);
        await Deno.writeTextFile(artifact, "[]");
        const restoreCase = {
          action: "restore",
          ...archiveScope,
          runId: newEvidence.plan.runId,
          archiveId,
          requestId: crypto.randomUUID(),
        };
        assertEquals(
          JSON.parse((await restoreTurn(restoreCase)).result).receipt.status,
          "failed",
        );
        assertEquals(readSentinelAssessment(evidencePath), undefined);
        await Deno.writeTextFile(artifact, availableBundle);
        await withGateway(async (afterRestart) => {
          const restoredCase = await afterRestart({
            ...restoreCase,
            requestId: crypto.randomUUID(),
          });
          assertEquals(
            JSON.parse(restoredCase.result).receipt.status,
            "succeeded",
          );
          assertEquals(readSentinelAssessment(evidencePath)?.paused, true);
          assertEquals(
            JSON.parse((await afterRestart(evidenceRead)).result).evidence,
            reopenedEvidence,
          );
          for (const { read, original } of observations) {
            assertEquals(
              JSON.parse((await afterRestart(read)).result).evidence,
              original,
            );
          }
          assertStringIncludes(
            (await afterRestart(branchAction)).result,
            "unavailable",
          );
          allowTracePayload = false;
          assertStringIncludes(
            (await afterRestart(evidenceRead)).result,
            "unavailable",
          );
          assertStringIncludes(
            (await afterRestart(observations[0].read)).result,
            "unavailable",
          );
          allowTracePayload = true;
          denyTraceSource = "PRE_TOOL_CALL";
          assertStringIncludes(
            (await afterRestart(evidenceRead)).result,
            "unavailable",
          );
          denyTraceSource = undefined;
          const lag = openSentinelAdaptiveStore(
            join(dirname(evidencePath), "sentinel-adaptive.db"),
          );
          try {
            assertEquals(lag.activeRevision(), priorAdaptive.revision);
            assertEquals(
              lag.list(priorAdaptive.revision).find(({ id }) =>
                id === pending.id
              )?.status,
              "queued",
            );
          } finally {
            lag.close();
          }
          const resumed = JSON.parse(
            (await afterRestart({
              action: "resume",
              ...archiveScope,
            })).result,
          ).run;
          assertEquals(resumed.status, "running");
          const latest = readSentinelAssessment(evidencePath)!;
          const current = readAdaptiveSentinel(
            evidencePath,
            latest,
            "revision",
          );
          const event = current?.history.find(({ event, note }) =>
            event === "carried_forward" && note?.includes(pending.id)
          );
          const carried = current?.tasks.find(({ id }) => id === event?.taskId);
          assert(carried);
          assertEquals(carried.nodeId, "branch-finding");
          assertEquals(carried.status, "completed");
          const receipt = observations[0];
          const plannerTool = "sentinel_case_execution_evidence";
          const plannerHooks: string[] = [];
          const plannerRegistry = createProviderRegistry();
          let received: unknown;
          plannerRegistry.register({
            name: "archived-planner-receipt",
            supportsStreaming: false,
            complete(messages, tools) {
              const usage = { inputTokens: 1, outputTokens: 1 };
              const results = messages.filter(({ role }) => role === "tool");
              if (!results.length) {
                assert(JSON.stringify(tools).includes(plannerTool));
                assert(
                  messages.some(({ content }) =>
                    String(content).includes('"executionReceipt":true')
                  ),
                );
                return Promise.resolve({
                  content: "",
                  usage,
                  toolCalls: [
                    `execution-evidence:${"0".repeat(64)}`,
                    observations[1].read.node,
                    receipt.read.node,
                  ].map((node, index) => ({
                    id: `planner-receipt-${index}`,
                    type: "function",
                    function: {
                      name: plannerTool,
                      arguments: JSON.stringify({ node }),
                    },
                  })),
                });
              }
              assertStringIncludes(String(results[0].content), "unavailable");
              assertStringIncludes(String(results[1].content), "unavailable");
              received = JSON.parse(String(results[2].content)).evidence;
              return Promise.resolve({
                content: JSON.stringify([{
                  kind: "review_evidence",
                  nodeId: receipt.read.node,
                }]),
                usage,
                toolCalls: [],
              });
            },
          });
          plannerRegistry.setDefault("archived-planner-receipt");
          const reviewNode = String(receipt.read.node);
          const evidenceReviewTask = sentinelAdaptiveTaskId(
            adaptiveRevision(latest),
            {
              kind: "review_evidence",
              nodeId: reviewNode,
            },
          );
          const reviewTool = "sentinel_assigned_execution_evidence";
          const reviewRegistry = createProviderRegistry();
          let reviewedReceipt: unknown;
          let reauthorizedSources = 0;
          reviewRegistry.register({
            name: "leased-receipt-review",
            supportsStreaming: false,
            complete(messages, tools) {
              const usage = { inputTokens: 1, outputTokens: 1 };
              const results = messages.filter(({ role }) => role === "tool");
              if (results.length) {
                assertStringIncludes(String(results[0].content), "unavailable");
                reviewedReceipt =
                  JSON.parse(String(results[1].content)).evidence;
                return Promise.resolve({
                  content: JSON.stringify({
                    summary: "Reviewed the exact retained receipt.",
                    followUps: [],
                  }),
                  usage,
                  toolCalls: [],
                });
              }
              assert(JSON.stringify(tools).includes(reviewTool));
              assert(!JSON.stringify(tools).includes(plannerTool));
              return Promise.resolve({
                content: "",
                usage,
                toolCalls: [observations[1].read.node, reviewNode].map((
                  node,
                  index,
                ) => ({
                  id: `leased-review-${index}`,
                  type: "function",
                  function: {
                    name: reviewTool,
                    arguments: JSON.stringify({ node }),
                  },
                })),
              });
            },
          });
          reviewRegistry.setDefault("leased-receipt-review");
          const modelPlanner = createSentinelModelPlanner(
            evidencePath,
            (state, taskId, token, role) =>
              taskId && taskId !== evidenceReviewTask
                ? {
                  execute: (_message, send) => {
                    send({
                      type: "response",
                      text:
                        '{"summary":"Reviewed retained case evidence.","followUps":[]}',
                      taint: "INTERNAL",
                    });
                    return Promise.resolve();
                  },
                  clear() {},
                }
                : createSentinelSubagent({
                  snapshotPath: evidencePath,
                  sharedInventoryBaseDir: baseDir,
                  assessmentRevision: state.revision,
                  plannerExecutionEvidenceRunId: role === "planner"
                    ? state.plan.runId
                    : undefined,
                  allowModelAccess: true,
                  assignedTaskId: taskId,
                  assignedTaskLeaseToken: token,
                  providerRegistry: taskId ? reviewRegistry : plannerRegistry,
                  authorizeExecutionTracePayload: (payload) => {
                    if (taskId) reauthorizedSources++;
                    return Promise.resolve(
                      payload.kind === "github_actions_status",
                    );
                  },
                  hookRunner: {
                    evaluateHook: (phase, { input }) => {
                      plannerHooks.push(`${phase}:${input.tool_name ?? ""}`);
                      return Promise.resolve({
                        allowed: true,
                        action: "ALLOW",
                        duration: 0,
                        ruleId: null,
                      });
                    },
                  },
                }),
          );
          try {
            for (
              let attempt = 0;
              attempt < 100 && reviewedReceipt === undefined;
              attempt++
            ) {
              modelPlanner.advance(latest);
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            for (
              let attempt = 0;
              attempt < 100 && modelPlanner.hasInFlightWork();
              attempt++
            ) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          } finally {
            modelPlanner.stop();
          }
          assertEquals(reviewedReceipt, receipt.original);
          assertEquals(reauthorizedSources, 1);
          assertEquals(received, receipt.original);
          assert(plannerHooks.includes(`PRE_TOOL_CALL:${plannerTool}`));
          assert(plannerHooks.includes("PRE_TOOL_CALL:github_actions"));
          assert(plannerHooks.includes("POST_TOOL_RESPONSE:github_actions"));
          assert(plannerHooks.includes(`POST_TOOL_RESPONSE:${plannerTool}`));
          assert(plannerHooks.includes("PRE_OUTPUT:"));
          const planned = readAdaptiveSentinel(
            evidencePath,
            latest,
            "revision",
          );
          assert(planned);
          const review = planned.modelReviews.find(({ taskId }) =>
            taskId === evidenceReviewTask
          );
          assertEquals(review?.summary, "Reviewed the exact retained receipt.");
          assert(
            review?.steps.some(({ tool, target, outcome, goalReceiptRead }) =>
              tool === reviewTool && outcome === "returned" &&
              target === reviewNode &&
              goalReceiptRead?.args.node === reviewNode
            ),
          );
          assert(
            planned.tasks.some(({ nodeId, kind, evidenceIds }) =>
              nodeId === receipt.read.node && kind === "review_evidence" &&
              typeof nodeId === "string" && evidenceIds.includes(nodeId)
            ),
          );
          assert(
            planned.modelPlannerHistory.some(({ reads }) =>
              reads?.some(({ tool, target, outcome }) =>
                tool === plannerTool && target === receipt.read.node &&
                outcome === "returned"
              )
            ),
          );
          const journal = openSentinelWorkerFindingStore(evidencePath);
          let originalFinding;
          try {
            originalFinding = journal.recordFinding({
              caseId: evidenceCase,
              runId: latest.plan.runId!,
              evidenceRevision: initialEvidence.revision,
              taskId: "previous-review",
              targetId: "repo-asset",
              graphFindingId: "branch-finding",
              controlId: "branch-control",
              evidenceId: "legacy-control-proof",
              snapshotDigest: "a".repeat(64),
              observedAt: new Date(Date.now() - 60_000).toISOString(),
              evaluatedAt: new Date(Date.now() - 30_000).toISOString(),
              validUntil: attach.validUntil,
              requestId: "old-branch-finding",
              title: "Prior branch finding",
              summary: "Earlier failed control check.",
            });
          } finally {
            journal.close();
          }
          assert(originalFinding);
          const discoverRechecks = {
            action: "finding_recheck_candidates",
            ...archiveScope,
            receiptId: originalFinding.id,
          };
          const discovered = JSON.parse(
            (await afterRestart(discoverRechecks)).result,
          );
          assertEquals(discovered.findingId, originalFinding.id);
          const lookupCommand =
            `/sentinel-recheck ${archiveScope.id} ${archiveScope.revision} ${originalFinding.id}`;
          const commandLookup = await afterRestart(lookupCommand);
          assertEquals(commandLookup.result, "");
          assertEquals(JSON.parse(commandLookup.response!), discovered);
          denied = "PRE_OUTPUT";
          try {
            const blocked = await afterRestart(lookupCommand);
            assertEquals(blocked.response, undefined);
            assertStringIncludes(blocked.error!, "blocked");
          } finally {
            denied = undefined;
          }
          assertEquals(discovered.adaptiveRevision, planned.revision);
          assertEquals(discovered.candidates, [{
            nodeId: attached.evidenceId,
            resultSha256: attached.executionSource.resultSha256,
          }]);
          allowTracePayload = false;
          try {
            const hidden = JSON.parse(
              (await afterRestart(discoverRechecks)).result,
            );
            assertEquals(hidden.candidates, []);
          } finally {
            allowTracePayload = true;
          }
          denied = "PRE_TOOL_CALL";
          traceSourceChecks.length = 0;
          try {
            assertStringIncludes(
              (await afterRestart(discoverRechecks)).result,
              "blocked",
            );
            assertEquals(traceSourceChecks, []);
          } finally {
            denied = undefined;
          }
          for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"] as const) {
            denyTraceSource = hook;
            traceSourceChecks.length = 0;
            try {
              const hidden = JSON.parse(
                (await afterRestart(discoverRechecks)).result,
              );
              assertEquals(hidden.candidates, []);
              assert(traceSourceChecks.includes(hook));
            } finally {
              denyTraceSource = undefined;
            }
          }
          assertStringIncludes(
            (await afterRestart({
              ...discoverRechecks,
              revision: archiveScope.revision - 1,
            })).result,
            "unavailable",
          );
          const exactRecheck = {
            action: "assign",
            ...archiveScope,
            runId: latest.plan.runId,
            adaptiveRevision: planned.revision,
            requestId: crypto.randomUUID(),
            node: attached.evidenceId,
            taskKind: "review_evidence",
            recheckFindingId: originalFinding.id,
          };
          const beforeApproval = confirmations.length;
          assertStringIncludes(
            (await afterRestart({ ...exactRecheck, node: receipt.read.node }))
              .result,
            "unavailable",
          );
          assertEquals(confirmations.length, beforeApproval);
          approved = false;
          assertStringIncludes(
            (await afterRestart(exactRecheck)).result,
            "declined",
          );
          approved = true;
          duringConfirmation = () => {
            allowTracePayload = false;
          };
          try {
            assertStringIncludes(
              (await afterRestart(exactRecheck)).result,
              "unavailable",
            );
          } finally {
            duringConfirmation = undefined;
            allowTracePayload = true;
          }
          const queueCommand =
            `${lookupCommand} queue ${exactRecheck.node} ${exactRecheck.runId} ${exactRecheck.adaptiveRevision} ${exactRecheck.requestId}`;
          const beforeQueue = confirmations.length;
          const queuedFromCommand = await afterRestart(queueCommand);
          assertEquals(queuedFromCommand.result, "");
          const assigned = JSON.parse(queuedFromCommand.response!).receipt;
          assertEquals(confirmations.length, beforeQueue + 1);
          assertEquals(assigned.recheckFindingId, originalFinding.id);
          assertEquals(assigned.nodeId, attached.evidenceId);
          const approvedCount = confirmations.length;
          approved = false;
          assertEquals(
            JSON.parse((await afterRestart(exactRecheck)).result).receipt,
            assigned,
          );
          assertEquals(confirmations.length, approvedCount);
          approved = true;
          const bound = readAdaptiveSentinel(evidencePath, latest, "revision")
            ?.tasks.filter(
              ({ plannerRound }) =>
                plannerRound?.recheckFindingId === originalFinding.id,
            );
          assertEquals(bound?.map(({ id }) => id), [assigned.taskId]);
          assertStringIncludes(
            confirmations.at(-1)!,
            attached.executionSource.resultSha256,
          );
          const staleRegistry = createProviderRegistry();
          let staleToolOutput: string | undefined;
          staleRegistry.register({
            name: "superseded-planner-receipt",
            supportsStreaming: false,
            complete(messages) {
              const response = messages.find(({ role }) => role === "tool");
              const usage = { inputTokens: 1, outputTokens: 1 };
              if (response) {
                staleToolOutput = String(response.content);
                return Promise.resolve({ content: "[]", usage, toolCalls: [] });
              }
              return Promise.resolve({
                content: "",
                usage,
                toolCalls: [{
                  id: "stale-receipt",
                  type: "function",
                  function: {
                    name: plannerTool,
                    arguments: JSON.stringify({ node: receipt.read.node }),
                  },
                }],
              });
            },
          });
          staleRegistry.setDefault("superseded-planner-receipt");
          const stale = createSentinelSubagent({
            snapshotPath: evidencePath,
            sharedInventoryBaseDir: baseDir,
            assessmentRevision: latest.revision,
            plannerExecutionEvidenceRunId: latest.plan.runId,
            allowModelAccess: true,
            providerRegistry: staleRegistry,
            hookRunner: {
              evaluateHook: () =>
                Promise.resolve({
                  allowed: true,
                  action: "ALLOW",
                  duration: 0,
                  ruleId: null,
                }),
            },
            async authorizeExecutionTracePayload() {
              const snapshot = latest.result?.sharedGraph.snapshot;
              assert(snapshot);
              await Deno.writeTextFile(
                evidencePath,
                JSON.stringify({
                  ...snapshot,
                  nodes: [...snapshot.nodes, {
                    id: "later-inventory",
                    kind: "asset",
                    label: "Newly committed inventory",
                  }],
                }),
              );
              const next = refreshSentinelAssessment(evidencePath);
              assert(next && next.revision > latest.revision);
              return true;
            },
          });
          try {
            await stale.execute(
              "Reopen the exact receipt from this planning revision.",
              () => {},
            );
          } finally {
            stale.clear();
          }
          assert(staleToolOutput);
          assert(!staleToolOutput.includes("repositoryId"));
          assert(
            readSentinelAssessment(evidencePath)!.revision > latest.revision,
          );
        }, restarted);
        assertEquals(originalToolInvocations, 0);
      }, restarted);
      const executionTracePath = join(baseDir, "execution-traces.db");
      for (const role of ["delegated", "scheduled"] as const) {
        const executing = Promise.withResolvers<{
          signal: AbortSignal;
          workerBoundary: NonNullable<
            Parameters<
              Bundle["orchestrator"]["executeAgentTurn"]
            >[0]["workerBoundary"]
          >;
        }>();
        const cleanup = new AbortController();
        const session = updateTaint(
          createSession({
            userId: "owner" as UserId,
            channelId: role as ChannelId,
          }),
          "INTERNAL",
          "Background control fixture",
        );
        let invocations = 0;
        type Bundle = Awaited<ReturnType<OrchestratorFactory["create"]>>;
        const bundle = {
          session,
          getSessionTaint: () => session.taint,
          toolExecutor: () => Promise.resolve(""),
          orchestrator: {
            async executeAgentTurn(
              { signal, workerBoundary }: Parameters<
                Bundle["orchestrator"]["executeAgentTurn"]
              >[0],
            ) {
              assert(signal && workerBoundary);
              invocations++;
              executing.resolve({ signal, workerBoundary });
              if (!signal.aborted) {
                await new Promise<void>((resolve) =>
                  signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  })
                );
              }
              return { ok: false as const, error: "Interrupted fixture" };
            },
          } as Bundle["orchestrator"],
        };
        const factory: OrchestratorFactory = {
          create: () => Promise.resolve(bundle),
        };
        const scheduledId = crypto.randomUUID();
        const scheduled = bindScheduledAgent(
          { executionTracePath } as SchedulerServiceConfig,
          bundle,
          { id: scheduledId, kind: "cron", sourceId: "fixture-cron" },
        );
        const scheduledTurn = () =>
          scheduled.orchestrator.executeAgentTurn({
            session,
            message: "Wait for cancellation.",
            targetClassification: "INTERNAL",
            signal: cleanup.signal,
          });
        const running = role === "delegated"
          ? buildSubagentFactory(factory, { executionTracePath })(
            "Wait for cancellation.",
            undefined,
            { signal: cleanup.signal },
          )
          : scheduledTurn();
        try {
          const { signal, workerBoundary } = await executing.promise;
          const listed = JSON.parse(
            (await turn({ action: "list", kind: role })).result,
          );
          const ref = listed.runs[0].ref;
          assertEquals(ref.kind, role);
          if (role === "scheduled") assertEquals(ref.id, scheduledId);
          const steer = {
            action: "steer",
            ...ref,
            requestId: crypto.randomUUID(),
            note: "Review the committed evidence first.",
          };
          const beforeSteer = confirmations.length;
          denied = "PRE_TOOL_CALL";
          await turn(steer);
          denied = undefined;
          assertEquals(await workerBoundary("before_model"), {});
          const steered = JSON.parse((await turn(steer)).result).receipt;
          assertEquals(steered.note, steer.note);
          assertEquals(await workerBoundary("before_action"), {
            instructions: [steer.note],
          });
          assertEquals(await workerBoundary("before_model"), {});
          assertEquals(JSON.parse((await turn(steer)).result).receipt, steered);
          assertEquals(confirmations.length, beforeSteer + 1);
          const cancel = { action: "cancel", ...ref };
          const count = confirmations.length;
          denied = "PRE_TOOL_CALL";
          await turn(cancel);
          denied = undefined;
          assert(!signal.aborted);
          assertEquals(confirmations.length, count);
          const cancelled = JSON.parse((await turn(cancel)).result).run;
          assertEquals(cancelled.status, "cancelled");
          assert(signal.aborted);
          await running;
          assertEquals(JSON.parse((await turn(cancel)).result).run, cancelled);
          assertEquals(confirmations.length, count + 1);
          if (role === "scheduled") {
            const retry = await scheduledTurn();
            assert(!retry.ok);
            assertStringIncludes(retry.error, "cancelled");
          }
          assertEquals(invocations, 1);
          await withGateway(async (reopen) => {
            assertEquals(
              JSON.parse((await reopen({ action: "inspect", ...ref })).result)
                .run,
              cancelled,
            );
          }, restarted);
        } finally {
          cleanup.abort();
          await running;
        }
      }
      const requirement = {
        case: "published",
        run_id: crypto.randomUUID(),
        revision: 2,
        observation_id: "workflow-observation:" + "a".repeat(64),
        workflow_run_id: 17,
      };
      const evidencePlan = {
        id: "evidence-gated",
        classification: "INTERNAL" as const,
        steps: [
          { id: "evidence-check", waitSeconds: 30, satisfiedBy: requirement },
          { id: "dependent" },
        ],
      };
      const proof = {
        caseId: requirement.case,
        runId: requirement.run_id,
        revision: requirement.revision,
        observationId: requirement.observation_id,
        workflowRunId: requirement.workflow_run_id,
        sourceTaskId: "adaptive:" + "b".repeat(64),
        sourceStepIndex: 0,
        resultSha256: "c".repeat(64),
      };
      const waitingPlan = {
        ...evidencePlan,
        id: "wait-for-evidence",
        steps: [
          { ...evidencePlan.steps[0], evidenceWaitSeconds: 20 },
          evidencePlan.steps[1],
        ],
      };
      const expiringPlan = {
        ...waitingPlan,
        id: "expiring-evidence",
        steps: [
          { ...waitingPlan.steps[0], evidenceWaitSeconds: 1 },
          waitingPlan.steps[1],
        ],
      };
      const evidenceJournal = join(baseDir, "evidence-workflow.db");
      let stale = true;
      let checks = 0;
      const evidenceAdapter = createOperatorWorkflowRuns(
        createWorkflowRunRegistry(),
        [evidencePlan, waitingPlan, expiringPlan],
        evidenceJournal,
        (expected) => {
          assertEquals(expected, requirement);
          checks++;
          return Promise.resolve(stale ? { ...proof, revision: 1 } : proof);
        },
      );
      const restartDir = join(baseDir, "workflow-evidence-restart");
      await Deno.mkdir(restartDir);
      const restartJournal = join(restartDir, "operator-workflows.db");
      const readyRestartDir = join(restartDir, "ready");
      await Deno.mkdir(readyRestartDir);
      const readyRestartJournal = join(
        readyRestartDir,
        "operator-workflows.db",
      );
      let readyRestartRunId: string | undefined;
      const pausedRestartDir = join(restartDir, "paused");
      await Deno.mkdir(pausedRestartDir);
      const pausedRestartJournal = join(
        pausedRestartDir,
        "operator-workflows.db",
      );
      let expiringRef: { kind: string; id: string } | undefined;
      let originalDeadline: string | undefined;
      let successRef: { kind: string; id: string } | undefined;
      await withGateway(async (control) => {
        const start = {
          action: "start",
          kind: "workflow",
          id: evidencePlan.id,
        };
        denied = "PRE_TOOL_CALL";
        await control({ ...start, requestId: crypto.randomUUID() });
        denied = undefined;
        assertEquals(checks, 0);
        const rejected = JSON.parse(
          (await control({
            ...start,
            requestId: crypto.randomUUID(),
          })).result,
        ).run.ref;
        await until(() =>
          evidenceAdapter.inspect(rejected.id)?.status === "failed"
        );
        assertEquals(
          evidenceAdapter.inspect(rejected.id)?.steps[1].status,
          "pending",
        );
        stale = false;
        const request = { ...start, requestId: crypto.randomUUID() };
        successRef = JSON.parse((await control(request)).result).run.ref;
        assert(successRef);
        const id = successRef.id;
        await until(() => evidenceAdapter.inspect(id)?.status === "completed");
        assertEquals(
          evidenceAdapter.inspect(id)?.steps.map(({ status }) => status),
          [
            "completed",
            "completed",
          ],
        );
        assertEquals(
          JSON.parse((await control(request)).result).run.ref,
          successRef,
        );
        assertEquals(checks, 2);
        const rejectedCommit = new DatabaseSync(evidenceJournal);
        try {
          rejectedCommit.exec(`
            CREATE TRIGGER decline_evidence_commit
            BEFORE UPDATE OF stepStatuses ON workflow_admissions_v1
            WHEN NEW.status = 'running' AND NEW.stepStatuses = '["completed","pending"]'
            BEGIN SELECT RAISE(IGNORE); END
          `);
          const ref = JSON.parse(
            (await control({
              ...start,
              requestId: crypto.randomUUID(),
            })).result,
          ).run.ref;
          await until(() =>
            evidenceAdapter.inspect(ref.id)?.status === "failed"
          );
          assertEquals(
            evidenceAdapter.inspect(ref.id)?.steps.map(({ status }) => status),
            ["pending", "pending"],
          );
          const traces = JSON.parse(
            (await control({
              action: "traces",
              ...ref,
            })).result,
          ).page.events;
          assert(
            !traces.some((
              { event, stepId }: { event: string; stepId?: string },
            ) => event === "step_satisfied" || stepId === "dependent"),
          );
        } finally {
          rejectedCommit.exec("DROP TRIGGER IF EXISTS decline_evidence_commit");
          rejectedCommit.close();
        }
        assertEquals(checks, 3);
        stale = true;
        const waitRef = JSON.parse(
          (await control({
            ...start,
            id: waitingPlan.id,
            requestId: crypto.randomUUID(),
          })).result,
        ).run.ref;
        await until(() => checks === 4);
        readyRestartRunId = waitRef.id;
        await Deno.copyFile(evidenceJournal, readyRestartJournal);
        assertEquals(
          evidenceAdapter.inspect(waitRef.id)?.steps.map(({ status }) =>
            status
          ),
          [
            "pending",
            "pending",
          ],
        );
        notifyCommittedEvidence({
          ...requirement,
          revision: requirement.revision + 1,
        });
        assertEquals(checks, 4);
        stale = false;
        notifyCommittedEvidence(requirement);
        await until(() =>
          evidenceAdapter.inspect(waitRef.id)?.status === "completed"
        );
        assertEquals(checks, 5);
        stale = true;
        expiringRef = JSON.parse(
          (await control({
            ...start,
            id: expiringPlan.id,
            requestId: crypto.randomUUID(),
          })).result,
        ).run.ref;
        assert(expiringRef);
        const expiredId = expiringRef.id;
        await until(() => checks === 6);
        const waitTrace = JSON.parse(
          (await control({
            action: "traces",
            ...expiringRef,
          })).result,
        ).page.events.find(({ event }: { event: string }) =>
          event === "step_waiting"
        );
        originalDeadline = waitTrace.deadlineAt;
        assert(originalDeadline);
        await Deno.copyFile(evidenceJournal, restartJournal);
        const paused = JSON.parse(
          (await control({ action: "pause", ...expiringRef })).result,
        ).run;
        assertEquals(paused.status, "paused");
        await Deno.copyFile(evidenceJournal, pausedRestartJournal);
        await control({ action: "cancel", ...expiringRef });
        await until(() =>
          evidenceAdapter.inspect(expiredId)?.status === "cancelled"
        );
      }, evidenceAdapter);
      assert(expiringRef && originalDeadline);
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, Date.parse(originalDeadline!) - Date.now() + 20),
        )
      );
      let restartProbes = 0;
      const expired = createOperatorWorkflowRuns(
        createWorkflowRunRegistry(),
        [expiringPlan],
        restartJournal,
        () => {
          restartProbes++;
          return Promise.resolve(proof);
        },
      );
      await withGateway(async (control) => {
        const id = expiringRef!.id;
        assertEquals(expired.inspect(id)?.status, "interrupted");
        assertEquals(expired.recoverWaiting(), [id]);
        assertEquals(expired.recoverWaiting(), []);
        await until(() => expired.inspect(id)?.status === "failed");
        assertEquals(restartProbes, 0);
        assertEquals(expired.inspect(id)?.steps[1].status, "pending");
        const events = JSON.parse(
          (await control({
            action: "traces",
            ...expiringRef,
          })).result,
        ).page.events;
        assertEquals(
          events.filter(({ event }: { event: string }) =>
            event === "step_waiting"
          ).map(
            ({ deadlineAt }: { deadlineAt: string }) => deadlineAt,
          ),
          [originalDeadline],
        );
      }, expired);
      const pausedOnRestart = createOperatorWorkflowRuns(
        createWorkflowRunRegistry(),
        [expiringPlan],
        pausedRestartJournal,
        () => {
          restartProbes++;
          return Promise.resolve(proof);
        },
      );
      assertEquals(pausedOnRestart.recoverWaiting(), []);
      assertEquals(
        pausedOnRestart.inspect(expiringRef.id)?.status,
        "interrupted",
      );
      assertEquals(restartProbes, 0);
      const readyOnRestart = createOperatorWorkflowRuns(
        createWorkflowRunRegistry(),
        [waitingPlan],
        readyRestartJournal,
        () => Promise.resolve(proof),
      );
      assert(readyRestartRunId);
      assertEquals(readyOnRestart.recoverWaiting(), [readyRestartRunId]);
      await until(() =>
        readyOnRestart.inspect(readyRestartRunId!)?.status === "completed"
      );
      assertEquals(
        readyOnRestart.inspect(readyRestartRunId)?.steps[1].status,
        "completed",
      );
      const reopenedEvidence = createOperatorWorkflowRuns(
        createWorkflowRunRegistry(),
        [evidencePlan],
        evidenceJournal,
      );
      await withGateway(async (control) => {
        const traces = JSON.parse(
          (await control({
            action: "traces",
            ...successRef,
          })).result,
        ).page.events;
        const sequence = traces.map((
          { event, stepId }: { event: string; stepId?: string },
        ) => [event, stepId]);
        assertEquals(
          sequence.filter(([, id]: (string | undefined)[]) =>
            id === "evidence-check"
          ),
          [
            ["step_satisfied", "evidence-check"],
          ],
        );
        assertEquals(
          traces.find(({ event }: { event: string }) =>
            event === "step_satisfied"
          ).evidence,
          proof,
        );
        assert(
          sequence.findIndex(([kind]: string[]) => kind === "step_satisfied") <
            sequence.findIndex(([, id]: string[]) => id === "dependent"),
        );
      }, reopenedEvidence);
    }, restarted);
    // Capture a portable case after the linked traffic hint's revision changed.
    const priorHint = readSentinelCaseHints(peerPath, 10).find((
      { trafficReference },
    ) => trafficReference);
    assert(
      priorHint?.trafficReference &&
        "evidenceId" in priorHint.trafficReference && priorHint.revision &&
        priorHint.assetIds?.[0],
    );
    assert(stopSentinelAssessment(peerPath));
    const stoppedPeer = readSentinelAssessment(peerPath);
    assert(stoppedPeer?.plan.runId);
    const staging = await Deno.makeTempDir({ dir: baseDir });
    const captured = captureStoppedSentinelCaseArtifacts(baseDir, {
      caseId: peer.id,
      runId: stoppedPeer.plan.runId,
      evidenceRevision: stoppedPeer.revision,
    }, staging);
    const portableSnapshot = captured.artifacts.find(({ name }) =>
      name === "sentinel.json"
    );
    assert(portableSnapshot);
    assertEquals(
      readSentinelCaseHints(portableSnapshot.path, 10).find(({ id }) =>
        id === priorHint.id
      ),
      priorHint,
    );
    assertEquals(
      readSentinelTrafficReceiptPage(
        portableSnapshot.path,
        priorHint.revision,
        {
          evidenceId: priorHint.trafficReference.evidenceId,
          assetId: priorHint.assetIds[0],
        },
      )?.receipts[0]?.digest,
      priorHint.trafficReference.digest,
    );
  } finally {
    for (const pending of [activeRunId, pausedRunId]) {
      if (!pending || !runs.getActiveRun(pending)) continue;
      runs.stopRun(pending);
      await until(() => runs.getActiveRun(pending) === null);
    }
    runs.completeRun(unrelated, { status: "cancelled" });
    await Deno.remove(baseDir, { recursive: true });
  }
});
