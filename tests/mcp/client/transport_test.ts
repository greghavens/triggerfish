/**
 * MCP transport tests — SSE URL validation (SSRF prevention).
 */
import { assertEquals, assertRejects } from "@std/assert";
import { SSETransport } from "../../../src/mcp/client/transport.ts";
import { validateMcpServerUrl } from "../../../src/mcp/manager.ts";

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
