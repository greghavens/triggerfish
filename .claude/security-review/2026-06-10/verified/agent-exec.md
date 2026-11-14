# Verified Security Review — Domain: agent-exec

Adversarial verification of `/var/home/venom/triggerfish/.claude/security-review/2026-06-10/findings/agent-exec.md`.
Each finding was independently checked against the source on branch
`security-remediation`, tracing call sites, centralized enforcement (orchestrator
tool-executor wrapper, PRE_TOOL_CALL hooks, gateway wiring), and the project
security model in `.claude/rules/security.md` / `.claude/rules/agent.md`.

Summary: all three findings are REAL. Severities as rated by the author are
correct. The report is unusually disciplined — it explicitly scopes each finding,
distinguishes exploitable-vs-defense-in-depth, and does not overclaim. No
false positives found.

---

## AGENT-EXEC-1: real

**Verdict: real. Severity: low (confirmed — not upgraded).**

The cited code matches exactly. All eight call sites use `Deno.env.get()` as an
API-key/config fallback:

- `src/agent/providers/anthropic.ts:241` — `config.apiKey ?? Deno.env.get("ANTHROPIC_API_KEY")`
- `src/agent/providers/openai.ts:225` — `config.apiKey ?? Deno.env.get("OPENAI_API_KEY")`
- `src/agent/providers/google/google.ts:225` — `config.apiKey ?? Deno.env.get("GOOGLE_API_KEY") ?? ""`
- `src/agent/providers/zai.ts:258` — `config.apiKey ?? Deno.env.get("ZAI_API_KEY") ?? ""`
- `src/agent/providers/zenmux.ts:251` — `config.apiKey ?? Deno.env.get("ZENMUX_API_KEY") ?? ""`
- `src/agent/providers/openrouter/openrouter.ts:56` — `configKey ?? Deno.env.get("OPENROUTER_API_KEY") ?? ""`
- `src/agent/providers/triggerfish.ts:81` — `Deno.env.get("TRIGGERFISH_GATEWAY_URL")`
- `src/agent/providers/triggerfish.ts:84` — `Deno.env.get("TRIGGERFISH_LICENSE_KEY")`

`grep -rn "Deno.env.get" src/agent/providers/` returns exactly these eight lines,
confirming the count and that no other provider is affected.

The premise the finding rests on is verified as a real, load-bearing project
rule. `.claude/rules/agent.md` ("LLM Provider Auth") states verbatim: "**NEVER use
`Deno.env.get()` for API keys in any provider** — no env var fallbacks, ever. This
is an absolute platform rule. Config comes from triggerfish.yaml only. The
empty-string default (`config.apiKey ?? ""`) is correct." MEMORY.md repeats this
under "LLM Provider Auth (CRITICAL)". The cited compliant reference is accurate:
`src/agent/providers/fireworks.ts:272` is `const apiKey = config.apiKey ?? "";`
with an explicit throw — exactly the shape the rule prescribes.

Stale JSDoc claims also verified: `anthropic.ts:25` and `openai.ts:21` both read
"Falls back to ANTHROPIC_API_KEY/OPENAI_API_KEY env var", and `triggerfish.ts:60`
reads "Falls back to TRIGGERFISH_LICENSE_KEY env var" — documentation that
advertises the very behaviour the rule forbids.

Severity assessment (agreeing with low): I tried to refute the low rating in both
directions.
- Not higher: `security.md` ("Never store secrets in config files (use OS keychain
  or env vars)") sanctions environment variables as a legitimate secret source, so
  reading a key from the environment is not itself a leak or a classification
  bypass. An attacker who can inject env vars into the daemon process already has
  substantial host access; this is a defense-in-depth / audit-trail gap, not a
  primary exfiltration vector. The finding states this explicitly and honestly.
- Not lower (i.e. not a non-finding): it is a real, unambiguous divergence from a
  rule the team documents as "absolute" in two places, across seven providers,
  with one compliant counter-example proving the intended shape — so it is a
  legitimate finding, not noise.

The `triggerfish.ts` gateway-URL fallback observation is also valid: a
`TRIGGERFISH_GATEWAY_URL` env override would redirect all cloud LLM traffic
(prompt content included) to an attacker-chosen host. Same caveat applies — it
requires environment influence — so it stays within the low rating.

Left low.

---

## AGENT-EXEC-2: real

**Verdict: real. Severity: medium (confirmed).**

This is the substantive finding and the mechanism is verified end-to-end against
code, not just at the cited lines.

Cited code confirmed:
- `src/agent/dispatch/command_classification.ts:226-227` — `classifyCommandSegment`:
  `const paths = extractCommandPaths(segment); if (paths.length === 0) return "PUBLIC";`
- `src/core/security/command_path_extraction.ts:179-196` — `isPathLikeToken` only
  returns true for tokens that contain `/`/`\`, start with `/ ./ ../ ~`, or are a
  Windows drive. `$(...)`, `"$f"`, and bare base64 blobs contain no separator and
  are not matched.

I traced the full enforcement path to confirm the gap is exploitable (fails OPEN,
not closed):

1. Dispatch (`security_pipeline.ts:247` `dispatchSecurityEnforcedToolCall`) calls
   `assembleSecurityContext` → `resolveResourceClassification`
   (`security_context.ts:166`). For `run_command`, `classifyShellCommandResource`
   ALWAYS returns a non-null result: `{ classification: highest /* default PUBLIC */,
   operation: "write", param: command }` (`command_classification.ts:307-311`).
2. For an obfuscated read (e.g. `cat $(printf '%s' L2V0Yy9zaGFkb3c= | base64 -d)`),
   no segment yields a recognized path → every segment returns `"PUBLIC"` →
   `resource_classification = PUBLIC`, `operation_type = "write"`.
3. `preEscalateOwnerTriggerTaint` (`security_pipeline.ts:51`) escalates the owner
   session to PUBLIC — a no-op for a PUBLIC session. **The taint escalation that is
   the upstream half of the write-down protection never fires.**
4. PRE_TOOL_CALL: `detectResourceWriteDownViolation` (`hook_violations.ts:48`) with
   `rc=PUBLIC, opType=write, taint=PUBLIC` computes `!canFlowTo(PUBLIC,PUBLIC)` =
   `!true` = false → no block. Tool executes; `/etc/shadow` is read.
5. `escalateResponseClassification` (`access_control.ts:145`) only escalates if the
   tool result JSON-parses and contains a `_classification` field. Raw file content
   has none → no escalation. Session stays PUBLIC; content is now in history at
   PUBLIC and PRE_OUTPUT (`response_handling.ts:37`) allows exfiltration
   (`target=PUBLIC, taint=PUBLIC`).

Contrast with the RECOGNIZED case `cat /etc/shadow`, which I verified behaves
correctly: `classifyRealPath("/etc/shadow")` falls through to the default
`CONFIDENTIAL` (`constants.ts:120` `DEFAULT_PATH_CLASSIFICATION`), so
`preEscalateOwnerTriggerTaint` raises the owner session to CONFIDENTIAL, and any
later write/outbound to a PUBLIC sink is blocked by write-down. Existing tests
(`tests/core/security/command_path_extraction_test.ts:261,286`) assert exactly
this for `/` and `/etc/passwd`. The obfuscation defeats this by suppressing the
classification that drives the escalation. So the difference between
"blocked" and "leaked" is purely whether the static tokenizer recognized the path —
the documented "THE security model" gap is real.

Refutation attempts (all failed to clear the finding):
- A sandbox/sanitizer elsewhere? `detectShellInjection` (`exec/sanitize.ts:133`)
  rejects only null bytes and CR/LF — confirmed; it does not touch `$(...)`/`$var`.
  The `ExecRunner` denylist defaults to empty (`exec/runner.ts:63`:
  `options?.denyList ?? []`). No backstop.
- Bumpers? `assessBumpersForToolCall`/`checkBumpersBlock`
  (`security_pipeline.ts:171`, `chat_session_assembly.ts:71`) gate on the resource
  classification level; with `PUBLIC` they cannot trip. No backstop.
- Dead/unwired code? `run_command` is live in production with a real
  `getWorkspacePath` (`gateway/startup/service_startup.ts:81`,
  `gateway/startup/factory/orchestrator_factory.ts:198`), and the raw executor is
  wrapped exactly once (`orchestrator.ts:140-141`) — verified, so this path is the
  actual boundary, not a stale alternative.
- Fail-closed instead of open? No — the unrecognized-segment default is explicitly
  `PUBLIC` (lowest), not the `CONFIDENTIAL` filesystem default. It fails OPEN.

No regression tests exist for `$(...)`, `"$var"`, or base64-decoded path arguments
(`grep` for `base64`/`printf`/substitution in the command tests returns nothing
relevant), confirming the finding's "add a regression test" recommendation is not
already satisfied.

Severity: medium is correct. It is genuinely reachable under the documented
prompt-injection-to-tool-call threat model and undermines a core advertised
control, but (a) it requires the session to already be permitted to call
`run_command` and an attacker goal of write-down/exfil of higher data, and
(b) fully parsing arbitrary POSIX shell statically is intractable, so this is an
inherent limitation rather than a single missed branch. The author flags both
caveats accurately. Not high, not low.

---

## AGENT-EXEC-3: real

**Verdict: real. Severity: low (confirmed — defense-in-depth / correctness).**

Cited code confirmed: `src/agent/loop/agent_turn.ts:44` hardcodes
`input: { content: extractText(message), source_type: "OWNER" }` for every user
turn, with no derivation from session ownership.

I verified the finding's own (commendably careful) claim that this is NOT an
exploitable bypass in the current wiring:
- `firePreContextHook` (`agent_turn.ts:35`) is the only place the agent fires
  PRE_CONTEXT_INJECTION. `grep` for `PRE_CONTEXT_INJECTION` / `source_type` shows
  no production path passes `source_type: "UNTRUSTED"` for a live user turn — the
  other `source_type` literals (`channel_message`, `mcp_server`, `memory_access`,
  `obsidian_vault`, `google_api`, `agent_response`) are lineage-record fields, not
  hook inputs.
- The default `untrusted-input` rule (`default_rules.ts:31`) blocks
  `source_type === "UNTRUSTED"`. Hardcoding `"OWNER"` means that rule can never
  fire on a user turn — i.e. the only inbound-trust gate is effectively dead for
  user input — but nothing today routes untrusted user input through this hook
  expecting it to block.
- Real ownership enforcement uses the correctly-derived signal:
  `gateway/chat_turn_execution.ts:123` sets
  `isOwnerSession: () => state.activeSessionId === state.ownerSessionId` (session-ID
  comparison, not LLM-controllable). That flows into PRE_TOOL_CALL via
  `assembleIdentityContext` (`security_context.ts:148`) and into PRE_OUTPUT
  write-down via `response_handling.ts:47-49`. No classification decision hinges on
  the hardcoded PRE_CONTEXT_INJECTION `source_type` for the user turn.

So the impact is exactly what the report says: inaccurate provenance and a latent
foot-gun (a future rule keying off PRE_CONTEXT_INJECTION `source_type` would
misbehave), with no current exploit. Low is correct — I considered downgrading to
"non-finding," but a security-relevant hook stage being silently inert is a
legitimate defense-in-depth observation, and the file is already in scope with a
low-effort fix. Left low.

Note: the recommendation references `config.isOwnerSession?.()`, which does exist
on the orchestrator config and is wired (verified above), so the fix is feasible
within scope.

---

## Assessment of the report's "verified sound" claims (spot-checked)

- Single enforcement point: confirmed. `wrapToolExecutorWithEnforcement` is applied
  exactly once at `orchestrator.ts:140-141`; `rawToolExecutor` is invoked only
  inside the wrapper (`access_control.ts:237`). No direct raw-executor call path.
- `escalateResponseClassification` correctly rejects non-lattice `_classification`
  values via `parseClassification` (`access_control.ts:160-168`) — accurate.
- Env-var subprocess allowlist (`exec/sanitize.ts` `buildSafeEnv` /
  `buildClaudeEnv`) matches the description: base allowlist excludes secrets;
  Claude auth vars scoped to the Claude binary only. Accurate.

These corroborate that AGENT-EXEC-2 is the genuine boundary gap (no other layer
catches the obfuscated read after classification returns PUBLIC).
