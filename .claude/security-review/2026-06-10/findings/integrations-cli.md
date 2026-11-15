# Security Review — Domain: integrations-cli

Scope audited: `src/integrations/`, `src/workflow/`, `src/routing/`, `src/cli/`, `src/dive/`
Branch: `security-remediation` (full source, not a diff). Date: 2026-06-10.

## Summary

The OAuth flows (Google, X) correctly use PKCE + CSRF state with server-side
state verification; tokens are persisted only to the OS keychain, never to
config files or logs. The dive wizard writes only `secret:<ref>` placeholders
into `triggerfish.yaml` and stores plaintext exclusively in the keychain.
SSRF-sensitive integrations (GitHub API, Notion, CalDAV) are wired with
`createSsrfCheckedFetch()` / `safeFetch` at the gateway layer, including
re-validation of server-returned URLs in CalDAV discovery. The workflow engine
is NOT a `eval` engine and routes every `call`/`run` task back through the
policy-enforced composite tool executor, so it cannot bypass the PRE_TOOL_CALL
classification gate; stored workflow definitions are forced to session taint and
read-gated by `canFlowTo`.

The notable gaps are in the GitHub repo clone/pull tools, which — unlike the
sibling X media-upload and filesystem-server code — skip the project's path-jail
and branch-name validators. Two medium findings result. Two low findings cover
a latent (currently unwired) delegation trust-anchor flaw and a fail-open branch
in the workflow-run store.

---

## INTEGRATIONS-CLI-1: GitHub clone/pull destination path escapes the agent workspace jail (path traversal)

**Severity:** medium

**Location:** `src/integrations/github/tools.ts:126-135` (and consumers
`src/integrations/github/repos/tools_repos.ts:313-338` clone,
`:281-306` pull → `src/integrations/github/repos/client_repos_git.ts:62-108`,
`:181-228`)

**Description:**
`github_clone_repo` and `github_pull` take an agent-supplied `path` and resolve
it for local filesystem use via `join(workspacePath, path)` with **no** jail
containment check. `@std/path` `join` does not neutralize `../` segments, so a
`path` such as `../../../../home/user/.config` resolves outside the per-agent
workspace. `git clone` then writes a full repository tree to that location.
This breaks security invariant #6 ("Agent workspaces are fully isolated") and is
reachable via a prompt-injection-to-tool-abuse chain (e.g. a malicious repo
README / issue body the agent reads, instructing it to clone into a sensitive
directory). When `ctx.workspacePath` is unset the `path` is used completely raw
(absolute paths accepted). The same codebase already has the correct pattern in
`src/integrations/x/posts/posts_media.ts:59-80` (relative()+`startsWith("..")`
containment) and in `src/core/security/path_jail.ts` (`resolveWithinJail` /
`isRealPathWithinJail`), neither of which is applied here. Both `clone` and
`pull` are registered tools (`tools_defs_repos.ts:161-211`) wired into the
gateway via `buildGitHubExecutor` with a real `workspacePath`.

**Evidence:**
```ts
// src/integrations/github/tools.ts
const LOCAL_PATH_ACTIONS = new Set(["clone", "pull"]);

function resolveLocalPathInput(action, input, workspacePath) {
  if (!LOCAL_PATH_ACTIONS.has(action)) return input;
  const path = input.path;
  if (typeof path !== "string" || path.length === 0) return input;
  return { ...input, path: join(workspacePath, path) }; // no isWithinJail() — ../ escapes
}
```
```ts
// src/integrations/github/repos/tools_repos.ts (clone)
const destPath = typeof input.path === "string" && input.path.length > 0
  ? input.path            // when workspacePath unset, fully raw (absolute allowed)
  : repoResult.name;
```

**Recommendation:**
After `join(workspacePath, path)`, enforce containment with
`isRealPathWithinJail(resolved, workspacePath)` (or `resolveWithinJail`) from
`core/security/path_jail.ts` and reject paths that escape, mirroring the
X media-upload check. Also require `ctx.workspacePath` to be set for `clone`/
`pull` (fail closed when absent) rather than falling through to a raw path.

---

## INTEGRATIONS-CLI-2: GitHub clone/pull `branch` bypasses branch-name validation (git argument injection)

**Severity:** medium

**Location:** `src/integrations/github/repos/tools_repos.ts:324` (clone),
`:294` (pull) → `src/integrations/github/repos/client_repos_git.ts:32-42`
(`buildCloneArgs`), `:158-166` (`buildPullArgs`)

**Description:**
The repo `branch` parameter for `github_clone_repo` and `github_pull` is read as
`typeof input.branch === "string" ? input.branch : undefined` and passed
straight into the `git` argv, **without** calling the existing
`assertValidBranchName` validator that `github_create_branch` /
`github_delete_branch` use. `SAFE_BRANCH_NAME`
(`tools_shared.ts:91`, anchored to a leading `[a-zA-Z0-9]`) would reject a
`--`-prefixed value, but it is never invoked here. For `pull`, the branch is
appended as a trailing positional (`git -C <path> pull <url> <branch>`), where
git's parse-options will interpret a `--`-prefixed value as a fetch/pull option
(e.g. `--upload-pack=…`, `--refmap=…`, `-o…`). While `--upload-pack` is only
executed locally for `ssh://`/`file://` transports (not the `https://` remotes
used here), feeding unvalidated option-shaped tokens into `git` argv is an
argument-injection hardening gap and is inconsistent with the validation applied
to sibling branch operations. Execution uses `Deno.Command("git", { args })`, so
classic shell metacharacter injection is not possible, but git-level option
abuse is.

**Evidence:**
```ts
// src/integrations/github/repos/tools_repos.ts  (clone & pull — no assertValidBranchName)
const branch = typeof input.branch === "string" ? input.branch : undefined;
```
```ts
// src/integrations/github/repos/client_repos_git.ts
function buildPullArgs(localPath, authUrl, opts) {
  const args = ["-C", localPath, "pull", authUrl];
  if (opts?.branch) args.push(opts.branch);   // trailing token parsed as option if it starts with --
  return args;
}
```
Contrast — the validator that exists but is not called here:
```ts
// src/integrations/github/tools_shared.ts
const SAFE_BRANCH_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._\-/]*[a-zA-Z0-9]$/;
export function assertValidBranchName(value, toolName) { /* rejects .., \, leading - */ }
```

**Recommendation:**
Route `branch` through `assertValidBranchName` in `cloneGitHubRepository` and
`pullGitHubRepository` exactly as the create/delete-branch handlers do. As
defense in depth, insert a `--` end-of-options separator before positional
args in `buildCloneArgs` / `buildPullArgs` so no later token can be parsed as a
git option.

---

## INTEGRATIONS-CLI-3: Delegation chain verification has no trust anchor (latent — module unwired)

**Severity:** low

**Location:** `src/routing/delegation.ts:36-52` (`verifyDelegationChain`),
`src/routing/delegation_crypto.ts:140-203`
(`verifySignatureAgainstPublicKey`, `verifyDelegationChainLinkage`)

**Description:**
A `DelegationCertificate` carries its own `publicKey`
(`delegation_types.ts:24-25`), and `verifyChain` validates only (a) each cert's
signature against that self-embedded key, (b) expiry, and (c) chain linkage
(`cert[n+1].delegator === cert[n].delegate`). It never anchors the root
(`certificates[0]`) to a known/trusted public key. Any party can therefore mint
a fully self-consistent chain asserting an arbitrary `delegator`, `delegate`,
and `permissions` set, and `verifyChain` returns `{ ok: true }`. If this service
is ever wired to grant cross-agent permissions, this is a complete trust bypass
(would be critical). It is recorded as **low** only because the module currently
has **no production consumers** — `createDelegationService` and the verify
functions are exported from `routing/mod.ts` but imported nowhere outside
`src/routing/` and its tests.

**Evidence:**
```ts
// src/routing/delegation.ts — no check that certificates[0].delegator's key is trusted
async function verifyDelegationChain(chain) {
  if (chain.certificates.length === 0) return { ok: false, error: "Delegation chain is empty" };
  for (let i = 0; i < chain.certificates.length; i++) {
    const result = await verifyDelegationCertificate(chain.certificates[i]); // verifies self-embedded key only
    if (!result.ok) return { ok: false, error: `Certificate at index ${i} is invalid: ${result.error}` };
  }
  return verifyDelegationChainLinkage(chain); // only links delegate→delegator, no root anchor
}
```

**Recommendation:**
Before wiring delegation into any authorization decision, require the verifier
to accept a set of trusted root public keys (or a trusted-delegator registry)
and assert that `certificates[0].publicKey` (and that it corresponds to
`certificates[0].delegator`) is in that set. Do not rely on the self-embedded
key as its own authority.

---

## INTEGRATIONS-CLI-4: Workflow-run store fails open for runs persisted without a classification

**Severity:** low

**Location:** `src/workflow/store.ts:158-176` (`loadRun`), `:178-208` (`listRuns`)

**Description:**
Read-down filtering for workflow run history is guarded by
`if (run.classification && !canFlowTo(...))`. When `run.classification` is
`undefined`, the guard is skipped and the run is returned regardless of session
taint — a potential write-down of classified run output to a lower-taint reader.
In the current wiring this is not reachable: the engine always stamps
`classification: options.getSessionTaint?.()` (`engine.ts:299`) and the workflow
tool handler always supplies `getSessionTaint` (`tool_handlers.ts:108`), so every
persisted run carries a classification. It is therefore a latent fail-open
branch / defense-in-depth gap rather than an exploitable bypass. (Workflow
*definitions* are handled correctly — `loadDefinition`/`listDefinitions` always
enforce `canFlowTo`, and `executeWorkflowSave` forces the stored classification
to `ctx.getSessionTaint()`.)

**Evidence:**
```ts
// src/workflow/store.ts
const run = JSON.parse(raw) as WorkflowRunResult;
if (run.classification && !canFlowTo(run.classification, sessionTaint)) { // undefined → no filter
  log.warn("Workflow run load denied: classification exceeds session taint", { ... });
  return null;
}
return run;
```

**Recommendation:**
Treat a missing `run.classification` as the most restrictive level (fail closed),
e.g. default to `RESTRICTED` before the `canFlowTo` check, so an unclassified run
is never read down. Mirror the same default in `listRuns`.

---

## Areas reviewed and found sound (no findings)

- **Google / X OAuth (PKCE + CSRF state):** `connect_google.ts:43-103`,
  `connect_x_oauth.ts:46-82` verify `state` server-side before resolving the
  code; consent URLs use 32-byte verifier + S256 challenge + 16-byte state
  (`auth_pkce.ts`). Callback servers bind `127.0.0.1`, single-use, 5-min timeout.
- **Token storage / refresh:** Google and X tokens persist only to the
  `SecretStore` (`auth.ts`); refresh is single-flighted; corrupt entries cleared.
  No token values logged (`exchange*`/`refresh*` log only operation + status).
- **GitHub PAT, Notion, CalDAV credentials:** resolved from keychain only;
  `connect_github.ts` verifies via `safeFetch`; CalDAV/GitHub/Notion HTTP is
  SSRF-checked at the gateway (`createSsrfCheckedFetch`/`safeFetch`), and the
  CalDAV executor explicitly injects the SSRF-checked fetch so server-returned
  discovery URLs (principal, calendar-home) are re-validated
  (`gateway/startup/factory/caldav_executor.ts:64-78`).
- **Dive wizard config/secrets:** `wizard_generators.ts` writes only
  `secret:<key>` references into YAML; `wizard_secrets.ts` / `cli/config/secrets.ts`
  store plaintext only in the keychain; `config get` masks key/secret/token
  fields and never resolves keychain refs (`config_crud.ts:59-69,125-144`).
- **Gateway auth token:** `cli/config/paths.ts:126-139` generates a 256-bit
  random token, writes it mode-0600, rotates per daemon start, logs only the path.
- **Workflow expression engine:** `expressions.ts` is a restricted dot-path /
  literal / comparison / arithmetic evaluator — no `eval`/`Function`/`import`.
- **Workflow task dispatch:** `dispatch.ts` maps every `call`/`run` type to a
  named tool dispatched through the policy-enforced composite `toolExecutor`
  (`gateway/startup/tools/tool_executor.ts:210-212`); `allowShellExecution`
  default-denies shell/script when explicitly `false`; recursion capped at 5.
- **X media upload:** correctly jails `filePath` to the workspace root
  (`posts_media.ts:59-80`).
- **Routing:** `router.ts` is a pure `Map` channel→agent lookup with default
  fallback — no isolation issue.
- **Filesystem MCP server** (`integrations/filesystem/server.ts`): uses
  `isWithinJail`; however it has no production caller (test-only), so its
  controls are not on a live path.
