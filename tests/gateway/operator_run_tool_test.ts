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
        const traceSource = input.tool_name === "github_actions" ||
          (input.tool_call as { name?: string } | undefined)?.name ===
            "github_actions";
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
          assertEquals(payload, workflowPayload);
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
      assert(nextPeer && nextPeer.revision > peer.revision);
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
      const allResults = JSON.parse(
        (await turn({
          action: resultSearch.action,
          query: resultSearch.query,
        })).result,
      ).page;
      assertEquals(
        allResults.matches.map(({ runId }: { runId: string }) => runId),
        [
          scheduled.runId,
          scheduled.runId,
          interruptedScope.runId,
          traceScope.runId,
        ],
      );
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
