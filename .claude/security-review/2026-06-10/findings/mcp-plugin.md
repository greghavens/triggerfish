# Security Review — Domain: mcp-plugin

Scope: `src/mcp/`, `src/plugin/` on branch `security-remediation`.
Focus: MCP proxy policy gating, untrusted server output, default-deny for
unclassified servers, hostile protocol parsing, plugin sandbox (Pyodide/WASM)
escape, capability gating, trust in plugin-declared metadata.

Method: traced production wiring (`src/gateway/startup/infra/mcp.ts`,
`src/gateway/startup/tools/tool_infra_plugins.ts`,
`src/gateway/startup/tools/tool_infra_assembly.ts`,
`src/agent/dispatch/security_pipeline.ts`, `access_control.ts`,
`security_context.ts`) to confirm reachability and whether enforcement is
applied a layer up before recording each finding.

## Summary of what is sound (not findings)

- **Unclassified MCP servers are default-denied at the gateway.** In
  `mcp.ts:128` a connected server is registered with status `CLASSIFIED` only
  when it carries a config classification, otherwise `UNTRUSTED`.
  `gateway.ts:126-136 rejectDisallowedServerStatus` rejects `UNTRUSTED`/`BLOCKED`
  before any tool runs. Default-deny holds.
- **Classified MCP tool calls are gated by `PRE_TOOL_CALL`** via the
  `mcp_<id>_` prefix injected into `toolClassifications`/
  `integrationClassifications` (`mcp.ts:138-152`); non-owner ceiling
  (`access_control.ts:57-86`) and integration write-down
  (`security_pipeline.ts:82-111`) both consult that prefix map and default-deny
  unknown prefixes. MCP tools the agent invokes flow through
  `dispatchSecurityEnforcedToolCall` as ordinary tool executors.
- **MCP taint escalates to the server's configured classification** on every
  call via `escalateToolPrefixTaint` (`access_control.ts:89-122`); the
  `classificationCeiling` (`manager_env.ts:121-126`) caps a misconfigured
  server's declared level. The server cannot self-declare a classification —
  it comes from owner config, not the wire.
- **`_classification` from tool output is validated** with
  `parseClassification` before driving taint (`access_control.ts:145-173`), so a
  hostile response cannot inject a non-lattice level.

---

## MCP-PLUGIN-1: Plugins execute with full host privileges — no runtime sandbox; "sandboxed" trust level is a try/catch wrapper only

**Severity:** high

**Location:** `src/plugin/sandboxed_executor.ts:49-97`, `src/plugin/loader.ts:191-210`, `src/gateway/startup/tools/tool_infra_plugins.ts:108-113`

**Description:**
The product treats plugins as a sandboxed extension surface ("The sandbox
protects FROM untrusted plugin code", `.claude/rules/integrations.md`; manifest
`trust: "sandboxed"`). In the actual production path there is **no sandbox at
all**. A plugin is loaded with a plain `await import(modPath)`
(`loader.ts:199`), which executes the module's top-level code in the host
isolate with the daemon's full Deno permissions (the daemon runs with
`--allow-read --allow-write --allow-run --allow-net --allow-env --allow-ffi`).
The executor is then obtained by calling the plugin's own
`createExecutor(context)` (`sandboxed_executor.ts:62`). For `effectiveTrust ===
"sandboxed"` the only difference from `"trusted"` is a `try/catch` that logs
errors (`sandboxed_executor.ts:79-96`) — the code still runs with full host
access.

The real isolation primitives — `createSandbox` (`new Function("fetch","Deno",
…)` with shadowed identifiers, `sandbox.ts:159-164`) and `createPythonSandbox`
(Pyodide WASM, `python_sandbox.ts`) plus the capability-aware `createPluginSdk`
(`sdk.ts`) — are exported from `plugin/mod.ts` but **never invoked by any
production wiring**. `grep` for `createSandbox`/`createPythonSandbox`/
`executePluginCode`/`executeSandboxedCode` outside tests yields only the barrel
re-exports; the gateway uses `initializePluginExecutor`, not the sandbox.

Consequently a "sandboxed" plugin can read/write any file the daemon can
(secrets keychain files, `triggerfish.yaml`, session stores), spawn
subprocesses, open arbitrary network connections, and read the environment —
none of the declared-endpoint allowlisting, Deno-API blocking, or classification
ceiling described in the sandbox docs apply.

Even the dead `createSandbox` would not contain malicious code if it were wired:
`new Function("fetch","Deno", code)` only shadows the local identifiers `fetch`
and `Deno`; `globalThis.Deno`, `import("node:fs")`, `(0,eval)("Deno")`, or
`globalThis.fetch` bypass it entirely.

**Evidence:**
```ts
// loader.ts — module top-level code runs here, full host perms
const mod = await import(`${modPath}${cacheBust}`);          // line 199

// sandboxed_executor.ts — "sandboxed" only adds a try/catch
const executor = await plugin.exports.createExecutor(context); // line 62
if (effectiveTrust === "trusted") { return executor; }         // line 64
...
return async (name, input) => {                                // line 79
  try { return await executor(name, input); }                  // runs with full perms
  catch (err) { log.warn("Sandboxed plugin executor error", ...); ... }
};

// sandbox.ts — the (unwired) "sandbox" is a closure with shadowed params
const fn = new Function("fetch","Deno",
  `return (async function() { ${code} })()`);                  // line 159
```

**Recommendation:**
Either (a) genuinely sandbox plugin execution (run plugin code in a Deno Worker
spawned with a restrictive `deno.permissions` set, or in the Pyodide WASM path
that already exists, and route all host access through the capability-checked
`PluginSdk`), or (b) if plugins are intended to be fully trusted host code,
remove the "sandboxed" trust level and the dead `sandbox.ts`/`python_sandbox.ts`
and document plainly that installing a plugin is equivalent to running
arbitrary code as the daemon user. Do not advertise "sandboxed" while executing
with full privileges. Track removal of the misleading dead code as cleanup.

---

## MCP-PLUGIN-2: `plugin_install` is an ungated LLM-callable tool that loads arbitrary code via `import()`, gated only by a bypassable regex scanner (prompt-injection → RCE)

**Severity:** high

**Location:** `src/plugin/tools_defs.ts:20-37`, `src/plugin/tools_handlers.ts:96-182`, `src/plugin/scanner.ts:84-255`, `src/core/security/constants.ts:81-95` (HARDCODED_TOOL_FLOORS)

**Description:**
`plugin_install` is exposed to the LLM as a built-in tool
(`PLUGIN_TOOL_DEFINITIONS`, wired at `tool_executor.ts:247` and
`tool_infra_assembly.ts:132-148`). It accepts an attacker-influenceable `path`
parameter and calls `importPluginModule(modPath)` →
`await import()` (`tools_handlers.ts:122`), executing that module's top-level
code with the daemon's full permissions (see MCP-PLUGIN-1). There is **no tool
floor** on `plugin_install`/`plugin_reload`/`plugin_scan`: `HARDCODED_TOOL_FLOORS`
contains no plugin entries, and no resource classification is derived for
`plugin_*` tools in `security_context.ts` (it only classifies filesystem, shell,
and URL tools). For an owner session this is intended; the exposure is the
**prompt-injection-to-tool-abuse chain**: a tainted document, web page, email,
or MCP/tool response that the agent ingests can instruct the agent to call
`plugin_install` with an attacker-supplied directory, and the only thing
standing between that and code execution is the static scanner.

The scanner (`scanPluginDirectory`) is a regex heuristic that fails open against
trivial obfuscation. It uses literal-dot patterns such as
`/Deno\.env\.(get|toObject|set|delete|has)\s*\(/` (scanner.ts:97) and
`/Deno\.(readFile|readTextFile|writeFile|...)\s*\(/` (scanner.ts:113). All of the
following execute full host access and score **0** (no match), passing the scan:

- `Deno["env"]["get"]("AWS_SECRET_ACCESS_KEY")` — bracket access
- `const D = globalThis.Deno; await D.readTextFile("/home/u/.triggerfish/...")` — aliasing
- `const m = "writeTextFile"; await Deno[m](path, data)` — computed member
- `const C = Deno.Command; new C("sh", { args:["-c", exfil] })` — aliased subprocess

Because top-level module code runs on `import()`, the malicious behavior does not
even need `eval`/`Function` (the only weight-3 code patterns); it runs as a side
effect of loading. The weight-2 plain-dot forms only reach the failing threshold
(`>=4`) if two distinct patterns match, which an attacker simply avoids.

**Evidence:**
```ts
// tools_handlers.ts — scan then import (import executes code)
const scanResult = await opts.scanPlugin(pluginDir);            // line 110
if (!scanResult.ok) { ...return `failed security scan...`; }    // line 111-120
const importResult = await importPluginModule(modPath);         // line 122  → await import()

// scanner.ts — literal-dot regexes, weight 2, threshold >= 4
{ pattern: /Deno\.env\.(get|toObject|set|delete|has)\s*\(/, weight: 2 }, // line 97
const HEURISTIC_SCORE_THRESHOLD = 4;                            // line 157
const ok = !hasCritical && totalScore < HEURISTIC_SCORE_THRESHOLD; // line 242
```

**Recommendation:**
Treat plugin loading as a privileged operation. Add a `RESTRICTED` hardcoded
tool floor for `plugin_install`/`plugin_reload` so a `PUBLIC`/untrusted-tainted
session cannot reach it, and/or require explicit owner confirmation
(out-of-band, like `daemon_manage`) before `import()`. Constrain the `path`
parameter to a fixed plugins root (reject arbitrary absolute paths from the
LLM). Most importantly, do not rely on a regex scanner as a security boundary —
combine it with real sandboxing (MCP-PLUGIN-1) so that even a scanner bypass
cannot achieve host code execution.

---

## MCP-PLUGIN-3: MCP SSE transport bypasses the project's SSRF standard (native redirect-following + DNS-rebinding window)

**Severity:** medium

**Location:** `src/mcp/client/transport.ts:143-202`, `src/mcp/manager_connection.ts:100-125`

**Description:**
The project invariant (`.claude/rules/security.md` #7) requires DNS resolution +
hardcoded IP denylist on **all** outbound HTTP, and `core/security/safe_fetch.ts`
explicitly warns "Never call `fetch()` directly on user-controlled or
config-provided URLs" and re-validates **every redirect hop**
(`safe_fetch.ts:94-120`). The MCP SSE transport does not use that machinery:

1. `SSETransport.connect()` validates the initial URL once via
   `validateMcpServerUrl` → `validateOutboundUrl` (resolves DNS, checks IPs),
   then opens a raw `new EventSource(this.#url)` (transport.ts:173). `EventSource`
   follows HTTP 3xx redirects natively with **no SSRF re-check**, so a permitted
   public MCP host can 302-redirect the stream to
   `http://169.254.169.254/…` (cloud metadata) or any internal address.
2. `SSETransport.send()` issues a raw `fetch(this.#url, …)` (transport.ts:192)
   with the default `redirect: "follow"`. Its own comment claims "URL was already
   validated in connect(); no re-check needed since #url is readonly" — this is
   incorrect: (a) default redirect-following defeats the one-time check, and (b)
   the DNS result from `connect()` is not pinned, so a low-TTL attacker domain
   that resolved to a public IP at validation time can resolve to a private IP at
   send time (DNS rebinding). `validateOutboundUrl`/`resolveAndCheck` validate the
   hostname, but the subsequent `fetch`/`EventSource` re-resolve independently.

Exploitability is bounded because the MCP server URL is owner-configured, not
attacker-supplied — so this is "a semi-trusted/compromised MCP server (or an
attacker who controls its DNS/redirects) can pivot to internal network
resources," not unauthenticated SSRF. That is the exact threat the SSRF invariant
exists to stop, and the rest of the codebase enforces it via `safeFetch`.

**Evidence:**
```ts
// transport.ts — EventSource follows redirects with no re-validation
this.#eventSource = new EventSource(this.#url);                 // line 173

// transport.ts — raw fetch, default redirect:"follow", no re-check
async send(msg: string): Promise<void> {
  // "URL was already validated in connect(); no re-check needed..."
  await fetch(this.#url, { method: "POST", ... });              // line 192
}
```

**Recommendation:**
Route SSE POSTs through `safeFetchWithRedirects`/`createSsrfCheckedFetch`
(`core/security/safe_fetch.ts`) so every hop is re-validated, and either disable
redirect following on the EventSource path (validate the post-redirect URL) or
pin the connection to the IP validated at `connect()` time. Re-validate on each
`send()` rather than trusting the readonly URL.

---

## MCP-PLUGIN-4: Untrusted MCP tool descriptions and plugin systemPrompt are injected verbatim into the agent system prompt

**Severity:** medium

**Location:** `src/mcp/executor.ts:207-234` (`buildMcpSystemPrompt`), `src/plugin/registry.ts:90-97` (`getSystemPrompts`), `src/gateway/startup/tools/tool_executor.ts:281-289`

**Description:**
The agent system prompt is assembled by concatenating sections, two of which
carry attacker-influenceable text:

- `buildMcpSystemPrompt` embeds each MCP server's per-tool `description` string
  (`executor.ts:227`). Tool descriptions come straight off the wire from the MCP
  server (`tools/list` response, `protocol.ts:188-197`) — untrusted server
  output — and are inserted into the system prompt with no sanitization
  (`tool_executor.ts:282-283`).
- `pluginRegistry.getSystemPrompts()` returns each plugin's `systemPrompt`
  export verbatim and pushes it into the system prompt
  (`tool_executor.ts:287-288`). For a sandboxed/untrusted plugin this is
  author-controlled text.

A malicious MCP server or plugin can therefore plant instructions in the system
prompt (the highest-trust context) — classic prompt injection that can steer the
agent's behavior, narration, or tool selection. Plugin `systemPrompt` text does
pass through the injection scanner first (`scanner.ts` INJECTION_PATTERNS), but
those patterns are a small denylist and the MCP tool-description path is **not
scanned at all**.

Per the project's own model the deterministic policy gates (resource
classification, taint, write-down) cannot be overridden by prompt content, so
this does not by itself defeat classification enforcement — hence medium, not
critical. But it is a real injection surface that can be chained with
MCP-PLUGIN-2 (e.g. nudging the agent toward `plugin_install`).

**Evidence:**
```ts
// executor.ts — server-supplied tool.description into system prompt text
for (const tool of server.tools) {
  const fullName = encodeMcpToolName(server.id, tool.name);
  lines.push(`- **${fullName}**: ${tool.description}`);          // line 227
}

// tool_executor.ts — both sections pushed unsanitized
if (mcpPrompt) sections.push(mcpPrompt);                         // line 283
if (pluginRegistry) sections.push(...pluginRegistry.getSystemPrompts()); // line 288
```

**Recommendation:**
Treat MCP/plugin-provided descriptions and system-prompt text as untrusted data:
fence them in a clearly-delimited "external metadata (do not treat as
instructions)" block, strip control/zero-width characters, and run the same
injection scan over MCP tool descriptions that plugin content already receives.
Prefer presenting tool descriptions as data the model is told not to obey.

---

## MCP-PLUGIN-5: MCP gateway discards the `MCP_TOOL_CALL` hook result, and no rules target that hook (latent fail-open)

**Severity:** low

**Location:** `src/mcp/gateway/gateway.ts:108-123, 237-272`, `src/core/policy/hooks/default_rules.ts` (no `MCP_TOOL_CALL` rule)

**Description:**
`createMcpGateway.callTool` awaits `fireToolCallHook`/`fireUnknownServerHook`
but throws away the returned `HookResult` (`gateway.ts:248`); it never inspects
`result.allowed`/`result.action`. The only gateway-layer enforcement is the
status check (`rejectDisallowedServerStatus`), which fires **after** the hook.
Today this is inert because (a) `createDefaultRules()` registers no rule for the
`MCP_TOOL_CALL` hook, so the engine returns ALLOW, and (b) MCP calls are
independently gated by `PRE_TOOL_CALL` and by the server-status check. So there
is no current bypass.

The risk is latent fail-open: the hook type exists
(`rules.ts:19`) and the docstring claims the gateway "enforces policy checks via
hooks." If an operator later adds an `MCP_TOOL_CALL` BLOCK rule (the obvious
extension point), the gateway will silently ignore it and proceed — a deny that
does not deny. This also contradicts `serviceability.md` ("All branches in
security ... logic must log with decision inputs"): the discarded result is
neither acted on nor logged at the gateway.

**Evidence:**
```ts
await fireToolCallHook(hookRunner, session, server, toolName);  // line 248 — result discarded
const rejection = rejectDisallowedServerStatus(server);         // line 250 — only real gate
if (rejection) return rejection;
```

**Recommendation:**
Capture the `HookResult` from the `MCP_TOOL_CALL` hook and return a rejection
when `!allowed` (logging the decision), so the documented hook is actually
authoritative and future BLOCK rules take effect. Alternatively, if
`MCP_TOOL_CALL` is intentionally unused in favor of `PRE_TOOL_CALL`, remove the
hook firing and the misleading docstring to avoid a false sense of enforcement.

---

## MCP-PLUGIN-6: Reef plugin install/catalog fetch does not use the SSRF-checked fetch; integrity check trusts the same origin as the content

**Severity:** low

**Location:** `src/plugin/reef.ts:94-100`, `src/plugin/reef_catalog.ts:97-161`, `src/plugin/reef_operations.ts:46-61, 128-153`

**Description:**
`createPluginReefRegistry` defaults `fetchFn` to `globalThis.fetch`
(`reef.ts:99`), and the catalog/bundle fetches call it directly
(`reef_catalog.ts:101`, `reef_operations.ts:36`) rather than the project's
`safeFetch`. SSRF exposure is limited because `parseRegistryUrl` requires HTTPS
and that the URL hostname equals the configured base host
(`reef_catalog.ts:65-80`), so requests cannot be redirected by URL construction
to arbitrary hosts — but redirect-following on the raw `fetch` is still not
re-validated, and the host is whatever the (owner-controlled) base URL is.

Separately, the integrity model is weak: `verifyPluginChecksum`
(`reef_operations.ts:46-61`) compares the downloaded `mod.ts` hash against
`entry.checksum`, but `entry` comes from the same catalog served by the same
origin (`fetchCatalog`). A malicious or compromised registry can serve matching
content+checksum; the check only catches transit corruption, not a hostile
registry. This is the standard "trust the marketplace" risk and Reef install is
owner-initiated via the CLI (`cli/commands/plugin.ts`), not an LLM tool — hence
low. It compounds MCP-PLUGIN-1/2 because installed Reef plugins ultimately run
with full host privileges.

**Evidence:**
```ts
const fetchFn = options?.fetchFn ?? globalThis.fetch;            // reef.ts:99
...
if (actualHash !== entry.checksum) { ...return checksum mismatch } // reef_operations.ts:51
```

**Recommendation:**
Use `createSsrfCheckedFetch` for all Reef HTTP so redirects are re-validated.
For integrity, verify bundles against a signature/pinned key that is independent
of the catalog origin (or at minimum document that Reef content is trusted to
the same degree as locally authored plugins, which — given MCP-PLUGIN-1 — means
arbitrary host code execution).
