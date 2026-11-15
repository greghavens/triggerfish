/**
 * Phase 10: Agent Orchestrator
 * Tests MUST FAIL until orchestrator.ts and llm.ts are implemented.
 * Tests LlmProvider interface, provider registry, orchestrator loop.
 */
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
import {
  createProviderRegistry,
  type LlmProvider,
} from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import { LEAKED_INTENT_PATTERN } from "../../src/agent/orchestrator/orchestrator_types.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import {
  createDefaultRules,
  createHookRunner,
} from "../../src/core/policy/hooks/hooks.ts";
import { createSession } from "../../src/core/types/session.ts";
import type { ChannelId, UserId } from "../../src/core/types/session.ts";

// --- Mock LLM Provider ---

function createMockProvider(
  name: string,
  response = "mock response",
): LlmProvider {
  return {
    name,
    supportsStreaming: false,
    // deno-lint-ignore require-await
    async complete(_messages, _tools, _options) {
      return {
        content: response,
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

// --- Provider Registry ---

Deno.test("ProviderRegistry: register and get provider", () => {
  const registry = createProviderRegistry();
  const mock = createMockProvider("test-provider");
  registry.register(mock);
  const retrieved = registry.get("test-provider");
  assertExists(retrieved);
  assertEquals(retrieved!.name, "test-provider");
});

Deno.test("ProviderRegistry: get returns undefined for unregistered", () => {
  const registry = createProviderRegistry();
  assertEquals(registry.get("nonexistent"), undefined);
});

Deno.test("ProviderRegistry: setDefault and getDefault", () => {
  const registry = createProviderRegistry();
  const mock = createMockProvider("primary");
  registry.register(mock);
  registry.setDefault("primary");
  const def = registry.getDefault();
  assertExists(def);
  assertEquals(def!.name, "primary");
});

// --- LlmProvider interface ---

Deno.test("LlmProvider: complete returns content and usage", async () => {
  const provider = createMockProvider("test", "hello world");
  const result = await provider.complete(
    [{ role: "user", content: "hi" }],
    [],
    {},
  );
  assertEquals(result.content, "hello world");
  assertExists(result.usage);
  assert(result.usage.inputTokens > 0);
});

// --- Orchestrator ---

Deno.test("Orchestrator: processes message through full loop", async () => {
  const engine = createPolicyEngine();
  for (const r of createDefaultRules()) engine.addRule(r);
  const runner = createHookRunner(engine);

  const registry = createProviderRegistry();
  registry.register(createMockProvider("mock", "agent response"));
  registry.setDefault("mock");

  const orchestrator = createOrchestrator({
    hookRunner: runner,
    providerRegistry: registry,
  });

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });

  const result = await orchestrator.executeAgentTurn({
    session,
    message: "Hello agent",
    targetClassification: "INTERNAL",
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertExists(result.value.response);
  }
});

// --- PRE_CONTEXT_INJECTION source_type derivation (AGENT-EXEC-3) ---

/** Build an orchestrator that records PRE_CONTEXT_INJECTION hook inputs. */
function createSourceTypeCapture(isOwnerSession?: () => boolean) {
  const engine = createPolicyEngine();
  for (const r of createDefaultRules()) engine.addRule(r);
  const runner = createHookRunner(engine);
  const captured: Record<string, unknown>[] = [];
  const capturingRunner: typeof runner = {
    evaluateHook(hook, context) {
      if (hook === "PRE_CONTEXT_INJECTION") captured.push(context.input);
      return runner.evaluateHook(hook, context);
    },
  };

  const registry = createProviderRegistry();
  registry.register(createMockProvider("mock"));
  registry.setDefault("mock");

  const orchestrator = createOrchestrator({
    hookRunner: capturingRunner,
    providerRegistry: registry,
    isOwnerSession,
  });
  return { orchestrator, captured };
}

async function runSourceTypeTurn(
  orchestrator: ReturnType<typeof createOrchestrator>,
): Promise<void> {
  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  const result = await orchestrator.executeAgentTurn({
    session,
    message: "hello",
    targetClassification: "INTERNAL",
  });
  assertEquals(result.ok, true);
}

Deno.test("PreContextHook: non-owner turn labels input NON_OWNER", async () => {
  const { orchestrator, captured } = createSourceTypeCapture(() => false);
  await runSourceTypeTurn(orchestrator);
  assertEquals(captured.length, 1);
  assertEquals(captured[0].source_type, "NON_OWNER");
});

Deno.test("PreContextHook: owner turn labels input OWNER", async () => {
  const { orchestrator, captured } = createSourceTypeCapture(() => true);
  await runSourceTypeTurn(orchestrator);
  assertEquals(captured.length, 1);
  assertEquals(captured[0].source_type, "OWNER");
});

Deno.test("PreContextHook: missing isOwnerSession defaults to NON_OWNER", async () => {
  const { orchestrator, captured } = createSourceTypeCapture(undefined);
  await runSourceTypeTurn(orchestrator);
  assertEquals(captured.length, 1);
  assertEquals(captured[0].source_type, "NON_OWNER");
});

Deno.test("Orchestrator: blocks output when write-down would occur", async () => {
  const engine = createPolicyEngine();
  for (const r of createDefaultRules()) engine.addRule(r);
  const runner = createHookRunner(engine);

  const registry = createProviderRegistry();
  registry.register(createMockProvider("mock"));
  registry.setDefault("mock");

  const orchestrator = createOrchestrator({
    hookRunner: runner,
    providerRegistry: registry,
  });

  // Session already tainted to RESTRICTED
  let session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  const { updateTaint } = await import("../../src/core/types/session.ts");
  session = updateTaint(session, "RESTRICTED", "secret doc");

  // Trying to output to PUBLIC channel should be blocked
  const result = await orchestrator.executeAgentTurn({
    session,
    message: "tell me the secret",
    targetClassification: "PUBLIC",
  });
  assertEquals(result.ok, false);
});

Deno.test("Orchestrator: maintains conversation history per session", async () => {
  const engine = createPolicyEngine();
  const runner = createHookRunner(engine);
  const registry = createProviderRegistry();
  registry.register(createMockProvider("mock", "response"));
  registry.setDefault("mock");

  const orchestrator = createOrchestrator({
    hookRunner: runner,
    providerRegistry: registry,
  });

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });

  await orchestrator.executeAgentTurn({
    session,
    message: "first message",
    targetClassification: "INTERNAL",
  });

  const history = orchestrator.getHistory(session.id);
  assert(history.length >= 2); // user message + assistant response
});

Deno.test("Orchestrator: loads SPINE.md as system prompt foundation", async () => {
  const engine = createPolicyEngine();
  const runner = createHookRunner(engine);
  const registry = createProviderRegistry();

  // Track what system prompt the provider receives
  let receivedSystemPrompt = "";
  const trackingProvider: LlmProvider = {
    name: "tracking",
    supportsStreaming: false,
    // deno-lint-ignore require-await
    async complete(messages, _tools, _options) {
      const system = messages.find((m) => m.role === "system");
      if (system) receivedSystemPrompt = system.content as string;
      return {
        content: "ok",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  registry.register(trackingProvider);
  registry.setDefault("tracking");

  const orchestrator = createOrchestrator({
    hookRunner: runner,
    providerRegistry: registry,
    spinePath: "/tmp/test-spine.md",
  });

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  await orchestrator.executeAgentTurn({
    session,
    message: "hi",
    targetClassification: "INTERNAL",
  });

  // Orchestrator should include SPINE.md content or a default system prompt
  assert(receivedSystemPrompt.length > 0, "System prompt should not be empty");
});

Deno.test("Orchestrator: parses native tool calls (OpenAI format)", async () => {
  const engine = createPolicyEngine();
  const runner = createHookRunner(engine);
  const registry = createProviderRegistry();

  // Provider returns a native tool call, then a final response
  let callCount = 0;
  const toolProvider: LlmProvider = {
    name: "tool-test",
    supportsStreaming: false,
    // deno-lint-ignore require-await
    async complete(_messages, _tools, _options) {
      callCount++;
      if (callCount === 1) {
        return {
          content: "",
          toolCalls: [{
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"path":"/tmp/test.txt"}',
            },
          }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      return {
        content: "Done reading file.",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  registry.register(toolProvider);
  registry.setDefault("tool-test");

  let executedArgs: Record<string, unknown> = {};
  const orchestrator = createOrchestrator({
    hookRunner: runner,
    providerRegistry: registry,
    tools: [{
      name: "read_file",
      description: "Read a file",
      parameters: {
        path: { type: "string", description: "path", required: true },
      },
    }],
    // deno-lint-ignore require-await
    toolExecutor: async (_name, input) => {
      executedArgs = input;
      return "file content";
    },
  });

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  await orchestrator.executeAgentTurn({
    session,
    message: "read it",
    targetClassification: "INTERNAL",
  });
  assertEquals(executedArgs.path, "/tmp/test.txt");
});

Deno.test("Orchestrator: parses native tool calls (Anthropic format)", async () => {
  const engine = createPolicyEngine();
  const runner = createHookRunner(engine);
  const registry = createProviderRegistry();

  let callCount = 0;
  const toolProvider: LlmProvider = {
    name: "tool-test",
    supportsStreaming: false,
    // deno-lint-ignore require-await
    async complete(_messages, _tools, _options) {
      callCount++;
      if (callCount === 1) {
        return {
          content: "",
          toolCalls: [{
            type: "tool_use",
            name: "run_command",
            input: { command: "ls -la" },
          }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      return {
        content: "Listed files.",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  registry.register(toolProvider);
  registry.setDefault("tool-test");

  let executedArgs: Record<string, unknown> = {};
  const orchestrator = createOrchestrator({
    hookRunner: runner,
    providerRegistry: registry,
    tools: [{
      name: "run_command",
      description: "Run command",
      parameters: {
        command: { type: "string", description: "cmd", required: true },
      },
    }],
    // deno-lint-ignore require-await
    toolExecutor: async (_name, input) => {
      executedArgs = input;
      return "output";
    },
  });

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  await orchestrator.executeAgentTurn({
    session,
    message: "run ls",
    targetClassification: "INTERNAL",
  });
  assertEquals(executedArgs.command, "ls -la");
});

Deno.test("Orchestrator: parses native tool calls with nested arguments", async () => {
  const engine = createPolicyEngine();
  const runner = createHookRunner(engine);
  const registry = createProviderRegistry();

  let callCount = 0;
  const toolProvider: LlmProvider = {
    name: "tool-test",
    supportsStreaming: false,
    // deno-lint-ignore require-await
    async complete(_messages, _tools, _options) {
      callCount++;
      if (callCount === 1) {
        return {
          content: "",
          toolCalls: [{
            type: "function",
            function: { name: "list_directory", arguments: '{"path":"/home"}' },
          }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      return {
        content: "Listed dir.",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  registry.register(toolProvider);
  registry.setDefault("tool-test");

  let executedArgs: Record<string, unknown> = {};
  const orchestrator = createOrchestrator({
    hookRunner: runner,
    providerRegistry: registry,
    tools: [{
      name: "list_directory",
      description: "List dir",
      parameters: {
        path: { type: "string", description: "path", required: true },
      },
    }],
    // deno-lint-ignore require-await
    toolExecutor: async (_name, input) => {
      executedArgs = input;
      return "/home/venom";
    },
  });

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  await orchestrator.executeAgentTurn({
    session,
    message: "list home",
    targetClassification: "INTERNAL",
  });
  assertEquals(executedArgs.path, "/home");
});

Deno.test("Orchestrator: parses native tool calls with content alongside", async () => {
  const engine = createPolicyEngine();
  const runner = createHookRunner(engine);
  const registry = createProviderRegistry();

  let callCount = 0;
  const toolProvider: LlmProvider = {
    name: "tool-test",
    supportsStreaming: false,
    // deno-lint-ignore require-await
    async complete(_messages, _tools, _options) {
      callCount++;
      if (callCount === 1) {
        return {
          content: "Running the command now.",
          toolCalls: [{
            type: "function",
            function: {
              name: "run_command",
              arguments: '{"command":"echo hello"}',
            },
          }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      return {
        content: "Echoed.",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  registry.register(toolProvider);
  registry.setDefault("tool-test");

  let executedArgs: Record<string, unknown> = {};
  const orchestrator = createOrchestrator({
    hookRunner: runner,
    providerRegistry: registry,
    tools: [{
      name: "run_command",
      description: "Run command",
      parameters: {
        command: { type: "string", description: "cmd", required: true },
      },
    }],
    // deno-lint-ignore require-await
    toolExecutor: async (_name, input) => {
      executedArgs = input;
      return "hello";
    },
  });

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  await orchestrator.executeAgentTurn({
    session,
    message: "echo",
    targetClassification: "INTERNAL",
  });
  assertEquals(executedArgs.command, "echo hello");
});

Deno.test("Orchestrator: uses default prompt when SPINE.md absent", async () => {
  const engine = createPolicyEngine();
  const runner = createHookRunner(engine);
  const registry = createProviderRegistry();
  registry.register(createMockProvider("mock", "ok"));
  registry.setDefault("mock");

  const orchestrator = createOrchestrator({
    hookRunner: runner,
    providerRegistry: registry,
    spinePath: "/nonexistent/SPINE.md",
  });

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  const result = await orchestrator.executeAgentTurn({
    session,
    message: "hi",
    targetClassification: "INTERNAL",
  });
  assertEquals(result.ok, true);
});

// --- LEAKED_INTENT_PATTERN tests ---

Deno.test("LEAKED_INTENT_PATTERN: matches common leaked-intent phrases", () => {
  const positives = [
    "I'll search for restaurants in Austin.",
    "Let me fetch that page for you.",
    "I need to look up the details.",
    "I should search for more information.",
    "I will fetch the content now.",
    "Let me find the best results.",
    "I can search for that.",
    "I am going to fetch the page.",
    "We need to fetch details.",
    "I need to retrieve the data.",
    "Let me browse the web for that.",
    "Let me use web_search to find it.",
  ];
  for (const phrase of positives) {
    assert(LEAKED_INTENT_PATTERN.test(phrase), `Should match: "${phrase}"`);
  }
});

Deno.test("LEAKED_INTENT_PATTERN: does not match normal response text", () => {
  const negatives = [
    "Based on my search of the documents, here are the results.",
    "The search engine returned 5 results.",
    "Here are the best fried fish restaurants in South Austin.",
    "I found 3 great options for you.",
    "The fetched data shows interesting trends.",
    "According to the website, the restaurant opens at 11am.",
    "Search results indicate several options.",
  ];
  for (const phrase of negatives) {
    assert(
      !LEAKED_INTENT_PATTERN.test(phrase),
      `Should NOT match: "${phrase}"`,
    );
  }
});

// Note: The leaked-intent guard was removed from the orchestrator because it
// caused blank responses with some LLM providers. The LEAKED_INTENT_PATTERN
// regex is still exported and tested above for potential future use.

// --- isTriggerSession tests ---

Deno.test("Orchestrator: isTriggerSession=undefined is always false (default deny)", async () => {
  // Without isTriggerSession set, the orchestrator should NOT behave as a trigger session.
  // isOwnerSession && !isOwnerSession() = false (isOwnerSession is undefined) — the
  // non-owner check is skipped. This is the legacy behaviour, not the trigger behaviour.
  // This test documents the baseline: isTrigger defaults to false.
  const engine = createPolicyEngine();
  for (const r of createDefaultRules()) engine.addRule(r);
  const runner = createHookRunner(engine);
  const registry = createProviderRegistry();
  registry.register(createMockProvider("mock", "response"));
  registry.setDefault("mock");

  const orchestrator = createOrchestrator({
    hookRunner: runner,
    providerRegistry: registry,
    tools: [{
      name: "read_file",
      description: "Read a file",
      parameters: { path: { type: "string", description: "path" } },
    }],
    toolExecutor: (name) => `${name} result`,
    // isTriggerSession not set — must be false per "undefined is always false" rule
  });

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  // With no isOwnerSession or isTriggerSession set, the non-owner check is bypassed
  // (legacy behaviour). The tool runs because neither check activates.
  const result = await orchestrator.executeAgentTurn({
    session,
    message: "do something",
    targetClassification: "INTERNAL",
  });
  // Passes because the orchestrator has no integration toolClassifications blocking it
  assertEquals(result.ok, true);
});

Deno.test("Orchestrator: trigger session allows built-in tools (not blocked as non-owner)", async () => {
  const engine = createPolicyEngine();
  for (const r of createDefaultRules()) engine.addRule(r);
  const runner = createHookRunner(engine);
  const registry = createProviderRegistry();
  registry.register(createMockProvider("mock", "result"));
  registry.setDefault("mock");

  const orchestrator = createOrchestrator({
    hookRunner: runner,
    providerRegistry: registry,
    tools: [{
      name: "memory_save",
      description: "Save memory",
      parameters: {
        key: { type: "string", description: "key" },
        value: { type: "string", description: "value" },
      },
    }],
    toolExecutor: (name) => `${name} saved`,
    isTriggerSession: () => true,
    getNonOwnerCeiling: () => "CONFIDENTIAL" as const,
    toolClassifications: new Map([["gmail_", "CONFIDENTIAL" as const]]),
    getSessionTaint: () => "PUBLIC" as const,
    escalateTaint: () => {},
  });

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  const result = await orchestrator.executeAgentTurn({
    session,
    message: "use memory tool",
    targetClassification: "CONFIDENTIAL",
  });
  // Trigger sessions can call built-in tools (memory_save is not in toolClassifications)
  assertEquals(result.ok, true);
});

Deno.test("Orchestrator: trigger session blocks integration tool above ceiling", async () => {
  const engine = createPolicyEngine();
  for (const r of createDefaultRules()) engine.addRule(r);
  const runner = createHookRunner(engine);
  const registry = createProviderRegistry();

  // Provider returns a tool call to a CONFIDENTIAL integration, then a final response
  let callCount = 0;
  const toolProvider: LlmProvider = {
    name: "tool-test",
    supportsStreaming: false,
    // deno-lint-ignore require-await
    async complete(_messages, _tools, _options) {
      callCount++;
      if (callCount === 1) {
        return {
          content: "",
          toolCalls: [{
            type: "function",
            function: { name: "gmail_list", arguments: "{}" },
          }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      return {
        content: "Done.",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  registry.register(toolProvider);
  registry.setDefault("tool-test");

  let toolResult = "";
  const orchestrator = createOrchestrator({
    hookRunner: runner,
    providerRegistry: registry,
    tools: [{ name: "gmail_list", description: "List gmail", parameters: {} }],
    toolExecutor: (name) => `${name} result`,
    isTriggerSession: () => true,
    // Ceiling is INTERNAL — gmail (CONFIDENTIAL) is above ceiling → blocked
    getNonOwnerCeiling: () => "INTERNAL" as const,
    toolClassifications: new Map([["gmail_", "CONFIDENTIAL" as const]]),
    getSessionTaint: () => "PUBLIC" as const,
    escalateTaint: () => {},
    onEvent: (evt) => {
      if (evt.type === "tool_result") toolResult = evt.result;
    },
  });

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  await orchestrator.executeAgentTurn({
    session,
    message: "list gmail",
    targetClassification: "INTERNAL",
  });
  // gmail_list (CONFIDENTIAL) is above INTERNAL ceiling — should be blocked
  assertStringIncludes(toolResult, "exceeds trigger ceiling");
});

Deno.test("Orchestrator: trigger session allows integration tool at ceiling level", async () => {
  const engine = createPolicyEngine();
  for (const r of createDefaultRules()) engine.addRule(r);
  const runner = createHookRunner(engine);
  const registry = createProviderRegistry();

  let callCount = 0;
  const toolProvider: LlmProvider = {
    name: "tool-test",
    supportsStreaming: false,
    // deno-lint-ignore require-await
    async complete(_messages, _tools, _options) {
      callCount++;
      if (callCount === 1) {
        return {
          content: "",
          toolCalls: [{
            type: "function",
            function: { name: "github_search_repos", arguments: "{}" },
          }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      return {
        content: "Done.",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  registry.register(toolProvider);
  registry.setDefault("tool-test");

  let toolExecuted = false;
  const orchestrator = createOrchestrator({
    hookRunner: runner,
    providerRegistry: registry,
    tools: [{
      name: "github_search_repos",
      description: "Search GitHub repos",
      parameters: {},
    }],
    toolExecutor: () => {
      toolExecuted = true;
      return "repos found";
    },
    isTriggerSession: () => true,
    // Ceiling is INTERNAL — github (INTERNAL) is at ceiling → allowed
    getNonOwnerCeiling: () => "INTERNAL" as const,
    toolClassifications: new Map([["github_", "INTERNAL" as const]]),
    getSessionTaint: () => "PUBLIC" as const,
    escalateTaint: () => {},
  });

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  await orchestrator.executeAgentTurn({
    session,
    message: "search repos",
    targetClassification: "INTERNAL",
  });
  // github_ (INTERNAL) is at the ceiling level — tool should execute
  assertEquals(toolExecuted, true);
});
