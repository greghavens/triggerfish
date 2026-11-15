# Triggerfish Security Remediation Plan — WORKING DRAFT

> Status: IN PROGRESS — auditor/verifier agents still writing. This draft is updated
> incrementally as findings land. Final output: REMEDIATION_PLAN.md.
> Date: 2026-06-10. Branch under audit: master (whole codebase, not diff).

## Intake Tracker

| Domain | findings/ received | verified/ received | integrated |
|---|---|---|---|
| core-policy | YES (4 findings; #4 = cross-ref of WB-3/4) | no | staged |
| core-state | YES (4 findings) | no | staged |
| channels | YES (7 findings) | YES — all real; C2 med→low | CONFIRMED |
| gateway | YES (4 findings) | no | staged |
| web-browser | YES (6 findings) | YES — all 6 real | CONFIRMED |
| tools-other | YES (5 findings) | no | staged |
| scheduler | YES (3 findings) | no | staged |
| mcp-plugin | YES (6 findings) | YES — all 6 real, sev held | CONFIRMED |
| agent-exec | YES (3 findings) | YES — all 3 real, sev held | CONFIRMED |
| integrations-cli | YES (4 findings) | no | staged |

## Grounding: invariants any fix must honor (.claude/rules/security.md)

1. Deterministic enforcement — pure-function hooks, no LLM in policy path.
2. Taint only escalates; session state immutable (return new objects).
3. No write-down (canFlowTo); memory classification forced to session taint.
4. Default DENY for unclassified tools/integrations/paths/channels.
5. SSRF: DNS-resolve then hardcoded IP denylist on ALL outbound HTTP; not configurable.
6. Resource classification gates execution (resource > domain classifier > integration prefix > fs default).
7. Result<T,E> not thrown exceptions; no `any`; no env-var fallbacks for API keys.
8. Single source of truth for domain security config: src/tools/web/domains.ts.
9. Secrets in OS keychain or env, never config files; Gateway WS never public without auth.
10. Audit logging: security decisions logged WARN+ with structured context.

## Fix-Surface Map (verified against working tree)

- Policy hooks: `src/core/policy/hooks/` (hook_runner.ts, hooks.ts, default_rules.ts, secret_access_hook.ts); engine at `src/core/policy/engine.ts`; audit at `src/core/policy/audit/` (HMAC-signed).
- Security primitives: `src/core/security/` — ssrf.ts, safe_fetch.ts (canonical; `src/tools/web/{ssrf,safe_fetch}.ts` are clean re-exports), hmac.ts, websocket_auth.ts, path_jail.ts, path_sanitization.ts, path_classification*.ts, command_path_extraction.ts, tool_floors.ts.
- Session/taint: `src/core/session/` — taint.ts, manager.ts, lineage*.ts, retention.ts, bumpers.ts.
- Domain SoT: `src/tools/web/domains.ts` + classifier.ts, policy.ts.
- Gateway surface: `src/gateway/server/` — server.ts, handlers.ts, handlers_rpc.ts, handlers_chat.ts, handlers_webhook.ts.
- Orchestrator tool gate: `src/agent/orchestrator/` — orchestrator.ts, classification_map.ts (+ tool_behavior_prompt.ts which is DO-NOT-TOUCH).
- Test roots match phase table: tests/core/{policy,security,session,storage}, tests/tools/web, tests/gateway, tests/channels, tests/scheduler, tests/mcp, tests/plugin, tests/agent, tests/exec, tests/integrations/google, tests/log_poisoning.

## Domain → source → phase-test map (for remediation items)

| Audit domain | Source roots | Test path (phase) |
|---|---|---|
| core-policy | src/core/policy/, src/core/security/ | tests/core/policy/ tests/core/security/ (Ph 2–3) |
| core-state | src/core/session/, src/core/storage/, src/core/secrets/ | tests/core/session/ tests/core/storage/ (Ph 4–5), tests/secrets/ |
| channels | src/channels/ | tests/channels/ (Ph 15–16) |
| gateway | src/gateway/ | tests/gateway/ (Ph 14) |
| web-browser | src/tools/web/, src/tools/browser/ | tests/tools/web/ (A1), tests/tools/browser/ (A3) |
| tools-other | src/tools/{memory,skills,todo,obsidian,tidepool,...} | tests/tools/memory/ (A2), tests/tools/skills/ (20), tests/tools/obsidian/ (B3) |
| scheduler | src/scheduler/ | tests/scheduler/ (Ph 17) |
| mcp-plugin | src/mcp/, src/plugin/ | tests/mcp/ (Ph 6–7), tests/plugin/ (Ph 8) |
| agent-exec | src/agent/, src/exec/ | tests/agent/ (Ph 10), tests/exec/ (Ph 11) |
| integrations-cli | src/integrations/, src/cli/ | tests/integrations/google/ (B1), tests/cli/ (Ph 13) |

## Prior remediation already landed on this branch (do NOT re-plan; check duplicates)

H1 gateway control-plane auth (token + Origin allowlist) · H2 SSRF re-check per redirect hop ·
H4 plugin security-scan before import · H6 canvas A2UI HTML/SVG sanitize, no unsafe-eval ·
H7 WhatsApp webhook HMAC + owner fail-closed · M1 validate untrusted _classification before
taint escalation · M2 constant-time auth-secret compare · M3 config URLs via safeFetch ·
M4 OAuth CSRF state + PKCE · M7 default-deny non-owner tools w/o classification map ·
M8 symlink resolution in workspace path jail · M10 adapters don't self-advertise owner ·
plus Google Chat owner verification (d2820462), dead verifyHmac stub removal (c2ecfd44).

## 1. Executive Summary (to finalize)

_Pending findings._

## STAGING — findings received, AWAITING VERIFIER VERDICT

### web-browser (6)
| ID | Sev (auditor) | Location | Issue |
|---|---|---|---|
| WEB-BROWSER-1 | high | src/tools/browser/tools/tools_navigation.ts:62-85, tools.ts:72-85 | Browser `page.goto` follows 3xx internally; SSRF check only on initial hostname — redirect to metadata/private IP fetched. No request interception. |
| WEB-BROWSER-2 | high | tools_navigation.ts:40-57, manager/manager_launch.ts:29-45 | DNS rebinding (validate-then-Chrome-re-resolves TOCTOU) + subresources/page-JS fetches have zero SSRF checks; no host-resolver-rules/egress proxy. |
| WEB-BROWSER-3 | medium | src/core/security/ssrf.ts:77-117 | Compressed IPv4-mapped IPv6 (`::ffff:7f00:1`) classified public — bypasses denylist (dotted + expanded forms handled, compressed not). Verified empirically. |
| WEB-BROWSER-4 | medium | src/core/security/ssrf.ts:19-43 | Denylist missing 100.64/10 (CGNAT), 198.18/15, 240/4, 224/4, TEST-NETs, broadcast; IPv6 matched by string prefixes (no NAT64 64:ff9b::/96). |
| WEB-BROWSER-5 | medium | src/tools/web/fetch.ts:48-77 + core safe_fetch.ts:94-120 | Domain allowlist/denylist enforced only on initial URL; redirect hops only re-check SSRF, not domain policy — egress allowlist bypass. |
| WEB-BROWSER-6 | low | tools_navigation.ts:40-57 | Browser nav deny paths (domain policy, SSRF) unlogged — violates audit-everything/serviceability (WARN+ on denials). |

Auditor's verified-safe notes: IPv4 CIDR math correct; IP-literals fail closed via resolveDns; per-hop Request-input rejection good; profile watermark escalation-only; search providers fixed-endpoint; CDP bound to 127.0.0.1.

Remediation shape (draft, pending verdicts):
- WB-1+WB-2 share one structural fix: CDP request interception re-running resolveAndCheck + domainPolicy.isAllowed on EVERY request (main frame + subresource + redirect), abort on fail; optionally egress lockdown via --host-resolver-rules/proxy. Theme T3.
- WB-3+WB-4 are one fix: rewrite isPrivateIp to parse IPs to bytes/ints and range-check numerically (expand `::`), add missing CIDRs + NAT64 unwrap; property-based tests. Theme T3 (denylist completeness). Fix in core/security/ssrf.ts — automatically inherited by web_fetch, browser, and anything using safeFetch.
- WB-5: thread DomainPolicy predicate into safeFetchWithRedirects per-hop validation. Theme T3/T7.
- WB-6: add WARN logging to browser nav deny paths. Theme T8 (observability).

### channels (7)
| ID | Sev (auditor) | Location | Issue |
|---|---|---|---|
| CHANNELS-1 | high | discord/adapter.ts:64, telegram/adapter.ts:56-58, cli prompt_discord.ts:47-61 | ownerId unconfigured ⇒ EVERY sender is owner (full tool set incl. run_command/secrets). Discord wizard omits ownerId when blank — reachable via supported onboarding. |
| CHANNELS-2 | medium | gateway/chat_channel_routing.ts:102, channels_telegram.ts:71/81, channels_discord.ts:51/61 | Owner routing via `isOwner !== false` — undefined promoted to owner. Latent fail-open (CLI simulateInput emits no isOwner). |
| CHANNELS-3 | low (unwired) | email/adapter.ts:118-124 | Owner from spoofable From: header, no DKIM/SPF/DMARC; same undefined⇒owner default. Email not wired into runtime. |
| CHANNELS-4 | low (unwired) | slack/adapter.ts:75 | Same fail-open owner default; Slack unwired today, high if ever enabled. |
| CHANNELS-5 | low (unwired) | webchat/adapter.ts:67-73 | Default CORS `["*"]`, no upgrade auth; mitigated by hard-pinned isOwner:false + PUBLIC taint. |
| CHANNELS-6 | low | whatsapp/adapter.ts:150-158 | Webhook subscription verify_token compared with `===` (not timing-safe); per-message HMAC is correct. |
| CHANNELS-7 | low | pairing.ts:145-200, chat_channel_routing.ts:116-135 | 6-digit pairing code brute-forceable when optional nonOwnerRateLimit absent; grants non-owner classification ceiling only. |

Auditor's verified-safe notes: Google Chat owner verification solid (API re-fetch, replay guard); HMAC raw-body constant-time correct; taint monotonic in non-owner turns; Signal pinned non-owner; outbound SSRF covered in adapters; router doc comment overstates (claims classification checks it doesn't do — enforcement is one layer up).

Remediation shape (draft, pending verdicts):
- CHANNELS-1+2+3+4 = ONE structural fix (Theme T4/T1): centralize owner determination fail-closed. (a) all adapters: `ownerId undefined ⇒ isOwner=false`; (b) all gateway routing: `isOwner === true` strict; (c) startup validation: owner-bearing channel without ownerId ⇒ refuse to wire (default deny) or wire as non-owner-only with WARN; (d) wizard: make Discord owner ID mandatory or warn. Candidate: shared helper in core (e.g. resolveOwnerStatus) so the comparison exists once.
- CHANNELS-6: swap `===` → timingSafeEqual from core/security/hmac.ts (one-liner).
- CHANNELS-7: always-on attempt cap in pairing.verifyCode (deterministic, storage-backed), WARN logs on failures.
- CHANNELS-5: default allowedOrigins to deny (empty) — default-deny invariant; keep pinning.

### mcp-plugin (6)
| ID | Sev (auditor) | Location | Issue |
|---|---|---|---|
| MCP-PLUGIN-1 | high | plugin/sandboxed_executor.ts:49-97, loader.ts:191-210 | No runtime sandbox: "sandboxed" trust = try/catch around full-privilege execution; real sandbox primitives (createSandbox/Pyodide/SDK caps) exported but never wired; even createSandbox is bypassable (globalThis.Deno). |
| MCP-PLUGIN-2 | high | plugin/tools_defs.ts:20-37, tools_handlers.ts:96-182, scanner.ts | plugin_install LLM tool → await import() RCE; no tool floor for plugin_*; regex scanner bypassed by bracket access/aliasing; top-level code runs on import. Prompt-injection → RCE chain. |
| MCP-PLUGIN-3 | medium | mcp/client/transport.ts:143-202 | SSE transport: EventSource follows redirects natively, send() uses raw fetch redirect:follow; one-time URL validation; DNS rebinding window. Violates SSRF invariant #7. |
| MCP-PLUGIN-4 | medium | mcp/executor.ts:207-234, plugin/registry.ts:90-97 | MCP tool descriptions (wire-supplied) + plugin systemPrompt injected verbatim into agent system prompt; MCP path not injection-scanned at all. |
| MCP-PLUGIN-5 | low | mcp/gateway/gateway.ts:108-123,237-272 | MCP_TOOL_CALL HookResult discarded — latent fail-open if operator adds BLOCK rule; deny that doesn't deny. Currently inert (PRE_TOOL_CALL + status check gate independently). |
| MCP-PLUGIN-6 | low | plugin/reef.ts:94-100, reef_catalog.ts, reef_operations.ts | Reef uses raw fetch (no per-hop SSRF); checksum verified against catalog from same origin (no independent signature). |

Auditor's verified-safe notes: unclassified MCP servers default-denied (UNTRUSTED rejected); classified MCP calls gated via mcp_<id>_ prefix in PRE_TOOL_CALL; taint escalates per call with ceiling cap; _classification parsed/validated.

### scheduler (3)
| ID | Sev (auditor) | Location | Issue |
|---|---|---|---|
| SCHEDULER-1 | high | scheduler/service_webhooks.ts:143-151, service_cron.ts:94-101, gateway orchestrator_factory.ts:203-208, core hook_violations.ts:62-73 | Webhook (and cron) sessions created WITHOUT isTrigger/ceiling ⇒ read-ceiling rule silently skipped (ceiling undefined ⇒ violation false); webhook source classification gates OUTPUT only. Attacker w/ shared secret injects prompt; cronJob profile reads owner integrations up to RESTRICTED. No default-deny for is_owner:false without ceiling. |
| SCHEDULER-2 | medium | scheduler/webhooks/replay_guard.ts:31-45, service_webhooks.ts:80-104 | Replay guard in-memory only (Map, no StorageProvider); timestamp NOT bound into HMAC (body-only signature) ⇒ post-restart replay with fresh x-timestamp. maxAgeMs/replayGuardSize not plumbed from YAML. |
| SCHEDULER-3 | low | scheduler/webhooks/security.ts:26-85 | Dead duplicate HMAC sign/verify pair exported from barrel, unused in production (only tests); diverges from canonical core/security/hmac.ts. |

Remediation shape (draft, pending verdicts):
- MCP-PLUGIN-1+2 are a pair (Theme: trust boundary): real decision needed — sandbox (Deno Worker w/ restricted perms or Pyodide path + capability SDK) vs declare plugins trusted-only + remove "sandboxed" level + RESTRICTED tool floor on plugin_install/plugin_reload + constrain path to plugins root + owner confirmation. Floor fix is cheap and immediate (core/security/constants.ts HARDCODED_TOOL_FLOORS); sandbox decision likely needs human input.
- MCP-PLUGIN-3 + MCP-PLUGIN-6 + (WEB-BROWSER-1/2 browser path) = same theme T3: every outbound HTTP surface must go through safeFetch/createSsrfCheckedFetch. Inventory all raw fetch/EventSource users; replace.
- MCP-PLUGIN-4: fence + scan MCP tool descriptions (reuse plugin injection scanner); delimited "external metadata" block.
- MCP-PLUGIN-5: honor or remove MCP_TOOL_CALL hook result (prefer honor: act on !allowed + log).
- SCHEDULER-1: pass `{ isTrigger: true, ceiling: classification }` in dispatchWebhookSession + executeCronJob (use job.classificationCeiling); PLUS defense-in-depth default-deny in detectResourceReadCeilingViolation when is_owner:false && ceiling undefined (Theme T1 — this is THE default-deny gap pattern).
- SCHEDULER-2: sign `timestamp + "." + body`; persist replay guard via StorageProvider (project rule: no raw Map for restart-surviving data).
- SCHEDULER-3: delete dead pair, point tests at core/security/hmac.ts (Theme T7).

### agent-exec (3)
| ID | Sev (auditor) | Location | Issue |
|---|---|---|---|
| AGENT-EXEC-1 | low | providers anthropic.ts:241, openai.ts:225, google.ts:225, zai.ts:258, zenmux.ts:251, openrouter.ts:56, triggerfish.ts:81/84 | 7 providers keep Deno.env.get API-key fallbacks (and TRIGGERFISH_GATEWAY_URL redirect) — violates absolute "config-only" platform rule; fireworks.ts is the compliant reference. |
| AGENT-EXEC-2 | medium | agent/dispatch/command_classification.ts:181-240, core command_path_extraction.ts:179-217 | run_command resource classification evaded by `$(...)`, `"$var"`, base64 paths — unrecognized segment ⇒ PUBLIC, gate never fires. Inherent static-parse limit; needs fail-closed handling. |
| AGENT-EXEC-3 | low | agent/loop/agent_turn.ts:34-51 | PRE_CONTEXT_INJECTION hardcodes source_type:"OWNER" for every user turn — untrusted-input rule can never fire; latent provenance foot-gun. |

Auditor's verified-safe notes: single enforcement point holds (raw executor wrapped once, exhaustive grep); path jail robust (realpath, fails closed); subprocess env allowlisted (clearEnv:true); no key logging; abort honored; taint monotonic; team isolation sound; no eval.

### core-state (4)
| ID | Sev (auditor) | Location | Issue |
|---|---|---|---|
| CORE-STATE-1 | medium | core/storage/sqlite.ts:54 | list(prefix) uses LIKE without ESCAPE — `_`/`%` in prefix over-match across key namespaces; diverges from memory provider startsWith contract; latent (current keys are UUID/hex/enum). |
| CORE-STATE-2 | low | core/secrets/classification/gated_keychain.ts, secret_access_gate.ts | SECRET_ACCESS classification gate implemented + tested but never wired — production uses raw createKeychain(); "no RESTRICTED secrets in background sessions" unenforced. |
| CORE-STATE-3 | low | core/logger/logger.ts:96-130 | No secret-redaction backstop in logger; structured args JSON.stringify'd verbatim to disk. |
| CORE-STATE-4 | low | core/session/manager.ts:68-80 + bumpers.ts:41 | deserialise() unvalidated: missing bumpersEnabled ⇒ undefined ⇒ bumpers silently OFF; invalid taint accepted. |

Auditor's verified-safe notes: taint escalate-only; restore forces PUBLIC; lineage persists content only for PUBLIC; keychain subprocesses argv/stdin (no shell); AES-256-GCM + 0600.

### integrations-cli (4)
| ID | Sev (auditor) | Location | Issue |
|---|---|---|---|
| INTEGRATIONS-CLI-1 | medium | integrations/github/tools.ts:126-135, repos/tools_repos.ts:281-338 | github_clone_repo/pull dest path join(workspacePath, path) with NO jail check — `../` escapes workspace; raw/absolute path accepted when workspacePath unset. Prompt-injection reachable. |
| INTEGRATIONS-CLI-2 | medium | repos/tools_repos.ts:294/324, client_repos_git.ts:32-42,158-166 | clone/pull branch param skips assertValidBranchName — `--`-prefixed values parsed as git options (argument injection); no `--` separator. |
| INTEGRATIONS-CLI-3 | low (unwired) | routing/delegation.ts:36-52 | Delegation chain verifies self-embedded keys only — no trust anchor; would be critical if ever wired. |
| INTEGRATIONS-CLI-4 | low | workflow/store.ts:158-208 | loadRun/listRuns skip canFlowTo when run.classification undefined — latent fail-open read-down. |

Auditor's verified-safe notes: OAuth PKCE+state sound; tokens keychain-only; CalDAV/GitHub/Notion SSRF-checked incl. discovery URLs; wizard writes secret: refs only; workflow engine no eval, dispatch through policy-enforced executor; X media upload correctly jailed.

### gateway (4)
| ID | Sev (auditor) | Location | Issue |
|---|---|---|---|
| GATEWAY-1 | medium | gateway/notifications/notifications.ts:84-118, core/types/notification.ts:35-38 | NotificationService fanOut() sends to ALL channels with no canFlowTo gate; DeliveryChannel drops the channel classification known at registration; RESTRICTED trigger notification can reach INTERNAL shared Google Chat space. Sibling channel_executors path DOES enforce. |
| GATEWAY-2 | low | gateway/server/server.ts:101-117 | /debug/run-triggers fails OPEN when token unconfigured (logs "proceeding"); unreachable in shipped wiring (token always set) but inverted default. |
| GATEWAY-3 | low | gateway/sessions.ts:123-149 | RPC sessions.send trusts caller-supplied targetClassification AND is a no-op returning delivered:true (toId/content unused); inconsistent with executeSessionsSend which derives target.taint. |
| GATEWAY-4 | low | gateway/notifications/priority_router.ts | Priority router (critical→all, dedup) dead/unwired — only barrel re-exports. |

Auditor's verified-safe notes: WS control plane authenticated (256-bit per-start token, Origin "null", loopback bind, timingSafeEqual); no session takeover; cross-session tools enforce write-down with injected taint; default-deny unmapped tools for non-owners; management tools unreachable by non-owners; no secret values in logs.

Remediation shape (draft, pending verdicts):
- GATEWAY-1+4: one fix — add readonly classification to DeliveryChannel, set at every registerChannel site, gate fanOut per channel with canFlowTo (WARN on suppression), default missing notification classification to session taint (fail closed); optionally fold priority router in or delete it. Theme T2/T1.
- GATEWAY-2: fail closed when token absent (401/503). Theme T1.
- GATEWAY-3: remove dead RPC surface or mirror executeSessionsSend (derive target.taint, actually deliver). Theme T2/T7.
- AGENT-EXEC-1: strip env fallbacks in 7 providers + gateway URL fallback; match fireworks.ts shape; fix JSDoc. Theme T5.
- AGENT-EXEC-2: fail-closed segment classification for unparseable/indirect commands (substitution/var-only args ⇒ filesystem default CONFIDENTIAL), regression tests. Theme T1/T6.
- AGENT-EXEC-3: derive source_type from isOwnerSession. Theme T2.
- CORE-STATE-1: LIKE → range scan or ESCAPE + shared provider conformance test. Theme T8 (contract divergence).
- CORE-STATE-2: wire gated keychain OR delete dead modules (human decision; relates to MCP-PLUGIN-1 dead-sandbox pattern). Theme T9 (advertised-but-unwired security).
- CORE-STATE-3: redaction pass in logger (key-denylist + bearer-pattern mask). Theme T5.
- CORE-STATE-4: validate taint via parseClassification, coerce bumpersEnabled ?? true. Theme T1.
- INTEGRATIONS-CLI-1: isRealPathWithinJail after join; fail closed when workspacePath unset. Theme T10 (jail bypass — same family as M8 fix).
- INTEGRATIONS-CLI-2: assertValidBranchName on clone/pull + `--` separator. Theme T6.
- INTEGRATIONS-CLI-3: trust-anchor requirement before any wiring (or delete). Theme T9.
- INTEGRATIONS-CLI-4: missing run.classification ⇒ RESTRICTED before canFlowTo. Theme T1.

### tools-other (5)
| ID | Sev (auditor) | Location | Issue |
|---|---|---|---|
| TOOLS-OTHER-1 | medium | tools/ssh/ssh_args.ts:73,85, ssh_executor.ts:51-66 | `host` placed before `--` in ssh argv; `-oProxyCommand=...` host value executes LOCAL commands on daemon host; no leading-dash rejection; SSH resources never classified (INTERNAL floor only). |
| TOOLS-OTHER-2 | medium | tools/obsidian/notes/note_walker.ts:22, note_query.ts:61/86, links.ts:161 | obsidian_search/list `folder` and links outlinks `notePath` bypass resolveVaultPath — `../` escapes vault; outlinks reads arbitrary .md with NO classification check. CRUD path is correctly confined. |
| TOOLS-OTHER-3 | medium | agent/orchestrator/classification_map.ts:90, tools/log_reader.ts:170 | log_read classified PUBLIC, no floor — PUBLIC non-owner (WebChat) can read operational logs containing INTERNAL/CONFIDENTIAL metadata (memory keys+classifications, ssh hosts/commandPreview, sender IDs). Write-down. |
| TOOLS-OTHER-4 | low | classification_map.ts:85 vs tools/healthcheck.ts:5 | healthcheck mapped PUBLIC but its own docstring says "INTERNAL minimum"; leaks provider name, skill sources, config status to PUBLIC sessions. |
| TOOLS-OTHER-5 | low (unwired) | tools/skills/author.ts:143,176 | Skill author joins unvalidated name (no enforceSkillName) — `../` escape writing SKILL.md; module currently dead/unwired. |

Auditor's verified-safe notes: memory subsystem sound (forced taint, canFlowTo reads, bound MATCH ?, non-owner default-deny on save/delete); Reef skill install validates+checksums+scans; Tidepool host loopback+timingSafeEqual+masking (iframe sandbox combo noted as DiD weakness, owner-only); secrets tool value never touches LLM; obsidian CRUD confined; workflow_healing dead/unwired.

Remediation shape (draft, pending verdicts):
- TOOLS-OTHER-1: reject `-`-leading host + validate [user@]host[:port] pattern; add `-o PermitLocalCommand=no` hardening in buildBaseArgs. Theme T6 (argument injection — same family as INTEGRATIONS-CLI-2 git branch).
- TOOLS-OTHER-2: route folder/notePath through resolveVaultPath; canFlowTo on outlinks; walker boundary assert per entry. Theme T10 (path jail — same family as INTEGRATIONS-CLI-1, M8).
- TOOLS-OTHER-3+4: reclassify log_read + healthcheck to INTERNAL via HARDCODED_TOOL_FLOORS (floors not lowerable by config). Theme T2 (classification mismatch).
- TOOLS-OTHER-5: enforceSkillName in author path (one-liner, pre-wiring guard). Theme T10.

### core-policy (4; CP-4 is a cross-reference of WB-3/4, not independently counted)
| ID | Sev (auditor) | Location | Issue |
|---|---|---|---|
| CORE-POLICY-1 | medium | core/policy/hooks/hook_violations.ts:16-24 | detectWriteDownViolation fails OPEN when target_classification missing/unrecognized (`target in CLASSIFICATION_ORDER` guard suppresses block; engine no-match default = ALLOW); user_sessions.ts:118 casts YAML values unvalidated. canFlowTo itself would fail closed. |
| CORE-POLICY-2 | medium | core/security/command_path_extraction.ts | Tokenizer misses `$(...)`/backticks (trailing `)`/`` ` `` breaks exact-path mappings) and attached `<` input redirect (`xxd</etc/shadow` one token); real accessed path never classified. Overlaps AGENT-EXEC-2 (same root cause, different evasion forms). |
| CORE-POLICY-3 | low | mcp/gateway/gateway.ts:90-123,237-272 | MCP_TOOL_CALL hook fired, decision discarded; no default rule for that hook. SAME as MCP-PLUGIN-5 (dedupe). |
| CORE-POLICY-4 | medium (x-ref) | core/security/ssrf.ts:37-43,87-117 | fe80::/10 only matched as literal "fe80:" prefix — fe90::/fea0::/febf:: link-local pass; bracketed literals unhandled. Merge into WB-3/4 fix. |

Auditor's verified-safe notes: taint monotonic + pre-escalation ordering correct; hook runner fail-closed on exception/timeout; audit HMAC chain sound; default-deny verified for unknown domains (PUBLIC ⇒ blocks tainted egress), unclassified MCP (UNTRUSTED ⇒ rejected), unmapped paths (CONFIDENTIAL); IPv4 literal encodings fail closed; path jail separator-aware; ws auth fail-open branch unreachable (token always supplied).

DEDUPE MAP (cross-domain duplicates to merge in final plan):
- CORE-POLICY-3 == MCP-PLUGIN-5 (one fix: honor MCP_TOOL_CALL result).
- CORE-POLICY-4 == WEB-BROWSER-3 + WEB-BROWSER-4 (one fix: byte-level IP parsing in core/security/ssrf.ts; add fe80::/10 range + bracket strip + NAT64).
- CORE-POLICY-2 ~= AGENT-EXEC-2 (complementary evasion sets; one structural fix in command classification: strip trailing metachars, split attached `<`, recurse into substitutions, fail-closed default for unparseable segments).
- SCHEDULER-3 relates to CHANNELS-6/HMAC SoT theme (canonical hmac.ts).
- MCP-PLUGIN-1 relates to CORE-STATE-2 + GATEWAY-4 + TOOLS-OTHER-5 + INTEGRATIONS-CLI-3 (advertised-but-unwired security code pattern).

## 2. Confirmed Findings (verifier verdict = "real" only)

| ID | Severity (verifier-corrected) | Location | Issue |
|---|---|---|---|
| WEB-BROWSER-1 | high | src/tools/browser/tools/tools_navigation.ts, tools.ts | Browser nav: SSRF check once on initial hostname; Chrome follows 3xx internally — redirect to metadata/private IP fetched + exfiltrable via browser_snapshot. No request interception. |
| WEB-BROWSER-2 | high | tools_navigation.ts, manager/manager_launch.ts | DNS rebinding TOCTOU (validated IP discarded; Chrome re-resolves) + all subresource/page-JS egress unchecked; no host-resolver-rules/proxy lockdown. |
| WEB-BROWSER-3 | medium | src/core/security/ssrf.ts:107-117 | Compressed IPv4-mapped IPv6 (`::ffff:7f00:1`, `::ffff:a9fe:a9fe`) classified public — bypasses denylist (verified empirically; Deno emits compressed form). |
| WEB-BROWSER-4 | medium | src/core/security/ssrf.ts:19-35 | IPv4 denylist missing 100.64/10 CGNAT, 198.18/15, 240/4, 224/4, TEST-NETs, broadcast; IPv6 prefix match string-fragile, no NAT64. All gaps verified live. |
| WEB-BROWSER-5 | medium | src/tools/web/fetch.ts + core safe_fetch.ts | Domain allowlist/denylist enforced only on initial URL; redirect hops re-check SSRF only — configured egress boundary bypassed via 3xx. |
| WEB-BROWSER-6 | low | tools_navigation.ts, tools.ts | Browser nav deny paths unlogged (no logger import at all) — violates WARN+ on security denials; web path logs correctly. |
| CHANNELS-1 | high | channels/discord/adapter.ts:64, telegram/adapter.ts:56-58, cli/dive wizards | ownerId unconfigured ⇒ every sender owner (full tools, RCE+secrets); Discord wizard omits ownerId when blank (two generator sites); Telegram wizard fails closed but adapter default fail-open. |
| CHANNELS-2 | low (was med) | gateway/chat_channel_routing.ts:102, channels_telegram.ts, channels_discord.ts | `isOwner !== false` routing promotes undefined to owner — latent only (wired adapters always set boolean; CLI simulateInput unwired test seam). Standardize `=== true`. |
| CHANNELS-3 | low | channels/email/adapter.ts:118-124 | Spoofable From: owner auth + fail-open default; adapter unwired (verified no createEmailChannel in gateway). High if ever wired. |
| CHANNELS-4 | low | channels/slack/adapter.ts:75 | Same fail-open owner default; Slack unwired (verified). High if ever wired. |
| CHANNELS-5 | low | channels/webchat/adapter.ts:67-73 | Wildcard CORS default + no upgrade auth; isOwner:false + PUBLIC pinned, so resource abuse only; unwired. |
| CHANNELS-6 | low | channels/whatsapp/adapter.ts:154 | verify_token `===` compare (subscription handshake only; per-message HMAC constant-time + fail-closed). Use timingSafeEqual. |
| CHANNELS-7 | low | channels/pairing.ts, gateway/chat_access_control.ts:42-54 | 6-digit pairing brute-forceable absent optional nonOwnerRateLimit; ceiling INTERNAL non-owner (addClassification only, never isOwner); wired for Signal/WhatsApp/GoogleChat. |
| MCP-PLUGIN-1 | high | plugin/sandboxed_executor.ts:49-97, loader.ts:191-210 | "Sandboxed" trust = try/catch only; plugin code runs via await import() with daemon --allow-all; real sandbox/SDK/Pyodide dead code. Empirically confirmed. |
| MCP-PLUGIN-2 | high | plugin/tools_defs.ts:20-37, tools_handlers.ts:96-182, scanner.ts | plugin_install (owner LLM tool, no floor) → import() RCE; regex scanner bypassed by bracket/alias/computed-member (4 payloads scored 0, verified). Prompt-injection → RCE in owner session. |
| MCP-PLUGIN-3 | medium | mcp/client/transport.ts:143-202 | SSE transport on live path: EventSource + raw send() fetch follow redirects, one-time URL validation, DNS rebinding. SSRF bypass. |
| MCP-PLUGIN-4 | medium | mcp/executor.ts:207-234, plugin/registry.ts:90-97 | MCP tool descriptions (wire) + plugin systemPrompt injected verbatim into system prompt; MCP path scanned by nothing. |
| MCP-PLUGIN-5 | low | mcp/gateway/gateway.ts:90-123,237-272 | MCP_TOOL_CALL HookResult discarded; no default rule — latent fail-open + unlogged. (== CORE-POLICY-3) |
| MCP-PLUGIN-6 | low | plugin/reef.ts:94-100, reef_operations.ts, reef_catalog.ts | Reef raw fetch (no per-hop SSRF); checksum from same catalog origin (no independent signature). Owner CLI scope. |
| AGENT-EXEC-1 | low | providers anthropic/openai/google/zai/zenmux/openrouter + triggerfish.ts | 8 Deno.env.get fallbacks for API keys + gateway URL — violates absolute config-only rule; stale JSDoc advertises it; fireworks.ts is compliant reference. |
| AGENT-EXEC-2 | medium | agent/dispatch/command_classification.ts:226, core command_path_extraction.ts:179-196 | run_command classification fails OPEN to PUBLIC for `$(...)`/`"$var"`/base64 paths — taint never escalates, write-down never blocks. Full exploit chain verified. (~= CORE-POLICY-2) |
| AGENT-EXEC-3 | low | agent/loop/agent_turn.ts:44 | PRE_CONTEXT_INJECTION hardcodes source_type:"OWNER" — untrusted-input rule dead for user turns; latent. |

## 3. Root-Cause Themes (cross-domain)

Candidate buckets to test against incoming findings (from invariants above):

- T1 Missing default-deny at a boundary (unclassified ⇒ allowed).
- T2 Classification/taint gap — flow not mediated by canFlowTo / taint not escalated.
- T3 SSRF / outbound-fetch bypass (missed DNS re-resolution, redirect, alternate fetch path).
- T4 AuthN/AuthZ gap on a control surface (gateway WS, webhooks, channel owner checks).
- T5 Secret handling (config-file storage, logging secrets, env fallbacks).
- T6 Injection (log poisoning, prompt injection conduit, command construction).
- T7 Duplicated security config drifting from single source of truth.
- T8 Non-deterministic or bypassable hook wiring (tool registered outside executor wrapper).

## 4. Phased Remediation

Item template (every item must carry all five fields):

```
#### P<n>.<k> <ID(s)> — <title>
- Files: <paths to change>
- Approach: <fix honoring invariants: Result types, default deny, deterministic hooks,
  immutable session state, no env-var API-key fallbacks, domains.ts as single SoT>
- Depends on: <other items or none>
- Tests: <new/updated test files> — run: `deno task test <phase path>`
- Theme: <T1..T8>
```

### P0 — Critical/High
_Pending._

### P1 — Medium
_Pending._

### P2 — Low / Hardening
_Pending._

## 5. Uncertain Findings / Open Questions

_Pending._

## 6. Appendix: False Positives

_Pending._
