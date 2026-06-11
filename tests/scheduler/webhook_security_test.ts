/**
 * Tests for webhook HMAC-SHA256 verification (canonical primitives).
 *
 * The dead `signWebhook`/`verifyWebhookSignature` pair was removed
 * (SCHEDULER-3); the live path is `verifyWebhookHmac`/`verifyHmacAsync`
 * in webhooks.ts, layered over the shared core primitive
 * `verifyHmacSha256` in src/core/security/hmac.ts.
 */
import { assert, assertEquals } from "@std/assert";
import {
  computeHmac,
  computeTimestampedHmac,
  verifyHmacAsync,
  verifyWebhookHmac,
} from "../../src/scheduler/webhooks/webhooks.ts";
import { verifyHmacSha256 } from "../../src/core/security/hmac.ts";

// ── Round-trip via the canonical signer ─────────────────────────────

Deno.test("computeHmac + verifyHmacAsync: round-trip succeeds", async () => {
  const secret = "my-webhook-secret";
  const body = '{"event":"deploy","data":{"env":"production"}}';

  const signature = await computeHmac(body, secret);
  assertEquals(await verifyHmacAsync(body, signature, secret), true);
});

Deno.test("computeHmac: returns sha256= prefixed 64-char lowercase hex", async () => {
  const sig = await computeHmac("payload", "secret");
  assert(sig.startsWith("sha256="), "Signature must carry the sha256= prefix");
  const hex = sig.slice("sha256=".length);
  assertEquals(hex.length, 64, "SHA-256 hex digest should be 64 chars");
  assert(/^[0-9a-f]+$/.test(hex), "Should be lowercase hex only");
});

Deno.test("computeHmac digest verifies via core verifyHmacSha256", async () => {
  // The scheduler signer and the core primitive must agree.
  const secret = "shared-secret";
  const body = '{"event":"push"}';
  const hex = (await computeHmac(body, secret)).slice("sha256=".length);
  const valid = await verifyHmacSha256(
    secret,
    new TextEncoder().encode(body),
    hex,
  );
  assertEquals(valid, true);
});

// ── Rejection cases ─────────────────────────────────────────────────

Deno.test("verifyHmacAsync: rejects corrupted signature", async () => {
  const secret = "correct-secret";
  const body = '{"event":"push"}';
  const signature = await computeHmac(body, secret);
  const wrongSig = signature.slice(0, -4) + "ffff";
  assertEquals(await verifyHmacAsync(body, wrongSig, secret), false);
});

Deno.test("verifyHmacAsync: rejects tampered payload", async () => {
  const secret = "webhook-secret";
  const signature = await computeHmac('{"event":"push"}', secret);
  assertEquals(
    await verifyHmacAsync(
      '{"event":"push","tampered":true}',
      signature,
      secret,
    ),
    false,
  );
});

Deno.test("verifyHmacAsync: rejects wrong secret", async () => {
  const body = '{"event":"push"}';
  const signature = await computeHmac(body, "correct-secret");
  assertEquals(await verifyHmacAsync(body, signature, "wrong-secret"), false);
});

Deno.test("verifyHmacAsync: rejects non-sha256 algorithm prefix", async () => {
  // md5= and sha1= prefixes must be rejected — only sha256= is accepted
  assertEquals(
    await verifyHmacAsync(
      "body",
      "md5=abc123abc123abc123abc123abc123ab",
      "secret",
    ),
    false,
  );
  assertEquals(
    await verifyHmacAsync(
      "body",
      "sha1=abc123abc123abc123abc123abc123ab",
      "secret",
    ),
    false,
  );
});

// ── verifyWebhookHmac scheme verdicts ────────────────────────────────

Deno.test("verifyWebhookHmac: accepts timestamp-bound signature (preferred scheme)", async () => {
  const secret = "ts-secret";
  const body = '{"event":"deploy"}';
  const timestamp = "1750000000";
  const signature = await computeTimestampedHmac(timestamp, body, secret);

  const verdict = await verifyWebhookHmac({
    body,
    signature,
    secret,
    timestamp,
  });
  assertEquals(verdict.valid, true);
  assertEquals(verdict.scheme, "timestamped");
});

Deno.test("verifyWebhookHmac: timestamped signature replayed with a fresh timestamp is rejected", async () => {
  const secret = "ts-secret";
  const body = '{"event":"deploy"}';
  const signature = await computeTimestampedHmac("1750000000", body, secret);

  // Same body+signature, attacker-supplied newer timestamp: the
  // timestamped scheme fails and the body-only fallback cannot match a
  // timestamp-bound digest either.
  const verdict = await verifyWebhookHmac({
    body,
    signature,
    secret,
    timestamp: "1750009999",
  });
  assertEquals(verdict.valid, false);
  assertEquals(verdict.scheme, null);
});

Deno.test("verifyWebhookHmac: body-only signature accepted as fallback scheme", async () => {
  const secret = "gh-secret";
  const body = '{"event":"push"}';
  const signature = await computeHmac(body, secret);

  const verdict = await verifyWebhookHmac({
    body,
    signature,
    secret,
    timestamp: "1750000000",
  });
  assertEquals(verdict.valid, true);
  assertEquals(verdict.scheme, "body");
});

Deno.test("verifyWebhookHmac: invalid signature yields null scheme", async () => {
  const verdict = await verifyWebhookHmac({
    body: "payload",
    signature:
      "sha256=0000000000000000000000000000000000000000000000000000000000000000",
    secret: "secret",
  });
  assertEquals(verdict.valid, false);
  assertEquals(verdict.scheme, null);
});
