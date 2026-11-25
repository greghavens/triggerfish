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
import { openExecutionTraces } from "../../src/core/execution_traces.ts";
import {
  createProviderRegistry,
  listEffectiveModelProfiles,
} from "../../src/agent/llm.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import {
  type ChannelId,
  createSession,
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

type Turn = (args: Record<string, unknown>) => Promise<{
  result: string;
  response?: string;
  error?: string;
}>;

Deno.test("owner socket controls exact Sentinel and configured workflow runs through policy", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir, "published");
  const confirmations: string[] = [];
  let approved = true;
  let duringConfirmation: (() => void) | undefined;
  const evaluated: { hook: string; taint: string; target?: unknown }[] = [];
  let denied: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | "PRE_OUTPUT" | undefined;
  let allowTracePayload = true;
  let originalToolInvocations = 0;
  let denyTraceSource: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | undefined;
  const traceSourceChecks: string[] = [];
  const workflowPayload = {
    kind: "github_actions_status" as const,
    repo: "owner/repo",
    repositoryId: 8642,
    workflow: "22",
    runs: [{ id: 123, status: "completed", conclusion: "success" }],
  };
  const repositoryPayload = {
    kind: "github_repository_status" as const,
    repo: workflowPayload.repo,
    repositoryId: workflowPayload.repositoryId,
    visibility: "private",
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
        const traceSource = [
          input.tool_name,
          (input.tool_call as { name?: string } | undefined)?.name,
        ]
          .some((name) =>
            name === "github_actions" || name === "github_repos" ||
            name === "github_pulls"
          );
        if (traceSource) {
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
      session: createSession({
        userId: "owner" as UserId,
        channelId: "test" as ChannelId,
        bumpersEnabled: false,
      }),
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
        workflows: adapter,
        profiles: (ceiling) =>
          listEffectiveModelProfiles(providerRegistry, ceiling),
        authorizeExecutionTracePayload: (payload, classification) => {
          assertEquals(
            payload,
            payload.kind === "github_repository_status"
              ? repositoryPayload
              : payload.kind === "github_pull_status"
              ? pullPayload
              : payload.kind === "github_release_status"
              ? releasePayload
              : payload.kind === "github_branch_protection"
              ? branchPayload
              : workflowPayload,
          );
          assertEquals(classification, "INTERNAL");
          return Promise.resolve(allowTracePayload);
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
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      await run((args) => {
        next = args;
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
          if (event.type === "response") response = event.text;
          if (event.type === "error") error = event.message;
          if (event.type === "turn_end") {
            done.resolve({ result, response, error });
          }
        }
        socket.addEventListener("message", receive);
        socket.send(
          JSON.stringify({
            type: "message",
            content: "Use the requested operator run control.",
          }),
        );
        return done.promise.finally(() => {
          clearTimeout(timer);
          socket.removeEventListener("message", receive);
        });
      });
    } finally {
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
        })).result,
      ).page;
      assertEquals(
        historicalInventory.assets.map(
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
        [workflowId, plan.id, sentinel.id, peer.id].sort(),
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
      assertEquals(
        JSON.parse((await turn(assignmentRequest)).result).receipt,
        assignmentReceipt,
      );
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
      const recoveryKey = await computeContentHash(JSON.stringify([
        interruptedScope.sessionId,
        interruptedScope.runId,
      ]));
      const recoveryPath = join(baseDir, "agent-recovery.db");
      const recovery = new AgentRecoveryStore(recoveryPath);
      try {
        const binding = "a".repeat(64);
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
      const restores: {
        restore: Record<string, unknown>;
        inspect: Record<string, unknown>;
        saved: unknown;
      }[] = [];
      for (const scope of [traceScope, scheduled, interruptedScope]) {
        const exact = { kind: scope.role, id: scope.runId };
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
        restores.push({ restore, inspect, saved });
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
        for (const { restore, inspect, saved } of restores) {
          assertEquals(
            JSON.parse((await restoreTurn(restore)).result).receipt.status,
            "succeeded",
          );
          assertEquals(JSON.parse((await restoreTurn(inspect)).result), saved);
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
        const namedSearch = {
          action: "execution_trace_payload",
          traceRole: "delegated",
          id: traceScope.runId,
          query: "main",
          limit: 1,
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
