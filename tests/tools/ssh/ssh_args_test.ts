/**
 * Tests for SSH argument builders and host validation.
 *
 * TOOLS-OTHER-1: a host beginning with `-` is parsed by OpenSSH as a
 * command-line option (e.g. `-oProxyCommand=...` executes a local
 * command), so such hosts must be rejected before any args are built.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildBaseArgs,
  buildExecuteArgs,
  buildSessionArgs,
  validateSshHost,
} from "../../../src/tools/ssh/ssh_args.ts";

// ─── validateSshHost ─────────────────────────────────────────────────────────

Deno.test("validateSshHost: accepts a plain hostname", () => {
  const result = validateSshHost("example.com");
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, "example.com");
});

Deno.test("validateSshHost: accepts user@host and trims whitespace", () => {
  const result = validateSshHost("  deploy@server01.internal  ");
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, "deploy@server01.internal");
});

Deno.test("validateSshHost: accepts an IPv6 literal", () => {
  const result = validateSshHost("2001:db8::42");
  assertEquals(result.ok, true);
});

Deno.test("validateSshHost: rejects a host beginning with '-' (option injection)", () => {
  const result = validateSshHost("-oProxyCommand=touch /tmp/pwned");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assert(result.error.includes("must not begin with '-'"));
  }
});

Deno.test("validateSshHost: rejects '-' hosts after trimming leading spaces", () => {
  const result = validateSshHost("  -oLocalCommand=id");
  assertEquals(result.ok, false);
});

Deno.test("validateSshHost: rejects a '-'-leading hostname after user@", () => {
  const result = validateSshHost("user@-evil");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assert(result.error.includes("must not begin with '-'"));
  }
});

Deno.test("validateSshHost: rejects hosts with embedded whitespace or control characters", () => {
  assertEquals(validateSshHost("host name").ok, false);
  assertEquals(validateSshHost("host\tname").ok, false);
  assertEquals(validateSshHost("host\nname").ok, false);
  assertEquals(validateSshHost("host\x00name").ok, false);
});

Deno.test("validateSshHost: rejects an empty or whitespace-only host", () => {
  assertEquals(validateSshHost("").ok, false);
  assertEquals(validateSshHost("   ").ok, false);
});

// ─── PermitLocalCommand hardening ────────────────────────────────────────────

Deno.test("buildBaseArgs: always disables PermitLocalCommand", () => {
  const args = buildBaseArgs({}, {});
  const idx = args.indexOf("PermitLocalCommand=no");
  assert(idx > 0);
  assertEquals(args[idx - 1], "-o");
});

Deno.test("buildExecuteArgs: includes PermitLocalCommand=no", () => {
  const args = buildExecuteArgs("example.com", "uptime", {}, {});
  assert(args.includes("PermitLocalCommand=no"));
});

Deno.test("buildSessionArgs: includes PermitLocalCommand=no", () => {
  const args = buildSessionArgs({ host: "example.com" }, {});
  assert(args.includes("PermitLocalCommand=no"));
});
