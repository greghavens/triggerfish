/**
 * Tests for SSH tool executor.
 *
 * Tests input validation and dispatch routing. Actual SSH connections
 * are not tested here (they require a remote host).
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createSshToolExecutor } from "../../../src/tools/ssh/mod.ts";

Deno.test("ssh executor returns null for unknown tool", async () => {
  const executor = createSshToolExecutor();
  const result = await executor("unknown_tool", {});
  assertEquals(result, null);
});

Deno.test("ssh_execute rejects missing host", async () => {
  const executor = createSshToolExecutor();
  const result = await executor("ssh_execute", { command: "ls" });
  assertStringIncludes(
    result!,
    "Error: ssh_execute requires a non-empty 'host'",
  );
});

Deno.test("ssh_execute rejects empty host", async () => {
  const executor = createSshToolExecutor();
  const result = await executor("ssh_execute", { host: "", command: "ls" });
  assertStringIncludes(
    result!,
    "Error: ssh_execute requires a non-empty 'host'",
  );
});

Deno.test("ssh_execute rejects missing command", async () => {
  const executor = createSshToolExecutor();
  const result = await executor("ssh_execute", { host: "example.com" });
  assertStringIncludes(
    result!,
    "Error: ssh_execute requires a non-empty 'command'",
  );
});

Deno.test("ssh_execute rejects empty command", async () => {
  const executor = createSshToolExecutor();
  const result = await executor("ssh_execute", {
    host: "example.com",
    command: "",
  });
  assertStringIncludes(
    result!,
    "Error: ssh_execute requires a non-empty 'command'",
  );
});

Deno.test("ssh_session_open rejects missing host", async () => {
  const executor = createSshToolExecutor();
  const result = await executor("ssh_session_open", {});
  assertStringIncludes(
    result!,
    "Error: ssh_session_open requires a non-empty 'host'",
  );
});

Deno.test("ssh_session_write rejects missing session_id", async () => {
  const executor = createSshToolExecutor();
  const result = await executor("ssh_session_write", { input: "hello" });
  assertStringIncludes(
    result!,
    "Error: ssh_session_write requires a non-empty 'session_id'",
  );
});

Deno.test("ssh_session_write rejects missing input", async () => {
  const executor = createSshToolExecutor();
  const result = await executor("ssh_session_write", { session_id: "abc" });
  assertStringIncludes(result!, "Error: ssh_session_write requires an 'input'");
});

Deno.test("ssh_session_read rejects missing session_id", async () => {
  const executor = createSshToolExecutor();
  const result = await executor("ssh_session_read", {});
  assertStringIncludes(
    result!,
    "Error: ssh_session_read requires a non-empty 'session_id'",
  );
});

Deno.test("ssh_session_close rejects missing session_id", async () => {
  const executor = createSshToolExecutor();
  const result = await executor("ssh_session_close", {});
  assertStringIncludes(
    result!,
    "Error: ssh_session_close requires a non-empty 'session_id'",
  );
});

Deno.test("ssh_session_write fails for nonexistent session", async () => {
  const executor = createSshToolExecutor();
  const result = await executor("ssh_session_write", {
    session_id: "nonexistent",
    input: "test",
  });
  assertStringIncludes(result!, "SSH session not found: nonexistent");
});

Deno.test("ssh_session_read fails for nonexistent session", async () => {
  const executor = createSshToolExecutor();
  const result = await executor("ssh_session_read", {
    session_id: "nonexistent",
  });
  assertStringIncludes(result!, "SSH session not found: nonexistent");
});

Deno.test("ssh_session_close fails for nonexistent session", async () => {
  const executor = createSshToolExecutor();
  const result = await executor("ssh_session_close", {
    session_id: "nonexistent",
  });
  assertStringIncludes(result!, "SSH session not found: nonexistent");
});
