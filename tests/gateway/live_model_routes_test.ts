import { runRecoverableAgentTurn } from "../../src/core/agent_recovery.ts";
import { AgentRecoveryStore } from "../../src/core/agent_recovery_store.ts";
import { assignmentRecoveryKey } from "../../src/core/durable_assignment.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { buildSubagentFactory } from "../../src/gateway/startup/factory/subagent.ts";
import { createSchedulerService } from "../../src/scheduler/service.ts";
import type { OrchestratorFactory } from "../../src/scheduler/service_types.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import {
  enableLiveProviderRoutes,
  liveProviderRouteSettings,
} from "../../src/agent/providers/live_routes.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import { createHookRunner } from "../../src/core/policy/hooks/hooks.ts";
import type { LlmProvider } from "../../src/core/types/llm.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";

Deno.test("gateway pins approved classification routes for the entire model turn", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: ".live-provider-route-",
  });
  const data = join(baseDir, "data");
  await Deno.mkdir(data, { mode: 0o700 });
  const routeFile = join(data, "model-routes.json");
  const approvals = { INTERNAL: ["first", "second"] };
  const policy = createHookRunner(createPolicyEngine());
  let allowRouteChanges = true;
  let revokeDuringReview = false;
  let reviews = 0;
  let withholdRouteOutput = false;
  let classifiedResponses = 0;
  let withheldOutputs = 0;
  const hooks: typeof policy = {
    ...policy,
    evaluateHook(hook, context) {
      if (
        hook === "POST_TOOL_RESPONSE" &&
        context.input.tool_name === "operator_runs"
      ) {
        classifiedResponses++;
      }
      if (
        hook === "PRE_OUTPUT" && withholdRouteOutput &&
        typeof context.input.content === "string" &&
        (context.input.content.includes('"baseline":') ||
          context.input.content.includes('"fixture-named-profile"'))
      ) {
        withheldOutputs++;
        return Promise.resolve({
          allowed: false,
          action: "BLOCK",
          ruleId: null,
          duration: 0,
        });
      }
      if (
        hook === "PRE_TOOL_CALL" && !allowRouteChanges &&
        ["set_live_model_route", "set_model_profile", "activate_model_profile"]
          .includes(
            (context.input.tool_call as
              | { args?: { action?: string } }
              | undefined)
              ?.args?.action ?? "",
          )
      ) {
        return Promise.resolve({
          allowed: false,
          action: "BLOCK",
          ruleId: null,
          duration: 0,
        });
      }
      return policy.evaluateHook(hook, context);
    },
  };
  const requests: string[] = [];
  const recoveryPath = join(baseDir, "agent-recovery.db");
  const recoverPrompt = "Use the exact committed local fixture receipt.";
  const approvedResult = "Exact approved local fixture receipt.";
  let readCount = 0;
  let routeEnabled = true;
  let interruption: {
    entered: PromiseWithResolvers<void>;
    release: PromiseWithResolvers<void>;
    finished: PromiseWithResolvers<void>;
  } | undefined;

  async function select(provider: string, model = provider) {
    const replacement = join(data, "replacement.json");
    await Deno.writeTextFile(
      replacement,
      JSON.stringify({ INTERNAL: { provider, model } }),
      { mode: 0o600 },
    );
    await Deno.rename(replacement, routeFile);
  }

  const provider = (name: string): LlmProvider => ({
    name,
    model: name,
    supportsStreaming: false,
    async complete(messages) {
      const input = messages.at(-1)?.content;
      requests.push(name);
      const last = messages.at(-1);
      if (last?.role === "user" && input === recoverPrompt) {
        return {
          content: "",
          toolCalls: [{
            type: "function",
            id: "exact-local-read",
            function: { name: "fixture_check", arguments: "{}" },
          }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      if (
        input === approvedResult &&
        messages.some(({ content }) => content === recoverPrompt)
      ) {
        if (interruption) {
          interruption.entered.resolve();
          await interruption.release.promise;
          throw new Error("Synthetic gateway interruption");
        }
        return {
          content: `Resumed on ${name} with the exact committed receipt.`,
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      if (
        last?.role === "user" && typeof input === "string" &&
        input.startsWith("{")
      ) {
        return {
          content: "",
          toolCalls: [{
            type: "function",
            id: "route-admin",
            function: { name: "operator_runs", arguments: input },
          }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      if (
        last?.role === "tool" && "tool_call_id" in last &&
        last.tool_call_id === "route-admin"
      ) {
        return {
          content: String(input),
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      if (name === "first" && input === "Start on the current route.") {
        await select("second");
        return {
          content: "",
          toolCalls: [{
            type: "function",
            id: "route-turn-check",
            function: { name: "fixture_check", arguments: "{}" },
          }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      return {
        content: `Answered by ${name}.`,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  });
  function registry() {
    const base = createProviderRegistry();
    for (const name of ["default", "first", "second", "unapproved"]) {
      base.register(provider(name));
    }
    base.setDefault("default");
    return base;
  }
  const session = createSession({
    userId: "owner" as UserId,
    channelId: "fixture" as ChannelId,
  });
  const backgroundRoutes = enableLiveProviderRoutes(
    registry(),
    baseDir,
    approvals,
  );
  const token = crypto.randomUUID();
  function makeGateway() {
    const ownerRoutes = enableLiveProviderRoutes(
      registry(),
      baseDir,
      routeEnabled ? approvals : undefined,
    );
    return createGatewayServer({
      port: 0,
      token,
      chatSession: createChatSession({
        session,
        hookRunner: hooks,
        providerRegistry: ownerRoutes,
        customToolsBaseDir: baseDir,
        agentModelProfileAllowlists: approvals,
        getSessionTaint: () => "INTERNAL",
        targetClassification: "INTERNAL",
        operatorRunExecutor: createOperatorRunToolExecutor({
          baseDir,
          liveModelRoutes: liveProviderRouteSettings(
            ownerRoutes,
            baseDir,
            approvals,
          ),
          confirm: () => {
            reviews++;
            if (revokeDuringReview) allowRouteChanges = false;
            return Promise.resolve(true);
          },
        }),
        tools: [{
          name: "fixture_check",
          description: "Check",
          parameters: {},
        }],
        toolExecutor: () => {
          readCount++;
          return Promise.resolve(approvedResult);
        },
        recoverAgentTurn: (id, orchestrator, options, control) =>
          runRecoverableAgentTurn(
            recoveryPath,
            id,
            {
              version: "exact-local-test-v1",
              projectCall: (call) =>
                call.name === "fixture_check" && !Object.keys(call.args).length
                  ? {}
                  : undefined,
              projectResult: (call, text) =>
                call.name === "fixture_check" && text === approvedResult
                  ? text
                  : undefined,
              authorize: (receipt) =>
                Promise.resolve(
                  receipt.name === "fixture_check" &&
                    !Object.keys(receipt.args).length,
                ),
              classification: () => "INTERNAL",
            },
            orchestrator,
            options,
            control,
          ).finally(() => interruption?.finished.resolve()),
      }),
    });
  }
  await select("first");
  let gateway = makeGateway();
  async function connect() {
    const { port } = await gateway.start();
    const connection = new WebSocket(
      `ws://127.0.0.1:${port}/chat?token=${token}`,
    );
    await new Promise<void>((resolve, reject) => {
      connection.addEventListener("open", () => resolve(), { once: true });
      connection.addEventListener("error", reject, { once: true });
    });
    return connection;
  }
  let socket = await connect();

  async function turn(content: string): Promise<string> {
    const done = Promise.withResolvers<string>();
    let answer = "";
    let toolResult: string | undefined;
    const receive = ({ data }: MessageEvent) => {
      const event = JSON.parse(data);
      if (event.type === "response") answer = String(event.text);
      if (event.type === "error") answer = String(event.message);
      if (event.type === "tool_result") toolResult = String(event.result);
      if (event.type === "turn_end") {
        done.resolve(content.startsWith("{") ? toolResult ?? answer : answer);
      }
    };
    const timer = setTimeout(() => done.reject(new Error("No reply")), 3000);
    socket.addEventListener("message", receive);
    try {
      socket.send(JSON.stringify({ type: "message", content }));
      return await done.promise;
    } finally {
      clearTimeout(timer);
      socket.removeEventListener("message", receive);
    }
  }
  try {
    assertEquals(
      await turn("Start on the current route."),
      "Answered by first.",
    );
    assertEquals(requests.splice(0), ["first", "first"]);
    assertEquals(await turn("Start the next turn."), "Answered by second.");
    assertEquals(requests.splice(0), ["second"]);

    // The normal scheduler and delegated entry points share an independent
    // startup registry, and resolve the same durable source snapshot.
    const factory: OrchestratorFactory = {
      create(channelId) {
        const backgroundSession = {
          ...createSession({
            userId: "fixture" as UserId,
            channelId: channelId as ChannelId,
          }),
          taint: "INTERNAL" as const,
        };
        const getSessionTaint = () => backgroundSession.taint;
        const toolExecutor = () => Promise.resolve("No tool call expected.");
        return Promise.resolve({
          session: backgroundSession,
          toolExecutor,
          getSessionTaint,
          orchestrator: createOrchestrator({
            providerRegistry: backgroundRoutes,
            hookRunner: hooks,
            getSessionTaint,
            isOwnerSession: () => false,
            getNonOwnerCeiling: () => "INTERNAL",
          }),
        });
      },
    };
    assertEquals(
      await buildSubagentFactory(factory)(
        "Read the independently loaded route.",
      ),
      "Answered by second.",
    );
    const delivered: string[] = [];
    const triggerMdPath = join(baseDir, "TRIGGER.md");
    await Deno.writeTextFile(
      triggerMdPath,
      "Read the current scheduled route.",
    );
    const scheduler = createSchedulerService({
      orchestratorFactory: factory,
      triggerMdPath,
      trigger: {
        enabled: false,
        intervalMinutes: 30,
        classificationCeiling: "INTERNAL",
      },
      webhooks: { enabled: false, sources: {} },
      onTriggerOutput: (_source, _classification, preview) =>
        delivered.push(preview),
    });
    try {
      await scheduler.runTrigger();
    } finally {
      scheduler.stop();
    }
    assertEquals(delivered, ["Answered by second."]);

    // Unapproved providers, mismatched exact models and a revoked file cannot
    // route protected context to the startup default or a different provider.
    for (const [name, model] of [["unapproved"], ["second", "other"]]) {
      await select(name, model);
      assertEquals(
        await turn("Do not send this context."),
        "The approved model route is unavailable.",
      );
    }
    await Deno.remove(routeFile);
    assertEquals(
      await turn("Do not send this after revocation."),
      "The approved model route is unavailable.",
    );
    assertEquals(requests.splice(0), ["second", "second"]);
    assertEquals(registry().getForClassification("INTERNAL")?.name, "default");

    await select("first");
    const change = (args: Record<string, unknown>) =>
      turn(JSON.stringify({
        modelRouteClassification: "INTERNAL",
        ...args,
      }));
    const read = async () =>
      JSON.parse(await change({ action: "live_model_route" }));
    const update = {
      action: "set_live_model_route",
      requestId: crypto.randomUUID(),
      expectedVersion: 0,
      modelProfile: "second",
      modelRouteModel: "second",
    };
    const initial = await read();
    assertEquals(initial.version, 0);
    assertEquals(initial._classification, "INTERNAL");
    assert(classifiedResponses > 0);
    withholdRouteOutput = true;
    assert(
      !(await change({ action: "live_model_route" })).includes('"baseline":'),
    );
    assert(withheldOutputs > 0);
    withholdRouteOutput = false;
    assert(
      (await change({ ...update, modelRouteClassification: "CONFIDENTIAL" }))
        .startsWith("Error:"),
    );
    assert(
      (await change({
        ...update,
        modelProfile: "unapproved",
        modelRouteModel: "unapproved",
      })).startsWith("Error:"),
    );
    assertEquals(reviews, 0);
    allowRouteChanges = false;
    assert((await change(update)).includes("blocked"));
    assertEquals(reviews, 0);
    allowRouteChanges = true;
    revokeDuringReview = true;
    assert((await change(update)).startsWith("Error:"));
    assertEquals(reviews, 1);
    allowRouteChanges = true;
    revokeDuringReview = false;
    assertEquals((await read()).version, 0);
    const updateReceipt = await change(update);
    assertEquals(JSON.parse(updateReceipt).edit.effective.provider, "second");
    assertEquals(reviews, 2);
    assertEquals(
      await turn("New turn after owner update."),
      "Answered by second.",
    );
    socket.close();
    await gateway.stop();
    gateway = makeGateway();
    socket = await connect();
    assertEquals(
      await turn("New gateway after owner update."),
      "Answered by second.",
    );
    assertEquals(await change(update), updateReceipt);
    assertEquals(reviews, 2);
    assert(
      (await change({
        ...update,
        modelProfile: "first",
        modelRouteModel: "first",
      })).startsWith("Error:"),
    );
    assertEquals((await read()).version, 1);

    const reset = {
      action: "reset_live_model_route",
      requestId: crypto.randomUUID(),
      expectedVersion: 1,
    };
    const resetReceipt = await change(reset);
    assertEquals(JSON.parse(resetReceipt).edit.effective.provider, "first");
    assertEquals(await turn("New turn after reset."), "Answered by first.");
    assertEquals(await change(reset), resetReceipt);
    assertEquals(reviews, 3);
    const independent = enableLiveProviderRoutes(
      registry(),
      baseDir,
      approvals,
    );
    assertEquals(
      independent.snapshotForTurn?.().getForClassification("INTERNAL")?.name,
      "first",
    );

    const id = "fixture-named-profile";
    const createNamed = {
      action: "set_model_profile",
      id,
      requestId: crypto.randomUUID(),
      expectedVersion: 0,
      modelProfile: "second",
      modelRouteModel: "second",
    };
    allowRouteChanges = false;
    assert((await change(createNamed)).includes("blocked"));
    assertEquals(reviews, 3);
    allowRouteChanges = true;
    assert((await change({
      ...createNamed,
      modelProfile: "unapproved",
      modelRouteModel: "unapproved",
    })).startsWith("Error:"));
    assert(
      (await change({ ...createNamed, apiKey: "synthetic-key" })).startsWith(
        "Error:",
      ),
    );
    assert((await change({
      ...createNamed,
      modelRouteClassification: "CONFIDENTIAL",
    })).startsWith("Error:"));
    revokeDuringReview = true;
    assert((await change(createNamed)).startsWith("Error:"));
    allowRouteChanges = true;
    revokeDuringReview = false;
    assertEquals(
      JSON.parse(await change({ action: "model_profiles" })).profiles,
      [],
    );
    const profileReceipt = await change(createNamed);
    assertEquals(JSON.parse(profileReceipt).profile.version, 1);
    const beforeClassificationCheck = classifiedResponses;
    withholdRouteOutput = true;
    assert(!(await change({ action: "model_profile", id })).includes(id));
    assert(classifiedResponses > beforeClassificationCheck);
    withholdRouteOutput = false;
    assertEquals(await change(createNamed), profileReceipt);
    assertEquals((await read()).version, 2);
    const activation = {
      action: "activate_model_profile",
      id,
      expectedVersion: 2,
      modelProfileVersion: 1,
      requestId: crypto.randomUUID(),
    };
    const activated = await change(activation);
    assertEquals(JSON.parse(activated).edit.named, { id, version: 1 });
    assertEquals(
      await turn("New turn after named activation."),
      "Answered by second.",
    );
    socket.close();
    await gateway.stop();
    gateway = makeGateway();
    socket = await connect();
    assertEquals(await change(activation), activated);
    assertEquals(
      await turn("New gateway with named model."),
      "Answered by second.",
    );

    const remove = {
      action: "delete_model_profile",
      id,
      requestId: crypto.randomUUID(),
      expectedVersion: 1,
    };
    assert((await change(remove)).startsWith("Error:"));
    const edited = JSON.parse(
      await change({
        ...createNamed,
        requestId: crypto.randomUUID(),
        expectedVersion: 1,
        modelProfile: "first",
        modelRouteModel: "first",
      }),
    );
    assertEquals(edited.profile.version, 2);
    assertEquals((await read()).named, { id, version: 2 });
    assertEquals((await read()).version, 4);
    assertEquals(
      await turn("New turn after active named edit."),
      "Answered by first.",
    );
    assert((await change(activation)).startsWith("Error:"));
    await change({
      ...reset,
      requestId: crypto.randomUUID(),
      expectedVersion: 4,
    });
    const deletion = { ...remove, expectedVersion: 2 };
    const dropped = await change(deletion);
    assertEquals(JSON.parse(dropped).profile.profile, null);
    assertEquals(await change(deletion), dropped);
    assertEquals(
      JSON.parse(await change({ action: "model_profiles" })).profiles,
      [],
    );

    const resumeCommand = (id: string) => `/recover ${id} ${recoverPrompt}`;
    const interrupt = async (id: string) => {
      const control = interruption = {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
        finished: Promise.withResolvers<void>(),
      };
      socket.send(
        JSON.stringify({ type: "message", content: resumeCommand(id) }),
      );
      const timeout = setTimeout(
        () => control.entered.reject(new Error("No committed tool batch")),
        3000,
      );
      try {
        await control.entered.promise;
        const journal = new AgentRecoveryStore(recoveryPath);
        try {
          const exact = journal.read(assignmentRecoveryKey(session.id, id));
          assert(
            exact && "checkpoint" in exact &&
              exact.checkpoint?.modelRouteIdentity,
          );
          assert(/^[a-f0-9]{256}$/.test(exact.checkpoint.modelRouteIdentity));
          assert(!exact.checkpoint.modelRouteIdentity.includes("first"));
        } finally {
          journal.close();
        }
      } finally {
        clearTimeout(timeout);
        socket.close();
        control.release.resolve();
        await control.finished.promise;
        interruption = undefined;
        await gateway.stop();
      }
    };

    const resumedId = crypto.randomUUID();
    await interrupt(resumedId);
    const afterFirstInterrupt = readCount;
    await select("second");
    gateway = makeGateway();
    socket = await connect();
    assertEquals(
      await turn("A new turn uses the updated route."),
      "Answered by second.",
    );
    assertEquals(
      await turn(resumeCommand(resumedId)),
      "Resumed on first with the exact committed receipt.",
    );
    assertEquals(readCount, afterFirstInterrupt);

    const revokedId = crypto.randomUUID();
    await select("first");
    await interrupt(revokedId);
    const afterSecondInterrupt = readCount;
    await select("second");
    approvals.INTERNAL = ["second"];
    gateway = makeGateway();
    socket = await connect();
    requests.length = 0;
    const denied =
      "The original approved model route is unavailable. Operator review is required.";
    assertEquals(await turn(resumeCommand(revokedId)), denied);
    assertEquals(requests, []);
    assertEquals(readCount, afterSecondInterrupt);

    approvals.INTERNAL = ["first", "second"];
    await select("first");
    const agentProfile = {
      action: "set_agent_profile",
      id: "model-pinned-agent",
      expectedVersion: 0,
      requestId: crypto.randomUUID(),
      profileSettings: {
        name: "Model pinned fixture",
        description: "Select the exact reviewed model.",
        role: "assistant",
        prompt: "Use verified fixture evidence.",
        tools: ["fixture_check"],
        modelProfile: { provider: "second", model: "second" },
      },
    };
    assertEquals(
      JSON.parse(await turn(JSON.stringify(agentProfile))).profile.version,
      1,
    );
    await turn("/agent-profile model-pinned-agent");
    assertEquals(
      await turn("Use the selected agent model."),
      "Answered by second.",
    );
    const selectedRecovery = crypto.randomUUID();
    await interrupt(selectedRecovery);
    const afterSelectedInterrupt = readCount;
    gateway = makeGateway();
    socket = await connect();
    assertEquals(
      await turn(resumeCommand(selectedRecovery)),
      "Resumed on second with the exact committed receipt.",
    );
    assertEquals(readCount, afterSelectedInterrupt);

    const revokedAgentRecovery = crypto.randomUUID();
    await interrupt(revokedAgentRecovery);
    approvals.INTERNAL = ["first"];
    gateway = makeGateway();
    socket = await connect();
    requests.length = 0;
    assertEquals(
      await turn("Do not fall back from this profile."),
      "The approved model route is unavailable.",
    );
    assertEquals(await turn(resumeCommand(revokedAgentRecovery)), denied);
    assertEquals(requests, []);
    await turn("/agent-profile off");
    assertEquals(
      await turn("Resume ordinary model selection."),
      "Answered by first.",
    );
    requests.length = 0;

    socket.close();
    await gateway.stop();
    routeEnabled = false;
    gateway = makeGateway();
    socket = await connect();
    assertEquals(await turn(resumeCommand(revokedId)), denied);
    assertEquals(requests, []);
    assertEquals(
      await turn("A fresh turn without live routes."),
      "Answered by default.",
    );
  } finally {
    socket.close();
    await gateway.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});
