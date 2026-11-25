import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { readSentinelCaseHints } from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createOperatorWorkflowRuns } from "../../src/gateway/operator_workflow_runs.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  readSentinelAssessment,
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
    const hookRunner: HookRunner = {
      evaluateHook(hook, { session, input, auditInput }) {
        const runTool = input.tool_name === tool ||
          (input.tool_call as { name?: string } | undefined)?.name === tool;
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
      enableStreaming: false,
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir,
        workflows: adapter,
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
          { id: "peer-asset", kind: "asset", label: "Other case asset" },
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

      const started =
        JSON.parse((await turn({ action: "start", ...sentinel })).result).run;
      assertEquals(started.status, "running");
      sentinelRevision = started.ref.revision;
      assert(sentinelRevision);
      const exact = { ...sentinel, revision: sentinelRevision };
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
      assertEquals(
        JSON.parse((await turn({ action: "resume", ...exact })).result).run
          .status,
        "running",
      );

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
      const workflow = { kind: "workflow", id: activeRunId };
      const workflowView = JSON.parse(
        (await turn({ action: "inspect", ...workflow })).result,
      );
      assertEquals(workflowView.run.ref, workflow);
      assertEquals(workflowView.run.status, "completed");
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
