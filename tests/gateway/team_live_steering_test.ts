import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import { createMemorySecretStore } from "../../src/core/secrets/mod.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import {
  type ChannelId,
  createSession,
  restoreSession,
  type SessionId,
  updateTaint,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import type { EnhancedSessionManager } from "../../src/gateway/sessions.ts";
import { buildWorkflowRecoveryExecutor } from "../../src/gateway/startup/factory/agent_recovery.ts";
import { teamDeliveryExecutionId } from "../../src/gateway/startup/factory/delegated_agent_recovery.ts";
import { buildTeamManager } from "../../src/gateway/startup/factory/team_executor.ts";

const emptyChecklist =
  "No todos. Use todo_write to create your task list. Revision: empty";

const hooks = {
  evaluateHook: () =>
    Promise.resolve({
      allowed: true,
      action: "ALLOW" as const,
      ruleId: null,
      duration: 0,
    }),
};

Deno.test("Owner gateway steers and stops exact admitted team deliveries", async () => {
  const baseDir = await Deno.makeTempDir();
  const storage = createMemoryStorage();
  const keychain = createMemorySecretStore();
  const userId = "owner" as UserId;
  const owner = createSession({ userId, channelId: "owner" as ChannelId });
  const entered = Promise.withResolvers<void>();
  const sideStarted = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  const enteredCancellation = Promise.withResolvers<void>();
  const releaseCancellation = Promise.withResolvers<void>();
  let cancelledDeliveryRunId: string | undefined;
  let cancellationTurns = 0;
  let revokeControlOnReview = false;
  const note = "Review the segregated local fixture before proceeding.";
  const touched: string[] = [];
  const usage = { inputTokens: 1, outputTokens: 1 };
  const makeManager = () =>
    buildTeamManager({
      storage,
      callerSessionId: owner.id,
      sessionManager: {
        get: (id: SessionId) => Promise.resolve(id === owner.id ? owner : null),
      } as unknown as EnhancedSessionManager,
      orchestratorFactory: {
        create(channelId, options) {
          const state = options?.recoverySessionId
            ? restoreSession({
              userId,
              channelId: channelId as ChannelId,
              id: options.recoverySessionId,
            })
            : createSession({ userId, channelId: channelId as ChannelId });
          const session = options?.recoverySessionTaint
            ? updateTaint(state, options.recoverySessionTaint, "Fixture taint")
            : state;
          const registry = createProviderRegistry();
          registry.register({
            name: "live-team-fixture",
            supportsStreaming: false,
            async complete(messages) {
              if (!options?.executionChecklistRunId) {
                return { content: "Team member ready.", usage, toolCalls: [] };
              }
              const tool = messages.findLast(({ role }) => role === "tool");
              if (options.executionChecklistRunId === cancelledDeliveryRunId) {
                cancellationTurns++;
                if (tool) {
                  assertEquals(tool.content, emptyChecklist);
                  enteredCancellation.resolve();
                  await releaseCancellation.promise;
                }
                return {
                  usage,
                  content: "",
                  toolCalls: [{
                    id: crypto.randomUUID(),
                    type: "function",
                    function: {
                      name: tool ? "todo_write" : "todo_read",
                      arguments: tool
                        ? JSON.stringify({
                          expected_revision: "empty",
                          todos: [],
                        })
                        : "{}",
                    },
                  }],
                };
              }
              const steered = JSON.stringify(messages).includes(note);
              if (!tool && !steered) {
                entered.resolve();
                await release.promise;
              }
              return {
                content: tool ? "Local status reviewed." : "",
                usage,
                toolCalls: tool ? [] : [{
                  type: "function",
                  id: crypto.randomUUID(),
                  function: {
                    name: steered ? "todo_read" : "todo_write",
                    arguments: JSON.stringify({}),
                  },
                }],
              };
            },
          });
          registry.setDefault("live-team-fixture");
          const toolExecutor = (name: string) => {
            touched.push(name);
            return Promise.resolve(emptyChecklist);
          };
          return Promise.resolve({
            session,
            getSessionTaint: () => session.taint,
            toolExecutor,
            orchestrator: createOrchestrator({
              providerRegistry: registry,
              hookRunner: hooks,
              tools: ["todo_read", "todo_write"].map((name) => ({
                name,
                description: "Inspect local fixture checklist.",
                parameters: {},
              })),
              toolExecutor,
              getSessionTaint: () => session.taint,
            }),
          });
        },
      },
      recovery: {
        path: join(baseDir, "team-recovery.db"),
        profileBinding: "b".repeat(64),
        exactChecklists: true,
        run: () => Promise.reject(new Error("Expected isolated delivery")),
        bindObservationRun: (source, authorizeObservationScope) =>
          buildWorkflowRecoveryExecutor(
            { agent_recovery: { team: true, background_checklists: true } },
            baseDir,
            keychain,
            undefined,
            source,
            false,
            { checklistRole: "team", authorizeObservationScope },
          ),
      },
    });
  let manager = makeManager();
  let approvals = 0;
  let teamMember: string;
  let sideDelivery: string;
  const commandText = "Review the local fixture again.";
  const messages = createMessageStore(storage);
  let rejectControl = false;
  const start = async (session: typeof owner, team = false) => {
    const token = crypto.randomUUID();
    const providers = createProviderRegistry();
    providers.register({
      name: "team-control-owner",
      supportsStreaming: false,
      async complete(messages, tools, options) {
        if (
          String(messages[0]?.content).startsWith(
            "Answer the owner's independent",
          )
        ) {
          assertEquals(tools, []);
          const prompt = JSON.parse(String(messages.at(-1)?.content));
          assertEquals(prompt.committedContext.run.scope.sessionId, teamMember);
          assertEquals(prompt.committedContext.run.scope.runId, sideDelivery);
          assertEquals(
            prompt.committedContext.steps.map(({ tool }: { tool: string }) =>
              tool
            ),
            ["todo_read"],
          );
          assert(!JSON.stringify(prompt).includes(commandText));
          if (prompt.question === "hold side") {
            const signal = options.signal as AbortSignal;
            sideStarted.resolve(signal);
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true })
            );
          }
          return {
            content: "Reviewed the committed team step.",
            usage,
            toolCalls: [],
          };
        }
        const last = messages.at(-1);
        return Promise.resolve({
          content: last?.role === "tool"
            ? "Fixture result: " + last.content
            : "",
          usage,
          toolCalls: last?.role === "tool" ? [] : [{
            id: crypto.randomUUID(),
            type: "function",
            function: {
              name: "operator_runs",
              arguments: String(last?.content),
            },
          }],
        });
      },
    });
    providers.setDefault("team-control-owner");
    const server = createGatewayServer({
      port: 0,
      token,
      chatSession: createChatSession({
        session,
        providerRegistry: providers,
        messageStore: messages,
        sideQuestionTracePath: join(baseDir, "execution-traces.db"),
        ...(team && { runTeamRecoveryCommand: manager.runRecoveryCommand }),
        hookRunner: {
          evaluateHook(hook, context) {
            const allowed = !(rejectControl && hook === "PRE_TOOL_CALL" &&
              context.input.tool_name === "operator_runs");
            return Promise.resolve({
              allowed,
              action: allowed ? "ALLOW" : "BLOCK",
              ruleId: null,
              duration: 0,
            });
          },
        },
        operatorRunExecutor: createOperatorRunToolExecutor({
          baseDir,
          confirm: () => {
            approvals++;
            if (revokeControlOnReview) rejectControl = true;
            return Promise.resolve(true);
          },
        }),
      }),
    });
    const { port } = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return {
      async turn(content: string) {
        const complete = Promise.withResolvers<string>();
        let response = "";
        const timer = setTimeout(
          () => complete.reject(new Error("No gateway response")),
          4_000,
        );
        const receive = ({ data }: MessageEvent) => {
          const frame = JSON.parse(data);
          if (frame.type === "response") response = frame.text;
          if (frame.type === "error") response = frame.message;
          if (frame.type === "turn_end") complete.resolve(response);
        };
        socket.addEventListener("message", receive);
        try {
          socket.send(JSON.stringify({ type: "message", content }));
          return (await complete.promise).replace(/^Fixture result: /, "");
        } finally {
          socket.removeEventListener("message", receive);
          clearTimeout(timer);
        }
      },
      async side(content: string, type: string) {
        const complete = Promise.withResolvers<Record<string, unknown>>();
        const timer = setTimeout(
          () => complete.reject(new Error("No " + type)),
          4_000,
        );
        const receive = ({ data }: MessageEvent) => {
          const frame = JSON.parse(data);
          if (frame.type === type) complete.resolve(frame);
        };
        socket.addEventListener("message", receive);
        try {
          socket.send(JSON.stringify({ type: "message", content }));
          return await complete.promise;
        } finally {
          socket.removeEventListener("message", receive);
          clearTimeout(timer);
        }
      },
      async stop() {
        socket.close();
        await server.stop();
      },
    };
  };
  const serving = [];
  let delivery: Promise<string> | undefined;
  try {
    const team = await manager.createTeam({
      name: "Local review",
      task: "Review the local fixture checklist.",
      members: [{
        role: "reviewer",
        description: "Review only the local checklist.",
        isLead: true,
        classificationCeiling: "INTERNAL",
      }],
    }, owner.id);
    assert(team.ok);
    manager.stopLifecycleMonitor(team.value.id);
    const member = team.value.members[0].sessionId;
    teamMember = member;
    const deliveryId = crypto.randomUUID();
    const id = await teamDeliveryExecutionId(owner.id, member, deliveryId);
    const deliveryGateway = await start(owner, true);
    serving.push(deliveryGateway);
    const control = await start(owner);
    serving.push(control);
    const other = await start(
      createSession({ userId, channelId: "other" as ChannelId }),
    );
    serving.push(other);
    const steer = {
      action: "steer",
      kind: "team_delivery",
      id: [team.value.id, member, deliveryId].join(":"),
      requestId: crypto.randomUUID(),
      note,
    };
    delivery = deliveryGateway.turn(
      `/recover-team ${deliveryId} ${team.value.id} ${member} Review the local fixture.`,
    );
    await Promise.race([
      entered.promise,
      delivery.then((text) => {
        throw new Error(text);
      }),
    ]);
    assertStringIncludes(
      await other.turn(JSON.stringify(steer)),
      "unavailable",
    );
    rejectControl = true;
    assert(!(await control.turn(JSON.stringify(steer))).includes(note));
    assertEquals(approvals, 0);
    rejectControl = false;
    assertStringIncludes(
      await control.turn(JSON.stringify({
        ...steer,
        id: [crypto.randomUUID(), member, deliveryId].join(":"),
      })),
      "unavailable",
    );
    assertEquals(approvals, 0);
    revokeControlOnReview = true;
    try {
      assertStringIncludes(
        await control.turn(JSON.stringify(steer)),
        "unavailable",
      );
    } finally {
      revokeControlOnReview = false;
      rejectControl = false;
    }
    assertEquals(approvals, 1);
    const acceptedSteering = JSON.parse(
      await control.turn(JSON.stringify(steer)),
    );
    assertEquals(acceptedSteering.run, { kind: steer.kind, id: steer.id });
    const { receipt } = acceptedSteering;
    assertEquals(receipt.note, note);
    assertEquals(
      JSON.parse(await control.turn(JSON.stringify(steer))).receipt,
      receipt,
    );
    assertEquals(approvals, 2);
    release.resolve();
    assertEquals(await delivery, "Team delivery completed.");
    assertEquals(touched, ["todo_read"]);
    const read = await start(owner);
    serving.push(read);
    const trace = JSON.parse(
      await read.turn(JSON.stringify({
        action: "execution_traces",
        traceRole: "delegated",
        id,
      })),
    );
    assertEquals(trace.controls.steering.length, 1);
    assertEquals(trace.controls.steering[0].note, note);
    assert(trace.controls.steering[0].appliedAt);

    const stoppedDelivery = crypto.randomUUID();
    sideDelivery = `${team.value.id}:${member}:${stoppedDelivery}`;
    cancelledDeliveryRunId = await teamDeliveryExecutionId(
      owner.id,
      member,
      stoppedDelivery,
    );
    const command =
      `/recover-team ${stoppedDelivery} ${team.value.id} ${member} ${commandText}`;
    const cancel = {
      action: "cancel",
      kind: "team_delivery",
      id: [team.value.id, member, stoppedDelivery].join(":"),
    };
    delivery = deliveryGateway.turn(command);
    await Promise.race([
      enteredCancellation.promise,
      delivery.then((text) => {
        throw new Error(text);
      }),
    ]);
    assertEquals(touched, ["todo_read", "todo_read"]);
    const side = `/btw --run team_delivery ${sideDelivery}`;
    const answered = await control.side(
      `${side} inspect committed work`,
      "side_answer",
    );
    await other.side(`${side} inspect committed work`, "side_error");
    await control.side(
      `/btw --run team_delivery ${crypto.randomUUID()}:${member}:${stoppedDelivery} inspect`,
      "side_error",
    );
    const pendingSide = control.side(`${side} hold side`, "side_cancelled");
    const sideSignal = await sideStarted.promise;
    await control.side("/btw cancel", "side_cancelled");
    await pendingSide;
    assert(sideSignal.aborted);
    assertEquals(cancellationTurns, 2);
    const sideHistory = await control.side(side, "side_history");
    assertEquals(sideHistory.entries, [answered.entry]);

    assertStringIncludes(
      await other.turn(JSON.stringify(cancel)),
      "unavailable",
    );
    assertStringIncludes(
      await control.turn(JSON.stringify({
        ...cancel,
        id: [crypto.randomUUID(), member, stoppedDelivery].join(":"),
      })),
      "unavailable",
    );
    assertEquals(approvals, 2);
    revokeControlOnReview = true;
    try {
      assertStringIncludes(
        await control.turn(JSON.stringify(cancel)),
        "unavailable",
      );
    } finally {
      revokeControlOnReview = false;
      rejectControl = false;
    }
    assertEquals(approvals, 3);
    const stopped = JSON.parse(await control.turn(JSON.stringify(cancel))).run;
    assertEquals(stopped.ref, { kind: cancel.kind, id: cancel.id });
    assertEquals(stopped.status, "cancelled");
    assertEquals(
      JSON.parse(await control.turn(JSON.stringify(cancel))).run,
      stopped,
    );
    assertEquals(approvals, 4);
    releaseCancellation.resolve();
    assertEquals(await delivery, "Run cancelled by operator.");
    assertEquals(touched, ["todo_read", "todo_read"]);
    assertEquals(cancellationTurns, 2);

    await deliveryGateway.stop();
    serving.splice(serving.indexOf(deliveryGateway), 1);
    manager = makeManager();
    const restarted = await start(owner, true);
    serving.push(restarted);
    const list = { action: "list", kind: "team_delivery", limit: 1 };
    const listed = JSON.parse(await restarted.turn(JSON.stringify(list)));
    assertEquals(
      listed.runs.map(({ ref, status }: { ref: unknown; status: string }) => ({
        ref,
        status,
      })),
      [{ ref: stopped.ref, status: "cancelled" }],
    );
    assert(listed.nextCursor);
    const next = { ...list, cursor: listed.nextCursor };
    const older = JSON.parse(await restarted.turn(JSON.stringify(next)));
    assertEquals(older.runs[0].ref, acceptedSteering.run);
    assertEquals(older.runs[0].status, "completed");
    assertEquals(older.nextCursor, null);
    const foreignDiscovery = await start(updateTaint(
      createSession({ userId, channelId: "foreign-discovery" as ChannelId }),
      "INTERNAL",
      "Fixture discovery scope",
    ));
    serving.push(foreignDiscovery);
    assertEquals(
      JSON.parse(await foreignDiscovery.turn(JSON.stringify(list))).runs,
      [],
    );
    for (
      const [gateway, args] of [[foreignDiscovery, next], [restarted, {
        ...next,
        kind: "delegated",
      }]] as const
    ) {
      assertStringIncludes(
        await gateway.turn(JSON.stringify(args)),
        "unavailable",
      );
    }
    const discovered = older.runs[0].ref;
    assertEquals(
      JSON.parse(
        await restarted.turn(JSON.stringify({
          action: "inspect",
          ...discovered,
        })),
      ).run,
      older.runs[0],
    );
    const found = JSON.parse(
      await restarted.turn(JSON.stringify({
        action: "execution_traces",
        traceRole: discovered.kind,
        id: discovered.id,
        ordinal: 1,
      })),
    );
    assertEquals(found.step.tool, "todo_read");
    const retained = JSON.parse(
      await restarted.turn(JSON.stringify({
        action: "execution_traces",
        traceRole: "delegated",
        id: cancelledDeliveryRunId,
      })),
    );
    assertEquals(retained.controls.stopped, true);
    assertEquals(
      JSON.parse(await restarted.turn(JSON.stringify(cancel))).run,
      stopped,
    );
    assertEquals(approvals, 4);
    assertEquals(
      JSON.parse(await restarted.turn(JSON.stringify(steer))),
      acceptedSteering,
    );
    assertEquals(approvals, 4);
    assertEquals(
      retained.page.steps.map(({ tool }: { tool: string }) => tool),
      ["todo_read"],
    );
    assertEquals(await restarted.turn(command), "Run cancelled by operator.");
    assertEquals(cancellationTurns, 2);
    assertEquals(touched, ["todo_read", "todo_read"]);
  } finally {
    release.resolve();
    releaseCancellation.resolve();
    await delivery?.catch(() => {});
    await Promise.all(serving.map((gateway) => gateway.stop()));
    await storage.close();
    await Deno.remove(baseDir, { recursive: true });
  }
});
