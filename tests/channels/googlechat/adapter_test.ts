/**
 * Google Chat channel adapter tests.
 *
 * Uses injectable PubSub pull functions and fetch mocks to test
 * the adapter without real Google API calls.
 *
 * @module
 */

import { assertEquals, assertRejects } from "@std/assert";
import { createGoogleChatChannel } from "../../../src/channels/googlechat/adapter.ts";
import type {
  GoogleChatConfig,
  GoogleChatEvent,
  PubSubPullResponse,
} from "../../../src/channels/googlechat/types.ts";
import type { ChannelMessage } from "../../../src/channels/types.ts";

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Encode a GoogleChatEvent as base64 (simulates PubSub message data). */
function encodeEvent(event: GoogleChatEvent): string {
  return btoa(JSON.stringify(event));
}

/** Build a mock PubSub pull function that returns canned responses. */
function createMockPullFn(
  responses: PubSubPullResponse[],
): GoogleChatConfig["_pullFn"] {
  let callIndex = 0;
  return (_subscription: string, _maxMessages: number) => {
    const response = responses[callIndex] ?? { receivedMessages: [] };
    callIndex++;
    return Promise.resolve(response);
  };
}

/** Build a mock fetch function that records calls and returns 200 OK. */
function createMockFetch(): {
  fetchFn: typeof fetch;
  calls: Array<{ url: string; body: string }>;
} {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchFn = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    calls.push({ url, body: (init?.body as string) ?? "" });
    return Promise.resolve(
      new Response(JSON.stringify({ name: "spaces/AAAA/messages/123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  return { fetchFn: fetchFn as typeof fetch, calls };
}

/** Build a standard test config with injectable mocks. */
function createTestConfig(
  overrides: Partial<GoogleChatConfig> = {},
): GoogleChatConfig {
  return {
    getAccessToken: () => Promise.resolve("test-token"),
    pubsubSubscription: "projects/test/subscriptions/test-sub",
    ownerEmail: "owner@company.com",
    ...overrides,
  };
}

/** Create a DM message event. */
function createDmEvent(
  senderEmail: string,
  text: string,
  messageName = "spaces/DM_AAAA/messages/MSG1",
): GoogleChatEvent {
  return {
    type: "MESSAGE",
    message: {
      name: messageName,
      text,
      sender: { name: "users/123", email: senderEmail, type: "HUMAN" },
      space: { name: "spaces/DM_AAAA", type: "DM", singleUserBotDm: true },
    },
  };
}

/** Authoritative Chat API message served by the verifying fetch mock. */
interface MockApiMessage {
  readonly senderUserId: string;
  readonly text: string;
  readonly space: {
    readonly name: string;
    readonly type?: string;
    readonly singleUserBotDm?: boolean;
  };
}

/**
 * Build a fetch mock that serves the Chat API endpoints used by owner
 * verification: spaces:findDirectMessage, members.list, and messages.get.
 */
function createVerifyingFetch(options: {
  readonly dmSpace: string;
  readonly ownerUserId: string;
  readonly messages: Readonly<Record<string, MockApiMessage>>;
}): { fetchFn: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const json = (body: unknown): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  const fetchFn = (
    input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    urls.push(url);
    if (url.includes("spaces:findDirectMessage")) {
      return json({ name: options.dmSpace, type: "DM" });
    }
    if (url.includes(`/v1/${options.dmSpace}/members`)) {
      return json({
        memberships: [
          { member: { name: "users/bot", type: "BOT" } },
          { member: { name: options.ownerUserId, type: "HUMAN" } },
        ],
      });
    }
    for (const [name, msg] of Object.entries(options.messages)) {
      if (url === `https://chat.googleapis.com/v1/${name}`) {
        return json({
          name,
          sender: { name: msg.senderUserId, type: "HUMAN" },
          text: msg.text,
          argumentText: msg.text,
          space: msg.space,
        });
      }
    }
    return json({});
  };
  return { fetchFn: fetchFn as typeof fetch, urls };
}

/** Create a group space message event with optional bot mention. */
function createGroupEvent(
  senderEmail: string,
  text: string,
  options: { mentioned?: boolean; messageName?: string } = {},
): GoogleChatEvent {
  const annotations = options.mentioned
    ? [{
      type: "USER_MENTION",
      userMention: {
        user: { name: "users/bot", type: "BOT" },
        type: "MENTION",
      },
    }]
    : [];
  return {
    type: "MESSAGE",
    message: {
      name: options.messageName ?? "spaces/SPACE_BBBB/messages/GMSG1",
      text,
      argumentText: text,
      sender: { name: "users/456", email: senderEmail, type: "HUMAN" },
      space: {
        name: "spaces/SPACE_BBBB",
        type: "ROOM",
        displayName: "Engineering",
      },
      annotations,
    },
  };
}

// ─── Adapter creation tests ─────────────────────────────────────────────────

Deno.test("googlechat adapter: defaults to INTERNAL classification", () => {
  const config = createTestConfig({
    _pullFn: createMockPullFn([]),
  });
  const adapter = createGoogleChatChannel(config);
  assertEquals(adapter.classification, "INTERNAL");
});

Deno.test("googlechat adapter: respects custom classification", () => {
  const config = createTestConfig({
    classification: "CONFIDENTIAL",
    _pullFn: createMockPullFn([]),
  });
  const adapter = createGoogleChatChannel(config);
  assertEquals(adapter.classification, "CONFIDENTIAL");
});

// ─── Connect / disconnect tests ─────────────────────────────────────────────

Deno.test({
  name: "googlechat adapter: connect sets connected state",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const config = createTestConfig({
      _pullFn: createMockPullFn([{ receivedMessages: [] }]),
    });
    const adapter = createGoogleChatChannel(config);

    assertEquals(adapter.status().connected, false);
    await adapter.connect();
    assertEquals(adapter.status().connected, true);
    assertEquals(adapter.status().channelType, "googlechat");
    await adapter.disconnect();
  },
});

Deno.test({
  name: "googlechat adapter: disconnect clears poll timer",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const config = createTestConfig({
      _pullFn: createMockPullFn([{ receivedMessages: [] }]),
    });
    const adapter = createGoogleChatChannel(config);

    await adapter.connect();
    assertEquals(adapter.status().connected, true);

    await adapter.disconnect();
    assertEquals(adapter.status().connected, false);
  },
});

// ─── DM message dispatch tests ──────────────────────────────────────────────

Deno.test({
  name:
    "googlechat adapter: DM messages produce googlechat-{space} session IDs",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Non-owner sender: exercises the session-ID shape without the
    // Chat API verification that owner-claimed events go through.
    const dmEvent = createDmEvent("user@company.com", "Hello bot");
    const config = createTestConfig({
      _pullFn: createMockPullFn([{
        receivedMessages: [{
          ackId: "ack-1",
          message: {
            data: encodeEvent(dmEvent),
            messageId: "msg-1",
            publishTime: "2026-01-01T00:00:00Z",
          },
        }],
      }]),
      _fetchFn: createMockFetch().fetchFn,
    });

    const received: ChannelMessage[] = [];
    const adapter = createGoogleChatChannel(config);
    adapter.onMessage((msg) => received.push(msg));

    await adapter.connect();
    await new Promise((r) => setTimeout(r, 100));

    assertEquals(received.length, 1);
    assertEquals(received[0].sessionId, "googlechat-spaces%2FDM_AAAA");
    assertEquals(received[0].content, "Hello bot");
    assertEquals(received[0].isGroup, false);

    await adapter.disconnect();
  },
});

Deno.test({
  name:
    "googlechat adapter: owner status requires Chat API verification, external stays non-owner",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ownerEvent = createDmEvent("owner@company.com", "owner msg");
    const externalEvent = createDmEvent("external@other.com", "external msg");

    const { fetchFn } = createVerifyingFetch({
      dmSpace: "spaces/DM_AAAA",
      ownerUserId: "users/123",
      messages: {
        "spaces/DM_AAAA/messages/MSG1": {
          senderUserId: "users/123",
          text: "owner msg",
          space: { name: "spaces/DM_AAAA", type: "DM", singleUserBotDm: true },
        },
      },
    });

    const config = createTestConfig({
      ownerEmail: "owner@company.com",
      _pullFn: createMockPullFn([{
        receivedMessages: [
          {
            ackId: "ack-1",
            message: {
              data: encodeEvent(ownerEvent),
              messageId: "msg-1",
              publishTime: "2026-01-01T00:00:00Z",
            },
          },
          {
            ackId: "ack-2",
            message: {
              data: encodeEvent(externalEvent),
              messageId: "msg-2",
              publishTime: "2026-01-01T00:00:01Z",
            },
          },
        ],
      }]),
      _fetchFn: fetchFn,
    });

    const received: ChannelMessage[] = [];
    const adapter = createGoogleChatChannel(config);
    adapter.onMessage((msg) => received.push(msg));

    await adapter.connect();
    await new Promise((r) => setTimeout(r, 100));

    assertEquals(received.length, 2);
    assertEquals(received[0].isOwner, true);
    assertEquals(received[0].content, "owner msg");
    assertEquals(received[1].isOwner, false);
    assertEquals(received[1].sessionTaint, "PUBLIC");

    await adapter.disconnect();
  },
});

// ─── Owner verification security tests ──────────────────────────────────────

Deno.test({
  name:
    "googlechat adapter: forged owner-claimed event is dropped and acknowledged",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Event claims the owner's email, but the authoritative Chat API
    // message was sent by a different user — must never reach the handler.
    const forgedEvent = createDmEvent(
      "owner@company.com",
      "evil text",
      "spaces/DM_AAAA/messages/FORGED",
    );

    const { fetchFn } = createVerifyingFetch({
      dmSpace: "spaces/DM_AAAA",
      ownerUserId: "users/123",
      messages: {
        "spaces/DM_AAAA/messages/FORGED": {
          senderUserId: "users/999",
          text: "evil text",
          space: { name: "spaces/DM_AAAA", type: "DM", singleUserBotDm: true },
        },
      },
    });

    const ackedIds: string[] = [];
    const config = createTestConfig({
      ownerEmail: "owner@company.com",
      _pullFn: createMockPullFn([{
        receivedMessages: [{
          ackId: "ack-1",
          message: {
            data: encodeEvent(forgedEvent),
            messageId: "msg-1",
            publishTime: "2026-01-01T00:00:00Z",
          },
        }],
      }]),
      _ackFn: (_sub, ackIds) => {
        ackedIds.push(...ackIds);
        return Promise.resolve();
      },
      _fetchFn: fetchFn,
    });

    const received: ChannelMessage[] = [];
    const adapter = createGoogleChatChannel(config);
    adapter.onMessage((msg) => received.push(msg));

    await adapter.connect();
    await new Promise((r) => setTimeout(r, 100));

    assertEquals(received.length, 0);
    assertEquals(ackedIds, ["ack-1"]);

    await adapter.disconnect();
  },
});

Deno.test({
  name:
    "googlechat adapter: owner session is bound to the authoritative space, not the event's",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Forged envelope claims an attacker-chosen space but references a
    // real owner message; the session must bind to the API's space.
    const event: GoogleChatEvent = {
      type: "MESSAGE",
      message: {
        name: "spaces/DM_AAAA/messages/MSG1",
        text: "owner msg",
        sender: {
          name: "users/123",
          email: "owner@company.com",
          type: "HUMAN",
        },
        space: { name: "spaces/EVIL", type: "DM", singleUserBotDm: true },
      },
    };

    const { fetchFn } = createVerifyingFetch({
      dmSpace: "spaces/DM_AAAA",
      ownerUserId: "users/123",
      messages: {
        "spaces/DM_AAAA/messages/MSG1": {
          senderUserId: "users/123",
          text: "owner msg",
          space: { name: "spaces/DM_AAAA", type: "DM", singleUserBotDm: true },
        },
      },
    });

    const config = createTestConfig({
      ownerEmail: "owner@company.com",
      _pullFn: createMockPullFn([{
        receivedMessages: [{
          ackId: "ack-1",
          message: {
            data: encodeEvent(event),
            messageId: "msg-1",
            publishTime: "2026-01-01T00:00:00Z",
          },
        }],
      }]),
      _fetchFn: fetchFn,
    });

    const received: ChannelMessage[] = [];
    const adapter = createGoogleChatChannel(config);
    adapter.onMessage((msg) => received.push(msg));

    await adapter.connect();
    await new Promise((r) => setTimeout(r, 100));

    assertEquals(received.length, 1);
    assertEquals(received[0].isOwner, true);
    assertEquals(received[0].sessionId, "googlechat-spaces%2FDM_AAAA");

    await adapter.disconnect();
  },
});

Deno.test({
  name: "googlechat adapter: replayed owner event is rejected but acknowledged",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ownerEvent = createDmEvent("owner@company.com", "owner msg");

    const { fetchFn } = createVerifyingFetch({
      dmSpace: "spaces/DM_AAAA",
      ownerUserId: "users/123",
      messages: {
        "spaces/DM_AAAA/messages/MSG1": {
          senderUserId: "users/123",
          text: "owner msg",
          space: { name: "spaces/DM_AAAA", type: "DM", singleUserBotDm: true },
        },
      },
    });

    const ackedIds: string[] = [];
    const config = createTestConfig({
      ownerEmail: "owner@company.com",
      _pullFn: createMockPullFn([{
        receivedMessages: [
          {
            ackId: "ack-1",
            message: {
              data: encodeEvent(ownerEvent),
              messageId: "msg-1",
              publishTime: "2026-01-01T00:00:00Z",
            },
          },
          {
            ackId: "ack-2",
            message: {
              data: encodeEvent(ownerEvent),
              messageId: "msg-2",
              publishTime: "2026-01-01T00:00:01Z",
            },
          },
        ],
      }]),
      _ackFn: (_sub, ackIds) => {
        ackedIds.push(...ackIds);
        return Promise.resolve();
      },
      _fetchFn: fetchFn,
    });

    const received: ChannelMessage[] = [];
    const adapter = createGoogleChatChannel(config);
    adapter.onMessage((msg) => received.push(msg));

    await adapter.connect();
    await new Promise((r) => setTimeout(r, 100));

    assertEquals(received.length, 1);
    assertEquals(ackedIds, ["ack-1", "ack-2"]);

    await adapter.disconnect();
  },
});

Deno.test({
  name:
    "googlechat adapter: transient Chat API failure leaves the message unacked for redelivery",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const ownerEvent = createDmEvent("owner@company.com", "owner msg");

    const failingFetch = (
      _input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => Promise.reject(new Error("network down"));

    const ackedIds: string[] = [];
    const config = createTestConfig({
      ownerEmail: "owner@company.com",
      _pullFn: createMockPullFn([{
        receivedMessages: [{
          ackId: "ack-1",
          message: {
            data: encodeEvent(ownerEvent),
            messageId: "msg-1",
            publishTime: "2026-01-01T00:00:00Z",
          },
        }],
      }]),
      _ackFn: (_sub, ackIds) => {
        ackedIds.push(...ackIds);
        return Promise.resolve();
      },
      _fetchFn: failingFetch as typeof fetch,
    });

    const received: ChannelMessage[] = [];
    const adapter = createGoogleChatChannel(config);
    adapter.onMessage((msg) => received.push(msg));

    await adapter.connect();
    await new Promise((r) => setTimeout(r, 100));

    assertEquals(received.length, 0);
    assertEquals(ackedIds, []);

    await adapter.disconnect();
  },
});

Deno.test({
  name: "googlechat adapter: verified owner message in a group space",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const groupEvent = createGroupEvent(
      "owner@company.com",
      "deploy it",
      { mentioned: true },
    );

    const { fetchFn } = createVerifyingFetch({
      dmSpace: "spaces/DM_AAAA",
      ownerUserId: "users/456",
      messages: {
        "spaces/SPACE_BBBB/messages/GMSG1": {
          senderUserId: "users/456",
          text: "deploy it",
          space: { name: "spaces/SPACE_BBBB", type: "ROOM" },
        },
      },
    });

    const config = createTestConfig({
      ownerEmail: "owner@company.com",
      defaultGroupMode: "mentioned-only",
      _pullFn: createMockPullFn([{
        receivedMessages: [{
          ackId: "ack-1",
          message: {
            data: encodeEvent(groupEvent),
            messageId: "msg-1",
            publishTime: "2026-01-01T00:00:00Z",
          },
        }],
      }]),
      _fetchFn: fetchFn,
    });

    const received: ChannelMessage[] = [];
    const adapter = createGoogleChatChannel(config);
    adapter.onMessage((msg) => received.push(msg));

    await adapter.connect();
    await new Promise((r) => setTimeout(r, 100));

    assertEquals(received.length, 1);
    assertEquals(received[0].isOwner, true);
    assertEquals(received[0].isGroup, true);
    assertEquals(
      received[0].sessionId,
      "googlechat-group-spaces%2FSPACE_BBBB",
    );

    await adapter.disconnect();
  },
});

// ─── Group space tests ──────────────────────────────────────────────────────

Deno.test({
  name:
    "googlechat adapter: group messages produce googlechat-group-{space} session IDs",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const groupEvent = createGroupEvent(
      "user@company.com",
      "Hey @bot check this",
      { mentioned: true },
    );

    const config = createTestConfig({
      defaultGroupMode: "mentioned-only",
      _pullFn: createMockPullFn([{
        receivedMessages: [{
          ackId: "ack-1",
          message: {
            data: encodeEvent(groupEvent),
            messageId: "msg-1",
            publishTime: "2026-01-01T00:00:00Z",
          },
        }],
      }]),
      _fetchFn: createMockFetch().fetchFn,
    });

    const received: ChannelMessage[] = [];
    const adapter = createGoogleChatChannel(config);
    adapter.onMessage((msg) => received.push(msg));

    await adapter.connect();
    await new Promise((r) => setTimeout(r, 100));

    assertEquals(received.length, 1);
    assertEquals(received[0].sessionId, "googlechat-group-spaces%2FSPACE_BBBB");
    assertEquals(received[0].isGroup, true);
    assertEquals(received[0].groupId, "spaces/SPACE_BBBB");

    await adapter.disconnect();
  },
});

Deno.test({
  name:
    "googlechat adapter: mentioned-only mode filters non-mentioned group messages",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const notMentionedEvent = createGroupEvent(
      "user@company.com",
      "Just chatting",
      { mentioned: false },
    );

    const config = createTestConfig({
      defaultGroupMode: "mentioned-only",
      _pullFn: createMockPullFn([{
        receivedMessages: [{
          ackId: "ack-1",
          message: {
            data: encodeEvent(notMentionedEvent),
            messageId: "msg-1",
            publishTime: "2026-01-01T00:00:00Z",
          },
        }],
      }]),
      _fetchFn: createMockFetch().fetchFn,
    });

    const received: ChannelMessage[] = [];
    const adapter = createGoogleChatChannel(config);
    adapter.onMessage((msg) => received.push(msg));

    await adapter.connect();
    await new Promise((r) => setTimeout(r, 100));

    assertEquals(received.length, 0);

    await adapter.disconnect();
  },
});

Deno.test({
  name: "googlechat adapter: always mode dispatches all group messages",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const notMentionedEvent = createGroupEvent(
      "user@company.com",
      "Just chatting",
      { mentioned: false },
    );

    const config = createTestConfig({
      defaultGroupMode: "always",
      _pullFn: createMockPullFn([{
        receivedMessages: [{
          ackId: "ack-1",
          message: {
            data: encodeEvent(notMentionedEvent),
            messageId: "msg-1",
            publishTime: "2026-01-01T00:00:00Z",
          },
        }],
      }]),
      _fetchFn: createMockFetch().fetchFn,
    });

    const received: ChannelMessage[] = [];
    const adapter = createGoogleChatChannel(config);
    adapter.onMessage((msg) => received.push(msg));

    await adapter.connect();
    await new Promise((r) => setTimeout(r, 100));

    assertEquals(received.length, 1);

    await adapter.disconnect();
  },
});

// ─── Send tests ─────────────────────────────────────────────────────────────

Deno.test({
  name: "googlechat adapter: send calls Chat API with correct space name",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { fetchFn, calls } = createMockFetch();
    const config = createTestConfig({
      _pullFn: createMockPullFn([{ receivedMessages: [] }]),
      _fetchFn: fetchFn,
    });
    const adapter = createGoogleChatChannel(config);

    await adapter.connect();
    await adapter.send({
      content: "Hello from Triggerfish",
      sessionId: "googlechat-spaces%2FDM_AAAA",
    });

    // Find the Chat API call (not the PubSub pull or ack calls)
    const chatCalls = calls.filter((c) => {
      try {
        return new URL(c.url).hostname === "chat.googleapis.com";
      } catch {
        return false;
      }
    });
    assertEquals(chatCalls.length, 1);
    assertEquals(
      chatCalls[0].url,
      "https://chat.googleapis.com/v1/spaces/DM_AAAA/messages",
    );
    const body = JSON.parse(chatCalls[0].body);
    assertEquals(body.text, "Hello from Triggerfish");

    await adapter.disconnect();
  },
});

Deno.test({
  name: "googlechat adapter: send to group session extracts correct space",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { fetchFn, calls } = createMockFetch();
    const config = createTestConfig({
      _pullFn: createMockPullFn([{ receivedMessages: [] }]),
      _fetchFn: fetchFn,
    });
    const adapter = createGoogleChatChannel(config);

    await adapter.connect();
    await adapter.send({
      content: "Reply to group",
      sessionId: "googlechat-group-spaces%2FSPACE_BBBB",
    });

    const chatCalls = calls.filter((c) => {
      try {
        return new URL(c.url).hostname === "chat.googleapis.com";
      } catch {
        return false;
      }
    });
    assertEquals(chatCalls.length, 1);
    assertEquals(
      chatCalls[0].url,
      "https://chat.googleapis.com/v1/spaces/SPACE_BBBB/messages",
    );

    await adapter.disconnect();
  },
});

// ─── Typing indicator test ──────────────────────────────────────────────────

Deno.test({
  name: "googlechat adapter: sendTyping does not throw",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const config = createTestConfig({
      _pullFn: createMockPullFn([{ receivedMessages: [] }]),
    });
    const adapter = createGoogleChatChannel(config);

    await adapter.connect();
    // sendTyping is a no-op for Google Chat but should not throw
    await adapter.sendTyping("googlechat-spaces%2FDM_AAAA");
    await adapter.disconnect();
  },
});

// ─── Error handling test ────────────────────────────────────────────────────

Deno.test({
  name: "googlechat adapter: poll error is logged but not thrown",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const errorPullFn = (
      _subscription: string,
      _maxMessages: number,
    ): Promise<PubSubPullResponse> => {
      return Promise.reject(new Error("Network error"));
    };

    const config = createTestConfig({
      _pullFn: errorPullFn,
    });
    const adapter = createGoogleChatChannel(config);

    // Should not throw — errors are caught and logged
    await adapter.connect();
    await new Promise((r) => setTimeout(r, 100));
    await adapter.disconnect();
  },
});

// ─── Owner-only group mode test (#16) ────────────────────────────────────────

Deno.test({
  name: "googlechat adapter: owner-only mode filters all group messages",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const mentionedEvent = createGroupEvent(
      "user@company.com",
      "Hey @bot check this",
      { mentioned: true },
    );

    const config = createTestConfig({
      defaultGroupMode: "owner-only",
      _pullFn: createMockPullFn([{
        receivedMessages: [{
          ackId: "ack-1",
          message: {
            data: encodeEvent(mentionedEvent),
            messageId: "msg-1",
            publishTime: "2026-01-01T00:00:00Z",
          },
        }],
      }]),
      _fetchFn: createMockFetch().fetchFn,
    });

    const received: ChannelMessage[] = [];
    const adapter = createGoogleChatChannel(config);
    adapter.onMessage((msg) => received.push(msg));

    await adapter.connect();
    await new Promise((r) => setTimeout(r, 100));

    // owner-only mode should filter ALL group messages (even @mentions)
    assertEquals(received.length, 0);

    await adapter.disconnect();
  },
});

// ─── Send failure propagation test (#17) ────────────────────────────────────

Deno.test({
  name: "googlechat adapter: send failure propagates after logging",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const errorFetchFn = (
      _input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      return Promise.resolve(
        new Response("Service unavailable", { status: 503 }),
      );
    };

    const config = createTestConfig({
      _pullFn: createMockPullFn([{ receivedMessages: [] }]),
      _fetchFn: errorFetchFn as typeof fetch,
    });
    const adapter = createGoogleChatChannel(config);

    await adapter.connect();

    const err = await assertRejects(
      () =>
        adapter.send({
          content: "test message",
          sessionId: "googlechat-spaces%2FDM_AAAA",
        }),
      Error,
    );
    assertEquals(err.message.includes("Google Chat send failed (503)"), true);

    await adapter.disconnect();
  },
});

// ─── Non-MESSAGE event filtering ────────────────────────────────────────────

Deno.test({
  name: "googlechat adapter: non-MESSAGE events are ignored",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const addedToSpaceEvent: GoogleChatEvent = {
      type: "ADDED_TO_SPACE",
      space: { name: "spaces/NEW", type: "DM" },
      user: { name: "users/789", email: "user@company.com" },
    };

    const config = createTestConfig({
      _pullFn: createMockPullFn([{
        receivedMessages: [{
          ackId: "ack-1",
          message: {
            data: encodeEvent(addedToSpaceEvent),
            messageId: "msg-1",
            publishTime: "2026-01-01T00:00:00Z",
          },
        }],
      }]),
      _fetchFn: createMockFetch().fetchFn,
    });

    const received: ChannelMessage[] = [];
    const adapter = createGoogleChatChannel(config);
    adapter.onMessage((msg) => received.push(msg));

    await adapter.connect();
    await new Promise((r) => setTimeout(r, 100));

    assertEquals(received.length, 0);

    await adapter.disconnect();
  },
});
