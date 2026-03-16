/**
 * SSRF prevention — hardcoded IP denylist and DNS resolution checks.
 *
 * All outbound HTTP must resolve DNS first and check the resolved IP
 * against this denylist. Private/reserved ranges are always blocked.
 * This is not configurable.
 *
 * @module
 */

import type { Result } from "../types/classification.ts";
import { createLogger } from "../logger/logger.ts";

const log = createLogger("security");

// --- SSRF Denylist (hardcoded, non-overridable) ---

/** IPv4 CIDR ranges that are always blocked (private/reserved). */
const SSRF_DENY_CIDRS_V4: readonly {
  readonly addr: number;
  readonly mask: number;
}[] = [
  // 127.0.0.0/8 — loopback
  { addr: 0x7F000000, mask: 0xFF000000 },
  // 10.0.0.0/8 — private
  { addr: 0x0A000000, mask: 0xFF000000 },
  // 172.16.0.0/12 — private
  { addr: 0xAC100000, mask: 0xFFF00000 },
  // 192.168.0.0/16 — private
  { addr: 0xC0A80000, mask: 0xFFFF0000 },
  // 169.254.0.0/16 — link-local
  { addr: 0xA9FE0000, mask: 0xFFFF0000 },
  // 0.0.0.0/8 — "this" network
  { addr: 0x00000000, mask: 0xFF000000 },
];

/** Well-known private/reserved IPv6 addresses (checked as exact prefixes). */
const SSRF_DENY_V6_PREFIXES: readonly string[] = [
  "::1", // loopback
  "fc", // fc00::/7 — unique local (fc and fd)
  "fd",
  "fe80:", // fe80::/10 — link-local
];

/**
 * Parse an IPv4 address string to a 32-bit number.
 * Returns null if the string is not a valid IPv4 address.
 */
function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = parseInt(part, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

/** Check if an IPv4 numeric address matches any denied CIDR range. */
function isPrivateIpv4(ipv4: number): boolean {
  for (const cidr of SSRF_DENY_CIDRS_V4) {
    if ((ipv4 & cidr.mask) === (cidr.addr & cidr.mask)) {
      return true;
    }
  }
  return false;
}

/**
 * Convert a full-form IPv4-mapped IPv6 address to IPv4.
 *
 * Handles `0:0:0:0:0:ffff:HHHH:LLLL` notation where the last two groups
 * encode the IPv4 address in hex. Returns null if not in this format.
 */
function fullFormMappedToIpv4(normalized: string): string | null {
  const match = normalized.match(
    /^(?:0+:){5}ffff:([0-9a-f]+):([0-9a-f]+)$/,
  );
  if (!match) return null;
  const hi = parseInt(match[1], 16);
  const lo = parseInt(match[2], 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/** Check if a normalized IPv6 string matches any denied prefix. */
function isPrivateIpv6(normalized: string): boolean {
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  for (const prefix of SSRF_DENY_V6_PREFIXES) {
    if (normalized.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Check if an IP address falls within the hardcoded SSRF denylist.
 *
 * Checks both IPv4 private/reserved ranges and IPv6 loopback/private prefixes.
 * This function is pure and deterministic.
 */
export function isPrivateIp(ip: string): boolean {
  const ipv4 = parseIpv4(ip);
  if (ipv4 !== null) return isPrivateIpv4(ipv4);
  const normalized = ip.toLowerCase();
  if (isPrivateIpv6(normalized)) return true;
  const v4Mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isPrivateIp(v4Mapped[1]);
  const fullFormIpv4 = fullFormMappedToIpv4(normalized);
  if (fullFormIpv4 !== null) return isPrivateIp(fullFormIpv4);
  return false;
}

/** Resolve a hostname to ALL its A and AAAA record IP addresses. */
async function resolveDnsHostname(
  hostname: string,
): Promise<Result<readonly string[], string>> {
  const [v4Result, v6Result] = await Promise.allSettled([
    Deno.resolveDns(hostname, "A"),
    Deno.resolveDns(hostname, "AAAA"),
  ]);

  const v4Ips = v4Result.status === "fulfilled"
    ? (v4Result.value as unknown as string[])
    : [];
  const v6Ips = v6Result.status === "fulfilled"
    ? (v6Result.value as unknown as string[])
    : [];

  const addresses = [...v4Ips.map(String), ...v6Ips.map(String)];

  if (addresses.length === 0) {
    const firstErr = v4Result.status === "rejected"
      ? v4Result.reason
      : v6Result.status === "rejected"
      ? v6Result.reason
      : null;
    const detail = firstErr instanceof Error
      ? firstErr.message
      : String(firstErr);
    return {
      ok: false,
      error: `DNS resolution failed for ${hostname}: ${detail}`,
    };
  }

  return { ok: true, value: addresses };
}

/**
 * Check a list of resolved IP addresses against the SSRF denylist.
 *
 * Blocks if ANY address in the list is private. Returns the first address
 * on success (for logging). Exported for unit testing without DNS mocking.
 *
 * @param hostname - The original hostname (used in error messages)
 * @param ips - All DNS A and AAAA records returned for the hostname
 * @returns Ok with the first IP, or Err if any IP is private
 */
export function enforceIpListForSsrf(
  hostname: string,
  ips: readonly string[],
): Result<string, string> {
  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      log.warn("SSRF blocked: hostname resolves to private IP", {
        hostname,
        resolvedIp: ip,
      });
      return {
        ok: false,
        error: `SSRF blocked: ${hostname} resolves to private IP ${ip}`,
      };
    }
  }
  log.debug("SSRF check passed", { hostname, resolvedIp: ips[0] });
  return { ok: true, value: ips[0] };
}

/** @deprecated Use enforceIpListForSsrf instead */
export const checkIpListForSsrf = enforceIpListForSsrf;

/**
 * Resolve a hostname via DNS and check ALL resolved IPs against the SSRF denylist.
 *
 * Blocks if ANY of the returned A or AAAA records is a private/reserved IP address.
 * This prevents DNS rebinding attacks where a domain returns a mix of
 * public and private IPs.
 *
 * @returns Ok with the first resolved IP, or Err with a reason string.
 */
export async function resolveAndCheck(
  hostname: string,
): Promise<Result<string, string>> {
  const resolved = await resolveDnsHostname(hostname);
  if (!resolved.ok) return resolved;
  return enforceIpListForSsrf(hostname, resolved.value);
}
