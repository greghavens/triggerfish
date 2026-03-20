/**
 * End-to-end resource classification tests.
 *
 * Validates the universal resource classification system (Bug 1 + Bug 2 + Bug 3 fixes):
 * - Filesystem path classification and taint escalation
 * - URL domain classification and taint escalation
 * - Write-down blocking for both paths and URLs
 * - Non-owner ceiling enforcement for URLs
 * - Collapsed code paths (single security + execution path)
 */
import { assert, assertEquals } from "@std/assert";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import {
  createDefaultRules,
  createHookRunner,
} from "../../src/core/policy/hooks/hooks.ts";
import { createSession, updateTaint } from "../../src/core/types/session.ts";
import type { ChannelId, UserId } from "../../src/core/types/session.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";
import type { LlmProvider } from "../../src/agent/llm.ts";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { PathClassifier } from "../../src/core/security/path_classification.ts";
import type { DomainClassifier } from "../../src/tools/web/domains.ts";
import { mapToolPrefixClassifications } from "../../src/agent/orchestrator/orchestrator_types.ts";

// --- Test helpers ---

function makeHookRunner() {
  const engine = createPolicyEngine();
  for (const rule of createDefaultRules()) {
    engine.addRule(rule);
  }
  return createHookRunner(engine);
}

/** Mock path classifier that maps specific paths to classifications. */
function createMockPathClassifier(
  mappings: Record<string, ClassificationLevel>,
  defaultLevel: ClassificationLevel = "INTERNAL",
): PathClassifier {
  return {
    classify(path: string) {
      for (const [pattern, level] of Object.entries(mappings)) {
        if (path.includes(pattern)) {
          return { classification: level, source: "configured" as const };
        }
      }
      return { classification: defaultLevel, source: "default" as const };
    },
  };
}

/** Mock domain classifier that maps URL patterns to classifications. */
function createMockDomainClassifier(
  mappings: Record<string, ClassificationLevel>,
  defaultLevel: ClassificationLevel = "PUBLIC",
): DomainClassifier {
  return {
    classify(url: string) {
      for (const [pattern, level] of Object.entries(mappings)) {
        if (url.includes(pattern)) {
          return { classification: level, source: "domain-policy" };
        }
      }
      return { classification: defaultLevel, source: "domain-policy" };
    },
  };
}

/**
 * Create a mock LLM provider that issues a single tool call, then returns final text.
 */
function createToolCallingProvider(
  toolName: string,
  toolArgs: Record<string, unknown>,
): LlmProvider {
  let callCount = 0;
  return {
    name: "mock-tool-caller",
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
              name: toolName,
              arguments: JSON.stringify(toolArgs),
            },
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
}

/**
 * Create a mock provider that issues two sequential tool calls.
 */
function createTwoToolProvider(
  tool1: { name: string; args: Record<string, unknown> },
  tool2: { name: string; args: Record<string, unknown> },
): LlmProvider {
  let callCount = 0;
  return {
    name: "mock-two-tool",
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
              name: tool1.name,
              arguments: JSON.stringify(tool1.args),
            },
          }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      if (callCount === 2) {
        return {
          content: "",
          toolCalls: [{
            type: "function",
            function: {
              name: tool2.name,
              arguments: JSON.stringify(tool2.args),
            },
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
}

const TOOL_DEFS = [
  {
    name: "read_file",
    description: "Read",
    parameters: { path: { type: "string", description: "p", required: true } },
  },
  {
    name: "edit_file",
    description: "Edit",
    parameters: {
      path: { type: "string", description: "p", required: true },
      content: { type: "string", description: "c", required: true },
    },
  },
  {
    name: "write_file",
    description: "Write",
    parameters: {
      path: { type: "string", description: "p", required: true },
      content: { type: "string", description: "c", required: true },
    },
  },
  {
    name: "list_directory",
    description: "List",
    parameters: { path: { type: "string", description: "p", required: true } },
  },
  {
    name: "search_files",
    description: "Search",
    parameters: {
      search_path: { type: "string", description: "p", required: true },
      pattern: { type: "string", description: "pat", required: true },
    },
  },
  {
    name: "web_fetch",
    description: "Fetch",
    parameters: { url: { type: "string", description: "u", required: true } },
  },
  {
    name: "browser_navigate",
    description: "Navigate",
    parameters: { url: { type: "string", description: "u", required: true } },
  },
  {
    name: "browser_type",
    description: "Type",
    parameters: {
      url: { type: "string", description: "u", required: true },
      text: { type: "string", description: "t", required: true },
    },
  },
  {
    name: "memory_save",
    description: "Save memory",
    parameters: {
      key: { type: "string", description: "k", required: true },
      value: { type: "string", description: "v", required: true },
    },
  },
  {
    name: "memory_search",
    description: "Search memory",
    parameters: { query: { type: "string", description: "q", required: true } },
  },
  {
    name: "secret_save",
    description: "Save secret",
    parameters: {
      name: { type: "string", description: "n", required: true },
      value: { type: "string", description: "v", required: true },
    },
  },
  {
    name: "gmail_send",
    description: "Send email",
    parameters: {
      to: { type: "string", description: "to", required: true },
      subject: { type: "string", description: "s", required: true },
      body: { type: "string", description: "b", required: true },
    },
  },
];

// --- Test 1: Filesystem read escalates taint (Bug 2 fix) ---

Deno.test("resource-classification: filesystem read escalates taint then blocks write-down", async () => {
  const hookRunner = makeHookRunner();
  const pathClassifier = createMockPathClassifier({
    "finance": "CONFIDENTIAL",
  });

  let sessionTaint: ClassificationLevel = "INTERNAL";
  const escalations: Array<{ level: ClassificationLevel; reason: string }> = [];

  const registry = createProviderRegistry();
  registry.register(createTwoToolProvider(
    { name: "read_file", args: { path: "~/Documents/finance/q4.xlsx" } },
    {
      name: "write_file",
      args: { path: "internal/notes.txt", content: "data" },
    },
  ));
  registry.setDefault("mock-two-tool");

  const toolResults: Array<{ name: string; blocked: boolean }> = [];

  const orchestrator = createOrchestrator({
    hookRunner,
    providerRegistry: registry,
    tools: TOOL_DEFS,
    // deno-lint-ignore require-await
    toolExecutor: async (_name, _input) => "ok",
    pathClassifier,
    getSessionTaint: () => sessionTaint,
    escalateTaint: (level: ClassificationLevel, reason: string) => {
      escalations.push({ level, reason });
      // Simulate maxClassification logic: only escalate upward
      const order: Record<string, number> = {
        PUBLIC: 0,
        INTERNAL: 1,
        CONFIDENTIAL: 2,
        RESTRICTED: 3,
      };
      if (order[level] > order[sessionTaint]) {
        sessionTaint = level;
      }
    },
    isOwnerSession: () => true,
    onEvent: (event) => {
      if (event.type === "tool_result") {
        toolResults.push({ name: event.name, blocked: event.blocked });
      }
    },
  });

  let session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  session = updateTaint(session, "INTERNAL", "initial");

  const result = await orchestrator.executeAgentTurn({
    session,
    message: "Read finance doc then write notes",
    targetClassification: "CONFIDENTIAL",
  });

  // First tool (read_file) should have escalated taint to CONFIDENTIAL
  assert(escalations.length >= 1, "Should have at least one escalation");
  assertEquals(escalations[0].level, "CONFIDENTIAL");
  assert(
    escalations[0].reason.includes("read_file"),
    "Escalation reason should mention tool name",
  );

  // Second tool (write_file to INTERNAL) should be blocked (write-down: CONFIDENTIAL → INTERNAL)
  assertEquals(toolResults.length, 2);
  assertEquals(
    toolResults[1].blocked,
    true,
    "Write to INTERNAL path should be blocked after CONFIDENTIAL escalation",
  );

  assertEquals(result.ok, true);
});

// --- Test 2: URL fetch escalates taint (Bug 1 + Bug 2 fix) ---

Deno.test("resource-classification: web_fetch escalates taint via domain classification", async () => {
  const hookRunner = makeHookRunner();
  const domainClassifier = createMockDomainClassifier({
    "intranet.corp": "CONFIDENTIAL",
  });

  let sessionTaint: ClassificationLevel = "INTERNAL";
  const escalations: Array<{ level: ClassificationLevel; reason: string }> = [];

  const registry = createProviderRegistry();
  registry.register(createTwoToolProvider(
    {
      name: "web_fetch",
      args: { url: "https://intranet.corp/confidential-report" },
    },
    {
      name: "write_file",
      args: { path: "internal/notes.txt", content: "data" },
    },
  ));
  registry.setDefault("mock-two-tool");

  const toolResults: Array<{ name: string; blocked: boolean }> = [];

  const orchestrator = createOrchestrator({
    hookRunner,
    providerRegistry: registry,
    tools: TOOL_DEFS,
    // deno-lint-ignore require-await
    toolExecutor: async (_name, _input) => "ok",
    domainClassifier,
    pathClassifier: createMockPathClassifier({}, "INTERNAL"),
    getSessionTaint: () => sessionTaint,
    escalateTaint: (level: ClassificationLevel, reason: string) => {
      escalations.push({ level, reason });
      const order: Record<string, number> = {
        PUBLIC: 0,
        INTERNAL: 1,
        CONFIDENTIAL: 2,
        RESTRICTED: 3,
      };
      if (order[level] > order[sessionTaint]) {
        sessionTaint = level;
      }
    },
    isOwnerSession: () => true,
    onEvent: (event) => {
      if (event.type === "tool_result") {
        toolResults.push({ name: event.name, blocked: event.blocked });
      }
    },
  });

  let session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  session = updateTaint(session, "INTERNAL", "initial");

  const result = await orchestrator.executeAgentTurn({
    session,
    message: "Fetch report then write notes",
    targetClassification: "CONFIDENTIAL",
  });

  // web_fetch should have escalated taint to CONFIDENTIAL
  assert(escalations.length >= 1, "Should have at least one escalation");
  assertEquals(escalations[0].level, "CONFIDENTIAL");
  assert(
    escalations[0].reason.includes("web_fetch"),
    "Escalation reason should mention web_fetch",
  );

  // write_file to INTERNAL should be blocked (write-down: CONFIDENTIAL → INTERNAL)
  assertEquals(toolResults.length, 2);
  assertEquals(
    toolResults[1].blocked,
    true,
    "Write to INTERNAL path should be blocked after CONFIDENTIAL escalation via URL",
  );

  assertEquals(result.ok, true);
});

// --- Test 3: Hook-level domain classification for URL tools ---

Deno.test("resource-classification: hook evaluates domain classification for web_fetch", async () => {
  const hookRunner = makeHookRunner();

  // Directly test the hook with resource_classification set (simulates what
  // buildSecurityHookInput now produces for URL tools)
  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  const updatedSession = updateTaint(session, "RESTRICTED", "setup");

  // Write-down: RESTRICTED session writing to PUBLIC domain
  const result = await hookRunner.evaluateHook("PRE_TOOL_CALL", {
    session: updatedSession,
    input: {
      tool_call: {
        name: "browser_type",
        args: { url: "https://public-forum.com/post", text: "secret" },
      },
      resource_classification: "PUBLIC" as ClassificationLevel,
      operation_type: "write",
      is_owner: true,
    },
  });

  assertEquals(result.allowed, false);
  assertEquals(result.ruleId, "resource-write-down");
});

// --- Test 4: Non-owner blocked by domain classification (Bug 1 fix) ---

Deno.test("resource-classification: non-owner blocked when URL domain exceeds ceiling", async () => {
  const hookRunner = makeHookRunner();

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  const updatedSession = updateTaint(session, "INTERNAL", "setup");

  const result = await hookRunner.evaluateHook("PRE_TOOL_CALL", {
    session: updatedSession,
    input: {
      tool_call: {
        name: "web_fetch",
        args: { url: "https://intranet.corp/confidential" },
      },
      resource_classification: "CONFIDENTIAL" as ClassificationLevel,
      operation_type: "read",
      is_owner: false,
      non_owner_ceiling: "INTERNAL" as ClassificationLevel,
    },
  });

  assertEquals(result.allowed, false);
  assertEquals(result.ruleId, "resource-read-ceiling");
});

// --- Test 5: Write-down blocked on URL domain (Bug 1 fix) ---

Deno.test("resource-classification: write-down blocked on URL domain", async () => {
  const hookRunner = makeHookRunner();

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  const updatedSession = updateTaint(session, "RESTRICTED", "setup");

  const result = await hookRunner.evaluateHook("PRE_TOOL_CALL", {
    session: updatedSession,
    input: {
      tool_call: {
        name: "browser_type",
        args: { url: "https://public-forum.com/post", text: "secret data" },
      },
      resource_classification: "PUBLIC" as ClassificationLevel,
      operation_type: "write",
      is_owner: true,
    },
  });

  assertEquals(result.allowed, false);
  assertEquals(result.ruleId, "resource-write-down");
});

// --- Test 6: Write to higher-classified path escalates taint ---

Deno.test("resource-classification: write to higher-classified path escalates taint", async () => {
  const hookRunner = makeHookRunner();
  const pathClassifier = createMockPathClassifier({
    "confidential": "CONFIDENTIAL",
    "internal": "INTERNAL",
  });

  let sessionTaint: ClassificationLevel = "INTERNAL";
  const escalations: Array<{ level: ClassificationLevel; reason: string }> = [];

  const registry = createProviderRegistry();
  registry.register(createTwoToolProvider(
    {
      name: "write_file",
      args: { path: "confidential/report.txt", content: "report" },
    },
    {
      name: "write_file",
      args: { path: "internal/notes.txt", content: "notes" },
    },
  ));
  registry.setDefault("mock-two-tool");

  const toolResults: Array<{ name: string; blocked: boolean }> = [];

  const orchestrator = createOrchestrator({
    hookRunner,
    providerRegistry: registry,
    tools: TOOL_DEFS,
    // deno-lint-ignore require-await
    toolExecutor: async (_name, _input) => "ok",
    pathClassifier,
    getSessionTaint: () => sessionTaint,
    escalateTaint: (level: ClassificationLevel, reason: string) => {
      escalations.push({ level, reason });
      const order: Record<string, number> = {
        PUBLIC: 0,
        INTERNAL: 1,
        CONFIDENTIAL: 2,
        RESTRICTED: 3,
      };
      if (order[level] > order[sessionTaint]) {
        sessionTaint = level;
      }
    },
    isOwnerSession: () => true,
    onEvent: (event) => {
      if (event.type === "tool_result") {
        toolResults.push({ name: event.name, blocked: event.blocked });
      }
    },
  });

  let session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  session = updateTaint(session, "INTERNAL", "initial");

  const result = await orchestrator.executeAgentTurn({
    session,
    message: "Write reports",
    targetClassification: "CONFIDENTIAL",
  });

  // First write (to CONFIDENTIAL path) should escalate taint
  assert(escalations.length >= 1, "Should have at least one escalation");
  assertEquals(escalations[0].level, "CONFIDENTIAL");
  assert(
    escalations[0].reason.includes("write_file"),
    "Reason should mention write_file",
  );

  // Second write (to INTERNAL path) should be blocked (write-down: CONFIDENTIAL → INTERNAL)
  assertEquals(toolResults.length, 2);
  assertEquals(
    toolResults[1].blocked,
    true,
    "Write to INTERNAL should be blocked after CONFIDENTIAL escalation",
  );

  assertEquals(result.ok, true);
});

// --- Test 7: Unmapped URL uses default classification ---

Deno.test("resource-classification: unmapped URL uses default domain classification", async () => {
  const hookRunner = makeHookRunner();

  // Domain classifier with CONFIDENTIAL default for unmapped domains
  const domainClassifier = createMockDomainClassifier({}, "CONFIDENTIAL");

  let sessionTaint: ClassificationLevel = "INTERNAL";
  const escalations: Array<{ level: ClassificationLevel; reason: string }> = [];

  const registry = createProviderRegistry();
  registry.register(createToolCallingProvider("web_fetch", {
    url: "https://random-website.com/page",
  }));
  registry.setDefault("mock-tool-caller");

  const orchestrator = createOrchestrator({
    hookRunner,
    providerRegistry: registry,
    tools: TOOL_DEFS,
    // deno-lint-ignore require-await
    toolExecutor: async (_name, _input) => "ok",
    domainClassifier,
    getSessionTaint: () => sessionTaint,
    escalateTaint: (level: ClassificationLevel, reason: string) => {
      escalations.push({ level, reason });
      const order: Record<string, number> = {
        PUBLIC: 0,
        INTERNAL: 1,
        CONFIDENTIAL: 2,
        RESTRICTED: 3,
      };
      if (order[level] > order[sessionTaint]) {
        sessionTaint = level;
      }
    },
    isOwnerSession: () => true,
  });

  let session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  session = updateTaint(session, "INTERNAL", "initial");

  await orchestrator.executeAgentTurn({
    session,
    message: "Fetch a random page",
    targetClassification: "CONFIDENTIAL",
  });

  // Default is CONFIDENTIAL, session was INTERNAL → should escalate
  assert(
    escalations.length >= 1,
    "Should escalate when default is higher than session taint",
  );
  assertEquals(escalations[0].level, "CONFIDENTIAL");
  assertEquals(
    sessionTaint,
    "CONFIDENTIAL",
    "Session taint should be CONFIDENTIAL after accessing unmapped domain with CONFIDENTIAL default",
  );
});

// --- Test: Collapsed code paths (Bug 3) - plan mode + security in single path ---

Deno.test("resource-classification: plan tool handled without security path, non-plan tool uses security path", async () => {
  // This test verifies that the collapsed code paths work correctly:
  // Plan tools get handled in step 2, non-plan tools go through step 3 (universal security).
  const hookRunner = makeHookRunner();

  const registry = createProviderRegistry();
  registry.register(
    createToolCallingProvider("read_file", { path: "/tmp/test.txt" }),
  );
  registry.setDefault("mock-tool-caller");

  let executedTool = "";
  const orchestrator = createOrchestrator({
    hookRunner,
    providerRegistry: registry,
    tools: TOOL_DEFS,
    // deno-lint-ignore require-await
    toolExecutor: async (name, _input) => {
      executedTool = name;
      return "content";
    },
  });

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  const result = await orchestrator.executeAgentTurn({
    session,
    message: "read file",
    targetClassification: "INTERNAL",
  });

  assertEquals(result.ok, true);
  assertEquals(
    executedTool,
    "read_file",
    "Tool should execute through the universal security path",
  );
});

// --- Test: URL domain classification does not override filesystem classification ---

Deno.test("resource-classification: filesystem classification takes precedence over URL for filesystem tools", async () => {
  const hookRunner = makeHookRunner();

  // Both classifiers present, but read_file should use path classifier
  const pathClassifier = createMockPathClassifier({ "finance": "RESTRICTED" });
  const domainClassifier = createMockDomainClassifier({}, "PUBLIC");

  let sessionTaint: ClassificationLevel = "INTERNAL";
  const escalations: Array<{ level: ClassificationLevel; reason: string }> = [];

  const registry = createProviderRegistry();
  registry.register(
    createToolCallingProvider("read_file", {
      path: "/home/user/finance/q4.xlsx",
    }),
  );
  registry.setDefault("mock-tool-caller");

  const orchestrator = createOrchestrator({
    hookRunner,
    providerRegistry: registry,
    tools: TOOL_DEFS,
    // deno-lint-ignore require-await
    toolExecutor: async (_name, _input) => "ok",
    pathClassifier,
    domainClassifier,
    getSessionTaint: () => sessionTaint,
    escalateTaint: (level: ClassificationLevel, reason: string) => {
      escalations.push({ level, reason });
      const order: Record<string, number> = {
        PUBLIC: 0,
        INTERNAL: 1,
        CONFIDENTIAL: 2,
        RESTRICTED: 3,
      };
      if (order[level] > order[sessionTaint]) {
        sessionTaint = level;
      }
    },
    isOwnerSession: () => true,
  });

  let session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  session = updateTaint(session, "INTERNAL", "initial");

  await orchestrator.executeAgentTurn({
    session,
    message: "read finance file",
    targetClassification: "RESTRICTED",
  });

  // Should escalate to RESTRICTED (from path classifier), not PUBLIC (from domain classifier)
  assert(
    escalations.length >= 1,
    "Should have escalation from path classifier",
  );
  assertEquals(escalations[0].level, "RESTRICTED");
});

// --- Test: read_file on PUBLIC path does NOT escalate (Issue #119 fix) ---

Deno.test("resource-classification: read_file on PUBLIC path does not escalate taint", async () => {
  const hookRunner = makeHookRunner();
  const pathClassifier = createMockPathClassifier(
    { "public-area": "PUBLIC" },
    "INTERNAL",
  );
  const { all: toolClassifications } = mapToolPrefixClassifications({});

  let sessionTaint: ClassificationLevel = "PUBLIC";
  const escalations: Array<{ level: ClassificationLevel; reason: string }> = [];

  const registry = createProviderRegistry();
  registry.register(
    createToolCallingProvider("read_file", {
      path: "/workspace/public-area/readme.txt",
    }),
  );
  registry.setDefault("mock-tool-caller");

  const orchestrator = createOrchestrator({
    hookRunner,
    providerRegistry: registry,
    tools: TOOL_DEFS,
    // deno-lint-ignore require-await
    toolExecutor: async (_name, _input) => "file contents",
    pathClassifier,
    toolClassifications,
    getSessionTaint: () => sessionTaint,
    escalateTaint: (level: ClassificationLevel, reason: string) => {
      escalations.push({ level, reason });
      const order: Record<string, number> = {
        PUBLIC: 0,
        INTERNAL: 1,
        CONFIDENTIAL: 2,
        RESTRICTED: 3,
      };
      if (order[level] > order[sessionTaint]) {
        sessionTaint = level;
      }
    },
    isOwnerSession: () => true,
  });

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  const result = await orchestrator.executeAgentTurn({
    session,
    message: "Read the readme",
    targetClassification: "PUBLIC",
  });

  assertEquals(result.ok, true);
  // Session should remain PUBLIC — read_file prefix classification (INTERNAL)
  // must NOT override the resource classification (PUBLIC)
  assertEquals(
    sessionTaint,
    "PUBLIC",
    "Session taint should remain PUBLIC after reading a PUBLIC-classified file",
  );
});

// --- Test: edit_file on PUBLIC path does NOT escalate (Issue #119 fix) ---

Deno.test("resource-classification: edit_file on PUBLIC path does not escalate taint", async () => {
  const hookRunner = makeHookRunner();
  const pathClassifier = createMockPathClassifier(
    { "public-area": "PUBLIC" },
    "INTERNAL",
  );
  const { all: toolClassifications } = mapToolPrefixClassifications({});

  let sessionTaint: ClassificationLevel = "PUBLIC";
  const escalations: Array<{ level: ClassificationLevel; reason: string }> = [];

  const registry = createProviderRegistry();
  registry.register(
    createToolCallingProvider("edit_file", {
      path: "/workspace/public-area/readme.txt",
      content: "updated",
    }),
  );
  registry.setDefault("mock-tool-caller");

  const orchestrator = createOrchestrator({
    hookRunner,
    providerRegistry: registry,
    tools: TOOL_DEFS,
    // deno-lint-ignore require-await
    toolExecutor: async (_name, _input) => "ok",
    pathClassifier,
    toolClassifications,
    getSessionTaint: () => sessionTaint,
    escalateTaint: (level: ClassificationLevel, reason: string) => {
      escalations.push({ level, reason });
      const order: Record<string, number> = {
        PUBLIC: 0,
        INTERNAL: 1,
        CONFIDENTIAL: 2,
        RESTRICTED: 3,
      };
      if (order[level] > order[sessionTaint]) {
        sessionTaint = level;
      }
    },
    isOwnerSession: () => true,
  });

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  const result = await orchestrator.executeAgentTurn({
    session,
    message: "Edit the readme",
    targetClassification: "PUBLIC",
  });

  assertEquals(result.ok, true);
  // Session should remain PUBLIC — edit_file prefix classification (RESTRICTED)
  // must NOT override the resource classification (PUBLIC)
  assertEquals(
    sessionTaint,
    "PUBLIC",
    "Session taint should remain PUBLIC after editing a PUBLIC-classified file",
  );
});

// --- Test: read_file on INTERNAL path escalates to INTERNAL from resource, not prefix ---

Deno.test("resource-classification: read_file on INTERNAL path escalates via resource classification", async () => {
  const hookRunner = makeHookRunner();
  const pathClassifier = createMockPathClassifier({}, "INTERNAL");
  const { all: toolClassifications } = mapToolPrefixClassifications({});

  let sessionTaint: ClassificationLevel = "PUBLIC";
  const escalations: Array<{ level: ClassificationLevel; reason: string }> = [];

  const registry = createProviderRegistry();
  registry.register(
    createToolCallingProvider("read_file", {
      path: "/workspace/docs/notes.txt",
    }),
  );
  registry.setDefault("mock-tool-caller");

  const orchestrator = createOrchestrator({
    hookRunner,
    providerRegistry: registry,
    tools: TOOL_DEFS,
    // deno-lint-ignore require-await
    toolExecutor: async (_name, _input) => "file contents",
    pathClassifier,
    toolClassifications,
    getSessionTaint: () => sessionTaint,
    escalateTaint: (level: ClassificationLevel, reason: string) => {
      escalations.push({ level, reason });
      const order: Record<string, number> = {
        PUBLIC: 0,
        INTERNAL: 1,
        CONFIDENTIAL: 2,
        RESTRICTED: 3,
      };
      if (order[level] > order[sessionTaint]) {
        sessionTaint = level;
      }
    },
    isOwnerSession: () => true,
  });

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  const result = await orchestrator.executeAgentTurn({
    session,
    message: "Read the notes",
    targetClassification: "INTERNAL",
  });

  assertEquals(result.ok, true);
  assertEquals(
    sessionTaint,
    "INTERNAL",
    "Session taint should escalate to INTERNAL from resource classification",
  );
  // Escalation reason should reference the tool and path, not just "Tool call:"
  assert(escalations.length >= 1, "Should have at least one escalation");
  assert(
    escalations[0].reason.includes("read_file"),
    "Escalation reason should mention read_file",
  );
});

// --- Test: memory_save does NOT escalate taint (operates at session taint) ---

Deno.test("resource-classification: memory_save does not escalate session taint", async () => {
  const hookRunner = makeHookRunner();
  const { all: toolClassifications } = mapToolPrefixClassifications({});

  let sessionTaint: ClassificationLevel = "PUBLIC";
  const escalations: Array<{ level: ClassificationLevel; reason: string }> = [];

  const registry = createProviderRegistry();
  registry.register(
    createToolCallingProvider("memory_save", { key: "test", value: "data" }),
  );
  registry.setDefault("mock-tool-caller");

  const orchestrator = createOrchestrator({
    hookRunner,
    providerRegistry: registry,
    tools: TOOL_DEFS,
    // deno-lint-ignore require-await
    toolExecutor: async (_name, _input) => "saved",
    toolClassifications,
    getSessionTaint: () => sessionTaint,
    escalateTaint: (level: ClassificationLevel, reason: string) => {
      escalations.push({ level, reason });
      const order: Record<string, number> = {
        PUBLIC: 0,
        INTERNAL: 1,
        CONFIDENTIAL: 2,
        RESTRICTED: 3,
      };
      if (order[level] > order[sessionTaint]) {
        sessionTaint = level;
      }
    },
    isOwnerSession: () => true,
  });

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  const result = await orchestrator.executeAgentTurn({
    session,
    message: "Save to memory",
    targetClassification: "RESTRICTED",
  });

  assertEquals(result.ok, true);
  // memory_save is intentionally absent from BUILTIN_TOOL_CLASSIFICATIONS —
  // it operates at the current session taint level and must not escalate.
  assertEquals(
    sessionTaint,
    "PUBLIC",
    "Session taint must remain PUBLIC — memory_save does not escalate",
  );
  assertEquals(
    escalations.length,
    0,
    "No taint escalations should occur for memory_save",
  );
});

// --- Test: list_directory and search_files on PUBLIC path do NOT escalate ---

Deno.test("resource-classification: list_directory on PUBLIC path does not escalate taint", async () => {
  const hookRunner = makeHookRunner();
  const pathClassifier = createMockPathClassifier(
    { "public-area": "PUBLIC" },
    "INTERNAL",
  );
  const { all: toolClassifications } = mapToolPrefixClassifications({});

  let sessionTaint: ClassificationLevel = "PUBLIC";
  const escalations: Array<{ level: ClassificationLevel; reason: string }> = [];

  const registry = createProviderRegistry();
  registry.register(
    createToolCallingProvider("list_directory", {
      path: "/workspace/public-area",
    }),
  );
  registry.setDefault("mock-tool-caller");

  const orchestrator = createOrchestrator({
    hookRunner,
    providerRegistry: registry,
    tools: TOOL_DEFS,
    // deno-lint-ignore require-await
    toolExecutor: async (_name, _input) => "file1.txt\nfile2.txt",
    pathClassifier,
    toolClassifications,
    getSessionTaint: () => sessionTaint,
    escalateTaint: (level: ClassificationLevel, reason: string) => {
      escalations.push({ level, reason });
      const order: Record<string, number> = {
        PUBLIC: 0,
        INTERNAL: 1,
        CONFIDENTIAL: 2,
        RESTRICTED: 3,
      };
      if (order[level] > order[sessionTaint]) {
        sessionTaint = level;
      }
    },
    isOwnerSession: () => true,
  });

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  const result = await orchestrator.executeAgentTurn({
    session,
    message: "List the directory",
    targetClassification: "PUBLIC",
  });

  assertEquals(result.ok, true);
  assertEquals(
    sessionTaint,
    "PUBLIC",
    "Session taint should remain PUBLIC after listing a PUBLIC-classified directory",
  );
});

// --- Integration write-down tests (checkIntegrationWriteDown fix) ---

Deno.test("integration-write-down: secret_save from CONFIDENTIAL session is NOT blocked", async () => {
  const hookRunner = makeHookRunner();
  const { all: toolClassifications, integrations: integrationClassifications } =
    mapToolPrefixClassifications({});

  let sessionTaint: ClassificationLevel = "CONFIDENTIAL";
  let executedTool = "";

  const registry = createProviderRegistry();
  registry.register(
    createToolCallingProvider("secret_save", {
      name: "api_key",
      value: "sk-123",
    }),
  );
  registry.setDefault("mock-tool-caller");

  const toolResults: Array<{ name: string; blocked: boolean }> = [];

  const orchestrator = createOrchestrator({
    hookRunner,
    providerRegistry: registry,
    tools: TOOL_DEFS,
    // deno-lint-ignore require-await
    toolExecutor: async (name, _input) => {
      executedTool = name;
      return "saved";
    },
    toolClassifications,
    integrationClassifications,
    getSessionTaint: () => sessionTaint,
    escalateTaint: (level: ClassificationLevel, _reason: string) => {
      const order: Record<string, number> = {
        PUBLIC: 0,
        INTERNAL: 1,
        CONFIDENTIAL: 2,
        RESTRICTED: 3,
      };
      if (order[level] > order[sessionTaint]) {
        sessionTaint = level;
      }
    },
    isOwnerSession: () => true,
    onEvent: (event) => {
      if (event.type === "tool_result") {
        toolResults.push({ name: event.name, blocked: event.blocked });
      }
    },
  });

  let session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  session = updateTaint(session, "CONFIDENTIAL", "accessed classified data");

  const result = await orchestrator.executeAgentTurn({
    session,
    message: "Save API key",
    targetClassification: "RESTRICTED",
  });

  assertEquals(result.ok, true);
  assertEquals(
    executedTool,
    "secret_save",
    "secret_save should execute successfully",
  );
  assertEquals(toolResults.length, 1);
  assertEquals(
    toolResults[0].blocked,
    false,
    "secret_save must NOT be blocked by integration write-down check",
  );
});

Deno.test("integration-write-down: memory_search from CONFIDENTIAL session is NOT blocked", async () => {
  const hookRunner = makeHookRunner();
  const { all: toolClassifications, integrations: integrationClassifications } =
    mapToolPrefixClassifications({});

  let sessionTaint: ClassificationLevel = "CONFIDENTIAL";
  let executedTool = "";

  const registry = createProviderRegistry();
  registry.register(
    createToolCallingProvider("memory_search", { query: "api keys" }),
  );
  registry.setDefault("mock-tool-caller");

  const toolResults: Array<{ name: string; blocked: boolean }> = [];

  const orchestrator = createOrchestrator({
    hookRunner,
    providerRegistry: registry,
    tools: TOOL_DEFS,
    // deno-lint-ignore require-await
    toolExecutor: async (name, _input) => {
      executedTool = name;
      return "results";
    },
    toolClassifications,
    integrationClassifications,
    getSessionTaint: () => sessionTaint,
    escalateTaint: (level: ClassificationLevel, _reason: string) => {
      const order: Record<string, number> = {
        PUBLIC: 0,
        INTERNAL: 1,
        CONFIDENTIAL: 2,
        RESTRICTED: 3,
      };
      if (order[level] > order[sessionTaint]) {
        sessionTaint = level;
      }
    },
    isOwnerSession: () => true,
    onEvent: (event) => {
      if (event.type === "tool_result") {
        toolResults.push({ name: event.name, blocked: event.blocked });
      }
    },
  });

  let session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  session = updateTaint(session, "CONFIDENTIAL", "accessed classified data");

  const result = await orchestrator.executeAgentTurn({
    session,
    message: "Search memory for API keys",
    targetClassification: "RESTRICTED",
  });

  assertEquals(result.ok, true);
  assertEquals(
    executedTool,
    "memory_search",
    "memory_search should execute successfully",
  );
  assertEquals(toolResults.length, 1);
  assertEquals(
    toolResults[0].blocked,
    false,
    "memory_search must NOT be blocked by integration write-down check",
  );
});

Deno.test("integration-write-down: gmail_send from CONFIDENTIAL session IS blocked", async () => {
  const hookRunner = makeHookRunner();
  // Gmail default classification is PUBLIC
  const { all: toolClassifications, integrations: integrationClassifications } =
    mapToolPrefixClassifications({});

  let sessionTaint: ClassificationLevel = "CONFIDENTIAL";

  const registry = createProviderRegistry();
  registry.register(
    createToolCallingProvider("gmail_send", {
      to: "test@example.com",
      subject: "Secret",
      body: "classified data",
    }),
  );
  registry.setDefault("mock-tool-caller");

  const toolResults: Array<{ name: string; blocked: boolean }> = [];

  const orchestrator = createOrchestrator({
    hookRunner,
    providerRegistry: registry,
    tools: TOOL_DEFS,
    // deno-lint-ignore require-await
    toolExecutor: async (_name, _input) => "sent",
    toolClassifications,
    integrationClassifications,
    getSessionTaint: () => sessionTaint,
    escalateTaint: (level: ClassificationLevel, _reason: string) => {
      const order: Record<string, number> = {
        PUBLIC: 0,
        INTERNAL: 1,
        CONFIDENTIAL: 2,
        RESTRICTED: 3,
      };
      if (order[level] > order[sessionTaint]) {
        sessionTaint = level;
      }
    },
    isOwnerSession: () => true,
    onEvent: (event) => {
      if (event.type === "tool_result") {
        toolResults.push({ name: event.name, blocked: event.blocked });
      }
    },
  });

  let session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  session = updateTaint(session, "CONFIDENTIAL", "accessed classified data");

  const result = await orchestrator.executeAgentTurn({
    session,
    message: "Send email with classified data",
    targetClassification: "RESTRICTED",
  });

  assertEquals(result.ok, true);
  assertEquals(toolResults.length, 1);
  assertEquals(
    toolResults[0].blocked,
    true,
    "gmail_send must be BLOCKED — CONFIDENTIAL cannot flow to PUBLIC gmail",
  );
});

Deno.test("integration-write-down: gmail_send from PUBLIC session is NOT blocked", async () => {
  const hookRunner = makeHookRunner();
  const { all: toolClassifications, integrations: integrationClassifications } =
    mapToolPrefixClassifications({});

  let sessionTaint: ClassificationLevel = "PUBLIC";
  let executedTool = "";

  const registry = createProviderRegistry();
  registry.register(
    createToolCallingProvider("gmail_send", {
      to: "test@example.com",
      subject: "Hello",
      body: "public data",
    }),
  );
  registry.setDefault("mock-tool-caller");

  const toolResults: Array<{ name: string; blocked: boolean }> = [];

  const orchestrator = createOrchestrator({
    hookRunner,
    providerRegistry: registry,
    tools: TOOL_DEFS,
    // deno-lint-ignore require-await
    toolExecutor: async (name, _input) => {
      executedTool = name;
      return "sent";
    },
    toolClassifications,
    integrationClassifications,
    getSessionTaint: () => sessionTaint,
    escalateTaint: (level: ClassificationLevel, _reason: string) => {
      const order: Record<string, number> = {
        PUBLIC: 0,
        INTERNAL: 1,
        CONFIDENTIAL: 2,
        RESTRICTED: 3,
      };
      if (order[level] > order[sessionTaint]) {
        sessionTaint = level;
      }
    },
    isOwnerSession: () => true,
    onEvent: (event) => {
      if (event.type === "tool_result") {
        toolResults.push({ name: event.name, blocked: event.blocked });
      }
    },
  });

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });

  const result = await orchestrator.executeAgentTurn({
    session,
    message: "Send a public email",
    targetClassification: "PUBLIC",
  });

  assertEquals(result.ok, true);
  assertEquals(
    executedTool,
    "gmail_send",
    "gmail_send should execute successfully",
  );
  assertEquals(toolResults.length, 1);
  assertEquals(
    toolResults[0].blocked,
    false,
    "gmail_send from PUBLIC session must NOT be blocked",
  );
});

// --- Test: Outbound HTTP write-down — RESTRICTED session to PUBLIC domain ---

Deno.test("resource-classification: web_fetch to unclassified domain blocked from RESTRICTED session", async () => {
  const hookRunner = makeHookRunner();

  // Unclassified domains default to PUBLIC
  const domainClassifier = createMockDomainClassifier({});

  const registry = createProviderRegistry();
  registry.register(createToolCallingProvider("web_fetch", {
    url: "https://docs.example.dev/mcp-servers",
  }));
  registry.setDefault("mock-tool-caller");

  const sessionTaint: ClassificationLevel = "RESTRICTED";
  const toolResults: Array<{ name: string; blocked: boolean }> = [];

  const orchestrator = createOrchestrator({
    hookRunner,
    providerRegistry: registry,
    tools: TOOL_DEFS,
    // deno-lint-ignore require-await
    toolExecutor: async (_name, _input) => "ok",
    domainClassifier,
    getSessionTaint: () => sessionTaint,
    escalateTaint: () => {},
    isOwnerSession: () => true,
    onEvent: (event) => {
      if (event.type === "tool_result") {
        toolResults.push({ name: event.name, blocked: event.blocked });
      }
    },
  });

  let session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  session = updateTaint(session, "RESTRICTED", "classified access");

  const result = await orchestrator.executeAgentTurn({
    session,
    message: "Fetch the docs page",
    targetClassification: "RESTRICTED",
  });

  assertEquals(result.ok, true);
  assertEquals(toolResults.length, 1);
  assertEquals(
    toolResults[0].blocked,
    true,
    "web_fetch to PUBLIC domain from RESTRICTED session must be blocked (outbound write-down)",
  );
});

// --- Test: Hook-level outbound request flag blocks read fetch ---

Deno.test("resource-classification: hook blocks outbound read to lower-classified domain", async () => {
  const hookRunner = makeHookRunner();

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  const updatedSession = updateTaint(session, "RESTRICTED", "setup");

  // Simulate web_fetch (read operation) to a PUBLIC domain with is_outbound_request
  const result = await hookRunner.evaluateHook("PRE_TOOL_CALL", {
    session: updatedSession,
    input: {
      tool_call: {
        name: "web_fetch",
        args: { url: "https://docs.example.dev/page" },
      },
      resource_classification: "PUBLIC" as ClassificationLevel,
      operation_type: "read",
      is_outbound_request: true,
      is_owner: true,
    },
  });

  assertEquals(result.allowed, false);
  assertEquals(result.ruleId, "resource-write-down");
});

// --- Test: Outbound read to same-or-higher classified domain is allowed ---

Deno.test("resource-classification: outbound read to same-classified domain is allowed", async () => {
  const hookRunner = makeHookRunner();

  const session = createSession({
    userId: "u" as UserId,
    channelId: "c" as ChannelId,
  });
  const updatedSession = updateTaint(session, "CONFIDENTIAL", "setup");

  // web_fetch to a CONFIDENTIAL domain — same level, should be allowed
  const result = await hookRunner.evaluateHook("PRE_TOOL_CALL", {
    session: updatedSession,
    input: {
      tool_call: {
        name: "web_fetch",
        args: { url: "https://intranet.corp/report" },
      },
      resource_classification: "CONFIDENTIAL" as ClassificationLevel,
      operation_type: "read",
      is_outbound_request: true,
      is_owner: true,
    },
  });

  assertEquals(result.allowed, true);
});
