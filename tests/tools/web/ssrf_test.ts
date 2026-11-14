/**
 * SSRF Prevention Tests
 *
 * Tests for the SSRF denylist helpers in src/tools/web/ssrf.ts:
 * - isPrivateIp with full-form IPv4-mapped IPv6 (new coverage)
 * - checkIpListForSsrf: blocks when ANY record is private (multi-record DNS)
 * - safeFetch: SSRF bypass attempt returns error
 *
 * @module
 */
import { assert, assertEquals } from "@std/assert";
import {
  checkIpListForSsrf,
  isPrivateIp,
  resolveAndCheck,
} from "../../../src/tools/web/ssrf.ts";
import { safeFetch } from "../../../src/tools/web/safe_fetch.ts";
import { safeFetchWithRedirects } from "../../../src/core/security/safe_fetch.ts";

// ─── isPrivateIp: full-form IPv4-mapped IPv6 ─────────────────────────────────

Deno.test("isPrivateIp: blocks full-form IPv4-mapped IPv6 loopback (0:0:0:0:0:ffff:7f00:1)", () => {
  // Represents 127.0.0.1
  assertEquals(isPrivateIp("0:0:0:0:0:ffff:7f00:1"), true);
});

Deno.test("isPrivateIp: blocks full-form IPv4-mapped IPv6 private 10.x (0:0:0:0:0:ffff:0a00:1)", () => {
  // Represents 10.0.0.1
  assertEquals(isPrivateIp("0:0:0:0:0:ffff:0a00:0001"), true);
});

Deno.test("isPrivateIp: blocks full-form IPv4-mapped IPv6 192.168.x (0:0:0:0:0:ffff:c0a8:0101)", () => {
  // Represents 192.168.1.1
  assertEquals(isPrivateIp("0:0:0:0:0:ffff:c0a8:0101"), true);
});

Deno.test("isPrivateIp: blocks full-form IPv4-mapped IPv6 link-local 169.254.x (0:0:0:0:0:ffff:a9fe:a9fe)", () => {
  // Represents 169.254.169.254 (AWS metadata endpoint)
  assertEquals(isPrivateIp("0:0:0:0:0:ffff:a9fe:a9fe"), true);
});

Deno.test("isPrivateIp: allows full-form IPv4-mapped IPv6 public IP (0:0:0:0:0:ffff:0808:0808)", () => {
  // Represents 8.8.8.8
  assertEquals(isPrivateIp("0:0:0:0:0:ffff:0808:0808"), false);
});

Deno.test("isPrivateIp: allows full-form IPv4-mapped IPv6 another public IP (0:0:0:0:0:ffff:0101:0101)", () => {
  // Represents 1.1.1.1
  assertEquals(isPrivateIp("0:0:0:0:0:ffff:0101:0101"), false);
});

// ─── checkIpListForSsrf: multi-record DNS ─────────────────────────────────────

Deno.test("checkIpListForSsrf: blocks when first record is private", () => {
  const result = checkIpListForSsrf("evil.example", ["127.0.0.1", "8.8.8.8"]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("127.0.0.1"), true);
  }
});

Deno.test("checkIpListForSsrf: blocks when private IP is not the first record", () => {
  // The key bypass scenario: first record is public, second is private
  const result = checkIpListForSsrf("sneaky.example", [
    "8.8.8.8",
    "127.0.0.1",
  ]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("127.0.0.1"), true);
  }
});

Deno.test("checkIpListForSsrf: blocks when only the third record is private (10.x)", () => {
  const result = checkIpListForSsrf("rebind.example", [
    "93.184.216.34",
    "1.1.1.1",
    "10.0.0.1",
  ]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("10.0.0.1"), true);
  }
});

Deno.test("checkIpListForSsrf: blocks when only the third record is link-local (169.254.x)", () => {
  // 169.254.169.254 is the AWS instance metadata endpoint
  const result = checkIpListForSsrf("aws-bypass.example", [
    "8.8.8.8",
    "1.1.1.1",
    "169.254.169.254",
  ]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("169.254.169.254"), true);
  }
});

Deno.test("checkIpListForSsrf: allows when all records are public", () => {
  const result = checkIpListForSsrf("cdn.example", [
    "93.184.216.34",
    "8.8.8.8",
    "1.1.1.1",
  ]);
  assertEquals(result.ok, true);
  if (result.ok) {
    // Returns first record
    assertEquals(result.value, "93.184.216.34");
  }
});

Deno.test("checkIpListForSsrf: allows single public record", () => {
  const result = checkIpListForSsrf("example.com", ["93.184.216.34"]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "93.184.216.34");
  }
});

Deno.test("checkIpListForSsrf: error message includes hostname and blocked IP", () => {
  const result = checkIpListForSsrf("evil.local", ["192.168.1.100"]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("evil.local"), true);
    assertEquals(result.error.includes("192.168.1.100"), true);
  }
});

// ─── safeFetch: SSRF prevention ──────────────────────────────────────────────

Deno.test("safeFetch: blocks request when SSRF check fails", async () => {
  const blockedDns = (_hostname: string) =>
    Promise.resolve({
      ok: false as const,
      error: "SSRF blocked: example.com resolves to private IP 127.0.0.1",
    });

  const result = await safeFetch("https://example.com/page", {}, blockedDns);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("SSRF blocked"), true);
  }
});

Deno.test("safeFetch: rejects invalid URL", async () => {
  const allowDns = (_hostname: string) =>
    Promise.resolve({ ok: true as const, value: "8.8.8.8" });

  const result = await safeFetch("not a url", {}, allowDns);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("Invalid URL"), true);
  }
});

Deno.test("safeFetch: rejects non-http protocols", async () => {
  const allowDns = (_hostname: string) =>
    Promise.resolve({ ok: true as const, value: "8.8.8.8" });

  const result = await safeFetch("ftp://example.com/file", {}, allowDns);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("Unsupported protocol"), true);
  }
});

Deno.test("safeFetch: calls SSRF check with correct hostname", async () => {
  let capturedHostname = "";
  const captureDns = (hostname: string) => {
    capturedHostname = hostname;
    return Promise.resolve({
      ok: false as const,
      error: `SSRF blocked: ${hostname}`,
    });
  };

  await safeFetch("https://target.example.com/api", {}, captureDns);
  assertEquals(capturedHostname, "target.example.com");
});

// ─── safeFetchWithRedirects: per-hop SSRF re-validation ──────────────────────

Deno.test("safeFetchWithRedirects: blocks a redirect hop resolving to a private IP", async () => {
  const checker = (hostname: string) =>
    Promise.resolve(
      hostname === "safe.example.com"
        ? { ok: true as const, value: "93.184.216.34" }
        : {
          ok: false as const,
          error: `SSRF blocked: ${hostname} resolves to private IP`,
        },
    );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response("redirecting", {
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data/" },
      }),
    )) as unknown as typeof fetch;
  try {
    const result = await safeFetchWithRedirects(
      "https://safe.example.com/start",
      {},
      checker,
    );
    assertEquals(result.ok, false);
    if (!result.ok) assert(result.error.includes("SSRF blocked"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("safeFetchWithRedirects: follows a safe redirect to a public host", async () => {
  const checker = (_hostname: string) =>
    Promise.resolve({ ok: true as const, value: "93.184.216.34" });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((url: string | URL) => {
    calls++;
    if (url.toString().includes("/start")) {
      return Promise.resolve(
        new Response("go", {
          status: 302,
          headers: { location: "https://example.com/final" },
        }),
      );
    }
    return Promise.resolve(new Response("final body", { status: 200 }));
  }) as unknown as typeof fetch;
  try {
    const result = await safeFetchWithRedirects(
      "https://example.com/start",
      {},
      checker,
    );
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.status, 200);
      assertEquals(await result.value.text(), "final body");
    }
    assertEquals(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── safeFetchWithRedirects: per-hop domain policy re-validation ─────────────

Deno.test("safeFetchWithRedirects: blocks a redirect hop that violates the domain policy", async () => {
  const checker = (_hostname: string) =>
    Promise.resolve({ ok: true as const, value: "93.184.216.34" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response("redirecting", {
        status: 302,
        headers: { location: "https://evil.example.org/payload" },
      }),
    )) as unknown as typeof fetch;
  try {
    const result = await safeFetchWithRedirects(
      "https://allowed.example.com/start",
      {},
      checker,
      {
        isUrlAllowed: (url) => new URL(url).hostname === "allowed.example.com",
      },
    );
    assertEquals(result.ok, false);
    if (!result.ok) {
      assert(result.error.includes("Domain blocked by policy"));
      assert(result.error.includes("evil.example.org"));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("safeFetchWithRedirects: blocks the initial URL when the domain policy denies it", async () => {
  const checker = (_hostname: string) =>
    Promise.resolve({ ok: true as const, value: "93.184.216.34" });
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    fetchCalls++;
    return Promise.resolve(new Response("body", { status: 200 }));
  }) as unknown as typeof fetch;
  try {
    const result = await safeFetchWithRedirects(
      "https://denied.example.org/start",
      {},
      checker,
      { isUrlAllowed: () => false },
    );
    assertEquals(result.ok, false);
    if (!result.ok) assert(result.error.includes("Domain blocked by policy"));
    assertEquals(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("safeFetchWithRedirects: follows a redirect when the domain policy allows every hop", async () => {
  const checker = (_hostname: string) =>
    Promise.resolve({ ok: true as const, value: "93.184.216.34" });
  const allowedHosts = ["start.example.com", "final.example.com"];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL) => {
    if (url.toString().includes("/start")) {
      return Promise.resolve(
        new Response("go", {
          status: 302,
          headers: { location: "https://final.example.com/landing" },
        }),
      );
    }
    return Promise.resolve(new Response("final body", { status: 200 }));
  }) as unknown as typeof fetch;
  try {
    const result = await safeFetchWithRedirects(
      "https://start.example.com/start",
      {},
      checker,
      { isUrlAllowed: (url) => allowedHosts.includes(new URL(url).hostname) },
    );
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.status, 200);
      assertEquals(await result.value.text(), "final body");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("safeFetchWithRedirects: fails closed when the domain policy predicate throws", async () => {
  const checker = (_hostname: string) =>
    Promise.resolve({ ok: true as const, value: "93.184.216.34" });
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    fetchCalls++;
    return Promise.resolve(new Response("body", { status: 200 }));
  }) as unknown as typeof fetch;
  try {
    const result = await safeFetchWithRedirects(
      "https://throwy.example.com/start",
      {},
      checker,
      {
        isUrlAllowed: () => {
          throw new Error("predicate exploded");
        },
      },
    );
    assertEquals(result.ok, false);
    if (!result.ok) assert(result.error.includes("Domain blocked by policy"));
    assertEquals(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── isPrivateIp: IPv6 unspecified address (::) ─────────────────────────────

Deno.test("isPrivateIp: blocks IPv6 unspecified address :: (short form)", () => {
  assertEquals(isPrivateIp("::"), true);
});

Deno.test("isPrivateIp: blocks IPv6 unspecified address 0:0:0:0:0:0:0:0 (full form)", () => {
  assertEquals(isPrivateIp("0:0:0:0:0:0:0:0"), true);
});

// ─── Regression: existing isPrivateIp tests still pass ───────────────────────

Deno.test("isPrivateIp regression: short-form IPv4-mapped IPv6 still blocked", () => {
  assertEquals(isPrivateIp("::ffff:127.0.0.1"), true);
  assertEquals(isPrivateIp("::ffff:10.0.0.1"), true);
  assertEquals(isPrivateIp("::ffff:192.168.1.1"), true);
});

Deno.test("isPrivateIp regression: IPv6 loopback ::1 still blocked", () => {
  assertEquals(isPrivateIp("::1"), true);
});

Deno.test("isPrivateIp regression: public IPs still allowed", () => {
  assertEquals(isPrivateIp("8.8.8.8"), false);
  assertEquals(isPrivateIp("1.1.1.1"), false);
});

// ─── resolveAndCheck: IPv6 AAAA record handling ──────────────────────────────

function stubResolveDns(
  aRecords: string[] | Error,
  aaaaRecords: string[] | Error,
): Deno.Disposable {
  const original = Deno.resolveDns;
  (Deno as Record<string, unknown>).resolveDns = (
    _hostname: string,
    recordType: string,
  ) => {
    if (recordType === "A") {
      return aRecords instanceof Error
        ? Promise.reject(aRecords)
        : Promise.resolve(aRecords);
    }
    if (recordType === "AAAA") {
      return aaaaRecords instanceof Error
        ? Promise.reject(aaaaRecords)
        : Promise.resolve(aaaaRecords);
    }
    return Promise.reject(new Error(`Unexpected record type: ${recordType}`));
  };
  return {
    [Symbol.dispose]() {
      (Deno as Record<string, unknown>).resolveDns = original;
    },
  };
}

Deno.test("resolveAndCheck: blocks private IPv6 loopback from AAAA record", async () => {
  using _stub = stubResolveDns(["1.2.3.4"], ["::1"]);
  const result = await resolveAndCheck("evil.example.com");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("::1"), true);
  }
});

Deno.test("resolveAndCheck: blocks private IPv6 unique-local (fd) from AAAA record", async () => {
  using _stub = stubResolveDns(["1.2.3.4"], ["fd12::1"]);
  const result = await resolveAndCheck("evil.example.com");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("fd12::1"), true);
  }
});

Deno.test("resolveAndCheck: blocks private IPv6 link-local from AAAA record", async () => {
  using _stub = stubResolveDns(["1.2.3.4"], ["fe80::1"]);
  const result = await resolveAndCheck("evil.example.com");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("fe80::1"), true);
  }
});

Deno.test("resolveAndCheck: allows public IPv6 from AAAA record", async () => {
  using _stub = stubResolveDns(["93.184.216.34"], ["2607:f8b0:4004:800::200e"]);
  const result = await resolveAndCheck("example.com");
  assertEquals(result.ok, true);
});

Deno.test("resolveAndCheck: works with AAAA-only host (no A records)", async () => {
  using _stub = stubResolveDns(new Error("no A records"), [
    "2607:f8b0:4004:800::200e",
  ]);
  const result = await resolveAndCheck("ipv6only.example.com");
  assertEquals(result.ok, true);
});

Deno.test("resolveAndCheck: works with A-only host (no AAAA records)", async () => {
  using _stub = stubResolveDns(["93.184.216.34"], new Error("no AAAA records"));
  const result = await resolveAndCheck("ipv4only.example.com");
  assertEquals(result.ok, true);
});

Deno.test("resolveAndCheck: fails when both A and AAAA queries fail", async () => {
  using _stub = stubResolveDns(new Error("NXDOMAIN"), new Error("NXDOMAIN"));
  const result = await resolveAndCheck("nonexistent.example.com");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("DNS resolution failed"), true);
  }
});

Deno.test("resolveAndCheck: blocks AAAA-only host with private IPv6", async () => {
  using _stub = stubResolveDns(new Error("no A records"), ["::1"]);
  const result = await resolveAndCheck("sneaky.example.com");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("::1"), true);
  }
});

// ─── Byte-level IPv6 parsing (compressed v4-mapped, fe80::/10 gap) ───────────

Deno.test("isPrivateIp: blocks compressed IPv4-mapped IPv6 loopback (::ffff:7f00:1)", () => {
  // Compressed spelling of 0:0:0:0:0:ffff:7f00:1 → 127.0.0.1
  assertEquals(isPrivateIp("::ffff:7f00:1"), true);
});

Deno.test("isPrivateIp: blocks compressed IPv4-mapped IPv6 metadata IP (::ffff:a9fe:a9fe)", () => {
  // Compressed spelling of 169.254.169.254 (cloud metadata endpoint)
  assertEquals(isPrivateIp("::ffff:a9fe:a9fe"), true);
});

Deno.test("isPrivateIp: allows compressed IPv4-mapped IPv6 public IP (::ffff:808:808)", () => {
  // Compressed spelling of 8.8.8.8
  assertEquals(isPrivateIp("::ffff:808:808"), false);
  assertEquals(isPrivateIp("::ffff:8.8.8.8"), false);
});

Deno.test("isPrivateIp: blocks full fe80::/10 link-local range (fe90::, fea0::, febf::)", () => {
  // The old string-prefix check only matched literal "fe80:" spellings
  assertEquals(isPrivateIp("fe90::1"), true);
  assertEquals(isPrivateIp("fea0::1"), true);
  assertEquals(isPrivateIp("febf::1"), true);
  // fec0:: is outside fe80::/10
  assertEquals(isPrivateIp("fec0::1"), false);
});

Deno.test("isPrivateIp: blocks bracketed IPv6 literals ([::1])", () => {
  assertEquals(isPrivateIp("[::1]"), true);
  assertEquals(isPrivateIp("[fe80::1]"), true);
  assertEquals(isPrivateIp("[::ffff:169.254.169.254]"), true);
});

Deno.test("isPrivateIp: blocks zoned IPv6 link-local (fe80::1%eth0)", () => {
  assertEquals(isPrivateIp("fe80::1%eth0"), true);
});

Deno.test("isPrivateIp: blocks NAT64-embedded private IPv4 (64:ff9b::/96)", () => {
  // 64:ff9b::7f00:1 embeds 127.0.0.1
  assertEquals(isPrivateIp("64:ff9b::7f00:1"), true);
  // 64:ff9b::a9fe:a9fe embeds 169.254.169.254
  assertEquals(isPrivateIp("64:ff9b::a9fe:a9fe"), true);
  // 64:ff9b::808:808 embeds public 8.8.8.8
  assertEquals(isPrivateIp("64:ff9b::808:808"), false);
});

Deno.test("isPrivateIp: blocks deprecated IPv4-compatible private addresses (::/96)", () => {
  // ::127.0.0.1 embeds loopback; ::8.8.8.8 embeds a public IP
  assertEquals(isPrivateIp("::127.0.0.1"), true);
  assertEquals(isPrivateIp("::8.8.8.8"), false);
});

Deno.test("isPrivateIp: blocks IPv6 multicast (ff00::/8) and documentation (2001:db8::/32)", () => {
  assertEquals(isPrivateIp("ff02::1"), true);
  assertEquals(isPrivateIp("2001:db8::1"), true);
});

Deno.test("isPrivateIp: allows public IPv6 (2001:4860:4860::8888)", () => {
  assertEquals(isPrivateIp("2001:4860:4860::8888"), false);
  assertEquals(isPrivateIp("2607:f8b0:4004:800::200e"), false);
});

// ─── Extended IPv4 reserved ranges ───────────────────────────────────────────

Deno.test("isPrivateIp: blocks carrier-grade NAT 100.64.0.0/10", () => {
  assertEquals(isPrivateIp("100.64.0.1"), true);
  assertEquals(isPrivateIp("100.127.255.255"), true);
  // Boundaries just outside the /10
  assertEquals(isPrivateIp("100.63.255.255"), false);
  assertEquals(isPrivateIp("100.128.0.1"), false);
});

Deno.test("isPrivateIp: blocks benchmarking range 198.18.0.0/15", () => {
  assertEquals(isPrivateIp("198.18.0.1"), true);
  assertEquals(isPrivateIp("198.19.255.255"), true);
  assertEquals(isPrivateIp("198.20.0.1"), false);
});

Deno.test("isPrivateIp: blocks IETF protocol assignments 192.0.0.0/24", () => {
  assertEquals(isPrivateIp("192.0.0.5"), true);
  assertEquals(isPrivateIp("192.0.1.5"), false);
});

Deno.test("isPrivateIp: blocks TEST-NET ranges (RFC 5737)", () => {
  assertEquals(isPrivateIp("192.0.2.1"), true); // TEST-NET-1
  assertEquals(isPrivateIp("198.51.100.7"), true); // TEST-NET-2
  assertEquals(isPrivateIp("203.0.113.9"), true); // TEST-NET-3
});

Deno.test("isPrivateIp: blocks multicast 224.0.0.0/4 and reserved 240.0.0.0/4", () => {
  assertEquals(isPrivateIp("224.0.0.1"), true);
  assertEquals(isPrivateIp("239.255.255.255"), true);
  assertEquals(isPrivateIp("240.0.0.1"), true);
  assertEquals(isPrivateIp("223.255.255.255"), false);
});

Deno.test("isPrivateIp: blocks limited broadcast 255.255.255.255", () => {
  assertEquals(isPrivateIp("255.255.255.255"), true);
});

// ─── Default deny on unparseable input ───────────────────────────────────────

Deno.test("isPrivateIp: treats unparseable input as private (default deny)", () => {
  assertEquals(isPrivateIp(""), true);
  assertEquals(isPrivateIp("not-an-ip"), true);
  assertEquals(isPrivateIp("1:2:3:4:5:6:7:8:9"), true);
  assertEquals(isPrivateIp("256.1.1.1"), true);
  // Octal-ambiguous dotted quads are rejected, hence denied
  assertEquals(isPrivateIp("0177.0.0.1"), true);
});
