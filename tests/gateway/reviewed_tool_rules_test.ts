import {
  approvalAdviceStore,
  createApprovalAdvisor,
} from "../../src/core/policy/approval_advice.ts";
import { createToolApprovalService } from "../../src/core/tool_approval_service.ts";
import { withReviewedToolRules } from "../../src/core/policy/reviewed_tool_rules.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import { createSqliteStorage } from "../../src/core/storage/sqlite.ts";
import { join } from "@std/path";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";

Deno.test("Reviewed restrictive tool rules retain exact versions across gateway restart", async () => {
  const baseDir = await Deno.makeTempDir();
  const token = crypto.randomUUID();
  let args: Record<string, unknown> | undefined;
  let toolResult = "";
  let allow = true;
  let reviews = 0;
  let baseAsks = false;
  let adviceCalls = 0;
  let blockAdvisorOutput = false;
  let adviceOutputChecks = 0;
  const inbox = createToolApprovalService(join(baseDir, "approvals.db"));
  const registry = createProviderRegistry();
  registry.register({
    name: "named-conversation-fixture",
    supportsStreaming: false,
    complete(history) {
      const usage = { inputTokens: 1, outputTokens: 1 };
      const last = history.at(-1);
      if (last?.role === "tool") {
        toolResult = String(last.content);
        return Promise.resolve({ content: "Updated.", usage, toolCalls: [] });
      }
      if (args) {
        return Promise.resolve({
          content: "",
          usage,
          toolCalls: [{
            id: crypto.randomUUID(),
            type: "function",
            function: {
              name: "operator_runs",
              arguments: JSON.stringify(args),
            },
          }],
        });
      }
      const content = history.filter(({ role }) => role === "user").map(
        ({ content }) => String(content),
      ).join(" | ");
      return Promise.resolve({ content, usage, toolCalls: [] });
    },
  });
  registry.register({
    name: "advisor-fixture",
    supportsStreaming: false,
    complete(history, tools) {
      adviceCalls++;
      assertEquals(tools, []);
      assertEquals(JSON.parse(String(history.at(-1)?.content)), {
        tool: "operator_runs",
        assignmentScoped: false,
      });
      return Promise.resolve({
        content: "caution",
        usage: { inputTokens: 7, outputTokens: 1 },
        toolCalls: [],
      });
    },
  });
  registry.setDefault("named-conversation-fixture");
  const open = (messages: ReturnType<typeof createMessageStore>) =>
    createGatewayServer({
      token,
      port: 0,
      chatSession: createChatSession({
        session: createSession({
          userId: "owner" as UserId,
          channelId: "named-conversations-fixture" as ChannelId,
        }),
        customToolsBaseDir: baseDir,
        providerRegistry: registry,
        messageStore: messages,
        hookRunner: withReviewedToolRules({
          toolApprovalInbox: inbox,
          reviewApprovalAdvice: createApprovalAdvisor(baseDir, registry, {
            INTERNAL: ["advisor-fixture"],
          }),
          evaluateHook: (hook, context) => {
            if (
              hook === "PRE_OUTPUT" &&
              context.input.operation === "tool_approval_advice"
            ) {
              adviceOutputChecks++;
              assertEquals(context.input.destination, "advisor-fixture");
              return Promise.resolve({
                allowed: !blockAdvisorOutput,
                action: blockAdvisorOutput ? "BLOCK" : "ALLOW",
                ruleId: blockAdvisorOutput ? "fixture-output-policy" : null,
                duration: 0,
              });
            }
            const ask = baseAsks && hook === "PRE_TOOL_CALL" &&
              context.input.tool_name === "operator_runs" &&
              (context.input.tool_call as
                  | { args?: Record<string, unknown> }
                  | undefined)
                  ?.args?.action === "list";
            return Promise.resolve({
              allowed: !ask,
              action: ask ? "REQUIRE_APPROVAL" : "ALLOW",
              ruleId: ask ? "fixture-base-policy" : null,
              duration: 0,
            });
          },
        }, baseDir),
        operatorRunExecutor: createOperatorRunToolExecutor({
          baseDir,
          approvalReviewerProfiles: () => [{ provider: "advisor-fixture" }],
          confirm: () => {
            reviews++;
            return Promise.resolve(allow);
          },
        }),
      }),
    });
  async function withGateway<T>(
    exercise: (
      turn: (text: string) => Promise<{ text: string; tool: string }>,
      manage: (action: Record<string, unknown>) => Promise<string>,
      port: number,
    ) => Promise<T>,
  ) {
    const storage = createSqliteStorage(join(baseDir, "messages.db"));
    const gateway = open(createMessageStore(storage));
    const { port } = await gateway.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      const turn = (content: string) =>
        new Promise<{ text: string; tool: string }>((resolve, reject) => {
          toolResult = "";
          let text = "";
          const listener = ({ data }: MessageEvent) => {
            const frame = JSON.parse(String(data));
            if (frame.type === "response") text = frame.text;
            if (frame.type === "error") text = frame.message;
            if (frame.type !== "turn_end") return;
            clearTimeout(timer);
            socket.removeEventListener("message", listener);
            resolve({ text, tool: toolResult });
          };
          const timer = setTimeout(() => {
            socket.removeEventListener("message", listener);
            reject(new Error("Named conversation turn did not finish"));
          }, 5000);
          socket.addEventListener("message", listener);
          socket.send(JSON.stringify({ type: "message", content }));
        });
      return await exercise(turn, async (action) => {
        args = action;
        try {
          return (await turn("Manage the selected conversation.")).tool;
        } finally {
          args = undefined;
        }
      }, port);
    } finally {
      socket.close();
      await gateway.stop();
      await storage.close();
    }
  }

  const id = crypto.randomUUID();
  const rule = {
    action: "set_reviewed_tool_rule",
    id,
    expectedVersion: 0,
    requestId: crypto.randomUUID(),
    reviewedRule: { effect: "block", enabled: true },
  };
  try {
    await withGateway(async (_turn, manage) => {
      allow = false;
      assertStringIncludes(await manage(rule), "declined");
      allow = true;
      assertEquals(JSON.parse(await manage(rule)).result.version, 1);
      assertEquals(JSON.parse(await manage(rule)).result.version, 1);
      assertEquals(reviews, 2);
      assertStringIncludes(await manage({ action: "list" }), "blocked");
      assertEquals(
        JSON.parse(await manage({ action: "reviewed_tool_rules" })).rules
          .length,
        1,
      );
    });
    await withGateway(async (_turn, manage) => {
      assertStringIncludes(await manage({ action: "list" }), "blocked");
      assertStringIncludes(
        await manage({ ...rule, requestId: crypto.randomUUID() }),
        "unavailable",
      );
      const updated = await manage({
        ...rule,
        expectedVersion: 1,
        requestId: crypto.randomUUID(),
        reviewedRule: { effect: "block", enabled: false },
      });
      assertEquals(JSON.parse(updated).result.version, 2);
      assertEquals(
        JSON.parse(await manage({ action: "reviewed_tool_rules" })).rules[0]
          .rule.enabled,
        false,
      );
      assertEquals(
        JSON.parse(
          await manage({
            action: "delete_reviewed_tool_rule",
            id,
            expectedVersion: 2,
            requestId: crypto.randomUUID(),
          }),
        ).result.rule,
        null,
      );
      assertEquals(
        JSON.parse(await manage({ action: "reviewed_tool_rules" })).rules,
        [],
      );
      const ask = await manage({
        ...rule,
        expectedVersion: 3,
        requestId: crypto.randomUUID(),
        reviewedRule: { effect: "ask", enabled: true, tool: "operator_runs" },
      });
      assertEquals(JSON.parse(ask).result.version, 4);
    });
    await withGateway(async (_turn, manage, port) => {
      const reviewer = new WebSocket(
        `ws://127.0.0.1:${port}/chat?token=${token}`,
      );
      try {
        await new Promise<void>((resolve, reject) => {
          reviewer.addEventListener("open", () => resolve(), { once: true });
          reviewer.addEventListener("error", reject, { once: true });
        });
        async function request(input: Record<string, unknown>) {
          const requestId = crypto.randomUUID();
          const reply = Promise.withResolvers<Record<string, unknown>>();
          const timer = setTimeout(
            () => reply.reject(new Error("No approval reply")),
            2000,
          );
          const receive = ({ data }: MessageEvent) => {
            const result = JSON.parse(String(data));
            if (
              result.type === "approval_inbox_result" &&
              result.requestId === requestId
            ) reply.resolve(result);
          };
          reviewer.addEventListener("message", receive);
          reviewer.send(JSON.stringify({ ...input, requestId }));
          return await reply.promise.finally(() => {
            clearTimeout(timer);
            reviewer.removeEventListener("message", receive);
          });
        }
        const reviewerSetting = {
          action: "set_reviewed_tool_reviewer",
          modelProfile: "advisor-fixture",
          expectedVersion: 0,
          requestId: crypto.randomUUID(),
        };
        assertEquals(
          JSON.parse(await manage(reviewerSetting)).setting.version,
          1,
        );
        assertEquals(
          JSON.parse(await manage(reviewerSetting)).setting.version,
          1,
        );
        for (const approved of [false, true]) {
          const turn = manage({ action: "list" });
          let id: string | undefined;
          for (let attempt = 0; attempt < 50 && !id; attempt++) {
            const page = await request({ type: "approval_inbox_list" });
            const result = page.result as {
              records: { id: string; status: string }[];
            };
            id = result.records.find((item) => item.status === "pending")?.id;
            if (!id) await new Promise((resolve) => setTimeout(resolve, 10));
          }
          if (!id) throw new Error("Tool did not enter reviewed approval");
          assertEquals(
            (await request({
              type: "approval_inbox_decide",
              approvalId: id,
              approved,
            })).ok,
            true,
          );
          if (approved) assertEquals(typeof JSON.parse(await turn), "object");
          else assertStringIncludes(await turn, "denied");
        }
        assertEquals(adviceCalls, 0);
        assertEquals(
          JSON.parse(
            await manage({
              ...rule,
              expectedVersion: 4,
              requestId: crypto.randomUUID(),
              reviewedRule: { effect: "ask", enabled: false },
            }),
          ).result.version,
          5,
        );
        baseAsks = true;
        try {
          const turn = manage({ action: "list" });
          let advisorId: string | undefined;
          for (let attempt = 0; attempt < 50 && !advisorId; attempt++) {
            const page = await request({ type: "approval_inbox_list" });
            const result = page.result as {
              records: { id: string; status: string }[];
            };
            const pending = result.records.find((item) =>
              item.status === "pending"
            );
            if (
              pending &&
              approvalAdviceStore(baseDir).read(pending.id)?.verdict ===
                "caution"
            ) {
              advisorId = pending.id;
            } else {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          if (!advisorId) {
            throw new Error(
              "Advisory result did not preserve pending approval",
            );
          }
          assertEquals(adviceCalls, 1);
          assertEquals(adviceOutputChecks, 1);
          assertEquals(
            (await request({
              type: "approval_inbox_decide",
              approvalId: advisorId,
              approved: false,
            })).ok,
            true,
          );
          assertStringIncludes(await turn, "denied");
          assertEquals(
            JSON.parse(
              await manage({
                action: "reviewed_tool_advice",
                id: advisorId,
              }),
            ).advice,
            {
              id: advisorId,
              version: 1,
              verdict: "caution",
              inputTokens: 7,
              outputTokens: 1,
            },
          );
          assertEquals(
            JSON.parse(
              await manage({
                action: "reviewed_tool_reviewer",
              }),
            ).usage,
            [{
              version: 1,
              requests: 1,
              profile: { provider: "advisor-fixture" },
              inputTokens: 7,
              outputTokens: 1,
            }],
          );
          blockAdvisorOutput = true;
          const blockedTurn = manage({ action: "list" });
          let blockedId: string | undefined;
          for (let attempt = 0; attempt < 50 && !blockedId; attempt++) {
            const page = await request({ type: "approval_inbox_list" });
            const result = page.result as {
              records: { id: string; status: string }[];
            };
            blockedId = result.records.find((item) => item.status === "pending")
              ?.id;
            if (!blockedId) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          if (!blockedId) {
            throw new Error("Output denial changed the tool approval gate");
          }
          assertEquals(adviceOutputChecks, 2);
          assertEquals(adviceCalls, 1);
          assertEquals(approvalAdviceStore(baseDir).read(blockedId), undefined);
          assertEquals(
            (await request({
              type: "approval_inbox_decide",
              approvalId: blockedId,
              approved: false,
            })).ok,
            true,
          );
          assertStringIncludes(await blockedTurn, "denied");
        } finally {
          baseAsks = false;
        }
      } finally {
        reviewer.close();
      }
    });
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
