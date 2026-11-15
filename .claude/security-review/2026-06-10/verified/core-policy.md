# Verified Findings — Domain: core-policy

Verifier pass over `.claude/security-review/2026-06-10/findings/core-policy.md`.
Each finding was traced into its production callers and, where claims were
empirical, reproduced by running the actual `src/core` code under the project's
`deno.json`. Judged against `.claude/rules/security.md` (notably: owner channels
share classification by design; default-deny; fail-closed expectation).

Summary: all four findings are REAL. The two enforcement findings (CORE-POLICY-1
fail-open detector, CORE-POLICY-2 shell-tokenizer evasion) are genuine but their
blast radius is bounded in ways the report itself states honestly, so medium is
correct for both. CORE-POLICY-3 is a real but secondary gap, correctly rated low.
CORE-POLICY-4 is a real defect in this domain's owned file but is an explicit
cross-reference to WEB-BROWSER-3/4 (already adjudicated real/medium by the
web-browser verifier) — not an independent count.

---

## CORE-POLICY-1: real

**Verdict:** real. **Severity:** medium (confirmed).

**Claim:** `detectWriteDownViolation` (`hook_violations.ts:16-24`) fails OPEN when
`target_classification` is missing or an unrecognized string, because the
`target in CLASSIFICATION_ORDER` guard makes an unknown target return `false`
(no violation) → `no-write-down` rule does not match → engine no-match default
`ALLOW` (`engine.ts:149`). This is inconsistent with `canFlowTo`, which fails
CLOSED on an invalid level.

**Empirically reproduced** (ran the real `classification.ts` + `hook_violations.ts`):
```
canFlowTo("CONFIDENTIAL", "CONFIDENTAL"bad)          = false   // fails CLOSED (blocks)
detectWriteDownViolation(target="CONFIDENTAL"bad, taint=CONFIDENTIAL) = false  // fails OPEN (no block)
detectWriteDownViolation(target=undefined,        taint=CONFIDENTIAL) = false  // fails OPEN
maxClassification("CONFIDENTIAL", "CONFIDENTAL"bad) = "CONFIDENTAL"  // taint latches onto garbage
detectWriteDownViolation(target="PUBLIC",         taint=CONFIDENTIAL) = true   // control: valid level blocks
```
And `engine.ts:149` is literally `return { action: "ALLOW" }` on no match. The
fail-open is in the rule *predicate* (returns false cleanly, no exception), so
the hook runner's fail-closed-on-exception handler (`hook_runner.ts:130-141`,
verified) does NOT catch it.

**Reachability confirmed.** The PRE_OUTPUT `target_classification` is the
non-owner `targetClassification` (`response_handling.ts:60`; owner is exempt at
`:49`, `effectiveTarget = outputTaint`, matching the "owner channels share
classification" rule — correctly not a finding). For non-owner channel turns the
value is `userCls = userSessions.getClassification(...)`
(`chat_turn_execution.ts:249,281`), which resolves from `parseUserOverrides`
output or `channelDefault` (`user_sessions.ts:54-56`). I verified these are NOT
validated at the trust boundary for four of five channels:
- `parseUserOverrides` does `map.set(String(key), value as ClassificationLevel)`
  with no `parseClassification` (`user_sessions.ts:118`).
- Telegram (`channels_telegram.ts:117`), Discord (`channels_discord.ts:85`),
  Signal (`channels_signal.ts:279`), Google Chat (`channels_googlechat.ts:166`)
  all do `(config.classification ?? "...") as ClassificationLevel` with no
  `parseClassification`. Only WhatsApp validates and throws
  (`channels_whatsapp.ts:188-195`).
So an operator typo (e.g. `CONFIDENTAL`) in any of those four channels'
`classification` or any channel's `user_classifications` reaches the fail-open
detector. Note that the same `userCls` also feeds `updateTaint`, so the affected
non-owner's taint *and* target both become the garbage value, and write-down for
that user silently passes.

**Why not higher / not lower:** This is fail-open on operator misconfiguration,
not attacker-triggerable directly (the raw YAML is RESTRICTED, operator-supplied).
But it silently defeats the core no-write-down invariant for affected non-owner
users and is inconsistent with the otherwise-fail-closed classification layer, so
medium (not low) is right. Not high, because it requires a config typo and only
affects the mistyped user/channel. The report's reachability and owner-exemption
scoping are accurate. The resource-variant predicates
(`detectResourceWriteDownViolation`, `detectResourceReadCeilingViolation`) share
the same guard but are fed only by validated classifiers
(path map / tool floors validated via `parseClassification` at
`bootstrap.ts:170-192`; domain classifier returns valid levels), so the guard is
defense-in-depth there and not reachable with garbage — the report correctly
focuses the live exposure on the PRE_OUTPUT path.

**Final severity: medium.**

---

## CORE-POLICY-2: real

**Verdict:** real. **Severity:** medium (confirmed).

**Claim:** the `run_command` resource classifier extracts paths from the command
string but several shell constructs slip a real accessed path past the tokenizer,
so the wrong (typically default) classification is applied.

**Empirically reproduced** (`extractCommandPaths` from
`command_path_extraction.ts`):
```
"cat $(echo /etc/shadow)" => ["/etc/shadow)"]    // trailing ) from cmd substitution
"cat `echo /etc/shadow`"  => ["/etc/shadow`"]    // trailing backtick
"xxd</etc/shadow"         => ["xxd</etc/shadow"] // attached < not split
"echo hi >/etc/out"       => ["/etc/out"]        // control: attached > works
"xxd < /etc/shadow"       => ["/etc/shadow"]      // control: spaced < works
```
Confirmed code causes: `splitOnShellOperators` (`:31-80`) has no case for `$( )`,
backticks, or `<` (only `| ; && ||`); `extractAttachedRedirectTarget` (`:249-256`)
only strips a redirect op when the token *starts with* it, so `xxd</...` is missed;
`isPathLikeToken` (`:179-196`) accepts any token containing `/`.

**Actual classification impact reproduced** with a real `PathClassifier`
(default = CONFIDENTIAL):
```
exact map /etc/shadow→RESTRICTED:
  "cat /etc/shadow"          => RESTRICTED  (correct)
  "cat $(echo /etc/shadow)"  => CONFIDENTIAL (downgraded from RESTRICTED)
  "xxd</etc/shadow"          => CONFIDENTIAL (downgraded from RESTRICTED)
prefix map /etc/*→RESTRICTED:
  "cat $(echo /etc/shadow)"  => RESTRICTED  (prefix startsWith survives trailing ) )
  "xxd</etc/shadow"          => CONFIDENTIAL (path resolves cwd-relative, misses /etc/*)
hardcoded-protected basename:
  "cat ~/SPINE.md"           => RESTRICTED  (correct)
  "cat $(echo ~/SPINE.md)"   => CONFIDENTIAL (basename "SPINE.md)" misses PROTECTED_BASENAMES)
```
So the evasion does NOT fall through to PUBLIC — the filesystem default
(CONFIDENTIAL, verified `security/constants.ts` default) is the floor. But it
genuinely downgrades RESTRICTED resources to CONFIDENTIAL when they are protected
by an exact mapping, by a hardcoded basename, or accessed via the attached-`<`
form. Consequences: (1) under-taints the session by one level; (2) defeats the
non-owner read ceiling for a RESTRICTED file when the user's ceiling is
CONFIDENTIAL (`detectResourceReadCeilingViolation`: `canFlowTo(CONFIDENTIAL,
CONFIDENTIAL)=true` ⇒ no block, where RESTRICTED would have blocked).

**Wiring confirmed live (not dead code):** `classifyShellCommandResource`
(`command_classification.ts:260`) is reached from `resolveResourceClassification`
→ `assembleSecurityContext`, with `pathClassifier` and `getWorkspacePath` wired
in production (`service_startup.ts:64,81`, `chat_turn_execution.ts:125,128`,
`orchestrator_factory.ts:189,198`).

**Why medium (not higher):** the CONFIDENTIAL floor caps the blast radius — no
PUBLIC fall-through, and prefix-mapped `/etc/*`-style configs survive the
command-substitution variant. Real exploitation requires an exact/basename-mapped
RESTRICTED resource or the attached-`<` form. The report is honest about this
("prefix mappings still match", "default is already CONFIDENTIAL"). Real,
medium.

**Final severity: medium.**

---

## CORE-POLICY-3: real

**Verdict:** real. **Severity:** low (confirmed).

**Claim:** the MCP gateway fires `MCP_TOOL_CALL` but discards the `HookResult`,
and `createDefaultRules()` defines no rule for `MCP_TOOL_CALL`, so an
operator-authored `MCP_TOOL_CALL` BLOCK rule would never fire.

**Verified at the code level.** `fireUnknownServerHook` and `fireToolCallHook`
both return `Promise<void>` and the awaited result is unused
(`gateway.ts:90-123`); `callTool` proceeds gated only by
`rejectDisallowedServerStatus` and taint escalation in `buildGatewayToolResult`
(`gateway.ts:237-272`). `default_rules.ts:137-147` lists no `MCP_TOOL_CALL`
entry, and `engine.ts:149` defaults to ALLOW on no match.

**Mitigation-one-layer-up confirmed (this is why low is right).** I traced the
production MCP path. MCP tools are exposed as `mcp_<serverId>_<toolName>` tool
definitions (`executor.ts:140-182`) and invoked through the orchestrator tool
executor (`createMcpExecutor`, `executor.ts:94-132`), which means every MCP call
first passes `dispatchSecurityEnforcedToolCall` →
`enforceIntegrationWriteDownPolicy` (`security_pipeline.ts:82-111`). `wireMcpServers`
registers every connected server's `mcp_<id>_` prefix into BOTH
`toolClassifications` and `integrationClassifications` (`infra/mcp.ts:149-152`),
so prefix-based write-down, bumpers, and taint escalation DO enforce. Unclassified
servers register as `"UNTRUSTED"` (`infra/mcp.ts:128`) and are rejected by
`rejectDisallowedServerStatus` — default-deny holds (`buildMcpToolClassifications`
also omits unclassified servers, `executor.ts:190-200`).

So the discarded hook is a genuine but secondary/redundant gap: the silent
mismatch is "operator wrote an MCP_TOOL_CALL rule expecting it to fire, and it
never does." No write-down bypass results because the orchestrator layer is the
real gate. The report's reasoning and low rating are accurate.

**Final severity: low.**

---

## CORE-POLICY-4: real (cross-reference — not an independent count)

**Verdict:** real. **Severity:** medium (confirmed), as a defect in this domain's
owned file `src/core/security/ssrf.ts`; primary write-up and remediation owned by
WEB-BROWSER-3 / WEB-BROWSER-4.

**Empirically reproduced** (`isPrivateIp` from `core/security/ssrf.ts`):
```
isPrivateIp("fe80::1")        = true    // canonical link-local, blocked
isPrivateIp("fe90::1")        = false   // fe80::/10 link-local, NOT blocked
isPrivateIp("fea0::1")        = false   // NOT blocked
isPrivateIp("feb0::1")        = false   // NOT blocked
isPrivateIp("febf::1")        = false   // NOT blocked (range edge)
isPrivateIp("[::1]")          = false   // bracketed loopback literal, NOT blocked
isPrivateIp("::ffff:7f00:1")  = false   // compressed v4-mapped loopback, NOT blocked
isPrivateIp("::1")            = true ; ("fc00::1")=true ; ("fd12::1")=true ; ("::ffff:127.0.0.1")=true
```
Confirmed cause: `SSRF_DENY_V6_PREFIXES` matches only the literal string `"fe80:"`,
but `fe80::/10` spans `fe80::`–`febf:ffff:…` (`ssrf.ts:38-43`, `isPrivateIpv6`
`:87-99`). The `fe9x/feax/febx::` link-local gap is reachable via DNS: `Deno.resolveDns`
returns bare/compressed AAAA records, so a hostname resolving to such an address
passes `resolveAndCheck` — contradicting the "Private/reserved ranges always
blocked" invariant. The literal cases (`[::1]`, `::ffff:7f00:1`) are currently
MASKED because all outbound HTTP routes through `resolveAndCheck` and
`Deno.resolveDns` rejects IP literals (fail-closed); they become exploitable only
if a future caller validates a user-supplied literal without DNS. The report is
honest about this masking.

**Cross-reference legitimacy verified.** `src/tools/web/ssrf.ts` re-exports
`isPrivateIp`/`resolveAndCheck` from `core/security/ssrf.ts` — the same single
source — so the same bytes are the web tools' SSRF check. The web-browser report
contains WEB-BROWSER-3 (compressed IPv4-mapped IPv6 bypass) and WEB-BROWSER-4
(IPv4 denylist gaps + IPv6 prefix string-fragility), and the web-browser
*verifier* already adjudicated both as real/medium, empirically reproducing the
identical `isPrivateIp("::ffff:7f00:1") = false`. This finding correctly states it
is "not re-counted as an independent finding." Real defect, but a duplicate
cross-reference; severity medium matches the gated-exploitability assessment.

**Final severity: medium (cross-reference; remediate under WEB-BROWSER-3/4).**

---

## Notes on the "Verified safe" section (spot-checked, no findings)

I independently re-confirmed two load-bearing "Verified safe" claims because they
bound the impact of the findings above:
- **Hook runner fail-closed** (`hook_runner.ts:106-144`): any exception/timeout
  returns `{ allowed:false, action:"BLOCK" }`, and `timeoutMs <= 0` rejects
  immediately. Confirmed — this is why CORE-POLICY-1's fail-open had to live in
  the rule predicate (clean `false`), not the runner.
- **Owner output exemption** (`response_handling.ts:49`): owner `effectiveTarget`
  = own taint, so `canFlowTo(taint, taint)` is always true by design, consistent
  with the "owner channels share classification" rule in security.md. Correctly
  excluded from CORE-POLICY-1.
