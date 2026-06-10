/**
 * Email IMAP client tests.
 *
 * Uses the mock IMAP client to test email adapter integration
 * without requiring a real IMAP server.
 */

import { assertEquals } from "@std/assert";
import {
  createMockImapClient,
  type ImapMessage,
} from "../../../src/channels/email/imap.ts";
import { createEmailChannel } from "../../../src/channels/email/adapter.ts";
import type { ChannelMessage } from "../../../src/channels/types.ts";

// ---------------------------------------------------------------------------
// Mock IMAP client tests
// ---------------------------------------------------------------------------

Deno.test("mock IMAP: fetchUnseen returns configured messages", async () => {
  const messages: ImapMessage[] = [
    {
      uid: 1,
      from: "alice@example.com",
      subject: "Hello",
      body: "Hi there",
      date: new Date("2025-01-15"),
    },
    {
      uid: 2,
      from: "bob@test.com",
      subject: "Question",
      body: "How are you?",
      date: new Date("2025-01-16"),
    },
  ];

  const client = createMockImapClient(messages);
  await client.connect();

  const result = await client.fetchUnseen();
  assertEquals(result.length, 2);
  assertEquals(result[0].from, "alice@example.com");
  assertEquals(result[1].body, "How are you?");

  await client.disconnect();
});

Deno.test("mock IMAP: second fetch returns empty (messages marked read)", async () => {
  const messages: ImapMessage[] = [
    {
      uid: 1,
      from: "alice@example.com",
      subject: "Hello",
      body: "Hi",
      date: new Date(),
    },
  ];

  const client = createMockImapClient(messages);
  await client.connect();

  const first = await client.fetchUnseen();
  assertEquals(first.length, 1);

  const second = await client.fetchUnseen();
  assertEquals(second.length, 0);

  await client.disconnect();
});

Deno.test("mock IMAP: fetchUnseen throws when not connected", async () => {
  const client = createMockImapClient([]);
  let threw = false;

  try {
    await client.fetchUnseen();
  } catch {
    threw = true;
  }

  assertEquals(threw, true);
});

Deno.test("mock IMAP: empty messages list returns empty", async () => {
  const client = createMockImapClient([]);
  await client.connect();

  const result = await client.fetchUnseen();
  assertEquals(result.length, 0);

  await client.disconnect();
});

// ---------------------------------------------------------------------------
// Email adapter integration with mock IMAP
// ---------------------------------------------------------------------------

Deno.test({
  name: "email adapter: receives messages via IMAP polling",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const messages: ImapMessage[] = [
      {
        uid: 1,
        from: "sender@test.com",
        subject: "Test Email",
        body: "Hello from email",
        date: new Date(),
      },
    ];

    const mockImap = createMockImapClient(messages);

    const channel = createEmailChannel({
      smtpApiUrl: "https://api.sendgrid.com/v3/mail/send",
      smtpApiKey: "test-key",
      imapHost: "imap.test.com",
      imapUser: "test@test.com",
      imapPassword: "password",
      fromAddress: "bot@test.com",
      pollInterval: 60000, // Long interval so we don't get extra polls
      _imapClient: mockImap,
    });

    const received: ChannelMessage[] = [];
    channel.onMessage((msg) => {
      received.push(msg);
    });

    await channel.connect();

    // Wait for initial poll to complete
    await new Promise((r) => setTimeout(r, 100));

    assertEquals(received.length, 1);
    assertEquals(received[0].content, "Hello from email");
    assertEquals(received[0].sessionId, "email-sender@test.com");

    await channel.disconnect();
  },
});

Deno.test({
  name: "email adapter: maps sender address to session ID",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const messages: ImapMessage[] = [
      {
        uid: 1,
        from: "alice@example.com",
        subject: "A",
        body: "msg1",
        date: new Date(),
      },
      {
        uid: 2,
        from: "bob@example.com",
        subject: "B",
        body: "msg2",
        date: new Date(),
      },
    ];

    const channel = createEmailChannel({
      smtpApiUrl: "https://api.test.com",
      smtpApiKey: "key",
      imapHost: "imap.test.com",
      imapUser: "test@test.com",
      imapPassword: "pass",
      fromAddress: "bot@test.com",
      pollInterval: 60000,
      _imapClient: createMockImapClient(messages),
    });

    const received: ChannelMessage[] = [];
    channel.onMessage((msg) => received.push(msg));

    await channel.connect();
    await new Promise((r) => setTimeout(r, 100));

    assertEquals(received.length, 2);
    assertEquals(received[0].sessionId, "email-alice@example.com");
    assertEquals(received[1].sessionId, "email-bob@example.com");

    await channel.disconnect();
  },
});

Deno.test("email adapter: defaults to CONFIDENTIAL classification", () => {
  const channel = createEmailChannel({
    smtpApiUrl: "https://api.test.com",
    smtpApiKey: "key",
    imapHost: "imap.test.com",
    imapUser: "test@test.com",
    imapPassword: "pass",
    fromAddress: "bot@test.com",
    _imapClient: createMockImapClient([]),
  });

  assertEquals(channel.classification, "CONFIDENTIAL");
});

Deno.test({
  name:
    "email adapter: unconfigured ownerEmail means no sender is owner (fail closed)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const messages: ImapMessage[] = [
      {
        uid: 1,
        from: "stranger@test.com",
        subject: "Hi",
        body: "I am totally the owner",
        date: new Date(),
      },
    ];

    const channel = createEmailChannel({
      smtpApiUrl: "https://api.test.com",
      smtpApiKey: "key",
      imapHost: "imap.test.com",
      imapUser: "test@test.com",
      imapPassword: "pass",
      fromAddress: "bot@test.com",
      pollInterval: 60000,
      // No ownerEmail configured
      _imapClient: createMockImapClient(messages),
    });

    const received: ChannelMessage[] = [];
    channel.onMessage((msg) => received.push(msg));

    await channel.connect();
    await new Promise((r) => setTimeout(r, 100));

    assertEquals(received.length, 1);
    assertEquals(received[0].isOwner, false);
    assertEquals(received[0].sessionTaint, "PUBLIC");

    await channel.disconnect();
  },
});

Deno.test({
  name: "email adapter: configured ownerEmail grants owner only to that sender",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const messages: ImapMessage[] = [
      {
        uid: 1,
        from: "owner@test.com",
        subject: "Owner",
        body: "from the owner",
        date: new Date(),
      },
      {
        uid: 2,
        from: "stranger@test.com",
        subject: "Stranger",
        body: "from a stranger",
        date: new Date(),
      },
    ];

    const channel = createEmailChannel({
      smtpApiUrl: "https://api.test.com",
      smtpApiKey: "key",
      imapHost: "imap.test.com",
      imapUser: "test@test.com",
      imapPassword: "pass",
      fromAddress: "bot@test.com",
      ownerEmail: "owner@test.com",
      pollInterval: 60000,
      _imapClient: createMockImapClient(messages),
    });

    const received: ChannelMessage[] = [];
    channel.onMessage((msg) => received.push(msg));

    await channel.connect();
    await new Promise((r) => setTimeout(r, 100));

    assertEquals(received.length, 2);
    assertEquals(received[0].isOwner, true);
    assertEquals(received[1].isOwner, false);

    await channel.disconnect();
  },
});
