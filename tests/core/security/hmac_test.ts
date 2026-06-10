/**
 * HMAC + constant-time comparison primitive tests (H7, M2).
 */
import { assert } from "@std/assert";
import {
  timingSafeEqual,
  verifyHmacSha256,
} from "../../../src/core/security/hmac.ts";

Deno.test("timingSafeEqual: equal strings match", () => {
  assert(timingSafeEqual("abc123def456", "abc123def456"));
});

Deno.test("timingSafeEqual: same-length mismatch fails", () => {
  assert(!timingSafeEqual("abc123def456", "abc123def457"));
});

Deno.test("timingSafeEqual: different-length mismatch fails", () => {
  assert(!timingSafeEqual("abc", "abcd"));
});

Deno.test("verifyHmacSha256: accepts correct signature, rejects tampering", async () => {
  const secret = "s3cr3t";
  const body = new TextEncoder().encode("payload");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  const hex = Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  assert(await verifyHmacSha256(secret, body, hex));
  assert(!(await verifyHmacSha256("wrong-secret", body, hex)));
  assert(!(await verifyHmacSha256(secret, body, "deadbeef")));
});
