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

  async function withGateway(
    run: (
      turn: (content: string) => Promise<string>,
      tick: () => Promise<void>,
    ) => Promise<void>,
  ) {
    const registry = createProviderRegistry();
    registry.register({
      name: "fixture",
      supportsStreaming: false,
      complete(messages) {
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
          assert(input.goalCompletion);
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

    const chatSession = createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "test" as ChannelId,
      }),
      providerRegistry: registry,
      hookRunner: createHookRunner(createPolicyEngine()),
      sentinelSnapshotPath: mainPath,
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
      await run(turn, tick);
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
    await withGateway(async (turn, tick) => {
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
      await tick();
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

    await withGateway(async (turn, tick) => {
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
    ]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
