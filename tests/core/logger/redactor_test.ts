/**
 * Tests for the logger secret-redaction backstop (CORE-STATE-3).
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  redactCredentialText,
  redactSecretValue,
} from "../../../src/core/logger/redactor.ts";
import {
  createLogger,
  initLogger,
  shutdownLogger,
} from "../../../src/core/logger/logger.ts";
import type { FileWriter } from "../../../src/core/logger/writer.ts";

/** In-memory FileWriter for testing. */
function createTestWriter(): FileWriter & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write(line: string): Promise<void> {
      lines.push(line);
      return Promise.resolve();
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

// --- redactSecretValue: secret-shaped keys ---

Deno.test("redactSecretValue: masks string values under secret-shaped keys", () => {
  const redacted = redactSecretValue({
    apiKey: "sk-abc",
    Authorization: "Bearer xyz",
    password: "hunter2",
    client_token: "t",
    secret_id: "s",
    cookie: "session=1",
    operation: "connect",
  }) as Record<string, unknown>;

  assertEquals(redacted.apiKey, "[REDACTED]");
  assertEquals(redacted.Authorization, "[REDACTED]");
  assertEquals(redacted.password, "[REDACTED]");
  assertEquals(redacted.client_token, "[REDACTED]");
  assertEquals(redacted.secret_id, "[REDACTED]");
  assertEquals(redacted.cookie, "[REDACTED]");
  assertEquals(redacted.operation, "connect");
});

Deno.test("redactSecretValue: masks nested objects and arrays under secret keys", () => {
  const redacted = redactSecretValue({
    credentials: { user: "u", pass: "p" },
    apiKeys: ["k1", "k2"],
  }) as Record<string, unknown>;

  assertEquals(redacted.credentials, "[REDACTED]");
  assertEquals(redacted.apiKeys, "[REDACTED]");
});

Deno.test("redactSecretValue: deep-walks nested structures", () => {
  const redacted = redactSecretValue({
    config: { providers: [{ name: "openai", apiKey: "sk-deep" }] },
  }) as { config: { providers: Array<Record<string, unknown>> } };

  assertEquals(redacted.config.providers[0].name, "openai");
  assertEquals(redacted.config.providers[0].apiKey, "[REDACTED]");
});

Deno.test("redactSecretValue: keeps numeric/boolean values under token-like keys", () => {
  const redacted = redactSecretValue({
    tokenCount: 42,
    maxTokens: 1024,
    tokenized: true,
  }) as Record<string, unknown>;

  assertEquals(redacted.tokenCount, 42);
  assertEquals(redacted.maxTokens, 1024);
  assertEquals(redacted.tokenized, true);
});

Deno.test("redactSecretValue: leaves ordinary values untouched", () => {
  const input = {
    operation: "deliver",
    sessionId: "s-1",
    count: 3,
    when: new Date("2026-01-01T00:00:00Z"),
  };
  const redacted = redactSecretValue(input) as Record<string, unknown>;
  assertEquals(redacted.operation, "deliver");
  assertEquals(redacted.sessionId, "s-1");
  assertEquals(redacted.count, 3);
  assertEquals((redacted.when as Date).toISOString(), input.when.toISOString());
});

// --- redactSecretValue: credential-shaped strings ---

Deno.test("redactSecretValue: masks bearer-like strings under any key", () => {
  const redacted = redactSecretValue({
    header: "Authorization: Bearer abcdef123456789",
    note: "uses sk-aaaaaaaaaaaaaaaaaaaa for auth",
  }) as Record<string, unknown>;

  assert(!(redacted.header as string).includes("abcdef123456789"));
  assert(!(redacted.note as string).includes("sk-aaaaaaaaaaaaaaaaaaaa"));
  assertStringIncludes(redacted.note as string, "[REDACTED]");
});

Deno.test("redactCredentialText: does not mangle ordinary text", () => {
  const ordinary = "Session not found: webhook-github (basic retry in 5s)";
  assertEquals(redactCredentialText(ordinary), ordinary);
});

// --- redactSecretValue: robustness ---

Deno.test("redactSecretValue: survives circular structures", () => {
  const obj: Record<string, unknown> = { name: "loop" };
  obj.self = obj;
  const redacted = redactSecretValue(obj) as Record<string, unknown>;
  assertEquals(redacted.name, "loop");
  assertEquals(redacted.self, "[circular]");
});

Deno.test("redactSecretValue: caps walk depth", () => {
  let deep: Record<string, unknown> = { apiKey: "sk-bottom" };
  for (let i = 0; i < 20; i++) deep = { nested: deep };
  const json = JSON.stringify(redactSecretValue(deep));
  assert(!json.includes("sk-bottom"), "deep secret must not leak");
  assertStringIncludes(json, "[max-depth]");
});

// --- end-to-end through the logger ---

Deno.test("Logger: structured args with apiKey/Authorization log masked", () => {
  const writer = createTestWriter();
  initLogger({ level: "INFO", fileWriter: writer, console: false });

  const log = createLogger("test");
  log.info("provider configured", {
    operation: "loadProviders",
    apiKey: "sk-live-aaaaaaaaaaaaaaaa",
    Authorization: "Bearer abcdef123456789",
  });

  assertEquals(writer.lines.length, 1);
  const line = writer.lines[0];
  assert(!line.includes("sk-live-aaaaaaaaaaaaaaaa"), "apiKey must be masked");
  assert(!line.includes("abcdef123456789"), "bearer value must be masked");
  assertStringIncludes(line, "[REDACTED]");
  assertStringIncludes(line, "loadProviders");

  shutdownLogger();
});

Deno.test("Logger: bare string args with credentials log masked", () => {
  const writer = createTestWriter();
  initLogger({ level: "INFO", fileWriter: writer, console: false });

  const log = createLogger("test");
  log.info("auth header was", "Bearer abcdef123456789");

  assertEquals(writer.lines.length, 1);
  assert(!writer.lines[0].includes("abcdef123456789"));

  shutdownLogger();
});
