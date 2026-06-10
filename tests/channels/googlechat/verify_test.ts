/**
 * Google Chat owner verification tests.
 *
 * Exercises createGoogleChatSenderVerifier directly with routed fetch
 * mocks: authoritative-sender checks, replay rejection, resource-name
 * validation, identity caching, and transient-vs-definitive errors.
 *
 * @module
 */

import { assertEquals } from "@std/assert";
import { createGoogleChatSenderVerifier } from "../../../src/channels/googlechat/verify.ts";
import type {
  GoogleChatConfig,
  GoogleChatEvent,
} from "../../../src/channels/googlechat/types.ts";

const DM_SPACE = "spaces/DM_AAAA";
const OWNER_ID = "users/123";
const MSG_NAME = "spaces/DM_AAAA/messages/MSG1";

/** Build an owner-claimed DM event referencing a message resource name. */
function ownerEvent(messageName?: string): GoogleChatEvent {
  return {
    type: "MESSAGE",
    message: {
      name: messageName,
      text: "claimed text",
      sender: { name: OWNER_ID, email: "owner@company.com", type: "HUMAN" },
      space: { name: DM_SPACE, type: "DM", singleUserBotDm: true },
    },
  };
}

/** Routed Chat API fetch mock with per-endpoint call counting. */
function chatApiFetch(options: {
  messageSenderId?: string;
  messageStatus?: number;
  rejectAll?: boolean;
}): { fetchFn: typeof fetch; counts: Record<string, number> } {
  const counts: Record<string, number> = {
    findDirectMessage: 0,
    members: 0,
    message: 0,
  };
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
    if (options.rejectAll) return Promise.reject(new Error("network down"));
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("spaces:findDirectMessage")) {
      counts.findDirectMessage++;
      return json({ name: DM_SPACE, type: "DM" });
    }
    if (url.includes(`/v1/${DM_SPACE}/members`)) {
      counts.members++;
      return json({
        memberships: [
          { member: { name: "users/bot", type: "BOT" } },
          { member: { name: OWNER_ID, type: "HUMAN" } },
        ],
      });
    }
    counts.message++;
    if (options.messageStatus && options.messageStatus !== 200) {
      return Promise.resolve(
        new Response("nope", { status: options.messageStatus }),
      );
    }
    return json({
      name: MSG_NAME,
      sender: { name: options.messageSenderId ?? OWNER_ID, type: "HUMAN" },
      text: "authoritative text",
      argumentText: "authoritative text",
      space: { name: DM_SPACE, type: "DM", singleUserBotDm: true },
    });
  };
  return { fetchFn: fetchFn as typeof fetch, counts };
}

/** Build a verifier config around a fetch mock. */
function verifierConfig(fetchFn: typeof fetch): GoogleChatConfig {
  return {
    getAccessToken: () => Promise.resolve("test-token"),
    pubsubSubscription: "projects/test/subscriptions/test-sub",
    ownerEmail: "owner@company.com",
    _fetchFn: fetchFn,
  };
}

Deno.test("verifier: grants owner for an authoritative owner message", async () => {
  const { fetchFn } = chatApiFetch({});
  const verifier = createGoogleChatSenderVerifier(verifierConfig(fetchFn));

  const result = await verifier.verifyOwnerMessage(ownerEvent(MSG_NAME));

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.text, "authoritative text");
    assertEquals(result.value.senderUserId, OWNER_ID);
    assertEquals(result.value.spaceName, DM_SPACE);
    assertEquals(result.value.isDm, true);
  }
});

Deno.test("verifier: rejects when the authoritative sender is not the owner", async () => {
  const { fetchFn } = chatApiFetch({ messageSenderId: "users/999" });
  const verifier = createGoogleChatSenderVerifier(verifierConfig(fetchFn));

  const result = await verifier.verifyOwnerMessage(ownerEvent(MSG_NAME));

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.transient, false);
    assertEquals(result.error.reason.includes("not the owner"), true);
  }
});

Deno.test("verifier: rejects a missing message name", async () => {
  const { fetchFn } = chatApiFetch({});
  const verifier = createGoogleChatSenderVerifier(verifierConfig(fetchFn));

  const result = await verifier.verifyOwnerMessage(ownerEvent(undefined));

  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.transient, false);
});

Deno.test("verifier: rejects malformed and dot-segment message names", async () => {
  const { fetchFn, counts } = chatApiFetch({});
  const verifier = createGoogleChatSenderVerifier(verifierConfig(fetchFn));

  for (
    const bad of [
      "spaces/DM_AAAA/messages/..",
      "spaces/DM_AAAA/messages/.",
      "spaces/../messages/MSG1",
      "spaces/DM_AAAA/messages/MSG1?alt=media",
      "https://evil.example.com/spaces/x/messages/y",
      "spaces/DM_AAAA/messages/a/b",
    ]
  ) {
    const result = await verifier.verifyOwnerMessage(ownerEvent(bad));
    assertEquals(result.ok, false, `should reject: ${bad}`);
    if (!result.ok) assertEquals(result.error.transient, false);
  }
  // No Chat API call may happen for an invalid name
  assertEquals(counts.message, 0);
  assertEquals(counts.findDirectMessage, 0);
});

Deno.test("verifier: rejects a replayed message name", async () => {
  const { fetchFn } = chatApiFetch({});
  const verifier = createGoogleChatSenderVerifier(verifierConfig(fetchFn));

  const first = await verifier.verifyOwnerMessage(ownerEvent(MSG_NAME));
  assertEquals(first.ok, true);

  const replay = await verifier.verifyOwnerMessage(ownerEvent(MSG_NAME));
  assertEquals(replay.ok, false);
  if (!replay.ok) {
    assertEquals(replay.error.transient, false);
    assertEquals(replay.error.reason.includes("replay"), true);
  }
});

Deno.test("verifier: caches the owner identity across verifications", async () => {
  const { fetchFn, counts } = chatApiFetch({});
  const verifier = createGoogleChatSenderVerifier(verifierConfig(fetchFn));

  await verifier.verifyOwnerMessage(ownerEvent(MSG_NAME));
  await verifier.verifyOwnerMessage(
    ownerEvent("spaces/DM_AAAA/messages/MSG2"),
  );

  assertEquals(counts.findDirectMessage, 1);
  assertEquals(counts.members, 1);
});

Deno.test("verifier: network failure is transient (retryable)", async () => {
  const { fetchFn } = chatApiFetch({ rejectAll: true });
  const verifier = createGoogleChatSenderVerifier(verifierConfig(fetchFn));

  const result = await verifier.verifyOwnerMessage(ownerEvent(MSG_NAME));

  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.transient, true);
});

Deno.test("verifier: 404 on the message fetch is definitive", async () => {
  const { fetchFn } = chatApiFetch({ messageStatus: 404 });
  const verifier = createGoogleChatSenderVerifier(verifierConfig(fetchFn));

  const result = await verifier.verifyOwnerMessage(ownerEvent(MSG_NAME));

  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.transient, false);
});

Deno.test("verifier: 503 on the message fetch is transient", async () => {
  const { fetchFn } = chatApiFetch({ messageStatus: 503 });
  const verifier = createGoogleChatSenderVerifier(verifierConfig(fetchFn));

  const result = await verifier.verifyOwnerMessage(ownerEvent(MSG_NAME));

  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.transient, true);
});

Deno.test("verifier: missing ownerEmail is a definitive rejection", async () => {
  const { fetchFn } = chatApiFetch({});
  const config: GoogleChatConfig = {
    getAccessToken: () => Promise.resolve("test-token"),
    pubsubSubscription: "projects/test/subscriptions/test-sub",
    _fetchFn: fetchFn,
  };
  const verifier = createGoogleChatSenderVerifier(config);

  const result = await verifier.verifyOwnerMessage(ownerEvent(MSG_NAME));

  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.transient, false);
});
