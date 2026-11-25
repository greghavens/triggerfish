import { buildSentinelProvenance } from "../../src/sentinel/provenance.ts";
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
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  readHistoricalAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  createSentinelSubagent,
  type SentinelReadTrace,
} from "../../src/gateway/sentinel_agent.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
  validateSentinelPlanSuggestions,
} from "../../src/sentinel/adaptive_planner.ts";
import {
  ensureSentinelFormalGoalContract,
  readSentinelGoalCompletionAtRevision,
  registerSentinelGoalCompletion,
} from "../../src/gateway/sentinel_goal_completion.ts";
import {
  digestSentinelGoalProposal,
  type SentinelFormalGoal,
} from "../../src/sentinel/formal_goals.ts";
import {
  openSentinelAdaptiveStore,
  sentinelAdaptiveTaskId,
} from "../../src/sentinel/adaptive_store.ts";
import {
  applySentinelFormalGoals,
  readSentinelAssessment,
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { listSentinelPlannerGraphFacts } from "../../src/sentinel/worker_graph_facts.ts";

const assigned = "sentinel_assigned_target";
const publish = "sentinel_publish_graph_fact";
const read = "sentinel_graph_facts";
const propose = "sentinel_propose_goal";
const observation = "sentinel_worker_observation";
const prove = "sentinel_prove_goal";
const call = (name: string, args: Record<string, unknown> = {}) => ({
  name,
  args,
});

async function ownerFacts(
  baseDir: string,
  run: (
    query: (input: Record<string, unknown>) => Promise<string>,
  ) => Promise<void>,
  approve: boolean | (() => boolean) = false,
) {
  const registry = createProviderRegistry();
  let result = "";
  let input: Record<string, unknown>;
  registry.register({
    name: "owner-fact-fixture",
    supportsStreaming: false,
    complete(messages) {
      const last = messages.at(-1);
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (last?.role === "tool") {
        result = String(last.content);
        return Promise.resolve({
          usage,
          content: "The fact lookup finished.",
          toolCalls: [],
        });
      }
      return Promise.resolve({
        usage,
        content: "",
        toolCalls: [{
          id: crypto.randomUUID(),
          type: "function",
          function: {
            name: "operator_runs",
            arguments: JSON.stringify({
              action: "facts",
              kind: "sentinel",
              ...input,
            }),
          },
        }],
      });
    },
  });
  registry.setDefault("owner-fact-fixture");
  const chatSession = createChatSession({
    session: createSession({
      userId: "owner" as UserId,
      channelId: "daemon" as ChannelId,
    }),
    providerRegistry: registry,
    operatorRunExecutor: createOperatorRunToolExecutor({
      baseDir,
      confirm: () =>
        Promise.resolve(typeof approve === "function" ? approve() : approve),
    }),
    hookRunner: {
      evaluateHook: () =>
        Promise.resolve({
          allowed: true,
          action: "ALLOW",
          ruleId: null,
          duration: 0,
        }),
    },
    enableStreaming: false,
  });
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({ port: 0, token, chatSession });
  const { port } = await gateway.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    await run(async (args) => {
      input = args;
      result = "";
      const ended = Promise.withResolvers<void>();
      const timer = setTimeout(
        () => ended.reject(new Error("Missing gateway turn end")),
        2000,
      );
      const receive = ({ data }: MessageEvent) => {
        if (JSON.parse(data).type === "turn_end") ended.resolve();
      };
      socket.addEventListener("message", receive);
      socket.send(
        JSON.stringify({
          type: "message",
          content: "Read the requested exact graph fact.",
        }),
      );
      try {
        await ended.promise;
        assert(result);
        return result;
      } finally {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
      }
    });
  } finally {
    if (socket.readyState < WebSocket.CLOSING) {
      const closed = new Promise<void>((resolve) =>
        socket.addEventListener("close", () => resolve(), { once: true })
      );
      socket.close();
      await closed;
    }
    await gateway.stop();
  }
}

type Lease = {
  readonly assessmentRevision: number;
  readonly assignedTaskId: string;
  readonly assignedTaskLeaseToken: string;
};

async function worker(
  snapshotPath: string,
  lease: Lease,
  batches: readonly (readonly ReturnType<typeof call>[])[],
  deny?: "publish" | "assigned" | "propose" | "prove" | "observation",
) {
  const results: string[][] = [];
  const trace: SentinelReadTrace[] = [];
  const hooks: string[] = [];
  const hookRunner: HookRunner = {
    evaluateHook(hook, { input, session, auditInput }) {
      const name = String(
        input.tool_name ??
          (input.tool_call as { name?: string } | undefined)?.name,
      );
      if (
        [assigned, publish, read, propose, prove, observation].includes(name)
      ) {
        assertEquals(session.taint, "INTERNAL");
        hooks.push(`${hook}:${name}`);
        if (hook === "POST_TOOL_RESPONSE") {
          assert(!Object.hasOwn(auditInput ?? {}, "tool_response"));
          if (
            name !== assigned && typeof input.tool_response === "string" &&
            input.tool_response.startsWith("{")
          ) {
            assertEquals(
              JSON.parse(input.tool_response)._classification,
              "INTERNAL",
            );
          }
        }
      }
      const allowed =
        !(hook === "PRE_TOOL_CALL" && name === propose && deny === "propose") &&
        !(hook === "PRE_TOOL_CALL" && name === prove && deny === "prove") &&
        !(hook === "PRE_TOOL_CALL" && name === publish && deny === "publish") &&
        !(hook === "POST_TOOL_RESPONSE" && name === observation &&
          deny === "observation") &&
        !(hook === "POST_TOOL_RESPONSE" && name === assigned &&
          deny === "assigned");
      return Promise.resolve({
        allowed,
        action: allowed ? "ALLOW" : "BLOCK",
        ruleId: null,
        duration: 0,
      });
    },
  };
  const providerRegistry = createProviderRegistry();
  let iteration = 0;
  providerRegistry.register({
    name: "graph-fact-fixture",
    supportsStreaming: false,
    complete(messages, tools) {
      for (const name of [assigned, publish, read]) {
        assert(
          tools?.some((tool) =>
            (tool as { function?: { name?: string } }).function?.name === name
          ),
        );
      }
      if (iteration > 0) {
        const size = batches[iteration - 1].length;
        results.push(
          messages.filter(({ role }) => role === "tool").slice(-size)
            .map(({ content }) => String(content)),
        );
      }
      const batch = batches[iteration++];
      return Promise.resolve({
        usage: { inputTokens: 1, outputTokens: 1 },
        content: batch
          ? ""
          : '{"summary":"Reviewed the published defensively scoped relationship.","followUps":[]}',
        toolCalls: batch?.map(({ name, args }, index) => ({
          id: `graph-fact-${iteration}-${index}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        })) ?? [],
      });
    },
  });
  providerRegistry.setDefault("graph-fact-fixture");
  const agent = createSentinelSubagent({
    snapshotPath,
    providerRegistry,
    hookRunner,
    allowModelAccess: true,
    ...lease,
  });
  try {
    await agent.execute(
      "Read and record the exact assigned relationship.",
      () => {},
      undefined,
      (step) => trace.push(step),
      true,
    );
    assertEquals(results.length, batches.length);
    return { results, trace, hooks };
  } finally {
    agent.clear();
  }
}

Deno.test("Only a post-authorized exact leased graph edge can be published and reopened by a same-target peer", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  const relationship = {
    from: "approved-record",
    to: "app",
    relation: "observed_on",
  };
  const foreign = {
    from: "foreign-record",
    to: "other-app",
    relation: "observed_on",
  };
  const raw = JSON.stringify({
    version: 1,
    nodes: [
      { id: "app", kind: "asset", label: "Assigned asset" },
      { id: "other-app", kind: "asset", label: "Different assignment asset" },
      { id: "approved-record", kind: "evidence", label: "Local record" },
      {
        id: "foreign-record",
        kind: "evidence",
        label: "Separate target record",
      },
    ],
    edges: [relationship, foreign],
  });
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, raw);
    const state = startSentinelAssessment(path);
    assert(state.plan.runId);
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    const assignedLease = (kind: "impact" | "trace", nodeId: string): Lease => {
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
    };
    try {
      store.sync(revision, [
        { kind: "impact", nodeId: "app", reason: MODEL_ASSIGNMENT_REASON },
        {
          kind: "trace",
          nodeId: "app",
          depth: 1,
          reason: MODEL_ASSIGNMENT_REASON,
        },
        {
          kind: "impact",
          nodeId: "other-app",
          reason: MODEL_ASSIGNMENT_REASON,
        },
      ], revision);
      advanceAdaptiveSentinel(path, state);
      const producer = assignedLease("impact", "app");
      const peer = assignedLease("trace", "app");
      const other = assignedLease("impact", "other-app");
      const args = { ...relationship, requestId: crypto.randomUUID() };
      const scope = {
        caseId: "main",
        runId: state.plan.runId,
        evidenceRevision: state.revision,
      };
      const registered = registerSentinelGoalCompletion(path, [{
        id: "verified-relationship",
        description: "Verify the exact committed relationship",
        source: "graph_fact",
        reference: JSON.stringify([
          relationship.from,
          relationship.relation,
          relationship.to,
        ]),
      }], "operator");
      assertEquals(registered.status, "open");
      const deniedRead = await worker(path, producer, [
        [call(assigned)],
        [call(publish, args)],
      ], "assigned");
      assertEquals(
        deniedRead.results[0][0],
        "Tool response withheld by policy.",
      );
      assertStringIncludes(deniedRead.results[1][0], "unavailable");
      assertEquals(listSentinelPlannerGraphFacts(path, scope), []);

      const deniedPublish = await worker(path, producer, [
        [call(assigned)],
        [call(publish, args)],
      ], "publish");
      assert(deniedPublish.hooks.includes(`PRE_TOOL_CALL:${publish}`));
      assert(!deniedPublish.hooks.includes(`POST_TOOL_RESPONSE:${publish}`));
      assertEquals(listSentinelPlannerGraphFacts(path, scope), []);

      const produced = await worker(path, producer, [
        [call(publish, args)],
        [call(assigned)],
        [
          call(publish, { ...foreign, requestId: crypto.randomUUID() }),
          call(publish, { ...args, from: "app", to: "approved-record" }),
          call(publish, args),
          call(publish, args),
        ],
      ]);
      assertStringIncludes(produced.results[0][0], "unavailable");
      assertEquals(JSON.parse(produced.results[1][0]).relationships, [
        relationship,
      ]);
      const [outside, forged, committed, duplicate] = produced.results[2];
      assertStringIncludes(outside, "unavailable");
      assertStringIncludes(forged, "unavailable");
      const { _classification, ...fact } = JSON.parse(committed);
      assertEquals(_classification, "INTERNAL");
      assertEquals(JSON.parse(duplicate), JSON.parse(committed));
      assertEquals(fact.relationship, relationship);
      assertEquals(fact.taskId, producer.assignedTaskId);
      assertEquals(fact.sourceTool, assigned);
      const source = produced.trace.at(fact.sourceStepIndex);
      assertEquals(source?.tool, assigned);
      assertEquals(source?.resultSha256, fact.resultSha256);
      assertEquals(listSentinelPlannerGraphFacts(path, scope), [fact]);
      assert(!store.modelReviewNotes(revision).length);

      const readByPeer = await worker(path, peer, [[
        call(read),
        call(read, { id: fact.id }),
      ]]);
      assertEquals(JSON.parse(readByPeer.results[0][0]).facts, [fact]);
      assertEquals(JSON.parse(readByPeer.results[0][1]), {
        _classification: "INTERNAL",
        ...fact,
      });
      const blockedPeer = await worker(path, other, [[
        call(read),
        call(read, { id: fact.id }),
      ]]);
      assertEquals(JSON.parse(blockedPeer.results[0][0]).facts, []);
      assertStringIncludes(blockedPeer.results[0][1], "unavailable");
      assertEquals(await Deno.readTextFile(path), raw);
      const observed = Promise.withResolvers<unknown>();
      const planner = createSentinelModelPlanner(path, (_case, assignment) => ({
        execute(prompt, send) {
          if (!assignment) {
            observed.resolve(
              JSON.parse(String(prompt).split("\n").at(-1)!).graphFacts,
            );
            send({
              type: "response",
              text: JSON.stringify({
                assignments: [
                  { kind: "trace", nodeId: "other-app", graphFactId: fact.id },
                  { kind: "trace", nodeId: "app", graphFactId: fact.id },
                ],
                prioritize: [],
                goalObservations: [{
                  criterionId: "verified-relationship",
                  evidence: [
                    {
                      source: "graph_fact",
                      reference: "worker-graph-fact:" + "0".repeat(64),
                      detail: "",
                    },
                    { source: "graph_fact", reference: fact.id, detail: "" },
                  ],
                }],
              }),
              taint: "INTERNAL",
            });
          }
          return Promise.resolve();
        },
        clear() {},
      }));
      try {
        planner.advance(state);
        const deadline = setTimeout(
          () =>
            observed.reject(
              new Error("Planner did not receive the committed graph fact"),
            ),
          2000,
        );
        try {
          assertEquals(await observed.promise, [{
            id: fact.id,
            targetId: "app",
            taskId: fact.taskId,
            relationship,
            resultSha256: fact.resultSha256,
          }]);
        } finally {
          clearTimeout(deadline);
        }
        assertEquals(
          store.modelPlanHistory(revision, true).at(-1)?.inputManifest
            ?.graphFactIds,
          [fact.id],
        );
        const expires = Date.now() + 2000;
        while (
          !store.list(revision).some((task) =>
            task.plannerRound?.graphFactId
          ) && Date.now() < expires
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const verifiedGoal = readSentinelGoalCompletionAtRevision(
          path,
          state.revision,
        );
        assertEquals(verifiedGoal?.status, "awaiting_confirmation");
        assertEquals(
          verifiedGoal?.observations[0].evidence.map(({ reference }) =>
            reference
          ),
          [fact.id],
        );
        const cited = store.list(revision).filter((task) =>
          task.plannerRound?.graphFactId
        );
        assertEquals(
          cited.map(({ nodeId, prerequisites, plannerRound }) => ({
            nodeId,
            prerequisites,
            factId: plannerRound?.graphFactId,
          })),
          [{
            nodeId: "app",
            prerequisites: [producer.assignedTaskId],
            factId: fact.id,
          }],
        );
        const historical = readHistoricalAdaptiveSentinel(path, state.revision);
        assert(historical);
        assertEquals(historical.modelPlanner?.status, "completed");
        const provenance = buildSentinelProvenance(state.result, historical)
          .snapshot();
        const factNode = provenance.nodes.find((node) =>
          node.sourceId === fact.id
        );
        assert(factNode && "graphFact" in factNode);
        const assignmentNode = provenance.nodes.find((node) =>
          node.sourceId === cited[0].id
        );
        assert(assignmentNode);
        assert(
          provenance.edges.some(({ from, to, relation }) =>
            from === assignmentNode.id && to === factNode.id &&
            relation === "references"
          ),
        );
      } finally {
        planner.stop();
      }
      const additional = await worker(path, other, [
        [call(assigned)],
        [call(publish, { ...foreign, requestId: crypto.randomUUID() })],
      ]);
      const laterFact = JSON.parse(additional.results[1][0]);
      assertEquals(laterFact.relationship, foreign);
      const otherCase = resolveSentinelCasePath(baseDir, "different-case");
      await Deno.mkdir(dirname(otherCase), { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(otherCase, raw);
      const different = startSentinelAssessment(otherCase);
      const latestGraph = { ...JSON.parse(raw), edges: [foreign] };
      await Deno.writeTextFile(path, JSON.stringify(latestGraph));
      const latest = refreshSentinelAssessment(path);
      assert(latest && latest.revision > state.revision);
      await ownerFacts(baseDir, async (query) => {
        const ref = { id: "main", revision: state.revision };
        const listed = JSON.parse(await query({ ...ref, limit: 1 }));
        assertEquals(listed.page.facts.map(({ id }: { id: string }) => id), [
          laterFact.id,
        ]);
        assert(!Object.hasOwn(listed.page.facts[0], "requestId"));
        const exact =
          JSON.parse(await query({ ...ref, factId: fact.id })).page.fact;
        assertEquals(exact.id, fact.id);
        assert(!Object.hasOwn(exact, "requestId"));
        for (
          const field of [
            "snapshotDigest",
            "resultSha256",
            "taskId",
            "targetId",
            "evidenceRevision",
            "sourceStepIndex",
            "relationship",
          ] as const
        ) {
          assertEquals(exact[field], fact[field]);
        }
        const newer = JSON.parse(
          await query({ id: "main", revision: latest.revision }),
        );
        assertEquals(newer.page.facts, []);
        assert(
          (await query({ ...ref, factId: fact.id, offset: 1 })).startsWith(
            "Error:",
          ),
        );
        for (
          const target of [
            { id: "different-case", revision: different.revision },
            { id: "main", revision: latest.revision },
          ]
        ) {
          const denied = await query({ ...target, factId: fact.id });
          assert(denied.startsWith("Error:"));
          assert(!denied.includes(fact.id));
        }
      });
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Leased worker proposals require assigned evidence and exact owner approval", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir, "goal-proposals");
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", kind: "asset", label: "Assigned asset" },
          { id: "approved-record", kind: "evidence", label: "Assigned record" },
          { id: "foreign-record", kind: "evidence", label: "Unlinked record" },
        ],
        edges: [{
          from: "approved-record",
          to: "app",
          relation: "observed_on",
        }],
      }),
    );
    const state = startSentinelAssessment(path);
    assert(state.plan.runId);
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      store.sync(revision, [{
        kind: "impact",
        nodeId: "app",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      advanceAdaptiveSentinel(path, state);
      const claim = store.claimModelReview(
        revision,
        MODEL_ASSIGNMENT_REASON,
        (task) => task.kind === "impact" && task.nodeId === "app",
      );
      assert(claim);
      const lease = {
        assessmentRevision: state.revision,
        assignedTaskId: claim.task.id,
        assignedTaskLeaseToken: claim.token,
      };
      const offer = {
        goalId: "verify-assigned",
        title: "Verify the assigned control",
        criterion: "Check the exact retained record",
        evidenceId: "approved-record",
        requestId: crypto.randomUUID(),
      };
      const blocked = await worker(path, lease, [[call(assigned)], [
        call(propose, offer),
      ]], "propose");
      assert(blocked.hooks.includes(`PRE_TOOL_CALL:${propose}`));
      assert(!blocked.hooks.includes(`POST_TOOL_RESPONSE:${propose}`));
      const response = await worker(path, lease, [
        [call(propose, offer)],
        [call(assigned)],
        [
          call(propose, { ...offer, evidenceId: "foreign-record" }),
          call(propose, offer),
          call(propose, offer),
        ],
      ]);
      assertStringIncludes(response.results[0][0], "exact evidence");
      assertStringIncludes(response.results[2][0], "exact evidence");
      const proposal = JSON.parse(response.results[2][1]).proposal;
      assertEquals(JSON.parse(response.results[2][2]).proposal, proposal);
      assertEquals(proposal.assignmentId, claim.task.id);
      assertEquals(proposal.targetId, "app");
      assertEquals(proposal.revision, state.revision);
      assertEquals(readSentinelAssessment(path)?.plan.formalGoals, undefined);
      const ref = {
        id: "goal-proposals",
        revision: state.revision,
        runId: state.plan.runId,
      };
      const list = { action: "goal_proposals", ...ref };
      const approve = {
        action: "approve_goal_proposal",
        ...ref,
        proposalId: proposal.id,
        requestId: crypto.randomUUID(),
      };
      await ownerFacts(baseDir, async (turn) => {
        const pending = JSON.parse(await turn(list)).proposals;
        assertEquals(pending, [{ ...proposal, acceptedRevision: null }]);
        assertStringIncludes(await turn(approve), "operator declined");
      });
      const originalGraph = await Deno.readTextFile(path);
      const newerGraph = JSON.parse(originalGraph);
      newerGraph.nodes.find(({ id }: { id: string }) =>
        id === "approved-record"
      ).label = "Changed retained record";
      await Deno.writeTextFile(path, JSON.stringify(newerGraph));
      await ownerFacts(baseDir, async (turn) => {
        assertStringIncludes(await turn(approve), "unavailable");
        assertEquals(readSentinelAssessment(path)?.revision, state.revision);
      }, true);
      await Deno.writeTextFile(path, originalGraph);
      await ownerFacts(baseDir, async (turn) => {
        const accepted = JSON.parse(await turn(approve)).receipt;
        assertEquals(accepted.appliedRevision, state.revision + 1);
        assertEquals(readSentinelAssessment(path)?.plan.formalGoals, [
          proposal.goal,
        ]);
      }, true);
      const updated = readSentinelAssessment(path);
      assert(updated?.active);
      const updatedRevision = adaptiveRevision(updated);
      store.sync(updatedRevision, [{
        kind: "impact",
        nodeId: "app",
        reason: MODEL_ASSIGNMENT_REASON,
      }], updatedRevision);
      advanceAdaptiveSentinel(path, updated);
      const proofClaim = store.claimModelReview(
        updatedRevision,
        MODEL_ASSIGNMENT_REASON,
        (task) => task.kind === "impact" && task.nodeId === "app",
      );
      assert(proofClaim);
      const proofLease = {
        assessmentRevision: updated.revision,
        assignedTaskId: proofClaim.task.id,
        assignedTaskLeaseToken: proofClaim.token,
      };
      const offeredProof = {
        goalId: proposal.goal.id,
        criterionId: "evidence",
        evidenceId: "approved-record",
      };
      const deniedProof = await worker(path, proofLease, [
        [call(assigned)],
        [call(prove, offeredProof)],
      ], "prove");
      assert(deniedProof.hooks.includes(`PRE_TOOL_CALL:${prove}`));
      assert(!deniedProof.hooks.includes(`POST_TOOL_RESPONSE:${prove}`));
      const proof = await worker(path, proofLease, [
        [call(prove, offeredProof)],
        [call(assigned)],
        [
          call(prove, { ...offeredProof, criterionId: "wrong" }),
          call(prove, offeredProof),
          call(prove, offeredProof),
        ],
      ]);
      assertStringIncludes(proof.results[0][0], "exact evidence");
      assertStringIncludes(proof.results[2][0], "unavailable");
      const receipt = JSON.parse(proof.results[2][1]);
      assertEquals(JSON.parse(proof.results[2][2]), receipt);
      assertEquals(receipt.status, "awaiting_confirmation");
      assertEquals(receipt.evidenceRevision, updated.revision);
      assertStringIncludes(receipt.proof.detail, proofClaim.task.id);
      const goalLookup = {
        action: "goals",
        id: ref.id,
        revision: updated.revision,
        goalId: proposal.goal.id,
        includeProof: true,
      };
      let completionRequest: Record<string, unknown> = {};
      await ownerFacts(baseDir, async (turn) => {
        assertEquals(JSON.parse(await turn(approve)).receipt.duplicate, true);
        assertEquals(
          JSON.parse(await turn(list)).proposals[0].acceptedRevision,
          state.revision + 1,
        );
        const savedProof = JSON.parse(await turn(goalLookup)).proof;
        completionRequest = {
          action: "confirm_goal_completion",
          id: ref.id,
          revision: updated.revision,
          runId: ref.runId,
          goalProofDigest: savedProof.digest,
        };
        assertStringIncludes(
          await turn({ ...completionRequest, goalProofDigest: "0".repeat(64) }),
          "unavailable",
        );
        assertStringIncludes(
          await turn(completionRequest),
          "operator declined",
        );
        assertEquals(savedProof.status, "awaiting_confirmation");
        assertEquals(savedProof.observations, [{
          criterionId: receipt.criterionId,
          evidence: [receipt.proof],
        }]);
        assertStringIncludes(
          await turn({ ...approve, requestId: crypto.randomUUID() }),
          "unavailable",
        );
      });
      await ownerFacts(baseDir, async (turn) => {
        assertStringIncludes(await turn(completionRequest), "unavailable");
        assert(readSentinelAssessment(path)?.active);
      }, () => {
        Deno.writeTextFileSync(path, JSON.stringify(newerGraph));
        return true;
      });
      await Deno.writeTextFile(path, originalGraph);
      let completion: unknown;
      await ownerFacts(baseDir, async (turn) => {
        completion = JSON.parse(await turn(completionRequest));
        assertEquals((completion as { status: string }).status, "completed");
        assertEquals(readSentinelAssessment(path)?.active, false);
      }, true);
      await ownerFacts(baseDir, async (turn) => {
        assertEquals(JSON.parse(await turn(completionRequest)), completion);
        const saved = JSON.parse(await turn(goalLookup)).proof;
        assertEquals(saved.status, "completed");
        assertEquals(saved.observations, [{
          criterionId: receipt.criterionId,
          evidence: [receipt.proof],
        }]);
      });
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Leased proof binds post-authorized same-target task results to formal criteria", async () => {
  const baseDir = await Deno.makeTempDir();
  const id = "task-proof";
  const path = resolveSentinelCasePath(baseDir, id);
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: ["app", "peer"].map((id) => ({ id, kind: "asset", label: id })),
        edges: [],
      }),
    );
    const initial = startSentinelAssessment(path, { goal: "Review controls" });
    const sources = ["app", "peer"].map((nodeId) => ({
      kind: "trace" as const,
      nodeId,
      depth: 1,
    }));
    const criteria = sources.map((task) => ({
      id: task.nodeId,
      description: "Review the committed control observation",
      source: "adaptive_task" as const,
      reference: `task:${task.kind}:${task.depth}:${task.nodeId}`,
    }));
    const goals: SentinelFormalGoal[] = [{
      id: "controls",
      title: "Verify controls",
      criteria,
      policy: "operator",
    }];
    const { state } = applySentinelFormalGoals(path, {
      mode: "append",
      requestId: crypto.randomUUID(),
      expectedRevision: initial.revision,
      expectedRunId: initial.plan.runId,
      proposalDigest: digestSentinelGoalProposal(goals),
      goals,
    });
    const revision = adaptiveRevision(state);
    ensureSentinelFormalGoalContract(path, state);
    advanceAdaptiveSentinel(path, state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      const wrongDepth = { ...sources[0], depth: 2 };
      const requested = validateSentinelPlanSuggestions(
        state,
        JSON.stringify([...sources, wrongDepth]),
      );
      assertEquals(requested?.map(({ depth }) => depth), [1, 1, 2]);
      assert(requested);
      store.sync(revision, [...requested, {
        kind: "impact",
        nodeId: "app",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      advanceAdaptiveSentinel(path, state);
      const claim = store.claimModelReview(
        revision,
        MODEL_ASSIGNMENT_REASON,
        (task) => task.nodeId === "app",
      );
      assert(claim);
      const lease = {
        assessmentRevision: state.revision,
        assignedTaskId: claim.task.id,
        assignedTaskLeaseToken: claim.token,
      };
      const [own, peer] = sources.map((task) =>
        sentinelAdaptiveTaskId(revision, task)
      );
      const wrong = sentinelAdaptiveTaskId(revision, wrongDepth);
      const open = (task: string) => call(observation, { task });
      const proof = (criterionId: string, evidenceId: string) =>
        call(prove, {
          goalId: "controls",
          criterionId,
          evidenceId,
          source: "adaptive_task",
        });
      const denied = await worker(path, lease, [[open(own)], [
        proof("app", own),
      ]], "observation");
      assert(denied.hooks.includes(`POST_TOOL_RESPONSE:${observation}`));
      assertStringIncludes(denied.results[1][0], "exact evidence");
      const actual = await worker(path, lease, [
        [open(own), open(peer), open(wrong)],
        [proof("app", wrong), proof("app", own), proof("peer", peer)],
      ]);
      const opened = JSON.parse(actual.results[0][0]);
      assertStringIncludes(actual.results[1][0], "unavailable");
      const receipt = JSON.parse(actual.results[1][1]);
      assertEquals(receipt.proof.reference, own);
      assertStringIncludes(receipt.proof.detail, opened.observationSha256);
      assertEquals(JSON.parse(actual.results[0][1]).task, peer);
      assertStringIncludes(actual.results[1][2], "unavailable");
      await ownerFacts(baseDir, async (turn) => {
        const saved = JSON.parse(
          await turn({
            action: "goals",
            id,
            revision: state.revision,
            goalId: "controls",
            includeProof: true,
          }),
        ).proof;
        assertEquals(saved.status, "open");
        assertEquals(saved.observations, [{
          criterionId: receipt.criterionId,
          evidence: [receipt.proof],
        }]);
      });
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
