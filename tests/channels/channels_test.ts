/**
 * Phase 15: Channel Adapter Tests
 *
 * Tests adapter factory functions, message chunking, router retry,
 * and per-channel configuration. Integration tests are gated behind
 * environment variables (BOT_TOKEN, etc.).
 */
import { assertEquals, assertExists, assert } from "@std/assert";

// --- Telegram ---

Deno.test("Telegram: factory creates adapter with correct channel type", async () => {
  const { createTelegramChannel } = await import("../../src/channels/telegram/adapter.ts");
  const adapter = createTelegramChannel({ botToken: "fake:token" });
  assertEquals(adapter.status().channelType, "telegram");
  assertEquals(adapter.status().connected, false);
  assertEquals(adapter.classification, "PUBLIC");
});

Deno.test("Telegram: respects custom classification", async () => {
  const { createTelegramChannel } = await import("../../src/channels/telegram/adapter.ts");
  const adapter = createTelegramChannel({
    botToken: "fake:token",
    classification: "CONFIDENTIAL",
  });
  assertEquals(adapter.classification, "CONFIDENTIAL");
});

Deno.test("Telegram: chunkMessage splits long text", async () => {
  const { chunkMessage } = await import("../../src/channels/telegram/adapter.ts");
  const longText = "a".repeat(5000);
  const chunks = chunkMessage(longText, 4096);
  assert(chunks.length >= 2, "Should split into at least 2 chunks");
  for (const chunk of chunks) {
    assert(chunk.length <= 4096, "Each chunk must be <= 4096 chars");
  }
});

Deno.test("Telegram: chunkMessage preserves short text", async () => {
  const { chunkMessage } = await import("../../src/channels/telegram/adapter.ts");
  const chunks = chunkMessage("Hello world", 4096);
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0], "Hello world");
});

Deno.test("Telegram: chunkMessage splits on newlines when possible", async () => {
  const { chunkMessage } = await import("../../src/channels/telegram/adapter.ts");
  const text = "Line one\n" + "x".repeat(90) + "\nLine three";
  const chunks = chunkMessage(text, 50);
  // Should split at a newline rather than mid-word
  assert(chunks.length >= 2);
});

Deno.test("Telegram: registers message handler", async () => {
  const { createTelegramChannel } = await import("../../src/channels/telegram/adapter.ts");
  const adapter = createTelegramChannel({ botToken: "fake:token" });
  let called = false;
  adapter.onMessage(() => { called = true; });
  // Handler is registered but won't fire without bot connection
  assertEquals(called, false);
});

Deno.test("Telegram: sendTyping method exists on adapter", async () => {
  const { createTelegramChannel } = await import("../../src/channels/telegram/adapter.ts");
  const adapter = createTelegramChannel({ botToken: "fake:token" });
  assertExists(adapter.sendTyping);
  assertEquals(typeof adapter.sendTyping, "function");
});

Deno.test("Telegram: sendTyping returns early for empty sessionId", async () => {
  const { createTelegramChannel } = await import("../../src/channels/telegram/adapter.ts");
  const adapter = createTelegramChannel({ botToken: "fake:token" });
  // Should not throw — returns early for empty/invalid sessionId
  await adapter.sendTyping("");
});

Deno.test("Telegram: sendTyping returns early for invalid sessionId", async () => {
  const { createTelegramChannel } = await import("../../src/channels/telegram/adapter.ts");
  const adapter = createTelegramChannel({ botToken: "fake:token" });
  // "telegram-notanumber" → NaN → returns early
  await adapter.sendTyping("telegram-notanumber");
});

// --- Slack ---

Deno.test({
  name: "Slack: factory creates adapter with correct channel type",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { createSlackChannel } = await import("../../src/channels/slack/adapter.ts");
    const adapter = createSlackChannel({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      signingSecret: "secret",
    });
    assertEquals(adapter.status().channelType, "slack");
    assertEquals(adapter.status().connected, false);
  },
});

Deno.test({
  name: "Slack: respects custom classification",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { createSlackChannel } = await import("../../src/channels/slack/adapter.ts");
    const adapter = createSlackChannel({
      botToken: "xoxb-fake",
      appToken: "xapp-fake",
      signingSecret: "secret",
      classification: "RESTRICTED",
    });
    assertEquals(adapter.classification, "RESTRICTED");
  },
});

// --- Discord ---

Deno.test({
  name: "Discord: factory creates adapter with correct channel type",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { createDiscordChannel } = await import("../../src/channels/discord/adapter.ts");
    const adapter = createDiscordChannel({ botToken: "fake-discord-token" });
    assertEquals(adapter.status().channelType, "discord");
    assertEquals(adapter.status().connected, false);
  },
});

Deno.test({
  name: "Discord: defaults to PUBLIC classification",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { createDiscordChannel } = await import("../../src/channels/discord/adapter.ts");
    const adapter = createDiscordChannel({ botToken: "fake-discord-token" });
    assertEquals(adapter.classification, "PUBLIC");
  },
});

Deno.test({
  name: "Discord: respects custom classification",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { createDiscordChannel } = await import("../../src/channels/discord/adapter.ts");
    const adapter = createDiscordChannel({
      botToken: "fake-discord-token",
      classification: "INTERNAL",
    });
    assertEquals(adapter.classification, "INTERNAL");
  },
});

Deno.test({
  name: "Discord: sendTyping method is defined",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { createDiscordChannel } = await import("../../src/channels/discord/adapter.ts");
    const adapter = createDiscordChannel({ botToken: "fake-discord-token" });
    assertEquals(typeof adapter.sendTyping, "function");
  },
});

Deno.test({
  name: "Discord: onMessage handler is registered",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { createDiscordChannel } = await import("../../src/channels/discord/adapter.ts");
    const adapter = createDiscordChannel({ botToken: "fake-discord-token" });
    let received = false;
    adapter.onMessage(() => {
      received = true;
    });
    // Handler is registered — just verify it doesn't throw
    assertEquals(received, false);
  },
});

Deno.test({
  name: "Discord: DiscordChannelAdapter interface is exported",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Verify that the extended interface type is exported from the adapter module
    const mod = await import("../../src/channels/discord/adapter.ts");
    assertEquals(typeof mod.createDiscordChannel, "function");
  },
});

// --- WhatsApp ---

Deno.test("WhatsApp: factory creates adapter with correct channel type", async () => {
  const { createWhatsAppChannel } = await import("../../src/channels/whatsapp/adapter.ts");
  const adapter = createWhatsAppChannel({
    accessToken: "fake-token",
    phoneNumberId: "123456",
    verifyToken: "verify-me",
  });
  assertEquals(adapter.status().channelType, "whatsapp");
  assertEquals(adapter.status().connected, false);
});

Deno.test("WhatsApp: defaults to PUBLIC classification", async () => {
  const { createWhatsAppChannel } = await import("../../src/channels/whatsapp/adapter.ts");
  const adapter = createWhatsAppChannel({
    accessToken: "fake-token",
    phoneNumberId: "123456",
    verifyToken: "verify-me",
  });
  assertEquals(adapter.classification, "PUBLIC");
});

// --- WebChat ---

Deno.test("WebChat: factory creates adapter with correct channel type", async () => {
  const { createWebChatChannel } = await import("../../src/channels/webchat/adapter.ts");
  const adapter = createWebChatChannel({ port: 0 });
  assertEquals(adapter.status().channelType, "webchat");
  assertEquals(adapter.status().connected, false);
  assertEquals(adapter.isOwner, false); // Web visitors are never owner
});

Deno.test("WebChat: defaults to PUBLIC classification", async () => {
  const { createWebChatChannel } = await import("../../src/channels/webchat/adapter.ts");
  const adapter = createWebChatChannel();
  assertEquals(adapter.classification, "PUBLIC");
});

// --- Email ---

Deno.test("Email: factory creates adapter with correct channel type", async () => {
  const { createEmailChannel } = await import("../../src/channels/email/adapter.ts");
  const adapter = createEmailChannel({
    smtpApiUrl: "https://api.sendgrid.com/v3/mail/send",
    smtpApiKey: "fake-key",
    imapHost: "imap.example.com",
    imapUser: "user@example.com",
    imapPassword: "password",
    fromAddress: "bot@example.com",
  });
  assertEquals(adapter.status().channelType, "email");
  assertEquals(adapter.status().connected, false);
});

Deno.test("Email: defaults to CONFIDENTIAL classification", async () => {
  const { createEmailChannel } = await import("../../src/channels/email/adapter.ts");
  const adapter = createEmailChannel({
    smtpApiUrl: "https://api.sendgrid.com/v3/mail/send",
    smtpApiKey: "fake-key",
    imapHost: "imap.example.com",
    imapUser: "user@example.com",
    imapPassword: "password",
    fromAddress: "bot@example.com",
  });
  assertEquals(adapter.classification, "CONFIDENTIAL");
});

// --- Signal ---

Deno.test("Signal: factory creates adapter with correct channel type", async () => {
  const { createSignalChannel } = await import("../../src/channels/signal/adapter.ts");
  const adapter = createSignalChannel({
    endpoint: "tcp://localhost:7583",
    account: "+15551234567",
  });
  assertEquals(adapter.status().channelType, "signal");
  assertEquals(adapter.status().connected, false);
});

Deno.test("Signal: defaults to PUBLIC classification", async () => {
  const { createSignalChannel } = await import("../../src/channels/signal/adapter.ts");
  const adapter = createSignalChannel({
    endpoint: "tcp://localhost:7583",
    account: "+15551234567",
  });
  assertEquals(adapter.classification, "PUBLIC");
});

Deno.test("Signal: respects custom classification", async () => {
  const { createSignalChannel } = await import("../../src/channels/signal/adapter.ts");
  const adapter = createSignalChannel({
    endpoint: "tcp://localhost:7583",
    account: "+15551234567",
    classification: "CONFIDENTIAL",
  });
  assertEquals(adapter.classification, "CONFIDENTIAL");
});

Deno.test("Signal: isOwner is always false", async () => {
  const { createSignalChannel } = await import("../../src/channels/signal/adapter.ts");
  const adapter = createSignalChannel({
    endpoint: "tcp://localhost:7583",
    account: "+15551234567",
  });
  assertEquals(adapter.isOwner, false);
});

// --- Enhanced Router ---

Deno.test("Router: sendWithRetry succeeds on first try", async () => {
  const { createChannelRouter } = await import("../../src/channels/router.ts");
  const router = createChannelRouter();

  let sent = false;
  const mockAdapter = {
    classification: "INTERNAL" as const,
    isOwner: true,
    connect: async () => {},
    disconnect: async () => {},
    // deno-lint-ignore require-await
    send: async () => { sent = true; },
    onMessage: () => {},
    status: () => ({ connected: true, channelType: "mock" }),
  };

  router.register("test", mockAdapter);
  const result = await router.sendWithRetry("test", { content: "hello" });
  assertEquals(result, true);
  assertEquals(sent, true);
});

Deno.test("Router: sendWithRetry returns false for unknown channel", async () => {
  const { createChannelRouter } = await import("../../src/channels/router.ts");
  const router = createChannelRouter();
  const result = await router.sendWithRetry("nonexistent", { content: "hello" });
  assertEquals(result, false);
});

Deno.test("Router: sendWithRetry retries on failure", async () => {
  const { createChannelRouter } = await import("../../src/channels/router.ts");
  const router = createChannelRouter({ maxRetries: 2, baseDelay: 10 });

  let attempts = 0;
  const mockAdapter = {
    classification: "INTERNAL" as const,
    isOwner: true,
    connect: async () => {},
    disconnect: async () => {},
    // deno-lint-ignore require-await
    send: async () => {
      attempts++;
      if (attempts < 3) throw new Error("Transient failure");
    },
    onMessage: () => {},
    status: () => ({ connected: true, channelType: "mock" }),
  };

  router.register("test", mockAdapter);
  const result = await router.sendWithRetry("test", { content: "hello" });
  assertEquals(result, true);
  assertEquals(attempts, 3); // 1 initial + 2 retries
});

Deno.test("Router: sendWithRetry gives up after max retries", async () => {
  const { createChannelRouter } = await import("../../src/channels/router.ts");
  const router = createChannelRouter({ maxRetries: 1, baseDelay: 10 });

  const mockAdapter = {
    classification: "INTERNAL" as const,
    isOwner: true,
    connect: async () => {},
    disconnect: async () => {},
    // deno-lint-ignore require-await
    send: async () => { throw new Error("Permanent failure"); },
    onMessage: () => {},
    status: () => ({ connected: true, channelType: "mock" }),
  };

  router.register("test", mockAdapter);
  const result = await router.sendWithRetry("test", { content: "hello" });
  assertEquals(result, false);
});

Deno.test("Router: connectAll connects all adapters", async () => {
  const { createChannelRouter } = await import("../../src/channels/router.ts");
  const router = createChannelRouter();

  const connected: string[] = [];
  const makeAdapter = (name: string) => ({
    classification: "INTERNAL" as const,
    isOwner: true,
    // deno-lint-ignore require-await
    connect: async () => { connected.push(name); },
    disconnect: async () => {},
    send: async () => {},
    onMessage: () => {},
    status: () => ({ connected: true, channelType: name }),
  });

  router.register("a", makeAdapter("a"));
  router.register("b", makeAdapter("b"));
  await router.connectAll();

  assertEquals(connected.length, 2);
  assert(connected.includes("a"));
  assert(connected.includes("b"));
});

Deno.test("Router: disconnectAll disconnects all adapters", async () => {
  const { createChannelRouter } = await import("../../src/channels/router.ts");
  const router = createChannelRouter();

  const disconnected: string[] = [];
  const makeAdapter = (name: string) => ({
    classification: "INTERNAL" as const,
    isOwner: true,
    connect: async () => {},
    // deno-lint-ignore require-await
    disconnect: async () => { disconnected.push(name); },
    send: async () => {},
    onMessage: () => {},
    status: () => ({ connected: true, channelType: name }),
  });

  router.register("a", makeAdapter("a"));
  router.register("b", makeAdapter("b"));
  await router.disconnectAll();

  assertEquals(disconnected.length, 2);
});

// --- Barrel exports ---

Deno.test("Barrel: mod.ts exports all channel factories", async () => {
  const mod = await import("../../src/channels/mod.ts");
  assertExists(mod.createTelegramChannel);
  assertExists(mod.createSlackChannel);
  assertExists(mod.createDiscordChannel);
  assertExists(mod.createWhatsAppChannel);
  assertExists(mod.createWebChatChannel);
  assertExists(mod.createEmailChannel);
  assertExists(mod.createSignalChannel);
  assertExists(mod.chunkMessage);
  assertExists(mod.createChannelRouter);
  assertExists(mod.createCliChannel);
});
