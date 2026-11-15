# Verified Security Findings — Domain: mcp-plugin

Verifier pass over `/.claude/security-review/2026-06-10/findings/mcp-plugin.md`.
Each finding independently checked against the code on branch `security-remediation`.
Method: opened cited files/lines, traced production wiring, grepped for
mitigations that may live a layer up (orchestrator tool-executor wrapper,
PRE_TOOL_CALL default rules, gateway wiring), and empirically ran the scanner
regexes against the claimed bypass payloads. Judged against
`.claude/rules/security.md` (resource classification is the security model;
for the OWNER all channels share classification by design).

The report's "Summary of what is sound" section was spot-checked and is
accurate (default-deny on UNTRUSTED servers at `gateway.ts:126-136`; MCP prefix
gating via `mcp_<id>_` in toolClassifications; `_classification` validated via
`parseClassification`).

---

## MCP-PLUGIN-1: real

**Verdict: real. Severity: high (confirmed; arguably critical given the
advertised "sandboxed" trust level, but high is defensible — see below).**

The central claim is fully confirmed by code and grep:

- Production path is `initializePluginExecutor` (`sandboxed_executor.ts:49-97`),
  wired from both `tool_infra_plugins.ts:108-113` (startup) and
  `tools_handlers.ts:146-150` (the LLM `plugin_install` tool). For
  `effectiveTrust === "sandboxed"` the ONLY difference from `"trusted"` is a
  `try/catch` that logs and returns the error string (`sandboxed_executor.ts:79-96`).
  The executor itself is the plugin's own `createExecutor(context)` return value
  (line 62), running in the host isolate.
- Plugin module top-level code executes via `await import(modPath)`
  (`loader.ts:199`, also `tools_handlers.ts:122` → `importPluginModule`). The
  daemon runs with full permissions: `deno.json` shows `dev` and `compile` use
  `--allow-all` (deno.json:8,10). So plugin code runs with full host access.
- The real isolation primitives are dead code. `grep` confirms:
  - `createPluginSdk` — ZERO production callers (only `mod.ts` re-export and
    `sdk.ts` definition).
  - `sandbox.ts` (`createSandbox`/`executeSandboxedCode`) — imported only by
    `python_sandbox.ts` and the `mod.ts` barrel; never by any wiring.
  - `python_sandbox.ts` (`createPythonSandbox`) — imported only by the `mod.ts`
    barrel; never by any wiring.
  - No `new Worker` and no `Deno.permissions` restriction anywhere in
    `src/plugin/` or `tool_infra_plugins.ts`.

The report's secondary claim — that even the dead `createSandbox` is bypassable
(`new Function("fetch","Deno", code)` only shadows local identifiers; a Deno
proxy at `sandbox.ts:133-144` throws on `Deno.*` but `globalThis.Deno`,
`import("node:fs")`, `(0,eval)("Deno")` are not blocked) — is also accurate.
(`createSandbox`'s `new Function` would itself trip the scanner's
`new\s+Function\s*\(` weight-3 rule if present in plugin source, but the sandbox
is host code, not plugin source, so that's moot.)

This matches the `.claude/rules/integrations.md` text "The sandbox protects FROM
untrusted plugin code," which the production path does not honor.

Severity: I considered raising to critical. Mitigating factors that keep it at
high: (a) the startup path only loads plugins explicitly `enabled` in
`triggerfish.yaml` (`tool_infra_plugins.ts:66`), which is owner config; (b) the
LLM `plugin_install` path is owner-session-only and additionally requires the
scanner to pass. So reaching unsandboxed execution requires either owner config
or the MCP-PLUGIN-2 chain. The "advertised sandbox is a no-op" gap is real and
high regardless. Keeping severity high.

Evidence: `sandboxed_executor.ts:49-97`, `loader.ts:191-210`,
`tool_infra_plugins.ts:108-113`, `tools_handlers.ts:122,146-150`,
`sandbox.ts:133-165`, `python_sandbox.ts`, `sdk.ts:229`, `deno.json:8,10`,
grep results above.

---

## MCP-PLUGIN-2: real

**Verdict: real. Severity: high (confirmed).**

Confirmed end-to-end, including the scanner bypass (empirically tested).

- `plugin_install` is LLM-exposed: `PLUGIN_TOOL_DEFINITIONS` (`tools_defs.ts:20-37`)
  with an attacker-influenceable `path` param, wired into the live tool set at
  `tool_executor.ts:247` (`buildExtraToolsGetter` pushes `PLUGIN_TOOL_DEFINITIONS`).
- Handler scans then imports: `executePluginInstall` (`tools_handlers.ts:97-182`)
  calls `opts.scanPlugin(pluginDir)` (line 110), then `importPluginModule(modPath)`
  → `await import()` (line 122 → `loader.ts:199`). Import executes top-level code
  with full perms (per MCP-PLUGIN-1).
- No tool floor: `HARDCODED_TOOL_FLOORS` (`constants.ts:81-96`) has no
  `plugin_*` entries. No resource classification is derived for `plugin_*` in
  `security_context.ts` (it only classifies filesystem/shell/URL tools).
- I confirmed the PRE_TOOL_CALL hook does NOT block `plugin_install` in an owner
  session: with no `tool_floor`, no `resource_classification`, and no
  `target_classification`, all four violation predicates in
  `hook_violations.ts:16-73` evaluate false, so `buildEvaluationContext` sets
  every `*_violation` field to `"false"` and the only PRE_TOOL_CALL BLOCK rules
  (`default_rules.ts:47-92`) never fire → ALLOW. The scanner is the sole barrier.
  (For NON-owner sessions, `enforceNonOwnerToolCeiling` at
  `access_control.ts:57-86` default-denies `plugin_install` because no prefix
  matches and there is no floor — so the chain is specifically an OWNER-session
  prompt-injection chain, exactly as the report frames it. Good, precise framing.)
- Scanner is bypassable. I extracted the exact patterns from `scanner.ts:84-148`
  (literal-dot regexes, weight 2, threshold >= 4) and ran the report's four
  payloads through a faithful replica:
  - `Deno["env"]["get"]("AWS_SECRET_ACCESS_KEY")` → score 0, PASSES
  - `const D = globalThis.Deno; await D.readTextFile("/home/u/.triggerfish/...")` → score 0, PASSES
  - `const m = "writeTextFile"; await Deno[m](path, data)` → score 0, PASSES
  - `const C = Deno.Command; new C("sh", { args:["-c", exfil] })` → score 0, PASSES
  None trip the base64 (`[A-Za-z0-9+/]{40,}`) or obfuscation patterns. Confirmed
  the regex heuristic fails open against trivial obfuscation, and because
  malicious behavior runs as a top-level import side effect it needs no
  `eval`/`Function` (the only weight-3 code patterns).

The prompt-injection → RCE chain is real: tainted content ingested into an owner
session can steer the agent to `plugin_install` a directory it controls, and the
only gate is a bypassable scanner. Severity high is correct.

Evidence: `tools_defs.ts:20-37`, `tools_handlers.ts:96-182`,
`scanner.ts:84-158`, `constants.ts:81-96`, `security_context.ts:165-179`,
`access_control.ts:57-86`, `hook_violations.ts:16-105`,
`default_rules.ts:47-92`, `tool_executor.ts:244-252`, plus the empirical scanner
run.

---

## MCP-PLUGIN-3: real

**Verdict: real. Severity: medium (confirmed).**

The SSE transport bypasses the project SSRF standard, and it IS on the
production path (refuted the "dead code" possibility):

- `createTransportForConfig` (`manager_connection.ts:116-125`) builds
  `new SSETransport(cfg.url!, validateMcpServerUrl)` for any URL-based MCP server
  config. `connectAllMcpServers` (line 197-221) uses it for every enabled
  `url` server. So SSE is live, not dead.
- `SSETransport.connect()` validates `#url` ONCE via the injected
  `validateMcpServerUrl` → `validateOutboundUrl` (`transport.ts:154-171`), then
  opens `new EventSource(this.#url)` (line 173). `EventSource` follows 3xx
  redirects natively with no SSRF re-check.
- `SSETransport.send()` issues a raw `fetch(this.#url, …)` with default
  `redirect: "follow"` (`transport.ts:189-197`); the in-code comment explicitly
  claims "no re-check needed since #url is readonly," which is wrong on both
  counts the report names (default redirect-follow defeats the one-time check;
  and the validated DNS result is not pinned, so a low-TTL host that resolved
  public at connect() can resolve private at send()).
- Contrast confirms the standard exists and is bypassed here: the project's
  `safeFetchWithRedirects` (`safe_fetch.ts:94-150`) uses `redirect: "manual"`
  and re-validates every hop, and `core/security/safe_fetch.ts` warns "Never
  call fetch() directly on user-controlled or config-provided URLs." The SSE
  transport uses neither.

The report's exploitability bound is honest: the MCP URL is owner-configured
(not attacker-supplied), and the more common stdio path is command-allowlisted
(`manager_connection.ts:57-89`). So this is "a compromised/semi-trusted MCP host
or an attacker controlling its DNS/redirects can pivot to internal resources,"
which is precisely the threat the SSRF invariant exists to stop. Medium is right.

Evidence: `transport.ts:143-202`, `manager_connection.ts:100-125,148-192`,
`safe_fetch.ts:94-150`.

---

## MCP-PLUGIN-4: real

**Verdict: real. Severity: medium (confirmed).**

Both injection surfaces confirmed; the system prompt is assembled by
concatenating these sections with attacker-influenceable text:

- `buildMcpSystemPrompt` (`executor.ts:207-234`) embeds each server tool's
  `description` verbatim: `lines.push(\`- **${fullName}**: ${tool.description}\`)`
  (line 227). Tool descriptions are untrusted server output from `tools/list`.
  No sanitization on this path.
- `pluginRegistry.getSystemPrompts()` (`registry.ts:90-97`) returns each
  plugin's `systemPrompt` export verbatim.
- Both are pushed into the prompt sections in `buildExtraSystemPromptGetter`
  (`tool_executor.ts:283` for MCP, `tool_executor.ts:288` for plugin prompts),
  with no fencing or control-char stripping.

The report's nuance is accurate: plugin `systemPrompt` DOES pass the injection
scanner (`scanPluginDirectory` runs over all `.ts` files including the source
that exports `systemPrompt`), but the INJECTION_PATTERNS are a small denylist
(`scanner.ts:40-82`), and the MCP tool-description path is scanned by nothing.
Per the project model, deterministic policy gates cannot be overridden by prompt
content, so this does not by itself defeat classification — medium, not
critical, is correct. It is a genuine injection surface chainable with
MCP-PLUGIN-2.

Evidence: `executor.ts:207-234`, `registry.ts:90-97`,
`tool_executor.ts:279-289`, `scanner.ts:40-82`.

---

## MCP-PLUGIN-5: real

**Verdict: real. Severity: low (confirmed).**

Latent fail-open, accurately characterized — no current bypass:

- `createMcpGateway.callTool` (`gateway.ts:237-273`) awaits `fireToolCallHook`
  (line 248) / `fireUnknownServerHook` (line 244) but both helpers return
  `Promise<void>` (`gateway.ts:91-123`) — the `HookResult` is discarded; the only
  real gate is `rejectDisallowedServerStatus` (line 250), which checks
  status, not the hook.
- `createDefaultRules()` (`default_rules.ts:137-147`) registers NO `MCP_TOOL_CALL`
  rule, so the engine returns ALLOW today, and MCP calls are independently gated
  by PRE_TOOL_CALL (via the `mcp_<id>_` prefix injected into toolClassifications
  at `mcp.ts:138-152` / `executor.ts:195-197`) and by the server-status check.
  So no current bypass — confirmed.
- This gateway IS on the live path (`wireMcpServers` creates it at `mcp.ts:111`
  and wraps it in `createMcpExecutor` which calls `gateway.callTool` at
  `executor.ts:115`), so the latent risk is genuine: if an operator later adds an
  `MCP_TOOL_CALL` BLOCK rule (the obvious extension point named in the
  docstring), the gateway will silently ignore it. Also a serviceability gap: the
  discarded result is neither acted on nor logged at the gateway.

Severity low is correct (no active bypass; defense-in-depth/correctness issue).

Evidence: `gateway.ts:90-136,237-273`, `default_rules.ts:137-147`,
`mcp.ts:110-118`, `executor.ts:115,195-197`.

---

## MCP-PLUGIN-6: real

**Verdict: real. Severity: low (confirmed).**

Both sub-claims confirmed; low severity justified by owner-initiated CLI scope:

- Raw fetch: `createPluginReefRegistry` defaults `fetchFn` to `globalThis.fetch`
  (`reef.ts:99`); `fetchPluginContent` (`reef_operations.ts:36`) and
  `fetchRemoteCatalog` (`reef_catalog.ts:101`) call it directly, not `safeFetch`.
  `parseRegistryUrl` (`reef_catalog.ts:65-80`) enforces HTTPS + hostname ==
  base host, which bounds URL-construction SSRF, but raw-fetch redirect-following
  is not re-validated. I confirmed no production wiring injects a safe fetch:
  the only consumer is `src/cli/commands/plugin.ts` (a CLI command), which is
  owner-initiated. No LLM tool invokes Reef install (grep over gateway tools and
  plugin tool handlers for "reef" returns nothing).
- Weak integrity model: `verifyPluginChecksum` (`reef_operations.ts:46-61`)
  compares the downloaded `mod.ts` hash against `entry.checksum`, where `entry`
  comes from the same catalog served by the same origin (`fetchCatalog`). A
  hostile/compromised registry can serve matching content+checksum; the check
  only catches transit corruption, not a malicious registry. Standard
  trust-the-marketplace risk.
- Compounds MCP-PLUGIN-1/2 because Reef-installed plugins ultimately run with
  full host privileges. Reef install is owner-initiated via CLI, hence low.

Evidence: `reef.ts:94-100`, `reef_operations.ts:26-61,128-153`,
`reef_catalog.ts:64-80,97-161`, `cli/commands/plugin.ts:14,46,92-93`, grep
results showing no LLM-tool Reef wiring.

---

## Overall assessment

All six findings are REAL and the severities are well-calibrated. The report is
notably disciplined about scope and exploitability bounds (owner-config vs
attacker-supplied, latent vs active fail-open, default-deny holding for
non-owner sessions). I found no overclaims of the three historical patterns:
none of the cited code was dead-while-production-used-another-path (verified the
SSE transport, the MCP gateway, and `initializePluginExecutor` are all live; the
DEAD code is the unused sandbox, which the report correctly identifies as the
point — the real isolation is absent); no flaw failed CLOSED instead of open
(the scanner and the discarded hook fail OPEN, confirmed); and no
sandbox/sanitizer elsewhere neutralizes the issues (the sandbox/SDK/Pyodide
machinery is never wired; MCP tool descriptions are scanned by nothing).

The two highest-value items are MCP-PLUGIN-1 (advertised plugin sandbox is a
no-op; production runs plugin code with `--allow-all`) and MCP-PLUGIN-2
(prompt-injection → `plugin_install` → RCE, gated only by a bypassable regex
scanner in owner sessions). I empirically verified the scanner bypass payloads.
