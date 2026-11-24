# Verified Security Review — Domain: integrations-cli

Verifier pass over `/var/home/venom/triggerfish/.claude/security-review/2026-06-10/findings/integrations-cli.md`.
Each finding was independently checked against the source on branch
`security-remediation`, including a search for centralized mitigations
(PRE_TOOL_CALL hook, security pipeline, gateway wiring) that could neutralize
the issue at a different layer.

Verdict legend: real / false_positive / uncertain. Severity may be adjusted with
justification.

---

## INTEGRATIONS-CLI-1: GitHub clone/pull destination path escapes the agent workspace jail — verdict: real

**Severity: medium (confirmed).**

The code path is exactly as described and is wired into production:

- `src/integrations/github/tools.ts:125-135` `resolveLocalPathInput` does
  `join(workspacePath, path)` with no containment check. Only invoked when
  `ctx.workspacePath` is truthy (`tools.ts:171-173`); otherwise the raw input is
  passed through.
- `src/integrations/github/repos/tools_repos.ts:321-323` (clone) uses
  `destPath = input.path` raw when present; `:289-299` (pull) requires a `path`
  and passes it straight to `client.pullRepo`.
- `src/integrations/github/client.ts:245-258` forwards `destPath`/`localPath`
  unchanged to `cloneRepoToPath` / `pullRepoAtPath`
  (`client_repos_git.ts:62-108`, `:181-228`), which pass it directly to
  `git clone <url> <destPath>` / `git -C <localPath> pull`. No path-jail check
  anywhere in the chain (confirmed by grep: `isWithinJail` / `resolveWithinJail`
  / `isRealPathWithinJail` are not imported by any `integrations/github/` file).

**Empirically confirmed traversal** (ran `@std/path` `join` inside the project):
- `join("/home/user/.triggerfish/workspace/public", "../../../../etc/cron.d/evil")` → `/home/etc/cron.d/evil` (escapes workspace).
- `join("/ws", "../../../home/user/.config")` → `/home/user/.config` (escapes).
- Minor correction to the report: when `workspacePath` IS set, an *absolute*
  `path` like `/etc/passwd` becomes `/ws/etc/passwd` (join treats it as
  relative), so it does NOT escape. The report's "absolute paths accepted" claim
  is true only for the `ctx.workspacePath`-unset branch, where
  `resolveLocalPathInput` is skipped and `tools_repos.ts:321` uses `input.path`
  raw. The report states this correctly. `../`-based escape is the live vector.

**Refutation attempt — is it caught by a centralized hook?** No. I traced the
PRE_TOOL_CALL pipeline (`src/agent/dispatch/security_pipeline.ts`,
`security_context.ts`, `command_classification.ts`):
- `classifyFilesystemResource` only classifies when the tool name is in
  `FILESYSTEM_READ_TOOLS`/`FILESYSTEM_WRITE_TOOLS` (`core/security/constants.ts:42-53`).
  Those sets contain `read_file`/`write_file`/etc. — **not** `github_repos`/
  `github_clone_repo`/`github_pull`. So the `path` arg of a github tool is never
  fed to the path classifier.
- `classifyShellCommandResource` returns early unless `call.name === "run_command"`
  (`command_classification.ts:264`) — github tools are not run_command.
- The resource classification used for github tools is the *repo* classification
  (returned as `_classification` in the result), which gates read-down of repo
  *content* but says nothing about the destination directory on disk.

Therefore nothing below the LLM enforces workspace containment for the clone
destination. This breaks security invariant #6 (agent workspaces fully
isolated). The sibling X media path (`x/posts/posts_media.ts:59-80`) correctly
jails its `filePath`, and the project ships `core/security/path_jail.ts` for
exactly this — neither is applied here. The inconsistency and the missing
control are real.

Severity medium is appropriate: exploitation requires the agent to be steered
into supplying a traversal `path` (prompt-injection-to-tool-abuse), and the
impact is writing an attacker-chosen repo tree to an arbitrary directory
(integrity/overwrite, potential code-drop into autostart locations) rather than
a direct secret read. Not critical, clearly above low.

---

## INTEGRATIONS-CLI-2: GitHub clone/pull `branch` bypasses branch-name validation — verdict: real

**Severity: medium → low (downgraded, see reasoning).**

Confirmed at the code level:
- `tools_repos.ts:294` (pull) and `:324` (clone) read
  `branch = typeof input.branch === "string" ? input.branch : undefined` with no
  call to `assertValidBranchName`.
- `assertValidBranchName` (`tools_shared.ts:97-111`, anchored `SAFE_BRANCH_NAME`,
  rejects `..`, `\`, leading `-`) IS called for create/delete branch
  (`tools_repos.ts:221`, `:258`) but NOT for clone/pull. Verified by grep: those
  are the only two call sites.
- The branch reaches `git` argv unvalidated: clone via `--branch <value>`
  (`client_repos_git.ts:39`), pull as a trailing positional
  `git -C <path> pull <url> <branch>` (`:163-164`).

This is a genuine validation inconsistency and an argument-injection hardening
gap. However I down-rate it to **low** for exploitability:
- Execution uses `Deno.Command("git", { args })` (no shell), so classic shell
  metacharacter injection is impossible (the report concedes this).
- For **clone**, the branch is the operand of `--branch` (`["--branch", X]`);
  git treats `X` as the ref value of `--branch`, not as a new option, so an
  option-shaped `X` just fails as an invalid ref — limited impact.
- For **pull**, the trailing-positional placement does let a `--`-prefixed token
  be parsed as a pull/fetch option. But the dangerous options (`--upload-pack`,
  `--receive-pack`) only execute a local program for `ssh://`/`file://`
  transports; the remotes built here are always `https://x-access-token:...@host`
  (`client_repos_git.ts:19-29`), where those options are inert. The report
  itself acknowledges this.

So the worst realistic outcome over the always-https remote is feeding
option-shaped tokens that git rejects or that tweak refmap/output options —
hardening, not a clear RCE/exfil path. Real finding, correctly identified, but
the practical severity is low. The recommended fixes (route through
`assertValidBranchName`; add a `--` end-of-options separator) are sound defense
in depth.

---

## INTEGRATIONS-CLI-3: Delegation chain verification has no trust anchor (latent — module unwired) — verdict: real

**Severity: low (confirmed).**

The cryptographic flaw is real:
- `src/routing/delegation.ts:36-52` `verifyDelegationChain` loops calling
  `verifyDelegationCertificate` (which verifies each cert's signature against its
  own self-embedded `cert.publicKey` — `delegation_crypto.ts:140-161, 164-180`)
  then `verifyDelegationChainLinkage` (`:182-203`, only checks
  `next.delegator === current.delegate`).
- Nothing anchors `certificates[0].publicKey` to a trusted root key set or maps
  it to `certificates[0].delegator`. A self-consistent chain with arbitrary
  `delegator`/`delegate`/`permissions` passes — a complete trust bypass *if ever
  used for authorization*.

The "unwired / no production consumers" claim is confirmed:
- `createDelegationService`, `verifyChain`, and the delegation symbols are
  exported from `routing/mod.ts` but imported nowhere outside `src/routing/`
  (grep for delegation references excluding `src/routing/` and tests returns only
  unrelated `verifyChainEntry` matches in `core/policy/audit/audit.ts`).
- No file outside `src/routing/` imports from `routing/mod.ts` or any
  `../routing` path (verified). `router.ts` (the actual channel→agent lookup)
  does not import delegation.

Because no authorization decision currently consumes this verifier, it is a
latent flaw, not a live bypass. Low is correct. The report appropriately flags
that it would be critical once wired — that guidance should be retained.

---

## INTEGRATIONS-CLI-4: Workflow-run store fails open for runs persisted without a classification — verdict: real

**Severity: low (confirmed).**

The fail-open branch is real:
- `src/workflow/store.ts:166` (`loadRun`) and `:190` (`listRuns`) guard with
  `if (run.classification && !canFlowTo(...))`. When `run.classification` is
  `undefined`, the guard short-circuits and the run is returned/listed
  regardless of session taint — a potential read-down.
- `WorkflowRunResult.classification` is optional (`types.ts:234`), and
  `engine.ts:299` stamps it via `options.getSessionTaint?.()` — optional
  chaining means an absent `getSessionTaint` yields `undefined`. `saveRun`
  (`store.ts:148-156`) persists the result verbatim with no defaulting.

The "not reachable in current wiring" claim is confirmed:
- `engine.ts:73` declares `getSessionTaint?` as optional on
  `ExecuteWorkflowOptions`, but the production handler
  (`tool_handlers.ts:104-108`) always passes `getSessionTaint: ctx.getSessionTaint`,
  and `ctx.getSessionTaint` is a required field (`tools.ts:45`). Sub-workflows
  inherit the same value (`run_executors.ts:113-116`). So every run persisted via
  the live tool path carries a classification.
- Contrast confirmed: workflow *definitions* take a non-optional
  `classification: ClassificationLevel` (`store.ts:35,82`) and always enforce
  `canFlowTo` on load/list (`:107,130`) — no fail-open there.

So this is a latent fail-open / defense-in-depth gap, not an exploitable bypass
on the current wiring. Low is correct. Recommended fix (treat missing
classification as RESTRICTED / fail closed in both `loadRun` and `listRuns`) is
appropriate.

---

## Summary

All four findings are **real** at the code level and survive refutation:

| ID | Verdict | Severity (report → verified) |
|----|---------|------------------------------|
| INTEGRATIONS-CLI-1 | real | medium → medium |
| INTEGRATIONS-CLI-2 | real | medium → low (limited exploitability over https + Deno.Command, no shell) |
| INTEGRATIONS-CLI-3 | real | low → low (module has no production consumers) |
| INTEGRATIONS-CLI-4 | real | low → low (unreachable in current wiring; fail-open latent) |

The report's "areas reviewed and found sound" claims that are load-bearing for
these verdicts were spot-checked and hold: the workflow engine routes `call`/
`run` tasks through the policy-enforced composite `toolExecutor`
(`tool_handlers.ts:107` → `tool_executor.ts:212` `compositeRef.current`), so
workflow execution cannot bypass PRE_TOOL_CALL; and GitHub clone/pull are the
genuine outliers that skip the path-jail and branch-name validators their
siblings use.
