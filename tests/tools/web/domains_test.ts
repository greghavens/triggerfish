/**
 * Phase A1: Web Domain Security Tests
 *
 * Tests SSRF denylist, glob pattern matching, domain classification,
 * and the unified domain policy interface.
 */
import { assertEquals } from "@std/assert";
import {
  createDomainPolicy,
  isPrivateIp,
} from "../../../src/tools/web/domains.ts";

// ─── SSRF Denylist: isPrivateIp ─────────────────────────────────────────────

Deno.test("isPrivateIp: blocks 127.0.0.0/8 (loopback)", () => {
  assertEquals(isPrivateIp("127.0.0.1"), true);
  assertEquals(isPrivateIp("127.255.255.255"), true);
  assertEquals(isPrivateIp("127.0.0.0"), true);
});

Deno.test("isPrivateIp: blocks 10.0.0.0/8 (private)", () => {
  assertEquals(isPrivateIp("10.0.0.1"), true);
  assertEquals(isPrivateIp("10.255.255.255"), true);
});

Deno.test("isPrivateIp: blocks 172.16.0.0/12 (private)", () => {
  assertEquals(isPrivateIp("172.16.0.1"), true);
  assertEquals(isPrivateIp("172.31.255.255"), true);
  // 172.32.x.x is outside the range
  assertEquals(isPrivateIp("172.32.0.1"), false);
});

Deno.test("isPrivateIp: blocks 192.168.0.0/16 (private)", () => {
  assertEquals(isPrivateIp("192.168.0.1"), true);
  assertEquals(isPrivateIp("192.168.255.255"), true);
});

Deno.test("isPrivateIp: blocks 169.254.0.0/16 (link-local)", () => {
  assertEquals(isPrivateIp("169.254.0.1"), true);
  assertEquals(isPrivateIp("169.254.169.254"), true);
});

Deno.test("isPrivateIp: blocks 0.0.0.0/8", () => {
  assertEquals(isPrivateIp("0.0.0.0"), true);
  assertEquals(isPrivateIp("0.255.255.255"), true);
});

Deno.test("isPrivateIp: blocks IPv6 loopback ::1", () => {
  assertEquals(isPrivateIp("::1"), true);
});

Deno.test("isPrivateIp: blocks IPv6 unique local (fc00::/7)", () => {
  assertEquals(isPrivateIp("fc00::1"), true);
  assertEquals(isPrivateIp("fd12:3456::1"), true);
});

Deno.test("isPrivateIp: blocks IPv6 link-local (fe80::/10)", () => {
  assertEquals(isPrivateIp("fe80::1"), true);
});

Deno.test("isPrivateIp: blocks IPv4-mapped IPv6", () => {
  assertEquals(isPrivateIp("::ffff:127.0.0.1"), true);
  assertEquals(isPrivateIp("::ffff:10.0.0.1"), true);
});

Deno.test("isPrivateIp: allows public IPs", () => {
  assertEquals(isPrivateIp("8.8.8.8"), false);
  assertEquals(isPrivateIp("1.1.1.1"), false);
  assertEquals(isPrivateIp("93.184.216.34"), false);
});

Deno.test("isPrivateIp: blocks TEST-NET-3 (203.0.113.0/24, RFC 5737)", () => {
  assertEquals(isPrivateIp("203.0.113.1"), true);
});

// ─── Domain Policy: Glob Pattern Matching ───────────────────────────────────

Deno.test("DomainPolicy: exact hostname in allowlist", () => {
  const policy = createDomainPolicy({
    allowlist: ["example.com"],
    denylist: [],
    classificationMap: [],
  });
  assertEquals(policy.isAllowed("https://example.com/page"), true);
  assertEquals(policy.isAllowed("https://other.com/page"), false);
});

Deno.test("DomainPolicy: glob pattern *.example.com matches subdomains", () => {
  const policy = createDomainPolicy({
    allowlist: ["*.example.com"],
    denylist: [],
    classificationMap: [],
  });
  assertEquals(policy.isAllowed("https://sub.example.com/page"), true);
  assertEquals(policy.isAllowed("https://deep.sub.example.com/page"), true);
  assertEquals(policy.isAllowed("https://example.com/page"), true);
  assertEquals(policy.isAllowed("https://notexample.com/page"), false);
});

Deno.test("DomainPolicy: denylist blocks domains", () => {
  const policy = createDomainPolicy({
    allowlist: [],
    denylist: ["malware.bad", "*.evil.com"],
    classificationMap: [],
  });
  assertEquals(policy.isAllowed("https://malware.bad/exploit"), false);
  assertEquals(policy.isAllowed("https://sub.evil.com/phish"), false);
  assertEquals(policy.isAllowed("https://good.com/page"), true);
});

Deno.test("DomainPolicy: denylist overrides allowlist", () => {
  const policy = createDomainPolicy({
    allowlist: ["*.corp.com"],
    denylist: ["secret.corp.com"],
    classificationMap: [],
  });
  assertEquals(policy.isAllowed("https://public.corp.com"), true);
  assertEquals(policy.isAllowed("https://secret.corp.com"), false);
});

Deno.test("DomainPolicy: empty allowlist allows all (minus denylist)", () => {
  const policy = createDomainPolicy({
    allowlist: [],
    denylist: ["blocked.com"],
    classificationMap: [],
  });
  assertEquals(policy.isAllowed("https://anything.com"), true);
  assertEquals(policy.isAllowed("https://blocked.com"), false);
});

Deno.test("DomainPolicy: invalid URL returns false for isAllowed", () => {
  const policy = createDomainPolicy({
    allowlist: [],
    denylist: [],
    classificationMap: [],
  });
  assertEquals(policy.isAllowed("not a url"), false);
});

// ─── Domain Classification ──────────────────────────────────────────────────

Deno.test("DomainPolicy: classification mapping with exact hostname", () => {
  const policy = createDomainPolicy({
    allowlist: [],
    denylist: [],
    classificationMap: [
      { pattern: "internal.corp", classification: "CONFIDENTIAL" },
    ],
  });
  assertEquals(
    policy.getClassification("https://internal.corp/docs"),
    "CONFIDENTIAL",
  );
});

Deno.test("DomainPolicy: classification mapping with glob pattern", () => {
  const policy = createDomainPolicy({
    allowlist: [],
    denylist: [],
    classificationMap: [
      { pattern: "*.internal.company.com", classification: "INTERNAL" },
    ],
  });
  assertEquals(
    policy.getClassification("https://hr.internal.company.com/"),
    "INTERNAL",
  );
});

Deno.test("DomainPolicy: unclassified domain returns PUBLIC", () => {
  const policy = createDomainPolicy({
    allowlist: [],
    denylist: [],
    classificationMap: [],
  });
  assertEquals(policy.getClassification("https://example.com"), "PUBLIC");
});

Deno.test("DomainPolicy: invalid URL returns PUBLIC for getClassification", () => {
  const policy = createDomainPolicy({
    allowlist: [],
    denylist: [],
    classificationMap: [
      { pattern: "secret.com", classification: "RESTRICTED" },
    ],
  });
  assertEquals(policy.getClassification("not a url"), "PUBLIC");
});
