import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createHash } from "node:crypto";
import { createSentinelLiveWorkflowReader } from "../../src/gateway/sentinel_live_workflow.ts";
import {
  branchExecutionEvidenceId,
  executionEvidenceDigest,
  repositoryVisibilityEvidenceId,
  sentinelExecutionEvidenceFile,
  workflowControlEvidenceId,
} from "../../src/sentinel/case_execution_evidence.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import type { ChatEvent } from "../../src/core/types/chat_event.ts";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  ensureSentinelFormalGoalContract,
  readSentinelGoalCompletionAtRevision,
  reportSentinelGoalCompletion,
} from "../../src/gateway/sentinel_goal_completion.ts";
import { createSentinelSubagent } from "../../src/gateway/sentinel_agent.ts";
import type { BootstrapResult } from "../../src/gateway/startup/bootstrap.ts";
import { createTidepoolSentinelHandler } from "../../src/gateway/startup/services/tidepool_sentinel.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  applySentinelFormalGoals,
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import {
  digestSentinelGoalProposal,
  type SentinelFormalGoal,
} from "../../src/sentinel/formal_goals.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import type {
  readSentinelWorkerFindingReport,
  SentinelWorkerFindingJournalRecord,
  SentinelWorkerFindingReportAmendment,
} from "../../src/sentinel/worker_finding_store.ts";
import { routeHostRequest } from "../../src/tools/tidepool/host/host_server.ts";
import type { A2UIHostState } from "../../src/tools/tidepool/host/host_types.ts";

const report = "sentinel_report_finding";
const context = "sentinel_finding_recheck_context";
const findings = "sentinel_worker_findings";
const recheck = "sentinel_record_finding_recheck";
const amend = "sentinel_update_finding_report";
const assigned = "sentinel_assigned_target";
const tool = (name: string, args: Record<string, unknown> = {}) => ({
  name,
  args,
});
type State = ReturnType<typeof startSentinelAssessment>;

function assignedLease(
  path: string,
  state: State,
  kind: "impact" | "trace" | "review_evidence",
  nodeId = "app",
) {
  const revision = adaptiveRevision(state);
  if (kind !== "review_evidence") advanceAdaptiveSentinel(path, state);
  const store = openSentinelAdaptiveStore(
    join(dirname(path), "sentinel-adaptive.db"),
  );
  try {
    store.sync(revision, [{
      kind,
      nodeId,
      ...(kind === "trace" && { depth: 1 }),
      reason: MODEL_ASSIGNMENT_REASON,
    }], kind === "review_evidence" ? store.activeRevision() : revision);
    advanceAdaptiveSentinel(path, state);
    const lease = store.claimModelReview(
      revision,
      MODEL_ASSIGNMENT_REASON,
      (task) => task.kind === kind && task.nodeId === nodeId,
    );
    assert(lease);
    return {
      assessmentRevision: state.revision,
      assignedTaskId: lease.task.id,
      assignedTaskLeaseToken: lease.token,
    };
  } finally {
    store.close();
  }
}

function nativeWorkflowReader() {
  return createSentinelLiveWorkflowReader({
    scopes: [{
      case: "main",
      asset: "app",
      owner: "owner",
      repo: "repo",
      workflow_id: 22,
    }],
    resolveToken: () => Promise.resolve("fixture-token"),
    ssrfChecker: () => Promise.resolve({ ok: true, value: "192.0.2.1" }),
    verifyAccess: () => Promise.resolve(true),
    readRuns: () => {
      throw new Error("Historical workflow runs must be reused");
    },
  });
}

async function workerTurn(
  path: string,
  lease: {
    assessmentRevision: number;
    assignedTaskId: string;
    assignedTaskLeaseToken: string;
  },
  batches: readonly (readonly ReturnType<typeof tool>[])[],
  deny?: "report" | "output" | "receipt-pre" | "receipt-post",
  executionSourceScope?: string,
  readRetainedWorkflow?: ReturnType<typeof nativeWorkflowReader>,
  execution?: {
    prompt: Parameters<ReturnType<typeof createSentinelSubagent>["execute"]>[0];
    options:
      Parameters<ReturnType<typeof createSentinelSubagent>["execute"]> extends
        [unknown, unknown, ...infer Rest] ? Rest : never;
  },
) {
  const receiptHooks: string[] = [];
  let reportPre = 0;
  let reportPost = 0;
  let outputHooks = 0;
  const hooks: HookRunner = {
    evaluateHook(hook, { session, input, auditInput }) {
      const name = String(
        input.tool_name ??
          (input.tool_call as { name?: string } | undefined)?.name,
      );
      const writing = [report, recheck, amend].includes(name);
      if (name === findings) receiptHooks.push(hook);
      if (writing && hook === "PRE_TOOL_CALL") {
        reportPre++;
        assertEquals(session.taint, "INTERNAL");
      }
      if ((writing || name === findings) && hook === "POST_TOOL_RESPONSE") {
        if (writing) reportPost++;
        assertEquals(session.taint, "INTERNAL");
        assert(typeof input.tool_response === "string");
        assert(!Object.hasOwn(auditInput ?? {}, "tool_response"));
        if (!input.tool_response.startsWith("Error:")) {
          assertEquals(
            JSON.parse(input.tool_response)._classification,
            "INTERNAL",
          );
        }
      }
      if (hook === "PRE_OUTPUT") {
        outputHooks++;
        assertEquals(input.target_classification, "INTERNAL");
      }
      const allowed =
        !(writing && hook === "PRE_TOOL_CALL" && deny === "report") &&
        !(name === findings && hook === "PRE_TOOL_CALL" &&
          deny === "receipt-pre") &&
        !(name === findings && hook === "POST_TOOL_RESPONSE" &&
          deny === "receipt-post") &&
        !(hook === "PRE_OUTPUT" && deny === "output");
      return Promise.resolve({
        allowed,
        action: allowed ? "ALLOW" : "BLOCK",
        duration: 0,
        ruleId: null,
      });
    },
  };
  const providerRegistry = createProviderRegistry();
  const results: string[][] = [];
  let iteration = 0;
  providerRegistry.register({
    name: "finding-fixture",
    supportsStreaming: false,
    complete(messages) {
      if (iteration > 0) {
        const start = batches.slice(0, iteration - 1).reduce(
          (sum, batch) => sum + batch.length,
          0,
        );
        const frames = messages.filter(({ role }) => role === "tool")
          .slice(start).map(({ content }) => String(content));
        assertEquals(frames.length, batches[iteration - 1].length);
        results.push(frames);
      }
      const batch = batches[iteration++];
      return Promise.resolve({
        content: batch
          ? ""
          : '{"summary":"Reviewed the saved control evidence.","followUps":[]}',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: batch?.map(({ name, args }, index) => ({
          id: `finding-${iteration}-${index}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        })) ?? [],
      });
    },
  });
  providerRegistry.setDefault("finding-fixture");
  const worker = createSentinelSubagent({
    snapshotPath: path,
    providerRegistry,
    hookRunner: hooks,
    allowModelAccess: true,
    ...lease,
    sharedInventoryBaseDir: executionSourceScope,
    readRetainedWorkflow,
    authorizeExecutionTracePayload: executionSourceScope
      ? (payload) => Promise.resolve([42, 43].includes(payload.repositoryId))
      : undefined,
  });
  const events: ChatEvent[] = [];
  try {
    await worker.execute(
      execution?.prompt ?? "Review the exact assigned control evidence.",
      (event) => events.push(event),
      ...execution?.options ?? [],
    );
    assertEquals(results.length, batches.length);
    return {
      results,
      receiptHooks,
      reportPre,
      reportPost,
      outputHooks,
      events,
    };
  } finally {
    worker.clear();
  }
}

async function withTidepool(
  baseDir: string,
  test: (
    list: (
      revision?: number,
      caseId?: string,
    ) => Promise<SentinelWorkerFindingJournalRecord[]>,
    provenance: (
      revision: number,
    ) => Promise<
      {
        workerFindings: NonNullable<
          ReturnType<typeof readSentinelWorkerFindingReport>
        >;
        planningAttempts: readonly {
          inputManifest?: { findingRecheckIds?: readonly string[] };
        }[];
      }
    >,
    request: (
      type: string,
      fields: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>,
  ) => Promise<void>,
) {
  const key = crypto.randomUUID();
  const handler = createTidepoolSentinelHandler({
    baseDir,
    config: { sentinel: { allow_model_access: true } },
  } as BootstrapResult);
  const state: A2UIHostState = {
    clients: new Set(),
    server: null,
    currentTree: null,
    resolvedPort: 0,
    cachedHtml: null,
    sessionKey: key,
    lastMcpConnected: -1,
    lastMcpConfigured: -1,
    topicHandlers: {
      sentinel: (message, socket) => void handler(message, socket),
    },
    socketCleanupCallbacks: [],
    canvasRenders: [],
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => routeHostRequest(request, state, undefined),
  );
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.addr.port}/?key=${key}`,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let sequence = 0;
    const request = async (type: string, fields: Record<string, unknown>) => {
      const requestId = ++sequence;
      const result = Promise.withResolvers<Record<string, unknown>>();
      const timer = setTimeout(
        () => result.reject(new Error("No worker finding reply")),
        3_000,
      );
      function receive(event: MessageEvent) {
        const message = JSON.parse(event.data);
        if (message.requestId === requestId && message.topic === "sentinel") {
          result.resolve(message);
        }
      }
      socket.addEventListener("message", receive);
      socket.send(
        JSON.stringify({
          topic: "sentinel",
          type,
          ...fields,
          requestId,
        }),
      );
      try {
        return await result.promise;
      } finally {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
      }
    };
    await test(async (revision, caseId = "main") => {
      const response = await request("worker_findings", { revision, caseId });
      assertEquals(response.type, "sentinel_worker_findings");
      assertEquals(response.caseId, caseId);
      assertEquals(response.evidenceRevision, revision ?? null);
      assert(Array.isArray(response.records));
      return response.records;
    }, async (revision) => {
      const response = await request("export", {
        format: "provenance",
        revision,
      });
      assertEquals(response.type, "export");
      assertEquals(response.caseId, "main");
      assertEquals(response.revision, revision);
      assert(typeof response.content === "string");
      const result = JSON.parse(response.content);
      assert(result.workerFindings);
      assert(Array.isArray(result.planningAttempts));
      return {
        workerFindings: result.workerFindings,
        planningAttempts: result.planningAttempts,
      };
    }, request);
  } finally {
    socket.close();
    await server.shutdown();
  }
}

Deno.test("Leased Sentinel workers report, recheck, and amend findings visible in authenticated Tidepool", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  let modelPlanner: ReturnType<typeof createSentinelModelPlanner> | undefined;
  const now = Date.now();
  function snapshot(remediated: boolean) {
    const verify = (id: string, outcome: "fail" | "pass", ago: number) => ({
      id,
      kind: "evidence",
      label: id,
      controlVerification: {
        outcome,
        observedAt: new Date(now - ago).toISOString(),
        validUntil: new Date(now + 3_600_000).toISOString(),
      },
    });
    const nodeIds = ["failed-check", ...(remediated ? ["passing-check"] : [])];
    return {
      version: 1,
      nodes: [
        { id: "app", kind: "asset", label: "Assigned application" },
        {
          id: "review-gap",
          kind: "finding",
          label: "Control gap",
          severity: "high",
        },
        { id: "check-control", kind: "control", label: "Control under review" },
        verify("failed-check", "fail", 120_000),
        ...(remediated ? [verify("passing-check", "pass", 60_000)] : []),
      ],
      edges: [
        { from: "review-gap", to: "app", relation: "affects" },
        { from: "check-control", to: "review-gap", relation: "mitigates" },
        ...nodeIds.flatMap((id) => [
          { from: id, to: "check-control", relation: "verifies" },
          { from: id, to: "app", relation: "observed_on" },
        ]),
      ],
    };
  }
  try {
    const otherPath = resolveSentinelCasePath(baseDir, "other");
    await Deno.mkdir(dirname(otherPath), { recursive: true });
    await Deno.writeTextFile(otherPath, JSON.stringify(snapshot(false)));
    await Deno.writeTextFile(path, JSON.stringify(snapshot(false)));
    const first = startSentinelAssessment(path);
    const source = assignedLease(path, first, "impact");
    const submission = {
      graphFindingId: "review-gap",
      controlId: "check-control",
      evidenceId: "failed-check",
      requestId: crypto.randomUUID(),
      title: "Recorded control gap",
      summary: "Retained check observed the control failing.",
    };
    let finding: SentinelWorkerFindingJournalRecord | undefined;
    let check: SentinelWorkerFindingJournalRecord | undefined;
    let secondRevision: number | undefined;
    let amendment: SentinelWorkerFindingReportAmendment | undefined;

    await withTidepool(baseDir, async (list, provenance) => {
      const denied = await workerTurn(path, source, [[tool(assigned)], [
        tool(report, submission),
      ]], "report");
      assertEquals(denied.reportPre, 1);
      assertEquals(denied.reportPost, 0);
      assertEquals(await list(), []);
      await assertRejects(
        () => Deno.lstat(join(dirname(path), "sentinel-worker-findings.db")),
        Deno.errors.NotFound,
      );

      const firstReport = await workerTurn(path, source, [
        [tool(report, submission)],
        [tool(assigned)],
        [
          tool(report, { ...submission, evidenceId: "wrong-record" }),
          tool(report, submission),
          tool(report, submission),
          tool(report, { ...submission, summary: "Changed replay input." }),
        ],
      ]);
      assertStringIncludes(
        firstReport.results[0][0],
        "Read the exact linked evidence",
      );
      assertStringIncludes(firstReport.results[1][0], "failed-check");
      const [wrong, accepted, duplicate, conflict] = firstReport.results[2];
      assertStringIncludes(wrong, "Read the exact linked evidence");
      assertStringIncludes(conflict, "unavailable");
      const original = JSON.parse(accepted).record;
      assertEquals(JSON.parse(duplicate).record, original);
      assertEquals(original.kind, "finding");
      assertEquals(original.evidenceRevision, first.revision);
      assertEquals(original.taskId, source.assignedTaskId);
      assertEquals(original.evidenceId, "failed-check");
      assertEquals(firstReport.reportPre, 5);
      assertEquals(firstReport.reportPost, 5);
      assertEquals(await list(first.revision), [original]);
      assertEquals(await list(undefined, "other"), []);
      finding = original;
      assert(finding);

      await Deno.writeTextFile(path, JSON.stringify(snapshot(true)));
      const goals: SentinelFormalGoal[] = [{
        id: "controls",
        title: "Verify remediation",
        policy: "operator",
        criteria: [{
          id: "remediated",
          description:
            "The original control failure has a verified passing recheck",
          source: "finding_recheck",
          reference: `pass:${original.id}`,
        }],
      }];
      const { state: second } = applySentinelFormalGoals(path, {
        mode: "append",
        requestId: crypto.randomUUID(),
        expectedRevision: first.revision,
        expectedRunId: first.plan.runId,
        proposalDigest: digestSentinelGoalProposal(goals),
        goals,
      });
      assert(second && second.revision > first.revision);
      secondRevision = second.revision;
      const stale = await workerTurn(path, source, [[tool(assigned)], [
        tool(report, submission),
      ]]);
      assertStringIncludes(
        stale.results[1][0],
        "Read the exact linked evidence",
      );
      assertEquals(await list(), [original]);

      const worker = assignedLease(path, second, "trace");
      const update = {
        findingId: finding.id,
        requestId: crypto.randomUUID(),
        summary: "Newer retained evidence verifies the control.",
      };
      const goal = ensureSentinelFormalGoalContract(path, second);
      assert(goal);
      const scope = goal.scope;
      const rounds: unknown[] = [];
      let plannerClock = Date.now();
      const planner = createSentinelModelPlanner(
        path,
        (_state, assignment) => ({
          execute(prompt, send) {
            if (assignment) return Promise.resolve();
            const inputs = JSON.parse(String(prompt).split("\n").at(-1)!);
            rounds.push(inputs.findingRechecks ?? []);
            const receipt = inputs.findingRechecks?.[0];
            send({
              type: "response",
              taint: "INTERNAL",
              text: JSON.stringify({
                assignments: [],
                prioritize: [],
                ...(receipt && {
                  goalObservations: [{
                    criterionId: inputs.goalCompletion.criteria[0].id,
                    evidence: [{
                      source: "finding_recheck",
                      reference: receipt.id,
                      detail: "Verified recheck",
                    }],
                  }],
                }),
              }),
            });
            return Promise.resolve();
          },
          clear() {},
        }),
        undefined,
        () => plannerClock,
      );
      modelPlanner = planner;
      const waitFor = async (condition: () => boolean) => {
        const end = Date.now() + 2_000;
        while (!condition() && Date.now() < end) {
          planner.advance(second);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert(condition(), "Sentinel planning round did not settle");
      };
      planner.advance(second);
      await waitFor(() =>
        readAdaptiveSentinel(path, second)?.modelPlanner?.status ===
          "no_new_assignments"
      );
      assertEquals(rounds, [[]]);
      const decision = await workerTurn(path, worker, [
        [tool(context, { findingId: finding.id }), tool(assigned)],
        [
          tool(recheck, { ...update, evidenceId: "failed-check" }),
          tool(recheck, { ...update, evidenceId: "passing-check" }),
          tool(recheck, { ...update, evidenceId: "passing-check" }),
        ],
      ], "output");
      const proof = JSON.parse(decision.results[0][0]);
      assertEquals(proof.finding, original);
      assertEquals(proof.originalOutcome, "fail");
      assertEquals(proof.current.evidenceId, "passing-check");
      assertEquals(proof.current.outcome, "pass");
      assertStringIncludes(decision.results[0][1], "passing-check");
      assertStringIncludes(decision.results[0][1], "failed-check");
      assertStringIncludes(decision.results[1][0], "unavailable");
      const verified = JSON.parse(decision.results[1][1]).record;
      assertEquals(JSON.parse(decision.results[1][2]).record, verified);
      assertEquals(verified.kind, "recheck");
      assertEquals(verified.findingId, finding.id);
      assertEquals(verified.outcome, "pass");
      assertEquals(verified.evidenceRevision, second.revision);
      assertEquals(verified.taskId, worker.assignedTaskId);
      assertEquals(decision.reportPost, 3);
      assertEquals(decision.outputHooks, 1);
      assert(!decision.events.some(({ type }) => type === "response"));
      assert(decision.events.some(({ type }) => type === "error"));
      const firstPage = JSON.parse(
        (await workerTurn(path, worker, [[
          tool(findings, { limit: 1 }),
        ]])).results[0][0],
      );
      assertEquals(firstPage.records, [verified]);
      assertEquals(firstPage.nextBeforeReceiptId, verified.id);
      const nextPage = await workerTurn(path, worker, [[
        tool(findings, {
          limit: 1,
          beforeReceiptId: firstPage.nextBeforeReceiptId,
        }),
        tool(findings, {
          revision: first.revision,
          beforeReceiptId: firstPage.nextBeforeReceiptId,
        }),
      ]]);
      const older = JSON.parse(nextPage.results[0][0]);
      assertEquals(older.records, [original]);
      assertEquals(older.nextBeforeReceiptId, null);
      assertStringIncludes(nextPage.results[0][1], "unavailable");
      const lookup = tool(findings, { receiptId: verified.id });
      const exact = await workerTurn(path, worker, [[
        lookup,
        tool(findings, { receiptId: original.id, revision: first.revision }),
        tool(findings, { receiptId: verified.id, revision: first.revision }),
      ]]);
      assertEquals(JSON.parse(exact.results[0][0]).record, verified);
      assertEquals(JSON.parse(exact.results[0][1]).record, original);
      assertStringIncludes(exact.results[0][2], "unavailable");
      assert(exact.receiptHooks.includes("PRE_TOOL_CALL"));
      assert(exact.receiptHooks.includes("POST_TOOL_RESPONSE"));
      const blocked = await workerTurn(path, worker, [[lookup]], "receipt-pre");
      assertEquals(blocked.receiptHooks, ["PRE_TOOL_CALL"]);
      assert(!blocked.results[0][0].includes(verified.id));
      const withheld = await workerTurn(
        path,
        worker,
        [[lookup]],
        "receipt-post",
      );
      assertEquals(withheld.receiptHooks, [
        "PRE_TOOL_CALL",
        "POST_TOOL_RESPONSE",
      ]);
      assertStringIncludes(withheld.results[0][0], "withheld by policy");
      const staleLookup = await workerTurn(path, source, [[lookup]]);
      assertStringIncludes(staleLookup.results[0][0], "unavailable");
      check = verified;
      const submit = (reference: string) =>
        reportSentinelGoalCompletion(
          path,
          scope,
          [{
            criterionId: "controls/remediated",
            evidence: [{ source: "finding_recheck", reference, detail: "" }],
          }],
        );
      assertEquals(submit(original.id).record.status, "open");
      assertEquals(
        submit(`worker-recheck:${"0".repeat(64)}`).record.status,
        "open",
      );
      planner.advance(second);
      assertEquals(rounds, [[]]);
      plannerClock += 60_001;
      planner.advance(second);
      await waitFor(() =>
        readSentinelGoalCompletionAtRevision(path, second.revision)?.status ===
          "awaiting_confirmation"
      );
      assertEquals(rounds, [[], [{
        id: verified.id,
        findingId: original.id,
        outcome: "pass",
      }]]);
      const savedHistory = readAdaptiveSentinel(path, second)
        ?.modelPlannerHistory;
      assertEquals(
        savedHistory?.map(({ inputManifest }) =>
          inputManifest?.findingRecheckIds
        ),
        [undefined, [verified.id]],
      );
      const verifiedGoal = readSentinelGoalCompletionAtRevision(
        path,
        second.revision,
      );
      assert(verifiedGoal);
      assertEquals(verifiedGoal.status, "awaiting_confirmation");
      assertEquals(
        verifiedGoal.observations[0].evidence[0].reference,
        verified.id,
      );
      assertEquals(
        submit(verified.id).record.observations,
        verifiedGoal.observations,
      );
      const offer = tool("sentinel_prove_goal", {
        goalId: "controls",
        criterionId: "remediated",
        source: "finding_recheck",
        evidenceId: verified.id,
      });
      const withheldProof = await workerTurn(
        path,
        worker,
        [[lookup], [offer]],
        "receipt-post",
      );
      assertStringIncludes(withheldProof.results[1][0], "exact evidence");
      const filed = await workerTurn(path, worker, [[lookup], [offer, offer]]);
      const workerProof = JSON.parse(filed.results[1][0]);
      assertEquals(workerProof.proof.reference, verified.id);
      assertEquals(workerProof.proof.source, "finding_recheck");
      assertStringIncludes(workerProof.proof.detail, worker.assignedTaskId);
      assertEquals(JSON.parse(filed.results[1][1]), workerProof);
      const draft = {
        findingId: original.id,
        requestId: crypto.randomUUID(),
        expectedVersion: 1,
        title: "Updated control gap report",
        summary:
          "The original failure remains evidence. A newer recheck passed.",
      };
      const edited = await workerTurn(path, worker, [[
        tool(amend, draft),
        tool(amend, draft),
        tool(amend, {
          ...draft,
          requestId: crypto.randomUUID(),
          title: "A different edit based on an older version",
        }),
        tool(amend, { ...draft, title: "Changed duplicate" }),
      ]]);
      const [changed, replayed, staleVersion, changedRetry] = edited.results[0];
      const version2 = JSON.parse(changed).amendment;
      assertEquals(JSON.parse(replayed).amendment, version2);
      assertStringIncludes(staleVersion, "unavailable");
      assertStringIncludes(changedRetry, "unavailable");
      assertEquals(edited.reportPre, 4);
      assertEquals(edited.reportPost, 4);
      assertEquals(version2.kind, "report_amendment");
      assertEquals(version2.version, 2);
      assertEquals(version2.findingId, original.id);
      assertEquals(version2.title, draft.title);
      assertEquals(version2.summary, draft.summary);
      assertEquals(version2.evidenceRevision, second.revision);
      assertEquals(version2.taskId, worker.assignedTaskId);
      amendment = version2;
      assertEquals(await list(first.revision), [original]);
      assertEquals(await list(second.revision), [verified]);
      assertEquals((await provenance(first.revision)).workerFindings, {
        findings: [original],
        rechecks: [],
        amendments: [],
        reports: [{
          finding: original,
          version: 1,
          title: original.title,
          summary: original.summary,
          amendments: [],
        }],
      });
      assertEquals((await provenance(second.revision)).workerFindings, {
        findings: [original],
        rechecks: [verified],
        amendments: [version2],
        reports: [{
          finding: original,
          version: 2,
          title: draft.title,
          summary: draft.summary,
          amendments: [version2],
        }],
      });
    });

    assert(finding && check && secondRevision && amendment);
    assertEquals(
      readSentinelGoalCompletionAtRevision(path, secondRevision)
        ?.observations[0].evidence[0].reference,
      check.id,
    );
    await withTidepool(baseDir, async (list, provenance) => {
      assertEquals(await list(first.revision), [finding!]);
      assertEquals(await list(secondRevision), [check!]);
      assertEquals(
        (await list()).map(({ id }) => id).sort(),
        [finding!.id, check!.id].sort(),
      );
      assertEquals(await list(undefined, "other"), []);
      assertEquals(
        (await provenance(first.revision)).workerFindings.amendments,
        [],
      );
      const restored = await provenance(secondRevision!);
      assertEquals(restored.workerFindings.findings, [finding!]);
      assertEquals(restored.workerFindings.rechecks, [check!]);
      assertEquals(
        restored.planningAttempts.map(({ inputManifest }) =>
          inputManifest?.findingRecheckIds
        ),
        [undefined, [check!.id]],
      );
      assertEquals(restored.workerFindings.amendments, [amendment!]);
    });
  } finally {
    modelPlanner?.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});

async function verifyOperatorNativeRecheck(options: {
  baseDir: string;
  state: State;
  findingId: string;
  evidenceId: string;
  digest: string;
  trace?: { taskId: string; result: unknown; index?: number };
}) {
  let blocked = false;
  let blockOutput = false;
  let revokeOnConfirm = false;
  let modelResult: string | undefined;
  const registry = createProviderRegistry();
  registry.register({
    name: "operator-evidence-fixture",
    supportsStreaming: false,
    complete(messages) {
      const response = messages.at(-1)?.role === "tool"
        ? messages.at(-1)
        : undefined;
      if (response) modelResult = String(response.content);
      return Promise.resolve({
        content: response ? "Review complete." : "",
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: response ? [] : [{
          id: "native-control-read",
          type: "function",
          function: {
            name: "operator_runs",
            arguments: JSON.stringify({
              kind: "sentinel",
              id: "main",
              revision: options.state.revision,
              ...(options.trace
                ? {
                  action: "worker_trace_result",
                  taskId: options.trace.taskId,
                  stepIndices: [options.trace.index ?? 0],
                }
                : {
                  action: "case_execution_evidence",
                  node: options.evidenceId,
                }),
            }),
          },
        }],
      });
    },
  });
  registry.setDefault("operator-evidence-fixture");
  const confirmations: string[] = [];
  const gateway = createChatSession({
    session: createSession({
      userId: "owner" as UserId,
      channelId: "native-recheck" as ChannelId,
      bumpersEnabled: false,
    }),
    providerRegistry: registry,
    hookRunner: {
      evaluateHook(hook, { input }) {
        const allowed = !(blocked && hook === "PRE_TOOL_CALL" &&
          input.tool_name === "sentinel_live_workflow_status") &&
          !(blocked && hook === "PRE_TOOL_CALL" &&
            input.tool_name === findings) &&
          !(blockOutput && hook === "PRE_OUTPUT");
        return Promise.resolve({
          allowed,
          action: allowed ? "ALLOW" : "BLOCK",
          duration: 0,
          ruleId: null,
        });
      },
    },
    operatorRunExecutor: createOperatorRunToolExecutor({
      baseDir: options.baseDir,
      readLiveWorkflow: nativeWorkflowReader(),
      confirm(text) {
        confirmations.push(text);
        if (revokeOnConfirm) blocked = true;
        return Promise.resolve(true);
      },
    }),
  });
  const run = async (command: string) => {
    const events: ChatEvent[] = [];
    await gateway.executeAgentTurn(command, (event) => events.push(event));
    const last = events.at(-1);
    assert(last?.type === "response", JSON.stringify(events));
    return last.text;
  };
  const command =
    `/sentinel-recheck main ${options.state.revision} ${options.findingId}`;
  await run("Review the exact saved workflow evidence.");
  if (options.trace) {
    assertEquals(JSON.parse(modelResult ?? "").result, options.trace.result);
    blocked = true;
    await run("Review that exact worker exchange again.");
    assertStringIncludes(modelResult ?? "", "unavailable");
    return;
  }
  assertEquals(
    JSON.parse(modelResult ?? "").evidence.resultSha256,
    options.digest,
  );
  blockOutput = true;
  const hidden: ChatEvent[] = [];
  await gateway.executeAgentTurn(command, (event) => hidden.push(event));
  assertEquals(hidden.at(-1)?.type, "error");
  blockOutput = false;
  blocked = true;
  assertEquals(JSON.parse(await run(command)).candidates, []);
  blocked = false;
  const discovered = JSON.parse(await run(command));
  assertEquals(discovered.candidates, [{
    nodeId: options.evidenceId,
    resultSha256: options.digest,
  }]);
  assertEquals(discovered.runId, options.state.plan.runId);
  const requestId = crypto.randomUUID();
  const queue =
    `${command} queue ${options.evidenceId} ${discovered.runId} ${discovered.adaptiveRevision} ${requestId}`;
  revokeOnConfirm = true;
  assertStringIncludes(await run(queue), "unavailable");
  assertEquals(confirmations.length, 1);
  assertStringIncludes(confirmations[0], options.digest);
  blocked = false;
  revokeOnConfirm = false;
  const assigned = JSON.parse(await run(queue)).receipt;
  assertEquals(assigned.recheckFindingId, options.findingId);
  assertEquals(assigned.nodeId, options.evidenceId);
  assertEquals(JSON.parse(await run(queue)).receipt, assigned);
  assertEquals(confirmations.length, 2);
}

async function verifyReceiptFamily(
  family:
    | "branch protection"
    | "repository visibility"
    | "workflow result"
    | "workflow result with repeated run"
    | "workflow result with older run"
    | "native workflow result",
  manual = false,
) {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  let receiptPlanner:
    | ReturnType<typeof createSentinelModelPlanner>
    | undefined;
  const placeholder = `execution-evidence:${"a".repeat(64)}`;
  const validUntil = new Date(Date.now() + 3_600_000).toISOString();
  const repo = "owner/repo";
  const branchPayload = {
    kind: "github_branch_protection" as const,
    repo,
    repositoryId: 42,
    protectedCount: 0,
    unprotectedCount: 1,
    approvedBranches: [{ name: "main", protected: false }],
  };
  const visibilityPayload = {
    kind: "github_repository_status" as const,
    repo,
    repositoryId: 42,
    visibility: "public" as const,
  };
  const workflowPayload = {
    kind: "github_actions_status" as const,
    repo,
    repositoryId: 42,
    workflow: "22",
    perPage: 1,
    runs: [{
      id: 1,
      status: "completed",
      conclusion: "failure",
      created_at: "2025-01-02T00:00:00.000Z",
    }],
  };
  const visibility = family === "repository visibility";
  const repeatedRun = family === "workflow result with repeated run";
  const olderRun = family === "workflow result with older run";
  const native = family === "native workflow result";
  const workflow = native || family === "workflow result" || repeatedRun ||
    olderRun;
  const reader = native ? nativeWorkflowReader() : undefined;
  const nativeRuns = [
    {
      id: 1,
      status: "completed",
      conclusion: "failure",
      repositoryId: 42,
      createdAt: "2025-01-02T00:00:00.000Z",
    },
    {
      id: 2,
      status: "completed",
      conclusion: "success",
      repositoryId: 42,
      createdAt: "2025-01-03T00:00:00.000Z",
    },
    {
      id: 3,
      status: "completed",
      conclusion: "success",
      repositoryId: 42,
      createdAt: "2025-01-01T00:00:00.000Z",
    },
  ];
  const nativeSources: {
    runId: string;
    revision: number;
    taskId: string;
    stepIndex: number;
    workflowRunNumber: number;
    resultSha256: string;
  }[] = [];
  const payload = workflow
    ? workflowPayload
    : visibility
    ? visibilityPayload
    : branchPayload;
  const evidenceId = (
    runId: string,
    source: Parameters<typeof branchExecutionEvidenceId>[3],
    foreign = false,
  ) =>
    workflow
      ? workflowControlEvidenceId(
        runId,
        "app",
        "control",
        source,
        42,
        foreign && !repeatedRun && !olderRun ? "23" : "22",
        validUntil,
      )
      : visibility
      ? repositoryVisibilityEvidenceId(
        runId,
        "app",
        "control",
        source,
        foreign ? 43 : 42,
        validUntil,
      )
      : branchExecutionEvidenceId(
        runId,
        "app",
        "control",
        source,
        "main",
        validUntil,
      );
  const recordedAt = new Date(Date.now() - 30_000).toISOString();
  const passedAt = new Date(Date.now() - 10_000).toISOString();
  const foreignAt = new Date(Date.now() - 5_000).toISOString();
  const source = {
    role: "delegated" as const,
    runId: "source-review",
    ordinal: 1,
    receiptId: `execution-trace:${"b".repeat(64)}`,
    resultSha256: executionEvidenceDigest(payload),
  };
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", kind: "asset", label: "Assigned asset" },
          {
            id: "gap",
            kind: "finding",
            label: `${family} gap`,
            severity: "low",
          },
          { id: "control", kind: "control", label: family },
          {
            id: placeholder,
            kind: "evidence",
            label: `Saved ${family} receipt`,
            executionSource: source,
            controlVerification: {
              outcome: "fail",
              observedAt: recordedAt,
              validUntil,
            },
          },
        ],
        edges: [
          { from: "gap", to: "app", relation: "affects" },
          { from: "control", to: "gap", relation: "mitigates" },
          { from: placeholder, to: "control", relation: "verifies" },
          { from: placeholder, to: "app", relation: "observed_on" },
        ],
      }),
    );
    await Deno.writeTextFile(
      join(dirname(path), sentinelExecutionEvidenceFile),
      JSON.stringify([{
        ...source,
        recordedAt,
        classification: "INTERNAL",
        payload,
      }]),
      { mode: 0o600 },
    );
    const started = startSentinelAssessment(path);
    let node = evidenceId(started.plan.runId!, source);
    if (native) {
      const lease = assignedLease(path, started, "trace");
      const store = openSentinelAdaptiveStore(
        join(dirname(path), "sentinel-adaptive.db"),
      );
      const steps = nativeRuns.map((run, stepIndex) => {
        const runs = [run];
        const resultSha256 = createHash("sha256").update(JSON.stringify(runs))
          .digest("hex");
        nativeSources.push({
          runId: started.plan.runId!,
          revision: started.revision,
          taskId: lease.assignedTaskId,
          stepIndex,
          workflowRunNumber: run.id,
          resultSha256,
        });
        return {
          tool: "sentinel_live_workflow_status",
          target: "app",
          outcome: "returned" as const,
          githubWorkflowRead: {
            repository: repo,
            workflowId: 22,
            evidenceRevision: started.revision,
            observedAt: [recordedAt, passedAt, foreignAt][stepIndex],
            connectorId: "github-actions" as const,
            resultSha256,
            runs,
          },
        };
      });
      try {
        assert(store.recordModelReviewProgress(
          adaptiveRevision(started),
          lease.assignedTaskId,
          lease.assignedTaskLeaseToken,
          steps,
        ));
      } finally {
        store.close();
      }
      node = "native-workflow-evidence:" + nativeSources[0].resultSha256;
    }
    const input = JSON.parse(
      (await Deno.readTextFile(path)).replaceAll(placeholder, node),
    );
    if (native) {
      const evidence = input.nodes.find((entry: { id: string }) =>
        entry.id === node
      );
      delete evidence.executionSource;
      evidence.nativeWorkflowSource = nativeSources[0];
    }
    await Deno.writeTextFile(path, JSON.stringify(input));
    const state = refreshSentinelAssessment(path);
    assert(state);
    const lease = assignedLease(path, state, "review_evidence", node);
    const submission = {
      graphFindingId: "gap",
      controlId: "control",
      evidenceId: node,
      requestId: crypto.randomUUID(),
      title: `${family} control gap`,
      summary: "The retained verification reports a failed control.",
    };
    const outcome = await workerTurn(
      path,
      lease,
      [
        [tool(assigned)],
        [tool(report, submission)],
        [tool("sentinel_assigned_execution_evidence", { node })],
        [tool(report, submission), tool(report, submission)],
      ],
      undefined,
      baseDir,
      reader,
    );
    assertStringIncludes(
      outcome.results[1][0],
      "Read the exact linked evidence",
    );
    assertEquals(
      JSON.parse(outcome.results[2][0]).evidence.payload,
      native
        ? JSON.parse(JSON.stringify({ ...workflowPayload, perPage: undefined }))
        : payload,
    );

    const finding = JSON.parse(outcome.results[3][0]).record;
    assert(finding);
    assertEquals(finding.targetId, "app");
    assertEquals(finding.evidenceId, node);
    assertEquals(finding.taskId, lease.assignedTaskId);
    assertEquals(JSON.parse(outcome.results[3][1]).record, finding);
    await withTidepool(baseDir, async (list) => {
      assertEquals(await list(state.revision), [finding]);
    });
    const peer = await workerTurn(path, assignedLease(path, state, "trace"), [
      [tool(findings, { receiptId: finding.id })],
    ]);
    assertEquals(JSON.parse(peer.results[0][0]).record, finding);
    const planningRegistry = createProviderRegistry();
    let plannerTurns = 0;
    let workerFinding: string | undefined;
    let receiptTargets: string[] = [];
    let recheckCandidates: (string[] | undefined)[] = [];
    planningRegistry.register({
      name: "receipt-candidate-planner",
      supportsStreaming: false,
      complete(messages) {
        const completed = messages.filter(({ role }) => role === "tool");
        if (completed.length) {
          recheckCandidates = completed.map(({ content }) =>
            JSON.parse(String(content)).recheckFindingIds
          );
        }
        if (completed.length || !receiptTargets.length) {
          plannerTurns++;
          return Promise.resolve({
            content: JSON.stringify(
              recheckCandidates[0]?.length
                ? receiptTargets.map((nodeId) => ({
                  kind: "review_evidence",
                  nodeId,
                  recheckFindingId: recheckCandidates[0]![0],
                }))
                : [],
            ),
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: [],
          });
        }
        return Promise.resolve({
          content: "",
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: receiptTargets.map((node, index) => ({
            type: "function",
            id: `candidate-receipt-${index}`,
            function: {
              name: "sentinel_case_execution_evidence",
              arguments: JSON.stringify({ node }),
            },
          })),
        });
      },
    });
    planningRegistry.setDefault("receipt-candidate-planner");
    let scheduledResult: unknown;
    let scheduledRead: unknown;
    let scheduledFindingRead: unknown;
    const clock = Date.now();
    receiptPlanner = createSentinelModelPlanner(
      path,
      (state, taskId, token, role) =>
        role === "planner"
          ? createSentinelSubagent({
            snapshotPath: path,
            assessmentRevision: state.revision,
            plannerExecutionEvidenceRunId: state.plan.runId,
            sharedInventoryBaseDir: baseDir,
            readRetainedWorkflow: reader,
            providerRegistry: planningRegistry,
            authorizeExecutionTracePayload: (receipt) =>
              Promise.resolve([42, 43].includes(receipt.repositoryId)),
            allowModelAccess: true,
            hookRunner: {
              evaluateHook: () =>
                Promise.resolve({
                  allowed: true,
                  action: "ALLOW",
                  duration: 0,
                  ruleId: null,
                }),
            },
          })
          : {
            execute: async (
              message,
              send,
              signal,
              onStep,
              digests,
              checkpoint,
            ) => {
              const input = JSON.parse(String(message).split("\n").at(-1)!);
              if (input.recheckFindingId) {
                workerFinding = input.recheckFindingId;
                if (native) {
                  assert(taskId && token);
                  const check = {
                    findingId: input.recheckFindingId,
                    evidenceId: input.target,
                    requestId: crypto.randomUUID(),
                    summary: "Verified the newer native workflow run.",
                  };
                  const review = await workerTurn(
                    path,
                    {
                      assessmentRevision: state.revision,
                      assignedTaskId: taskId,
                      assignedTaskLeaseToken: token,
                    },
                    [
                      [tool("sentinel_assigned_execution_evidence", {
                        node: check.evidenceId,
                      })],
                      [tool(context, { findingId: check.findingId })],
                      [tool(recheck, check), tool(recheck, check)],
                      [tool(findings, { receiptId: check.findingId })],
                    ],
                    undefined,
                    baseDir,
                    reader,
                    {
                      prompt: message,
                      options: [signal, onStep, digests, checkpoint],
                    },
                  );
                  scheduledRead = JSON.parse(review.results[0][0]);
                  scheduledFindingRead = JSON.parse(review.results[3][0]);
                  assertEquals(
                    JSON.parse(review.results[1][0]).current.evidenceId,
                    check.evidenceId,
                  );
                  scheduledResult = JSON.parse(review.results[2][0]).record;
                  assert(scheduledResult);
                  const { outcome, evidenceId, evidenceRevision } = JSON.parse(
                    review.results[2][0],
                  ).record;
                  assertEquals(outcome, "pass");
                  assertEquals(evidenceId, check.evidenceId);
                  assertEquals(evidenceRevision, state.revision);
                  assertEquals(
                    JSON.parse(review.results[2][1]).record,
                    scheduledResult,
                  );
                  for (const event of review.events) send(event);
                  return;
                }
              }
              send({
                type: "response",
                text: '{"summary":"Reviewed the assignment.","followUps":[]}',
                taint: "INTERNAL",
              });
            },
            clear() {},
          },
      undefined,
      () => clock,
    );
    const finishPlanning = async (state: State, count: number) => {
      for (let index = 0; index < 100; index++) {
        receiptPlanner!.advance(state);
        if (plannerTurns === count && !receiptPlanner!.hasInFlightWork()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assertEquals(
        plannerTurns,
        count,
        JSON.stringify(readAdaptiveSentinel(path, state)),
      );
      assert(!receiptPlanner!.hasInFlightWork());
    };
    await finishPlanning(state, 1);
    const passingBranchPayload = {
      ...branchPayload,
      protectedCount: 1,
      unprotectedCount: 0,
      approvedBranches: [{ name: "main", protected: true }],
    };
    const passingVisibilityPayload = {
      ...visibilityPayload,
      visibility: "private" as const,
    };
    const passingWorkflowPayload = {
      ...workflowPayload,
      runs: [{
        id: 2,
        status: "completed",
        conclusion: "success",
        created_at: "2025-01-03T00:00:00.000Z",
      }],
    };
    const passingPayload = workflow
      ? passingWorkflowPayload
      : visibility
      ? passingVisibilityPayload
      : passingBranchPayload;
    const passedSource = {
      ...source,
      ordinal: 2,
      receiptId: `execution-trace:${"d".repeat(64)}`,
      resultSha256: executionEvidenceDigest(passingPayload),
    };
    const passingNode = native
      ? "native-workflow-evidence:" + nativeSources[1].resultSha256
      : evidenceId(finding.runId, passedSource);
    const foreignPayload = workflow
      ? repeatedRun || olderRun
        ? {
          ...passingWorkflowPayload,
          runs: [{
            ...passingWorkflowPayload.runs[0],
            id: repeatedRun ? 1 : 3,
            ...(olderRun && { created_at: "2025-01-01T00:00:00.000Z" }),
          }],
        }
        : { ...passingWorkflowPayload, workflow: "23" }
      : visibility
      ? { ...passingVisibilityPayload, repositoryId: 43 }
      : { ...passingBranchPayload, repositoryId: 43 };
    const foreignSource = {
      ...passedSource,
      ordinal: 3,
      receiptId: `execution-trace:${"f".repeat(64)}`,
      resultSha256: executionEvidenceDigest(foreignPayload),
    };
    const foreignNode = native
      ? "native-workflow-evidence:" + nativeSources[2].resultSha256
      : evidenceId(finding.runId, foreignSource, true);
    const snapshot = state.result?.sharedGraph.snapshot;
    assert(snapshot);
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...snapshot,
        nodes: [
          ...snapshot.nodes,
          ...[
            { id: passingNode, source: passedSource, observedAt: passedAt },
            { id: foreignNode, source: foreignSource, observedAt: foreignAt },
          ].map(({ id, source, observedAt }, index) => ({
            id,
            kind: "evidence",
            label: `Passing ${family} receipt`,
            ...(native
              ? { nativeWorkflowSource: nativeSources[index + 1] }
              : { executionSource: source }),
            controlVerification: { outcome: "pass", observedAt, validUntil },
          })),
        ],
        edges: [
          ...snapshot.edges,
          {
            from: passingNode,
            to: "control",
            relation: "verifies",
          },
          { from: passingNode, to: "app", relation: "observed_on" },
          { from: foreignNode, to: "control", relation: "verifies" },
          { from: foreignNode, to: "app", relation: "observed_on" },
        ],
      }),
    );
    await Deno.writeTextFile(
      join(dirname(path), sentinelExecutionEvidenceFile),
      JSON.stringify([
        { ...source, recordedAt, classification: "INTERNAL", payload },
        {
          ...passedSource,
          recordedAt: passedAt,
          classification: "INTERNAL",
          payload: passingPayload,
        },
        {
          ...foreignSource,
          recordedAt: foreignAt,
          classification: "INTERNAL",
          payload: foreignPayload,
        },
      ]),
      { mode: 0o600 },
    );
    const updated = refreshSentinelAssessment(path);
    assert(updated && updated.revision > state.revision);
    receiptTargets = [passingNode, foreignNode];
    advanceAdaptiveSentinel(path, updated);
    if (manual) {
      await verifyOperatorNativeRecheck({
        baseDir,
        state: updated,
        findingId: finding.id,
        evidenceId: passingNode,
        digest: nativeSources[1].resultSha256,
      });
      return;
    }
    await finishPlanning(updated, 2);
    assertEquals(recheckCandidates, [[finding.id], undefined]);
    const handoff = readAdaptiveSentinel(path, updated)?.tasks.filter((
      task,
    ) => task.plannerRound?.recheckFindingId);
    assertEquals(
      handoff?.map((
        task,
      ) => [task.nodeId, task.plannerRound?.recheckFindingId]),
      [[passingNode, finding.id]],
    );
    assertEquals(workerFinding, finding.id);
    receiptPlanner.stop();
    if (native) {
      assert(handoff?.[0]);
      const taskId = handoff[0].id;
      assertEquals(
        readAdaptiveSentinel(path, updated)?.modelReviewStates.find(
          (worker) => worker.taskId === taskId,
        )?.status,
        "completed",
      );
      assert(scheduledResult);
      assert(scheduledRead);
      await verifyOperatorNativeRecheck({
        baseDir,
        state: updated,
        findingId: finding.id,
        evidenceId: passingNode,
        digest: nativeSources[1].resultSha256,
        trace: { taskId, result: scheduledRead },
      });
      await verifyOperatorNativeRecheck({
        baseDir,
        state: updated,
        findingId: finding.id,
        evidenceId: passingNode,
        digest: nativeSources[1].resultSha256,
        trace: { taskId, index: 4, result: scheduledFindingRead },
      });
      await withTidepool(baseDir, async (_list, _provenance, request) => {
        const lineage = await request("worker_recheck_lineage", {
          revision: updated.revision,
          taskId,
        });
        assertEquals(lineage.type, "sentinel_worker_recheck_lineage");
        assertEquals(lineage.finding, finding);
        assertEquals(lineage.rechecks, [scheduledResult]);
      });
      return;
    }
    const passingLease = assignedLease(
      path,
      updated,
      "review_evidence",
      passingNode,
    );
    const recheckArgs = {
      findingId: finding.id,
      evidenceId: passingNode,
      requestId: crypto.randomUUID(),
      summary: "Verified the newer passing receipt.",
    };
    const foreign = await workerTurn(
      path,
      assignedLease(path, updated, "review_evidence", foreignNode),
      [
        [tool("sentinel_assigned_execution_evidence", { node: foreignNode })],
        [
          tool(context, { findingId: finding.id }),
          tool(recheck, { ...recheckArgs, evidenceId: foreignNode }),
          tool(findings),
          tool(findings, { receiptId: finding.id }),
        ],
      ],
      undefined,
      baseDir,
      reader,
    );
    assertEquals(
      JSON.parse(foreign.results[0][0]).evidence.payload,
      foreignPayload,
    );
    assertStringIncludes(foreign.results[1][0], "unavailable");
    assertStringIncludes(foreign.results[1][1], "unavailable");
    assertEquals(JSON.parse(foreign.results[1][2]).records, []);
    assertStringIncludes(foreign.results[1][3], "unavailable");
    const verification = await workerTurn(
      path,
      passingLease,
      [
        [
          tool(context, { findingId: finding.id }),
          tool(recheck, recheckArgs),
          tool(findings),
        ],
        [tool("sentinel_assigned_execution_evidence", { node: passingNode })],
        [
          tool(findings),
          tool(context, { findingId: finding.id }),
          tool(findings, { receiptId: finding.id }),
        ],
        [
          tool(recheck, { ...recheckArgs, evidenceId: node }),
          tool(recheck, recheckArgs),
          tool(recheck, recheckArgs),
        ],
      ],
      undefined,
      baseDir,
      reader,
    );
    assertStringIncludes(verification.results[0][0], "unavailable");
    assertStringIncludes(
      verification.results[0][1],
      "Read the exact linked evidence",
    );
    assertEquals(JSON.parse(verification.results[0][2]).records, []);
    assertEquals(JSON.parse(verification.results[2][0]).records, [finding]);
    assertEquals(JSON.parse(verification.results[2][2]).record, finding);
    const read = JSON.parse(verification.results[2][1]);
    assertEquals(read.finding, finding);
    assertEquals(read.current.evidenceId, passingNode);
    assertStringIncludes(
      verification.results[3][0],
      "Read the exact linked evidence",
    );
    const saved = JSON.parse(verification.results[3][1]).record;
    assertEquals(saved.outcome, "pass");
    assertEquals(saved.findingId, finding.id);
    assertEquals(saved.evidenceId, passingNode);
    assertEquals(saved.evidenceRevision, updated.revision);
    assertEquals(JSON.parse(verification.results[3][2]).record, saved);
    await withTidepool(baseDir, async (list, provenance, request) => {
      assertEquals(await list(state.revision), [finding]);
      const history = (await provenance(updated.revision)).workerFindings;
      assertEquals(history.findings, [finding]);
      assertEquals(history.rechecks, [saved]);
      assert(handoff?.[0]);
      const bound = await request("worker_recheck_lineage", {
        revision: updated.revision,
        taskId: handoff[0].id,
      });
      assertEquals(bound.type, "sentinel_worker_recheck_lineage");
      assertEquals(bound.finding, finding);
      // The test's separate, unbound asset recheck must not appear in this assignment.
      assertEquals(bound.rechecks, []);
      const foreignScope = await request("worker_recheck_lineage", {
        revision: updated.revision,
        taskId: handoff[0].id,
        caseId: "other",
      });
      assertEquals(foreignScope.type, "error");
    });
  } finally {
    receiptPlanner?.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
}

for (
  const family of [
    "branch protection",
    "repository visibility",
    "workflow result",
    "workflow result with repeated run",
    "workflow result with older run",
    "native workflow result",
  ] as const
) {
  Deno.test(
    `Leased ${family} evidence reviews publish a failed check and recheck it from a newer receipt`,
    () => verifyReceiptFamily(family),
  );
}

Deno.test("Gateway operator discovers and queues one exact native remediation recheck", () =>
  verifyReceiptFamily("native workflow result", true));
