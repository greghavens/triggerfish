import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { dirname, join } from "@std/path";
import { createOperatorWorkflowRuns } from "../../src/gateway/operator_workflow_runs.ts";
import { createWorkflowObservationVerifier } from "../../src/gateway/scheduled_observation_tool.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { createWorkflowRunRegistry } from "../../src/workflow/registry.ts";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import { createHookRunner } from "../../src/core/policy/hooks/hooks.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { subscribeCommittedEvidence } from "../../src/core/evidence_task_progression.ts";
import { executeAssessmentTemplates } from "../../src/gateway/sentinel_assessment_templates.ts";
import { openOperatorRunLinkStore } from "../../src/core/operator_runs.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createSentinelSubagent } from "../../src/gateway/sentinel_agent.ts";
import { readSentinelGoalCompletion } from "../../src/gateway/sentinel_goal_completion.ts";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { startSentinelAssessmentCoordinator } from "../../src/gateway/sentinel_assessment_service.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  readSentinelAssessment,
  readSentinelAssessmentRevision,
  readSentinelOperatingConstraintsForRevision,
} from "../../src/sentinel/assessment_store.ts";
import type { SentinelFormalGoal } from "../../src/sentinel/formal_goals.ts";

function goal(id: string, reference: string): SentinelFormalGoal {
  return {
    id,
    title: `Check ${id} evidence`,
    policy: "operator",
    criteria: [{
      id: "record",
      description: "Verify the exact published record.",
      source: "graph_evidence",
      reference,
    }],
  };
}

async function until(check: () => boolean, maxAttempts = 100) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(check(), "Sentinel assessment did not reach the expected state");
}

Deno.test("authenticated Sentinel chat drafts, approves and extends independently evidenced goals", async () => {
  const directory = await Deno.makeTempDir();
  const mainPath = join(directory, "sentinel.json");
  const path = resolveSentinelCasePath(directory, "local-service");
  const caseDirectory = dirname(path);
  const draft = [
    goal("inventory", "draft-placeholder"),
    goal("coverage", "proof-b"),
  ];
  const objective = "Verify the published records for the local service";
  const description =
    "Review only the published service asset and exclude tracing.";
  const proposedConstraints = {
    deniedKinds: ["trace"],
    allowedAssetIds: ["service-asset"],
  };
  const approvedConstraints = {
    deniedKinds: ["impact"],
    allowedAssetIds: ["service-asset"],
  };
  const approved = draft.map((item, index): SentinelFormalGoal => ({
    ...item,
    title: index === 0 ? "Validate the approved service inventory" : item.title,
    policy: "automatic",
    criteria: index === 0
      ? [{ ...item.criteria[0], reference: "proof-a" }]
      : item.criteria,
  }));
  const additional = {
    ...goal("followup", "proof-c"),
    policy: "automatic",
  } as const;
  const draftPrompts: string[] = [];
  const rounds: { revision: number; goalIds: string[]; criteria: string[] }[] =
    [];
  const errors: unknown[] = [];
  const reviewedModelGoalRequests: string[] = [];
  const withdrawalReviews: string[] = [];
  let denyModelGoal = false;
  let revokeModelGoalOnConfirmation = false;
  let sawClassifiedModelGoalResult = false;

  async function withGateway(
    run: (
      turn: (content: string) => Promise<string>,
      tick: () => Promise<void>,
      operator: (args: Record<string, unknown>) => Promise<string>,
    ) => Promise<void>,
  ) {
    const registry = createProviderRegistry();
    let nextOperatorCall: Record<string, unknown> | undefined;
    let showOperatorResult = false;
    let operatorResult = "";
    registry.register({
      name: "fixture",
      supportsStreaming: false,
      complete(messages, tools) {
        const usage = { inputTokens: 1, outputTokens: 1 };
        if (nextOperatorCall) {
          const definitions = tools as {
            function?: {
              name?: string;
              parameters?: { properties?: { action?: { enum?: string[] } } };
            };
          }[];
          const operator = definitions.find((tool) =>
            tool.function?.name === "operator_runs"
          );
          const actions = operator?.function?.parameters?.properties?.action
            ?.enum;
          assert(actions);
          const args = nextOperatorCall;
          if (args.action === "list") {
            assert(actions.includes("list"));
          } else {
            assert(actions.includes("append_goals"));
            assert(!actions.includes("revise_goals"));
          }
          nextOperatorCall = undefined;
          showOperatorResult = true;
          return Promise.resolve({
            content: "",
            toolCalls: [{
              id: crypto.randomUUID(),
              type: "function",
              function: {
                name: "operator_runs",
                arguments: JSON.stringify(args),
              },
            }],
            usage,
          });
        }
        if (showOperatorResult) {
          const reply = messages.findLast(({ role }) => role === "tool");
          if (reply) operatorResult = String(reply.content);
          return Promise.resolve({
            content: "Reviewed the selected case request.",
            toolCalls: [],
            usage,
          });
        }
        draftPrompts.push(JSON.stringify(messages));
        return Promise.resolve({
          content: JSON.stringify({
            goals: draft,
            initialConstraints: proposedConstraints,
          }),
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      },
    });
    registry.setDefault("fixture");

    const planner = createSentinelModelPlanner(
      path,
      (state, taskId) => ({
        execute(content, send) {
          if (taskId) {
            send({
              type: "response",
              text: "Reviewed saved evidence.",
              taint: "INTERNAL",
            });
            return Promise.resolve();
          }
          assert(typeof content === "string");
          const input = JSON.parse(content.split("\n").at(-1)!);
          if (!input.goalCompletion) {
            send({ type: "response", text: "[]", taint: "INTERNAL" });
            return Promise.resolve();
          }
          assertEquals(input.goal, objective);
          assertEquals(input.goalCompletion.policy, "automatic");
          const criteria = input.goalCompletion.criteria.map(
            (item: { id: string; requirement: string }) => {
              const [source, reference] = JSON.parse(item.requirement);
              return {
                criterionId: item.id,
                evidence: [{
                  source,
                  reference,
                  detail: "Found exact published record.",
                }],
              };
            },
          );
          const goals: Pick<SentinelFormalGoal, "id" | "title" | "policy">[] =
            input.goalCompletion.formalGoals;
          rounds.push({
            revision: state.revision,
            goalIds: goals.map(({ id }) => id),
            criteria: criteria.map(({ criterionId, evidence }: {
              criterionId: string;
              evidence: { reference: string }[];
            }) => `${criterionId}=${evidence[0].reference}`),
          });
          if (state.revision === 1) {
            assertEquals(input.operatingConstraints.version, 1);
            assertEquals(
              input.operatingConstraints.restrictions,
              approvedConstraints,
            );
            assertEquals(
              goals,
              approved.map(({ id, title, policy }) => ({ id, title, policy })),
            );
          }
          send({
            type: "response",
            text: JSON.stringify({
              assignments: [],
              prioritize: [],
              goalObservations: criteria,
            }),
            taint: "INTERNAL",
          });
          return Promise.resolve();
        },
        clear() {},
      }),
      undefined,
      () => 100_000,
    );

    const normalHooks = createHookRunner(createPolicyEngine());
    const chatSession = createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "test" as ChannelId,
      }),
      providerRegistry: registry,
      hookRunner: {
        ...normalHooks,
        evaluateHook(hook, context) {
          const call = context.input.tool_call as {
            name?: string;
            args?: Record<string, unknown>;
          } | undefined;
          if (
            hook === "PRE_TOOL_CALL" && call?.name === "operator_runs" &&
            (call.args?.action === "append_goals" ||
              call.args?.action === "withdraw_goal") &&
            denyModelGoal
          ) {
            return Promise.resolve({
              allowed: false,
              action: "BLOCK",
              ruleId: null,
              duration: 0,
            });
          }
          if (
            hook === "POST_TOOL_RESPONSE" &&
            context.input.tool_name === "operator_runs" &&
            typeof context.input.tool_response === "string" &&
            context.input.tool_response.includes('"receipt"')
          ) {
            assertEquals(context.session.taint, "INTERNAL");
            sawClassifiedModelGoalResult = true;
          }
          return normalHooks.evaluateHook(hook, context);
        },
      },
      sentinelSnapshotPath: mainPath,
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir: directory,
        confirm(message) {
          if (message.startsWith("Withdraw this exact Sentinel formal goal?")) {
            withdrawalReviews.push(message);
            if (revokeModelGoalOnConfirmation) denyModelGoal = true;
            return Promise.resolve(true);
          }
          assertMatch(
            message,
            /^Approve (these exact Sentinel formal goal definitions|this replacement for an exact completed Sentinel goal)/,
          );
          reviewedModelGoalRequests.push(message);
          if (revokeModelGoalOnConfirmation) denyModelGoal = true;
          return Promise.resolve(true);
        },
      }),
      resolveSentinelChatCase: (id) =>
        id === "local-service" ? path : undefined,
      allowSentinelModelAccess: true,
      enableStreaming: false,
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
      const turn = (content: string) => {
        const done = Promise.withResolvers<string>();
        let response = "";
        let error: string | undefined;
        const timer = setTimeout(
          () => done.reject(new Error("No turn_end")),
          3000,
        );
        function receive({ data }: MessageEvent) {
          const event = JSON.parse(data);
          if (event.type === "response") response = event.text;
          if (event.type === "error") error = event.message;
          if (event.type === "turn_end") {
            if (error) done.reject(new Error(error));
            else done.resolve(response);
          }
        }
        socket.addEventListener("message", receive);
        socket.send(JSON.stringify({ type: "message", content }));
        return done.promise.finally(() => {
          clearTimeout(timer);
          socket.removeEventListener("message", receive);
        });
      };
      const tick = async () => {
        const coordinator = startSentinelAssessmentCoordinator({
          snapshotPath: path,
          advanceAdaptive(state) {
            advanceAdaptiveSentinel(path, state);
            planner.advance(state);
          },
          stopAdaptive: () => planner.stop(),
          onError: (error) => errors.push(error),
        });
        try {
          await Promise.resolve();
          await until(() => !planner.hasInFlightWork());
        } finally {
          coordinator.stop();
        }
        assertEquals(errors, []);
      };
      await turn("/sentinel on");
      assertMatch(await turn("/sentinel case local-service"), /local-service/);
      await run(turn, tick, async (args) => {
        nextOperatorCall = args;
        operatorResult = "";
        await turn("Register the formal goal through the selected case.");
        showOperatorResult = false;
        return operatorResult;
      });
    } finally {
      planner.stop();
      socket.close();
      await server.stop();
    }
  }

  try {
    await Deno.mkdir(caseDirectory, { recursive: true });
    await Deno.writeTextFile(
      mainPath,
      JSON.stringify({
        version: 1,
        nodes: [{
          id: "unassigned-main-proof",
          kind: "evidence",
          label: "Main case evidence",
        }],
        edges: [],
      }),
    );
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "service-asset", kind: "asset", label: "Published service" },
          ...["proof-a", "proof-b", "proof-c"].map((id) => ({
            id,
            kind: "evidence",
            label: `Published ${id}`,
          })),
        ],
        edges: ["proof-a", "proof-b", "proof-c"].map((id) => ({
          from: id,
          to: "service-asset",
          relation: "observed_on",
        })),
      }),
    );
    const status = "assessment goals status";
    const evidence = (revision: number) =>
      `assessment goals evidence ${revision}`;
    const start = `assessment goals start ${
      JSON.stringify({
        objective,
        requestId: "approved-start",
        goals: approved,
        initialConstraints: approvedConstraints,
      })
    }`;

    let initialRevision = 0;
    let finalRevision = 0;
    let runId = "";
    let initialEvidence: unknown;
    let finalEvidence: unknown;
    let add = "";
    let revise = "";
    let modelAppend: Record<string, unknown> | undefined;
    let modelRevision = 0;
    let withdrawalRevision = 0;
    let pausedWithdrawal: Record<string, unknown> | undefined;
    await withGateway(async (turn, tick, operator) => {
      const proposal = JSON.parse(
        await turn(
          `assessment goals propose ${
            JSON.stringify({ objective, description })
          }`,
        ),
      );
      assertEquals(proposal.goals, draft);
      assertEquals(proposal.initialConstraints, proposedConstraints);
      assertMatch(draftPrompts[0], /proof-a/);
      assert(!draftPrompts[0].includes("unassigned-main-proof"));
      assert(draftPrompts[0].includes(description));
      assertEquals(readSentinelAssessment(path), undefined);
      const invalid = `assessment goals start ${
        JSON.stringify({
          objective,
          requestId: "approved-start",
          goals: approved,
          initialConstraints: {
            deniedKinds: [],
            allowedAssetIds: ["foreign-asset"],
          },
        })
      }`;
      await assertRejects(
        () => turn(invalid),
        Error,
        "require published case assets",
      );
      assertEquals(readSentinelAssessment(path), undefined);
      assertEquals(rounds, []);
      const starting = JSON.parse(await turn(start));
      assertEquals(starting.activeFormalGoalIds, ["inventory", "coverage"]);
      assertEquals(starting.formalGoals, approved);
      assertEquals(starting.duplicate, false);
      initialRevision = starting.appliedRevision;
      assertEquals(starting.initialOperatingConstraints.version, 1);
      assertEquals(
        starting.initialOperatingConstraints.constraints,
        approvedConstraints,
      );
      assertEquals(
        readSentinelOperatingConstraintsForRevision(path, initialRevision),
        starting.initialOperatingConstraints,
      );
      await assertRejects(() => turn(invalid), Error, "already used");
      const replay = JSON.parse(await turn(start));
      assertEquals(replay.duplicate, true);
      assertEquals(
        replay.initialOperatingConstraints,
        starting.initialOperatingConstraints,
      );
      const exactRunId = readSentinelAssessment(path)?.plan.runId;
      assert(exactRunId);
      const watched = {
        case: "local-service",
        run_id: exactRunId,
        revision: initialRevision,
        goal_id: "inventory",
      };
      const verifier = createWorkflowObservationVerifier(directory);
      assertEquals(await verifier(watched), undefined);
      const localPlan = {
        id: "record-goal-check",
        classification: "INTERNAL" as const,
        steps: [
          { id: "verified-goal", satisfiedBy: watched, evidenceWaitSeconds: 5 },
          { id: "record" },
        ],
      };
      const workflowPath = join(directory, "operator-workflow-runs.db");
      const workflows = createOperatorWorkflowRuns(
        createWorkflowRunRegistry(),
        [localPlan],
        workflowPath,
        verifier,
      );
      const admitted = workflows.start(localPlan.id);
      assert(admitted);
      await until(() =>
        workflows.traces(admitted.runId, "INTERNAL")?.events.some(({ event }) =>
          event === "step_waiting"
        ) === true
      );
      assertEquals(
        workflows.inspect(admitted.runId)?.steps[1].status,
        "pending",
      );
      await turn("/sentinel off");
      const listProgress = {
        action: "list",
        kind: "sentinel",
        includeProgress: true,
      };
      const findProgress = (reply: string) =>
        JSON.parse(reply).runs.find(({ ref }: { ref: { id: string } }) =>
          ref.id === "local-service"
        )?.details.progress;
      assertEquals(findProgress(await operator(listProgress)), {
        goalsTotal: 2,
        goalsMet: 0,
        inFlight: 0,
      });
      await tick();
      assertEquals(findProgress(await operator(listProgress)), {
        goalsTotal: 2,
        goalsMet: 2,
        inFlight: 0,
      });
      await turn("/sentinel on");
      await turn("/sentinel case local-service");
      const first = JSON.parse(await turn(status));
      assertEquals(first.active, false, JSON.stringify({ first, rounds }));
      assertEquals(first.completedFormalGoalIds, ["inventory", "coverage"]);
      runId = first.runId;
      assert(runId);
      initialEvidence = JSON.parse(await turn(evidence(initialRevision)));
      assertEquals(initialEvidence, first.completion);
      assertEquals(first.completion.status, "completed");
      const receipt = await verifier(watched);
      assert(receipt && "goalId" in receipt);
      await until(
        () => workflows.inspect(admitted.runId)?.status === "completed",
        400,
      );
      const reopened = createOperatorWorkflowRuns(
        createWorkflowRunRegistry(),
        [localPlan],
        workflowPath,
        verifier,
      );
      const settled = reopened.traces(admitted.runId, "INTERNAL")?.events.find((
        { event },
      ) => event === "step_satisfied");
      assert(settled && "evidence" in settled);
      assertEquals(settled.evidence, receipt);
      assertEquals(receipt.goalId, watched.goal_id);
      assertEquals(receipt.revision, initialRevision);
      assertEquals(
        await verifier({ ...watched, goal_id: "missing" }),
        undefined,
      );

      assertEquals(
        first.completion.observations.map((
          { criterionId }: { criterionId: string },
        ) => criterionId).sort(),
        ["coverage/record", "inventory/record"],
      );

      add = `assessment goals add ${
        JSON.stringify({
          requestId: "approved-append",
          goal: additional,
          expectedRevision: initialRevision,
          expectedRunId: runId,
        })
      }`;
      const appended = JSON.parse(await turn(add));
      assertEquals(await verifier(watched), undefined);
      assertEquals(appended.active, true);
      assertEquals(appended.activeFormalGoalIds, ["followup"]);
      assertEquals(appended.appliedRevision, initialRevision + 1);
      finalRevision = appended.appliedRevision;
      assertEquals(JSON.parse(await turn(add)).duplicate, true);
      assertEquals(
        JSON.parse(await turn(evidence(initialRevision))),
        initialEvidence,
      );
      const revisedGoal = {
        ...additional,
        title: "Confirm the revised follow-up scope",
        criteria: additional.criteria.map((criterion) => ({
          ...criterion,
          reference: "proof-b",
        })),
      };
      const change = {
        requestId: "approved-revision",
        goal: revisedGoal,
        expectedRevision: appended.appliedRevision,
        expectedRunId: runId,
      };
      const reviseCommand = (input: Record<string, unknown>) =>
        `assessment goals revise ${JSON.stringify(input)}`;
      await assertRejects(
        () =>
          turn(reviseCommand({
            ...change,
            goal: approved[0],
          })),
        Error,
        "existing active goals",
      );
      await assertRejects(
        () =>
          turn(reviseCommand({
            ...change,
            expectedRevision: initialRevision,
          })),
        Error,
        "assessment changed",
      );
      revise = reviseCommand(change);
      const revised = JSON.parse(await turn(revise));
      assertEquals(revised.appliedRevision, appended.appliedRevision + 1);
      assertEquals(revised.activeFormalGoalIds, ["followup"]);
      assertEquals(revised.formalGoals, [...approved, revisedGoal]);
      assertEquals(
        readSentinelAssessmentRevision(path, appended.appliedRevision)?.plan
          ?.formalGoals,
        [...approved, additional],
      );
      assertEquals(JSON.parse(await turn(revise)).duplicate, true);
      finalRevision = revised.appliedRevision;
      await tick();
      const final = JSON.parse(await turn(status));
      assertEquals(final.active, false, JSON.stringify({ final, rounds }));
      assertEquals(final.runId, runId);
      assertEquals(final.completedFormalGoalIds, [
        "inventory",
        "coverage",
        "followup",
      ]);
      finalEvidence = JSON.parse(await turn(evidence(finalRevision)));
      assertEquals(finalEvidence, final.completion);
      assertEquals(
        final.completion.observations.map((
          { criterionId }: { criterionId: string },
        ) => criterionId),
        ["followup/record"],
      );
    });

    await withGateway(async (turn, tick, operator) => {
      assertEquals(JSON.parse(await turn(add)).duplicate, true);
      assertEquals(JSON.parse(await turn(revise)).duplicate, true);
      const changed = add.replace("proof-c", "proof-b");
      await assertRejects(() => turn(changed), Error, "request ID");
      const restored = JSON.parse(await turn(status));
      assertEquals(restored.runId, runId);
      assertEquals(restored.revision, finalRevision);
      assertEquals(restored.active, false);
      assertEquals(
        JSON.parse(await turn(evidence(initialRevision))),
        initialEvidence,
      );
      assertEquals(
        JSON.parse(await turn(evidence(finalRevision))),
        finalEvidence,
      );
      await tick();

      modelAppend = {
        action: "append_goals",
        kind: "sentinel",
        id: "local-service",
        revision: finalRevision,
        runId,
        requestId: crypto.randomUUID(),
        supersedes: { goalId: "inventory", evidenceRevision: initialRevision },
        goals: [{ ...additional, id: "model-followup" }],
      };
      assertMatch(
        await operator({ ...modelAppend, id: "main" }),
        /unavailable/,
      );
      assertEquals(reviewedModelGoalRequests.length, 0);
      assertMatch(
        await operator({
          ...modelAppend,
          supersedes: { goalId: "inventory", evidenceRevision: finalRevision },
        }),
        /unavailable/,
      );
      assertEquals(reviewedModelGoalRequests.length, 0);
      denyModelGoal = true;
      await operator(modelAppend);
      assertEquals(reviewedModelGoalRequests.length, 0);
      denyModelGoal = false;
      revokeModelGoalOnConfirmation = true;
      assertMatch(await operator(modelAppend), /unavailable/);
      assertEquals(readSentinelAssessment(path)?.revision, finalRevision);
      denyModelGoal = false;
      revokeModelGoalOnConfirmation = false;
      const wakes: { observation_id: string }[] = [];
      const unsubscribe = subscribeCommittedEvidence(
        "local-service",
        (address) => {
          if (
            address.observation_id.startsWith("formal-goal-supersession:")
          ) wakes.push(address);
        },
      );
      const applied = JSON.parse(await operator(modelAppend));
      unsubscribe();
      assertEquals(wakes.map(({ observation_id }) => observation_id), [
        `formal-goal-supersession:${modelAppend.requestId}`,
      ]);
      assert(applied.receipt, JSON.stringify(applied));
      assertEquals(applied.receipt.duplicate, false);
      assertEquals(reviewedModelGoalRequests.length, 2);
      assert(sawClassifiedModelGoalResult);
      modelRevision = applied.receipt.appliedRevision;
      assertEquals(modelRevision, finalRevision + 1);
      const reopened = JSON.parse(await turn(status));
      assertEquals(reopened.active, true);
      assertEquals(reopened.activeFormalGoalIds, ["model-followup"]);
      const [lineage] = reopened.goalSupersessions;
      assertEquals(lineage.goalId, "inventory");
      assertEquals(lineage.replacementGoalId, "model-followup");
      assertEquals(lineage.evidenceRevision, initialRevision);
      assertEquals(lineage.requestId, modelAppend.requestId);
      assertMatch(lineage.completionSha256, /^[a-f0-9]{64}$/);
      assertEquals(
        reopened.formalGoals.find(({ id }: { id: string }) =>
          id === "inventory"
        ),
        approved[0],
      );
      assertEquals(readSentinelGoalCompletion(path)?.observations, []);

      assertEquals(
        reopened.completedFormalGoalIds,
        restored.completedFormalGoalIds,
      );
      assertEquals(
        JSON.parse(await turn(evidence(finalRevision))),
        finalEvidence,
      );
      await tick();
      const verified = JSON.parse(await turn(status));
      assertEquals(verified.active, false);
      assertEquals(verified.completedFormalGoalIds, [
        ...restored.completedFormalGoalIds,
        "model-followup",
      ]);
    });
    await withGateway(async (turn, tick, operator) => {
      assert(modelAppend);
      const replay = JSON.parse(await operator(modelAppend));
      assertEquals(replay.receipt.appliedRevision, modelRevision);
      assertEquals(reviewedModelGoalRequests.length, 2);
      const [supersession] = JSON.parse(await turn(status)).goalSupersessions;
      assertEquals(supersession.goalId, "inventory");
      assertEquals(supersession.evidenceRevision, initialRevision);
      assertMatch(
        await operator({
          ...modelAppend,
          goals: [{ ...additional, id: "changed" }],
        }),
        /unavailable/,
      );
      assertEquals(
        JSON.parse(await turn(evidence(finalRevision))),
        finalEvidence,
      );
      await tick();
      const goalRequest = {
        action: "append_goals",
        kind: "sentinel",
        id: "local-service",
        revision: modelRevision,
        runId,
        requestId: crypto.randomUUID(),
        goals: [{ ...additional, id: "keep-goal" }, {
          ...additional,
          id: "withdraw-goal",
        }],
      };
      const reopened = JSON.parse(await operator(goalRequest));
      const discard = {
        action: "withdraw_goal",
        kind: "sentinel",
        id: "local-service",
        revision: reopened.receipt.appliedRevision,
        runId,
        requestId: crypto.randomUUID(),
        goalId: "withdraw-goal",
      };
      assertMatch(
        await operator({ ...discard, revision: modelRevision }),
        /unavailable/,
      );
      assertMatch(
        await operator({ ...discard, goalId: "inventory" }),
        /unavailable/,
      );
      assertEquals(withdrawalReviews, []);
      const observed: string[] = [];
      const unsubscribe = subscribeCommittedEvidence(
        "local-service",
        (entry) => {
          observed.push(entry.observation_id);
        },
      );
      try {
        const previous = readSentinelAssessment(path);
        revokeModelGoalOnConfirmation = true;
        assertMatch(await operator(discard), /unavailable/);
        assertEquals(readSentinelAssessment(path), previous);
        assertEquals(observed, []);
        denyModelGoal = false;
        revokeModelGoalOnConfirmation = false;
        const withdrawn = JSON.parse(await operator(discard));
        assertEquals(withdrawn.withdrawnGoalId, discard.goalId);
        withdrawalRevision = withdrawn.receipt.appliedRevision;
        assertEquals(withdrawalRevision, discard.revision + 1);
        assertEquals(readSentinelAssessment(path)?.result, previous?.result);
        assertEquals(
          JSON.parse(await operator(discard)).receipt.duplicate,
          true,
        );
        assertMatch(
          await operator({ ...discard, goalId: "keep-goal" }),
          /unavailable/,
        );
        assertEquals(observed, [`formal-goal-withdrawal:${discard.requestId}`]);
        assertEquals(withdrawalReviews.length, 2);
      } finally {
        unsubscribe();
      }
      await tick();
      const remaining = JSON.parse(await turn(status));
      assertEquals(remaining.active, false);
      assert(remaining.completedFormalGoalIds.includes("keep-goal"));
      assert(!remaining.completedFormalGoalIds.includes("withdraw-goal"));
      assertEquals(remaining.withdrawnFormalGoalIds, ["withdraw-goal"]);
      assertEquals(
        remaining.formalGoals.find(({ id }: { id: string }) =>
          id === "withdraw-goal"
        ),
        goalRequest.goals[1],
      );
      assertEquals(
        JSON.parse(await turn(evidence(finalRevision))),
        finalEvidence,
      );

      const finalOpen = JSON.parse(
        await operator({
          ...goalRequest,
          revision: withdrawalRevision,
          requestId: crypto.randomUUID(),
          goals: [{ ...additional, id: "paused-withdrawal" }],
        }),
      );
      await turn("assessment pause");
      pausedWithdrawal = {
        ...discard,
        revision: finalOpen.receipt.appliedRevision,
        requestId: crypto.randomUUID(),
        goalId: "paused-withdrawal",
      };
      assertEquals(
        JSON.parse(await operator(pausedWithdrawal)).receipt.duplicate,
        false,
      );
      const paused = JSON.parse(await turn(status));
      assertEquals(paused.paused, true);
      assertEquals(paused.activeFormalGoalIds, []);
      assertEquals(paused.completion, null);
    });
    await withGateway(async (turn, tick, operator) => {
      assert(pausedWithdrawal);
      assertEquals(
        JSON.parse(await operator(pausedWithdrawal)).receipt.duplicate,
        true,
      );
      assertEquals(withdrawalReviews.length, 3);
      assertEquals(JSON.parse(await turn(status)).paused, true);
      await turn("assessment resume");
      await tick();
      const pending = JSON.parse(await turn(status));
      assertEquals(pending.active, true);
      assertEquals(pending.completion, null);
      assertEquals(
        JSON.parse(await turn(evidence(finalRevision))),
        finalEvidence,
      );
    });
    assertEquals(draftPrompts.length, 1);
    assertEquals(rounds, [
      {
        revision: initialRevision,
        goalIds: ["inventory", "coverage"],
        criteria: ["inventory/record=proof-a", "coverage/record=proof-b"],
      },
      {
        revision: finalRevision,
        goalIds: ["followup"],
        criteria: ["followup/record=proof-b"],
      },
      {
        revision: modelRevision,
        goalIds: ["model-followup"],
        criteria: ["model-followup/record=proof-c"],
      },
      {
        revision: withdrawalRevision,
        goalIds: ["keep-goal"],
        criteria: ["keep-goal/record=proof-c"],
      },
    ]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

async function withSentinelGoalSocket(
  path: string,
  check: (turn: (content: string) => Promise<string>) => Promise<void>,
  configure?: (registry: ReturnType<typeof createProviderRegistry>) => void,
) {
  const registry = createProviderRegistry();
  configure?.(registry);
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({
    port: 0,
    token,
    chatSession: createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "test" as ChannelId,
      }),
      providerRegistry: registry,
      hookRunner: createHookRunner(createPolicyEngine()),
      sentinelSnapshotPath: path,
      allowSentinelModelAccess: true,
    }),
  });
  const { port } = await gateway.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const turn = (content: string) => {
      const done = Promise.withResolvers<string>();
      let response = "";
      let failure: string | undefined;
      const timer = setTimeout(
        () => done.reject(new Error("Missing turn end")),
        3000,
      );
      const receive = ({ data }: MessageEvent) => {
        const event = JSON.parse(data);
        if (event.type === "response") response = event.text;
        if (event.type === "error") failure = event.message;
        if (event.type === "turn_end") {
          if (failure) done.reject(new Error(failure));
          else done.resolve(response);
        }
      };
      socket.addEventListener("message", receive);
      socket.send(JSON.stringify({ type: "message", content }));
      return done.promise.finally(() => {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
      });
    };
    await turn("/sentinel on");
    await check(turn);
  } finally {
    socket.close();
    await gateway.stop();
  }
}

Deno.test("reviewed standalone Sentinel admission binds optional inventory coverage", async () => {
  const directory = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(directory);
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(
    path,
    JSON.stringify({ version: 1, nodes: [], edges: [] }),
  );
  const command = (inventoryCoverageEnabled: unknown) =>
    `assessment goals start ${
      JSON.stringify({
        requestId: "reviewed-coverage",
        objective: "Review the published service record.",
        goals: [goal("inventory", "future-evidence")],
        inventoryCoverageEnabled,
      })
    }`;

  try {
    await withSentinelGoalSocket(path, async (turn) => {
      await assertRejects(
        () => turn(command("false")),
        Error,
        "Choose whether inventory coverage",
      );
      assertEquals(readSentinelAssessment(path), undefined);
      const saved = JSON.parse(await turn(command(false)));
      assertEquals(saved.duplicate, false);
      assertEquals(saved.inventoryCoverageEnabled, false);
      assertEquals(
        readSentinelAssessment(path)?.plan.inventoryCoverageEnabled,
        false,
      );
      const amendment = `assessment goals add ${
        JSON.stringify({
          requestId: "invalid-coverage-amendment",
          goal: goal("followup", "future-evidence"),
          inventoryCoverageEnabled: true,
        })
      }`;
      await assertRejects(
        () => turn(amendment),
        Error,
        "when starting an assessment",
      );
    });
    await withSentinelGoalSocket(path, async (turn) => {
      const saved = JSON.parse(await turn("assessment goals status"));
      assertEquals(saved.inventoryCoverageEnabled, false);
      const replay = JSON.parse(await turn(command(false)));
      assertEquals(replay.duplicate, true);
      assertEquals(replay.inventoryCoverageEnabled, false);
      await assertRejects(() => turn(command(true)), Error, "already used");
      assertEquals(
        readSentinelAssessment(path)?.revision,
        replay.appliedRevision,
      );
    });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Sentinel formal goal proof accepts overflow criteria only after an authorized planner read", async () => {
  for (const allowRead of [false, true]) {
    const dir = await Deno.makeTempDir();
    const path = resolveSentinelCasePath(dir);
    const proofId = "saved-proof";
    const criteria = Array.from({ length: 9 }, (_, n) => ({
      ...goal("assessment", proofId).criteria[0],
      id: "criterion-" + n,
    }));
    const lastCriterion = "assessment/" + criteria.at(-1)!.id;
    const registry = createProviderRegistry();
    let permissionChecks = 0;
    let finalProposal = false;
    let plannerPrompt: string | undefined;
    registry.register({
      name: "planner-goal-fixture",
      supportsStreaming: false,
      complete(messages) {
        const result = messages.findLast(({ role }) => role === "tool");
        const usage = { inputTokens: 1, outputTokens: 1 };
        if (!result) {
          plannerPrompt = String(
            messages.findLast(({ role }) => role === "user")?.content,
          );
          return Promise.resolve({
            content: "",
            usage,
            toolCalls: [{
              id: "goal-page",
              type: "function",
              function: {
                name: "sentinel_goal_state",
                arguments: JSON.stringify({ offset: 8, limit: 1 }),
              },
            }],
          });
        }
        if (allowRead) {
          assertEquals(
            JSON.parse(String(result.content)).criteria[0].id,
            lastCriterion,
          );
        } else assert(!String(result.content).includes(lastCriterion));
        finalProposal = true;
        return Promise.resolve({
          content: JSON.stringify({
            assignments: [],
            prioritize: [],
            goalObservations: [{
              criterionId: lastCriterion,
              evidence: [{
                source: "graph_evidence",
                reference: proofId,
                detail: "The exact saved graph record.",
              }],
            }],
          }),
          usage,
          toolCalls: [],
        });
      },
    });
    registry.setDefault("planner-goal-fixture");
    const planner = createSentinelModelPlanner(
      path,
      (state) =>
        createSentinelSubagent({
          snapshotPath: path,
          assessmentRevision: state.revision,
          plannerExecutionEvidenceRunId: state.plan.runId,
          providerRegistry: registry,
          allowModelAccess: true,
          hookRunner: {
            evaluateHook(hook, { input }) {
              const checksGoalPage = hook === "PRE_TOOL_CALL" &&
                input.tool_name === "sentinel_goal_state";
              if (checksGoalPage) permissionChecks++;
              const allowed = !checksGoalPage || allowRead;
              return Promise.resolve({
                allowed,
                action: allowed ? "ALLOW" : "BLOCK",
                ruleId: null,
                duration: 0,
              });
            },
          },
        }),
    );

    try {
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          version: 1,
          nodes: [
            { id: proofId, kind: "evidence", label: "Saved review" },
            { id: "asset", kind: "asset", label: "Local service" },
          ],
          edges: [{ from: proofId, to: "asset", relation: "observed_on" }],
        }),
      );
      await withSentinelGoalSocket(path, async (turn) => {
        const started = JSON.parse(
          await turn(`assessment goals start ${
            JSON.stringify({
              objective: "Review the saved record.",
              requestId: "overflow-goal",
              goals: [{ ...goal("assessment", proofId), criteria }],
            })
          }`),
        );
        assertEquals(started.active, true);
        const state = readSentinelAssessment(path);
        assert(state);
        planner.advance(state);
        await until(() => finalProposal && !planner.hasInFlightWork());
        assertEquals(permissionChecks, 1);
        assert(plannerPrompt);
        assert(plannerPrompt.length <= 8000);
        assert(!plannerPrompt.includes(lastCriterion));
        assertEquals(
          readSentinelGoalCompletion(path)?.observations.map((
            { criterionId },
          ) => criterionId),
          allowRead ? [lastCriterion] : [],
        );
      });
    } finally {
      planner.stop();
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("standalone Sentinel start binds the reviewed template version and exact goal criteria", async () => {
  const directory = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(directory);
  const templateId = crypto.randomUUID();
  const objective = "Verify the published service configuration.";
  const description = "Approved configuration review";
  const categoryId = crypto.randomUUID();
  const categoryTitle = "Configuration reviews";
  const category = { id: categoryId, version: 1 };
  const templateRequest = {
    action: "set_assessment_template",
    templateId,
    templateVersion: 0,
    requestId: crypto.randomUUID(),
    title: "Service review template",
    childDescription: description,
    childGoal: objective,
    category,
  };
  const selected = { id: templateId, version: 1 };
  const criteria = [goal("configure", "future-configuration")];
  const start = (changes: Record<string, unknown> = {}) =>
    `assessment goals start ${
      JSON.stringify({
        requestId: "reviewed-template",
        template: selected,
        goals: criteria,
        inventoryCoverageEnabled: false,
        ...changes,
      })
    }`;

  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({ version: 1, nodes: [], edges: [] }),
    );
    const journal = openOperatorRunLinkStore(
      join(directory, "operator-run-links.db"),
    );
    try {
      const change = { kind: "create", title: categoryTitle } as const;
      const preview = journal.categories.review(categoryId, change)?.preview;
      assert(preview);
      assert(journal.categories.review(categoryId, change, preview)?.receipt);
    } finally {
      journal.close();
    }
    assert(
      await executeAssessmentTemplates(
        directory,
        templateRequest,
        async () => true,
        async () => true,
      ),
    );
    let approved: Record<string, unknown> | undefined;
    await withSentinelGoalSocket(path, async (turn) => {
      const draft = JSON.parse(
        await turn(
          `assessment goals propose ${JSON.stringify({ template: selected })}`,
        ),
      );
      assertEquals(draft.goals, criteria);
      assertEquals(draft.template.objective, objective);
      assertEquals(draft.template.description, description);
      assertEquals(draft.template.category, {
        ...category,
        title: categoryTitle,
      });
      await assertRejects(
        () => turn(start({ objective })),
        Error,
        "instead of objective or description",
      );
      assertEquals(readSentinelAssessment(path), undefined);
      approved = JSON.parse(await turn(start()));
      assertEquals(approved?.duplicate, false);
      assertEquals(approved?.formalGoals, criteria);
      assertEquals(approved?.admissionCategory, {
        ...category,
        title: categoryTitle,
      });
      const state = readSentinelAssessment(path);
      assertEquals(state?.plan.goal, objective);
      assertEquals(state?.plan.childDescription, description);
      assertEquals(
        state?.plan.assessmentTemplate,
        approved?.assessmentTemplate,
      );
      assertEquals(state?.plan.inventoryCoverageEnabled, false);
    }, (registry) => {
      registry.register({
        name: "template-goal-draft",
        supportsStreaming: false,
        complete(messages) {
          const prompt = JSON.stringify(messages);
          assertMatch(prompt, /Verify the published service configuration\./);
          assertMatch(prompt, /Approved configuration review/);
          return Promise.resolve({
            content: JSON.stringify({ goals: criteria }),
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1 },
          });
        },
      });
      registry.setDefault("template-goal-draft");
    });
    assert(
      await executeAssessmentTemplates(
        directory,
        {
          ...templateRequest,
          requestId: crypto.randomUUID(),
          templateVersion: 1,
          childGoal: "Review configuration drift.",
        },
        async () => true,
        async () => true,
      ),
    );
    assert(
      await executeAssessmentTemplates(
        directory,
        {
          action: "withdraw_assessment_template",
          templateId,
          templateVersion: 2,
          requestId: crypto.randomUUID(),
        },
        async () => true,
        async () => true,
      ),
    );
    await withSentinelGoalSocket(path, async (turn) => {
      const replay = JSON.parse(await turn(start()));
      assertEquals(replay.duplicate, true);
      assertEquals(replay.appliedRevision, approved?.appliedRevision);
      assertEquals(replay.assessmentTemplate, approved?.assessmentTemplate);
      assertEquals(replay.admissionCategory, approved?.admissionCategory);
      const readback = JSON.parse(await turn("assessment goals status"));
      assertEquals(readback.assessmentTemplate, approved?.assessmentTemplate);
      await assertRejects(
        () => turn(start({ template: { id: templateId, version: 2 } })),
        Error,
        "already used",
      );
      await assertRejects(
        () => turn(start({ requestId: "fresh-stale-template" })),
        Error,
        "no longer current",
      );
      await assertRejects(
        () =>
          turn(start({
            requestId: "fresh-withdrawn-template",
            template: { id: templateId, version: 2 },
          })),
        Error,
        "no longer current",
      );
      const unchanged = readSentinelAssessment(path);
      assertEquals(unchanged?.revision, approved?.appliedRevision);
      assertEquals(unchanged?.plan.goal, objective);
    });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("reviewed standalone Sentinel admission binds the exact workspace category version", async () => {
  const directory = await Deno.makeTempDir();
  const caseId = "categorized-standalone";
  const path = resolveSentinelCasePath(directory, caseId);
  const linkPath = join(directory, "operator-run-links.db");
  const id = crypto.randomUUID();
  const objective = "Review the published service controls.";
  const title = "Service control audits";
  const start = (version: number, requestId = "categorized-start") =>
    `assessment goals start ${
      JSON.stringify({
        requestId,
        objective,
        goals: [goal("categorized", "published-evidence")],
        category: { id, version },
      })
    }`;
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({ version: 1, nodes: [], edges: [] }),
    );
    let journal = openOperatorRunLinkStore(linkPath);
    try {
      const change = { kind: "create", title } as const;
      const preview = journal.categories.review(id, change)?.preview;
      assert(preview);
      assert(journal.categories.review(id, change, preview)?.receipt);
    } finally {
      journal.close();
    }
    let initial: ReturnType<typeof readSentinelAssessment>;
    await withSentinelGoalSocket(path, async (turn) => {
      await assertRejects(
        () => turn(start(2)),
        Error,
        "category version is unavailable",
      );
      assertEquals(readSentinelAssessment(path), undefined);
      const admission = JSON.parse(await turn(start(1)));
      assertEquals(admission.duplicate, false);
      assertEquals(admission.admissionCategory, { id, version: 1, title });
      initial = readSentinelAssessment(path);
      assert(initial?.plan.runId);
      assertEquals(initial.plan.admissionCategory, admission.admissionCategory);
      const readback = JSON.parse(await turn("assessment goals status"));
      assertEquals(readback.admissionCategory, admission.admissionCategory);
    });
    assert(initial?.plan.runId);
    const exactRun = {
      kind: "sentinel",
      id: caseId,
      runId: initial.plan.runId,
      revision: initial.revision,
    } as const;
    journal = openOperatorRunLinkStore(linkPath);
    try {
      assertEquals(journal.categories.forRun(exactRun), {
        id,
        version: 1,
        title,
      });
      const change = {
        kind: "rename",
        categoryId: id,
        version: 1,
        title: "Control verification",
      } as const;
      const renameId = crypto.randomUUID();
      const preview = journal.categories.review(renameId, change)?.preview;
      assert(preview);
      assert(journal.categories.review(renameId, change, preview)?.receipt);
      assertEquals(journal.categories.forRun(exactRun)?.version, 2);
    } finally {
      journal.close();
    }
    await withSentinelGoalSocket(path, async (turn) => {
      const replay = JSON.parse(await turn(start(1)));
      assertEquals(replay.duplicate, true);
      assertEquals(replay.appliedRevision, initial?.revision);
      assertEquals(replay.admissionCategory, { id, version: 1, title });
      await assertRejects(() => turn(start(2)), Error, "already used");
      await assertRejects(
        () => turn(start(1, "fresh-stale-category")),
        Error,
        "category version is unavailable",
      );
      assertEquals(readSentinelAssessment(path)?.revision, initial?.revision);
      await turn("assessment stop");
      const next = JSON.parse(await turn(start(2, "next-category-version")));
      assertEquals(next.admissionCategory, {
        id,
        version: 2,
        title: "Control verification",
      });
      const historical = JSON.parse(await turn(start(1)));
      assertEquals(historical.duplicate, true);
      assertEquals(historical.appliedRevision, initial?.revision);
      assertEquals(historical.admissionCategory, { id, version: 1, title });
    });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
