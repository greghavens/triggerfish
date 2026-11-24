# Gateway Findings — Adversarial Verification — 2026-06-10

Verifier: independent re-check of `findings/gateway.md` against the working tree
(branch `security-remediation`). For each finding I read the cited code, traced
the production wiring, and searched for centralized mitigations (orchestrator
tool-executor wrapper, policy hooks, gateway wiring) that could neutralize the
claim.

---

## GATEWAY-1: real

**Verdict: real. Severity: Medium (confirmed).**

### Evidence checked

- `src/gateway/notifications/notifications.ts:84-90` — `fanOut(message)` sends
  the raw message string to every entry in `channels` via
  `Promise.allSettled(channels.map((ch) => ch.send(message)))`. No `canFlowTo`,
  no classification parameter. Confirmed. `deliver()` (`:93-118`) persists
  `notification.classification` then calls `fanOut(notification.message)` —
  the classification is dropped at the delivery boundary. `flushPending`
  (`:153-169`) has the same gap.
- `src/core/types/notification.ts:35-38` — `DeliveryChannel` is
  `{ name, send }` only. Confirmed: even an enforcing fanOut would have nothing
  to compare against.
- Registration sites discard the known channel classification. Confirmed at
  `channels_telegram.ts:102-105` (classification computed at `:116-117`,
  default `PUBLIC`, not passed), `channels_googlechat.ts:128-131`
  (classification at `:165-166`, default `INTERNAL`, not passed),
  `channels_whatsapp.ts:154-158`, `channels_signal.ts:211-218`,
  `chat_session_network.ts:162-168` (tidepool) and `:245-251` (cli-websocket).
- Upstream plumbing confirmed: `scheduler/service_output.ts:79-84` passes
  `classification: sessionTaint` into `deliver()`; called from
  `service_trigger.ts:140-145`, `service_cron.ts:103-106`,
  `service_webhooks.ts:153-157`. Trigger ceiling defaults to CONFIDENTIAL
  (`core/config_types.ts:118-125`, doc comment: "triggers routinely need access
  to CONFIDENTIAL integrations such as Gmail").
- Sibling-path inconsistency confirmed:
  `gateway/tools/session/channel_executors.ts:55-70`
  (`enforceMessageWriteDown`) blocks `!canFlowTo(currentTaint,
  registered.classification)` using live injected taint, with **no owner
  exemption anywhere in that path** (grepped `isOwner` across
  `gateway/tools/session/` — nothing). So write-down-to-channel enforcement is
  the platform's design even for owner sessions, refuting the
  "owner channels are equivalent so this is by design" defense.
- Mitigation search (refutation attempts):
  - PRE_OUTPUT hook: `agent/dispatch/response_handling.ts:37-74` does run for
    trigger turns with **live** taint (`config.getSessionTaint?.()`), but its
    target is the trigger's `targetClassification` = `classification_ceiling`
    (CONFIDENTIAL default; `isOwnerSession` is not set by the scheduler factory
    — `orchestrator_factory.ts:203-208` sets only `isTriggerSession`/
    `getNonOwnerCeiling`). So CONFIDENTIAL output passes
    canFlowTo(CONFIDENTIAL, CONFIDENTIAL) and is then fanned out to
    PUBLIC/INTERNAL-classified channels with no further gate. The hook gates the
    wrong boundary for this flow; it does not neutralize the finding.
  - Channel adapters: `channels/telegram/adapter.ts` `send()` is a dumb
    transport — stores classification for inbound message labeling, performs no
    outbound canFlowTo. No adapter-level mitigation.
  - Dead-code check: the service is live production code —
    `startup/infra/storage.ts:55` creates it, channels register against it, and
    scheduler/healing deliver through it.

### Correction / addendum (does not change the verdict)

The finding's claim that "the classification is plumbed end-to-end" overstates
the quality of the upstream metadata. The `session.taint` read at all three
scheduler deliver sites is **stale**: `orchestrator_factory.ts:186-188`
escalates taint by reassigning the factory-closure variable
(`session = updateTaint(session, ...)`; `updateTaint` is immutable —
`core/types/session.ts:120-150`), while `create()` returned the *initial*
session object reference (`:211`). Trigger/webhook/cron sessions start PUBLIC
(`createSession`, `core/types/session.ts:66-76`), so
`notification.classification` is effectively always "PUBLIC" regardless of
in-run escalation (the `Trigger completed (taint: ...)` log at
`service_trigger.ts:132` is stale for the same reason). Consequence: the
recommended fanOut gate keyed on `notification.classification` would be a
no-op unless the stale taint read is fixed too (e.g. expose the live
`getSessionTaint` from the factory or return final taint from the turn). The
enforcement gap itself is unaffected — fanOut checks nothing — and the
content-level write-down (CONFIDENTIAL-derived text reaching a
PUBLIC-classified channel) is real.

Also confirmed: `healing_orchestrator.ts:208-218` delivers with no
`classification` at all (undefined), so the gate must fail closed on missing
classification as the recommendation says.

### Severity

Medium is correct. Real, deterministic enforcement gap at a live production
boundary, directly contrary to invariant #3 ("CONFIDENTIAL data cannot reach a
PUBLIC channel") and inconsistent with the sibling channel-send path. Bounded
below High because every registered destination is owner-addressed in the
shipped wiring (`telegram-${ownerId}`, `whatsapp-${ownerPhone}`,
`signal-${ownerPhone}`, owner Google Chat space, loopback sockets) and the
worst concrete leak (shared Google Chat space with non-owner members) is
config-dependent.

---

## GATEWAY-2: real

**Verdict: real. Severity: Low (confirmed).**

### Evidence checked

- `src/gateway/server/server.ts:97-137` — `handleDebugTriggerEndpoint`: when
  `!options?.token` it logs `"Debug endpoint auth not configured, proceeding"`
  (at DEBUG, line 102) and falls through to
  `options.schedulerService.runTrigger()` — an action-bearing,
  unauthenticated trigger fire. Fail-open confirmed; quoted evidence matches
  the file verbatim. Routed from `:266-271` (`POST /debug/run-triggers`).
- Reachability: server binds `hostname: "127.0.0.1"` hardcoded (`:197`). The
  only production caller is
  `startup/services/chat_session_network.ts:233-242`, which always passes
  `token: await ensureGatewayToken()`. Grep confirms no other `src/` caller of
  `createGatewayServer`; only tests construct it token-less
  (`tests/gateway/server_test.ts:16` etc.). So the fail-open branch is
  unreachable in shipped wiring — exactly as the finding states.
- The inverted default also violates the project's documented invariant
  ("Never default to ALLOW ... if no permission configured, default must be
  DENY", `.claude/rules/security.md`), and the silent-allow branch logs at
  DEBUG, which additionally conflicts with the "security events at WARN+" rule.

### Severity

Low is correct: a latent fail-open default with no production exposure today
(token always set, loopback-only), but a single refactor away from an
unauthenticated trigger-fire endpoint (and, token-less, it would be reachable
via simple cross-origin POST from a browser to 127.0.0.1 since no custom
headers are required). Fix is trivial (return 401/503 when token absent).

---

## GATEWAY-3: real

**Verdict: real. Severity: Low (confirmed).**

### Evidence checked

- `src/gateway/sessions.ts:123-149` — confirmed verbatim: `_toId` and
  `_content` are unused; the write-down check is
  `canFlowTo(source.taint, targetClassification)` against the caller-supplied
  value; returns `{ ok: true, value: { delivered: true } }` having delivered
  nothing. Both claims (caller-asserted classification, no-op delivery) hold.
- RPC entry confirmed: `server/handlers_rpc.ts:101-140` —
  `validateSendParams` pulls `targetClassification` straight from JSON-RPC
  params and `dispatchSessionsSend` forwards it; reachable via the
  control-plane WebSocket, which is authenticated (server.ts:206-223 →
  `rejectWebSocketUpgrade` with token + origin allowlist; production always
  passes the token). Owner-only loopback transport + nothing actually delivered
  → no exploitable flow, as the finding says.

### Correction (sharpens, does not weaken, the finding)

The finding calls the agent tool `executeSessionsSend`
(`tools/session/session_executors.ts:172-205`) "the correct,
content-delivering path." Half right: it does derive the classification from
the resolved target (`target.taint`, line 191 — not a caller value), but it
delegates to the **same** `EnhancedSessionManager.sessionsSend`
(`SessionToolContext.sessionManager` is `EnhancedSessionManager`,
`session_tools_defs.ts:32-34`), so it also delivers nothing while returning
"Message delivered to session ${sessionId}." The no-op delivery semantics are
universal to session-to-session send, not unique to the RPC variant. This
strengthens the dead-semantics half of the finding and slightly weakens only
the contrast framing.

### Severity

Low is correct. Today this is dead semantics plus a misleading
caller-trusted-classification pattern; the latent risk is that a future change
wires real delivery into `sessionsSend` without changing the classification
source, instantly creating a caller-controlled write-down bypass on the RPC
surface. Remove the RPC surface or derive from `target.taint` and actually
deliver, per the recommendation.

---

## GATEWAY-4: real

**Verdict: real. Severity: Low (confirmed).**

### Evidence checked

- `src/gateway/notifications/priority_router.ts` — full module read:
  `createPriorityRouter` implements route-by-priority
  (critical→all_channels, normal→primary_only, low→batch_digest) plus
  dedup (`isDuplicate`/`recordDelivery`/`sweep`).
- Reference search across `src/` and `tests/`: the only non-test references are
  barrel re-exports at `src/gateway/notifications/mod.ts:9` and
  `src/gateway/mod.ts:31` (plus type re-exports at `:33-34`). Callers of
  `createPriorityRouter`/`.route(`/`.isDuplicate(` exist only in
  `tests/gateway/notification_priority_test.ts`. No production instantiation —
  confirmed dead/unwired.
- Behavioral consequence confirmed against `notifications.ts`: `deliver()`
  fans out every notification to all channels regardless of `priority`, and no
  dedup is applied — so the module's documented behavior (and its tests) imply
  routing/dedup guarantees that the runtime does not provide.

### Severity

Low is correct. Primarily a dead-code/maintenance hazard (violates the
project's no-dead-code rule and misleads readers into assuming priority
routing/dedup is active); security impact is indirect — its absence is part of
why GATEWAY-1's fan-out is all-channels-always. Wire it in (ideally together
with the GATEWAY-1 classification gate) or delete it.

---

## Summary

| ID | Verdict | Severity | Notes |
|----|---------|----------|-------|
| GATEWAY-1 | real | Medium | Fan-out write-down gap confirmed; addendum: scheduler's `session.taint` read at deliver sites is stale (always initial/PUBLIC), so the fix must also read live taint, not just gate on `notification.classification`. |
| GATEWAY-2 | real | Low | Fail-open branch confirmed; unreachable in shipped wiring (token always set, loopback-only). |
| GATEWAY-3 | real | Low | Caller-supplied classification + no-op delivery confirmed; correction: the agent tool path is also a no-op (same underlying `sessionsSend`), so only its classification *derivation* is correct. |
| GATEWAY-4 | real | Low | Dead/unwired confirmed: barrel exports + tests only. |
