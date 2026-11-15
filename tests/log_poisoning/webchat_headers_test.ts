/**
 * Tests for WebChat WebSocket upgrade header validation.
 *
 * @module
 */
import { assertEquals } from "@std/assert";
import {
  MAX_SINGLE_HEADER_BYTES,
  MAX_TOTAL_HEADER_BYTES,
  validateWebChatUpgrade,
} from "../../src/channels/webchat/adapter.ts";
import type { WebChatConfig } from "../../src/channels/webchat/adapter.ts";

/** Build a test Request with custom headers for WS upgrade. */
function buildUpgradeRequest(headers: Record<string, string>): Request {
  const init: RequestInit = {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      ...headers,
    },
  };
  return new Request("http://localhost:8765/", init);
}

const emptyConfig: WebChatConfig = {};

Deno.test("WebChat: rejects oversized single header (HTTP 431)", () => {
  const req = buildUpgradeRequest({
    "x-custom": "a".repeat(MAX_SINGLE_HEADER_BYTES + 1),
  });
  const result = validateWebChatUpgrade(req, emptyConfig);
  assertEquals(result?.status, 431);
});

Deno.test("WebChat: rejects oversized total headers (HTTP 431)", () => {
  // Create many small headers that collectively exceed MAX_TOTAL_HEADER_BYTES.
  const headers: Record<string, string> = {};
  // Each header: "x-hdr-NN" (9 bytes) + value (100 bytes) = ~109 bytes.
  // Need more than MAX_TOTAL_HEADER_BYTES / 109 headers.
  const count = Math.ceil(MAX_TOTAL_HEADER_BYTES / 100) + 5;
  for (let i = 0; i < count; i++) {
    headers[`x-hdr-${String(i).padStart(3, "0")}`] = "v".repeat(90);
  }
  const req = buildUpgradeRequest(headers);
  const result = validateWebChatUpgrade(req, emptyConfig);
  assertEquals(result?.status, 431);
});

Deno.test("WebChat: allows request within header limits", () => {
  const req = buildUpgradeRequest({ "x-custom": "normal-value" });
  const result = validateWebChatUpgrade(req, { allowedOrigins: ["*"] });
  assertEquals(result, null);
});

Deno.test("WebChat: rejects disallowed origin (HTTP 403)", () => {
  const config: WebChatConfig = { allowedOrigins: ["https://app.example.com"] };
  const req = buildUpgradeRequest({ origin: "https://evil.com" });
  const result = validateWebChatUpgrade(req, config);
  assertEquals(result?.status, 403);
});

Deno.test("WebChat: allows configured origin", () => {
  const config: WebChatConfig = { allowedOrigins: ["https://app.example.com"] };
  const req = buildUpgradeRequest({ origin: "https://app.example.com" });
  const result = validateWebChatUpgrade(req, config);
  assertEquals(result, null);
});

Deno.test("WebChat: allows all origins when wildcard configured", () => {
  const config: WebChatConfig = { allowedOrigins: ["*"] };
  const req = buildUpgradeRequest({ origin: "https://anything.example.com" });
  const result = validateWebChatUpgrade(req, config);
  assertEquals(result, null);
});

Deno.test("WebChat: no allowedOrigins defaults to deny", () => {
  const req = buildUpgradeRequest({ origin: "https://whatever.example.com" });
  const result = validateWebChatUpgrade(req, emptyConfig);
  assertEquals(result?.status, 403);
});
