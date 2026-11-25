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
  const stage = (component: string) =>
    Deno.writeTextFile(proposal, JSON.stringify({ name: alias, component }), {
      mode: 0o600,
    });
  await stage("providers");
  const owner = createSession({
    userId: "owner" as UserId,
    channelId: "owner" as ChannelId,
  });
  const target = "INTERNAL";
  const actual: unknown[] = [];
  let aliasAdvertised = false;
  let blocked: { hook: string; tool?: string } | undefined;

  async function launch(healthcheck = true, collision = false) {
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
        session: owner,
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
      async approve(approved: boolean, action: "apply" | "retire" = "apply") {
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
