# Triggerfish Security Remediation — Implementation Plan

Branch: `security-remediation` (base `master`). Date: 2026-06-10. All findings below were re-verified against current source; the "Status" column reflects what is actually in the tree after the 15 remediation commits already landed (M1–M10, H1/H2/H4/H6/H7, Google-Chat owner verification, dead-stub removal).

## Conventions every change must honor (`.claude/rules/`)

- `Result<T,E>` for expected failures; never throw for control flow. No `any`.
- Default-deny: unclassified/unparseable/missing ⇒ most restrictive, never allow.
- Immutable session state (return new objects); taint only escalates.
- Deterministic policy hooks — no LLM calls in the policy path.
- SSRF denylist is hardcoded and non-configurable; single SoT lives in `src/core/security/ssrf.ts` (re-exported by `src/tools/web/{ssrf,domains}.ts`).
- Structured logging via `createLogger` only — no `console.*`. Security decisions/denials log at WARN+; a security call must have a log statement within ±5 lines.
- Tests adjacent to source plus the phase test path in `tests/` (see table in `.claude/rules/testing.md`).
- Pre-existing unrelated infrastructure work ⇒ GitHub issue, not a code change in this branch.

## Verification commands (run per change; full set before finishing)

- Type check: `deno task check` (`deno check src/mod.ts src/cli/main.ts`)
- Lint: `deno task lint`
- Format: `deno task fmt`
- Targeted tests: `deno task test <path>` (phase paths cited per item)

---

## Summary table (finding → severity → status → action)

| ID | Severity (verified) | Status | Action |
|---|---|---|---|
| WEB-BROWSER-1 | high | OPEN | CDP request interception: re-validate every browser request (main+subresource+redirect) |
| WEB-BROWSER-2 | high | OPEN | Same interception fix + Chrome egress lockdown (`--host-resolver-rules`/proxy) |
| MCP-PLUGIN-1 | high | OPEN (decision needed) | Sandbox plugins OR drop "sandboxed" level; plus tool floor (see MCP-PLUGIN-2). Sandbox build = **GH issue** |
| MCP-PLUGIN-2 | high | OPEN | RESTRICTED floor on `plugin_install`/`plugin_reload`/`plugin_scan`; constrain `path` to plugins root |
| SCHEDULER-1 | high | OPEN | Pass `{isTrigger:true, ceiling}` for webhook+cron sessions; defense-in-depth default-deny in read-ceiling detector |
| CHANNELS-1 | high | OPEN | Adapters fail closed when ownerId unset; startup guard; wizard mandatory/warn |
| WEB-BROWSER-3 | medium | OPEN | Byte-level IPv6 parsing in `ssrf.ts` (handles compressed v4-mapped) |
| WEB-BROWSER-4 | medium | OPEN | Add missing v4 CIDRs (100.64/10, 240/4, 224/4, 198.18/15, TEST-NETs, broadcast) + IPv6 range checks + NAT64 |
| WEB-BROWSER-5 | medium | OPEN | Thread `DomainPolicy` predicate into per-hop redirect validation |
| MCP-PLUGIN-3 | medium | OPEN (partial fix landed) | Route SSE `send()` through `safeFetchWithRedirects`; validate post-redirect EventSource URL |
| MCP-PLUGIN-4 | medium | OPEN | Fence + injection-scan MCP tool descriptions and plugin systemPrompt |
| AGENT-EXEC-2 / CORE-POLICY-2 | medium | OPEN | Fail-closed command classification (strip metachars, split attached `<`, recurse `$()`/backticks, unparseable ⇒ filesystem default) |
| CORE-POLICY-1 | medium | OPEN | Write-down detector fails closed on missing/unknown target; validate channel/user classifications via `parseClassification` |
| GATEWAY-1 | medium | OPEN | Add classification to `DeliveryChannel`; gate `fanOut` with `canFlowTo`; fix stale taint read |
| CORE-STATE-1 | medium | OPEN | SQLite `list()` literal-prefix (range scan / `ESCAPE`) + provider conformance test |
| TOOLS-OTHER-1 | medium | OPEN | Reject `-`-leading SSH host; `-o PermitLocalCommand=no` |
| TOOLS-OTHER-2 | medium | OPEN | Route obsidian `folder`/outlinks `notePath` through `resolveVaultPath`; `canFlowTo` on outlinks |
| TOOLS-OTHER-3 | medium | OPEN | `log_read` → INTERNAL floor in `HARDCODED_TOOL_FLOORS` |
| INTEGRATIONS-CLI-1 | medium | OPEN | Jail `github_clone_repo`/`github_pull` dest via `isRealPathWithinJail`; require workspacePath |
| INTEGRATIONS-CLI-2 | low (was med) | OPEN | `assertValidBranchName` on clone/pull + `--` separator |
| CHANNELS-2 | low (was med) | OPEN | Standardize owner routing on `isOwner === true` |
| SCHEDULER-2 | medium | OPEN | Sign `timestamp + "." + body`; persist replay guard via StorageProvider; plumb config |
| CHANNELS-6 | low | OPEN | `timingSafeEqual` for WhatsApp verify_token |
| CHANNELS-7 | low | OPEN | Always-on per-sender attempt cap in `pairing.verifyCode`; WARN logs |
| CHANNELS-3/4/5 | low (unwired) | OPEN | Fail-closed owner defaults (folds into CHANNELS-1); webchat default-deny origins |
| WEB-BROWSER-6 | low | OPEN | Add `createLogger` + WARN logs to browser nav deny paths |
| TOOLS-OTHER-4 | low | OPEN | `healthcheck` → INTERNAL floor |
| TOOLS-OTHER-5 | low (unwired) | OPEN | `enforceSkillName` in skill author (pre-wiring guard) |
| MCP-PLUGIN-5 / CORE-POLICY-3 | low | OPEN | Honor `MCP_TOOL_CALL` HookResult (reject on `!allowed` + log) |
| MCP-PLUGIN-6 | low | OPEN | Reef via `createSsrfCheckedFetch` |
| AGENT-EXEC-1 | low | OPEN | Strip `Deno.env.get` fallbacks from 7 providers + gateway URL; fix JSDoc |
| AGENT-EXEC-3 | low | OPEN | Derive PRE_CONTEXT_INJECTION `source_type` from `isOwnerSession` |
| GATEWAY-2 | low | OPEN | `/debug/run-triggers` fail closed (401/503) when token absent |
| GATEWAY-3 | low | OPEN | Remove dead RPC `sessions.send` or mirror `executeSessionsSend` |
| CORE-STATE-3 | low | OPEN | Secret-redaction backstop in logger |
| CORE-STATE-4 | low | OPEN | Validate `deserialise()` taint; `bumpersEnabled ?? true` |
| INTEGRATIONS-CLI-4 | low | OPEN | Missing `run.classification` ⇒ RESTRICTED before `canFlowTo` |
| SCHEDULER-3 | low | OPEN | Delete dead `webhooks/security.ts` HMAC pair; point tests at canonical hmac |
| CORE-POLICY-4 | medium (x-ref) | OPEN | Merged into WEB-BROWSER-3/4 |
| GATEWAY-4 | low | OPEN | Fold priority router into GATEWAY-1 or delete |
| CORE-STATE-2 | low (unwired) | **GH ISSUE** | Wire gated keychain or delete — out of single-PR scope (human decision) |
| INTEGRATIONS-CLI-3 | low (unwired) | **GH ISSUE** | Delegation trust anchor before any wiring (module dead) |

### Already fixed on this branch (do NOT re-plan — verified in tree)

H1 gateway control-plane auth; H2 per-hop SSRF re-check in `safeFetch`; H4 plugin security-scan before import; H6 canvas A2UI sanitize + no unsafe-eval; H7 WhatsApp webhook HMAC + owner fail-closed; M1 validate `_classification` before taint escalation (`access_control.ts`); M2 constant-time auth-secret compare; M3 config URLs via `safeFetch` (SSE `connect()` now validates — but `send()`/redirects still open, see MCP-PLUGIN-3); M4 Google OAuth CSRF+PKCE; M7 default-deny non-owner tools w/o classification map (`access_control.ts:68-85`); M8 symlink resolution in workspace path jail; M10 adapters don't self-advertise owner at the `ChannelAdapter.isOwner` level (note: this did **not** fix the per-message fail-open — CHANNELS-1 is still open); Google Chat owner verification (`d2820462`); dead `verifyHmac` stub in `webhooks.ts` removed (`c2ecfd44` — note `security.ts` pair is a different module, still open as SCHEDULER-3).

### Disputed / severity-adjusted by verifiers (still actioned)

- CHANNELS-2: medium → **low** (latent only; wired adapters always set a boolean). Fix retained.
- INTEGRATIONS-CLI-2: medium → **low** (https remotes make `--upload-pack` inert; `Deno.Command` no shell). Fix retained as hardening.
- No findings were judged false positives; all 47 are real.

---

## Phase P0 — Critical / High

Order chosen to group same-module edits and put SSRF-core first (it is inherited by web, browser, and MCP).

### P0.1 — WEB-BROWSER-3 + WEB-BROWSER-4 + CORE-POLICY-4 — Rewrite SSRF IP parsing to byte-level ranges
- Files: `src/core/security/ssrf.ts` (the SoT; re-exported by `src/tools/web/ssrf.ts`, `src/tools/web/domains.ts`).
- Approach: Replace string-prefix IPv6 matching and the regex-only v4-mapped handling with byte-level parsing:
  - Add a `parseIpv6(ip): Uint8Array | null` that strips surrounding `[...]` brackets and expands `::`.
  - Range-check numerically: `::1/128`, `::/128`, `fc00::/7`, `fe80::/10` (second hextet 0x80–0xbf — covers the `fe90::`/`fea0::`/`febf::` gap), IPv4-mapped/compat (`::ffff:HHHH:LLLL` compressed **and** expanded, plus `::ffff:1.2.3.4` dotted) unwrapped to the embedded v4, and `64:ff9b::/96` NAT64 unwrap.
  - Extend `SSRF_DENY_CIDRS_V4` with: `100.64.0.0/10` (CGNAT), `198.18.0.0/15`, `192.0.0.0/24`, `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` (TEST-NETs), `240.0.0.0/4`, `224.0.0.0/4` (multicast), `255.255.255.255/32` (broadcast). CIDR mask math already proven correct.
  - Keep `isPrivateIp` pure/deterministic; preserve existing exports. The WARN log in `enforceIpListForSsrf` already satisfies the ±5-line rule.
- Depends on: none. Land first — inherited by web_fetch, browser, MCP, Reef.
- Tests: extend `tests/tools/web/ssrf_test.ts` (Phase A1) — property-style cases asserting `isPrivateIp` true for `::ffff:7f00:1`, `::ffff:a9fe:a9fe`, `fe90::1`, `febf::1`, `[::1]`, `100.64.0.1`, `100.127.255.255`, `198.18.0.1`, `240.0.0.1`, `224.0.0.1`, `255.255.255.255`, `192.0.2.1`, `64:ff9b::7f00:1`; and false for public IPs (`2001:4860:4860::8888`, `8.8.8.8`). Run: `deno task test tests/tools/web/ tests/core/security/`.

### P0.2 — WEB-BROWSER-1 + WEB-BROWSER-2 + WEB-BROWSER-6 — Browser SSRF interception + egress lockdown + logging
- Files: `src/tools/browser/tools/tools_navigation.ts`, `src/tools/browser/tools/tools.ts`, `src/tools/browser/manager/manager_launch.ts` (`baseChromeArgs`); possibly a new helper in `src/tools/browser/tools/` for the request-interception predicate.
- Approach:
  - Enable CDP request interception (`page.setRequestInterception(true)` / `Fetch.enable`) and, in the `request` handler, re-run `resolveAndCheck(hostname)` **and** `domainPolicy.isAllowed(url)` for **every** request — main frame, subframes, subresources, and redirect targets — `request.abort()` on failure, `request.continue()` otherwise. This closes the redirect bypass (WB-1), the subresource gap and the DNS-rebinding TOCTOU (WB-2, because validation happens at request time).
  - Defense-in-depth: after `page.goto` resolves, re-validate `page.url()` (final URL) and fail closed if the final host is blocked.
  - Egress lockdown in `baseChromeArgs`: add `--host-resolver-rules` that blocks loopback/link-local/RFC1918, or document an egress proxy. (If a full proxy is deemed pre-existing infra, interception alone satisfies the finding; note that decision inline.)
  - WB-6: add `const log = createLogger("browser-tools")`; log the domain-policy denial and the navigation block at WARN with `{ operation, hostname }` (do not log full URLs that may carry tokens). Mirrors `enforceFetchPolicy`.
- Depends on: P0.1 (uses the corrected `resolveAndCheck`).
- Tests: extend `tests/tools/browser/` (Phase A3) with a mock `page` that emits a redirect/subresource request to a private IP and asserts `abort` + a WARN log; mirror the web suite's "blocks a redirect hop resolving to a private IP". Run: `deno task test tests/tools/browser/`.

### P0.3 — MCP-PLUGIN-2 (+ MCP-PLUGIN-1 floor half) — Tool floor + path constraint on plugin install
- Files: `src/core/security/constants.ts` (`HARDCODED_TOOL_FLOORS`), `src/plugin/tools_handlers.ts` (`executePluginInstall`), `src/plugin/tools_defs.ts`.
- Approach:
  - Add `["plugin_install","RESTRICTED"]`, `["plugin_reload","RESTRICTED"]`, `["plugin_scan","RESTRICTED"]` to `HARDCODED_TOOL_FLOORS` (floors cannot be lowered by config). This forces taint escalation and makes the tools unreachable below RESTRICTED, so a prompt-injection chain in a non-RESTRICTED owner session cannot reach `import()`.
  - In `executePluginInstall`, constrain the `path` parameter to a fixed plugins root (reject absolute/`../` paths from the LLM) using `isRealPathWithinJail` from `src/core/security/path_jail.ts`; return a `Result` error on escape. Log the rejection at WARN.
  - The full runtime sandbox (MCP-PLUGIN-1) is a larger decision — see GH issue note below. The floor + path constraint is the immediate, in-scope mitigation.
- Depends on: none (floor is independent).
- Tests: extend `tests/plugin/` (Phase 8) — assert the floor is enforced (non-RESTRICTED session denied), and `plugin_install` with `../escape` path returns an error. Also add a `tests/agent/` ceiling test that a non-owner cannot reach `plugin_install`. Run: `deno task test tests/plugin/ tests/agent/`.

### P0.4 — MCP-PLUGIN-1 (runtime sandbox) — flag as GitHub issue
- Per verifier + project rule: genuinely sandboxing plugin execution (Deno Worker with restricted `deno.permissions`, or the existing-but-dead Pyodide path + capability `PluginSdk`) vs. declaring plugins trusted-and-removing the misleading "sandboxed" level is an architecture decision requiring human input and touches dead infrastructure (`src/plugin/sandbox.ts`, `python_sandbox.ts`, `sdk.ts`). **Create a GitHub issue**; do not implement the sandbox in this branch. The P0.3 floor + path constraint is the security-remediation deliverable here.

### P0.5 — SCHEDULER-1 — Webhook/cron sessions get a non-owner read ceiling
- Files: `src/scheduler/service_webhooks.ts` (`dispatchWebhookSession:144`), `src/scheduler/service_cron.ts` (`executeCronJob:94`), `src/gateway/startup/factory/orchestrator_factory.ts:203-208`, and defense-in-depth in `src/core/policy/hooks/hook_violations.ts` (`detectResourceReadCeilingViolation:62-73`).
- Approach:
  - `dispatchWebhookSession`: call `create("webhook-${sourceId}", { isTrigger: true, ceiling: classification })` so the factory attaches `isTriggerSession`/`getNonOwnerCeiling`; the source's configured classification becomes an enforced read ceiling, not just an output gate.
  - `executeCronJob`: same, using `job.classificationCeiling`.
  - Defense-in-depth (Theme T1 default-deny): in `detectResourceReadCeilingViolation`, when `is_owner === false` and `ceiling === undefined`, treat reads above PUBLIC as a violation rather than silently allowing. Keep deterministic; add a WARN log at the call site within ±5 lines.
- Depends on: none.
- Tests: `tests/scheduler/` (Phase 17) — webhook session with a CONFIDENTIAL source is blocked from reading an above-ceiling integration; `tests/core/policy/` for the read-ceiling default-deny. (Note `tests/scheduler/scheduler_test.ts` mock OrchestratorFactory already carries `toolExecutor` per `b158cdcf` — extend, don't duplicate.) Run: `deno task test tests/scheduler/ tests/core/policy/`.

### P0.6 — CHANNELS-1 (+ CHANNELS-3/4/5 fail-closed defaults) — Fail-closed owner determination
- Files: `src/channels/discord/adapter.ts:64`, `src/channels/telegram/adapter.ts:58`, `src/channels/slack/adapter.ts:75`, `src/channels/email/adapter.ts:118-124`, `src/channels/webchat/adapter.ts:67`; startup guard in `src/gateway/startup/channels/channels.ts`; wizard in `src/cli/config/prompts/prompt_discord.ts` + `src/dive/.../wizard_generators.ts`.
- Approach:
  - Adapters: when the owner identifier is undefined, treat **no** sender as owner — change Discord `ownerId !== undefined ? senderId === ownerId : true` → `ownerId !== undefined && senderId === ownerId`; Telegram `checkTelegramOwnership` `if (ownerId === undefined) return false`; same for Slack and Email (`resolveEmailOwnership`), matching the already-correct WhatsApp/Signal pattern. Prefer a shared helper (e.g. `resolveOwnerStatus(senderId, ownerId)` in `src/channels/`) so the comparison exists once.
  - Startup guard: in `wireChannels`, if an owner-bearing channel (Discord/Telegram/Slack) is enabled without an owner identifier, refuse to wire it as owner-capable (default-deny) and log a WARN; or wire non-owner-only.
  - Wizard: make the Discord owner ID mandatory, or warn loudly that a blank value means the bot answers strangers as non-owner.
  - CHANNELS-5 (webchat): default `allowedOrigins` to deny (empty) instead of `["*"]`; keep the `isOwner:false`/PUBLIC pinning.
  - Email DKIM/SPF/DMARC verification (CHANNELS-3) before wiring is a larger pre-wiring task; the fail-closed default is the in-scope change. Note the DKIM work as a follow-up in the PR body.
- Depends on: none.
- Tests: `tests/channels/` (Phase 15) — unconfigured ownerId ⇒ `isOwner:false` for Discord/Telegram/Slack/Email; webchat default origins deny. Run: `deno task test tests/channels/`.

---

## Phase P1 — Medium

### P1.1 — WEB-BROWSER-5 — Domain policy re-checked on every redirect hop
- Files: `src/core/security/safe_fetch.ts` (`safeFetchWithRedirects:94-119`, `validateOutboundUrl`), `src/tools/web/fetch.ts` (`createWebFetcher`/`fetchPageContent` call site), `src/tools/web/fetch_content.ts`, `src/tools/web/fetch_types.ts`.
- Approach: Thread an optional `isAllowed(url): boolean` (or `DomainPolicy`) predicate into `safeFetchWithRedirects` and call it inside the per-hop loop alongside `validateOutboundUrl`, failing closed when a hop violates domain policy. Wire `web_fetch` to pass `domainPolicy.isAllowed` so the configured allowlist/denylist is re-evaluated on every redirect target. Keep `Result` returns; the existing SSRF WARN logs satisfy ±5-line logging; add a WARN on a domain-policy hop denial.
- Depends on: P0.1 (shared module).
- Tests: `tests/tools/web/` (Phase A1) — allowed host 302-redirects to a non-allowlisted public host ⇒ blocked. Run: `deno task test tests/tools/web/`.

### P1.2 — MCP-PLUGIN-3 — SSE transport: per-hop SSRF on send + redirect-safe EventSource
- Files: `src/mcp/client/transport.ts` (`SSETransport.send:189-197`, `connect:154-179`).
- Approach: Replace the raw `fetch(this.#url, …)` in `send()` with `safeFetchWithRedirects` (or `createSsrfCheckedFetch`) so every POST hop is re-validated; remove the stale "no re-check needed" comment. For the receive path, either disable redirect following on the EventSource (validate the post-redirect URL) or pin to the IP validated at `connect()`. Keep the injected `urlValidator` shape (already wired by M3 in `manager_connection.ts`). The existing connect-time WARN log stays.
- Depends on: P0.1, P1.1 (uses `safeFetchWithRedirects`).
- Tests: extend `tests/mcp/client/transport_test.ts` (Phase 6) — `send()` to a host that redirects to a private IP is blocked. Run: `deno task test tests/mcp/client/`.

### P1.3 — AGENT-EXEC-2 + CORE-POLICY-2 — Fail-closed `run_command` classification
- Files: `src/core/security/command_path_extraction.ts` (`isPathLikeToken:179-196`, `tokenizeRespectingQuotes`, `extractAttachedRedirectTarget:249-256`, `splitOnShellOperators:31-80`), `src/agent/dispatch/command_classification.ts` (`classifyCommandSegment:226`).
- Approach (one structural fix covering both evasion sets):
  - Strip trailing shell metacharacters (`) ` ; & | <space>`) from extracted path tokens before classifying.
  - Split attached input-redirect tokens (`cmd<path`, `cmd<<path`) the same way attached output redirects are handled.
  - Recurse into `$( … )` and backtick spans; extract paths from their contents.
  - Fail closed: when a segment contains un-modeled substitution syntax (`$(`, backtick, `"$var"`/`$var`-only path args) or a known data-reading executable (`cat`, `dd`, `xxd`, `base64`, `curl`, `scp`, …) yields no recognizable resource, classify that segment at the configured filesystem default (`DEFAULT_PATH_CLASSIFICATION` = CONFIDENTIAL) instead of PUBLIC. Deterministic, no LLM. This raises taint so write-down/read-ceiling fire.
- Depends on: none.
- Tests: `tests/core/security/command_path_extraction_test.ts` and `tests/agent/` (Phases 2–3, 10) — assert `cat $(printf … | base64 -d)`, `f=/etc/shadow; cat "$f"`, `xxd</etc/shadow`, and `cat $(echo /etc/shadow)` classify ≥ CONFIDENTIAL (not PUBLIC), and that exact-mapped RESTRICTED files are not downgraded. Run: `deno task test tests/core/security/ tests/agent/`.

### P1.4 — CORE-POLICY-1 — Write-down detector fails closed; validate config classifications
- Files: `src/core/policy/hooks/hook_violations.ts` (`detectWriteDownViolation:16-24`; same guard in `detectResourceWriteDownViolation`, `detectResourceReadCeilingViolation`), and validation at the trust boundary in `src/channels/user_sessions.ts:118` (`parseUserOverrides`) + the four channel wirings that cast unchecked (`channels_telegram.ts`, `channels_discord.ts`, `channels_signal.ts`, `channels_googlechat.ts`).
- Approach:
  - In `detectWriteDownViolation`, treat a missing or unrecognized `target_classification` as a violation (fail closed) — drop the `target in CLASSIFICATION_ORDER` short-circuit, or invert it so unknown ⇒ block. Keep the predicate a clean boolean (hook runner already fails closed on exceptions).
  - Validate `user_classifications`/`channelDefault` via `parseClassification` at load time and reject (or coerce to the most restrictive) on parse failure, matching WhatsApp's existing validation. Add a WARN on rejection.
- Depends on: none.
- Tests: `tests/core/policy/` (Phases 2–3) — `target_classification` undefined or typo (`CONFIDENTAL`) ⇒ BLOCK for a higher-tainted non-owner; valid level behaves unchanged. Run: `deno task test tests/core/policy/`.

### P1.5 — GATEWAY-1 (+ GATEWAY-4) — Notification fan-out write-down gate
- Files: `src/core/types/notification.ts` (`DeliveryChannel:35-38`), `src/gateway/notifications/notifications.ts` (`fanOut:84-90`, `deliver`, `registerChannel`, `flushPending`), all `registerChannel` sites (`channels_telegram.ts`, `channels_googlechat.ts`, `channels_whatsapp.ts`, `channels_signal.ts`, `chat_session_network.ts` tidepool+cli), and the **stale-taint** source (`orchestrator_factory.ts:186-188` / scheduler deliver sites `service_output.ts`).
- Approach:
  - Add `readonly classification: ClassificationLevel` to `DeliveryChannel`; set it at every `registerChannel(...)` from the same classification already computed for the adapter.
  - In `fanOut`, skip any channel where `!canFlowTo(notification.classification ?? sessionTaint, channel.classification)`; log the suppressed write-down at WARN (±5-line rule).
  - Default a missing notification classification to the session taint at the call site (fail closed), and fix the stale-taint read flagged by the verifier — expose the live `getSessionTaint` from the factory (or return final taint from the turn) so `notification.classification` is not always PUBLIC; otherwise the gate is a no-op. `healing_orchestrator.ts` delivers with undefined classification — must fail closed.
  - GATEWAY-4: either fold `priority_router.ts` into `deliver` (so dedup/priority actually govern fan-out, combinable with this gate) or delete the dead module. Prefer delete unless the team wants the behavior; note in PR.
- Depends on: none. (Touches the same notification module as GATEWAY-4 — do together.)
- Tests: `tests/gateway/` incl. `notifications_test.ts` (Phase 14) — a CONFIDENTIAL notification is suppressed for a PUBLIC/INTERNAL channel and logged; owner-equivalent channels still deliver. Run: `deno task test tests/gateway/`.

### P1.6 — CORE-STATE-1 — SQLite `list()` literal prefix
- Files: `src/core/storage/sqlite.ts:54,66,99`.
- Approach: Make SQLite match a literal prefix. Either escape LIKE metacharacters and add `ESCAPE '\\'` with `prefix.replace(/[\\%_]/g, "\\$&") + "%"`, or use a range scan `WHERE key >= ? AND key < ?` binding `prefix` and `prefix + "￿"` (no escaping needed). Preserve the `list()` contract.
- Depends on: none.
- Tests: add a **shared StorageProvider conformance test** asserting identical `list()` results from memory and SQLite for prefixes containing `_` and `%` — `tests/core/storage/` (Phase 4). Run: `deno task test tests/core/storage/`.

### P1.7 — TOOLS-OTHER-1 — SSH host option-injection
- Files: `src/tools/ssh/ssh_executor.ts` (`executeSshExecute`), `src/tools/ssh/ssh_session.ts` (`openSession`), `src/tools/ssh/ssh_args.ts` (`buildBaseArgs`, `buildExecuteArgs:85`, `buildSessionArgs:73`).
- Approach: Reject a `host` that begins with `-` (and ideally validate `[user@]hostname[:port]`) in the executors, returning a `Result`/error string; log the rejection at WARN. Defensively add `-o PermitLocalCommand=no` in `buildBaseArgs`. (Note `buildSessionArgs` pushes host with no `--` at all — the leading-dash guard is the load-bearing fix for both paths.)
- Depends on: none.
- Tests: SSH suite under `tests/tools/` — host `-oProxyCommand=…` rejected for both execute and session-open. Run: `deno task test tests/tools/` (SSH path) plus `deno task check`.

### P1.8 — TOOLS-OTHER-2 — Obsidian query/outlinks vault confinement
- Files: `src/tools/obsidian/notes/note_walker.ts:22`, `src/tools/obsidian/notes/note_query.ts:61,86`, `src/tools/obsidian/links.ts:161` (`findVaultOutlinks`), `src/tools/obsidian/tools/tools.ts` (`obsidian_search`/`obsidian_list`/`obsidian_links` outlinks).
- Approach: Route the `folder` parameter (search/list) and `notePath` (outlinks) through `resolveVaultPath` before walking/reading, rejecting any path that escapes the vault. Add `canFlowTo(noteClassification, sessionTaint)` to `obsidian_links` outlinks reads. Defense-in-depth: have `walkNotes`/`walkMdFiles` assert each `entry.path` still begins with `ctx.realVaultPath + SEPARATOR` before yielding.
- Depends on: none.
- Tests: `tests/tools/obsidian/` (Phase B3) — `folder: "../../etc"` and `obsidian_links(note: "../../etc/hosts", outlinks)` rejected. Run: `deno task test tests/tools/obsidian/`.

### P1.9 — TOOLS-OTHER-3 + TOOLS-OTHER-4 — Reclassify `log_read` and `healthcheck` to INTERNAL
- Files: `src/core/security/constants.ts` (`HARDCODED_TOOL_FLOORS`); optionally update the PUBLIC entries in `src/agent/orchestrator/classification_map.ts:85,90`.
- Approach: Add `["log_read","INTERNAL"]` and `["healthcheck","INTERNAL"]` to `HARDCODED_TOOL_FLOORS` (floors cannot be lowered by config, the strongest place). A PUBLIC non-owner ceiling can no longer reach either tool. Align `healthcheck` with its own module docstring.
- Depends on: none. (Same file as P0.3 — batch the `HARDCODED_TOOL_FLOORS` edits.)
- Tests: `tests/agent/` ceiling tests (Phase 10) — explicit-PUBLIC non-owner denied `log_read`/`healthcheck`; INTERNAL+ allowed. Run: `deno task test tests/agent/ tests/tools/`.

### P1.10 — INTEGRATIONS-CLI-1 + INTEGRATIONS-CLI-2 — GitHub clone/pull jail + branch validation
- Files: `src/integrations/github/tools.ts` (`resolveLocalPathInput:126-135`), `src/integrations/github/repos/tools_repos.ts` (`:281-338`), `src/integrations/github/repos/client_repos_git.ts` (`buildCloneArgs:32-42`, `buildPullArgs:158-166`).
- Approach:
  - After `join(workspacePath, path)`, enforce `isRealPathWithinJail(resolved, workspacePath)` (from `src/core/security/path_jail.ts`) and reject escapes, mirroring `x/posts/posts_media.ts`. Require `ctx.workspacePath` to be set for clone/pull (fail closed when absent rather than using the raw path). Return a `Result` error; log denial at WARN.
  - Route `branch` through the existing `assertValidBranchName` (`tools_shared.ts`) in `cloneGitHubRepository`/`pullGitHubRepository`, and insert a `--` end-of-options separator before positional args in `buildCloneArgs`/`buildPullArgs`.
- Depends on: none.
- Tests: GitHub tests live in `tests/integrations/github/` — add traversal-`path` rejection and `--`-prefixed branch rejection there. Run: `deno task test tests/integrations/`.

### P1.11 — SCHEDULER-2 — Bind timestamp into HMAC + persistent replay guard
- Files: `src/scheduler/webhooks/webhooks.ts` (`verifyHmacAsync`/signer), `src/scheduler/service_webhooks.ts:80-104`, `src/scheduler/webhooks/replay_guard.ts:31-45`, `src/gateway/startup/factory/scheduler_config.ts` (plumb `maxAgeMs`/`replayGuardSize`).
- Approach: Sign and verify over `timestamp + "." + body` so the freshness window actually constrains a captured signature (the verifier notes the unauthenticated timestamp currently provides no replay protection). Persist seen signatures (or nonce+timestamp tuples) via `StorageProvider` so the guard survives daemon restarts within the freshness window (project rule: no raw `Map` for restart-surviving security data). Plumb `maxAgeMs`/`replayGuardSize` from YAML. For senders that can only sign the body (e.g. GitHub), make the persistent nonce store the primary control. Keep `Result` returns; existing WARN logs stay.
- Depends on: none. (Same module as SCHEDULER-1 and SCHEDULER-3 — batch scheduler edits.)
- Tests: `tests/scheduler/` (Phase 17) — replayed `(body, signature)` with a fresh timestamp is rejected (signature now covers timestamp); persisted guard rejects post-restart replay. Run: `deno task test tests/scheduler/`.

---

## Phase P2 — Low / Hardening

Grouped by module to minimize churn.

### P2.1 — CHANNELS-2 — Owner routing on strict `=== true`
- Files: `src/gateway/chat_channel_routing.ts:102`, `src/gateway/startup/channels/channels_discord.ts:51,61`, `src/gateway/startup/channels/channels_telegram.ts:71,81` (and the doc comment in `chat_session_interface.ts:46`).
- Approach: Replace `msg.isOwner !== false` with `msg.isOwner === true` everywhere, matching the WhatsApp/Google Chat form. Default-deny: owner requires a positive `true`.
- Tests: `tests/gateway/` / `tests/channels/` — a message with `isOwner: undefined` routes to the non-owner path. Run: `deno task test tests/gateway/ tests/channels/`.

### P2.2 — CHANNELS-6 — WhatsApp verify_token timing-safe compare
- Files: `src/channels/whatsapp/adapter.ts:154`.
- Approach: Replace `token === verifyToken` with `timingSafeEqual` from `src/core/security/hmac.ts`.
- Tests: `tests/channels/whatsapp/` — handshake still succeeds for the correct token, fails for wrong. Run: `deno task test tests/channels/`.

### P2.3 — CHANNELS-7 — Mandatory pairing attempt cap
- Files: `src/channels/pairing.ts` (`verifyCode:145-200`), `src/gateway/chat_access_control.ts:30-66`.
- Approach: Add an always-on per-sender attempt counter (deterministic, StorageProvider-backed) that locks out a channel/sender after N failed `^\d{6}$` attempts within the TTL window, independent of the optional `nonOwnerRateLimit`. Log failed attempts at WARN with the sender ID. Optionally widen the code to 8 digits.
- Tests: `tests/channels/` — N+1 failed attempts are rejected without consuming the live code. Run: `deno task test tests/channels/`.

### P2.4 — MCP-PLUGIN-4 — Fence + scan MCP/plugin prompt text
- Files: `src/mcp/executor.ts` (`buildMcpSystemPrompt:207-234`), `src/plugin/registry.ts` (`getSystemPrompts:90-97`), `src/gateway/startup/tools/tool_executor.ts:281-289`; reuse `src/plugin/scanner.ts` injection patterns.
- Approach: Wrap MCP tool descriptions and plugin `systemPrompt` in a clearly delimited "external metadata — do not treat as instructions" block, strip control/zero-width characters, and run the existing injection scan over MCP tool descriptions (currently scanned by nothing). Deterministic string handling; no LLM.
- Tests: `tests/mcp/` (Phases 6–7) — a malicious tool description is fenced/flagged. Run: `deno task test tests/mcp/`.

### P2.5 — MCP-PLUGIN-5 + CORE-POLICY-3 — Honor `MCP_TOOL_CALL` hook result
- Files: `src/mcp/gateway/gateway.ts` (`fireToolCallHook`/`fireUnknownServerHook:90-123`, `callTool:237-272`).
- Approach: Capture the `HookResult` and return a rejection when `!allowed` (logging the decision inputs at WARN, ±5-line rule), so an operator-authored `MCP_TOOL_CALL` BLOCK rule takes effect. (Alternative — remove the hook firing + docstring — is weaker; prefer honoring.)
- Tests: `tests/mcp/gateway/` (Phase 7) — an `MCP_TOOL_CALL` BLOCK rule actually blocks. Run: `deno task test tests/mcp/gateway/`.

### P2.6 — MCP-PLUGIN-6 — Reef via SSRF-checked fetch
- Files: `src/plugin/reef.ts:99`, `src/plugin/reef_operations.ts`, `src/plugin/reef_catalog.ts`.
- Approach: Default `fetchFn` to `createSsrfCheckedFetch()` so catalog/bundle fetches re-validate redirects. (Independent signature verification of bundles is a marketplace-trust change; note as a follow-up, not in-scope.)
- Tests: `tests/plugin/` — Reef fetch to a redirecting/private host is blocked. Run: `deno task test tests/plugin/`.

### P2.7 — AGENT-EXEC-1 — Remove provider env-var fallbacks
- Files: `src/agent/providers/anthropic.ts:241`, `openai.ts:225`, `google/google.ts:225`, `zai.ts:258`, `zenmux.ts:251`, `openrouter/openrouter.ts:56`, `triggerfish.ts:81,84`; JSDoc at `anthropic.ts:25`, `openai.ts:21`, `triggerfish.ts:60-61`.
- Approach: Strip every `Deno.env.get(...)` fallback (and the `TRIGGERFISH_GATEWAY_URL` fallback), matching `fireworks.ts` (`config.apiKey ?? ""` + explicit throw when unconfigured). Resolve credentials only from `triggerfish.yaml`/keychain refs. Fix the stale JSDoc that advertises env fallback.
- Tests: `tests/agent/` provider tests (Phase 10) — provider throws a clear "not configured" error when no `config.apiKey`. Run: `deno task test tests/agent/`.

### P2.8 — AGENT-EXEC-3 — Derive PRE_CONTEXT_INJECTION source_type
- Files: `src/agent/loop/agent_turn.ts` (`firePreContextHook:34-51`).
- Approach: Derive `source_type` from `config.isOwnerSession?.()` — `OWNER` only when true, otherwise a non-owner/untrusted value — instead of the hardcoded `"OWNER"`. Restores the inbound-trust gate.
- Tests: `tests/agent/` (Phase 10) — a non-owner turn no longer labels content `OWNER`. Run: `deno task test tests/agent/`.

### P2.9 — GATEWAY-2 — Debug endpoint fails closed
- Files: `src/gateway/server/server.ts` (`handleDebugTriggerEndpoint:101-117`).
- Approach: When `options.token` is absent, return 401/503 instead of logging "proceeding" and firing the trigger. Default-deny.
- Tests: `tests/gateway/server_test.ts` (Phase 14) — token-less debug request is rejected. Run: `deno task test tests/gateway/`.

### P2.10 — GATEWAY-3 — Remove/fix dead RPC `sessions.send`
- Files: `src/gateway/sessions.ts` (`sessionsSend:123-149`), `src/gateway/server/handlers_rpc.ts:117-140`.
- Approach: Prefer removing the unused JSON-RPC `sessions.send` surface. If retained, derive the classification from the resolved target session (`target.taint`, not the caller value) and actually deliver, mirroring `executeSessionsSend`. (Verifier note: the agent-tool path shares the same no-op `sessionsSend`; if delivery is wired later it must derive from `target.taint`.)
- Tests: `tests/gateway/` — removed surface returns method-not-found, or the fixed surface uses target taint. Run: `deno task test tests/gateway/`.

### P2.11 — CORE-STATE-3 — Logger secret-redaction backstop
- Files: `src/core/logger/logger.ts` (`formatLine:96-99`, `dispatchLogLine:120-130`).
- Approach: Add a `redactSecrets(value)` pass in the structured-arg path that deep-walks args and masks values whose key matches `/secret|token|password|api[_-]?key|authorization|cookie|client_token|secret_id/i` and masks bearer-like high-entropy strings. Complements (does not replace) per-call-site discipline; leave the audit log raw by design.
- Tests: `tests/core/` logger tests — an object with `apiKey`/`Authorization` logs masked. Run: `deno task test tests/core/`.

### P2.12 — CORE-STATE-4 — Validate `deserialise()`
- Files: `src/core/session/manager.ts` (`deserialise:68-80`).
- Approach: Coerce `bumpersEnabled: data.bumpersEnabled ?? true` (secure default), and validate `taint` via `parseClassification`, rejecting/failing-closed on an invalid level. Optionally validate `history` entry shapes.
- Tests: `tests/core/session/` (Phase 4) — a record missing `bumpersEnabled` deserializes with bumpers ON; invalid taint rejected. Run: `deno task test tests/core/session/`.

### P2.13 — INTEGRATIONS-CLI-4 — Workflow-run store fails closed
- Files: `src/workflow/store.ts` (`loadRun:158-176`, `listRuns:178-208`).
- Approach: Treat a missing `run.classification` as the most restrictive level (default to `RESTRICTED`) before the `canFlowTo` check, so an unclassified run is never read down. Mirror in `listRuns`.
- Tests: workflow store tests — an undefined-classification run is not returned to a lower-taint reader. Run: `deno task test` for the workflow tests path.

### P2.14 — TOOLS-OTHER-5 — Skill author name validation (pre-wiring guard)
- Files: `src/tools/skills/author.ts` (`normalizeSkillCreateOptions:143`, `executeSkillCreation`/`:176`).
- Approach: Call `enforceSkillName(opts.name)` at the top of `executeSkillCreation` and return its error on failure, mirroring `registry_install.ts`. Module is currently dead/unwired — this is a guard added before it is ever wired.
- Tests: `tests/tools/skills/` (Phase 20) — `name: "../../x"` rejected. Run: `deno task test tests/tools/skills/`.

### P2.15 — SCHEDULER-3 — Delete dead duplicate HMAC pair
- Files: `src/scheduler/webhooks/security.ts` (`signWebhook`/`verifyWebhookSignature:26-85`), barrel exports `src/scheduler/webhooks/mod.ts`, `src/scheduler/mod.ts`; tests `tests/scheduler/webhook_security_test.ts`.
- Approach: Remove the unused `signWebhook`/`verifyWebhookSignature` and their barrel exports; route any signing/verification through the canonical `verifyHmacSha256` in `src/core/security/hmac.ts` (the live path already uses `verifyHmacAsync`). Repoint the tests at the canonical primitive. In-scope per the verifier (touches only scheduler-domain files already under review).
- Tests: `tests/scheduler/` (Phase 17). Run: `deno task test tests/scheduler/`.

---

## Findings deferred to GitHub issues (per project "unrelated/dead infrastructure" rule)

- **CORE-STATE-2** — Wire the gated keychain (`createGatedKeychain`/`createSecretAccessGate`/`createDefaultSecretAccessRules` + live `getSessionTaint`/`getIsBackground`) into the orchestrator secret path, OR delete the dead modules. The factory already carries an explicit "NEVER create a gated keychain here" comment for integration executors, so this is a deliberate architecture decision out of single-PR scope. **GH issue.**
- **INTEGRATIONS-CLI-3** — Delegation chain has no trust anchor (`verifyDelegationChain` validates self-embedded keys only). Module has zero production consumers; would be critical if wired. Require a trusted-root-key set before any wiring, or delete. **GH issue.**
- **MCP-PLUGIN-1 (runtime sandbox half)** — see P0.4. The capability/Worker/Pyodide sandbox decision and removal of dead `sandbox.ts`/`python_sandbox.ts`/`sdk.ts` is human-gated. **GH issue.** (The RESTRICTED floor + path constraint in P0.3 ships in this branch.)

---

## Final verification gate (run before completing the branch)

1. `deno task fmt` then `deno task lint` — must be clean (no `console.*`, no `any`).
2. `deno task check` — type-check `src/mod.ts` + `src/cli/main.ts`.
3. Full targeted test sweep across every touched phase path:
   `deno task test tests/core/security/ tests/core/policy/ tests/core/session/ tests/core/storage/ tests/tools/web/ tests/tools/browser/ tests/tools/obsidian/ tests/tools/skills/ tests/tools/ tests/mcp/ tests/plugin/ tests/agent/ tests/gateway/ tests/channels/ tests/scheduler/ tests/integrations/`
4. Spot-confirm each new security branch logs at WARN+ with `{ operation, … }` within ±5 lines (serviceability rule), and that every new fallible path returns `Result` rather than throwing.

## Critical files for implementation

- `src/core/security/ssrf.ts` — SSRF denylist SoT (WEB-BROWSER-3/4, CORE-POLICY-4; inherited by web/browser/MCP/Reef).
- `src/core/security/constants.ts` — `HARDCODED_TOOL_FLOORS` (MCP-PLUGIN-2 plugin floor, TOOLS-OTHER-3/4 log_read/healthcheck).
- `src/core/policy/hooks/hook_violations.ts` — write-down/read-ceiling detectors (CORE-POLICY-1, SCHEDULER-1 default-deny).
- `src/core/security/command_path_extraction.ts` — `run_command` path tokenizer (AGENT-EXEC-2 / CORE-POLICY-2).
- `src/scheduler/service_webhooks.ts` + `src/gateway/startup/factory/orchestrator_factory.ts` — webhook/cron ceiling wiring and notification taint (SCHEDULER-1/2, GATEWAY-1).
