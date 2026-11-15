# Gateway Security Review — 2026-06-10

Domain: `gateway` (paths: `src/gateway/`)
Branch: `security-remediation`

Scope: WebSocket server authn/origin handling; session takeover; notification
write-down enforcement; startup wiring (tools/integrations/channels
classification); agent_tools registration completeness vs. the policy
enforcement wrapper.

## Summary of posture

The gateway is, on the whole, soundly designed against the project's invariants:

- **WebSocket control plane is always authenticated in production.** The sole
  production caller (`startup/services/chat_session_network.ts:234`) creates the
  server with a fresh 256-bit per-start token (`ensureGatewayToken`) plus
  `allowedOrigins: ["null"]`, and the server binds to `127.0.0.1` only
  (`server/server.ts:197`). Cross-site WebSocket hijack is blocked at the Origin
  check (browsers always send a non-null Origin → 403); the bearer-token check
  uses `timingSafeEqual` (`core/security/websocket_auth.ts:63`). Header-size and
  message-size limits are enforced before parsing.
- **No session takeover.** The `/chat` WebSocket path always executes as the
  owner (`chat.ts:174` → `orchestrateOwnerAgentTurn`), and that path is only
  reachable by the authenticated owner on loopback. Non-owner channel traffic is
  routed through a separate non-owner path that applies a classification ceiling
  (`chat_turn_execution.ts:237`).
- **Cross-session/channel tools enforce write-down deterministically** using
  injected session taint (never LLM args): `sessions.ts:135`
  (`canFlowTo(source.taint, target)`), `tools/session/channel_executors.ts:60`
  (`canFlowTo(currentTaint, channelClassification)`),
  `tools/session/session_executors.ts:88` (read ceiling),
  `tools/trigger/trigger_context_executor.ts:82` (trigger write-down).
- **Tool enforcement is delegated correctly.** The gateway threads `hookRunner`,
  `toolClassifications`, `pathClassifier`, `domainClassifier`,
  `toolFloorRegistry`, `isOwnerSession`, and `getNonOwnerCeiling` into the
  orchestrator config (`chat_turn_execution.ts:95`). The agent-layer wrapper
  (`agent/dispatch/access_control.ts:223`) applies PRE_TOOL_CALL access control
  and **defaults to DENY for unmapped tools / non-owners**
  (`enforceNonOwnerToolCeiling`, `access_control.ts:85`). Powerful gateway-owned
  management tools (`config_manage`, `mcp_manage`, `daemon_manage`,
  `spine_manage`) carry no classification entry/floor and are therefore
  unreachable by non-owners; `daemon_manage` restart additionally requires an
  out-of-band confirm prompt (`tools/executor/executor_daemon_manage.ts:65`).
- **No secret leakage into gateway logs.** Notification/secret/credential paths
  log only operation names, nonces, and key *names* (`mcp_manage` returns
  `env_keys`, never values — `tools/executor/executor_mcp_manage.ts:96`).

The findings below are a latent write-down gap in the notification fan-out and
three low-severity hardening/cleanup items.

---

## GATEWAY-1: NotificationService fan-out ignores classification (latent write-down past channel classification)

**Severity:** Medium

**Location:** `src/gateway/notifications/notifications.ts:84-90` (fanOut), `:93-118`
(deliver), `:149-151` (registerChannel); type at
`src/core/types/notification.ts:35-38`

**Description:**
`NotificationService.deliver()` accepts a `classification` field and persists it,
but the actual delivery routine `fanOut()` sends the message to **every**
registered delivery channel with no `canFlowTo` check against the destination
channel's classification. The `DeliveryChannel` registration interface carries
only `{ name, send }` — the per-channel classification (which *is* known at
registration time, e.g. Telegram `PUBLIC`, Google Chat `INTERNAL`,
`startup/channels/channels_telegram.ts:117`,
`startup/channels/channels_googlechat.ts:166`) is deliberately discarded, so
even an enforcing fan-out would have nothing to compare against.

The classification is plumbed end-to-end and then dropped: the scheduler computes
`classification: sessionTaint` and passes it to `deliver()`
(`src/scheduler/service_output.ts:79-84`, `:108-113`), and a trigger run can be
tainted up to its `classification_ceiling` (default `CONFIDENTIAL`) by accessing
classified resources. That CONFIDENTIAL/RESTRICTED notification is then fanned
out to all registered owner channels regardless of each channel's classification.

This is **inconsistent with the sibling code path**: the agent-callable
channel-send (`tools/session/channel_executors.ts:55-70`) enforces
`canFlowTo(currentTaint, channelClassification)` for the *same* channels and
blocks the write-down. The notification path does not.

Exploitability is bounded by configuration. All notification channels are
registered to deliver to the *owner's* address only (`telegram-${ownerId}`,
`signal-${ownerPhone}`, `whatsapp-${ownerPhone}`, the owner's Google Chat space,
and the loopback-authenticated Tidepool/CLI sockets), and the project's
classification model treats all of the owner's own channels as equivalent for the
owner. The real write-down occurs when a registered channel destination is a
*shared* space whose lower `classification` reflects non-owner readers — most
plausibly the Google Chat owner space (`channels_googlechat.ts:127`, default
`INTERNAL`): a RESTRICTED trigger notification is delivered into an INTERNAL
shared space, leaking classified data to that space's non-owner members. The
deterministic no-write-down invariant ("CONFIDENTIAL data cannot reach a PUBLIC
channel") is not enforced at this boundary even though the metadata to enforce it
exists upstream.

**Evidence:**
```ts
// src/gateway/notifications/notifications.ts
const channels: DeliveryChannel[] = [];
// ...
/** Attempt delivery to all registered channels. ... */
async function fanOut(message: string): Promise<boolean> {
  if (channels.length === 0) return false;
  const results = await Promise.allSettled(
    channels.map((ch) => ch.send(message)),   // no classification check
  );
  return results.some((r) => r.status === "fulfilled");
}
// deliver(): persists notification.classification, then:
const delivered = await fanOut(notification.message);  // classification dropped
```
```ts
// src/core/types/notification.ts — channel has no classification to gate on
export interface DeliveryChannel {
  readonly name: string;
  readonly send: (message: string) => Promise<void>;
}
```
Contrast (the path that DOES enforce it):
```ts
// src/gateway/tools/session/channel_executors.ts
if (!canFlowTo(currentTaint, opts.channelClassification)) {
  return `Write-down blocked: ... ${opts.channelClassification} ...`;
}
```

**Recommendation:**
Carry the channel classification on `DeliveryChannel` (set it at each
`registerChannel(...)` site from the same `classification` already used for the
adapter), and in `fanOut` skip any channel where
`!canFlowTo(notification.classification ?? "PUBLIC", channel.classification)`,
logging the suppressed write-down at WARN. Default a missing notification
classification to the session taint at the call site rather than `undefined` so
the gate fails closed. This aligns the notification boundary with the
channel-send boundary and the documented no-write-down invariant.

---

## GATEWAY-2: Debug trigger endpoint fails open when no token is configured

**Severity:** Low

**Location:** `src/gateway/server/server.ts:101-117` (handleDebugTriggerEndpoint),
reached from `:266-271`

**Description:**
`POST /debug/run-triggers` authenticates only when `options.token` is set; when
no token is configured it logs "Debug endpoint auth not configured, proceeding"
and fires a scheduler trigger unauthenticated. This is a fail-*open* default for
an action-bearing endpoint (it triggers an agent run). In production the token is
always set (the sole caller passes `ensureGatewayToken()`,
`startup/services/chat_session_network.ts:233`) and the server binds to
`127.0.0.1`, so this branch is unreachable in the shipped wiring — hence Low. The
concern is purely the inverted default: a future caller that omits the token (or
a refactor that makes the server reachable off-loopback) would expose an
unauthenticated trigger-fire.

**Evidence:**
```ts
if (!options?.token) {
  log.debug("Debug endpoint auth not configured, proceeding", {
    operation: "debug/run-triggers",
  });
} else {
  const provided = extractBearerToken(request);
  if (provided === null || !timingSafeEqual(provided, options.token)) {
    return new Response("Unauthorized", { status: 401 });
  }
  // ...
}
```

**Recommendation:**
Fail closed: when `options.token` is absent, return 401/503 for
`/debug/run-triggers` rather than proceeding. The debug endpoint should require
an explicitly configured token to be reachable at all.

---

## GATEWAY-3: `sessions.send` JSON-RPC trusts caller-supplied targetClassification and never delivers content

**Severity:** Low

**Location:** `src/gateway/sessions.ts:123-149` (sessionsSend);
RPC entry `src/gateway/server/handlers_rpc.ts:117-140`

**Description:**
The `EnhancedSessionManager.sessionsSend` used by the JSON-RPC `sessions.send`
method takes `targetClassification` from the caller and checks
`canFlowTo(source.taint, targetClassification)`, but it never reads the target
session and never delivers `_toId`/`_content` (both parameters are unused). So
(a) the write-down check is evaluated against a caller-asserted classification
rather than the actual target session's taint, and (b) the method is effectively
a no-op that returns `{ delivered: true }` without delivering anything.

Not exploitable in the current wiring: the RPC transport is owner-only
(gateway token + null-origin on loopback), and because no content is actually
delivered there is no flow to subvert. The correct, content-delivering path is
the agent tool `executeSessionsSend`
(`tools/session/session_executors.ts:172-205`), which looks up the target and
uses `target.taint` (not a caller value) as the classification. This finding is
about the inconsistency/dead semantics of the RPC variant.

**Evidence:**
```ts
async sessionsSend(
  fromId: SessionId,
  _toId: SessionId,          // unused — never delivered to
  _content: string,          // unused — never delivered
  targetClassification: ClassificationLevel,  // caller-supplied
): Promise<Result<{ delivered: true }, string>> {
  const source = await base.get(fromId);
  if (!source) return { ok: false, error: `Source session not found: ${fromId}` };
  if (!canFlowTo(source.taint, targetClassification)) { /* block */ }
  return { ok: true, value: { delivered: true } };  // nothing delivered
}
```

**Recommendation:**
Either remove the unused JSON-RPC `sessions.send` surface, or make it derive the
classification from the resolved target session (`target.taint`) and actually
deliver — mirroring `executeSessionsSend`. Deriving from the target prevents a
caller from asserting a permissive classification, and removes the misleading
`{ delivered: true }` for a no-op.

---

## GATEWAY-4: Notification priority router is dead/unwired code

**Severity:** Low

**Location:** `src/gateway/notifications/priority_router.ts` (whole module);
only re-exported at `src/gateway/notifications/mod.ts:9` and
`src/gateway/mod.ts:31`

**Description:**
`createPriorityRouter` (priority-based routing: critical→all channels,
normal→primary only, low→batch; plus deduplication) is never instantiated or
called anywhere in production — only re-exported by barrels. As a result the
documented priority routing and dedup behaviors are not applied: every
notification is fanned out to all channels regardless of priority
(see GATEWAY-1). Per the project's stance on dead/unwired code this is a
cleanup note, but it is also a latent maintenance hazard — a reader may assume
priority routing/dedup is in effect when it is not.

**Evidence:**
```
$ grep -rn "createPriorityRouter|priorityRouter|\.route\(|isDuplicate|recordDelivery" src --include=*.ts | grep -v _test.ts | grep -v priority_router.ts
src/gateway/notifications/mod.ts:9:  export { createPriorityRouter } from "./priority_router.ts";
src/gateway/mod.ts:31: export { createPriorityRouter } from "./notifications/priority_router.ts";
# (only barrel re-exports — no instantiation, no .route()/.isDuplicate() callers)
```

**Recommendation:**
Either wire the priority router into `createNotificationService.deliver` (so
`route()`/`isDuplicate()`/`recordDelivery()` actually govern fan-out — naturally
combinable with the GATEWAY-1 classification gate), or remove the module to avoid
implying behavior that is not in effect.
