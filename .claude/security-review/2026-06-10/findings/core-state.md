# Core-State Security Review — 2026-06-10

Domain: **core-state** — `src/core/session/`, `src/core/storage/`, `src/core/secrets/`, `src/core/logger/`, `src/core/image/`.

Scope reviewed: session manager + taint lifecycle, lineage store/serde/retention, bumpers,
StorageProvider implementations (memory + SQLite), the full secrets subsystem (resolver,
keychain backends, encrypted-file provider + crypto, key manager, composite store, secret
cache, classification gate, Vault client/auth/lease), logger (sanitizer/writer/audit), and
image content types.

Overall the core-state surface is in good shape. Taint is correctly modeled as escalate-only
(`escalateTaint` / `maxClassification`), the production session-restore path forces taint to
PUBLIC across restarts (`restoreSession`), `canFlowTo` is used in the correct direction for
write-down checks and lineage `getByHash`, lineage content is only persisted for PUBLIC records,
secret backends never log secret values, keychain/DPAPI subprocesses pass secret material via
argv arrays / stdin (no shell, no command injection), and the encrypted-file store uses
AES-256-GCM with a random machine key, fresh per-write IVs, and 0600 file permissions.

The findings below are hardening / latent-bug issues, not live policy bypasses.

---

## CORE-STATE-1: SQLite `list()` prefix uses unescaped LIKE — wildcards (`_`, `%`) over-match across key namespaces

**Severity:** medium

**Location:** `src/core/storage/sqlite.ts:54` (prepared statement), used at `:66` and via `:99` `list()`

**Description:**
`StorageProvider.list(prefix)` is the primitive every state namespace relies on for
enumeration (sessions, lineage, memory, conversation, team, pairing, cron, triggers,
workflows). The interface contract (`provider.ts:25`) is a literal prefix match, and the
in-memory implementation honors that with `String.startsWith` (`memory.ts:18`). The SQLite
implementation instead matches with a `LIKE` pattern built from the raw prefix:

```ts
// sqlite.ts
listPrefix: db.prepare("SELECT key FROM kv WHERE key LIKE ? || '%'"),
// ...
return stmts.listPrefix.all<KeyRow>(prefix).map((r) => r.key);
```

There is no `ESCAPE` clause, so any `_` (match-any-single-char) or `%` (match-any-sequence)
characters inside the supplied prefix are interpreted as SQL LIKE wildcards rather than
literal characters. A prefix such as `memory:agent_1:` would also match keys like
`memory:agentX1:` / `memory:agent#1:`, and a prefix containing `%` matches across the
namespace separator entirely. This is a cross-namespace / cross-tenant isolation hazard for
`list()`-based enumeration, deletion (e.g. lineage/session retention purges iterate the keys
returned by `list()`), and classification-filtered reads (the memory store enumerates
`memory:<agentId>:<level>:` via `list()` and applies `canFlowTo` per record — wildcard
over-matching could pull records from an unintended agent namespace into the candidate set).

**Exploitability (current wiring):** Not presently reachable. Every variable segment that is
interpolated into a `list()` prefix today is a `crypto.randomUUID()` session/lineage id, a
SHA-256 hex content hash, a fixed enum (`channelType` in `pairing.ts`, classification level
names), or a hard-coded constant (`OWNER_MEMORY_AGENT_ID = "main-session"`, `team:`), none of
which contain `_` or `%`. So this is a latent bug, not a live bypass — hence medium, not high.

**Why it still matters:** (1) it is a silent violation of the StorageProvider contract that
the entire codebase trusts for namespace isolation; (2) it is invisible to the test suite,
which runs against the in-memory provider whose `startsWith` semantics differ — so a future key
format that embeds user-derived data (an arbitrary agent id, a team member handle, an email
local-part, a label) containing `_`/`%` would introduce a real cross-namespace leak/delete that
passes all tests; (3) `_` is an extremely common identifier character, making accidental
introduction likely.

**Evidence:**
```ts
// src/core/storage/provider.ts:25 — contract is a literal prefix
/** List all keys matching an optional prefix. ... */
list(prefix?: string): Promise<string[]>;

// src/core/storage/memory.ts:18 — literal semantics
return [...data.keys()].filter((k) => k.startsWith(prefix));

// src/core/storage/sqlite.ts:54 — wildcard semantics, no ESCAPE
listPrefix: db.prepare("SELECT key FROM kv WHERE key LIKE ? || '%'"),
```

**Recommendation:**
Make SQLite match literal prefixes. Either:
- Escape LIKE metacharacters in the bound prefix and add an explicit `ESCAPE` clause:
  `WHERE key LIKE ? ESCAPE '\\'` with `prefix.replace(/[\\%_]/g, "\\$&") + "%"`; or
- Avoid LIKE entirely using a range scan that needs no escaping:
  `WHERE key >= ? AND key < ?` binding `prefix` and `prefix + "￿"` (or the
  `substr(key,1,length(?)) = ?` form).
Add a shared StorageProvider conformance test that asserts identical `list()` results from the
memory and SQLite providers for prefixes containing `_` and `%`, so the two implementations
cannot diverge again.

---

## CORE-STATE-2: Classification-gated keychain (`SecretAccessGate`) is implemented and tested but never wired into production

**Severity:** low

**Location:** `src/core/secrets/classification/gated_keychain.ts:44`, `src/core/secrets/classification/secret_access_gate.ts:97`, `src/core/policy/hooks/secret_access_hook.ts:43`

**Description:**
The codebase ships a `SECRET_ACCESS`-hook-backed keychain wrapper that gates `getSecret` on the
secret's classification vs. session taint, including a default rule that denies RESTRICTED
secrets to background/trigger sessions (`createDefaultSecretAccessRules`,
`secret_access_hook.ts:102`). However, `createGatedKeychain` / `createSecretAccessGate` are only
referenced by `mod.ts` barrels and tests (`tests/gateway/secret_access_wiring_test.ts`,
`tests/gateway/trigger_session_taint_test.ts`) — no production startup path constructs them.
Every production secret consumer (`gateway/startup/.../*_executor.ts`, `bootstrap.ts`,
`channels.ts`, `config_watcher.ts`, CLI commands) calls `createKeychain()` and passes the **raw,
ungated** `SecretStore` directly to `resolveConfigSecrets` / `resolveSecretRefs` / integration
clients. Consequently the per-secret classification gate and the "no RESTRICTED secrets in
background sessions" rule are not enforced at runtime.

**Exploitability (current wiring):** Limited. Config-level secret refs are resolved once at
startup (outside any LLM/session taint context), and tool-arg `{{secret:name}}` resolution
happens below the LLM layer in `access_control.ts:208` — the LLM never sees the values and
cannot name-spoof to read a value it then exfiltrates without tripping the separate resource-
classification / output gates. So this is a missing defense-in-depth layer rather than a direct
exfiltration path; recording as low per the dead/unwired-code guidance.

**Evidence:**
```
$ grep -rn "createGatedKeychain\|createSecretAccessGate" src/ | grep -v mod.ts | grep -v classification/
# (no matches — no production wiring)
```
```ts
// src/core/secrets/classification/secret_access_gate.ts:65 default dispatcher
function defaultHookDispatcher(input): Promise<SecretAccessHookResult> {
  if (canFlowTo(classification, sessionTaint)) return { action: "ALLOW" };
  return { action: "ALLOW", escalateTo: classification }; // allow-with-escalation, never DENY
}
```

**Recommendation:**
If per-secret classification gating is an intended product control, wire `createGatedKeychain`
(with `createSecretAccessGate` + `createDefaultSecretAccessRules` + a live `getSessionTaint` /
`getIsBackground`) into the orchestrator/tool-executor secret path so background/trigger sessions
cannot read RESTRICTED secrets and reads above session taint escalate or deny per policy. If it
is intentionally unused, delete the dead modules to avoid implying a guarantee that is not
enforced. Either way this is out-of-scope of any single PR — recommend tracking via a GitHub
issue rather than an in-place change.

---

## CORE-STATE-3: Logger has no secret-redaction layer; structured args are `JSON.stringify`'d verbatim

**Severity:** low

**Location:** `src/core/logger/logger.ts:96-99` (`formatLine`), `:120-130` (`dispatchLogLine`)

**Description:**
`createLogger().{error,warn,info,debug,trace}(msg, ...args)` serializes every non-string arg
with `JSON.stringify` and writes it to both stderr and the on-disk log
(`~/.triggerfish/logs/...`). There is no allow/deny-list or key-name based redaction
(e.g. `apiKey`, `token`, `secret`, `password`, `Authorization`). The only sanitizing path is the
opt-in `log.ext()` method, which merely truncates/neutralizes control chars and wraps values in
provenance delimiters — it does not redact secrets. The audit log
(`audit.ts:60`) intentionally writes raw content. Today the in-scope secret backends are careful
(`encrypted_file_provider.ts`, `file_provider.ts`, `linux/mac/windows keychain`, Vault auth) to
log only `{ name }` / status and never the secret value, and `resolveToolSecrets`
(`access_control.ts:203`) does not log resolved input. So no in-scope code currently leaks a
secret. The gap is the absence of a backstop: any current or future caller anywhere that does
`log.debug("...", someObjectContainingASecret)` (e.g. logging a full tool-input object after
`{{secret:}}` substitution, or an HTTP request init with an `Authorization` header) writes the
plaintext secret to persistent logs.

**Exploitability (current wiring):** No confirmed live leak in the audited modules — this is a
defense-in-depth gap, recorded as low.

**Evidence:**
```ts
// src/core/logger/logger.ts:96
const extra = args.length > 0
  ? " " + args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ")
  : "";
// no redaction of token/apiKey/secret/password/authorization keys before write
```

**Recommendation:**
Add a redaction pass in `dispatchLogLine`/`formatLine` (or a shared `redactSecrets(value)`
helper) that deep-walks structured args and masks values whose key matches a denylist
(`/secret|token|password|api[_-]?key|authorization|cookie|client_token|secret_id/i`) and masks
high-entropy bearer-like string values. This complements (does not replace) the existing
per-call-site discipline and guards against future regressions.

---

## CORE-STATE-4: Session `deserialise()` performs no schema validation; missing `bumpersEnabled` silently disables bumpers

**Severity:** low

**Location:** `src/core/session/manager.ts:68-80` (`deserialise`), interacting with `src/core/session/bumpers.ts:41`

**Description:**
`deserialise()` does `JSON.parse(raw)` and spreads `...data` straight into a `SessionState` with
no validation that `taint` is a valid `ClassificationLevel`, that `bumpersEnabled` is present, or
that `history` entries are well-formed. The persisted shape is trusted as-is. Two concrete
consequences if a `sessions:` record is malformed or written by an older schema:
- A record lacking `bumpersEnabled` deserializes with `bumpersEnabled === undefined`. Bumpers
  default to ON at creation (`createSession`, `restoreSession`), but `wouldBumpersBlock`
  short-circuits on `if (!session.bumpersEnabled) return false` (`bumpers.ts:41`), so an
  `undefined` value evaluates falsy and **silently disables** the taint-escalation guard for
  that restored session.
- A record with a `taint` value outside the four enum members yields
  `CLASSIFICATION_ORDER[taint] === undefined`, making downstream `canFlowTo`/`maxClassification`
  comparisons behave unpredictably (they generally fail closed, but the state is undefined-behavior).

**Exploitability (current wiring):** Low. The `StorageProvider` is internal, not directly
attacker-writable, and the primary production session-restore path persists only `{id, createdAt}`
under `session-id:<channel>` and rebuilds via `restoreSession` (which always sets `bumpersEnabled`
and PUBLIC taint), bypassing this deserializer. The full-state `sessions:` serializer/deserializer
is exercised by `SessionManager`/`EnhancedSessionManager` (wired in `startup/infra/storage.ts`)
for `get`/`list`/`sessionsSend`/team taint lookups, so a malformed/old record there would surface
the bumper-disable behavior. This is a robustness/fail-safe gap rather than a remote exploit.

**Evidence:**
```ts
// src/core/session/manager.ts:68
function deserialise(raw: string): SessionState {
  const data = JSON.parse(raw);
  return { ...data, createdAt: new Date(data.createdAt), history: /* ... */ } as SessionState;
  // no validation of data.taint ∈ ClassificationLevel, no default for data.bumpersEnabled
}

// src/core/session/bumpers.ts:41
if (!session.bumpersEnabled) return false; // undefined ⇒ bumpers treated as OFF
```

**Recommendation:**
Validate on deserialize: reject (or fail-closed) records whose `taint` is not a valid
`ClassificationLevel` (`parseClassification`), and coerce a missing `bumpersEnabled` to the
secure default `true` (e.g. `bumpersEnabled: data.bumpersEnabled ?? true`) so a legacy/partial
record cannot silently disable the escalation guard. Optionally validate `history` entry shapes.
