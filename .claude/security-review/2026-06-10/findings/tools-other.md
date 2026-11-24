# Security Review — Domain: tools-other

Date: 2026-06-10
Branch: security-remediation
Scope: src/tools/memory, src/tools/skills, src/tools/obsidian, src/tools/ssh,
src/tools/voice, src/tools/tidepool, src/tools/simulate, src/tools/explore,
src/tools/image, src/tools/workflow_healing, src/tools/*.ts root files, src/skills/

## Summary

The memory tool subsystem is well-built: writes are forced to session taint
(`buildMemoryRecord` sets `classification: opts.sessionTaint`, the executor
`sessionTaint` is bound from the live session at creation time), reads filter by
`canFlowTo` in every backend (store, FTS5, in-memory), shadowing keeps only the
highest visible version, and the FTS5 query uses a bound `MATCH ?` parameter (no
FTS injection). Secrets tooling never accepts or returns secret values. The Reef
skill install path validates names/versions against strict regexes, verifies
SHA-256 checksums, scans for injection patterns, and verifies integrity at load
time. The Tidepool A2UI host binds to 127.0.0.1, requires a `timingSafeEqual`
session key in production, and masks secrets in served config. Obsidian note CRUD
is correctly confined via `resolveVaultPath` (rejects `..`, resolves real path,
checks vault boundary).

Findings below are concentrated in (a) argument/path-injection gaps where tool
parameters reach `Deno.Command`/`Deno.readDir`/`Deno.readTextFile` without the
confinement applied elsewhere in the same module, and (b) two built-in tools
classified PUBLIC that surface operational/system internals to PUBLIC non-owner
sessions (write-down).

---

## TOOLS-OTHER-1: SSH `host` parameter enables SSH option-injection → local command execution on the daemon host

Severity: medium

Location: src/tools/ssh/ssh_args.ts:85 (`buildExecuteArgs`); ssh_args.ts:73
(`buildSessionArgs`); src/tools/ssh/ssh_executor.ts:51-66

Description:
`ssh_execute` and `ssh_session_open` accept a free-form `host` string and place
it as a positional argument **before** the `--` separator. OpenSSH parses any
argument that begins with `-` as an option until `--` is reached. Because the
host precedes `--`, a host value beginning with `-o` is interpreted as an SSH
option. An attacker who can steer the agent's `host` argument (e.g. via
prompt-injection in fetched web content, an email, or a tool result that names a
"server" to connect to) can pass
`-oProxyCommand=<cmd>` or `-oPermitLocalCommand=yes -oLocalCommand=<cmd>`, which
OpenSSH executes **on the local daemon host**, not the remote. The `command`
argument is correctly placed after `--`, but the host is not, so the injection
lands through the host parameter. No validation rejects a host that starts with
`-`. SSH is invoked via `Deno.Command("ssh", { args })` (no shell), so this is
argument injection, not shell injection — but the effect (local arbitrary command
execution) is the same.

Exploitability notes: the SSH tools carry a hardcoded INTERNAL floor
(`HARDCODED_TOOL_FLOORS`), so the session must already be at INTERNAL+ taint and a
non-owner needs an INTERNAL ceiling. The marginal escalation over the tool's
intended capability is that a call that the security model classifies as "remote
SSH to host X" actually runs a command on the **local** daemon host, outside any
resource classification (the host is not a classified resource — see
TOOLS-OTHER-1 note below), defeating operator expectations and the audit trail
(`commandPreview` logs the remote command, not the injected ProxyCommand).

Additionally, the SSH `host`/command resources are not classified at all by
`assembleSecurityContext` (it only classifies filesystem paths, shell commands,
and URLs), so SSH tool calls never receive a `resource_classification`; only the
INTERNAL floor gates them.

Evidence:
```ts
// ssh_args.ts — buildExecuteArgs
export function buildExecuteArgs(host, command, opts, resolved): string[] {
  const args = buildBaseArgs(opts, resolved); // -o BatchMode=..., -o StrictHostKeyChecking, -p, -i
  args.push(host, "--", command);             // host BEFORE `--` → parsed as option if it starts with `-`
  return args;
}
```
```ts
// ssh_executor.ts — executeSshExecute: host is only checked for non-empty
const host = input.host;
if (typeof host !== "string" || host.trim().length === 0) { ... }
// ... no check that host does not start with "-"
const args = buildExecuteArgs(host, command, { port }, resolved);
const proc = new Deno.Command("ssh", { args, ... });
```

Recommendation:
Reject hosts that begin with `-` (and, ideally, validate against a
`[user@]hostname[:port]`/SSH-config-alias allowlist pattern). Alternatively pass
the destination after a leading `--` as well, or use the explicit
`ssh -- <host> <command>` ordering with a guard. The simplest fix is an
input-validation guard in `executeSshExecute` / `executeSshSessionOpen`:
`if (host.startsWith("-")) return "Error: invalid host";` Consider also disabling
local command execution defensively with `-o PermitLocalCommand=no` and clearing
`ProxyCommand`/`LocalCommand` in `buildBaseArgs`.

---

## TOOLS-OTHER-2: Obsidian search/list/outlinks bypass vault confinement (path traversal → out-of-vault file disclosure)

Severity: medium

Location: src/tools/obsidian/notes/note_walker.ts:22-23 (`walkNotes` basePath);
src/tools/obsidian/notes/note_query.ts:61,86 (`searchNotesInVault`,
`listNotesInVault`); src/tools/obsidian/links.ts:161 (`findVaultOutlinks`);
src/tools/obsidian/tools/tools.ts:49-64,88-107,163-168

Description:
Note CRUD (`obsidian_read`/`obsidian_write`) is correctly confined through
`resolveVaultPath`, which rejects `..` components and verifies the resolved real
path stays within the vault. The **query and link** operations do not use that
guard:

- `obsidian_search` and `obsidian_list` pass the LLM-supplied `folder` argument
  straight to `NoteStore.search/list` → `walkNotes(ctx, folder)`, which builds
  `basePath = \`${ctx.realVaultPath}/${folder}\`` with no `..` validation and
  recurses with `Deno.readDir`. A `folder` of `../../../../etc` (or any path) makes
  the walker enumerate `*.md` files **outside the vault**. The post-walk
  classification filter computes `relativePath = entry.path.substring(realVaultPath.length+1)`,
  which for an escaped path yields a string that matches no folder-classification
  prefix and therefore falls back to the vault **default** classification — so
  escaped entries can pass `canFlowTo`. Search/list return note `path`, `name`,
  `tags`, and `headings` (metadata, not full content), so the disclosure is
  filesystem reconnaissance of `.md` files anywhere the daemon can read.

- `obsidian_links` with `direction: "outlinks"` calls
  `findVaultOutlinks(ctx, notePath)` where `notePath = resolveNotePath(noteName)`
  (only appends `.md`). It then does
  `absolutePath = \`${ctx.realVaultPath}/${notePath}\`` and
  `Deno.readTextFile(absolutePath)` with **no** `resolveVaultPath` and **no**
  classification check at all. `obsidian_links(note: "../../../../etc/hosts", direction: "outlinks")`
  reads `/etc/hosts.md`-style paths and returns extracted `[[wikilinks]]` from
  whatever `.md` file it finds — an unconfined, unclassified file read.

This defeats the vault boundary that the CRUD path enforces. The obsidian tools
are classified INTERNAL (read/search/list) in the prefix map, so a non-owner
needs INTERNAL ceiling; the owner can trigger it directly or via prompt-injection
("search the folder `../../` of your vault").

Evidence:
```ts
// note_walker.ts
const basePath = folder
  ? `${ctx.realVaultPath}/${folder}`   // no traversal validation
  : ctx.realVaultPath;
for await (const entry of walkDir(basePath)) { ... }   // walkDir uses string concat fullPath
```
```ts
// links.ts — findVaultOutlinks (no resolveVaultPath, no canFlowTo)
const absolutePath = `${ctx.realVaultPath}/${notePath}`;
const content = await Deno.readTextFile(absolutePath);
```
```ts
// tools.ts — obsidian_search / obsidian_list pass folder unvalidated
const folder = typeof input.folder === "string" ? input.folder : undefined;
const result = await ctx.noteStore.search({ query, folder, tags, maxResults });
```

Recommendation:
Route the `folder` parameter (search/list) and `notePath` (outlinks) through
`resolveVaultPath` before walking/reading, rejecting any path that escapes the
vault. Apply the same `canFlowTo(noteClassification, sessionTaint)` filter to
`obsidian_links` outlinks that read file content. As defense-in-depth, have
`walkNotes`/`walkMdFiles` verify each `entry.path` still begins with
`ctx.realVaultPath + SEPARATOR` before yielding.

---

## TOOLS-OTHER-3: `log_read` is classified PUBLIC, exposing operational logs (INTERNAL/CONFIDENTIAL metadata) to PUBLIC non-owner sessions (write-down)

Severity: medium

Location: src/agent/orchestrator/classification_map.ts:90 (`["log_read", "PUBLIC"]`);
src/tools/log_reader.ts:170 (`readLogsForLlm` reads all non-audit `*.log`);
wired at src/gateway/tools/executor/executor_filesystem.ts:284 / executor_handlers.ts:233

Description:
`log_read` returns the contents of all Triggerfish operational log files (every
`*.log` in `~/.triggerfish/logs/` except audit.log), truncated to the last ~50 KB
each. It is classified `PUBLIC` in `BUILTIN_TOOL_CLASSIFICATIONS` and has no tool
floor. Non-owner channel turns (`orchestrateNonOwnerAgentTurn`) share the main
daemon orchestrator and its CLI tool profile (which includes `logReader`); they
are gated only by `enforceNonOwnerToolCeiling`. For a channel/sender whose
explicit classification is PUBLIC — WebChat visitors are PUBLIC by default — the
ceiling is PUBLIC, and `canFlowTo("PUBLIC","PUBLIC")` is true, so the call is
permitted.

The operational logs contain data above PUBLIC: memory writes log the record key
and forced classification (`memory/store.ts` — `{ key, classification }`), SSH
calls log `host` and an 80-char `commandPreview` of the remote command
(`ssh_executor.ts`), non-owner taint changes log sender IDs and classification,
and integration calls log resource identifiers. The `log_read` injection-scanner
only strips prompt-injection patterns from `«»`-delimited regions; it does **not**
redact classified content or downgrade by classification. The result is a
write-down: an unauthenticated/PUBLIC non-owner can read INTERNAL/CONFIDENTIAL
operational metadata of the owner's daemon by inducing the agent to call
`log_read`.

Evidence:
```ts
// classification_map.ts (BUILTIN_TOOL_CLASSIFICATIONS)
["log_read", "PUBLIC"],
```
```ts
// access_control.ts — enforceNonOwnerToolCeiling
for (const [prefix, level] of toolClassifications ?? []) {
  if (name.startsWith(prefix)) {
    if (!canFlowTo(level, ceiling)) return "...Access denied.";
    return null;   // log_read @ PUBLIC, ceiling PUBLIC → allowed
  }
}
```
```ts
// log_reader.ts — reads every non-audit *.log, no per-classification gating
if (isAuditFile(entry.name)) continue;
// ...content returned to caller, only «»-region injection patterns stripped
```

Recommendation:
Reclassify `log_read` to at least INTERNAL (a tool floor in
`HARDCODED_TOOL_FLOORS`, e.g. `["log_read","INTERNAL"]`, is the strongest place —
floors cannot be lowered by config). Operational logs are owner-diagnostic by
nature and should not be reachable by a PUBLIC non-owner session. Optionally
restrict `log_read` to owner sessions entirely.

---

## TOOLS-OTHER-4: `healthcheck` classified PUBLIC contradicts its documented INTERNAL minimum, leaking system internals to non-owners

Severity: low

Location: src/agent/orchestrator/classification_map.ts:85 (`["healthcheck","PUBLIC"]`);
src/tools/healthcheck.ts:5 (module doc: "Output is classified INTERNAL minimum")

Description:
The healthcheck module's own documentation states "Output is classified INTERNAL
minimum — it reveals system internals," but the tool is mapped `PUBLIC` in
`BUILTIN_TOOL_CLASSIFICATIONS` and has no tool floor. As with TOOLS-OTHER-3, a
PUBLIC non-owner session can invoke it and learn the default LLM provider name,
the count and sources of discovered skills, storage round-trip status, and config
load status — system internals the module asserts should require INTERNAL. The
disclosed data is lower-sensitivity than TOOLS-OTHER-3 (no user data, no command
text), hence low severity, but it is a clear classification mismatch and a
defense-in-depth write-down.

Evidence:
```ts
// healthcheck.ts (module docstring)
* Reports status of providers, storage, skills, and config.
* Output is classified INTERNAL minimum — it reveals system internals.
```
```ts
// classification_map.ts
["healthcheck", "PUBLIC"],
```

Recommendation:
Align the classification with the documented intent: give `healthcheck` an
INTERNAL floor (or map it INTERNAL) so it matches its own security contract and is
not reachable by PUBLIC non-owner sessions.

---

## TOOLS-OTHER-5: Skill self-authoring omits `enforceSkillName`, allowing directory escape (currently unwired)

Severity: low

Location: src/tools/skills/author.ts:176 (`skillDir = join(authorOptions.skillsDir, opts.name)`);
normalizeSkillCreateOptions (author.ts:143) does not validate `name`

Description:
`createSkillAuthor().create({ name, ... })` builds the skill directory as
`join(authorOptions.skillsDir, opts.name)` without validating `name` through
`enforceSkillName` (the strict `^[a-z0-9][a-z0-9-]*$` regex used everywhere else
in the skills module). A `name` containing `../` would normalize via `join` and
escape `skillsDir`, then `writeSkillToDisk` would `mkdir -p` and write a
`SKILL.md` outside the intended directory — an arbitrary-location file write
constrained to the `SKILL.md` filename.

This is rated low because `createSkillAuthor` is exported from `skills/mod.ts` but
is **not wired into any tool executor or gateway code** (no importer outside
`author.ts`); it is presently dead/unreachable. It is recorded as a latent
hardening gap so the guard is added before the author tool is ever wired up.

Evidence:
```ts
// author.ts — no enforceSkillName before join
function normalizeSkillCreateOptions(createOptions) {
  return { name: createOptions.name, /* ...no validation... */ };
}
const skillDir = join(authorOptions.skillsDir, opts.name);  // "../../x" escapes
await Deno.mkdir(skillDir, { recursive: true });
await Deno.writeTextFile(join(skillDir, "SKILL.md"), skillMd);
```

Recommendation:
Call `enforceSkillName(opts.name)` at the top of `executeSkillCreation` and return
its error on failure, mirroring `writeInstalledSkill` in `registry_install.ts`.

---

## Notes / verified-safe (no finding)

- Memory writes are forced to session taint and cannot be chosen by the LLM
  (`buildMemoryRecord` → `classification: opts.sessionTaint`); the executor's
  `sessionTaint` is bound from the live session at construction
  (`initializeMemorySystem`, `buildExtraSystemPromptGetter` re-reads
  `getSessionTaint()`); reads filter by `canFlowTo` in store/FTS5/in-memory;
  shadowing returns the highest visible version. `memory_save`/`memory_delete`
  are intentionally absent from the prefix map and have no floor, so non-owner
  sessions hit default-deny (cannot write/delete memory). No FTS injection — the
  query is a bound `MATCH ?` parameter.
- Skills: Reef install validates name/version (strict regexes), verifies SHA-256
  checksum, scans content (weighted heuristics; instant-fail on weight≥3 patterns
  including base64/atob/zero-width chars), records and re-verifies integrity at
  load time; loader uses `resolveWithinJail` + `sanitizePathForPrompt` per
  directory entry and skips symlinked dirs; registry URL enforced to HTTPS + exact
  host. The classification ceiling is enforced at `read_skill` activation.
- Tidepool A2UI host binds to 127.0.0.1, requires a persisted random session key
  with `timingSafeEqual` comparison in production (`startTidepoolHost` always
  supplies one), and masks apikey/token/secret/password fields in served config.
  The no-auth branch (`if (!state.sessionKey) return null`) is unreachable in the
  daemon. Canvas HTML renders into `<iframe sandbox="allow-scripts
  allow-same-origin">` — the `allow-same-origin`+`allow-scripts` combination is a
  defense-in-depth weakness for untrusted HTML, but `tidepool_*` tools are only
  added to the tool set for authenticated Tidepool turns (`isTidepoolCallRef`),
  never for non-owner channel turns, and the surface is owner-only on localhost.
- Secrets tool never accepts a value from the LLM (out-of-band prompt callback),
  returns only names from `secret_list`, masks nothing into the model context, and
  logs all operations at WARN with the name only.
- Obsidian note CRUD (`obsidian_read`/`obsidian_write`) is correctly confined via
  `resolveVaultPath` and enforces `canFlowTo` for read (note class ≤ taint) and
  write-down (taint ≤ folder class).
- Voice (`stt.ts`/`tts.ts`) are provider-interface abstractions with no executor
  or injection surface. Image clipboard uses array-arg `Deno.Command` (no shell).
  Explore spawns a subagent via an injected `spawnSubagent` (isolation handled in
  gateway). `llm_task`, `summarize`, `release_notes`, todo*, simulate defs have no
  reachable injection/classification gaps in this domain.
- `workflow_healing` tools (`workflow_version_approve`/`reject`/`list`,
  `workflow_healing_status`) are not imported outside their own directory — dead /
  unwired code. The `workflow` tool group resolves to `src/workflow/`'s run tools,
  not these. No exploitable self-approval path in the current wiring.
