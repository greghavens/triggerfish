# Security Review — Domain: core-policy

Audited paths: `src/core/policy/`, `src/core/security/`, `src/core/types/`.
Branch: `security-remediation`. Full-source audit (not a diff).

Scope note: these modules are the deterministic enforcement substrate (policy
engine, hook runner, violation detectors, classification math, SSRF denylist,
HMAC, path/command classification, WebSocket auth). Because the security
guarantee is realized only when these primitives are wired correctly, every
candidate finding below was traced into its production callers
(`src/agent/dispatch/`, `src/gateway/`, `src/mcp/gateway/`) to confirm
reachability and fail-open-vs-fail-closed behavior. Findings that turned out to
be enforced one layer up, or fail-closed, are listed in the "Verified safe"
section rather than as findings.

Summary: The core classification math is sound and monotonic. `canFlowTo`,
`maxClassification`, taint escalation (`escalateTaint`), tool floors, the audit
HMAC chain, and the hook runner's fail-closed-on-timeout behavior are all
correct and were verified empirically. The hook runner defaults to BLOCK on any
exception/timeout, and the default system rules are loaded in production
(`gateway/startup/infra/storage.ts:80`,
`gateway/startup/factory/orchestrator_factory_infra.ts:91`). The principal
weaknesses are: (1) the write-down violation detector silently fails **open**
when the target classification is missing or an unrecognized string, while every
other classification comparison fails closed; (2) the `run_command` resource
classifier — described by the project as "THE security model" — can be evaded
for specific path-mapping configurations via shell features its tokenizer does
not model (command substitution, attached `<` input redirect); (3) the MCP
gateway fires the `MCP_TOOL_CALL` hook but discards its decision, and no default
rule exists for that hook. The SSRF IPv6 denylist gaps in `core/security/ssrf.ts`
are real but are already owned and documented by the web-browser domain
(WEB-BROWSER-3, WEB-BROWSER-4); they are cross-referenced here, not re-counted.

---

## CORE-POLICY-1: Write-down detector fails open on missing/unrecognized target classification

**Severity:** medium

**Location:** `src/core/policy/hooks/hook_violations.ts:16-24`
(`detectWriteDownViolation`); same pattern in `detectResourceWriteDownViolation`
(48-59) and `detectResourceReadCeilingViolation` (62-73).

**Description:**
`detectWriteDownViolation` is the predicate behind the `no-write-down` default
rule (`default_rules.ts:14-28`), which is the PRE_OUTPUT enforcement of the
project's core "no write-down" invariant. It only reports a violation when the
target classification is a *recognized* level:

```ts
export function detectWriteDownViolation(
  input: Record<string, unknown>,
  sessionTaint: ClassificationLevel,
): boolean {
  const target = input.target_classification as ClassificationLevel | undefined;
  return target !== undefined &&
    target in CLASSIFICATION_ORDER &&   // <-- guard makes unknown target => no violation
    !canFlowTo(sessionTaint, target);
}
```

If `target_classification` is `undefined` or a string not in
`CLASSIFICATION_ORDER` (e.g. a typo like `"CONFIDENTAL"`), the function returns
`false`, the `no-write-down` rule does not match, and the engine's no-match
default is `ALLOW` (`engine.ts:149`). A higher-tainted session's output is then
emitted to a target whose classification could not be parsed — a silent
write-down. This is inconsistent with the rest of the classification layer, which
fails **closed** on an invalid level. Verified empirically:

```
canFlowTo("CONFIDENTIAL", "CONFIDENTAL"(bad)) = false   // canFlowTo fails CLOSED (blocks)
detectWriteDownViolation(target="CONFIDENTAL"(bad))     // returns false => NO BLOCK (fails OPEN)
maxClassification("CONFIDENTIAL", bad) = "CONFIDENTAL"  // taint can LATCH onto a garbage level
```

So `canFlowTo` itself would block an invalid target, but the detector's explicit
`target in CLASSIFICATION_ORDER` guard suppresses the block.

Reachability: in the standard non-owner channel path the target is always a valid
level — `UserSessionManager.getClassification()` falls back to
`config.channelDefault` (`src/channels/user_sessions.ts:54-57`), so the guard
normally passes. However the classification values that feed `channelDefault` and
`userOverrides` are cast straight from raw YAML without validation
(`user_sessions.ts:118`, `value as ClassificationLevel`; same unchecked cast in
`gateway/startup/infra/mcp.ts:96-97` uses `parseClassification` but silently drops
invalid values to `undefined`). An operator typo in `user_classifications` (or any
future hook caller that forgets to set `target_classification`) yields an
unrecognized target and a fail-open write-down for that user. Owner output is
intentionally exempt (`response_handling.ts:49` sets `effectiveTarget = outputTaint`),
so this only affects non-owner / channel-targeted output — exactly where
write-down protection is supposed to apply.

**Evidence:** `hook_violations.ts:16-24` (guard); `engine.ts:149` (`return { action: "ALLOW" }`
default); `user_sessions.ts:118` (`map.set(String(key), value as ClassificationLevel)`
— no `parseClassification`).

**Recommendation:** Treat an unrecognized or missing `target_classification` as a
violation (fail closed), or validate it with `parseClassification` at the trust
boundary and reject the operation when parsing fails. At minimum, validate
`user_classifications` / channel-default config values via `parseClassification`
at load time so an invalid level can never reach the detector. The
`target in CLASSIFICATION_ORDER` short-circuit should not be the difference
between enforcing and silently skipping the no-write-down rule.

---

## CORE-POLICY-2: run_command resource classifier evadable via shell features the tokenizer does not model

**Severity:** medium

**Location:** `src/core/security/command_path_extraction.ts`
(`isPathLikeToken` 179-196, `tokenizeRespectingQuotes` 109-153,
`extractAttachedRedirectTarget` 249-256, `splitOnShellOperators` 31-80).

**Description:**
`run_command` participates in resource classification by extracting filesystem
paths from the opaque command string and classifying them (`classifyCommandPaths`
→ `classifyRealPath`). The project memory states this is "THE security model" —
the resource's classification drives taint escalation and write-down/read-ceiling
gating. The extractor models quotes, backslash escapes, `| ; && ||` operators, and
standalone/attached redirect targets, but several common shell constructs slip a
real accessed path past it intact, so the wrong (typically default) classification
is applied. Verified empirically:

```
"cat $(echo /etc/shadow)"  => ["/etc/shadow)"]   // trailing ')' from command substitution
"cat `echo /etc/shadow`"   => ["/etc/shadow`"]   // trailing '`' from backticks
"xxd</etc/shadow"          => ["xxd</etc/shadow"] // attached '<' input redirect, not split
```

Impact depends on the path-mapping configuration:

- **Prefix mappings (`/etc/*` → LEVEL) still match** despite a trailing `)`/`` ` ``
  because `pathPatternMatches` uses `startsWith(dirPrefix + "/")`
  (`path_classification_rules.ts:101`). So the common config is unaffected.
- **Exact-path mappings** (e.g. a single sensitive file mapped without a wildcard)
  do **not** match `"/etc/shadow)"`, so command substitution evades classification
  of that resource — no taint escalation, defeating read-ceiling (non-owner) and
  the resource write-down check for that call.
- The attached-redirect form `xxd</etc/shadow` is tokenized as the single token
  `xxd</etc/shadow`, which `isPathLikeToken` accepts as a path (it "contains `/`").
  `classifyRealPath` then resolves `"<cwd>/xxd</etc/shadow"` — a path that matches
  neither the hardcoded protected set nor any intended mapping — so the real file
  being read (`/etc/shadow`) is never classified.

This is reachable by the agent directly and by any prompt-injection-to-tool-abuse
chain that can steer `run_command`. The deterministic gate is supposed to be the
backstop the LLM cannot talk its way around; here the parser, not the LLM, is the
weak point.

**Evidence:** `command_path_extraction.ts:179-196` (`isPathLikeToken` accepts any
token containing `/`); `extractAttachedRedirectTarget` only strips a redirect op
when the *token starts with* the op, so `xxd</...` is missed
(`command_path_extraction.ts:249-256`); `splitOnShellOperators` has no case for
`$( )`, backticks, or process substitution (`command_path_extraction.ts:31-80`).

**Recommendation:** Strip trailing shell metacharacters (`) ` ; & | <space>`) from
extracted path tokens before classifying; split attached input-redirect tokens
(`cmd<path`, `cmd<<path`) the same way attached output redirects are handled;
recurse into `$( ... )` and backtick spans and extract paths from their contents.
Given the stated impossibility of fully parsing shell, fail conservatively: when a
token cannot be cleanly resolved, classify it at the configured filesystem default
(already CONFIDENTIAL) rather than letting a mangled path fall through to a less
restrictive mapping, and consider escalating to the workspace default for any
command containing un-modeled substitution syntax.

---

## CORE-POLICY-3: MCP_TOOL_CALL hook decision is discarded and has no default rule

**Severity:** low

**Location:** `src/mcp/gateway/gateway.ts:90-123` (`fireUnknownServerHook`,
`fireToolCallHook`), `:237-272` (`callTool`); default rule set
`src/core/policy/hooks/default_rules.ts:137-147`.

**Description:**
The MCP gateway calls `hookRunner.evaluateHook("MCP_TOOL_CALL", ...)` but never
inspects the returned `HookResult` — both `fireUnknownServerHook` and
`fireToolCallHook` return `Promise<void>` and `callTool` proceeds based only on
`rejectDisallowedServerStatus` (server status) and taint escalation in
`buildGatewayToolResult`. Separately, `createDefaultRules()` defines no rule for
the `MCP_TOOL_CALL` hook, and the engine defaults to `ALLOW` when no rule matches
(`engine.ts:149`). Consequently any policy rule an operator authored for
`MCP_TOOL_CALL` (including a `BLOCK`) would have **no effect** — the hook is
informational/audit-only in this path.

This is rated low because it is not the primary MCP enforcement: `wireMcpServers`
registers every connected MCP server's prefix into both `toolClassifications` and
`integrationClassifications` (`gateway/startup/infra/mcp.ts:149-152`), so when MCP
tools are invoked through the orchestrator they pass through
`dispatchSecurityEnforcedToolCall` →`enforceIntegrationWriteDownPolicy`
(`agent/dispatch/security_pipeline.ts:82-111`), which *does* enforce write-down by
prefix, plus prefix-based taint escalation. Unclassified MCP servers are also
registered with status `"UNTRUSTED"` and rejected by
`rejectDisallowedServerStatus` (default-deny holds,
`gateway/startup/infra/mcp.ts:128`). The risk is the silent gap between operator
expectation ("I wrote an MCP_TOOL_CALL BLOCK rule") and reality ("it is never
consulted").

**Evidence:** `gateway.ts:107-123` (`fireToolCallHook` returns void, result
unused), `gateway.ts:248-253` (only `rejectDisallowedServerStatus` gates the
call), `default_rules.ts:137-147` (no `MCP_TOOL_CALL` entry).

**Recommendation:** Either honor the hook decision in `callTool` (reject when
`result.allowed === false`), or remove the hook calls and document that MCP
enforcement is performed at the orchestrator integration-classification layer so
operators do not author `MCP_TOOL_CALL` rules expecting them to fire. Add at least
an audit/log assertion if the hook is intentionally informational.

---

## CORE-POLICY-4: SSRF IPv6 denylist gaps in core/security/ssrf.ts (cross-reference)

**Severity:** medium (defect lives in this domain's owned file; primary write-up
owned by the web-browser domain)

**Location:** `src/core/security/ssrf.ts:37-43` (`SSRF_DENY_V6_PREFIXES`),
`:87-117` (`isPrivateIpv6`, `isPrivateIp`).

**Description:**
`ssrf.ts` is in this domain's audited paths, so the IPv6 denylist defects are
recorded here for completeness, but they are the same defects already documented
in detail (with recommendations) as **WEB-BROWSER-3** and **WEB-BROWSER-4**, and
are not re-counted as independent findings. Confirmed independently from the
core-policy side:

- **`fe80::/10` link-local is only partially covered.** The denylist matches the
  literal prefix `"fe80:"`, but `fe80::/10` spans `fe80::` through
  `febf:ffff:…` (second hextet 0x80–0xbf). Addresses such as `fe90::1`, `fea0::1`,
  `feb0::1`, `febf::1` are link-local but `isPrivateIp` returns `false`. This is
  reachable: `Deno.resolveDns(host, "AAAA")` returns bare, compressed addresses
  (verified: `2606:4700:4700::1111`), so a hostname whose AAAA record resolves to a
  `fe9x::`/`fea x::`/`feb x::` address passes the denylist. This contradicts the
  documented invariant "Private/reserved ranges always blocked."
- **`isPrivateIp` does not handle IPv6 literals / bracketed hosts.** `isPrivateIp("[::1]")`
  and `isPrivateIp("::ffff:7f00:1")` (compressed v4-mapped) return `false`.
  Currently *masked* because all outbound HTTP routes through `resolveAndCheck`,
  and `Deno.resolveDns` rejects IP literals ("Label contains invalid characters")
  → fail-closed (verified). It becomes exploitable the moment any caller validates
  a user-supplied literal host *without* DNS. This is the same "`isPrivateIp` is
  effectively dead for literals" observation made in the web-browser report.

**Evidence:**
```
isPrivateIp("fe90::1")        = false   // link-local fe80::/10, NOT blocked
isPrivateIp("febf::1")        = false   // link-local fe80::/10, NOT blocked
isPrivateIp("[::1]")          = false   // bracketed loopback literal, NOT blocked
isPrivateIp("::ffff:7f00:1")  = false   // compressed v4-mapped loopback, NOT blocked
isPrivateIp("fec0::1")        = false   // deprecated site-local — acceptable
resolveAndCheck("fe90::1")    = BLOCK (DNS literal rejected, fail-closed for *literals* only)
```

**Recommendation:** Replace the IPv6 prefix string match with a byte-level range
check covering `::1/128`, `::/128`, `fc00::/7`, `fe80::/10`, IPv4-mapped/compat,
and (optionally) `64:ff9b::/96` NAT64 unwrapping; strip surrounding brackets and
normalize `::` expansion before matching. Implement under WEB-BROWSER-3/4 to avoid
divergent fixes — the file is shared (`tools/web/ssrf.ts` and `tools/web/domains.ts`
re-export it).

---

## Verified safe (examined, not findings)

- **Taint monotonicity.** `escalateTaint` uses `maxClassification` and returns a
  new object; taint can only rise (`types/session.ts:115-150`). The PRE_TOOL_CALL
  path pre-escalates owner/trigger taint to the resource level *before* evaluating
  the hook and re-reads live taint (`security_pipeline.ts:263`, `:144`), so
  read-ups escalate and subsequent write-down/ceiling checks use the escalated
  taint. Ordering is correct (no taint TOCTOU that lowers protection).
- **Hook runner fail-closed.** Any exception/timeout in `evaluateHook` returns
  `{ allowed:false, action:"BLOCK" }` (`hook_runner.ts:46-55, 130-141`);
  `timeoutMs <= 0` rejects immediately.
- **HMAC / WebSocket auth.** `verifyHmacSha256` and `timingSafeEqual` use
  constant-time byte comparison (`hmac.ts:11-27, 50-66`). The gateway control
  plane is wired with a fresh per-start token, binds to `127.0.0.1`, and sets
  `allowedOrigins:["null"]` (`gateway/startup/services/chat_session_network.ts:233-237`);
  `rejectWebSocketUpgrade` fail-open-when-no-token (`websocket_auth.ts:61`) is not
  reachable because the caller always supplies a token, and localhost binding is
  defense-in-depth.
- **Audit chain.** HMAC-chained, genesis-anchored, canonicalized with sorted keys;
  `verify`/`verifyAuditChain` recompute and compare via string equality of hex
  digests and validate sequential indices (`audit.ts`, `audit_hmac.ts`).
- **Default-deny for unclassified resources.** Unknown outbound domains default to
  PUBLIC (`tools/web/policy.ts:90,110`), which is the *most restrictive* for the
  outbound write-down check — any tainted session is blocked from exfiltrating to
  an unclassified domain (verified: CONFIDENTIAL session + PUBLIC outbound resource
  ⇒ `canFlowTo` false ⇒ BLOCK). Unclassified MCP servers ⇒ `"UNTRUSTED"` ⇒
  rejected. Unmapped filesystem paths default to CONFIDENTIAL
  (`security/constants.ts:120`).
- **IPv4 literal SSRF encodings.** WHATWG `URL` normalizes `127.1`, `2130706433`,
  `0x7f000001`, `0177.0.0.1` to `127.0.0.1`, all correctly BLOCKED (verified). The
  IPv4 CIDR mask math in `isPrivateIpv4` is correct.
- **Path jail.** `isWithinJail` is separator-aware (rejects
  `/jailbreak` vs `/jail`); `isRealPathWithinJail` re-resolves symlinks and fails
  closed when the jail cannot be real-pathed (`path_jail.ts`).
- **`restoreSession` taint reset to PUBLIC** on daemon restart is intentional and
  safe (no data is loaded into the fresh process; matches the "fresh PUBLIC taint"
  invariant). `deserialise` uses `JSON.parse` over locally-trusted storage (no
  unsafe deserialization of untrusted input).
- **Policy engine `matches` operator** builds a `RegExp` from a condition value
  (`engine.ts:83-86`). Policy YAML is RESTRICTED, operator-supplied config, not
  attacker-controlled at runtime, so ReDoS/regex-injection is not reachable from an
  untrusted source. (Hardening nit only: the regex is unanchored and flag-less.)
- **Non-owner read ceiling** (`detectResourceReadCeilingViolation`) requires
  `is_owner === false`; `assembleSecurityContext` always sets `is_owner` to a
  boolean (`security_context.ts:198`), so there is no fail-open from an unset
  `is_owner` in the PRE_TOOL_CALL path.
