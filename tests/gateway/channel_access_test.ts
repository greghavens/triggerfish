/**
 * Tests for centralized channel access control in handleChannelMessage.
 *
 * Verifies the unified access control gate: pairing and classification
 * are a single decision — "does this user have a classification?" Pairing
 * is one way to get a classification (alongside static config).
 */
import { assert, assertEquals } from "@std/assert";
import { createChatSession } from "../../src/gateway/chat.ts";
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelStatus,
  MessageHandler,
} from "../../src/channels/types.ts";
import type {
  ClassificationLevel,
  Result,
} from "../../src/core/types/classification.ts";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { LlmProvider } from "../../src/agent/llm.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import { createHookRunner } from "../../src/core/policy/hooks/hooks.ts";
import { createSession } from "../../src/core/types/session.ts";
import type { ChannelId, UserId } from "../../src/core/types/session.ts";
import type {
  PairingCode,
  PairingResult,
  PairingService,
} from "../../src/channels/pairing.ts";

/** Create a mock adapter that records send calls. */
function createMockAdapter(cls: ClassificationLevel = "PUBLIC"): {
  adapter: ChannelAdapter;
  sent: ChannelMessage[];
  typingSent: string[];
} {
  const sent: ChannelMessage[] = [];
  const typingSent: string[] = [];

  const adapter: ChannelAdapter = {
    classification: cls,
    isOwner: false,
    connect(): Promise<void> {
      return Promise.resolve();
    },
    disconnect(): Promise<void> {
      return Promise.resolve();
    },
    send(msg: ChannelMessage): Promise<void> {
      sent.push(msg);
      return Promise.resolve();
    },
    onMessage(_handler: MessageHandler) {},
    status(): ChannelStatus {
      return { connected: true, channelType: "test" };
    },
    sendTyping(sessionId: string): Promise<void> {
      typingSent.push(sessionId);
      return Promise.resolve();
    },
  };

  return { adapter, sent, typingSent };
}

/** Create a mock LLM provider that returns a fixed response. */
function createMockProvider(): LlmProvider {
  return {
    name: "mock",
    supportsStreaming: false,
    complete() {
      return Promise.resolve({
        content: "Mock response",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    },
  };
}

/** Create a mock pairing service. */
function createMockPairingService(opts?: {
  linkedUsers?: string[];
  verifyResult?: Result<PairingResult, string>;
}): PairingService {
  const linked = opts?.linkedUsers ?? [];
  const verifyResult = opts?.verifyResult ??
    { ok: false, error: "Invalid" } as Result<PairingResult, string>;

  return {
    generateCode(_channelType: string): Promise<PairingCode> {
      return Promise.resolve({
        code: "123456",
        channelType: _channelType,
        expiresAt: new Date(Date.now() + 300000),
        used: false,
      });
    },
    verifyCode(
      _code: string,
      _channelType: string,
      _platformUserId: string,
    ): Promise<Result<PairingResult, string>> {
      return Promise.resolve(verifyResult);
    },
    getPending(_channelType: string): Promise<PairingCode | null> {
      return Promise.resolve(null);
    },
    getLinkedUsers(_channelType: string): Promise<string[]> {
      return Promise.resolve(linked);
    },
  };
}

/** Create a minimal ChatSession for testing access control gates. */
function createTestSession(opts?: {
  pairingService?: PairingService;
}) {
  const registry = createProviderRegistry();
  registry.register(createMockProvider());
  registry.setDefault("mock");

  const engine = createPolicyEngine();
  const hookRunner = createHookRunner(engine);

  const session = createSession({
    userId: "owner" as UserId,
    channelId: "test" as ChannelId,
  });

  return createChatSession({
    hookRunner,
    providerRegistry: registry,
    session,
    pairingService: opts?.pairingService,
  });
}

// --- Test 1: Owner bypass ---

Deno.test("Access control: owner messages bypass all gates", async () => {
  const pairingService = createMockPairingService({ linkedUsers: [] });
  const chatSession = createTestSession({ pairingService });
  const { adapter, sent } = createMockAdapter();

  await chatSession.registerChannel("signal", {
    adapter,
    channelName: "Signal",
    classification: "PUBLIC" as ClassificationLevel,
    pairing: true,
    respondToUnclassified: false,
  });

  await chatSession.handleChannelMessage({
    content: "Hello from owner",
    sessionId: "signal-owner",
    isOwner: true,
  }, "signal");

  assert(
    sent.length > 0,
    "Owner messages should bypass all gates and get a response",
  );
});

// --- Test 1b: isOwner undefined routes to the non-owner path (CHANNELS-2) ---

Deno.test("Access control: isOwner undefined routes to non-owner path, not owner", async () => {
  const chatSession = createTestSession();
  const { adapter, sent } = createMockAdapter();

  await chatSession.registerChannel("telegram", {
    adapter,
    channelName: "Telegram",
    classification: "PUBLIC" as ClassificationLevel,
    respondToUnclassified: false,
  });

  // No isOwner flag at all: must be treated as non-owner (default-deny).
  // With respondToUnclassified=false and no classification, it is dropped.
  await chatSession.handleChannelMessage({
    content: "Hello!",
    sessionId: "telegram-99999",
    senderId: "99999",
  }, "telegram");

  assertEquals(
    sent.length,
    0,
    "isOwner: undefined must route to the non-owner path and be dropped",
  );
});

// --- Test 2: Config-classified user ---

Deno.test("Access control: config-classified user allowed", async () => {
  const chatSession = createTestSession();
  const { adapter, sent } = createMockAdapter();

  await chatSession.registerChannel("telegram", {
    adapter,
    channelName: "Telegram",
    classification: "PUBLIC" as ClassificationLevel,
    respondToUnclassified: false,
    userClassifications: { "12345": "INTERNAL" },
  });

  await chatSession.handleChannelMessage({
    content: "Hello!",
    sessionId: "telegram-12345",
    senderId: "12345",
    isOwner: false,
  }, "telegram");

  assert(sent.length > 0, "Config-classified sender should get a response");
});

// --- Test 3: Unclassified + respondToUnclassified=false → dropped ---

Deno.test("Access control: unclassified + respondToUnclassified=false drops sender", async () => {
  const chatSession = createTestSession();
  const { adapter, sent } = createMockAdapter();

  await chatSession.registerChannel("telegram", {
    adapter,
    channelName: "Telegram",
    classification: "PUBLIC" as ClassificationLevel,
    respondToUnclassified: false,
  });

  await chatSession.handleChannelMessage({
    content: "Hello!",
    sessionId: "telegram-12345",
    senderId: "12345",
    isOwner: false,
  }, "telegram");

  assertEquals(
    sent.length,
    0,
    "Unclassified sender should be silently dropped",
  );
});

// --- Test 4: Unclassified + respondToUnclassified=true → allowed ---

Deno.test("Access control: unclassified + respondToUnclassified=true allows sender", async () => {
  const chatSession = createTestSession();
  const { adapter, sent } = createMockAdapter();

  await chatSession.registerChannel("telegram", {
    adapter,
    channelName: "Telegram",
    classification: "PUBLIC" as ClassificationLevel,
    // respondToUnclassified defaults to true
  });

  await chatSession.handleChannelMessage({
    content: "Hello!",
    sessionId: "telegram-12345",
    senderId: "12345",
    isOwner: false,
  }, "telegram");

  assert(
    sent.length > 0,
    "Unclassified sender should get a response when respondToUnclassified=true",
  );
});

// --- Test 5: Pairing enabled + unpaired + non-code msg → dropped ---

Deno.test("Access control: pairing enabled, unpaired sender with non-code msg dropped", async () => {
  const pairingService = createMockPairingService({ linkedUsers: [] });
  const chatSession = createTestSession({ pairingService });
  const { adapter, sent } = createMockAdapter();

  await chatSession.registerChannel("signal", {
    adapter,
    channelName: "Signal",
    classification: "PUBLIC" as ClassificationLevel,
    pairing: true,
  });

  await chatSession.handleChannelMessage({
    content: "Hello!",
    sessionId: "signal-+15559876543",
    senderId: "+15559876543",
    isOwner: false,
  }, "signal");

  assertEquals(
    sent.length,
    0,
    "Unpaired sender with non-code msg should be dropped",
  );
});

// --- Test 6: Pairing enabled + valid 6-digit code → confirms + adds classification ---

Deno.test("Access control: valid 6-digit code pairs and confirms", async () => {
  const pairingService = createMockPairingService({
    linkedUsers: [],
    verifyResult: {
      ok: true,
      value: {
        channelType: "signal",
        platformUserId: "+15559876543",
        linkedAt: new Date(),
      },
    },
  });
  const chatSession = createTestSession({ pairingService });
  const { adapter, sent } = createMockAdapter();

  await chatSession.registerChannel("signal", {
    adapter,
    channelName: "Signal",
    classification: "PUBLIC" as ClassificationLevel,
    pairing: true,
  });

  // Send a 6-digit code as DM
  await chatSession.handleChannelMessage({
    content: "123456",
    sessionId: "signal-+15559876543",
    senderId: "+15559876543",
    isOwner: false,
  }, "signal");

  assertEquals(sent.length, 1, "Should send pairing confirmation");
  assert(
    sent[0].content.includes("Paired successfully"),
    "Confirmation message",
  );
});

// --- Test 7: Pairing enabled + invalid code → silent drop ---

Deno.test("Access control: invalid pairing code stays silent", async () => {
  const pairingService = createMockPairingService({
    linkedUsers: [],
    verifyResult: { ok: false, error: "Invalid pairing code" },
  });
  const chatSession = createTestSession({ pairingService });
  const { adapter, sent } = createMockAdapter();

  await chatSession.registerChannel("signal", {
    adapter,
    channelName: "Signal",
    classification: "PUBLIC" as ClassificationLevel,
    pairing: true,
  });

  await chatSession.handleChannelMessage({
    content: "999999",
    sessionId: "signal-+15559876543",
    senderId: "+15559876543",
    isOwner: false,
  }, "signal");

  assertEquals(sent.length, 0, "Invalid code should stay silent");
});

// --- Test 8: Pairing enabled + group msg with 6-digit → no code check, dropped ---

Deno.test("Access control: group message from unpaired sender dropped, no code check", async () => {
  const pairingService = createMockPairingService({ linkedUsers: [] });
  const chatSession = createTestSession({ pairingService });
  const { adapter, sent } = createMockAdapter();

  await chatSession.registerChannel("signal", {
    adapter,
    channelName: "Signal",
    classification: "PUBLIC" as ClassificationLevel,
    pairing: true,
  });

  // Group messages don't attempt code verification even with 6-digit content
  await chatSession.handleChannelMessage({
    content: "123456",
    sessionId: "signal-group-abc123",
    senderId: "+15559876543",
    isOwner: false,
  }, "signal");

  assertEquals(
    sent.length,
    0,
    "Group message from unpaired sender should be silently dropped",
  );
});

// --- Test 9: Pre-paired user (from storage) → allowed with pairing classification ---

Deno.test("Access control: pre-paired user from storage is allowed", async () => {
  const pairingService = createMockPairingService({
    linkedUsers: ["+15559876543"],
  });
  const chatSession = createTestSession({ pairingService });
  const { adapter, sent } = createMockAdapter();

  await chatSession.registerChannel("signal", {
    adapter,
    channelName: "Signal",
    classification: "PUBLIC" as ClassificationLevel,
    pairing: true,
  });

  await chatSession.handleChannelMessage({
    content: "Hello!",
    sessionId: "signal-+15559876543",
    senderId: "+15559876543",
    isOwner: false,
  }, "signal");

  assert(sent.length > 0, "Pre-paired sender should get a response");
});

// --- Test 10: Pre-paired + respondToUnclassified=false → allowed (the critical bug fix) ---

Deno.test("Access control: pre-paired user allowed even with respondToUnclassified=false", async () => {
  const pairingService = createMockPairingService({
    linkedUsers: ["+15559876543"],
  });
  const chatSession = createTestSession({ pairingService });
  const { adapter, sent } = createMockAdapter();

  await chatSession.registerChannel("signal", {
    adapter,
    channelName: "Signal",
    classification: "PUBLIC" as ClassificationLevel,
    pairing: true,
    respondToUnclassified: false,
  });

  await chatSession.handleChannelMessage({
    content: "Hello!",
    sessionId: "signal-+15559876543",
    senderId: "+15559876543",
    isOwner: false,
  }, "signal");

  assert(
    sent.length > 0,
    "Pre-paired user must be allowed even when respondToUnclassified=false",
  );
});

// --- Test 11: sendTyping integration ---

Deno.test("Access control: sendTyping called on adapter during processing", async () => {
  const chatSession = createTestSession();
  const { adapter, typingSent } = createMockAdapter();

  await chatSession.registerChannel("telegram", {
    adapter,
    channelName: "Telegram",
    classification: "PUBLIC" as ClassificationLevel,
  });

  await chatSession.handleChannelMessage({
    content: "Hello!",
    sessionId: "telegram-12345",
    senderId: "12345",
    isOwner: false,
  }, "telegram");

  assert(
    typingSent.length > 0,
    "sendTyping should be called on the adapter during LLM processing",
  );
});

// --- Test 12: Write-down blocked tool sends direct notification to channel ---
//
// When the owner's session taint (e.g. INTERNAL) exceeds an integration tool's
// classification (e.g. PUBLIC for gmail_), the write-down check blocks the tool call
// and sets blocked=true. buildSendEvent must forward the block reason to the channel
// adapter so the user sees it — channels like Telegram don't surface tool results the
// way the Tidepool webchat does.

Deno.test("buildSendEvent: write-down blocked tool sends direct notification to channel adapter", async () => {
  let callCount = 0;

  // Mock LLM: first call returns a tool call for gmail_send; second returns final response
  const mockLlm: LlmProvider = {
    name: "mock-tool-llm",
    supportsStreaming: false,
    // deno-lint-ignore require-await
    async complete(_messages, _tools, _options) {
      callCount++;
      if (callCount === 1) {
        return {
          content: "",
          toolCalls: [
            {
              function: {
                name: "gmail_send",
                arguments: JSON.stringify({
                  to: "test@example.com",
                  subject: "Hi",
                  body: "Hello",
                }),
              },
            },
          ],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      // Second call: final response after receiving the blocked tool result
      return {
        content:
          "I was unable to send the email because your session taint is elevated.",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };

  const registry = createProviderRegistry();
  registry.register(mockLlm);
  registry.setDefault("mock-tool-llm");

  const engine = createPolicyEngine();
  const hookRunner = createHookRunner(engine);

  const session = createSession({
    userId: "owner" as UserId,
    channelId: "telegram" as ChannelId,
  });

  // gmail_ is an external integration classified PUBLIC;
  // session taint is INTERNAL → write-down blocked
  const toolClassifications = new Map<string, ClassificationLevel>([
    ["gmail_", "PUBLIC" as ClassificationLevel],
  ]);
  const integrationClassifications = new Map<string, ClassificationLevel>([
    ["gmail_", "PUBLIC" as ClassificationLevel],
  ]);

  const chatSession = createChatSession({
    hookRunner,
    providerRegistry: registry,
    session,
    toolClassifications,
    integrationClassifications,
    // Taint is INTERNAL — simulates owner session after reading an INTERNAL resource
    getSessionTaint: () => "INTERNAL" as ClassificationLevel,
    escalateTaint: (_level, _reason) => {/* no-op for this test */},
    tools: [
      {
        name: "gmail_send",
        description: "Send an email",
        parameters: {
          to: { type: "string", description: "Recipient email address" },
          subject: { type: "string", description: "Email subject" },
          body: { type: "string", description: "Email body" },
        },
      },
    ],
    // toolExecutor is present so the orchestrator passes native tools to the LLM;
    // it will NOT be reached because write-down blocks the call before execution.
    toolExecutor: (name: string, _input: unknown) => `Tool ${name} executed`,
  });

  const { adapter, sent } = createMockAdapter(
    "INTERNAL" as ClassificationLevel,
  );

  await chatSession.registerChannel("telegram", {
    adapter,
    channelName: "Telegram",
    classification: "INTERNAL" as ClassificationLevel,
  });

  await chatSession.handleChannelMessage({
    content: "Send an email to test@example.com saying Hello",
    sessionId: "telegram-owner-1",
    isOwner: true,
  }, "telegram");

  // Should have received at least 2 messages:
  //   1. The write-down block notification (tool_result with blocked=true)
  //   2. The LLM's final response
  assert(
    sent.length >= 2,
    `Expected ≥2 adapter messages (block notification + final response), got ${sent.length}: ${
      JSON.stringify(sent.map((m) => m.content))
    }`,
  );

  // The first message should be the write-down block reason
  const blockMsg = sent.find(
    (m) =>
      m.content.includes("cannot flow to") && m.content.includes("gmail_send"),
  );
  assert(
    blockMsg !== undefined,
    `Expected a write-down block notification mentioning 'gmail_send', got: ${
      JSON.stringify(sent.map((m) => m.content))
    }`,
  );
});

// --- Test 13: Non-owner with elevated taint still blocked (write-down preserved) ---
//
// Verifies that the write-down fix did not remove protection for non-owner sessions.
// A non-owner whose taint has escalated to INTERNAL should still be blocked from PUBLIC tools.

Deno.test("buildSendEvent: non-owner write-down block also notifies channel", async () => {
  let callCount = 0;

  // Mock LLM: first call reads an INTERNAL file (escalating taint),
  // second call tries gmail_send (blocked by write-down),
  // third call returns the final response.
  const mockLlm: LlmProvider = {
    name: "mock-nonowner-llm",
    supportsStreaming: false,
    // deno-lint-ignore require-await
    async complete(_messages, _tools, _options) {
      callCount++;
      if (callCount === 1) {
        return {
          content: "",
          toolCalls: [
            {
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "/data/internal.txt" }),
              },
            },
          ],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      if (callCount === 2) {
        return {
          content: "",
          toolCalls: [
            {
              function: {
                name: "gmail_send",
                arguments: JSON.stringify({
                  to: "a@b.com",
                  subject: "test",
                  body: "test",
                }),
              },
            },
          ],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      return {
        content: "I cannot send the email.",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };

  const registry = createProviderRegistry();
  registry.register(mockLlm);
  registry.setDefault("mock-nonowner-llm");

  const engine = createPolicyEngine();
  const hookRunner = createHookRunner(engine);

  const nonOwnerSession = createSession({
    userId: "user-456" as UserId,
    channelId: "telegram" as ChannelId,
  });

  const toolClassifications = new Map<string, ClassificationLevel>([
    ["gmail_", "PUBLIC" as ClassificationLevel],
  ]);
  const integrationClassifications = new Map<string, ClassificationLevel>([
    ["gmail_", "PUBLIC" as ClassificationLevel],
  ]);

  // Path classifier that classifies all paths as INTERNAL —
  // reading /data/internal.txt escalates non-owner taint to INTERNAL.
  const pathClassifier = {
    classify: (_path: string) => ({
      classification: "INTERNAL" as ClassificationLevel,
    }),
  };

  const chatSession = createChatSession({
    hookRunner,
    providerRegistry: registry,
    session: nonOwnerSession,
    toolClassifications,
    integrationClassifications,
    pathClassifier,
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        parameters: {
          path: { type: "string", description: "File path" },
        },
      },
      {
        name: "gmail_send",
        description: "Send an email",
        parameters: {
          to: { type: "string", description: "Recipient" },
          subject: { type: "string", description: "Subject" },
          body: { type: "string", description: "Body" },
        },
      },
    ],
    toolExecutor: (name: string, _input: unknown) => `Result from ${name}`,
  });

  const { adapter, sent } = createMockAdapter(
    "INTERNAL" as ClassificationLevel,
  );

  await chatSession.registerChannel("telegram", {
    adapter,
    channelName: "Telegram",
    classification: "INTERNAL" as ClassificationLevel,
    userClassifications: { "user-456": "INTERNAL" },
  });

  await chatSession.handleChannelMessage({
    content: "Read the file then send an email to a@b.com",
    sessionId: "telegram-user-456",
    senderId: "user-456",
    isOwner: false,
  }, "telegram");

  // Tool should have been blocked — at minimum a final response should be sent
  assert(
    sent.length >= 1,
    "Non-owner session should receive at least a final response",
  );

  // Verify the block notification was sent (taint escalated to INTERNAL, gmail_ is PUBLIC)
  const blockMsg = sent.find(
    (m) =>
      m.content.includes("cannot flow to") && m.content.includes("gmail_send"),
  );
  assert(
    blockMsg !== undefined,
    `Expected a write-down block notification for non-owner, got: ${
      JSON.stringify(sent.map((m) => m.content))
    }`,
  );
});
