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
import { openSentinelFindingTrafficLinks } from "../../src/sentinel/finding_traffic_links.ts";
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
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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
import { createOperatorWorkflowJournal } from "../../src/gateway/operator_workflow_journal.ts";
import { createOperatorWorkflowRuns } from "../../src/gateway/operator_workflow_runs.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { renderSentinelProvenanceJson } from "../../src/sentinel/assessment_export.ts";
import {
  readSentinelAssessment,
  readSentinelAssessmentRevision,
  readSentinelOperatingConstraints,
  refreshSentinelAssessment,
  startSentinelAssessment,
  stopSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { createWorkflowRunRegistry } from "../../src/workflow/registry.ts";

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
            call?.args?.action === "list_trace_workers" ||
            call?.args?.action === "worker_trace_result")
        ) {
          assertEquals(input.operation_type, "read");
          assertEquals(auditInput?.operation_type, "read");
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
      const journal = openSentinelWorkerFindingStore(peerPath);
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
      assertEquals(
        JSON.parse((await turn(attachTraffic)).result).link,
        trafficLink,
      );
      const trafficAction = { ...receiptAction, action: "finding_traffic" };
      assertEquals(JSON.parse((await turn(trafficAction)).result).page.links, [
        trafficLink,
      ]);
      const followLink = { ...trafficAction, trafficLinkId: trafficLink.id };
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
        JSON.parse((await turn(trafficAction)).result).page.links.length,
        2,
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

      const childCase = "linked-sentinel";
      const childPath = resolveSentinelCasePath(baseDir, childCase);
      await Deno.mkdir(dirname(childPath), { recursive: true });
      const childGraph = {
        version: 1,
        nodes: [{
          id: "child-asset",
          kind: "asset",
          label: "Child fixture asset",
        }],
        edges: [],
      };
      await Deno.writeTextFile(childPath, JSON.stringify(childGraph));
      const sentinelSpawn = {
        ...spawn,
        targetKind: "sentinel",
        targetId: childCase,
        requestId: crypto.randomUUID(),
      };
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
      assertEquals(linkedSentinel.run.ref, {
        kind: "sentinel",
        id: childCase,
        revision: 1,
      });
      assertEquals(linkedSentinel.link.origin, "spawn");
      assertEquals(linkedSentinel.link.left, linkedSentinel.run.ref);
      assertEquals(linkedSentinel.link.right, exact);
      const lastApproval = confirmations.length;
      await withGateway(async (reopenTurn) => {
        const reopened = JSON.parse((await reopenTurn(sentinelSpawn)).result);
        assertEquals(reopened.link, linkedSentinel.link);
        assertEquals(
          reopened.run.details.runId,
          linkedSentinel.run.details.runId,
        );
        assertEquals(confirmations.length, lastApproval);
        assertStringIncludes(
          (await reopenTurn({
            ...sentinelSpawn,
            requestId: crypto.randomUUID(),
          })).result,
          "unavailable",
        );
      }, reopenedWorkflows);

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
