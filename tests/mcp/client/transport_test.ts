/**
 * MCP transport tests — SSE URL validation (SSRF prevention) and
 * per-hop redirect re-validation on both the POST (send) path and
 * the SSE receive stream.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { SSETransport } from "../../../src/mcp/client/transport.ts";
import { validateMcpServerUrl } from "../../../src/mcp/manager.ts";

/** SSRF checker that allows every hostname. */
const allowAllChecker = (_hostname: string) =>
  Promise.resolve({ ok: true as const, value: "93.184.216.34" });

/** SSRF checker that allows only the given hostname. */
function checkerAllowingOnly(allowedHost: string) {
  return (hostname: string) =>
    Promise.resolve(
      hostname === allowedHost
        ? { ok: true as const, value: "93.184.216.34" }
        : {
          ok: false as const,
          error: `SSRF blocked: ${hostname} resolves to private IP`,
        },
    );
}

Deno.test("SSETransport: connect is blocked when the urlValidator rejects", async () => {
  const failingValidator = (_url: string) =>
    Promise.resolve({
      ok: false as const,
      error: "SSRF blocked: mcp.internal resolves to private IP 10.0.0.5",
    });
  const transport = new SSETransport(
    "http://mcp.internal/sse",
    failingValidator,
  );
  await assertRejects(
    () => transport.connect(),
    Error,
    "SSE connection blocked by SSRF policy",
  );
});

Deno.test("SSETransport: send is blocked when a redirect hop targets a private address", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(null, {
        status: 307,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }),
    )) as unknown as typeof fetch;
  try {
    const transport = new SSETransport(
      "https://mcp.example.com/sse",
      undefined,
      checkerAllowingOnly("mcp.example.com"),
    );
    await assertRejects(
      () => transport.send('{"jsonrpc":"2.0","method":"tools/list"}'),
      Error,
      "SSE send blocked",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("SSETransport: send POSTs the message with manual redirect handling", async () => {
  const originalFetch = globalThis.fetch;
  const captured: { url?: string; init?: RequestInit } = {};
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    captured.url = url.toString();
    captured.init = init;
    return Promise.resolve(new Response(null, { status: 202 }));
  }) as unknown as typeof fetch;
  try {
    const transport = new SSETransport(
      "https://mcp.example.com/sse",
      undefined,
      allowAllChecker,
    );
    await transport.send('{"jsonrpc":"2.0","id":1}');
    assertEquals(captured.url, "https://mcp.example.com/sse");
    assertEquals(captured.init?.method, "POST");
    assertEquals(captured.init?.body, '{"jsonrpc":"2.0","id":1}');
    assertEquals(captured.init?.redirect, "manual");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("SSETransport: connect is blocked when the SSE stream redirects to a private address", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: "http://10.0.0.5/sse" },
      }),
    )) as unknown as typeof fetch;
  try {
    const transport = new SSETransport(
      "https://mcp.example.com/sse",
      undefined,
      checkerAllowingOnly("mcp.example.com"),
    );
    await assertRejects(
      () => transport.connect(),
      Error,
      "SSE connection blocked",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("SSETransport: dispatches SSE message data to handlers and filters named events", async () => {
  const originalFetch = globalThis.fetch;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
    init?.signal?.addEventListener("abort", () => {
      try {
        controller.close();
      } catch {
        // Stream already closed by the server side of the test.
      }
    });
    return Promise.resolve(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
  }) as unknown as typeof fetch;
  try {
    const transport = new SSETransport(
      "https://mcp.example.com/sse",
      undefined,
      allowAllChecker,
    );
    const received: string[] = [];
    const twoMessages = new Promise<void>((resolve) => {
      transport.onMessage((msg) => {
        received.push(msg);
        if (received.length === 2) resolve();
      });
    });
    await transport.connect();
    const enc = new TextEncoder();
    controller.enqueue(enc.encode("event: endpoint\ndata: /ignored\n\n"));
    controller.enqueue(enc.encode(": keepalive comment\n"));
    controller.enqueue(enc.encode('data: {"jsonrpc"'));
    controller.enqueue(enc.encode(':"2.0","id":1}\n\ndata: second\n\n'));
    await twoMessages;
    assertEquals(received, ['{"jsonrpc":"2.0","id":1}', "second"]);
    await transport.disconnect();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("SSETransport: connect fails on a non-OK SSE response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response("not here", { status: 404 }),
    )) as unknown as typeof fetch;
  try {
    const transport = new SSETransport(
      "https://mcp.example.com/sse",
      undefined,
      allowAllChecker,
    );
    await assertRejects(
      () => transport.connect(),
      Error,
      "SSE connection failed: HTTP 404",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("validateMcpServerUrl: rejects an invalid URL", async () => {
  const result = await validateMcpServerUrl("not a url");
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.includes("Invalid URL"), true);
});

Deno.test("validateMcpServerUrl: rejects non-http protocols", async () => {
  const result = await validateMcpServerUrl("ftp://mcp.example.com/sse");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("Unsupported protocol"), true);
  }
});
