# Security Review — Domain: agent-exec

Scope audited: `src/agent/`, `src/exec/`, `src/models/` on branch
`security-remediation` (full source, not a diff).

Focus areas covered: orchestrator tool-dispatch wrapper as the single
enforcement point; provider API-key handling and accidental logging; abort/
stream handling; exec-environment workspace isolation (path escape, symlinks,
env leakage); `run_command` resource classification; prompt assembly placing
untrusted content next to directives.

## Summary of the enforcement architecture (verified sound)

The single-enforcement-point invariant holds in the agent layer. The raw
`config.toolExecutor` is wrapped exactly once in
`orchestrator.ts:140-141` via `wrapToolExecutorWithEnforcement`, and every
dispatch path (`loop_iteration.ts`, `llm_streaming.ts`,
`security_pipeline.ts`) uses `state.toolExecutor` (the wrapped form). A
grep of all `toolExecutor`/`rawToolExecutor` references confirms the raw
executor is never invoked directly anywhere else.

The PRE_TOOL_CALL pipeline (`security_pipeline.ts` →
`security_context.ts` → `core/policy/hooks/hook_violations.ts`) is
deterministic: the dispatch feeds `resource_classification`,
`operation_type`, `is_outbound_request`, `is_owner`, `tool_floor`, and
`non_owner_ceiling`; `buildEvaluationContext` computes the violation
booleans with `canFlowTo`; default rules BLOCK on them. Taint pre-escalation
(`preEscalateOwnerTriggerTaint`) only escalates upward, so resource-level
write-down enforcement remains intact even for owner sessions. Provider
selection is taint-driven (`runLlmProviderCall`), so higher-classified
sessions route to the configured higher provider. Abort is honored
per-chunk in `consumeProviderStream`, after each LLM call in
`callLlmAndRecordUsage`, and per-call in `orchestrateToolCallBatch`.

Workspace isolation is robust: `isRealPathWithinJail`
(`core/security/path_jail.ts`) resolves symlinks via `Deno.realPathSync`,
walks to the deepest existing ancestor, rejects `..` in the missing suffix,
real-paths the jail, and fails closed. `containsPathTraversal` blocks
absolute/`..` inputs; PUBLIC sessions are denied workspace access;
`resolveExplicitClassifiedPath` enforces read-up/write-down with `canFlowTo`.
Subprocess env is allowlisted (`buildSafeEnv`, `clearEnv: true`) so secrets
are not leaked to `run_command` children; the Claude-CLI allowlist
(`buildClaudeEnv`) deliberately passes auth vars only to the trusted
first-party `claude` binary.

Provider key logging is clean: the two request-body `log.debug` statements
(`triggerfish_request.ts:145`, `fireworks.ts:152`) log only metadata
(message/tool counts, temperature); headers and keys are never logged.
Error paths log `response.text()` bodies but never request headers.

Findings below are the residual issues.

---

## AGENT-EXEC-1: LLM providers read API keys from `Deno.env.get()`, violating the documented config-only platform rule

**Severity:** low

**Location:**
- `src/agent/providers/anthropic.ts:241`
- `src/agent/providers/openai.ts:225`
- `src/agent/providers/google/google.ts:225`
- `src/agent/providers/zai.ts:258`
- `src/agent/providers/zenmux.ts:251`
- `src/agent/providers/openrouter/openrouter.ts:56`
- `src/agent/providers/triggerfish.ts:81,84` (gateway URL + license key)

**Description:**
`.claude/rules/agent.md` ("LLM Provider Auth") and the project memory state
as an *absolute* platform rule: "NEVER use `Deno.env.get()` for API keys in
any provider — no env var fallbacks, ever. Config comes from triggerfish.yaml
only." Seven of the nine providers violate this. `fireworks.ts:271`
(`const apiKey = config.apiKey ?? ""`) is the compliant reference
implementation, demonstrating the intended shape and that the violation is an
inconsistency, not a necessity.

This is reported as **low** rather than a secret-exfiltration finding:
`security.md` explicitly sanctions environment variables as a legitimate
secret source ("Never store secrets in config files (use OS keychain or env
vars)"), so reading a key from the environment is not itself a leak or a
classification bypass. The issue is (a) a clear deviation from a stated
platform invariant the team treats as load-bearing, and (b) a defense-in-depth
gap: an attacker who can influence the daemon's environment (e.g. a
compromised parent process or an injected systemd drop-in) can silently
supply or override an LLM credential without touching `triggerfish.yaml`,
and the provider will use it with no audit trail. The `triggerfish.ts`
gateway-URL fallback additionally allows redirecting all cloud LLM traffic
(including prompt content) to an attacker-chosen host via
`TRIGGERFISH_GATEWAY_URL` if the environment is influenced.

**Evidence:**
```ts
// src/agent/providers/anthropic.ts:241
const apiKey = config.apiKey ?? Deno.env.get("ANTHROPIC_API_KEY");
```
```ts
// src/agent/providers/triggerfish.ts:80-84
const gatewayUrl = config.gatewayUrl ??
  Deno.env.get("TRIGGERFISH_GATEWAY_URL") ??
  "https://api.trigger.fish";
const licenseKey = config.licenseKey ??
  Deno.env.get("TRIGGERFISH_LICENSE_KEY") ?? "";
```
Compliant counter-example:
```ts
// src/agent/providers/fireworks.ts:271
const apiKey = config.apiKey ?? "";
```

**Recommendation:**
Remove the `Deno.env.get(...)` fallbacks from all providers and the
triggerfish gateway-URL fallback, matching `fireworks.ts`
(`config.apiKey ?? ""` and an explicit "not configured" throw). Resolve
credentials exclusively from `triggerfish.yaml` (`secret:`/keychain refs).
Also correct the now-stale JSDoc comments that advertise the env fallback
(`anthropic.ts:25`, `openai.ts:21`, `triggerfish.ts:60-61`). If runtime env
support is genuinely desired, it must be a deliberate, documented exception —
not seven silent per-provider divergences from an "absolute" rule.

---

## AGENT-EXEC-2: `run_command` resource classification can be evaded by shell obfuscation, weakening the resource-classification gate

**Severity:** medium

**Location:**
- `src/agent/dispatch/command_classification.ts:181-240,260-312`
- `src/core/security/command_path_extraction.ts:179-217` (path detection)

**Description:**
Resource classification of `run_command` is the product's core security
guarantee for the exec tool: every command must be classified by the
resource it targets, and PRE_TOOL_CALL must gate execution on that
classification vs. session taint. `classifyShellCommandResource` implements
this by statically splitting the command on shell operators
(`splitOnShellOperators`) and, per segment, attempting (1) repo-cache lookup,
(2) URL domain classification, (3) integration-CLI prefix fallback, and
(4) filesystem path extraction (`extractCommandPaths`).

Each of these recognizers is a static string heuristic. A command that
references a higher-classified resource *without emitting a recognizable
path-like or URL-like token* classifies as PUBLIC for that segment, and
because the per-segment results are combined with `maxClassification`, a
single unrecognized segment contributes only PUBLIC. The PRE_TOOL_CALL
write-down/read-ceiling checks then see `resource_classification = PUBLIC`
(or the next-highest recognized segment) and do not block. Examples that
evade `isPathLikeToken` / `extractCommandPaths` while still reading a
sensitive file at execution time:

- Command substitution: `cat $(printf '%s' L2V0Yy9zaGFkb3c= | base64 -d)`
  — no `/`-bearing token; the path materializes only inside `/bin/sh`.
- Variable indirection: `f=/etc/shadow; cat "$f"` — `"$f"` is not path-like;
  `$f` only resolves in the shell.
- Here-strings / xargs piping a path produced by an earlier opaque command.

`detectShellInjection` (`exec/sanitize.ts:133`) only rejects null bytes and
newlines, and the `ExecRunner` denylist is empty by default, so none of these
forms are otherwise blocked. The default for *recognized-but-unmapped* paths
is fail-safe CONFIDENTIAL (`constants.ts:120`), but that default never
applies when no token is recognized as a path in the first place.

Exploitability assessment: this is reachable in production — `run_command`
is wired through the wrapped executor with a live `getWorkspacePath`
(`service_startup.ts:81`, `orchestrator_factory.ts:198`), and the LLM fully
controls the `command` string, so prompt injection that reaches a tool call
(the documented threat model) can craft an obfuscated read. It is rated
**medium** rather than high because (a) it requires the session to already be
permitted to call `run_command` and the attacker to want a *write-down /
outbound* of higher-classified data (read-up within an owner session is
allowed by design), and (b) fully parsing arbitrary POSIX shell statically is
not tractable, so this is an inherent limitation of the approach rather than a
single missed branch. Nonetheless it is a real gap in a control the project
documents as "THE security model."

**Evidence:**
```ts
// src/core/security/command_path_extraction.ts:179-196 — token must look
// like a path; $(...), "$f", base64 blobs do not match.
function isPathLikeToken(token: string): boolean {
  if (token.length === 0) return false;
  if (token.startsWith("-")) return false;
  if (token.includes("://")) return false;
  ...
  if ((token.includes("/") || token.includes("\\")) && !token.startsWith("-")) {
    return true;
  }
  return false;
}
```
```ts
// src/agent/dispatch/command_classification.ts:226-227
const paths = extractCommandPaths(segment);
if (paths.length === 0) return "PUBLIC"; // segment with no recognized path → PUBLIC
```

**Recommendation:**
Treat statically-unparseable commands as fail-closed rather than PUBLIC.
Options, in increasing strength: (a) when a segment's executable is a known
data-reading command (`cat`, `dd`, `xxd`, `base64`, `curl`, `scp`, etc.) and
no resource could be classified, escalate that segment to the configured
filesystem default (CONFIDENTIAL) instead of PUBLIC; (b) flag the presence of
command substitution (`$(`, backticks) or variable-only path arguments and
treat the command as at least the filesystem default; (c) document explicitly
that `run_command` resource classification is best-effort against
non-obfuscated commands and rely on the bumpers/ceiling layer for hard
guarantees. At minimum, add a regression test covering `$(...)`, `"$var"`,
and base64-decoded path arguments.

---

## AGENT-EXEC-3: PRE_CONTEXT_INJECTION hook hardcodes `source_type: "OWNER"` for every user turn regardless of session ownership

**Severity:** low

**Location:** `src/agent/loop/agent_turn.ts:34-51` (`firePreContextHook`)

**Description:**
`firePreContextHook` fires PRE_CONTEXT_INJECTION for the inbound user
message with `input: { content: extractText(message), source_type: "OWNER" }`
unconditionally. The session may be a non-owner session (e.g. a WebChat
visitor, who per project docs is never the owner) or a trigger session, yet
the message is always labeled `OWNER`. The default untrusted-input rule
(`default_rules.ts:31`) blocks `source_type === "UNTRUSTED"`; labeling the
turn `OWNER` guarantees that rule can never fire on a user turn.

I verified this is **not** an exploitable classification bypass in the current
wiring: no production code path passes `source_type: "UNTRUSTED"` for a live
user turn (UNTRUSTED/LOG_FILE are used for tool-injected external content,
which is sanitized by its own readers), and all *real* enforcement that
depends on ownership uses the correctly-derived `is_owner`
(`chat_turn_execution.ts:123`, surfaced into the PRE_TOOL_CALL context via
`assembleIdentityContext` and into PRE_OUTPUT write-down via
`response_handling.ts:47-49`). So no classification decision actually hinges
on this label for the user turn. It is reported as **low / defense-in-depth**:
the hardcoded value is inaccurate provenance, defeats the only hook stage
intended to vet inbound content by trust level, and is a latent foot-gun if a
future rule keys off PRE_CONTEXT_INJECTION `source_type` expecting it to
reflect the real session identity.

**Evidence:**
```ts
// src/agent/loop/agent_turn.ts:40-46
const result = await config.hookRunner.evaluateHook(
  "PRE_CONTEXT_INJECTION",
  {
    session,
    input: { content: extractText(message), source_type: "OWNER" },
  },
);
```

**Recommendation:**
Derive `source_type` from the actual session: `OWNER` only when
`config.isOwnerSession?.()` is true, otherwise a non-owner/untrusted value
(e.g. `USER` or `UNTRUSTED` depending on channel trust). This restores
PRE_CONTEXT_INJECTION as a meaningful trust gate and keeps lineage/provenance
honest. Low effort, file already in scope.

---

## Areas examined with no finding

- **Single enforcement point** — raw executor wrapped once; no bypass path
  (verified by exhaustive grep).
- **Symlink / path-traversal escape in workspace and `run_command` cwd** —
  `isRealPathWithinJail` resolves real paths and fails closed; per-call cwd
  and filesystem tools both re-validate against the jail.
- **Env-var leakage to subprocesses** — `buildSafeEnv` allowlist +
  `clearEnv: true`; secrets excluded for `run_command`; Claude-CLI auth vars
  scoped to the trusted first-party binary only.
- **API keys in logs** — request-body debug logs carry metadata only; headers
  never logged; Google's `?key=` URL is never logged.
- **Abort/stream handling** — signal checked per-chunk and per-call;
  cancellation returns a typed cancelled result.
- **Taint monotonicity / owner write-down** — `escalateTaint` is upward-only;
  resource write-down still fires for owner writes to lower-classified
  resources; provider selection is taint-driven.
- **Multi-agent (team) authz & isolation** — members spawn at fresh PUBLIC
  taint with explicit ceilings; `team_status`/`team_message`/`disband` check
  creator/member/lead by session ID (not LLM-controllable).
- **`simulate_tool_call`** — pure dry-run, no execution or taint mutation.
- **Unsafe deserialization / eval** — no `eval`/`Function`; team
  deserialization parses the daemon's own KV store (not an untrusted boundary).
- **`console.*` logging** — none in scope; all logging via `createLogger`.
