import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import {
  createDefaultRules,
  createHookRunner,
  type HookLogEntry,
} from "../../src/core/policy/hooks/hooks.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";

const fixtureResult = JSON.stringify({
  _classification: "INTERNAL",
  value: "private response fixture",
});

async function run(
  source: "interactive" | "delegated" | "scheduler",
  decision: "allow" | "block" | "throw" | "pre" | "output",
  targetClassification: ClassificationLevel = "INTERNAL",
  resumeFormat?: "native" | "legacy",
  name = "fixture",
  toolCeiling: ClassificationLevel = "INTERNAL",
) {
  const audit: HookLogEntry[] = [];
  const events: unknown[] = [];
  const providerTools: string[] = [];
  const authorized: string[] = [];
  let executions = 0;
  let escalated: ClassificationLevel = "PUBLIC";
  const engine = createPolicyEngine();
  for (const rule of createDefaultRules()) engine.addRule(rule);
  if (decision === "block" || decision === "pre" || decision === "output") {
    engine.addRule({
      id: "fixture-denial",
      priority: 999,
      hook: decision === "block"
        ? "POST_TOOL_RESPONSE"
        : decision === "pre"
        ? "PRE_TOOL_CALL"
        : "PRE_OUTPUT",
      conditions: decision === "block"
        ? [{
          field: "tool_response",
          operator: "equals",
          value: fixtureResult,
        }, {
          field: "session_taint",
          operator: "equals",
          value: "INTERNAL",
        }]
        : [],
      action: "BLOCK",
      message: "fixture blocked",
    });
  }
  const hooked = createHookRunner(engine, {
    logger: { log: (entry) => audit.push(entry) },
  });
  const providers = createProviderRegistry();
  providers.register({
    name: "fixture",
    supportsStreaming: false,
    complete(messages) {
      const tool = messages.find(({ role }) => role === "tool");
      if (tool) providerTools.push(String(tool.content));
      return Promise.resolve({
        content: tool ? "Fixture complete." : "",
        toolCalls: tool ? [] : [{
          id: "test-tool",
          type: "function",
          function: { name, arguments: "{}" },
        }],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
  });
  providers.setDefault("fixture");
  const agent = createOrchestrator({
    hookRunner: {
      evaluateHook(hook, context) {
        if (decision === "throw" && hook === "POST_TOOL_RESPONSE") {
          return Promise.reject(new Error(fixtureResult));
        }
        return hooked.evaluateHook(hook, context);
      },
    },
    providerRegistry: providers,
    getSessionTaint: () => escalated,
    escalateTaint: (level) => {
      escalated = level;
    },
    isOwnerSession: () => source === "interactive",
    isTriggerSession: () => source === "scheduler",
    toolClassifications: new Map([[name, "PUBLIC"]]),
    getNonOwnerCeiling: () => toolCeiling,
    tools: [{ name, description: "Test reader", parameters: {} }],
    toolExecutor: () => {
      executions++;
      return Promise.resolve(fixtureResult);
    },
    onEvent: (event) => events.push(event),
    onAuthorizedToolResponse: (_name, _args, result) => authorized.push(result),
  });
  const message = "Run the test reader.";
  const result = await agent.executeAgentTurn({
    session: createSession({
      userId: "fixture" as UserId,
      channelId: source as ChannelId,
    }),
    message,
    targetClassification,
    ...(resumeFormat && {
      resumeClassification: "INTERNAL",
      resumeMessageIndex: 0,
      resumeToolCalls: [{ name: "fixture", args: {} }],
      resume: {
        history: [
          { role: "user", content: message },
          { role: "assistant", content: " " },
          resumeFormat === "native"
            ? { role: "tool", content: fixtureResult }
            : {
              role: "user",
              content:
                `[TOOL_RESULT name="fixture"]\n${fixtureResult}\n[/TOOL_RESULT]`,
            },
        ],
        completedIterations: 1,
        tokenUsage: { inputTokens: 1, outputTokens: 1 },
        nudgeCount: 0,
        eosRetries: 0,
        toolCallCounts: [],
      },
    }),
  });
  return { result, audit, events, providerTools, authorized, executions };
}

for (const source of ["interactive", "delegated", "scheduler"] as const) {
  Deno.test(`Shared POST_TOOL_RESPONSE blocks results after classification for ${source}`, async () => {
    const state = await run(source, "block");
    assert(state.result.ok);
    assertEquals(state.executions, 1);
    assertEquals(state.authorized, []);
    assertEquals(state.providerTools, ["Tool response withheld by policy."]);
    const audit = state.audit.find(({ hook }) => hook === "POST_TOOL_RESPONSE");
    assertEquals(audit?.input, {
      tool_name: "fixture",
      session_taint: "INTERNAL",
      response_length: fixtureResult.length,
    });
    assertEquals(audit?.result.ruleId, "fixture-denial");
    assertEquals(audit?.result.message, undefined);
    assert(!JSON.stringify(state.events).includes("private response fixture"));
  });
}

Deno.test("POST_TOOL_RESPONSE allows by default and PRE_OUTPUT still rejects cross-class output", async () => {
  const allowed = await run("interactive", "allow");
  assert(allowed.result.ok);
  assertEquals(allowed.authorized, [fixtureResult]);
  assertEquals(allowed.providerTools, [fixtureResult]);
  const blocked = await run("delegated", "allow", "PUBLIC");
  assert(!blocked.result.ok);
  assertStringIncludes(blocked.result.error, "Write-down violation");
  assertEquals(
    blocked.audit.find(({ hook }) => hook === "PRE_OUTPUT")?.result.allowed,
    false,
  );
});

for (const format of ["native", "legacy"] as const) {
  Deno.test(`Recovery checks saved ${format} responses against the current post-tool policy`, async () => {
    const state = await run("scheduler", "block", "INTERNAL", format);
    assert(!state.result.ok);
    assertStringIncludes(state.result.error, "saved tool result is blocked");
    assertEquals(state.executions, 0);
    assertEquals(state.providerTools, []);
    assertEquals(state.authorized, []);
    assert(!JSON.stringify(state.events).includes("private response fixture"));
  });
}

Deno.test("POST_TOOL_RESPONSE fails closed on hook exceptions and never executes for PRE denial", async () => {
  const failed = await run("interactive", "throw");
  assertEquals(failed.providerTools, ["Tool response withheld by policy."]);
  assertEquals(failed.authorized, []);
  assert(!JSON.stringify(failed.events).includes("private response fixture"));
  const denied = await run("interactive", "pre");
  assertEquals(denied.executions, 0);
  assertEquals(denied.authorized, []);
  assert(!denied.audit.some(({ hook }) => hook === "POST_TOOL_RESPONSE"));
});

Deno.test("Plugin administration requires an owner even with a restricted ceiling", async () => {
  for (const name of ["plugin_install", "plugin_reload", "plugin_scan"]) {
    for (const source of ["delegated", "scheduler"] as const) {
      const denied = await run(
        source,
        "allow",
        "INTERNAL",
        undefined,
        name,
        "RESTRICTED",
      );
      assertEquals(denied.executions, 0);
      assert(
        denied.providerTools.some((result) =>
          result.includes("requires the active owner session")
        ),
      );
    }
  }

  const argumentsForPlugin = ["INTERNAL", undefined, "plugin_reload"] as const;
  const allowed = await run("interactive", "allow", ...argumentsForPlugin);
  assertEquals(allowed.executions, 1);
  assertEquals(allowed.providerTools, [fixtureResult]);
  const pre = await run("interactive", "pre", ...argumentsForPlugin);
  assertEquals(pre.executions, 0);
  const post = await run("interactive", "block", ...argumentsForPlugin);
  assertEquals(post.executions, 1);
  assertEquals(post.providerTools, ["Tool response withheld by policy."]);
  const output = await run("interactive", "output", ...argumentsForPlugin);
  assert(!output.result.ok);
  assertEquals(output.executions, 1);
  assertEquals(
    output.audit.find(({ hook }) => hook === "PRE_OUTPUT")?.result.allowed,
    false,
  );
});
