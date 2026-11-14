# Security Review — Domain: scheduler

Scope: `src/scheduler/` (cron, triggers, webhooks, service wiring). Verified
against the live production wiring in `src/gateway/` (orchestrator factory,
webhook HTTP route, policy hooks, default rules) to confirm exploitability.

Branch: `security-remediation`. Audited the full current source, not a diff.

---

## SCHEDULER-1: Webhook-driven sessions run with no non-owner classification ceiling (read-ceiling policy gate silently bypassed)

**Severity:** high

**Location:**
- `src/scheduler/service_webhooks.ts:143-151` (`dispatchWebhookSession`)
- `src/scheduler/service_cron.ts:94-101` (`executeCronJob`) — related
- `src/gateway/startup/factory/orchestrator_factory.ts:96-97,203-208`
- `src/core/policy/hooks/hook_violations.ts:62-73` (`detectResourceReadCeilingViolation`)
- `src/core/policy/hooks/default_rules.ts:78-92` (`buildResourceReadCeilingRule`)

**Description:**
A webhook session is created by `dispatchWebhookSession` with **no**
`OrchestratorCreateOptions` — i.e. without `isTrigger: true` and without a
`ceiling`. The only trigger path that sets these is `invokeTriggerCallback`
(`service_trigger.ts:203-207`, passes `{ isTrigger: true, ceiling }`).

Because webhook sessions omit those options, the orchestrator factory does NOT
attach `isTriggerSession`/`getNonOwnerCeiling` (orchestrator_factory.ts:203-208
only sets them `if (isTrigger)`). Downstream:

- In the tool-executor wrapper, `enforceAccessControl`
  (`src/agent/dispatch/access_control.ts:178-200`) takes neither the trigger
  branch (`isTriggerSession?.() ?? false` → false) nor the non-owner branch
  (`config.isOwnerSession && !config.isOwnerSession()` → `isOwnerSession` is
  undefined, so the `&&` short-circuits). It returns `null` — no tool ceiling.
- In `assembleIdentityContext` (`src/agent/dispatch/security_context.ts:153-157`),
  `is_owner` resolves to `false` but `non_owner_ceiling` is left `undefined`
  (never populated — `populateHookInputFields` only sets it when non-null,
  security_context.ts:200-202).
- The PRE_TOOL_CALL read-ceiling rule (`resource-read-ceiling`,
  default_rules.ts:78-92) only BLOCKs when `resource_read_ceiling_violation ==
  "true"`, and `detectResourceReadCeilingViolation` returns `false` whenever
  `ceiling === undefined` (hook_violations.ts:66,70). So the read-ceiling check
  is silently skipped for webhook sessions.

The session taint starts at PUBLIC (`createSession`,
`src/core/types/session.ts:71`). The remaining PRE_TOOL_CALL gate that could
apply is `resource-write-down` (`detectResourceWriteDownViolation`,
hook_violations.ts:48-59), which is taint-based: it blocks only when
`!canFlowTo(sessionTaint, rc)`. With PUBLIC taint,
`canFlowTo(PUBLIC, CONFIDENTIAL)` = `3 >= 1` = **true**
(`src/core/types/classification.ts:59-64`), so reading-up to CONFIDENTIAL /
RESTRICTED resources is NOT blocked. There is no catch-all default-deny for
`is_owner:false` (the full rule set is in `createDefaultRules`,
default_rules.ts:137-147).

The webhook source even carries a `classification`
(`WebhookSourceConfig.classification`, service_types.ts:88-90). But that value
is passed only as `targetClassification` to `executeAgentTurn`
(service_webhooks.ts:150), which gates the final **output** (write-down at
PRE_OUTPUT, `src/agent/dispatch/response_handling.ts:41-67`). It is never used
as the session's tool-call read ceiling. So the configured classification of a
webhook source does NOT constrain what data a webhook-driven agent may read.

Exploitability: the webhook body is attacker-controlled — whoever holds the
shared HMAC secret. The body is embedded verbatim into the agent prompt
(`buildWebhookPrompt`, service_webhooks.ts:130-136). The webhook session uses
the `cronJob` tool profile (orchestrator_factory.ts:148), which includes the
`google`, `github`, `notion`, `x`, `caldav`, `web`, `memory`, `cron`, and
`workflow` tool groups (`src/gateway/tools/defs/tool_profile_defs.ts:152-169`)
— i.e. tools that read the owner's connected accounts and that can create
new persistent cron jobs. A crafted payload can therefore instruct the agent
to read CONFIDENTIAL/RESTRICTED owner data through those integrations; the
read-ceiling rule that is meant to block a non-owner from reading above its
level never fires, so the read succeeds (taint escalates as a legal read-up).
This defeats the per-resource classification gate that is the core product
guarantee — for a session whose prompt comes from an externally-delivered,
shared-secret-authenticated request.

Cron sessions share the same root cause (executeCronJob creates the session
with no ceiling, service_cron.ts:94), but cron `task` text is owner-authored
via the owner-only `cron` tool, so the risk there is lower (owner acting on
their own behalf). The webhook vector is the exploitable one because its prompt
is third-party-supplied.

**Evidence:**
```ts
// src/scheduler/service_webhooks.ts:143-151 — webhook session: NO ceiling/isTrigger
const { orchestrator, session } = await config.orchestratorFactory.create(
  `webhook-${sourceId}`,
);
const result = await orchestrator.executeAgentTurn({
  session,
  message: buildWebhookPrompt(sourceId, event, body),
  targetClassification: classification,   // gates OUTPUT only, not reads
});

// src/scheduler/service_trigger.ts:203-207 — trigger session DOES set them
.orchestratorFactory.create(
  "trigger",
  { isTrigger: true, ceiling: config.trigger.classificationCeiling },
);

// src/core/policy/hooks/hook_violations.ts:62-73 — read-ceiling skipped when ceiling undefined
export function detectResourceReadCeilingViolation(input): boolean {
  const rc = input.resource_classification as ClassificationLevel | undefined;
  const ceiling = input.non_owner_ceiling as ClassificationLevel | undefined;
  return rc !== undefined &&
    input.operation_type === "read" &&
    input.is_owner === false &&
    ceiling !== undefined &&        // <-- false for webhook/cron sessions
    ceiling in CLASSIFICATION_ORDER &&
    !canFlowTo(rc, ceiling);
}
```

**Recommendation:**
Treat webhook (and cron) sessions as non-owner, ceiling-bounded sessions, the
same way trigger sessions are. In `dispatchWebhookSession`, pass
`{ isTrigger: true, ceiling: classification }` (or an equivalent non-owner-
ceiling option) when creating the orchestrator so the source's configured
classification becomes an enforced read ceiling — not just an output gate.
Apply the same to `executeCronJob` using `job.classificationCeiling`. As
defense-in-depth, make the PRE_TOOL_CALL policy default-deny reads above PUBLIC
for any session that is `is_owner:false` with no `non_owner_ceiling` set,
rather than silently allowing them.

---

## SCHEDULER-2: Webhook replay protection is non-persistent and the timestamp is not bound into the HMAC (post-restart replay window)

**Severity:** medium

**Location:**
- `src/scheduler/webhooks/replay_guard.ts:31-45` (in-memory only)
- `src/scheduler/service_webhooks.ts:80-104` (timestamp check then HMAC over body only)
- `src/scheduler/webhooks/webhooks.ts:48-86` (`verifyHmacAsync` signs `body` only)

**Description:**
The webhook anti-replay defense relies entirely on the in-memory replay guard,
which is a plain `Map` with no `StorageProvider` backing
(`createReplayGuard`, replay_guard.ts:31-45). It is wiped on every daemon
restart.

The timestamp freshness check (service_webhooks.ts:80-90) is meant to backstop
replay, but the timestamp is **not** part of the signed payload: HMAC is
computed over `body` only (`verifyHmacAsync(body, context.signature,
source.secret)`, service_webhooks.ts:92; the signer signs `body` alone,
webhooks.ts:69-77). Because `x-timestamp` is unauthenticated, an attacker
replaying a captured valid `(body, signature)` pair simply supplies a fresh
`x-timestamp` to pass the freshness window. The HMAC still matches (body
unchanged), and after a restart the replay guard is empty, so the replay is
accepted.

Each accepted webhook spawns an agent turn (`dispatchWebhookSession`) that can
deliver owner notifications and invoke integration/cron tools, so a replayed
webhook re-executes that side-effecting action.

Within a single daemon lifetime replay is blocked (the guard holds the
signature; an attacker cannot force LRU eviction since they cannot mint new
valid signatures without the secret). The window is therefore: capture a valid
signed request, wait for / induce a daemon restart, replay within the
`maxAgeMs` freshness window (default 300_000 ms; note `maxAgeMs` and
`replayGuardSize` are not plumbed from YAML in `buildSchedulerConfig` /
`buildWebhookSources`, `src/gateway/startup/factory/scheduler_config.ts:19-32`,
so production uses the defaults). The gateway binds `127.0.0.1`
(`src/gateway/server/server.ts:197`), so external delivery implies a reverse
proxy/tunnel in front; an attacker on that path (or a compromised intermediary)
is the capture position.

**Evidence:**
```ts
// src/scheduler/webhooks/replay_guard.ts:31-45 — purely in-memory, lost on restart
export function createReplayGuard(maxSize = 10_000): ReplayGuard {
  const seen = new Map<string, true>();        // no StorageProvider
  ...
}

// src/scheduler/service_webhooks.ts:92 — HMAC covers body only; timestamp not signed
const valid = await verifyHmacAsync(body, context.signature, source.secret);
```

**Recommendation:**
Bind the timestamp (and ideally the sourceId) into the signed payload and
verify the HMAC over `timestamp + "." + body` so the freshness check actually
constrains a captured signature, making the timestamp window a real anti-replay
control independent of the volatile guard. Additionally, persist recently-seen
signatures (or a nonce + timestamp tuple) via `StorageProvider` so the replay
guard survives daemon restarts within the freshness window. If a sender format
cannot sign the timestamp (e.g. GitHub signs body only), enforce a persistent
nonce/replay store as the primary control and treat the in-memory guard as a
cache.

---

## SCHEDULER-3: Dead duplicate HMAC implementation in webhooks/security.ts

**Severity:** low

**Location:** `src/scheduler/webhooks/security.ts:26-85`
(`signWebhook`, `verifyWebhookSignature`)

**Description:**
`signWebhook`/`verifyWebhookSignature` are a second HMAC sign+verify pair that
is exported from the scheduler barrel (`mod.ts:50`) but is **not used in any
production path** — the live webhook handler uses `verifyHmacAsync`
(service_webhooks.ts:19,92), and a correct shared primitive already exists in
`src/core/security/hmac.ts` (`verifyHmacSha256`, which compares raw bytes in
constant time). The only callers of the `security.ts` pair are tests
(`tests/scheduler/webhook_security_test.ts`). This is dead/duplicated security
code: it diverges from the canonical primitive and risks future callers picking
the wrong one. The hand-rolled comparison in `verifyWebhookSignature`
(security.ts:70-85) is itself acceptable (length short-circuit on a fixed
64-char hex digest, per-byte XOR accumulation), so this is a cleanup note, not
an exploitable timing flaw.

**Evidence:**
```ts
// src/scheduler/webhooks/security.ts:62-73 — duplicate verifier, unused in production
export async function verifyWebhookSignature(secret, payload, signature) {
  const expected = await signWebhook(secret, payload);
  if (expected.length !== signature.length) { ...; return false; }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  ...
}
```
(no production importer: `grep` for `signWebhook|verifyWebhookSignature`
outside `webhooks/security.ts`, `mod.ts`, and `*_test.ts` yields nothing.)

**Recommendation:**
Remove `security.ts`'s `signWebhook`/`verifyWebhookSignature` (and their barrel
export) and route any signing/verification through the single canonical
`verifyHmacSha256` primitive in `core/security/hmac.ts`, or have the scheduler's
`verifyHmacAsync` delegate to it. Keep one source of truth for HMAC handling.
