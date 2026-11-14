# Verified Security Review — Domain: channels

Verifier pass over `/var/home/venom/triggerfish/.claude/security-review/2026-06-10/findings/channels.md`.
Each finding was independently checked against the live code: adapters in `src/channels/`,
gateway wiring in `src/gateway/startup/channels/` + `src/gateway/chat_*`, the dive wizard,
the role filter, and the PRE_OUTPUT owner exemption. The report's framing matches the project
security model (owner sees the full tool set; non-owner is filtered + ceiling-enforced), and the
"OWNER shares classification across channels" design rule does not invalidate any of these — every
finding is about *who is tagged owner*, not channel-level classification differences.

---

## CHANNELS-1: real

**Verdict: real. Severity: high (confirmed).**

The two cited fail-open defaults exist exactly as quoted and are on live (wired) paths.

Evidence checked:
- `src/channels/discord/adapter.ts:64` — `const isOwner = ownerId !== undefined ? senderId === ownerId : true;` Unconfigured `ownerId` ⇒ every sender is owner.
- `src/channels/telegram/adapter.ts:56-58` — `checkTelegramOwnership` returns `true` when `ownerId === undefined`.
- Discord is wired: `wireChannels` (`channels.ts:80-85`) calls `wireDiscordChannel` whenever a `discord` config block exists (it does not even require `botToken` to be present to attempt). `channels_discord.ts:61` routes `msg.isOwner !== false` to `chatSession.executeAgentTurn` (owner turn). Telegram is wired identically (`channels.ts:76-78`, `channels_telegram.ts:81`).
- Owner turn → full tool set: `filterToolsForRole` (`role_filter.ts:85-90`) returns all tools unmodified when `isOwner` is true (includes `run_command`, `write_file`, `secret_save`, `browser_*`, `cron`). Confirmed wired via `chat_turn_execution.ts:131` (`filterTools: filterToolsForRole`) and the owner-output write-down exemption at `response_handling.ts:47-49` (`effectiveTarget = isOwnerOutput ? outputTaint : targetClassification`). So an attacker tagged owner gets unauthenticated RCE + secret access.
- Discord wizard reachability confirmed in TWO places: `prompt_discord.ts:47-61` ("optional" owner ID; `if (discordOwner.length > 0) { config.ownerId = discordOwner; }` — key omitted when blank), and the dive wizard `wizard_generators.ts:87-95` does the same (`if (answers.discordOwnerId.length > 0) { cfg["ownerId"] = ...}`). `collectDiscordConfig` (`wizard_channels.ts:107-118`) does not force a value. A user who leaves it blank ships an open-to-everyone Discord owner console.
- Telegram nuance confirmed: `prompt_telegram.ts:27` and `wizard_generators.ts:84` both coerce blank to `parseInt(...) || 0`, and `selective_channels.ts:105` does the same. `0` is not a real Telegram ID, so the wizard path fails closed for Telegram; the adapter default is still fail-open if `ownerId` is hand-removed from YAML.
- Contrast confirmed: WhatsApp `adapter.ts:172` is fail-closed (`ownerPhone !== undefined && from === ownerPhone`); Signal pins `isOwner:false`. No startup guard requires an owner identifier (grep of `src/gateway/startup/` + `src/dive/` finds none).

Refutation attempts that FAILED (i.e., the finding survives):
- Dead/unwired path? No — Discord and Telegram are both in `wireChannels` and reach the owner turn.
- Fails closed elsewhere? No — the role filter passes all tools for owners; there is no secondary owner re-verification on Discord/Telegram (unlike Google Chat, which re-fetches from the Chat API).
- Neutralized by a sanitizer? No.

Severity high is correct: unauthenticated RCE/secret exfiltration for the Discord wizard default. I considered raising to critical but the trigger requires the operator to either leave the Discord owner blank in the wizard or hand-edit YAML — a misconfiguration the product actively invites rather than a zero-config default. High is the right call.

---

## CHANNELS-2: real

**Verdict: real. Severity: medium → low (downgraded). Justification below.**

The `isOwner !== false` pattern is present on the cited owner-routing decisions and is a genuine latent fail-open, but it is defense-in-depth, not a presently-exploitable hole.

Evidence checked:
- `src/gateway/chat_channel_routing.ts:102` — `if (msg.isOwner !== false) { return orchestrateOwnerAgentTurn(...) }`. `undefined` ⇒ owner.
- `channels_telegram.ts:71,81` and `channels_discord.ts:51,61` use the same `msg.isOwner !== false`.
- Safe form already used for WhatsApp (`channels_whatsapp.ts:130`, `:116`) and Google Chat (`channels_googlechat.ts:92,97`): `msg.isOwner === true`.
- The wired adapters always set a concrete boolean `isOwner` on the message (`discord/adapter.ts:98`, `telegram/adapter.ts:107`), so `undefined` does not arise on these paths today — confirmed.
- The report's `CliChannel.simulateInput` example is accurate (`src/channels/cli/channel.ts:80` emits `handler({ content: text })` with no `isOwner`), but I verified `createCliChannel`/`simulateInput` is **not** imported anywhere in `src/` outside the barrel export (`mod.ts:17`) — it is not wired into `wireChannels` and `simulateInput` is a test seam. So the example is illustrative of the latent risk, not a live trigger.

Refutation: the finding correctly self-describes as a latent fail-open ("Today the wired adapters always set isOwner to a concrete boolean"). There is no concrete production message that arrives with `undefined isOwner` on these paths. The danger is purely "a future adapter/refactor forgets to set it." That is a real hardening gap (it violates default-deny as a coding pattern), but it is not an exploitable vulnerability in the current tree.

Severity: I downgrade medium → low. It is a code-quality / defense-in-depth inconsistency with no current exploit path. The fix (standardize on `=== true`) is still warranted and cheap.

---

## CHANNELS-3: real

**Verdict: real. Severity: low (confirmed).**

Evidence checked:
- `src/channels/email/adapter.ts:118-124` — `resolveEmailOwnership` returns `senderAddress === ownerEmail`, with the same fail-open default (`ownerEmail === undefined ⇒ true`). `From:` is attacker-controlled.
- Grep across `src/` for `dkim|dmarc|spf|authentication-results` returns **zero** hits — confirmed no message-authentication check anywhere.
- Email adapter is **not wired**: `wireChannels` (`channels.ts`) never calls `createEmailChannel`; the only references are the barrel export (`channels/mod.ts:56`) and the dive prompt. Confirmed via grep — no `createEmailChannel` call in `src/gateway/`.
- It is a public export with a wizard prompt, so the unsafe trust decision ships in the supported surface.

Refutation: the only thing that bounds this to low is that the adapter is unreachable in the runtime — confirmed accurate. If wired, this would be the same high-severity unauthenticated-owner compromise as CHANNELS-1. Low is correct for the current tree. Note the finding's secondary point (the `ownerEmail === undefined ⇒ true` fail-open) is the same bug class as CHANNELS-1/4 and is also accurate.

---

## CHANNELS-4: real

**Verdict: real. Severity: low (confirmed).**

Evidence checked:
- `src/channels/slack/adapter.ts:75` — `const isOwner = ownerId !== undefined ? msg.user === ownerId : true;` Identical fail-open to CHANNELS-1.
- Slack is **not wired**: grep finds no `createSlackChannel` call in `src/gateway/`; only the barrel export (`channels/mod.ts:41`). Confirmed unreachable in production runtime.

Refutation: low is justified solely by the adapter being unwired (verified). If Slack is ever wired, this becomes high (same as CHANNELS-1). Correct as written.

---

## CHANNELS-5: real

**Verdict: real. Severity: low (confirmed).**

Evidence checked:
- `src/channels/webchat/adapter.ts:67` — `const allowedOrigins = config.allowedOrigins ?? ["*"];` with the origin check skipped entirely when the list contains `"*"` (`:68-73`). No token/auth on upgrade.
- `src/channels/webchat/adapter.ts:108-112` — every inbound frame is hard-pinned `isOwner: false`, `sessionTaint: "PUBLIC"`. Confirmed: a WebChat connection can never reach owner tools regardless of origin.
- WebChat is **not wired** by `wireChannels` (no `createWebChatChannel` call in `src/gateway/`; only barrel export `mod.ts:53`). Confirmed.

Refutation: the security-relevant fields are statically pinned, so the wildcard CORS does not grant privilege — it only allows unauthenticated PUBLIC sessions to consume LLM resources. The report correctly characterizes this as a low-severity hardening / resource-abuse issue, not a privilege bug. Correct.

---

## CHANNELS-6: real

**Verdict: real. Severity: low (confirmed).**

Evidence checked:
- `src/channels/whatsapp/adapter.ts:154` — `if (mode === "subscribe" && token === verifyToken)` uses non-constant-time `===` on a secret.
- A `timingSafeEqual(a, b)` is exported for exactly this purpose at `src/core/security/hmac.ts:24-27` (constant-time per-byte, length-public). Confirmed available.
- Per-message authenticity is enforced by the timing-safe HMAC: `verifyWhatsAppSignature` (`adapter.ts:94`) → `verifyHmacSha256` (`hmac.ts:50-65`, constant-time digest compare over raw body), and it fails closed when `appSecret` is missing (`adapter.ts:99-102`). Confirmed — the `===` is only on the one-time Meta subscription handshake, not per-message auth.

Refutation: impact is limited as the report states — the verify_token is only checked during the one-time subscription handshake initiated by Meta, and timing-based extraction over the network against Meta's caller is impractical. Low is correct. The fix is trivial and consistent with the rest of the security layer, so the finding is valid.

---

## CHANNELS-7: real

**Verdict: real. Severity: low (confirmed).**

Evidence checked:
- `src/channels/pairing.ts:124-126` — 6-digit code (`generateSixDigitCode`), 5-minute TTL (`PAIRING_CODE_TTL_MS`); single-use enforced (`verifyCode` rejects `used` at `:163-165` and marks used at `:171-176`).
- `src/gateway/chat_access_control.ts:42-49` — a non-owner DM matching `^\d{6}$` triggers `pairingService.verifyCode`. On success it calls `channelState.userSessions.addClassification(senderId, pairingClassification)` (`:51-54`).
- `addClassification` (`src/channels/user_sessions.ts:101-102`) only sets a classification override in `runtimeOverrides`; it never sets `isOwner`. Confirmed — a successful pair is a non-owner gaining `pairingClassification` (default INTERNAL per `chat_channel_routing.ts:61-62`), NOT owner compromise. The report's bounded-impact framing is accurate.
- Throttle is optional: the only rate limiter is created when `channelConfig.nonOwnerRateLimit` is present (`chat_channel_routing.ts:66-68`) and applied at `:116-119`. With no `nonOwnerRateLimit`, pairing attempts run at full messaging throughput. Confirmed.
- Pairing is only enabled where `pairing:` is configured — verified it is wired for Signal/WhatsApp/Google Chat (`channels_signal.ts:245`, `channels_whatsapp.ts:239`, `channels_googlechat.ts:179,193`), not Discord/Telegram. So this is reachable on the wired Signal/WhatsApp/GoogleChat non-owner paths when pairing is on.

Refutation: bounded but real. 1,000,000-space + 5-min TTL + single active code makes a blind guess unlikely-per-window, but with no mandatory throttle an attacker can burn the full code space across windows, and the absence of an always-on attempt cap violates the project's default-deny posture for security-sensitive verification. Low is appropriate given the ceiling is INTERNAL non-owner, not owner. Valid finding.

---

## Notes on the report's "found sound" section

I spot-checked the "Areas reviewed and found sound" claims and they hold up:
- WhatsApp HMAC is constant-time over the raw body and fails closed without `appSecret` (`hmac.ts:50-65`, `adapter.ts:99-102`) — confirmed.
- Google Chat owner status is not taken from the unsigned envelope (`googlechat/dispatch.ts` sets `isOwner:false` on the raw path at `:156,162`; owner `true` at `:210` is on the API-verified path) — consistent with the recent commit `d2820462` "verify Google Chat owner claims against the Chat API."
- Signal/WebChat hard-pin `isOwner:false` — confirmed.

These do not change any verdict.
