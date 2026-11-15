# Security Review — Domain: web-browser

Audited paths: `src/tools/web/`, `src/tools/browser/` (plus the canonical SSRF/fetch
implementations in `src/core/security/ssrf.ts` and `src/core/security/safe_fetch.ts`,
which the web/browser modules re-export, and the production wiring in
`src/gateway/startup/services/browser_init.ts` and `src/agent/dispatch/`).

Branch: `security-remediation`. Full-source audit (not a diff).

Summary: The `web_fetch` SSRF path is well-built — DNS-resolve-then-IP-denylist on
the initial request and **per-hop re-validation** of every redirect
(`safeFetchWithRedirects`, `redirect: "manual"`). IP-literal URLs fail closed
(Deno's `resolveDns` rejects literals). The IPv4 denylist math is correct
(verified empirically). The principal weaknesses are in the **browser
(CDP/puppeteer) navigation path**, which does NOT replicate the redirect
re-validation or guard against the browser's independent DNS resolution and
subresource fetches, and several denylist completeness / hardening gaps.

---

## WEB-BROWSER-1: Browser navigation follows HTTP redirects with no per-hop SSRF re-validation

**Severity:** high

**Location:** `src/tools/browser/tools/tools_navigation.ts:62-85` (`navigateBrowserPage`),
`src/tools/browser/tools/tools.ts:72-85` (`navigate`)

**Description:**
`web_fetch` follows redirects manually and re-runs the SSRF DNS/IP check on every
hop (`src/core/security/safe_fetch.ts:94-120`, `safeFetchWithRedirects` with
`redirect: "manual"`). The browser navigation path does NOT. It runs the SSRF
check once on the *initial* hostname (`enforceBrowserNavigationPolicy`) and then
calls `page.goto(url, { waitUntil: "domcontentloaded" })`, which lets Chrome
follow 3xx redirects internally with no further checks. There is no
`page.setRequestInterception(true)` anywhere in `src/tools/browser/` (confirmed by
grep), so nothing re-validates the redirect target.

A permitted, public domain (passes the initial DNS+denylist+domain-policy check)
can return `302 Location: http://169.254.169.254/latest/meta-data/...` (cloud
metadata) or any private/internal address, and the browser will fetch it. The
agent can then read the response via `browser_snapshot` (returns
`document.body.innerText` and page links) — exfiltrating internal data back into
the LLM context. `browser_navigate` is an LLM-exposed tool wired into the live
orchestrator (`gateway/startup/services/browser_init.ts` → `createAutoLaunchBrowserExecutor`),
and the redirect can also be reached on any attacker-controlled or
prompt-injected page, so this is an SSRF bypass past the denylist.

The PRE_TOOL_CALL resource-classification gate does not save this either: it
classifies `call.args.url` (the *declared* URL), not the redirect destination
(`src/agent/dispatch/security_context.ts:127-143`), and it only blocks
write-down (higher taint → lower-classified host), not requests to private IPs.

**Evidence:**
```ts
// tools_navigation.ts — SSRF check is one-shot on the initial hostname
export async function enforceBrowserNavigationPolicy(
  url: string, hostname: string, dnsCheck: DnsChecker, domainPolicy: DomainPolicy,
): Promise<Result<void, string>> {
  const dnsResult = await dnsCheck(hostname);          // checked ONCE
  if (!dnsResult.ok) return { ok: false, error: dnsResult.error };
  if (!domainPolicy.isAllowed(url)) { ... }
  return { ok: true, value: undefined };
}

export async function navigateBrowserPage(page: Page, url: string) {
  const response = await page.goto(url, {              // Chrome follows 3xx
    waitUntil: "domcontentloaded", timeout: 30000,     // hops with NO re-check
  });
  ...
}
```
Contrast `src/core/security/safe_fetch.ts:94-120` (web path) which loops over hops
and calls `validateOutboundUrl` on each. The web SSRF test suite explicitly
covers this (`tests/tools/web/ssrf_test.ts:183` "blocks a redirect hop resolving
to a private IP"); the browser suite has no equivalent (its `page` is a mock that
never redirects).

**Recommendation:**
Enable CDP request interception and re-run `resolveAndCheck` + `domainPolicy.isAllowed`
on every navigation/redirect request before allowing it (abort otherwise). At
minimum, after `page.goto` resolves, re-validate `page.url()` (the final URL) and
treat a private/blocked final host as an error with the body discarded — though
interception is the only way to block the request *before* the response is
fetched.

---

## WEB-BROWSER-2: Browser DNS rebinding + unchecked subresource fetches (no IP guard once Chrome owns the navigation)

**Severity:** high

**Location:** `src/tools/browser/tools/tools_navigation.ts:40-57`,
`src/tools/browser/tools/tools.ts:67-85`, `src/tools/browser/manager/manager_launch.ts:29-45`
(`baseChromeArgs`)

**Description:**
Two related TOCTOU/scope gaps in the browser path:

1. **DNS rebinding.** `enforceBrowserNavigationPolicy` resolves the hostname via
   `resolveAndCheck(hostname)` and checks the resulting IPs, then `page.goto`
   makes Chrome resolve the **same hostname again, independently**. With a
   low-TTL attacker-controlled DNS record, the validation lookup returns a public
   IP (passes) and Chrome's lookup returns a private IP (e.g. `169.254.169.254`,
   `127.0.0.1`). Triggerfish never pins the validated IP for the actual request,
   so the check and the fetch can resolve to different addresses. The `web_fetch`
   path has the same theoretical window, but its blast radius is smaller because
   the body is size-limited and re-validated per hop; the browser executes page
   JS and renders subresources.

2. **Unchecked subresources.** Once `page.goto` loads a page, Chrome fetches all
   subresources — `<img>`, `<script>`, `<iframe>`, CSS, and any `fetch()`/`XHR`
   issued by page JavaScript — with **no SSRF check at all**. A public page can
   embed `<img src="http://169.254.169.254/latest/meta-data/iam/...">` or script
   that calls internal services; results are observable to the page (and thus
   exfiltratable, e.g. via a beacon the attacker controls, or visible in a
   screenshot/snapshot). The launch flags (`baseChromeArgs`) contain no
   `--host-resolver-rules`, proxy isolation, or network restriction, so Chrome
   has unrestricted network egress to the host's loopback/LAN/metadata endpoints.

**Evidence:**
```ts
// baseChromeArgs — no --host-resolver-rules / proxy / egress restriction
return [
  "--no-first-run", "--disable-default-apps", "--disable-extensions",
  "--disable-sync", "--disable-background-networking",
  "--disable-blink-features=AutomationControlled", "--disable-infobars",
  "--exclude-switches=enable-automation",
  ...(config.credentialAutofill === true ? [] : ["--disable-save-password-bubble"]),
  ...(config.launchArgs ?? []),
];
```
`enforceBrowserNavigationPolicy` checks DNS once; nothing pins the result for the
subsequent `page.goto`, and nothing constrains subresource origins.

**Recommendation:**
Use CDP `Fetch`/`Network` request interception to re-resolve and re-check **every**
request the page issues (main frame, subframes, and subresources) against the
SSRF denylist, aborting on private/blocked IPs. Consider launching Chrome with a
locked-down `--host-resolver-rules` or an egress proxy that enforces the denylist,
so the browser cannot reach loopback/link-local/RFC1918 ranges regardless of DNS.
This also closes the rebinding window because interception re-checks at request
time.

---

## WEB-BROWSER-3: IPv4-mapped IPv6 in compressed-hex form bypasses the private-IP denylist

**Severity:** medium

**Location:** `src/core/security/ssrf.ts:77-117` (`isPrivateIp`,
`fullFormMappedToIpv4`, `isPrivateIpv6`)

**Description:**
`isPrivateIp` handles IPv4-mapped IPv6 in two forms: the dotted form
`::ffff:127.0.0.1` (regex at line 112) and the fully-expanded hex form
`0:0:0:0:0:ffff:7f00:0001` (`fullFormMappedToIpv4`, line 78 regex requires five
`0:` groups). It does NOT handle the **compressed** hex form
`::ffff:7f00:1`, which is the canonical short representation Deno’s `resolveDns`
emits for AAAA records (verified: `dns.google` returns `2001:4860:4860::8844`,
i.e. compressed). So a hostname whose AAAA record is `::ffff:7f00:1` (loopback)
or `::ffff:a9fe:a9fe` (169.254.169.254) is reported as **public** and passes the
denylist.

Verified empirically:
```
!!! isPrivateIp("::ffff:7f00:1")            = false  (loopback, should be true)
    isPrivateIp("0:0:0:0:0:ffff:7f00:0001") = true   (expanded form handled)
    isPrivateIp("::ffff:127.0.0.1")         = true   (dotted form handled)
```
Exploitability is gated: the attacker must control DNS to return an AAAA record
in this exact form and the host's networking stack must route the v4-mapped
address to the embedded IPv4 — but it is a genuine hole in a "hardcoded,
non-overridable" denylist that the product guarantee depends on, and it is the
kind of encoding a rebinding attacker would try.

**Evidence:**
```ts
// Only the dotted v4-mapped form is normalized:
const v4Mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
if (v4Mapped) return isPrivateIp(v4Mapped[1]);
// fullFormMappedToIpv4 requires the EXPANDED 0:0:0:0:0:ffff: form:
const match = normalized.match(/^(?:0+:){5}ffff:([0-9a-f]+):([0-9a-f]+)$/);
// → compressed "::ffff:7f00:1" matches neither.
```

**Recommendation:**
Normalize IPv6 to a canonical fully-expanded form before matching (expand `::`),
or add handling for the compressed `::ffff:HHHH:LLLL` shape (and `::ffff:0:HHHH`
variants). Better: parse the address into its 16 bytes and check ranges
numerically rather than via string prefixes/regex, which also fixes the prefix
fragility in `isPrivateIpv6`.

---

## WEB-BROWSER-4: SSRF IPv4 denylist omits CGNAT and other reserved ranges; IPv6 prefix matching is string-fragile

**Severity:** medium

**Location:** `src/core/security/ssrf.ts:19-43` (`SSRF_DENY_CIDRS_V4`,
`SSRF_DENY_V6_PREFIXES`)

**Description:**
The hardcoded IPv4 denylist covers loopback, RFC1918, link-local (169.254/16,
which does cover the AWS/GCP metadata IP), and 0.0.0.0/8. It is missing other
ranges that resolve to internal/abuse targets:
- `100.64.0.0/10` — Carrier-Grade NAT (used inside many cloud/VPC and ISP
  networks; a hostname can legitimately resolve here).
- `192.0.0.0/24`, `192.0.2.0/24`, `198.18.0.0/15`, `198.51.100.0/24`,
  `203.0.113.0/24` — IETF special-use / benchmarking / TEST-NET.
- `240.0.0.0/4` (reserved) and `255.255.255.255` (broadcast).
- IPv4 multicast `224.0.0.0/4` (less impactful but conventionally blocked).

Verified the gaps are live: `isPrivateIp("100.64.0.1")`, `isPrivateIp("198.18.0.1")`,
`isPrivateIp("240.0.0.1")`, `isPrivateIp("224.0.0.1")` all return `false`.

The IPv6 side is matched by lowercase string prefixes (`"fc"`, `"fd"`, `"fe80:"`),
which is brittle: it relies on Deno returning a particular textual form and would
miss, e.g., IPv4-compatible deprecated addresses or NAT64 (`64:ff9b::/96`)
wrapping a private v4. Because IP-literal URLs fail closed in `web_fetch` (Deno
`resolveDns` rejects literals), the practical impact is limited to hostnames that
*resolve* to these ranges, but for the metadata/CGNAT case that is a realistic
SSRF target and the denylist is advertised as the authoritative, non-configurable
control.

**Evidence:**
```ts
const SSRF_DENY_CIDRS_V4 = [
  { addr: 0x7F000000, mask: 0xFF000000 }, // 127/8
  { addr: 0x0A000000, mask: 0xFF000000 }, // 10/8
  { addr: 0xAC100000, mask: 0xFFF00000 }, // 172.16/12
  { addr: 0xC0A80000, mask: 0xFFFF0000 }, // 192.168/16
  { addr: 0xA9FE0000, mask: 0xFFFF0000 }, // 169.254/16
  { addr: 0x00000000, mask: 0xFF000000 }, // 0/8
];   // no 100.64/10, 198.18/15, 240/4, 224/4, 255.255.255.255, TEST-NETs
```

**Recommendation:**
Add the missing reserved/special-use CIDRs (notably `100.64.0.0/10`, `240.0.0.0/4`,
`224.0.0.0/4`, `198.18.0.0/15`, and the TEST-NET ranges). Replace the IPv6 prefix
string match with byte-level range checks covering `::1/128`, `fc00::/7`,
`fe80::/10`, `::/128`, IPv4-mapped/compat, and `64:ff9b::/96` (NAT64) unwrapping.

---

## WEB-BROWSER-5: web_fetch domain allowlist/denylist is not re-checked on redirect hops

**Severity:** medium

**Location:** `src/tools/web/fetch.ts:48-77` (`enforceFetchPolicy`) +
`src/core/security/safe_fetch.ts:94-120` (`safeFetchWithRedirects`)

**Description:**
`createWebFetcher().fetch` enforces `domainPolicy.isAllowed(url)` only on the
*initial* URL (`enforceFetchPolicy`). The actual fetch is delegated to
`safeFetchWithRedirects`, which re-validates **SSRF (private IP) per hop** but
never re-applies the domain allowlist/denylist. Consequently, if an operator
configures `web.domains.allowlist` (an explicit allow-list deployment) or a
denylist of public domains, an allowed page can `3xx`-redirect to a domain that
is *not* on the allowlist (or *is* on the denylist) and `web_fetch` will follow
it and return the content. The IP denylist still applies per hop, so this is not
a private-IP SSRF — it is a domain-policy / egress-allowlist bypass that defeats
the configured boundary (e.g., data-exfiltration to a non-approved public host,
or reaching a denied public domain).

**Evidence:**
```ts
// fetch.ts: allowlist/denylist checked once, on the initial URL
if (!domainPolicy.isAllowed(url)) {
  return { ok: false, error: `Domain blocked by policy: ${hostname}` };
}
...
const pageResult = await fetchPageContent({ url, ..., ssrfChecker: resolveAndCheck });
// safe_fetch.ts validateOutboundUrl (run per hop) only does protocol + SSRF:
const ssrfResult = await ssrfChecker(parsed.hostname);   // no domainPolicy.isAllowed
```

**Recommendation:**
Thread the `DomainPolicy` (or an `isAllowed(url)` predicate) into the per-hop
validation so the allowlist/denylist is re-evaluated on every redirect target,
consistent with how the SSRF check is already re-evaluated. Fail closed if a hop
violates the domain policy.

---

## WEB-BROWSER-6: Browser navigation SSRF/domain-policy block decisions are not logged

**Severity:** low

**Location:** `src/tools/browser/tools/tools_navigation.ts:40-57`,
`src/tools/browser/tools/tools.ts:72-85`

**Description:**
Project serviceability rules require security decisions (`canFlowTo`, SSRF checks)
to log within ±5 lines, and security events (denied/blocked/violation) at WARN+.
`enforceBrowserNavigationPolicy` and the `navigate` factory produce no log
statements for the allow path or for the two block paths (SSRF DNS failure,
domain-policy denial). The underlying `resolveAndCheck`/`enforceIpListForSsrf`
logs the SSRF outcome at the core layer, but a domain-policy denial
(`!domainPolicy.isAllowed(url)`) and the overall browser-navigation block are
silent. For a daemon whose only visibility is `~/.triggerfish/logs/`, blocked
navigations leave no audit trail, undermining "Audit everything" for this tool.
This is defense-in-depth/observability, not an exploitable flaw.

**Evidence:**
```ts
// tools_navigation.ts — no createLogger import, no log calls on the deny paths
if (!domainPolicy.isAllowed(url)) {
  return { ok: false, error: `Navigation blocked by domain policy: ${url}` };  // not logged
}
```
(grep for `log.` in `tools_navigation.ts` / `tools.ts` returns nothing.)

**Recommendation:**
Add a `createLogger("browser-tools")` and log the domain-policy denial and the
navigation block at WARN with `{ operation, hostname }` (avoid logging full URLs
that may carry tokens). Keep it consistent with the web-fetch path
(`enforceFetchPolicy` logs both block and allow).

---

## Notes / verified-safe (no finding)

- **IPv4 denylist math is correct.** The signed-`&` CIDR comparison
  (`(ipv4 & cidr.mask) === (cidr.addr & cidr.mask)`) works despite the high-bit
  sign issue; verified empirically for 127/8, 10/8, 172.16/12, 192.168/16,
  169.254/16, 0/8 and public IPs.
- **IP-literal SSRF is fail-closed in web_fetch.** WHATWG `URL` normalizes
  `0x7f000001`, `2130706433`, `0177.0.0.1`, unicode digits all to `127.0.0.1`,
  and `Deno.resolveDns` rejects IP literals (`no records found`), so direct
  IP-literal fetches (private *and* public) are blocked before the IP check. This
  is fail-closed, though it means `isPrivateIp` is effectively dead for the
  literal case in this path — protection rests on `resolveDns` behavior, which is
  worth a regression test.
- **`createSsrfCheckedFetch` rejects `Request` inputs** so every hop is
  re-validated — good (`safe_fetch.ts:162-164`).
- **Browser profile watermarking** correctly enforces escalation-only and
  blocks lower-taint reuse (`manager.ts:186-201`, `watermark.ts`), and logs the
  escalation at WARN.
- **Search providers** (`search_brave.ts`, `search_cloud.ts`) use raw `fetch` to
  *fixed, configured* API endpoints (not user/LLM-controlled URLs), so they are
  out of SSRF scope; the license key / API key are sent in headers and not logged.
- **CDP endpoint** is bound to `127.0.0.1` with an ephemeral port
  (`manager_detection.ts:224-231`) or pipe mode; not exposed externally.
</content>
</invoke>
