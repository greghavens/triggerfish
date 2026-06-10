/**
 * Gateway auth token helper tests (H1).
 *
 * Verifies the daemon-written token round-trips to local CLI clients,
 * regenerates per start, and is not readable by group/other.
 */
import { assert, assertEquals } from "@std/assert";
import {
  ensureGatewayToken,
  readGatewayToken,
  resolveGatewayTokenPath,
} from "../../src/cli/config/paths.ts";

Deno.test("gateway token: ensure writes a 256-bit hex token, read returns it", async () => {
  const base = await Deno.makeTempDir();
  try {
    assertEquals(readGatewayToken(base), null);
    const token = await ensureGatewayToken(base);
    assertEquals(token.length, 64);
    assert(/^[0-9a-f]{64}$/.test(token));
    assertEquals(readGatewayToken(base), token);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("gateway token: each daemon start regenerates the token", async () => {
  const base = await Deno.makeTempDir();
  try {
    const first = await ensureGatewayToken(base);
    const second = await ensureGatewayToken(base);
    assert(first !== second);
    assertEquals(readGatewayToken(base), second);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("gateway token: token file is not group/other accessible", async () => {
  if (Deno.build.os === "windows") return;
  const base = await Deno.makeTempDir();
  try {
    await ensureGatewayToken(base);
    const stat = await Deno.stat(resolveGatewayTokenPath(base));
    assertEquals((stat.mode ?? 0) & 0o077, 0);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
