/**
 * WhatsApp adapter integration tests.
 *
 * Tests webhook verification, message parsing, owner detection,
 * non-text message filtering, message length truncation, and send error handling.
 *
 * Each test that starts a webhook server uses a unique port to avoid TCP TIME_WAIT conflicts.
 */
import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { createWhatsAppChannel } from "../../src/channels/whatsapp/adapter.ts";

// Unique ports per test to avoid port-reuse issues when tests run sequentially.
const PORT_GET_VALID = 18440;
const PORT_GET_INVALID = 18441;
const PORT_POST_OWNER = 18442;
const PORT_POST_NONOWNER = 18443;
const PORT_POST_NONTEXT = 18444;

/** Build a minimal WhatsApp Cloud API webhook POST payload. */
function makeWebhookBody(
  from: string,
  text: string,
  type = "text",
): Record<string, unknown> {
  const msgObj: Record<string, unknown> = { type, from };
  if (type === "text") {
    msgObj.text = { body: text };
  }
  return {
    entry: [{
      changes: [{
        value: {
          messages: [msgObj],
        },
      }],
    }],
  };
}

// --- Webhook GET verification ---

Deno.test({
  name: "WhatsApp: webhook GET with correct verify token returns 200 and challenge",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const adapter = createWhatsAppChannel({
      accessToken: "fake-token",
      phoneNumberId: "123456",
      verifyToken: "my-secret",
      webhookPort: PORT_GET_VALID,
    });
    await adapter.connect();
    try {
      const res = await fetch(
        `http://localhost:${PORT_GET_VALID}/webhook` +
          `?hub.mode=subscribe&hub.verify_token=my-secret&hub.challenge=abc123`,
      );
      assertEquals(res.status, 200);
      assertEquals(await res.text(), "abc123");
    } finally {
      await adapter.disconnect();
    }
  },
});

Deno.test({
  name: "WhatsApp: webhook GET with wrong verify token returns 403",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const adapter = createWhatsAppChannel({
      accessToken: "fake-token",
      phoneNumberId: "123456",
      verifyToken: "my-secret",
      webhookPort: PORT_GET_INVALID,
    });
    await adapter.connect();
    try {
      const res = await fetch(
        `http://localhost:${PORT_GET_INVALID}/webhook` +
          `?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=abc123`,
      );
      assertEquals(res.status, 403);
      await res.body?.cancel();
    } finally {
      await adapter.disconnect();
    }
  },
});

// --- Webhook POST message parsing ---

Deno.test({
  name: "WhatsApp: webhook POST text message invokes handler with correct fields",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const adapter = createWhatsAppChannel({
      accessToken: "fake-token",
      phoneNumberId: "123456",
      verifyToken: "my-secret",
      webhookPort: PORT_POST_OWNER,
      ownerPhone: "15551234567",
    });

    let captured: {
      sessionId?: string;
      senderId?: string;
      content?: string;
      isOwner?: boolean;
    } | null = null;

    adapter.onMessage((msg) => {
      captured = {
        sessionId: msg.sessionId,
        senderId: msg.senderId,
        content: msg.content,
        isOwner: msg.isOwner,
      };
    });

    await adapter.connect();
    try {
      const res = await fetch(
        `http://localhost:${PORT_POST_OWNER}/webhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(makeWebhookBody("15551234567", "Hello agent")),
        },
      );
      assertEquals(res.status, 200);
      await res.body?.cancel();

      assertExists(captured);
      assertEquals(captured!.sessionId, "whatsapp-15551234567");
      assertEquals(captured!.senderId, "15551234567");
      assertEquals(captured!.content, "Hello agent");
      assertEquals(captured!.isOwner, true);
    } finally {
      await adapter.disconnect();
    }
  },
});

// --- Owner detection ---

Deno.test({
  name: "WhatsApp: non-owner sender gets isOwner false and PUBLIC sessionTaint",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const adapter = createWhatsAppChannel({
      accessToken: "fake-token",
      phoneNumberId: "123456",
      verifyToken: "my-secret",
      webhookPort: PORT_POST_NONOWNER,
      ownerPhone: "15551234567",
    });

    let captured: { isOwner?: boolean; sessionTaint?: string } | null = null;
    adapter.onMessage((msg) => {
      captured = { isOwner: msg.isOwner, sessionTaint: msg.sessionTaint };
    });

    await adapter.connect();
    try {
      const res = await fetch(
        `http://localhost:${PORT_POST_NONOWNER}/webhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(makeWebhookBody("19999999999", "Stranger message")),
        },
      );
      assertEquals(res.status, 200);
      await res.body?.cancel();

      assertExists(captured);
      assertEquals(captured!.isOwner, false);
      assertEquals(captured!.sessionTaint, "PUBLIC");
    } finally {
      await adapter.disconnect();
    }
  },
});

// --- Non-text message filtering ---

Deno.test({
  name: "WhatsApp: non-text message type (image) does not invoke handler",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const adapter = createWhatsAppChannel({
      accessToken: "fake-token",
      phoneNumberId: "123456",
      verifyToken: "my-secret",
      webhookPort: PORT_POST_NONTEXT,
    });

    let handlerCalled = false;
    adapter.onMessage(() => {
      handlerCalled = true;
    });

    await adapter.connect();
    try {
      const res = await fetch(
        `http://localhost:${PORT_POST_NONTEXT}/webhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(makeWebhookBody("15551234567", "", "image")),
        },
      );
      assertEquals(res.status, 200);
      await res.body?.cancel();

      assertEquals(handlerCalled, false);
    } finally {
      await adapter.disconnect();
    }
  },
});

// --- Send: message truncation ---

Deno.test({
  name: "WhatsApp: send truncates messages longer than 4096 characters",
  async fn() {
    const adapter = createWhatsAppChannel({
      accessToken: "fake-token",
      phoneNumberId: "123456",
      verifyToken: "verify",
    });

    let sentBody: Record<string, unknown> | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ messages: [{ id: "wamid.xxx" }] }),
        { status: 200 },
      );
    };

    try {
      await adapter.send({
        content: "x".repeat(5000),
        sessionId: "whatsapp-15551234567",
      });
      assertExists(sentBody);
      const textBody = (sentBody as { text: { body: string } }).text.body;
      assertEquals(textBody.length, 4096);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

// --- Send: error handling ---

Deno.test({
  name: "WhatsApp: send throws on non-OK API response",
  async fn() {
    const adapter = createWhatsAppChannel({
      accessToken: "fake-token",
      phoneNumberId: "123456",
      verifyToken: "verify",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("Unauthorized", { status: 401 });

    try {
      await assertRejects(
        () =>
          adapter.send({ content: "hello", sessionId: "whatsapp-15551234567" }),
        Error,
        "WhatsApp send failed",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

