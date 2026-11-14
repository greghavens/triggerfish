# Verified — Domain: tools-other

Date: 2026-06-10
Verifier: adversarial re-check against code on the current branch
Source report: .claude/security-review/2026-06-10/findings/tools-other.md

Summary of verdicts:
- TOOLS-OTHER-1: real (medium) — SSH host option-injection → local command exec
- TOOLS-OTHER-2: real (medium) — Obsidian search/list/outlinks path-traversal
- TOOLS-OTHER-3: real (medium) — log_read PUBLIC write-down (reachability narrowed)
- TOOLS-OTHER-4: real (low) — healthcheck PUBLIC contradicts INTERNAL contract
- TOOLS-OTHER-5: real (low) — skill author missing enforceSkillName (unwired)

---

## TOOLS-OTHER-1: real

Severity (confirmed): medium

The vulnerability is exactly as described. OpenSSH treats any argument beginning
with `-` as an option until `--`, and the host is placed before `--` (one-shot)
or with no `--` at all (interactive), so a host value of `-oProxyCommand=<cmd>`
(or `-oPermitLocalCommand=yes -oLocalCommand=<cmd>`) is parsed as an SSH option
and the command executes on the LOCAL daemon host.

Evidence checked:
- `src/tools/ssh/ssh_args.ts:85` `buildExecuteArgs`: `args.push(host, "--", command)`
  — host BEFORE `--`. Base args (`-o BatchMode=...`, `-o StrictHostKeyChecking`,
  `-p`, `-i`) precede the host, so the full argv is
  `["-o","BatchMode=yes","-o","StrictHostKeyChecking=accept-new", host, "--", command]`.
  A host beginning with `-o` lands in option position.
- `src/tools/ssh/ssh_args.ts:73` `buildSessionArgs`: `args.push(opts.host)` with NO
  `--` separator at all — even more exposed than the one-shot path.
- `src/tools/ssh/ssh_executor.ts:50-66` `executeSshExecute`: validates only that
  `host` is a non-empty string. No `host.startsWith("-")` guard.
- `src/tools/ssh/ssh_session.ts:114` `openSession`: same — `host.trim()` only.
- Invocation is `new Deno.Command("ssh", { args })` (no shell), confirming this is
  argument injection, not shell injection — but the impact (local arbitrary
  command execution) is identical.

Refutation attempts (all failed to clear the finding):
- Searched the dispatch pipeline and core security for any centralized leading-dash
  arg sanitizer (`grep startsWith("-")`). The only hits are in
  `core/security/command_path_extraction.ts` (skips flags during filesystem path
  extraction from `run_command`) — unrelated to SSH and does not run on SSH args.
- `assembleSecurityContext` (src/agent/dispatch/security_context.ts) only classifies
  filesystem paths, `run_command` shell text, and URLs. SSH tools are dispatched by
  their own executor (`createSshToolExecutor`), not via `run_command`, so they never
  receive a `resource_classification`. The finding's claim on this point is correct.
- The tools are wired into production: `gateway/startup/tools/tool_executor.ts:218`
  creates `sshExecutor`; `gateway/tools/executor/executor_handlers.ts:81` dispatches
  it; `ssh` is in the `cli`/`tidepool` tool profiles. Not dead code.

Mitigations present (do not eliminate, only narrow): SSH tools carry an INTERNAL
floor (`HARDCODED_TOOL_FLOORS`, core/security/constants.ts:87-91), so the session
must already be at INTERNAL+ taint. For the owner that bar is trivial; for a
non-owner an INTERNAL ceiling is required. The marginal escalation is real: a call
the model treats as "remote SSH to host X" runs a command on the LOCAL host,
outside any resource classification.

Minor inaccuracy in the report (does not change the verdict): the report says the
audit trail is defeated because "commandPreview logs the remote command, not the
injected ProxyCommand." In fact the `host` field IS logged in full
(`ssh_executor.ts:71` and `ssh_session.ts:125`), so the injected `-oProxyCommand=...`
payload does appear in the log under `host`. The audit-evasion angle is therefore
weaker than stated, but the core local-RCE-via-option-injection vulnerability is
unaffected.

Final severity: medium. Local code execution, but gated behind an INTERNAL floor
and requiring attacker control of the `host` argument (e.g. via prompt-injection).

---

## TOOLS-OTHER-2: real

Severity (confirmed): medium

All three sub-claims verified against code.

(a) Search/list traversal:
- `src/tools/obsidian/tools/tools.ts:43-86` (`obsidian_search`) and `:88-127`
  (`obsidian_list`) read `input.folder` (LLM-supplied) and pass it straight to
  `ctx.noteStore.search/list({ folder, ... })`. No `resolveVaultPath`.
- `src/tools/obsidian/notes/note_query.ts:61,86` forward `options.folder` to
  `walkNotes(ctx, options.folder)`.
- `src/tools/obsidian/notes/note_walker.ts:22-24`:
  `basePath = folder ? \`${ctx.realVaultPath}/${folder}\` : ctx.realVaultPath`
  — no `..` validation. `walkDir` (line 58-69) uses raw string concatenation for
  fullPath and calls `Deno.readDir(basePath)`. The OS resolves `..` in the path
  passed to the syscall, so `folder = "../../etc"` enumerates `*.md` outside the
  vault. Confirmed the guard `resolveVaultPath` (vault.ts:106, with explicit `..`
  rejection and realPath boundary check) is NOT on this path.

(b) Classification-filter bypass for escaped paths:
- The post-walk filter (tools.ts:68-74, 111-117) computes the note classification
  via `resolveClassificationForPath(ctx.vaultContext, note.path)`. Note `path` is the
  RELATIVE path produced in note_walker.ts:30 as
  `entry.path.substring(ctx.realVaultPath.length + 1)`. For an escaped entry the
  resulting string (e.g. `../../etc/foo.md`) matches no folder-classification prefix,
  so `resolveClassificationForPath` (vault.ts:191-202) falls back to
  `ctx.config.classification` — the vault DEFAULT. If the vault default is at/below
  session taint, `canFlowTo` passes and the escaped entry is returned. Confirmed: the
  filter does NOT re-confine to the vault boundary; it only maps classification.

(c) Outlinks unconfined, unclassified read:
- `src/tools/obsidian/tools/tools.ts:163-167`: `obsidian_links` with
  `direction:"outlinks"` calls `resolveNotePath(noteName)` then
  `ctx.linkResolver.getOutlinks(notePath)`.
- `resolveNotePath` (tools_read_write.ts:23-27) only appends `.md`; `"../../etc/hosts"`
  → `"../../etc/hosts.md"`.
- `src/tools/obsidian/links.ts:156-163` `findVaultOutlinks`:
  `absolutePath = \`${ctx.realVaultPath}/${notePath}\``; `Deno.readTextFile(absolutePath)`
  — NO `resolveVaultPath` and NO `canFlowTo` check anywhere. Confirmed unconfined,
  unclassified file read (returns extracted `[[wikilinks]]` from the target file).

Reachability: the obsidian executor is wired into production
(`gateway/startup/infra/subsystems.ts:86` `createObsidianToolExecutor`,
`tool_infra_assembly.ts:106`). obsidian read/search/list/links are classified
INTERNAL in the prefix map (classification_map.ts:78-81), so a non-owner needs an
INTERNAL ceiling; the owner can trigger it directly or via prompt-injection.

Refutation attempt: checked whether the note `path` returned to the LLM is the
absolute path (which would not enable disclosure) — it is the relative path, but the
disclosure is the existence/metadata of `.md` files anywhere the daemon can read, and
for outlinks the actual file CONTENT is read. The CRUD path's `resolveVaultPath` guard
is genuinely absent from query/link operations. Finding stands.

Final severity: medium. Out-of-vault filesystem reconnaissance (search/list,
metadata) plus an unconfined file read of `.md`-suffixed paths (outlinks). Not full
content disclosure for search/list, hence not high.

---

## TOOLS-OTHER-3: real (reachability corrected)

Severity (confirmed): medium

The core write-down is real: `log_read` returns Triggerfish operational logs
(`~/.triggerfish/logs/*.log` minus audit) that contain data above PUBLIC, yet it is
classified PUBLIC with no floor, so a non-owner session with a PUBLIC ceiling can read
it.

Evidence checked:
- `src/agent/orchestrator/classification_map.ts:90` `["log_read", "PUBLIC"]`. No entry
  in `HARDCODED_TOOL_FLOORS` (constants.ts) — confirmed no floor.
- `src/agent/dispatch/access_control.ts:70-86` `enforceNonOwnerToolCeiling`: prefix
  match on `log_read` @ PUBLIC with ceiling PUBLIC → `canFlowTo("PUBLIC","PUBLIC")` is
  true → returns null (allowed).
- `src/tools/log_reader.ts:170` `readLogsForLlm` reads every non-audit `*.log`
  (last ~50 KB each, default 3 files). The `«»`-region scanner only strips
  prompt-injection patterns; it does NOT redact by classification.
- Log content above PUBLIC confirmed: memory writes log `{ key, agentId, classification }`
  at info (store.ts:201-205); SSH calls log `host` + `commandPreview = command.slice(0,80)`
  at info (ssh_executor.ts:69-76); non-owner turns log sender IDs + classification
  (chat_turn_execution.ts:263-268). These land in `triggerfish.log` via the file writer
  (core/logger/writer.ts), which segregates only audit.log, not by classification.
- Non-owner turns reuse the owner orchestrator: `routeChannelMessage`
  (chat_channel_routing.ts:103,139) passes the SAME `orchestrator` to both owner and
  non-owner handlers, and the daemon chat orchestrator is built with `TOOL_PROFILES.cli`
  (chat_session_assembly.ts:112,158), which includes `logReader`. So `log_read` is in the
  non-owner tool set, gated only by the ceiling.

CORRECTION to the report's reachability claim (overclaim): the report states "for a
channel/sender whose explicit classification is PUBLIC — WebChat visitors are PUBLIC by
default — the ceiling is PUBLIC." This is partially wrong.
`resolveNonOwnerCeiling` (chat_turn_execution.ts:204-211) returns the sender's
classification ONLY when `userSessions.hasExplicitClassification(senderId)` is true; else
it returns `null`. `hasExplicitClassification` (user_sessions.ts:95-96) is true only for a
runtime-paired user or a per-user `user_classifications` config override — NOT for the
channel default. With a `null` ceiling, `enforceNonOwnerToolCeiling` (access_control.ts:65)
returns "Tool calls are not available in this session," blocking ALL tools including
`log_read`. So a bare WebChat visitor cannot reach `log_read`.

The finding is still REAL because the exploit holds whenever any non-owner sender is
EXPLICITLY classified PUBLIC (operator sets `user_classifications: { id: "PUBLIC" }`, or a
pairing flow at PUBLIC). In that case the PUBLIC ceiling permits `log_read` and discloses
INTERNAL/CONFIDENTIAL operational metadata — a genuine write-down. The recommended fix
(INTERNAL floor for `log_read`) is correct and cheap.

Final severity: medium retained. The exposed data (SSH command previews, memory keys,
sender taint history) is sensitive, and the fix is a one-line floor. The precondition is
narrower than stated (requires explicit PUBLIC non-owner classification, not a default
visitor), which is why this is medium and not high.

---

## TOOLS-OTHER-4: real

Severity (confirmed): low

Classification mismatch confirmed and self-contradictory with the module's own contract.

Evidence checked:
- `src/tools/healthcheck.ts:5` module docstring: "Output is classified INTERNAL
  minimum — it reveals system internals."
- `src/agent/orchestrator/classification_map.ts:85` `["healthcheck", "PUBLIC"]`. No
  floor in `HARDCODED_TOOL_FLOORS`.
- Disclosed data (healthcheck.ts): default LLM provider name (`checkProviders`,
  details.defaultProvider), discovered-skill count and per-source breakdown
  (`discoverSkillHealth`, details.total/bySource), storage round-trip status, config-load
  status. System internals, exactly what the docstring says should be INTERNAL minimum.

Reachability mirrors TOOLS-OTHER-3: a non-owner reaches it only with an explicit PUBLIC
ceiling (channel default alone yields a null ceiling and blocks all tools). The disclosed
data is lower-sensitivity than TOOLS-OTHER-3 (no user data, no command text), so low
severity is correct. It is a real defense-in-depth write-down plus a contract violation
(tool ships at a lower classification than its own module asserts).

Final severity: low retained.

---

## TOOLS-OTHER-5: real (latent / unwired)

Severity (confirmed): low

Missing `enforceSkillName` confirmed; dead-code claim confirmed.

Evidence checked:
- `src/tools/skills/author.ts:176`:
  `const skillDir = join(authorOptions.skillsDir, opts.name)` — `opts.name` is used
  directly. `normalizeSkillCreateOptions` (author.ts:143-161) copies `name` with no
  validation. A `name` of `../../x` normalizes via `join` and escapes `skillsDir`;
  `writeSkillToDisk` (author.ts:97-115) does `mkdir -p` then writes `SKILL.md` —
  arbitrary-location file write constrained to the `SKILL.md` basename.
- `enforceSkillName` (registry_types.ts:118, strict `^[a-z0-9][a-z0-9-]*$`) is used in
  `registry_install.ts:31,79` and `registry_publish.ts:72` but NOT in author.ts.
- Dead/unwired confirmed: `grep` for `createSkillAuthor` / `executeSkillCreation` /
  `.create(` across src shows only the type re-exports in `skills/mod.ts:36-37`
  (`SkillAuthor`, `SkillAuthorOptions`) — no production importer calls
  `createSkillAuthor()` or `.create()`. The only skills tool defined/wired is
  `read_skill` (skills/tools.ts:44); there is no `skill_create`/`skill_author` tool in any
  executor or profile.

This matches one of the historical overclaim patterns (cited code is dead/unwired), and
the report correctly accounts for it: rated low and explicitly flagged as a latent
hardening gap to fix before the author tool is ever wired. Accurate.

Final severity: low retained. Real latent issue; not currently exploitable.

---

## Cross-cutting note on reachability (applies to TOOLS-OTHER-3 and -4)

The non-owner tool ceiling is `null` for any sender lacking an EXPLICIT per-user
classification (config override or runtime pairing); a `null` ceiling blocks ALL tool
calls (access_control.ts:65-66). The channel default classification (e.g. WebChat PUBLIC)
does NOT make a sender "explicitly classified" (user_sessions.ts:95-96). Findings that
rely on "default channel classification → PUBLIC ceiling → tool allowed" therefore require
the additional precondition that the sender be explicitly classified PUBLIC. Both -3 and
-4 remain valid under that (achievable) configuration, but the bare-default-visitor path
is closed.
