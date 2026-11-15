# Verified Security Review — Domain: web-browser

Verifier pass over `.claude/security-review/2026-06-10/findings/web-browser.md`.
Each finding was checked against the actual code on the `security-remediation`
branch: cited files opened, calling/wiring code traced, mitigations grepped for
elsewhere (orchestrator dispatch, PRE_TOOL_CALL hooks, gateway wiring), and the
SSRF claims re-run empirically.

Overall: the report is unusually careful and its empirical self-checks reproduce
exactly. All six findings are confirmed REAL. Severities are accurate; I made one
minor severity annotation on WEB-BROWSER-1/2 (see notes) but kept the ratings.

---

## WEB-BROWSER-1: real

**Verdict:** real. **Severity:** high (confirmed).

**What I checked:**
- `src/tools/browser/tools/tools_navigation.ts` — `enforceBrowserNavigationPolicy`
  runs `dnsCheck(hostname)` exactly once on the initial hostname, then
  `navigateBrowserPage` calls `page.goto(url, { waitUntil: "domcontentloaded" })`.
  There is no re-validation of `page.url()` after the goto resolves.
- `grep -rn "setRequestInterception|Fetch.enable|Network.enable|page.on(...request...)|continueRequest|abortRequest|host-resolver-rules"`
  over `src/tools/browser/` returned **nothing** (exit 1). No CDP request
  interception exists anywhere in the browser module. Chrome follows 3xx
  redirects internally with no further checks.
- Production wiring is live, not dead: `src/gateway/startup/services/browser_init.ts`
  → `createAutoLaunchBrowserExecutor` → `src/tools/browser/executor/tools_executor_autolaunch.ts`
  (`launchBrowserForAgent` builds `createBrowserTools`) →
  `tools_executor_dispatch.ts` (`dispatchNavigate`). Referenced from
  `gateway/startup/services/chat_session.ts` and `tools/tool_executor.ts`. The
  `browser_navigate` tool is genuinely exposed to the LLM.
- Exfiltration channel confirmed: `src/tools/browser/tools/tools_page.ts`
  `captureBrowserSnapshot` returns `document.body.innerText` and page anchor
  links — the redirected internal response body is readable by the agent.
- The PRE_TOOL_CALL gate does NOT save this. `src/agent/dispatch/security_context.ts`
  `classifyUrlResource` classifies `call.args.url` (the *declared* URL).
  `src/core/policy/hooks/hook_violations.ts` `detectResourceWriteDownViolation`
  only fires when `!canFlowTo(sessionTaint, rc)` where `rc` is the declared
  domain's classification. For a permitted public domain (`rc = PUBLIC`) and a
  PUBLIC-taint session there is no block, and nothing classifies or inspects the
  redirect destination IP. The default rules (`default_rules.ts`) contain no
  private-IP rule at all — only tool-floor, resource-write-down, and
  read-ceiling.

**Refutation attempts (all failed):** searched for interception, post-goto
re-check, a hook that gates on resolved IP, and a final-URL validation. None
exist. The browser test suite (`tests/tools/browser/`) has `cdp_test.ts`,
`domains_test.ts`, `manager_test.ts`, `watermark_test.ts` — no redirect/SSRF
re-validation test (grep for `redirect|302|setRequestInterception` → none),
matching the report's claim that the mock page never redirects. The web path
*does* have the equivalent test (`tests/tools/web/ssrf_test.ts`
"blocks a redirect hop resolving to a private IP", confirmed present).

**Conclusion:** A permitted public host that returns
`302 Location: http://169.254.169.254/...` is followed by Chrome and its body is
exfiltrable via `browser_snapshot`. Genuine SSRF redirect bypass on a live,
LLM-exposed path. High is correct.

---

## WEB-BROWSER-2: real

**Verdict:** real. **Severity:** high (confirmed).

**What I checked:**
- DNS rebinding: `enforceBrowserNavigationPolicy` resolves+checks the hostname,
  but `page.goto` makes Chrome resolve the same hostname **independently**.
  Nothing pins the validated IP for the actual request — confirmed by reading the
  full navigate path in `tools_navigation.ts` and `tools.ts`; the validated IP
  from `dnsCheck` is discarded (only `dnsResult.ok` is consulted). With a
  low-TTL record the validation lookup and Chrome's lookup can differ.
- Unchecked subresources: no request interception (same grep as WEB-BROWSER-1),
  so once `page.goto` loads a page, all `<img>/<script>/<iframe>/fetch()/XHR`
  egress is unguarded.
- `src/tools/browser/manager/manager_launch.ts` `baseChromeArgs` — verified the
  flag list verbatim. No `--host-resolver-rules`, no proxy, no egress
  restriction. (`launchFlatpak` adds `--no-sandbox` and a window-size flag,
  still no network lockdown.) Chrome has unrestricted egress to
  loopback/LAN/metadata.

**Refutation attempts:** looked for an egress proxy, a pinned-IP connect
override, or `--host-resolver-rules` in both launch strategies and in the
manager — none. The `web_fetch` path shares the rebinding *window* but its blast
radius is smaller (size-limited body, per-hop re-validation); the browser
executes page JS and renders subresources, so the report's relative severity
framing is fair.

**Conclusion:** Real TOCTOU/rebinding + unchecked-subresource SSRF in the
browser path. High is correct.

---

## WEB-BROWSER-3: real

**Verdict:** real. **Severity:** medium (confirmed).

**What I checked (empirically reproduced):** ran `isPrivateIp` from
`src/core/security/ssrf.ts` against the report's cases:
```
!!! isPrivateIp("::ffff:7f00:1")            = false   (loopback, should be true)
!!! isPrivateIp("::ffff:a9fe:a9fe")         = false   (169.254.169.254, should be true)
ok  isPrivateIp("0:0:0:0:0:ffff:7f00:0001") = true    (expanded form handled)
ok  isPrivateIp("::ffff:127.0.0.1")         = true    (dotted form handled)
```
The compressed IPv4-mapped IPv6 form bypasses the denylist. Confirmed the code
cause: `isPrivateIp` (lines 107-117) only matches the dotted form
(`/^::ffff:(\d+\.\d+\.\d+\.\d+)$/`) and the fully-expanded form
(`fullFormMappedToIpv4` requires five `0:` groups). `::ffff:7f00:1` matches
neither, and `isPrivateIpv6`'s prefix list (`::1`, `fc`, `fd`, `fe80:`) does not
cover `::ffff:`.

Also confirmed the report's premise that Deno emits compressed IPv6: live
`Deno.resolveDns("dns.google", "AAAA")` returned
`["2001:4860:4860::8888","2001:4860:4860::8844"]` (compressed). So a malicious
AAAA record of `::ffff:7f00:1` would be returned in that exact form and pass.

**Severity judgement:** medium is right, not higher. Exploitability is gated: the
attacker must control DNS to return an AAAA record literally in the v4-mapped
shape *and* the host stack must route the v4-mapped address to the embedded IPv4.
That is a real but conditional path. It is nonetheless a genuine hole in a
denylist the product advertises as hardcoded/non-overridable, and exactly the
encoding a rebinding attacker would probe. Keep medium.

---

## WEB-BROWSER-4: real

**Verdict:** real. **Severity:** medium (confirmed).

**What I checked (empirically reproduced):**
```
!!! isPrivateIp("100.64.0.1")     = false   (CGNAT 100.64/10)
!!! isPrivateIp("100.127.255.255")= false   (CGNAT top)
!!! isPrivateIp("198.18.0.1")     = false   (benchmarking 198.18/15)
!!! isPrivateIp("240.0.0.1")      = false   (reserved 240/4)
!!! isPrivateIp("224.0.0.1")      = false   (multicast 224/4)
!!! isPrivateIp("255.255.255.255")= false   (broadcast)
!!! isPrivateIp("192.0.2.1")      = false   (TEST-NET-1)
ok  isPrivateIp("169.254.169.254")= true    (control)
ok  isPrivateIp("127.0.0.1")      = true    (control)
```
Confirmed `SSRF_DENY_CIDRS_V4` (ssrf.ts lines 19-35) contains only 127/8, 10/8,
172.16/12, 192.168/16, 169.254/16, 0/8. All the report's omissions are live
gaps. The IPv6 side is matched by lowercase string prefixes
(`SSRF_DENY_V6_PREFIXES`, used via `String.startsWith`), which is brittle as
described (relies on Deno's textual form, misses NAT64 `64:ff9b::/96` wrapping a
private v4).

**Severity judgement:** medium is right. Direct IP-literal URLs fail closed in
`web_fetch` (verified below), so the practical reach is hostnames that *resolve*
into these ranges. CGNAT (100.64/10) is the most realistic — it is routable
inside many cloud/VPC and ISP networks — making it a plausible internal target
the denylist should cover. The 240/4, 224/4, TEST-NET ranges are lower-impact but
conventionally blocked. Reasonable as medium.

**Supporting check (report's "verified-safe" notes reproduce):** WHATWG `URL`
normalizes `http://0x7f000001/`, `http://2130706433/`, `http://0177.0.0.1/` all
to hostname `127.0.0.1`; and `Deno.resolveDns("127.0.0.1","A")` throws
`no records found`. So obfuscated *literals* are fail-closed in `web_fetch`,
exactly as the report states. This strengthens the report's credibility and
correctly bounds the impact of #3/#4 to resolving hostnames.

---

## WEB-BROWSER-5: real

**Verdict:** real. **Severity:** medium (confirmed).

**What I checked:**
- `src/tools/web/fetch.ts` `enforceFetchPolicy` calls `domainPolicy.isAllowed(url)`
  exactly once, on the initial URL. The body fetch is delegated to
  `fetchPageContent` (`src/tools/web/fetch_content.ts`), which calls
  `safeFetchWithRedirects`.
- `src/core/security/safe_fetch.ts` — `grep` for `isAllowed|domainPolicy|DomainPolicy`
  returns **nothing**. `validateOutboundUrl` (run per hop) does protocol + SSRF
  (`ssrfChecker`) only. The domain allow/deny list is never re-applied on
  redirect hops.
- `src/tools/web/policy.ts` confirms the allowlist is a real, configurable mode:
  `evaluateDomainAllowance` denies if `allowlist.length > 0` and the hostname
  doesn't match. `browser_init.ts` `buildBrowserDomainPolicyFromConfig` wires
  `web.domains.allowlist/denylist` from config, so allowlist deployments exist.

**Conclusion:** When an operator configures an allowlist (or a public-domain
denylist), an allowed page can 3xx-redirect to a non-allowlisted / denied public
host and `web_fetch` returns the content. The IP denylist still applies per hop,
so this is a domain-policy/egress-allowlist bypass, not a private-IP SSRF —
exactly as the report scopes it. Medium is correct (impact is conditional on the
operator having configured an allow/deny list; with the default empty allowlist
there is no boundary to bypass).

---

## WEB-BROWSER-6: real

**Verdict:** real. **Severity:** low (confirmed).

**What I checked:**
- `grep -n "createLogger|log\.|import.*logger"` over
  `src/tools/browser/tools/tools_navigation.ts` and `tools.ts` returns **nothing**
  (exit 1). Neither file imports a logger or logs anything.
- The deny paths (`enforceBrowserNavigationPolicy` returning the SSRF DNS failure
  or `Navigation blocked by domain policy`) are therefore silent at this layer.
  The underlying `enforceIpListForSsrf` (`ssrf.ts`) does log the SSRF outcome
  (WARN on private IP, DEBUG on pass), so the *SSRF* decision has a log, but the
  domain-policy denial and the overall browser-navigation block do not.
- Contrast `src/tools/web/fetch.ts` `enforceFetchPolicy`, which logs both block
  (WARN) and allow (DEBUG) paths — the web path is the correct pattern the
  browser path is missing.

**Conclusion:** Real serviceability gap against the project's `serviceability.md`
rule ("security events (denied/blocked/violation) at WARN+" and "security calls
must log within ±5 lines"). It is observability/defense-in-depth, not an
exploitable flaw. Low is correct.

---

## Verifier notes on the report's "verified-safe" section

Spot-checked the report's no-finding claims; they hold:
- IPv4 literal obfuscation is fail-closed in `web_fetch` (reproduced above:
  WHATWG normalization + `resolveDns` literal rejection).
- `createSsrfCheckedFetch` rejects `Request` inputs (`safe_fetch.ts:162-164`) so
  every hop is a string/URL that gets re-validated — confirmed.
- Default rules carry no private-IP gate, consistent with the finding that SSRF
  protection lives only in the per-call DNS check (so the browser path's missing
  per-hop check is genuinely unguarded).

No over-claims detected. No dead-code/failed-closed/sanitized-elsewhere
exception applies to any of the six findings.
