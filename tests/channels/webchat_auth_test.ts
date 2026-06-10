/**
 * Phase 15: WebChat adapter Origin validation and fingerprinting suppression tests.
 *
 * Verifies that the WebChat adapter enforces the allowedOrigins config on
 * WebSocket upgrade requests, and that non-WebSocket requests return 404
 * with no identifying information.
 *
 * @module
 */
import { assertEquals } from "@std/assert";
import { createWebChatChannel } from "../../src/channels/mod.ts";

Deno.test("WebChatChannel: WebSocket rejected 403 — Origin not in allowedOrigins", async () => {
  const port = 28765;
  const channelWithPort = createWebChatChannel({
    port,
    allowedOrigins: ["https://example.com"],
  });
  try {
    await channelWithPort.connect();
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      headers: {
        upgrade: "websocket",
        connection: "upgrade",
        origin: "https://evil.com",
      },
    });
    assertEquals(response.status, 403);
    await response.body?.cancel();
  } finally {
    await channelWithPort.disconnect();
  }
});

Deno.test("WebChatChannel: WebSocket accepted — Origin matches allowedOrigins", async () => {
  const port = 28766;
  const channel = createWebChatChannel({
    port,
    allowedOrigins: ["https://example.com"],
  });
  try {
    await channel.connect();
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      headers: {
        upgrade: "websocket",
        connection: "upgrade",
        origin: "https://example.com",
      },
    });
    // Auth passed — should get 101 or similar, not 401/403
    const status = response.status;
    assertEquals(status !== 403, true);
    await response.body?.cancel();
  } finally {
    await channel.disconnect();
  }
});

Deno.test("WebChatChannel: WebSocket rejected 403 — allowedOrigins not configured (default deny)", async () => {
  const port = 28767;
  const channel = createWebChatChannel({ port });
  try {
    await channel.connect();
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      headers: {
        upgrade: "websocket",
        connection: "upgrade",
        origin: "https://any-origin.com",
      },
    });
    assertEquals(response.status, 403);
    await response.body?.cancel();
  } finally {
    await channel.disconnect();
  }
});

Deno.test("WebChatChannel: WebSocket accepted — explicit wildcard allowedOrigins", async () => {
  const port = 28769;
  const channel = createWebChatChannel({ port, allowedOrigins: ["*"] });
  try {
    await channel.connect();
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      headers: {
        upgrade: "websocket",
        connection: "upgrade",
        origin: "https://any-origin.com",
      },
    });
    assertEquals(response.status !== 403, true);
    await response.body?.cancel();
  } finally {
    await channel.disconnect();
  }
});

Deno.test("WebChatChannel: non-WebSocket request returns 404", async () => {
  const port = 28768;
  const channel = createWebChatChannel({ port });
  try {
    await channel.connect();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assertEquals(response.status, 404);
    const text = await response.text();
    assertEquals(text, "");
  } finally {
    await channel.disconnect();
  }
});
