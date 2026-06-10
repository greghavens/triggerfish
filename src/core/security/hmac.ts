/**
 * HMAC-SHA256 signature verification for inbound webhooks.
 *
 * Shared security primitive: verifies that a raw request body was signed with
 * a known shared secret, using a constant-time digest comparison so a timing
 * side-channel cannot be used to forge a signature byte-by-byte.
 *
 * @module
 */

/** Constant-time comparison of two equal-length byte arrays. */
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Decode a hex string to bytes, or null if it is malformed. */
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

/**
 * Verify an HMAC-SHA256 signature over a raw request body.
 *
 * @param secret - The shared secret the sender used to sign the body
 * @param body - The exact raw bytes that were signed
 * @param providedHex - The lowercase hex digest from the signature header,
 *   without any algorithm prefix (e.g. strip `sha256=` before calling)
 * @returns true only if the recomputed digest matches in constant time
 */
export async function verifyHmacSha256(
  secret: string,
  body: BufferSource,
  providedHex: string,
): Promise<boolean> {
  const provided = hexToBytes(providedHex.trim().toLowerCase());
  if (!provided) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return timingSafeEqualBytes(expected, provided);
}
