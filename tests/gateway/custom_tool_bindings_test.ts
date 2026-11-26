import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import {
  createDefaultRules,
  createHookRunner,
} from "../../src/core/policy/hooks/hooks.ts";
import { createToolApprovalService } from "../../src/core/tool_approval_service.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { AgentRecoveryStore } from "../../src/core/agent_recovery_store.ts";
import { assignmentRecoveryKey } from "../../src/core/durable_assignment.ts";
import { createMemorySecretStore } from "../../src/core/secrets/mod.ts";
import { buildWorkflowRecoveryExecutor } from "../../src/gateway/startup/factory/agent_recovery.ts";
import { delegatedSubagentIdentity } from "../../src/gateway/startup/factory/delegated_agent_recovery.ts";
import { buildOwnerSubagentRecoveryCommand } from "../../src/gateway/startup/factory/owner_subagent_recovery.ts";
import { buildSubagentFactory } from "../../src/gateway/startup/factory/subagent.ts";
import { createOrchestratorFactory } from "../../src/gateway/startup/factory/orchestrator_factory.ts";
import { type TriggerFishConfig } from "../../src/core/config.ts";
import { createToolFloorRegistry } from "../../src/core/security/tool_floors.ts";
import { createCronManager } from "../../src/scheduler/cron/cron.ts";
import { tickCronJobs } from "../../src/scheduler/service_cron.ts";
import {
  buildHealthcheckToolDefinitions,
  createHealthcheckToolExecutor,
} from "../../src/tools/healthcheck.ts";

const alias = "custom_diagnostic";
const admin = "custom_tool_manage";
const usage = { inputTokens: 1, outputTokens: 1 };

Deno.test("Owner publishes and revises one local diagnostic alias through exact approval and root policies", async () => {
  const dir = await Deno.makeTempDir();
  const proposals = join(dir, "custom-tool-proposals");
  await Deno.mkdir(proposals, { mode: 0o700 });
  const proposal = join(proposals, alias + ".json");
  const stage = (component: string, cronJobId?: string) =>
    Deno.writeTextFile(
      proposal,
      JSON.stringify({ name: alias, component, cronJobId }),
      {
        mode: 0o600,
      },
    );
  await stage("providers");
  const owner = createSession({
    userId: "owner" as UserId,
    channelId: "owner" as ChannelId,
  });
  const target = "INTERNAL";
  const actual: unknown[] = [];
  let aliasAdvertised = false;
  let blocked: { hook: string; tool?: string } | undefined;

  async function launch(
    healthcheck = true,
    collision = false,
    runSubagentRecoveryCommand?: ReturnType<
      typeof buildOwnerSubagentRecoveryCommand
    >,
    session = owner,
  ) {
    const inbox = createToolApprovalService(join(dir, "approval-inbox.db"));
    const engine = createPolicyEngine();
    for (const rule of createDefaultRules()) engine.addRule(rule);
    const base = createHookRunner(engine);
    const providers = createProviderRegistry();
    providers.register({
      name: "custom-tool-fixture",
      supportsStreaming: false,
      complete(messages, definitions) {
        const response = messages.findLast(({ role }) => role === "tool");
        if (messages.at(-1)?.role === "tool") {
          return Promise.resolve({
            content: "Fixture result: " + String(response?.content),
            toolCalls: [],
            usage,
          });
        }
        aliasAdvertised = definitions?.some((tool) =>
          (tool as { function?: { name: string } }).function?.name === alias
        ) ?? false;
        const input = JSON.parse(String(messages.at(-1)?.content));
        return Promise.resolve({
          content: "",
          usage,
          toolCalls: [{
            id: crypto.randomUUID(),
            type: "function",
            function: {
              name: input.tool,
              arguments: JSON.stringify(input.args),
            },
          }],
        });
      },
    });
    providers.setDefault("custom-tool-fixture");
    const healthcheckExecutor = createHealthcheckToolExecutor({
      providerRegistry: providers,
    });
    const token = crypto.randomUUID();
    const gateway = createGatewayServer({
      port: 0,
      token,
      chatSession: createChatSession({
        session,
        runSubagentRecoveryCommand,
        customToolsBaseDir: dir,
        targetClassification: target,
        providerRegistry: providers,
        enableStreaming: false,
        tools: [
          ...healthcheck ? buildHealthcheckToolDefinitions() : [],
          ...(collision
            ? [{
              name: alias,
              description: "Independent existing tool",
              parameters: {},
            }]
            : []),
        ],
        toolClassifications: new Map([["healthcheck", "INTERNAL"]]),
        hookRunner: {
          ...base,
          toolApprovalInbox: inbox,
          async evaluateHook(hook, context) {
            if (
              blocked?.hook === hook &&
              (blocked.tool === context.input.tool_name ||
                (hook === "PRE_OUTPUT" &&
                  String(context.input.content).includes("Healthcheck Report")))
            ) {
              return {
                allowed: false,
                action: "BLOCK",
                ruleId: null,
                duration: 0,
              };
            }
            return await base.evaluateHook(hook, context);
          },
        },
        async toolExecutor(name, args) {
          if (collision && name === alias) return "Independent tool result.";
          assertEquals(name, "healthcheck");
          actual.push(args.components);
          const result = await healthcheckExecutor(name, args);
          assert(result);
          return result;
        },
      }),
    });
    const { port } = await gateway.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    async function exchange(
      body: Record<string, unknown>,
      complete: (frame: Record<string, unknown>) => boolean,
    ) {
      const result = Promise.withResolvers<Record<string, unknown>[]>();
      const frames: Record<string, unknown>[] = [];
      const timer = setTimeout(
        () => result.reject(new Error("Gateway exchange timed out")),
        3500,
      );
      const receive = ({ data }: MessageEvent) => {
        const frame = JSON.parse(data);
        frames.push(frame);
        if (complete(frame)) result.resolve(frames);
      };
      socket.addEventListener("message", receive);
      socket.send(JSON.stringify(body));
      try {
        return await result.promise;
      } finally {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
      }
    }
    return {
      async command(content: string) {
        const frames = await exchange(
          { type: "message", content },
          ({ type }) => type === "turn_end",
        );
        const final = frames.findLast(({ type }) =>
          type === "response" || type === "error"
        );
        return String(final?.text ?? final?.message);
      },
      async turn(tool: string, args: Record<string, unknown> = {}) {
        const frames = await exchange({
          type: "message",
          content: JSON.stringify({ tool, args }),
        }, ({ type }) => type === "turn_end");
        const final = frames.findLast(({ type }) =>
          type === "response" || type === "error"
        );
        return {
          text: String(final?.text ?? final?.message).replace(
            /^Fixture result: /,
            "",
          ),
          frames,
        };
      },
      receipt(id: string) {
        return inbox.list().records.find((record) => record.id === id);
      },
      async approve(
        approved: boolean,
        action: "apply" | "retire" | "test" = "apply",
      ) {
        let pending;
        for (let attempt = 0; attempt < 100 && !pending; attempt++) {
          pending = inbox.list().records.find((record) =>
            record.status === "pending"
          );
          if (!pending) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert(pending);
        assertEquals(pending.customTool, { action, name: alias });
        const requestId = crypto.randomUUID();
        const frames = await exchange(
          {
            type: "approval_inbox_decide",
            requestId,
            approvalId: pending.id,
            approved,
          },
          (event) =>
            event.type === "approval_inbox_result" &&
            event.requestId === requestId,
        );
        assertEquals(frames.at(-1)?.ok, true);
        return pending.id;
      },
      async stop() {
        const closed = new Promise<void>((resolve) =>
          socket.addEventListener("close", () => resolve(), { once: true })
        );
        socket.close();
        await closed;
        await gateway.stop();
      },
    };
  }

  let gateway = await launch();
  try {
    assertStringIncludes((await gateway.turn(alias)).text, "unavailable");
    assert(!aliasAdvertised);
    const inspect = async () =>
      JSON.parse(
        (await gateway.turn(admin, { action: "inspect", name: alias })).text,
      );
    const apply = (revision: string) =>
      gateway.turn(admin, { action: "apply", name: alias, revision });
    const initial = await inspect();
    assertEquals(initial.replacing, false);
    const test = (revision: string) =>
      gateway.turn(admin, { action: "test", name: alias, revision });
    blocked = { hook: "PRE_TOOL_CALL", tool: admin };
    assertStringIncludes((await test(initial.revision)).text, "blocked");
    assertEquals(actual, []);
    blocked = undefined;
    const declinedTest = test(initial.revision);
    await gateway.approve(false, "test");
    assertStringIncludes((await declinedTest).text, "denied");
    assertEquals(actual, []);

    const staleTest = test(initial.revision);
    await stage("config");
    await gateway.approve(true, "test");
    assertStringIncludes((await staleTest).text, "unavailable");
    assertEquals(actual, []);
    await stage("providers");

    blocked = { hook: "PRE_TOOL_CALL", tool: "healthcheck" };
    const deniedDiagnostic = test(initial.revision);
    await gateway.approve(true, "test");
    assertStringIncludes((await deniedDiagnostic).text, "blocked");
    assertEquals(actual, []);

    blocked = { hook: "POST_TOOL_RESPONSE", tool: "healthcheck" };
    const privateDiagnostic = test(initial.revision);
    await gateway.approve(true, "test");
    assert(
      !JSON.stringify((await privateDiagnostic).frames).includes(
        "Healthcheck Report",
      ),
    );
    assertEquals(actual, [["providers"]]);

    blocked = { hook: "PRE_OUTPUT" };
    const blockedDiagnosticOutput = test(initial.revision);
    await gateway.approve(true, "test");
    assert(
      !JSON.stringify((await blockedDiagnosticOutput).frames).includes(
        "Healthcheck Report",
      ),
    );
    assertEquals(actual, [["providers"], ["providers"]]);

    blocked = undefined;
    const acceptedTest = test(initial.revision);
    const testApproval = await gateway.approve(true, "test");
    assertStringIncludes(
      (await acceptedTest).text,
      "[OK] providers: Default provider: custom-tool-fixture",
    );
    assertEquals(gateway.receipt(testApproval)?.customTool, {
      action: "test",
      name: alias,
    });
    assertEquals(actual, [["providers"], ["providers"], ["providers"]]);
    assert(!aliasAdvertised);
    assertStringIncludes((await gateway.turn(alias)).text, "unavailable");
    assertEquals(
      JSON.parse((await gateway.turn(admin, { action: "list" })).text).bindings,
      [],
    );
    actual.length = 0;
    const denied = apply(initial.revision);
    await gateway.approve(false);
    assertStringIncludes((await denied).text, "denied");
    assertStringIncludes((await gateway.turn(alias)).text, "unavailable");
    const creating = apply(initial.revision);
    const approval = await gateway.approve(true);
    assertEquals(JSON.parse((await creating).text).approvalRequestId, approval);

    assertStringIncludes(
      (await gateway.turn(alias)).text,
      "[OK] providers: Default provider: custom-tool-fixture",
    );
    assert(aliasAdvertised);
    assertEquals(actual, [["providers"]]);
    assertStringIncludes(
      (await gateway.turn(alias, { component: "storage" })).text,
      "unavailable",
    );
    for (const tool of [alias, "healthcheck"]) {
      blocked = { hook: "PRE_TOOL_CALL", tool };
      assertStringIncludes((await gateway.turn(alias)).text, "blocked");
    }
    assertEquals(actual.length, 1);
    for (const tool of [alias, "healthcheck"]) {
      blocked = { hook: "POST_TOOL_RESPONSE", tool };
      const result = await gateway.turn(alias);
      assert(!JSON.stringify(result.frames).includes("Healthcheck Report"));
    }
    blocked = { hook: "PRE_OUTPUT" };
    const output = await gateway.turn(alias);
    assert(!JSON.stringify(output.frames).includes("Healthcheck Report"));
    blocked = undefined;

    const status = async () =>
      JSON.parse(
        (await gateway.turn(admin, { action: "status", name: alias })).text,
      );
    const retire = (revision: string) =>
      gateway.turn(admin, { action: "retire", name: alias, revision });
    const previous = await status();
    await stage("config");
    const changed = await inspect();
    assertEquals(changed.replacing, true);
    assertStringIncludes(
      (await gateway.turn(alias)).text,
      "[OK] providers: Default provider: custom-tool-fixture",
    );
    const stale = apply(changed.revision);
    await stage("providers");
    await gateway.approve(true);
    assertStringIncludes((await stale).text, "changed before approval");
    assertStringIncludes(
      (await gateway.turn(alias)).text,
      "[OK] providers: Default provider: custom-tool-fixture",
    );
    await stage("config");
    const fresh = await inspect();
    const revising = apply(fresh.revision);
    await gateway.approve(true);
    assertEquals(JSON.parse((await revising).text).binding.component, "config");
    await gateway.stop();

    gateway = await launch();
    assertStringIncludes(
      (await gateway.turn(alias)).text,
      "[OK] config: Configuration loaded",
    );
    assert(aliasAdvertised);
    assertEquals(actual.at(-1), ["config"]);
    const current = await status();
    assertEquals(current.retired, false);
    const staleRetirement = retire(previous.revision);
    await gateway.approve(true, "retire");
    assertStringIncludes(
      (await staleRetirement).text,
      "changed before retirement",
    );
    const declinedRetirement = retire(current.revision);
    await gateway.approve(false, "retire");
    assertStringIncludes((await declinedRetirement).text, "denied");
    assertEquals(await status(), current);

    const reviewedBeforeRetirement = await inspect();
    await gateway.stop();
    gateway = await launch(true, true);
    assertEquals((await gateway.turn(alias)).text, "Independent tool result.");
    assertStringIncludes(
      (await gateway.turn(admin, { action: "inspect", name: alias })).text,
      "existing tool already has this name",
    );
    const retiring = retire(current.revision);
    const retiredApproval = await gateway.approve(true, "retire");
    const retirement = JSON.parse((await retiring).text);
    assertEquals(retirement.approvalRequestId, retiredApproval);
    assertEquals(retirement.retired, true);
    assertEquals((await gateway.turn(alias)).text, "Independent tool result.");
    await gateway.stop();
    gateway = await launch();

    assertStringIncludes((await gateway.turn(alias)).text, "unavailable");
    assert(!aliasAdvertised);
    assertEquals((await status()).revision, retirement.revision);
    const receipt = gateway.receipt(retiredApproval);
    assertEquals(receipt?.customTool, { action: "retire", name: alias });
    assertEquals(receipt?.status, "completed");
    assert(!JSON.stringify(receipt).includes(current.revision));
    const obsoleteApply = apply(reviewedBeforeRetirement.revision);
    await gateway.approve(true);
    assertStringIncludes((await obsoleteApply).text, "changed before approval");
    const freshAfterRetirement = await inspect();
    assertEquals(freshAfterRetirement.replacing, false);
    const recreating = apply(freshAfterRetirement.revision);
    await gateway.approve(true);
    assertEquals(
      JSON.parse((await recreating).text).binding.component,
      "config",
    );

    const jobs = createCronManager();
    const matching = jobs.create({
      expression: "* * * * *",
      task: "Run local diagnostic: matching job.",
      classificationCeiling: "INTERNAL",
    });
    const neighbor = jobs.create({
      expression: "* * * * *",
      task: "Run local diagnostic: neighboring job.",
      classificationCeiling: "INTERNAL",
    });
    assert(matching.ok && neighbor.ok);
    const matchedJob = matching.value.id;
    await stage("config", matchedJob);
    const observedProposal = await inspect();
    assertEquals(observedProposal.binding.cronJobId, matchedJob);
    const grant = apply(observedProposal.revision);
    await gateway.approve(true);
    assertEquals(JSON.parse((await grant).text).binding.cronJobId, matchedJob);
    await gateway.stop();
    gateway = await launch();
    assertStringIncludes(
      (await gateway.turn(alias)).text,
      "Configuration loaded",
    );

    const runModel = async (
      beforeCall?: () => Promise<void>,
      delegatedRun?: (
        factory: ReturnType<typeof createOrchestratorFactory>,
        config: TriggerFishConfig,
      ) => Promise<void>,
      afterResult?: () => void,
    ) => {
      const results = new Map<
        string,
        { advertised: boolean; result: string }
      >();
      const offered = new Map<string, boolean>();
      const response = Promise.withResolvers<void>();
      const model = Deno.serve({
        hostname: "127.0.0.1",
        port: 0,
        onListen() {},
      }, async (request) => {
        try {
          if (new URL(request.url).pathname !== "/v1/chat/completions") {
            return new Response(null, { status: 404 });
          }
          const body = await request.json();
          const subject: string = body.messages.find((
            { role }: { role: string },
          ) => role === "user")?.content;
          const id = subject.includes("matching job") ? "matching" : "neighbor";
          const tool = body.messages.findLast(({ role }: { role: string }) =>
            role === "tool"
          );
          const available = body.tools.some((
            { function: definition }: { function: { name: string } },
          ) => definition.name === alias);
          if (tool) {
            if (id === "matching") afterResult?.();
            results.set(id, {
              advertised: offered.get(id)!,
              result: String(tool.content),
            });
          } else {
            offered.set(id, available);
            results.set(id, { advertised: available, result: "" });
            if (id === "matching") await beforeCall?.();
          }
          const message = tool
            ? { role: "assistant", content: "Checked local diagnostics." }
            : {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: crypto.randomUUID(),
                type: "function",
                function: { name: alias, arguments: "{}" },
              }],
            };
          if (
            [...results.values()].filter(({ result }) => result).length === 2
          ) {
            response.resolve();
          }
          if (body.stream) {
            return new Response(
              `data: ${JSON.stringify({ choices: [{ delta: message }] })}\n\n` +
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          return Response.json({
            choices: [{ message }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          });
        } catch (error) {
          response.reject(error);
          return new Response(null, { status: 500 });
        }
      });
      const ollama = {
        model: "fixture",
        endpoint: `http://127.0.0.1:${model.addr.port}`,
      };
      const config: TriggerFishConfig = {
        models: {
          primary: { provider: "ollama", model: "fixture" },
          providers: { ollama },
        },
        channels: {},
        classification: { mode: "strict" },
        ...(delegatedRun &&
          { agent_recovery: { background_checklists: true } }),
      };
      const factory = createOrchestratorFactory(
        config,
        dir,
        jobs,
        undefined,
        undefined,
        undefined,
        undefined,
        createToolFloorRegistry(),
      );
      const timeout = setTimeout(
        () => response.reject(new Error("Cron diagnostic test timed out")),
        5000,
      );
      try {
        if (delegatedRun) {
          await Promise.race([
            delegatedRun(factory, config),
            response.promise.then(() => new Promise<never>(() => {})),
          ]);
        } else {
          tickCronJobs({
            orchestratorFactory: factory,
            triggerMdPath: join(dir, "TRIGGER.md"),
            webhooks: { enabled: false, sources: {} },
            trigger: {
              enabled: false,
              intervalMinutes: 1,
              classificationCeiling: "INTERNAL",
            },
          }, jobs);
          await response.promise;
        }
        return results;
      } finally {
        clearTimeout(timeout);
        await model.shutdown();
      }
    };

    const offeredWithGrant = await runModel();
    const native = offeredWithGrant.get("matching");
    assert(native?.advertised);
    assertEquals(JSON.parse(native.result)._classification, "INTERNAL");
    assertStringIncludes(
      JSON.parse(native.result).diagnostic,
      "Configuration loaded",
    );
    const deniedNeighbor = offeredWithGrant.get("neighbor");
    assertEquals(deniedNeighbor?.advertised, false);
    assert(!deniedNeighbor?.result.includes("Configuration loaded"));
    const oldGrant = await status();
    const inFlight = await runModel(async () => {
      const removing = retire(oldGrant.revision);
      await gateway.approve(true, "retire");
      assertEquals(JSON.parse((await removing).text).retired, true);
    });
    assertEquals(inFlight.get("matching")?.advertised, true);
    assert(!inFlight.get("matching")?.result.includes("Configuration loaded"));
    assertStringIncludes((await gateway.turn(alias)).text, "unavailable");
    await stage("config");
    const unscoped = await inspect();
    const restoreAlias = apply(unscoped.revision);
    await gateway.approve(true);
    assertEquals(
      JSON.parse((await restoreAlias).text).binding.cronJobId,
      undefined,
    );
    assertEquals((await runModel()).get("matching")?.advertised, false);
    const executionId = crypto.randomUUID();
    const delegated = { parentSessionId: owner.id, executionId };
    await Deno.writeTextFile(
      proposal,
      JSON.stringify({ name: alias, component: "config", delegated }),
      { mode: 0o600 },
    );
    const delegatedProposal = await inspect();
    assertEquals(delegatedProposal.binding.delegated, delegated);
    const approveDelegated = apply(delegatedProposal.revision);
    await gateway.approve(true);
    assertEquals(
      JSON.parse((await approveDelegated).text).binding.delegated,
      delegated,
    );
    const identity = await delegatedSubagentIdentity(owner.id, executionId);
    const key = await assignmentRecoveryKey(
      identity.sessionId,
      identity.executionId,
    );
    const recoveryPath = join(dir, "agent-recovery.db");
    const withRecovery = <T>(fn: (store: AgentRecoveryStore) => T) => {
      const store = new AgentRecoveryStore(recoveryPath);
      try {
        return fn(store);
      } finally {
        store.close();
      }
    };
    const subagent = (
      factory: ReturnType<typeof createOrchestratorFactory>,
      config: TriggerFishConfig,
    ) =>
      buildOwnerSubagentRecoveryCommand(
        buildSubagentFactory(factory, {
          executionTracePath: join(dir, "execution-traces.db"),
        }),
        buildWorkflowRecoveryExecutor(
          config,
          dir,
          createMemorySecretStore(),
          undefined,
          undefined,
          false,
          { checklistRole: "delegated" },
        ),
        (source) =>
          buildWorkflowRecoveryExecutor(
            config,
            dir,
            createMemorySecretStore(),
            undefined,
            source,
            false,
            { checklistRole: "delegated" },
          ),
      );
    const task = "Run local diagnostic: matching job.";
    let pause = true;
    let pauseAfterResult = true;
    const peer = await runModel(() => {
      if (pause) {
        pause = false;
        assert(withRecovery((store) => store.requestPause(key, true)));
      }
      return Promise.resolve();
    }, async (factory, config) => {
      await gateway.stop();
      gateway = await launch(true, false, subagent(factory, config));
      assertStringIncludes(
        await gateway.command(`/recover-subagent ${executionId} ${task}`),
        "before dispatch",
      );
      assertEquals(withRecovery((store) => store.read(key)?.status), "paused");
      await gateway.stop();
      gateway = await launch(true, false, subagent(factory, config));
      assertStringIncludes(
        await gateway.command(
          `/recover-subagent --resume-paused ${executionId} ${task}`,
        ),
        "paused",
      );
      const saved = withRecovery((store) => store.read(key));
      assert(saved?.status === "paused" && saved.checkpoint);
      assertEquals(saved.tools.length, 1);
      assertEquals(saved.tools[0].name, alias);
      assert(
        saved.checkpoint.history.some(({ role, content }) =>
          role === "tool" && String(content).includes("Configuration loaded")
        ),
      );
      assertStringIncludes(
        await gateway.command(
          `/recover-subagent --resume-paused ${executionId} ${task}`,
        ),
        "Checked local diagnostics.",
      );
      assertEquals(
        withRecovery((store) => store.read(key)?.status),
        "finished",
      );
      assertStringIncludes(
        await gateway.command(
          `/recover-subagent ${crypto.randomUUID()} Run local diagnostic: neighboring job.`,
        ),
        "before dispatch",
      );
    }, () => {
      if (pauseAfterResult) {
        pauseAfterResult = false;
        assert(withRecovery((store) => store.requestPause(key)));
      }
    });
    assertEquals(peer.get("matching")?.advertised, true);
    assertStringIncludes(
      peer.get("matching")?.result ?? "",
      "Configuration loaded",
    );
    assertEquals(peer.get("neighbor")?.advertised, false);
    assert(!peer.get("neighbor")?.result.includes("Configuration loaded"));
    const alternateOwner = createSession({
      userId: "owner" as UserId,
      channelId: "alternate-owner" as ChannelId,
    });
    const mismatched = await runModel(undefined, async (factory, config) => {
      await gateway.stop();
      gateway = await launch(
        true,
        false,
        subagent(factory, config),
        alternateOwner,
      );
      assertStringIncludes(
        await gateway.command(
          `/recover-subagent ${executionId} Run local diagnostic: neighboring job.`,
        ),
        "before dispatch",
      );
    });
    assertEquals(mismatched.get("neighbor")?.advertised, false);
    assert(
      !mismatched.get("neighbor")?.result.includes("Configuration loaded"),
    );
    const rotatedExecution = crypto.randomUUID();
    const rotatedRecipient = {
      parentSessionId: owner.id,
      executionId: rotatedExecution,
    };
    const stageDelegated = (component: string) =>
      Deno.writeTextFile(
        proposal,
        JSON.stringify({ name: alias, component, delegated: rotatedRecipient }),
        { mode: 0o600 },
      );
    await gateway.stop();
    gateway = await launch();
    await stageDelegated("config");
    const approvedBefore = await inspect();
    const bindRotated = apply(approvedBefore.revision);
    await gateway.approve(true);
    assertEquals(
      JSON.parse((await bindRotated).text).binding.delegated,
      rotatedRecipient,
    );
    const rotatedIdentity = await delegatedSubagentIdentity(
      owner.id,
      rotatedExecution,
    );
    const rotatedKey = await assignmentRecoveryKey(
      rotatedIdentity.sessionId,
      rotatedIdentity.executionId,
    );
    let diagnosticDeliveries = 0;
    await runModel(undefined, async (factory, config) => {
      await gateway.stop();
      gateway = await launch(true, false, subagent(factory, config));
      assertStringIncludes(
        await gateway.command(`/recover-subagent ${rotatedExecution} ${task}`),
        "paused",
      );
      const saved = withRecovery((store) => store.read(rotatedKey));
      assert(saved?.status === "paused" && saved.checkpoint);
      assertEquals(saved.tools.length, 1);
      await stageDelegated("providers");
      const replacement = await inspect();
      const replaced = apply(replacement.revision);
      await gateway.approve(true);
      assertEquals(
        JSON.parse((await replaced).text).binding.delegated,
        rotatedRecipient,
      );
      assert(replacement.revision !== approvedBefore.revision);
      assertStringIncludes(
        await gateway.command(
          `/recover-subagent --resume-paused ${rotatedExecution} ${task}`,
        ),
        "saved tool result is blocked",
      );
      assertEquals(diagnosticDeliveries, 1);
    }, () => {
      diagnosticDeliveries++;
      if (diagnosticDeliveries === 1) {
        assert(withRecovery((store) => store.requestPause(rotatedKey)));
      }
    });
    const invoked = actual.length;
    await gateway.stop();
    gateway = await launch(false);
    assertStringIncludes((await gateway.turn(alias)).text, "unavailable");
    assert(!aliasAdvertised);
    assertEquals(actual.length, invoked);
  } finally {
    await gateway.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
