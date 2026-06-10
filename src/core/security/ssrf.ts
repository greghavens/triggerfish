/**
 * SSRF prevention — hardcoded IP denylist and DNS resolution checks.
 *
 * All outbound HTTP must resolve DNS first and check the resolved IP
 * against this denylist. Private/reserved ranges are always blocked.
 * This is not configurable.
 *
 * IP parsing is byte-level: IPv6 addresses are expanded to their full
 * 16-byte form before range checks, so compressed, bracketed, zoned,
 * IPv4-mapped, IPv4-compatible, and NAT64 spellings cannot bypass the
 * denylist. Unparseable input is treated as private (default deny).
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
  // 100.64.0.0/10 — carrier-grade NAT (RFC 6598)
  { addr: 0x64400000, mask: 0xFFC00000 },
  // 192.0.0.0/24 — IETF protocol assignments (RFC 6890)
  { addr: 0xC0000000, mask: 0xFFFFFF00 },
  // 192.0.2.0/24 — TEST-NET-1 (RFC 5737)
  { addr: 0xC0000200, mask: 0xFFFFFF00 },
  // 198.18.0.0/15 — benchmarking (RFC 2544)
  { addr: 0xC6120000, mask: 0xFFFE0000 },
  // 198.51.100.0/24 — TEST-NET-2 (RFC 5737)
  { addr: 0xC6336400, mask: 0xFFFFFF00 },
  // 203.0.113.0/24 — TEST-NET-3 (RFC 5737)
  { addr: 0xCB007100, mask: 0xFFFFFF00 },
  // 224.0.0.0/4 — multicast
  { addr: 0xE0000000, mask: 0xF0000000 },
  // 240.0.0.0/4 — reserved for future use
  { addr: 0xF0000000, mask: 0xF0000000 },
  // 255.255.255.255/32 — limited broadcast (explicit; also inside 240/4)
  { addr: 0xFFFFFFFF, mask: 0xFFFFFFFF },
];

/** An IPv6 CIDR range expressed as a hextet prefix plus prefix length. */
interface Ipv6Cidr {
  readonly hextets: readonly number[];
  readonly bits: number;
}

/** IPv6 CIDR ranges that are always blocked (private/reserved). */
const SSRF_DENY_CIDRS_V6: readonly Ipv6Cidr[] = [
  // ::1/128 — loopback
  { hextets: [0, 0, 0, 0, 0, 0, 0, 1], bits: 128 },
  // ::/128 — unspecified
  { hextets: [0, 0, 0, 0, 0, 0, 0, 0], bits: 128 },
  // fc00::/7 — unique local (fc00:: through fdff::)
  { hextets: [0xFC00, 0, 0, 0, 0, 0, 0, 0], bits: 7 },
  // fe80::/10 — link-local (covers fe80:: through febf:: numerically)
  { hextets: [0xFE80, 0, 0, 0, 0, 0, 0, 0], bits: 10 },
  // ff00::/8 — multicast
  { hextets: [0xFF00, 0, 0, 0, 0, 0, 0, 0], bits: 8 },
  // 2001:db8::/32 — documentation (IPv6 TEST-NET analogue)
  { hextets: [0x2001, 0x0DB8, 0, 0, 0, 0, 0, 0], bits: 32 },
];

/** 96-bit prefixes whose final 32 bits embed an IPv4 address. */
const IPV4_MAPPED_PREFIX: readonly number[] = // ::ffff:0:0/96
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xFF];
const IPV4_COMPAT_PREFIX: readonly number[] = // ::/96 (deprecated)
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const NAT64_PREFIX: readonly number[] = // 64:ff9b::/96 (RFC 6052)
  [0x00, 0x64, 0xFF, 0x9B, 0, 0, 0, 0, 0, 0, 0, 0];

// --- IPv4 parsing ---

/**
 * Parse an IPv4 address string to a 32-bit number.
 *
 * Strict dotted-quad only: four decimal octets, no leading zeros
 * (octal-ambiguous spellings are rejected). Returns null otherwise.
 */
function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = parseInt(part, 10);
    if (n > 255) return null;
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

// --- IPv6 parsing (byte-level) ---

/** Strip surrounding `[...]` brackets and any `%zone` suffix. */
function stripIpv6Decorations(ip: string): string {
  let s = ip.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zoneIndex = s.indexOf("%");
  if (zoneIndex !== -1) s = s.slice(0, zoneIndex);
  return s;
}

/**
 * Convert IPv6 textual groups to 16-bit hextets.
 *
 * A trailing dotted-quad group (e.g. the tail of `::ffff:127.0.0.1`)
 * contributes two hextets. Returns null on any invalid group.
 */
function groupsToHextets(groups: readonly string[]): number[] | null {
  const hextets: number[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (group.includes(".")) {
      if (i !== groups.length - 1) return null;
      const v4 = parseIpv4(group);
      if (v4 === null) return null;
      hextets.push((v4 >>> 16) & 0xFFFF, v4 & 0xFFFF);
    } else {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      hextets.push(parseInt(group, 16));
    }
  }
  return hextets;
}

/** Pack eight 16-bit hextets into a 16-byte address. */
function packHextetsToBytes(hextets: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (hextets[i] >> 8) & 0xFF;
    bytes[i * 2 + 1] = hextets[i] & 0xFF;
  }
  return bytes;
}

/**
 * Parse an IPv6 address string into its full 16-byte form.
 *
 * Strips `[...]` brackets and `%zone` suffixes, expands `::` compression,
 * and decodes a trailing dotted IPv4 quad. Returns null when the string
 * is not a valid IPv6 address.
 */
function parseIpv6(ip: string): Uint8Array | null {
  const s = stripIpv6Decorations(ip).toLowerCase();
  if (!s.includes(":")) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  if (halves.length === 2 && halves[0].includes(".")) return null;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length === 2 && halves[1] !== ""
    ? halves[1].split(":")
    : [];
  const headHextets = groupsToHextets(head);
  const tailHextets = groupsToHextets(tail);
  if (headHextets === null || tailHextets === null) return null;
  const fill = 8 - headHextets.length - tailHextets.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const zeros = new Array<number>(fill).fill(0);
  return packHextetsToBytes([...headHextets, ...zeros, ...tailHextets]);
}

// --- IPv6 range checks ---

/** Check whether a parsed IPv6 address falls inside a CIDR range. */
function matchesIpv6Cidr(addr: Uint8Array, cidr: Ipv6Cidr): boolean {
  let bitsLeft = cidr.bits;
  for (let i = 0; i < 8 && bitsLeft > 0; i++) {
    const addrHextet = (addr[i * 2] << 8) | addr[i * 2 + 1];
    const maskBits = Math.min(16, bitsLeft);
    const mask = (0xFFFF << (16 - maskBits)) & 0xFFFF;
    if ((addrHextet & mask) !== (cidr.hextets[i] & mask)) return false;
    bitsLeft -= maskBits;
  }
  return true;
}

/** True when the first 12 bytes of the address equal the given prefix. */
function matchesIpv6Prefix96(
  addr: Uint8Array,
  prefix: readonly number[],
): boolean {
  for (let i = 0; i < 12; i++) {
    if (addr[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Extract the embedded IPv4 address from IPv4-mapped (`::ffff:0:0/96`),
 * deprecated IPv4-compatible (`::/96`), and NAT64 (`64:ff9b::/96`) forms.
 * Returns null when the address embeds no IPv4 address.
 */
function extractEmbeddedIpv4(addr: Uint8Array): number | null {
  const embedsIpv4 = matchesIpv6Prefix96(addr, IPV4_MAPPED_PREFIX) ||
    matchesIpv6Prefix96(addr, IPV4_COMPAT_PREFIX) ||
    matchesIpv6Prefix96(addr, NAT64_PREFIX);
  if (!embedsIpv4) return null;
  return (
    ((addr[12] << 24) | (addr[13] << 16) | (addr[14] << 8) | addr[15]) >>> 0
  );
}

/** Check if a parsed 16-byte IPv6 address falls in any denied range. */
function isPrivateIpv6Bytes(addr: Uint8Array): boolean {
  for (const cidr of SSRF_DENY_CIDRS_V6) {
    if (matchesIpv6Cidr(addr, cidr)) return true;
  }
  const embedded = extractEmbeddedIpv4(addr);
  if (embedded !== null) return isPrivateIpv4(embedded);
  return false;
}

// --- Public API ---

/**
 * Check if an IP address falls within the hardcoded SSRF denylist.
 *
 * IPv4 addresses are checked against private/reserved CIDR ranges. IPv6
 * addresses are parsed to their 16-byte form (handling `::` compression,
 * brackets, zone suffixes, and embedded-IPv4 spellings) and range-checked
 * numerically. Unparseable input is treated as private (default deny).
 * This function is pure and deterministic.
 */
export function isPrivateIp(ip: string): boolean {
  const ipv4 = parseIpv4(ip);
  if (ipv4 !== null) return isPrivateIpv4(ipv4);
  const ipv6 = parseIpv6(ip);
  if (ipv6 !== null) return isPrivateIpv6Bytes(ipv6);
  return true;
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
