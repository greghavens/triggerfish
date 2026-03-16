/**
 * Tests for SSH session manager internals.
 * @module
 */

import { assertEquals } from "@std/assert";
import {
  buildAskpassEnv,
  buildExecuteArgs,
  cleanupTempFile,
  materializeAskpassScript,
  materializeKeyToTempFile,
  resolveCredentials,
} from "../../../src/tools/ssh/ssh_session.ts";

// ─── buildExecuteArgs ────────────────────────────────────────────────────────

Deno.test("buildExecuteArgs produces correct base args without credentials", () => {
  const args = buildExecuteArgs("user@host", "uptime", {}, {});
  assertEquals(args.includes("BatchMode=yes"), true);
  assertEquals(args.includes("StrictHostKeyChecking=accept-new"), true);
  assertEquals(args[args.length - 1], "uptime");
  assertEquals(args[args.length - 2], "--");
  assertEquals(args[args.length - 3], "user@host");
});

Deno.test("buildExecuteArgs includes port when specified", () => {
  const args = buildExecuteArgs("host", "ls", { port: 2222 }, {});
  const portIdx = args.indexOf("-p");
  assertEquals(portIdx >= 0, true);
  assertEquals(args[portIdx + 1], "2222");
});

Deno.test("buildExecuteArgs includes -i when tempKeyPath provided", () => {
  const args = buildExecuteArgs("host", "ls", {}, {
    tempKeyPath: "/tmp/triggerfish-ssh-key-abc",
  });
  const iIdx = args.indexOf("-i");
  assertEquals(iIdx >= 0, true);
  assertEquals(args[iIdx + 1], "/tmp/triggerfish-ssh-key-abc");
});

Deno.test("buildExecuteArgs uses BatchMode=no when askpass provided", () => {
  const args = buildExecuteArgs("host", "ls", {}, {
    tempAskpassPath: "/tmp/triggerfish-ssh-askpass-abc",
  });
  assertEquals(args.includes("BatchMode=no"), true);
  assertEquals(args.includes("BatchMode=yes"), false);
});

Deno.test("buildExecuteArgs omits port and -i when not specified", () => {
  const args = buildExecuteArgs("host", "ls", {}, {});
  assertEquals(args.includes("-p"), false);
  assertEquals(args.includes("-i"), false);
});

// ─── buildAskpassEnv ─────────────────────────────────────────────────────────

Deno.test("buildAskpassEnv returns empty when no askpass", () => {
  const env = buildAskpassEnv({});
  assertEquals(Object.keys(env).length, 0);
});

Deno.test("buildAskpassEnv sets SSH_ASKPASS vars when askpass provided", () => {
  const env = buildAskpassEnv({
    tempAskpassPath: "/tmp/triggerfish-ssh-askpass-abc",
  });
  assertEquals(env.SSH_ASKPASS, "/tmp/triggerfish-ssh-askpass-abc");
  assertEquals(env.SSH_ASKPASS_REQUIRE, "force");
  assertEquals(env.DISPLAY, ":0");
});

// ─── resolveCredentials ──────────────────────────────────────────────────────

Deno.test("resolveCredentials returns empty when no credentials", async () => {
  const resolved = await resolveCredentials({});
  assertEquals(resolved.tempKeyPath, undefined);
  assertEquals(resolved.tempAskpassPath, undefined);
});

Deno.test("resolveCredentials materializes key to temp file", async () => {
  const resolved = await resolveCredentials({ key: "fake-key-data" });
  try {
    assertEquals(typeof resolved.tempKeyPath, "string");
    assertEquals(resolved.tempAskpassPath, undefined);
    const content = await Deno.readTextFile(resolved.tempKeyPath!);
    assertEquals(content, "fake-key-data\n");
  } finally {
    if (resolved.tempKeyPath) await cleanupTempFile(resolved.tempKeyPath);
  }
});

Deno.test("resolveCredentials materializes password as askpass script", async () => {
  const resolved = await resolveCredentials({ password: "mypassword" });
  try {
    assertEquals(resolved.tempKeyPath, undefined);
    assertEquals(typeof resolved.tempAskpassPath, "string");
    const content = await Deno.readTextFile(resolved.tempAskpassPath!);
    assertEquals(content.includes("mypassword"), true);
    assertEquals(content.startsWith("#!/bin/sh"), true);
  } finally {
    if (resolved.tempAskpassPath) {
      await cleanupTempFile(resolved.tempAskpassPath);
    }
  }
});

Deno.test("resolveCredentials materializes key + passphrase", async () => {
  const resolved = await resolveCredentials({
    key: "encrypted-key",
    passphrase: "my-passphrase",
  });
  try {
    assertEquals(typeof resolved.tempKeyPath, "string");
    assertEquals(typeof resolved.tempAskpassPath, "string");
    const askpass = await Deno.readTextFile(resolved.tempAskpassPath!);
    assertEquals(askpass.includes("my-passphrase"), true);
  } finally {
    if (resolved.tempKeyPath) await cleanupTempFile(resolved.tempKeyPath);
    if (resolved.tempAskpassPath) {
      await cleanupTempFile(resolved.tempAskpassPath);
    }
  }
});

Deno.test("resolveCredentials prefers passphrase over password for askpass", async () => {
  const resolved = await resolveCredentials({
    key: "my-key",
    password: "my-password",
    passphrase: "my-passphrase",
  });
  try {
    const askpass = await Deno.readTextFile(resolved.tempAskpassPath!);
    assertEquals(askpass.includes("my-passphrase"), true);
    assertEquals(askpass.includes("my-password"), false);
  } finally {
    if (resolved.tempKeyPath) await cleanupTempFile(resolved.tempKeyPath);
    if (resolved.tempAskpassPath) {
      await cleanupTempFile(resolved.tempAskpassPath);
    }
  }
});

// ─── materializeKeyToTempFile ────────────────────────────────────────────────

Deno.test("materializeKeyToTempFile writes key with 0600 permissions", async () => {
  const fakeKey =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nfakedata\n-----END OPENSSH PRIVATE KEY-----";
  const path = await materializeKeyToTempFile(fakeKey);

  try {
    const stat = await Deno.stat(path);
    assertEquals(stat.isFile, true);
    if (stat.mode !== null && stat.mode !== undefined) {
      assertEquals(stat.mode & 0o777, 0o600);
    }
    const content = await Deno.readTextFile(path);
    assertEquals(content, fakeKey + "\n");
  } finally {
    await cleanupTempFile(path);
  }
});

Deno.test("materializeKeyToTempFile appends newline only if missing", async () => {
  const keyWithNewline =
    "-----BEGIN OPENSSH PRIVATE KEY-----\ndata\n-----END OPENSSH PRIVATE KEY-----\n";
  const path = await materializeKeyToTempFile(keyWithNewline);

  try {
    const content = await Deno.readTextFile(path);
    assertEquals(content, keyWithNewline);
    assertEquals(content.endsWith("\n\n"), false);
  } finally {
    await cleanupTempFile(path);
  }
});

// ─── materializeAskpassScript ────────────────────────────────────────────────

Deno.test("materializeAskpassScript writes executable script with 0700 permissions", async () => {
  const path = await materializeAskpassScript("test-password");

  try {
    const stat = await Deno.stat(path);
    assertEquals(stat.isFile, true);
    if (stat.mode !== null && stat.mode !== undefined) {
      assertEquals(stat.mode & 0o777, 0o700);
    }
    const content = await Deno.readTextFile(path);
    assertEquals(content.startsWith("#!/bin/sh"), true);
    assertEquals(content.includes("test-password"), true);
  } finally {
    await cleanupTempFile(path);
  }
});

Deno.test("materializeAskpassScript escapes single quotes in password", async () => {
  const path = await materializeAskpassScript("it's a p'ass");

  try {
    // Verify the script actually outputs the correct password when run.
    const proc = new Deno.Command("sh", {
      args: [path],
      stdout: "piped",
    });
    const output = await proc.output();
    const result = new TextDecoder().decode(output.stdout).trimEnd();
    assertEquals(result, "it's a p'ass");
  } finally {
    await cleanupTempFile(path);
  }
});

// ─── cleanupTempFile ─────────────────────────────────────────────────────────

Deno.test("cleanupTempFile removes the file", async () => {
  const path = await materializeKeyToTempFile("test-key-data");
  await cleanupTempFile(path);

  let exists = true;
  try {
    await Deno.stat(path);
  } catch {
    exists = false;
  }
  assertEquals(exists, false);
});

Deno.test("cleanupTempFile does not throw for nonexistent file", async () => {
  await cleanupTempFile("/tmp/nonexistent-key-file-abc123");
});
