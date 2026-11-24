/**
 * Phase 14: Gateway WebSocket authentication and Origin validation tests.
 *
 * Verifies that token auth and Origin allowlist enforcement is correctly applied
 * before WebSocket upgrades and on the /debug/run-triggers endpoint.
 *
 * Auth is opt-in: when no token or allowedOrigins is configured, all existing
 * behavior is preserved (backward compatibility).
 *
 * @module
 */
import { assertEquals } from "@std/assert";
import { createGatewayServer } from "../../src/gateway/server/mod.ts";

// --- Token authentication ---

Deno.test("GatewayServer auth: WebSocket rejected 401 — token configured, no credentials", async () => {
  const server = createGatewayServer({ port: 0, token: "secret" });
  try {
    const addr = await server.start();
    const response = await fetch(`http://127.0.0.1:${addr.port}/`, {
      headers: { upgrade: "websocket", connection: "upgrade" },
    });
    assertEquals(response.status, 401);
    await response.body?.cancel();
  } finally {
    await server.stop();
  }
});

Deno.test("GatewayServer auth: WebSocket rejected 401 — token configured, wrong token", async () => {
  const server = createGatewayServer({ port: 0, token: "secret" });
  try {
    const addr = await server.start();
    const response = await fetch(`http://127.0.0.1:${addr.port}/`, {
      headers: {
        upgrade: "websocket",
        connection: "upgrade",
        authorization: "Bearer wrongtoken",
      },
    });
    assertEquals(response.status, 401);
    await response.body?.cancel();
  } finally {
    await server.stop();
  }
});

Deno.test("GatewayServer auth: WebSocket accepted — correct token in ?token= query param", async () => {
  const server = createGatewayServer({ port: 0, token: "secret" });
  try {
    const addr = await server.start();
    // Fetch with upgrade headers will get a 101 or parse error, not a 401/403
    const response = await fetch(
      `http://127.0.0.1:${addr.port}/?token=secret`,
      { headers: { upgrade: "websocket", connection: "upgrade" } },
    );
    // Auth passed — Deno.serve rejects the non-WebSocket fetch with a different status
    // The key assertion is that it's NOT 401 or 403
    const status = response.status;
    assertEquals(status !== 401 && status !== 403, true);
    await response.body?.cancel();
  } finally {
    await server.stop();
  }
});

Deno.test("GatewayServer auth: WebSocket accepted — correct token in Authorization header", async () => {
  const server = createGatewayServer({ port: 0, token: "secret" });
  try {
    const addr = await server.start();
    const response = await fetch(`http://127.0.0.1:${addr.port}/`, {
      headers: {
        upgrade: "websocket",
        connection: "upgrade",
        authorization: "Bearer secret",
      },
    });
    const status = response.status;
    assertEquals(status !== 401 && status !== 403, true);
    await response.body?.cancel();
  } finally {
    await server.stop();
  }
});

// --- Origin validation ---

Deno.test("GatewayServer auth: WebSocket rejected 403 — allowedOrigins configured, Origin mismatch", async () => {
  const server = createGatewayServer({
    port: 0,
    allowedOrigins: ["https://example.com"],
  });
  try {
    const addr = await server.start();
    const response = await fetch(`http://127.0.0.1:${addr.port}/`, {
      headers: {
        upgrade: "websocket",
        connection: "upgrade",
        origin: "https://evil.com",
      },
    });
    assertEquals(response.status, 403);
    await response.body?.cancel();
  } finally {
    await server.stop();
  }
});

Deno.test("GatewayServer auth: WebSocket accepted — Origin matches allowedOrigins", async () => {
  const server = createGatewayServer({
    port: 0,
    allowedOrigins: ["https://example.com"],
  });
  try {
    const addr = await server.start();
    const response = await fetch(`http://127.0.0.1:${addr.port}/`, {
      headers: {
        upgrade: "websocket",
        connection: "upgrade",
        origin: "https://example.com",
      },
    });
    const status = response.status;
    assertEquals(status !== 401 && status !== 403, true);
    await response.body?.cancel();
  } finally {
    await server.stop();
  }
});

Deno.test("GatewayServer auth: WebSocket accepted — no auth options configured (backward compat)", async () => {
  const server = createGatewayServer({ port: 0 });
  try {
    const addr = await server.start();
    const response = await fetch(`http://127.0.0.1:${addr.port}/`, {
      headers: { upgrade: "websocket", connection: "upgrade" },
    });
    const status = response.status;
    assertEquals(status !== 401 && status !== 403, true);
    await response.body?.cancel();
  } finally {
    await server.stop();
  }
});

// --- /debug/run-triggers authentication ---

Deno.test("GatewayServer auth: /debug/run-triggers rejected 401 — token configured, no credentials", async () => {
  const server = createGatewayServer({ port: 0, token: "secret" });
  try {
    const addr = await server.start();
    const response = await fetch(
      `http://127.0.0.1:${addr.port}/debug/run-triggers`,
      { method: "POST" },
    );
    assertEquals(response.status, 401);
    await response.body?.cancel();
  } finally {
    await server.stop();
  }
});

Deno.test("GatewayServer auth: /debug/run-triggers accepted — correct token in header", async () => {
  const server = createGatewayServer({ port: 0, token: "secret" });
  try {
    const addr = await server.start();
    const response = await fetch(
      `http://127.0.0.1:${addr.port}/debug/run-triggers`,
      {
        method: "POST",
        headers: { authorization: "Bearer secret" },
      },
    );
    // No scheduler configured → 503 (after auth passes)
    assertEquals(response.status, 503);
    await response.body?.cancel();
  } finally {
    await server.stop();
  }
});

Deno.test("GatewayServer auth: /debug/run-triggers fails closed 503 — no token configured", async () => {
  const server = createGatewayServer({ port: 0 });
  try {
    const addr = await server.start();
    const response = await fetch(
      `http://127.0.0.1:${addr.port}/debug/run-triggers`,
      { method: "POST" },
    );
    assertEquals(response.status, 503);
    const body = await response.json();
    assertEquals(
      (body.error as string).includes("Debug endpoint disabled"),
      true,
    );
  } finally {
    await server.stop();
  }
});

// --- Fingerprinting suppression ---

Deno.test("GatewayServer auth: default HTTP response is 404 with no body", async () => {
  const server = createGatewayServer({ port: 0 });
  try {
    const addr = await server.start();
    const response = await fetch(`http://127.0.0.1:${addr.port}/`);
    assertEquals(response.status, 404);
    const text = await response.text();
    assertEquals(text, "");
  } finally {
    await server.stop();
  }
});
