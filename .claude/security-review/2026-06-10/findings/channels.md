# Security Review — Domain: channels

Scope: `src/channels/` (all adapters + shared router/session/pairing/rate-limit/ripple/groups), verified against the live gateway wiring in `src/gateway/startup/channels/` and `src/gateway/chat_*`.

Live (wired) channels per `src/gateway/startup/channels/channels.ts::wireChannels`: **Telegram, Discord, WhatsApp, Google Chat, Signal**. The **Slack, Email, and WebChat** adapters are exported and have dive-wizard config prompts but are NOT connected by `wireChannels` — they are unreachable in the current production runtime, which caps the severity of issues confined to them.

Owner-trust model (verified): adapters set `ChannelMessage.isOwner` per message; the gateway routes `isOwner === true` (WhatsApp/GoogleChat) or `isOwner !== false` (Telegram/Discord/`routeChannelMessage`) to `orchestrateOwnerAgentTurn` / `chatSession.executeAgentTurn`, which run on the owner session with the **full unfiltered tool set** (`filterToolsForRole` returns all tools incl. `run_command`, `write_file`, `edit_file`, `secret_*`, `browser_*`, `cron`; see `src/gateway/tools/defs/role_filter.ts:85-90`) and with owner output exempt from write-down enforcement (`effectiveTarget = outputTaint` in `src/agent/dispatch/response_handling.ts:47-49`). Therefore any path that lets a non-owner be tagged `isOwner: true` (or non-`false`) is an unauthenticated/lightly-authenticated full-compromise.

---

## CHANNELS-1: Discord and Telegram adapters grant OWNER to every sender when `ownerId` is unconfigured (fail-open authentication)

**Severity:** high

**Location:**
- `src/channels/discord/adapter.ts:64` (`resolveDiscordSenderContext`)
- `src/channels/telegram/adapter.ts:56-58` (`checkTelegramOwnership`)
- Reached via `src/gateway/startup/channels/channels_discord.ts:61` and `channels_telegram.ts:81` (`if (msg.isOwner !== false)` → owner turn)

**Description:**
Both wired adapters default the owner check to **true** when no owner identifier is configured:

- Discord: `const isOwner = ownerId !== undefined ? senderId === ownerId : true;`
- Telegram: `if (ownerId === undefined) return true;`

When `ownerId` is absent, *every* inbound sender is dispatched as the owner. The gateway then runs that message through `chatSession.executeAgentTurn` on the owner session, which exposes the complete privileged tool set (`run_command`, `write_file`, `secret_save`, `browser_*`, `cron`, …) and bypasses output write-down checks. The result is unauthenticated remote code/command execution and secret access for anyone who can DM the bot or post where the bot can see it.

This is directly reachable for **Discord** through the supported onboarding wizard: `src/cli/config/prompts/prompt_discord.ts:47-61` labels the owner ID "optional" and **omits `ownerId` from the generated config entirely when left blank** (`if (discordOwner.length > 0) { config.ownerId = discordOwner; }`). A user who accepts the default produces a config with no `ownerId`, silently turning the Discord bot into an open-to-everyone owner console.

For **Telegram** the wizard coerces an empty entry to `0` (`parseInt(ownerId,10) || 0`, `prompt_telegram.ts`), which fails closed (no real Telegram ID is 0), so the Telegram exposure requires hand-editing `triggerfish.yaml` to drop `ownerId`. The adapter default itself is still fail-open.

No startup validation requires an owner identifier (grep over `src/gateway/startup/` and `src/dive/` finds no "missing ownerId" guard). This violates security invariant #9 (default DENY) and #5 (the deterministic owner/enforcement model).

**Evidence:**
```ts
// src/channels/discord/adapter.ts:64
const isOwner = ownerId !== undefined ? senderId === ownerId : true;

// src/channels/telegram/adapter.ts:56-58
function checkTelegramOwnership(fromId, ownerId) {
  if (ownerId === undefined) return true;   // ← every sender becomes owner
  ...
}

// src/cli/config/prompts/prompt_discord.ts:47-61  (owner ID is "optional"; omitted if blank)
const discordOwner = await Input.prompt({ message: "Your Discord user ID (optional, snowflake)", default: "" });
...
if (discordOwner.length > 0) { config.ownerId = discordOwner; }   // no ownerId key when blank
```
Contrast the correct fail-closed direction in WhatsApp:
```ts
// src/channels/whatsapp/adapter.ts:172
const isOwner = ownerPhone !== undefined && from === ownerPhone;  // unconfigured ⇒ nobody is owner
```

**Recommendation:**
Make the unconfigured case fail closed in both adapters: when `ownerId`/owner identifier is undefined, treat **no** sender as owner (`return false`), matching WhatsApp and Signal. Additionally, reject channel startup if owner-bearing channels (Discord/Telegram/Slack) are enabled without an owner identifier, and make the Discord wizard prompt mandatory (or warn loudly that an empty owner ID means the bot answers strangers as a non-owner). The same fix should be applied to Slack (`adapter.ts:75`) for consistency even though Slack is currently unwired (see CHANNELS-4).

---

## CHANNELS-2: Gateway owner routing uses fail-open `isOwner !== false` instead of `isOwner === true`

**Severity:** medium

**Location:**
- `src/gateway/chat_channel_routing.ts:102` (`routeChannelMessage`)
- `src/gateway/startup/channels/channels_telegram.ts:71,81`
- `src/gateway/startup/channels/channels_discord.ts:51,61`

**Description:**
The Telegram/Discord gateway handlers and the shared `routeChannelMessage` decide owner vs non-owner with `if (msg.isOwner !== false)`. This treats `undefined` (and any non-`false` value) as the owner. WhatsApp and Google Chat use the safe form `msg.isOwner === true`. Today the wired adapters always set `isOwner` to a concrete boolean, so `undefined` does not arise on these paths — but the inconsistency is a latent fail-open: any future adapter, refactor, or re-emitted message that forgets to set `isOwner` (e.g. `CliChannel.simulateInput` already emits `{ content }` with no `isOwner`, `src/channels/cli/channel.ts:80`) would be silently promoted to owner. A defense-in-depth control for the platform's #1 guarantee should default to deny.

**Evidence:**
```ts
// src/gateway/chat_channel_routing.ts:102
if (msg.isOwner !== false) {
  return orchestrateOwnerAgentTurn(...);   // undefined ⇒ owner
}
// vs the safe form already used for WhatsApp:
// src/gateway/startup/channels/channels_whatsapp.ts:130
if (msg.isOwner === true) { ... }
```

**Recommendation:**
Standardize every owner-routing decision on `msg.isOwner === true`. Owner status should require an explicit, positively-verified `true`, never the absence of `false`.

---

## CHANNELS-3: Email adapter authenticates the owner from the spoofable `From:` header (no SPF/DKIM/DMARC)

**Severity:** low

**Location:**
- `src/channels/email/adapter.ts:118-124` (`resolveEmailOwnership`)
- `src/channels/email/imap_parsers.ts:11-14` (`parseImapFrom`)

**Description:**
Inbound email owner status is decided by string-comparing the parsed `From:` address to `ownerEmail`. The `From:` header is attacker-controlled and is never validated against SPF, DKIM, DMARC, or `Authentication-Results` (grep across `src/` finds no such check). Any party who can deliver mail to the configured IMAP inbox with a forged `From: owner@…` would be treated as the owner — the same full-tool-access compromise as CHANNELS-1.

This is rated **low** only because the Email adapter is **not wired** into the runtime: `wireChannels` (`src/gateway/startup/channels/channels.ts`) never calls `createEmailChannel`, so no live message flow reaches `resolveEmailOwnership`. The adapter is, however, a public export (`src/channels/mod.ts:56`) with a dive-wizard prompt (`promptEmailConfig`), so the unsafe trust decision ships in the supported API surface.

**Evidence:**
```ts
// src/channels/email/adapter.ts:118-124
function resolveEmailOwnership(senderAddress, ownerEmail) {
  return ownerEmail !== undefined ? senderAddress === ownerEmail : true;  // From: is forgeable + fail-open default
}
```
(Note the same unconfigured-default fail-open as CHANNELS-1: `ownerEmail` undefined ⇒ every sender owner.)

**Recommendation:**
Before wiring the Email adapter, require and verify a message-authentication signal: parse `Authentication-Results`/DKIM and reject owner status unless DKIM-aligned with `ownerEmail`'s domain and SPF/DMARC pass. Independently, change the `ownerEmail === undefined` branch to return `false`.

---

## CHANNELS-4: Slack adapter shares the fail-open owner default (`ownerId` undefined ⇒ owner)

**Severity:** low

**Location:** `src/channels/slack/adapter.ts:75` (`attachSlackMessageListener`)

**Description:**
`const isOwner = ownerId !== undefined ? msg.user === ownerId : true;` — identical fail-open pattern to CHANNELS-1. Currently **low** because Slack is not wired by `wireChannels` (no `createSlackChannel` call anywhere in `src/gateway/`). If Slack is ever enabled, this becomes the same high-severity unauthenticated-owner exposure.

**Evidence:**
```ts
// src/channels/slack/adapter.ts:75
const isOwner = ownerId !== undefined ? msg.user === ownerId : true;
```

**Recommendation:**
Fix together with CHANNELS-1: default to `false` when `ownerId` is unconfigured, and gate Slack startup on a configured owner ID before the adapter is wired.

---

## CHANNELS-5: WebChat defaults to wildcard CORS origin (`["*"]`) and never authenticates connections

**Severity:** low

**Location:**
- `src/channels/webchat/adapter.ts:67-73` (`enforceWebChatUpgrade`)
- `src/channels/webchat/adapter.ts:104-112` (`attachSocketEventHandlers`)

**Description:**
The WebChat WebSocket server defaults `allowedOrigins` to `["*"]`, so when origins are unconfigured any web origin may open a socket; there is no token/auth on the upgrade. This is acceptable *by design* for WebChat because every WebChat sender is pinned to `isOwner: false` + `sessionTaint: PUBLIC` (`adapter.ts:108-110`), so a connection grants only non-owner PUBLIC access — it cannot reach owner tools. The residual risk is unauthenticated PUBLIC sessions consuming agent/LLM resources and the broad default being easy to deploy unintentionally. Severity is **low**: WebChat is also not wired into `wireChannels` today, and the security-relevant fields are hard-pinned regardless of origin.

**Evidence:**
```ts
// src/channels/webchat/adapter.ts:67-73
const allowedOrigins = config.allowedOrigins ?? ["*"];
if (!allowedOrigins.includes("*")) { /* origin check only when not wildcard */ }

// src/channels/webchat/adapter.ts:108-110  (sender can never be owner)
isOwner: false,
sessionTaint: "PUBLIC" as ClassificationLevel,
```

**Recommendation:**
Default `allowedOrigins` to an explicit list (or empty = deny) rather than `["*"]`, and before wiring WebChat add a connection token / rate limit. Keep the `isOwner:false`/PUBLIC pinning.

---

## CHANNELS-6: WhatsApp webhook subscription-challenge token compared with non-timing-safe `===`

**Severity:** low

**Location:** `src/channels/whatsapp/adapter.ts:150-158` (`verifyWhatsAppWebhook`)

**Description:**
The GET subscription handshake compares the Meta-supplied `hub.verify_token` to the configured `verifyToken` using `===`, which is not constant-time and can in principle leak the secret byte-by-byte via response timing. Impact is limited: this token is only used during the one-time webhook subscription handshake (Meta is the caller), not for per-message authentication — per-message authenticity is enforced by the timing-safe HMAC in `verifyWhatsAppSignature` → `verifyHmacSha256` (`src/core/security/hmac.ts:50-66`, correct constant-time digest comparison, fails closed without `appSecret`). Still, the codebase already exports a `timingSafeEqual` for exactly this purpose.

**Evidence:**
```ts
// src/channels/whatsapp/adapter.ts:154
if (mode === "subscribe" && token === verifyToken) {   // non-constant-time secret compare
  return new Response(challenge, { status: 200 });
}
```

**Recommendation:**
Compare `token` against `verifyToken` with `timingSafeEqual` (`src/core/security/hmac.ts`), consistent with the rest of the security layer.

---

## CHANNELS-7: Pairing-code verification has no mandatory rate limiting (6-digit brute force)

**Severity:** low

**Location:**
- `src/channels/pairing.ts:145-200` (`verifyCode`)
- `src/gateway/chat_channel_routing.ts:116-135` (rate limiter applied only if `nonOwnerRateLimit` configured)
- `src/gateway/chat_access_control.ts:30-66` (`attemptPairingVerification`)

**Description:**
Pairing codes are 6 digits (1,000,000-space) with a 5-minute TTL and are single-use. A non-owner DM containing `^\d{6}$` triggers `pairingService.verifyCode`. The only throttle is the optional per-user rate limiter in `routeChannelMessage`, which is created only when `nonOwnerRateLimit` is present in channel config (`registerChannelState`, `chat_channel_routing.ts:66-68`). With no `nonOwnerRateLimit`, an attacker can attempt codes at full messaging throughput. Impact is bounded: a successful guess grants only `pairingClassification` (default INTERNAL) as a **non-owner** (it calls `addClassification`, never sets `isOwner`), so this is privilege *gain to a classification ceiling*, not owner compromise. The narrow code space + always-on TTL + single active code make practical exploitation noisy but not impossible.

**Evidence:**
```ts
// src/channels/pairing.ts:124-142  — 6-digit code, 5-min TTL
const code = generateSixDigitCode();           // 000000–999999
const expiresAt = new Date(now() + PAIRING_CODE_TTL_MS);  // 5 minutes

// src/gateway/chat_channel_routing.ts:116  — throttle only if configured
if (channelState.rateLimiter && !channelState.rateLimiter.isAllowed(effectiveSenderId)) { ... }
```

**Recommendation:**
Enforce an always-on per-sender attempt cap on pairing verification (independent of the optional `nonOwnerRateLimit`), e.g. lock out a channel/sender after N failed `^\d{6}$` attempts within the TTL window, and/or widen the code to 8 digits. Log failed pairing attempts at WARN with the sender ID.

---

## Areas reviewed and found sound (no finding)

- **Google Chat owner verification** (`googlechat/verify.ts`, `googlechat/dispatch.ts`): owner status is never granted from the unsigned PubSub payload; owner-claimed events are re-fetched from the Chat API by resource name and matched against an API-resolved owner identity, with a strict resource-name regex (anti-path-injection), a replay guard (TTL + bounded LRU), and fail-closed transient/definitive handling. Session/space/text come from the authoritative API message, not the envelope. Solid.
- **HMAC verification** (`core/security/hmac.ts`): constant-time digest comparison over the **raw** body bytes (captured before JSON parse in `handleWhatsAppWebhookPost`), fails closed on missing `appSecret`/header/malformed hex. Correct.
- **Taint application for non-owner turns** (`gateway/chat_turn_execution.ts:258`): uses `updateTaint`=`escalateTaint`=`maxClassification` (`core/types/session.ts:115-121`) — monotonic, cannot lower taint; no write-down via the non-owner ceiling.
- **Signal adapter**: logs in as the owner's own number and pins every inbound message to `isOwner:false`/PUBLIC, routing exclusively through the non-owner `handleChannelMessage` path (fail-closed). Daemon spawn (`signal/setup/setup_daemon.ts`) uses `Deno.Command` with an args array (no shell) and owner-sourced values — no command injection.
- **Message chunking** (`telegram/adapter.ts::chunkMessage`, shared by Discord/Signal): pure string slicing on length; no cross-session/classification leakage.
- **Outbound SSRF**: Email uses `safeFetch` (`email/adapter.ts:99`); WhatsApp receives an injected SSRF-checked fetch in production (`channels_whatsapp.ts:222` → `ssrfSafeFetchWrapper`); Google Chat/PubSub target hardcoded first-party Google hosts only (documented). No user-controlled outbound hostnames in the adapters.
- **Ripple** (`ripple.ts`): presence/typing state only, no security decisions or secret handling.
- **Router** (`router.ts`): `sendWithRetry` exponential backoff is bounded by `maxRetries`; logs failures with context. Note its module doc claims it "Applies classification checks on inbound/outbound flows," but it does not — classification/write-down enforcement happens in the agent PRE_OUTPUT hook and turn execution, not the router. The doc comment is misleading but not a vulnerability (enforcement exists one layer up).
