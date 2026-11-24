# Verified Security Review — Domain: scheduler

Adversarial verification of `.claude/security-review/2026-06-10/findings/scheduler.md`
against the live source on branch `security-remediation`. Each finding was
re-derived from the cited files plus the surrounding wiring (orchestrator
factory, dispatch pipeline, policy hooks, gateway HTTP route, config builder).

---

## SCHEDULER-1: real

**Verdict: real. Severity: high (confirmed, with documented preconditions and one partial mitigation the report already acknowledges).**

The finding's full logic chain reproduces exactly against the code.

Evidence checked:

- **Webhook session is created with no ceiling/trigger options.**
  `dispatchWebhookSession` calls `config.orchestratorFactory.create("webhook-${sourceId}")`
  with no `OrchestratorCreateOptions` (`src/scheduler/service_webhooks.ts:144-146`).
  `executeCronJob` does the same with `create("cron")`
  (`src/scheduler/service_cron.ts:94-96`). Only `invokeTriggerCallback`
  passes `{ isTrigger: true, ceiling }` (`src/scheduler/service_trigger.ts:203-207`).

- **The factory only attaches identity getters when `isTrigger`.**
  `createOrchestratorFactory` sets `isTriggerSession`/`getNonOwnerCeiling`
  only inside the `...(isTrigger ? {...} : {})` spread
  (`src/gateway/startup/factory/orchestrator_factory.ts:203-208`). It **never**
  sets `isOwnerSession` for any scheduler session. I grepped the whole tree:
  `isOwnerSession` is wired in `gateway/chat_turn_execution.ts`,
  `gateway/startup/service_startup.ts`, and `simulate_handlers.ts` — never in
  the scheduler orchestrator factory. So for webhook/cron sessions all three
  of `isTriggerSession`, `isOwnerSession`, `getNonOwnerCeiling` are `undefined`.

- **Tool-executor wrapper ceiling is bypassed.**
  `enforceAccessControl` (`src/agent/dispatch/access_control.ts:178-200`):
  `isActiveTrigger = config.isTriggerSession?.() ?? false` → false; the
  non-owner branch guard is `config.isOwnerSession && !config.isOwnerSession()`
  → short-circuits to false because `isOwnerSession` is `undefined`. Returns
  `null` — no tool ceiling applied. Confirmed.

  Note: `enforceNonOwnerToolCeiling` is the gate that *would* catch integration
  tools (it matches `toolClassifications` prefixes incl. `gmail_`, `github_`,
  …, and default-denies unmapped tools). It is the operative bypassed control
  for the integration vector, and the report correctly cites it.

- **PRE_TOOL_CALL read-ceiling rule no-ops.**
  `assembleIdentityContext` sets `isOwner=false` and `nonOwnerCeiling=null`
  (`src/agent/dispatch/security_context.ts:153-157`);
  `populateHookInputFields` only writes `non_owner_ceiling` when non-null
  (`:200-202`), so it is absent. `detectResourceReadCeilingViolation` returns
  `false` whenever `ceiling === undefined`
  (`src/core/policy/hooks/hook_violations.ts:66,70`). Confirmed.

- **No catch-all default-deny for `is_owner:false`.**
  The scheduler factory's hook runner is built from exactly
  `createDefaultRules()` (`orchestrator_factory_infra.ts:91`), which contains
  the 7 rules in `src/core/policy/hooks/default_rules.ts:137-147`. None blocks
  a non-owner read with no ceiling. The remaining PRE_TOOL_CALL gate
  (`resource-write-down`) is taint-based and only blocks write-down; with
  PUBLIC taint, read-up is permitted: `canFlowTo(PUBLIC, CONFIDENTIAL)` =
  `CLASSIFICATION_ORDER[CONFIDENTIAL]=3 >= CLASSIFICATION_ORDER[PUBLIC]=1` =
  true (`src/core/types/classification.ts:23-28,59-64`). Sessions start PUBLIC
  (`src/core/types/session.ts:66-76`). Confirmed.

- **Source `classification` gates OUTPUT only.**
  It is passed as `targetClassification` to `executeAgentTurn`
  (`service_webhooks.ts:150`) → `target_classification` in the PRE_OUTPUT hook
  (`src/agent/dispatch/response_handling.ts:41-62`), never as a read ceiling.
  Confirmed.

- **Attacker-controlled prompt + sensitive tool profile.**
  The HTTP body (≤1 MB) is read by `consumeWebhookBody`
  (`src/gateway/server/handlers_webhook.ts:51-88`), passed through
  `verifyWebhookRequest` (HMAC), then embedded verbatim into the prompt by
  `buildWebhookPrompt` (`service_webhooks.ts:130-136`). The session uses the
  `cronJob` tool profile (factory line 148), which includes
  `google, github, caldav, notion, x, web, memory, cron, workflow`
  (`src/gateway/tools/defs/tool_profile_defs.ts:151-169`). Live path confirmed:
  `service.ts:129` → `verifyWebhookRequest`, `service.ts:139` →
  `dispatchWebhookSession`; route is `routeWebhookHttp` in
  `handlers_webhook.ts`.

**Refinement of the exploit premise (verified, narrows but does not negate):**
Integration prefix classifications are config-driven and default to **PUBLIC**
for `google`/`github` and **INTERNAL** for `x`
(`src/agent/orchestrator/classification_map.ts:122-142`). `caldav`/`notion`
have no prefix entry at all and no hardcoded floor
(`src/core/security/constants.ts` HARDCODED_TOOL_FLOORS lists only
claude_/ssh_/config_manage/daemon_manage). Consequences:

- The read-up above PUBLIC only occurs when the **owner has explicitly raised
  an integration's classification** in `triggerfish.yaml` (e.g.
  `google.classification: CONFIDENTIAL`). That is precisely the scenario the
  non-owner ceiling exists to protect, so the bug is meaningful exactly where
  it matters.
- With the recommended fix (mark webhook/cron sessions non-owner with the
  source classification as ceiling), `enforceNonOwnerToolCeiling` WOULD block
  these reads: it matches the integration prefix and `canFlowTo(level, ceiling)`
  fails for an above-ceiling integration; unmapped tools (`caldav`/`notion`)
  hit the default-deny tail (`access_control.ts:85`). So the recommendation is
  sound and the gate is genuinely defeated today.

**Partial mitigation present (already acknowledged by the report):** PRE_OUTPUT
write-down (`response_handling.ts:49`) uses `effectiveTarget =
targetClassification` for non-owner output, so once taint escalates from
reading owner data, echoing that data back into a lower-classified webhook
response is blocked. This constrains exfiltration **through the response** but
does not stop the read itself, the taint escalation, exposure to the LLM
provider, or side-effecting use of the data through other tools (subject to
their own write-down checks). The non-owner read-ceiling invariant
(Architecture Principle #10 / the "non-owner cannot read above its ceiling"
model) is still violated.

**Refutation attempts that failed:**
- "Cited code is dead / production uses another path" — No. I traced the live
  HTTP route → scheduler service → `dispatchWebhookSession`; this is the only
  webhook execution path.
- "Fails closed, not open" — No. The wrapper returns `null` (allow) and the
  hook rule returns `false` (no violation). Both fail OPEN for the non-owner.
- "A sanitizer elsewhere neutralizes it" — No bumpers (`checkBumpersBlock` is
  not configured by this factory), no floor for the integration tools, no
  catch-all rule. The only backstop is PRE_OUTPUT, which is output-side only.

**Severity:** I keep **high**. It is a deterministic bypass of the core
non-owner read-ceiling guarantee for externally-prompted, shared-secret
sessions. I considered lowering to medium given the preconditions (webhooks
off by default — `enabled ?? false` in `scheduler_config.ts:69`; requires a
configured source + HMAC secret; requires the owner to have raised an
integration classification; and the output gate blocks response-side exfil),
but the finding targets the product's central invariant and fails open, so
high is justified. Mitigations/preconditions are documented above so the
reader can prioritize accurately.

---

## SCHEDULER-2: real

**Verdict: real. Severity: medium (confirmed; the underlying weakness is marginally stronger than described).**

Evidence checked:

- **Replay guard is in-memory only.** `createReplayGuard` uses a plain
  `Map<string, true>` with LRU eviction and no `StorageProvider`
  (`src/scheduler/webhooks/replay_guard.ts:31-45`). Wiped on restart. Confirmed.

- **Timestamp is not bound into the HMAC.** `verifyHmacAsync(body, signature,
  secret)` signs `encoder.encode(body)` only
  (`src/scheduler/webhooks/webhooks.ts:48-86`, sign call at :69-73). The
  freshness check reads `context.timestamp` from the unauthenticated
  `x-timestamp` header (`handlers_webhook.ts:97`; check at
  `service_webhooks.ts:80-90`). Confirmed.

- **Config not plumbed; defaults used.** `buildSchedulerConfig` constructs
  `webhooks: { enabled, sources }` only — no `maxAgeMs`, no `replayGuardSize`
  (`src/gateway/startup/factory/scheduler_config.ts:46-73`). So production uses
  `maxAgeMs = 300_000` (service_webhooks.ts:80) and `replayGuardSize = 10_000`
  (service.ts:168). Confirmed.

- **Bind address.** Gateway binds `127.0.0.1` (`src/gateway/server/server.ts:197`),
  so external delivery implies a reverse proxy/tunnel; the capture position is
  on that path. Confirmed.

The post-restart replay window is real: the in-memory guard blocks replays
within a single daemon lifetime (an attacker cannot mint new valid signatures
without the secret, so they cannot force LRU eviction), but after a restart the
guard is empty and a captured `(body, signature)` pair re-verifies.

**One correction that strengthens the finding:** because the timestamp is
attacker-chosen and unauthenticated, the freshness window provides essentially
**no** replay protection — an attacker replaying after a restart simply sets
`x-timestamp = now`, giving `age ≈ 0`, which always passes
`age <= maxAgeMs && age >= 0`. So the replay is not constrained to "within
`maxAgeMs` of the original capture"; it is open at any time after a restart.
The report's phrasing ("replay within the maxAgeMs freshness window")
understates this slightly. The freshness check only limits clock skew for the
honest sender; it backstops nothing against replay.

Each accepted webhook spawns a side-effecting agent turn
(`dispatchWebhookSession`), so a replay re-executes the action.

**Refutation attempts that failed:**
- "Already mitigated by the guard" — only within one process lifetime; the
  guard is non-persistent, so a restart reopens the window.
- "Timestamp signing makes this a non-issue" — the timestamp is NOT signed, so
  it does not constrain a captured signature.
- "Fails closed" — no; an empty guard + matching HMAC + forgeable fresh
  timestamp = accepted (open).

**Severity:** medium is appropriate. Preconditions reduce practical risk
(webhooks off by default; loopback bind requires an on-path capture position;
attacker needs a captured valid signed request and a daemon restart), and the
HMAC secret is never exposed by this flaw. The recommendation (sign
`timestamp + "." + body`, and/or persist the nonce store via StorageProvider)
is correct and is the right fix.

---

## SCHEDULER-3: real

**Verdict: real. Severity: low (confirmed — dead/duplicated security code, not an exploitable timing flaw).**

Evidence checked:

- `signWebhook`/`verifyWebhookSignature` are defined in
  `src/scheduler/webhooks/security.ts:26-85` and exported via
  `src/scheduler/webhooks/mod.ts:17` and `src/scheduler/mod.ts:50`.
- A full-tree grep for `signWebhook|verifyWebhookSignature` returns only those
  definitions/barrels plus `tests/scheduler/webhook_security_test.ts`. **No
  production importer.** Confirmed.
- The live webhook handler uses a different function, `verifyHmacAsync`
  (`service_webhooks.ts:19,92`), which parses the `sha256=` prefix — a divergent
  API from `verifyWebhookSignature` (which takes raw hex). This confirms they
  are not interchangeable and the `security.ts` pair is unused.
- A canonical primitive already exists: `verifyHmacSha256` + `timingSafeEqual`
  in `src/core/security/hmac.ts:24,50`.

The hand-rolled comparison in `verifyWebhookSignature`
(`security.ts:70-85`) is acceptable: it short-circuits on length mismatch over
a fixed 64-char hex digest and XOR-accumulates per byte. No meaningful timing
leak when used as intended, so this is a maintainability/duplication concern
(divergence from the single canonical HMAC primitive, risk of a future caller
picking the wrong one), not an exploitable vulnerability.

**Refutation attempts that failed:**
- "It's actually used in production" — no, only tests import it.
- "It's a timing vulnerability" — the report itself does not claim this, and
  the comparison is constant-time-ish over fixed-length hex; agreed it is not
  exploitable.

**Severity:** low is correct (cleanup/consolidation note). The recommendation
to remove the duplicate and route through `core/security/hmac.ts`'s
`verifyHmacSha256` is the right call. (Scope note: removing barrel exports and
a tested module touches files already within the scheduler domain under review,
so it is in-scope for this domain; no unrelated infrastructure is implicated.)

---

## Summary

| Finding | Report severity | Verified verdict | Verified severity |
|---|---|---|---|
| SCHEDULER-1 | high | real | high |
| SCHEDULER-2 | medium | real | medium |
| SCHEDULER-3 | low | real | low |

All three findings reproduce against the live code on `security-remediation`.
No finding was based on dead code, a fail-closed misread, or a
neutralized-elsewhere issue. SCHEDULER-1's exploit premise was narrowed (the
read-up above PUBLIC requires the owner to have configured an above-PUBLIC
integration classification, and response-side exfil is blocked by PRE_OUTPUT
write-down), but the non-owner read-ceiling bypass itself is genuine and fails
open. SCHEDULER-2's weakness is marginally stronger than the report states
(the unauthenticated timestamp makes the freshness window provide no real
replay protection). SCHEDULER-3 is an accurate dead-code/duplication note.
