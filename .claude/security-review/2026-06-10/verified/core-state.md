# Core-State Verification — 2026-06-10

Domain: **core-state**. Findings file: `findings/core-state.md` (4 findings).
Verifier: adversarial re-check against actual code on branch `security-remediation`.

---

## CORE-STATE-1: real

**Final severity: medium (upheld)**

**Code claims verified.** All three cited snippets match the source verbatim:
- `src/core/storage/sqlite.ts:54` — `listPrefix: db.prepare("SELECT key FROM kv WHERE key LIKE ? || '%'")`, bound with the raw prefix at `:66`, exposed via `list()` at `:99`. No `ESCAPE` clause anywhere in the file, so `_` and `%` in a prefix act as wildcards.
- `src/core/storage/provider.ts:25-26` — contract documents literal prefix matching ("List all keys matching an optional prefix").
- `src/core/storage/memory.ts:18` — in-memory provider uses `String.startsWith` (literal semantics). The two implementations genuinely diverge, and the test provider is the literal one.

**Production wiring verified.** `createSqliteStorage` is the production store (`src/gateway/startup/infra/storage.ts:37`, also `src/cli/commands/cron.ts:139`), so the wildcard semantics are what runs in the daemon. Not dead code.

**Exploitability claim re-checked — mostly accurate, two nuances the report missed.** I enumerated every `storage.list(prefix)` call site with a variable segment:
- Session/lineage/conv prefixes use `crypto.randomUUID()` ids (`src/core/types/session.ts:68`), hash-index keys, or constants — confirmed safe as the report stated.
- `pairing.ts:203` interpolates only `channelType` (fixed channel names); `platformUserId` is in the key suffix, not the list prefix — safe.
- **Missed by the report:** `src/gateway/server/handlers_rpc.ts:192-196` (`notifications.list` RPC) passes a *client-supplied* `params.userId` straight into the `notifications:<userId>:` list prefix (`src/gateway/notifications/notifications.ts:121-122`). A userId of `%` would enumerate all users' pending notifications. Mitigation: the Gateway WS is token-authenticated (`src/core/security/websocket_auth.ts` via `server.ts`), so the caller is the owner's own control plane — same trust domain, not a boundary crossing in this single-owner product.
- **Missed by the report:** webhook `sourceId` from owner config flows into agent ids (`orchestrator_factory.ts:98` builds `scheduler-webhook-<sourceId>-<Date.now()>`) which become `memory:<agentId>:<level>:` list prefixes (`src/tools/memory/store.ts:114,153`) and todo-manager keys. Config source names can legitimately contain `_`. However the `Date.now()` suffix makes a colliding near-identical agent id practically impossible, and config is owner-trusted.
- `workflowName` is interpolated into list prefixes (`src/workflow/healing/version_records.ts:71,89`, `version_store.ts:241,299`), but `createWorkflowVersionStore` is constructed nowhere in production (barrel exports + tests only) — latent, consistent with the report's framing.

**Conclusion:** the defect is unambiguous and production-wired; there is no *attacker-controlled* path today, but user/config-derived strings already reach `list()` prefixes (notifications RPC, webhook source ids), which slightly strengthens — not weakens — the report's "likely future introduction" argument. The bug silently violates the isolation primitive every namespace (including the memory classification gating of security invariant #8 and agent isolation of #6) relies on, and it is invisible to the test suite because tests run on the `startsWith` provider. Medium is the right severity: real latent cross-namespace over-match in the production storage primitive, no live bypass.

---

## CORE-STATE-2: real

**Final severity: low (upheld)**

**Unwired claim verified.** `grep -rn "createGatedKeychain\|createSecretAccessGate" src/ tests/` shows references only in:
- definitions (`src/core/secrets/classification/gated_keychain.ts:44`, `secret_access_gate.ts:97`),
- barrels (`src/core/secrets/mod.ts:84-85`, `classification/mod.ts:17,26`),
- tests (`tests/core/secrets/classification/access_gate_test.ts`, `tests/gateway/secret_access_wiring_test.ts`, `tests/gateway/trigger_session_taint_test.ts`).

No production construction anywhere. The "wiring" tests construct the gate themselves rather than exercising production wiring — the test name overstates what is enforced.

**Production consumers verified ungated.** `createKeychain()` (raw `SecretStore`) is used directly by `gateway/startup/bootstrap.ts:126`, `gateway/startup/channels/channels.ts:92`, `gateway/startup/factory/orchestrator_factory_infra.ts:106`, and all CLI connect/secrets commands. Tool-arg `{{secret:}}` resolution happens in the centralized enforcement wrapper `src/agent/dispatch/access_control.ts:203-241` (`wrapToolExecutorWithEnforcement` → `resolveToolSecrets` → `resolveSecretRefs(input, config.secretStore)`) using the ungated store — note the report cited `access_control.ts:208`, which is `src/agent/dispatch/access_control.ts`, not orchestrator/; minor citation-path imprecision, substance correct.

**Behavior claims verified.** `defaultHookDispatcher` (`secret_access_gate.ts:65-89`) indeed never returns DENY — it allows-with-escalation. `createDefaultSecretAccessRules` (`src/core/policy/hooks/secret_access_hook.ts:102-112`) contains the deny-RESTRICTED-in-background rule, which is therefore shipped but unenforced. The `SECRET_ACCESS` hook type exists in `core/policy/rules.ts:16` but no production hook chain dispatches it.

**Additional evidence of partial intentionality** (supports low, not higher): `src/gateway/startup/factory/orchestrator_factory.ts` carries an explicit in-code comment — "IMPORTANT: infra.keychain for all integration executors ... NEVER create a gated/classified keychain here" — so at least the integration-executor path is deliberately ungated. The gate's own doc comment, however, anticipates orchestrator POST_TOOL_RESPONSE wiring that does not exist.

**Conclusion:** accurately reported as dead/unwired defense-in-depth (the report itself applied the dead-code discount). Secrets never transit the LLM (resolution is below the LLM layer; missing-secret errors name the ref, not the value), so no direct exfiltration path. Real finding at low severity; remediation belongs in a tracked issue (wire it or delete it), exactly as the report recommends.

---

## CORE-STATE-3: real

**Final severity: low (upheld)**

**Code claims verified.**
- `src/core/logger/logger.ts:96-99` (`formatLine`) serializes every non-string arg with bare `JSON.stringify`; `dispatchLogLine` (`:120-130`) writes the line to stderr and the persistent `FileWriter` with no redaction pass. No allow/deny key list exists anywhere in `src/core/logger/`.
- `src/core/logger/sanitizer.ts` confirmed to be provenance/injection sanitization only: byte-truncation to 256, newline/control-char stripping, «» delimiter escaping. It performs zero secret redaction, and it only applies to the opt-in `log.ext()` path anyway.
- `src/core/logger/audit.ts` (`writeAuditEvent`) writes `event.rawContent` verbatim by design ("Write a raw audit event").

**"No live leak" claim spot-checked and confirmed.** Grepped all `log.*` calls mentioning secret-like identifiers: the secrets subsystem (`file_provider.ts`, `windows_migration.ts`, `secret_cache.ts`, `vault/auth/approle.ts`, `composite_store.ts`, `permission_check.ts`, `secret_access_hook.ts`) logs only names/paths/status, never values. `resolveToolSecrets` and the dispatch/loop path (`tool_dispatch.ts`, `loop_iteration.ts`) contain no logging of tool input at all, so post-substitution secrets are not currently written to logs.

**Conclusion:** the finding is a defense-in-depth gap, accurately scoped: discipline at every call site is the only thing preventing plaintext secrets in `~/.triggerfish/logs/`, and a single future `log.debug("...", requestInit)` regresses silently. This is a hardening recommendation rather than a present vulnerability — low is the correct severity (it should not be raised; "false_positive" would be wrong because the absence of the backstop is factual and security-relevant for a daemon that persists logs).

---

## CORE-STATE-4: real

**Final severity: low (upheld, with a correction that weakens the headline consequence)**

**Code claims verified.**
- `src/core/session/manager.ts:68-80` — `deserialise` is `JSON.parse` + spread + `as SessionState`. No validation of `taint` against `ClassificationLevel`, no default for `bumpersEnabled`, no history-shape checks. Confirmed.
- `src/core/session/bumpers.ts:41` — `if (!session.bumpersEnabled) return false;` so `undefined` ⇒ bumpers treated as disabled. Confirmed.
- `createSession`/`restoreSession` (`src/core/types/session.ts:74,104`) both default `bumpersEnabled ?? true`. Confirmed.
- Production main-session restore persists only `{id, createdAt}` (`tool_infra_session.ts` `restoreOrCreateMainSession` / `persistSessionRecord`; `orchestrator_factory.ts:273` `session-id:<channel>`) and rebuilds via `restoreSession` — bypassing `deserialise()` entirely, exactly as the report conceded.

**Correction — the report overstates reachability of the bumper consequence.** It claims the `SessionManager`/`EnhancedSessionManager` consumers of full-state `sessions:` records "would surface the bumper-disable behavior". I verified this is not true in current wiring: `wouldBumpersBlock` has exactly one production caller, `src/gateway/startup/services/chat_session_assembly.ts:72`, operating on `state.session` — which is only ever produced by `createSession`/`restoreSession`/`updateTaint`/`toggleBumpers` on the live in-memory main session. The deserialised-session consumers (`sessions.get/list/sessionsSend/sessionsSpawn` in `src/gateway/sessions.ts`, team taint lookups in `team_session_registry.ts` — which actually reads a live in-memory registry, not storage) never evaluate `bumpersEnabled`. So no current path connects `deserialise()` output to the bumper guard at all.

**Fail-direction verified for the invalid-taint half.** A garbage `taint` fails CLOSED everywhere I traced: `canFlowTo` (`classification.ts`) computes `ORDER[target] >= ORDER[garbage]` → `undefined` comparison → `false` → flow blocked (e.g. `sessionsSend` write-down check at `src/gateway/sessions.ts` denies); memory visibility (`canFlowTo(level, garbageTaint)`) → `false` → no records visible; `maxClassification(garbage, level)` returns the valid incoming level, repairing the field on next escalation. This matches the report's "generally fail closed" hedge.

**Also noted:** `serialise()` always writes `bumpersEnabled` (required field on `SessionState`), so a missing field can only come from a pre-bumpers-schema record or out-of-band DB edits; the SQLite store is internal and not attacker-writable.

**Conclusion:** the underlying facts are real — persisted state is trusted without validation, and a security toggle has fail-open default semantics on `undefined` — and the recommended fix (`bumpersEnabled: data.bumpersEnabled ?? true`, `parseClassification` on `taint`) is correct and cheap. But the only fail-open consequence is unreachable in current wiring (more so than the report claimed), and the invalid-taint case fails closed. Real latent robustness/hardening gap; low severity is the ceiling and is upheld. Not a false positive because the finding was explicitly scoped as a robustness gap, not a live exploit, and its code-level assertions are accurate apart from the corrected reachability detail.

---

## Summary

| ID | Verdict | Severity (final) | Note |
|----|---------|------------------|------|
| CORE-STATE-1 | real | medium | Confirmed verbatim; production-wired SQLite; latent (no attacker-controlled prefix today, but client/config-derived strings already reach `list()` — notifications RPC userId, webhook sourceId) |
| CORE-STATE-2 | real | low | Confirmed unwired (barrels + tests only); production uses raw keychain; default dispatcher never denies; partially intentional per in-code comment |
| CORE-STATE-3 | real | low | Confirmed no redaction layer; sanitizer is injection-only; verified no current call site logs secret values |
| CORE-STATE-4 | real | low | Code facts confirmed; correction: no current path feeds `deserialise()` output into the bumper check, and invalid taint fails closed |
