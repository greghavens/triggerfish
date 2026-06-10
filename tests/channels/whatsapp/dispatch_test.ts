/**
 * @module WhatsApp message dispatch tests.
 *
 * Tests signed-webhook dispatch, owner detection, non-owner taint,
 * no-ownerPhone fail-safe, signature rejection (missing/invalid/unconfigured),
 * non-text/empty-body skipping, and send with missing sessionId.
 */
import { assertEquals } from "@std/assert";
import { createWhatsAppChannel } from "../../../src/channels/whatsapp/adapter.ts";
import type { ChannelMessage } from "../../../src/channels/types.ts";

/** Base port for WhatsApp dispatch tests (each test offsets from this). */
const BASE_PORT = 19_400;

/** App secret shared between the test client and the adapter. */
const TEST_APP_SECRET = "test-app-secret";

/** Build a minimal WhatsApp config for testing (signature verification on). */
function buildTestConfig(portOffset: number) {
  return {
    accessToken: "test-access-token",
    phoneNumberId: "123456789",
    verifyToken: "test-verify-token",
    appSecret: TEST_APP_SECRET,
    webhookPort: BASE_PORT + portOffset,
  };
}

/** Compute the hex HMAC-SHA256 the way Meta signs webhook bodies. */
async function signBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  return Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** POST a signed webhook body to the adapter, returning the response. */
async function postSigned(
  port: number,
  body: string,
  secret = TEST_APP_SECRET,
): Promise<Response> {
  const hex = await signBody(secret, body);
  return await fetch(`http://127.0.0.1:${port}/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": `sha256=${hex}`,
    },
    body,
  });
}

/** Build a Cloud API webhook payload containing one text message. */
function buildWebhookPayload(
  from: string,
  body: string,
  type = "text",
): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "BIZ_ID",
      changes: [{
        value: {
          messaging_product: "whatsapp",
          metadata: {
            display_phone_number: "15550001111",
            phone_number_id: "123456789",
          },
          messages: [{
            from,
            id: "wamid.test123",
            timestamp: "1700000000",
            type,
            ...(type === "text" ? { text: { body } } : {}),
          }],
        },
        field: "messages",
      }],
    }],
  };
}

Deno.test({
  name:
    "WhatsApp: signed text message dispatches to handler with correct fields",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const port = BASE_PORT + 20;
    const adapter = createWhatsAppChannel({
      ...buildTestConfig(20),
      webhookPort: port,
    });
    const received: ChannelMessage[] = [];
    adapter.onMessage((msg) => received.push(msg));
    await adapter.connect();
    try {
      const body = JSON.stringify(
        buildWebhookPayload("15559876543", "Hello agent"),
      );
      const resp = await postSigned(port, body);
      assertEquals(resp.status, 200);
      await resp.body?.cancel();
      assertEquals(received.length, 1);
      assertEquals(received[0].content, "Hello agent");
      assertEquals(received[0].sessionId, "whatsapp-15559876543");
      assertEquals(received[0].senderId, "15559876543");
      assertEquals(received[0].isGroup, false);
    } finally {
      await adapter.disconnect();
    }
  },
});

Deno.test({
  name: "WhatsApp: owner phone match sets isOwner true",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const port = BASE_PORT + 21;
    const adapter = createWhatsAppChannel({
      ...buildTestConfig(21),
      webhookPort: port,
      ownerPhone: "15559876543",
    });
    const received: ChannelMessage[] = [];
    adapter.onMessage((msg) => received.push(msg));
    await adapter.connect();
    try {
      const body = JSON.stringify(
        buildWebhookPayload("15559876543", "Owner msg"),
      );
      const resp = await postSigned(port, body);
      await resp.body?.cancel();
      assertEquals(received.length, 1);
      assertEquals(received[0].isOwner, true);
      assertEquals(received[0].sessionTaint, undefined);
    } finally {
      await adapter.disconnect();
    }
  },
});

Deno.test({
  name: "WhatsApp: non-owner phone sets isOwner false with PUBLIC taint",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const port = BASE_PORT + 22;
    const adapter = createWhatsAppChannel({
      ...buildTestConfig(22),
      webhookPort: port,
      ownerPhone: "15550000001",
    });
    const received: ChannelMessage[] = [];
    adapter.onMessage((msg) => received.push(msg));
    await adapter.connect();
    try {
      const body = JSON.stringify(
        buildWebhookPayload("15559999999", "Stranger msg"),
      );
      const resp = await postSigned(port, body);
      await resp.body?.cancel();
      assertEquals(received.length, 1);
      assertEquals(received[0].isOwner, false);
      assertEquals(received[0].sessionTaint, "PUBLIC");
    } finally {
      await adapter.disconnect();
    }
  },
});

Deno.test({
  name: "WhatsApp: no ownerPhone configured treats sender as non-owner",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const port = BASE_PORT + 23;
    const adapter = createWhatsAppChannel({
      ...buildTestConfig(23),
      webhookPort: port,
    });
    const received: ChannelMessage[] = [];
    adapter.onMessage((msg) => received.push(msg));
    await adapter.connect();
    try {
      const body = JSON.stringify(
        buildWebhookPayload("15550009999", "Anyone msg"),
      );
      const resp = await postSigned(port, body);
      await resp.body?.cancel();
      assertEquals(received.length, 1);
      assertEquals(received[0].isOwner, false);
      assertEquals(received[0].sessionTaint, "PUBLIC");
    } finally {
      await adapter.disconnect();
    }
  },
});

Deno.test({
  name: "WhatsApp: POST without signature returns 403 and does not dispatch",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const port = BASE_PORT + 26;
    const adapter = createWhatsAppChannel({
      ...buildTestConfig(26),
      webhookPort: port,
      ownerPhone: "15559876543",
    });
    const received: ChannelMessage[] = [];
    adapter.onMessage((msg) => received.push(msg));
    await adapter.connect();
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildWebhookPayload("15559876543", "forged")),
      });
      assertEquals(resp.status, 403);
      await resp.body?.cancel();
      assertEquals(received.length, 0);
    } finally {
      await adapter.disconnect();
    }
  },
});

Deno.test({
  name: "WhatsApp: POST with invalid signature returns 403",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const port = BASE_PORT + 27;
    const adapter = createWhatsAppChannel({
      ...buildTestConfig(27),
      webhookPort: port,
      ownerPhone: "15559876543",
    });
    const received: ChannelMessage[] = [];
    adapter.onMessage((msg) => received.push(msg));
    await adapter.connect();
    try {
      const body = JSON.stringify(buildWebhookPayload("15559876543", "forged"));
      const resp = await postSigned(port, body, "wrong-secret");
      assertEquals(resp.status, 403);
      await resp.body?.cancel();
      assertEquals(received.length, 0);
    } finally {
      await adapter.disconnect();
    }
  },
});

Deno.test({
  name: "WhatsApp: POST rejected with 403 when appSecret is unconfigured",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const port = BASE_PORT + 28;
    const adapter = createWhatsAppChannel({
      accessToken: "test-access-token",
      phoneNumberId: "123456789",
      verifyToken: "test-verify-token",
      webhookPort: port,
    });
    const received: ChannelMessage[] = [];
    adapter.onMessage((msg) => received.push(msg));
    await adapter.connect();
    try {
      const body = JSON.stringify(buildWebhookPayload("15559876543", "msg"));
      // Even a body signed with some secret must be rejected: no secret means
      // the adapter cannot establish authenticity.
      const resp = await postSigned(port, body, "any-secret");
      assertEquals(resp.status, 403);
      await resp.body?.cancel();
      assertEquals(received.length, 0);
    } finally {
      await adapter.disconnect();
    }
  },
});

Deno.test({
  name: "WhatsApp: non-text message type is skipped",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const port = BASE_PORT + 24;
    const adapter = createWhatsAppChannel({
      ...buildTestConfig(24),
      webhookPort: port,
    });
    const received: ChannelMessage[] = [];
    adapter.onMessage((msg) => received.push(msg));
    await adapter.connect();
    try {
      const body = JSON.stringify(
        buildWebhookPayload("15551111111", "", "image"),
      );
      const resp = await postSigned(port, body);
      await resp.body?.cancel();
      assertEquals(received.length, 0);
    } finally {
      await adapter.disconnect();
    }
  },
});

Deno.test({
  name: "WhatsApp: empty text body is skipped",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const port = BASE_PORT + 25;
    const adapter = createWhatsAppChannel({
      ...buildTestConfig(25),
      webhookPort: port,
    });
    const received: ChannelMessage[] = [];
    adapter.onMessage((msg) => received.push(msg));
    await adapter.connect();
    try {
      const body = JSON.stringify(
        buildWebhookPayload("15551111111", "", "text"),
      );
      const resp = await postSigned(port, body);
      await resp.body?.cancel();
      assertEquals(received.length, 0);
    } finally {
      await adapter.disconnect();
    }
  },
});

Deno.test("WhatsApp: send with missing sessionId returns early", async () => {
  const adapter = createWhatsAppChannel(buildTestConfig(40));
  // Should not throw — returns early when sessionId is missing
  await adapter.send({ content: "test" });
});

Deno.test("WhatsApp: send calls injected fetchFn with correct API endpoint", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const mockFetch: typeof fetch = (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  const adapter = createWhatsAppChannel({
    ...buildTestConfig(0),
    phoneNumberId: "MY_PHONE_ID",
    fetchFn: mockFetch,
  });
  await adapter.send({ content: "Hello", sessionId: "whatsapp-15551234567" });
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].url,
    "https://graph.facebook.com/v18.0/MY_PHONE_ID/messages",
  );
  assertEquals(calls[0].init.method, "POST");
});
