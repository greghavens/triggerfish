# Security review reconciliation — 2026-11-14

This supersedes the status column in `REMEDIATION_PLAN.md`. The findings and
verification reports are historical evidence, not a current list of open bugs.
Reconciliation started at `0451595a` on `security-remediation` and includes the
follow-up changes in this branch. No security changes were merged into `master`,
`language-server`, or `vscode-plugin`.

## What was valid

The verified reports contain **46 finding identifiers, representing 43 distinct
items** after cross-references: CORE-POLICY-2 duplicates AGENT-EXEC-2,
CORE-POLICY-3 duplicates MCP-PLUGIN-5, and CORE-POLICY-4 cross-references
WEB-BROWSER-3/4. The old statement that there were 47 independent findings is
incorrect. Several items were latent defects in unused code, not live exploits.

Important qualifications upheld by the code and verification evidence:

- Missing Telegram/Discord owner configuration really did promote arbitrary
  senders to owner; that is fixed. Undefined-owner routing was a separate latent
  inconsistency, not a demonstrated production escalation.
- The canvas hardening commit `c6739ac8` explicitly corrects the original host
  escape claim: the served Svelte canvas already had a null-origin sandbox and
  chat sanitization. The added SVG/markdown sanitization is defense in depth.
- Log exposure required an explicitly PUBLIC-classified non-owner, not an
  arbitrary unpaired WebChat visitor. The INTERNAL tool floor is still
  justified.
- Git branch validation was warranted hardening, not a demonstrated shell
  injection: the subprocess uses argv and the relevant remotes are HTTPS.
- Session deserialization findings concern corrupt/legacy stored records. The
  notes overstated the reachability of the bumpers bypass in current wiring.
- Prompt scanning and metadata fencing are heuristics, not proof that prompt
  injection is impossible. Authorization must remain below the model.

## Additional gaps reproduced and fixed during reconciliation

1. Disabled/unconfigured plugins executed top-level code before startup
   filtering. Regression probes reproduced all three paths: direct import,
   directory load, and daemon startup. Explicit enabled/trusted grants now gate
   imports. Legacy sandbox requests cannot create executors. The agent's config
   tool cannot grant plugin trust or traverse object prototypes. Install paths
   bind to the granted plugin name, and revoked trust prevents reload rollback
   from reactivating code.
2. The redirect loop forwarded authentication and cookies to other origins,
   preserved POST bodies across 303 redirects, and permitted HTTPS downgrade. It
   now removes common credential headers on origin changes, applies redirect
   method rules, and rejects cross-origin body forwarding and HTTPS downgrade.
3. The replay check and record were separate asynchronous operations. A
   concurrent service regression accepted 10 copies of the same signed event.
   Claims are now serialized before dispatch, and storage failure denies the
   claim. Timestamp-bound signatures are the default; body-only signatures
   require explicit source opt-in.
4. A dangling symlink passed the ancestor-based path jail and could create a
   file outside it. Existing-but-unresolvable path components now fail closed.
5. A configured email address still granted owner privileges from a spoofable
   From header. Email messages now remain non-owner/PUBLIC until authenticated
   sender identity is implemented.
6. Existing LLM task tests exposed timeout handles left alive after completion
   or error. The executor now clears its timer in `finally`. WebChat header
   tests were also corrected to test the new deny-by-default origin policy.

## Finding disposition

“Fixed” means the reported case has a corresponding code fix and regression
coverage in the passing security suite. It is not a claim that every possible
bypass of the larger subsystem has been eliminated.

| Finding                      | Assessment and current disposition                                                                                          | Evidence                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| WEB-BROWSER-1                | Valid; fixed redirect/subresource checks.                                                                                   | `tools_request_guard.ts`; browser request-guard tests                                               |
| WEB-BROWSER-2                | Valid; **partial, still open**. Chrome resolves independently and WebSockets bypass request interception.                   | See remaining work below.                                                                           |
| WEB-BROWSER-3                | Valid; fixed compressed IPv4-mapped IPv6 parsing.                                                                           | `ssrf.ts`; `ssrf_test.ts`                                                                           |
| WEB-BROWSER-4                | Valid; added the reported missing address ranges and NAT64 handling.                                                        | `ssrf.ts`; `ssrf_test.ts`                                                                           |
| WEB-BROWSER-5                | Valid; fixed per-redirect domain-policy checks.                                                                             | `safe_fetch.ts`; web fetch tests                                                                    |
| WEB-BROWSER-6                | Valid; fixed browser denial logging.                                                                                        | Browser request guard/navigation                                                                    |
| CHANNELS-1                   | Valid; fixed missing-owner fail-open defaults.                                                                              | `owner_status.ts`; owner/channel tests                                                              |
| CHANNELS-2                   | Latent, low; fixed strict `isOwner === true` routing.                                                                       | `de8e9612`; channel-access tests                                                                    |
| CHANNELS-3                   | Valid but unwired; fixed by denying owner status from unauthenticated email.                                                | Email IMAP spoofed-From regression                                                                  |
| CHANNELS-4                   | Valid but unwired; fixed Slack missing-owner default.                                                                       | `ae0f7a1a`; owner-status tests                                                                      |
| CHANNELS-5                   | Valid but unwired; fixed default-deny WebChat origins.                                                                      | WebChat auth/header tests                                                                           |
| CHANNELS-6                   | Low; fixed constant-time WhatsApp verification-token comparison.                                                            | `80825ce7`; WhatsApp tests                                                                          |
| CHANNELS-7                   | Low; fixed persistent per-sender pairing attempt caps.                                                                      | `946e37e6`; pairing tests                                                                           |
| MCP-PLUGIN-1                 | Valid high-severity false sandbox claim; **mitigated by disabling untrusted execution**. Real isolation is not implemented. | Plugin trust regressions; updated plugin documentation                                              |
| MCP-PLUGIN-2                 | Valid; RESTRICTED tool floors, path jail, and explicit user trust now gate activation.                                      | Plugin integration/trust/path tests                                                                 |
| MCP-PLUGIN-3                 | Valid; fixed unchecked SSE redirects/reconnects, but connection/DNS binding remains a shared limitation.                    | MCP transport tests; remaining work                                                                 |
| MCP-PLUGIN-4                 | Valid; metadata scanning/fencing added. This is defense in depth.                                                           | MCP executor/plugin registry tests                                                                  |
| MCP-PLUGIN-5 / CORE-POLICY-3 | Valid latent defect; fixed honoring denied MCP hook results.                                                                | MCP gateway tests                                                                                   |
| MCP-PLUGIN-6                 | Valid; safe-fetch defaults added. Independent bundle authenticity and connection/DNS binding remain follow-ups.             | Plugin Reef tests; remaining work                                                                   |
| SCHEDULER-1                  | Valid high; fixed webhook/cron read ceilings and absent-ceiling defaults.                                                   | Scheduler, policy and non-owner tests                                                               |
| SCHEDULER-2                  | Valid; secured default signing and concurrent replay claims. Explicit legacy body-only mode has bounded protection.         | Scheduler signature/concurrency/restart tests                                                       |
| SCHEDULER-3                  | Dead duplicate; removed rather than treated as a live exploit.                                                              | `e1f20899`; canonical HMAC tests                                                                    |
| AGENT-EXEC-1                 | Credential-policy hardening; removed provider environment fallbacks.                                                        | Provider tests; `679945ec`                                                                          |
| AGENT-EXEC-2 / CORE-POLICY-2 | Valid; fixed the reported substitution/redirect parsing cases. Shell parsing is not an execution sandbox.                   | Command classification/path-extraction tests                                                        |
| AGENT-EXEC-3                 | Low defense in depth; fixed owner source labeling.                                                                          | `85185dbe`; orchestrator role tests                                                                 |
| CORE-POLICY-1                | Valid; fixed unknown/missing flow target handling and configured classification validation.                                 | Hook and channel classification tests                                                               |
| CORE-POLICY-4                | Duplicate cross-reference; addressed under WEB-BROWSER-3/4.                                                                 | SSRF tests                                                                                          |
| CORE-STATE-1                 | Valid literal-prefix contract defect; fixed SQLite wildcard expansion.                                                      | Storage provider conformance cases                                                                  |
| CORE-STATE-2                 | Valid unused defense-in-depth code; **deferred**, not a demonstrated credential-exfiltration path.                          | No production gated-keychain construction; factory comment explains raw infrastructure credentials. |
| CORE-STATE-3                 | Valid hardening; added operational-log redaction. Forensic audit logging remains separate.                                  | Redactor tests                                                                                      |
| CORE-STATE-4                 | Low robustness defect; fixed persisted-taint validation and missing-bumpers default.                                        | Session manager tests                                                                               |
| GATEWAY-1                    | Valid; fixed notification flow checks and live post-turn taint.                                                             | Notification and scheduler tests                                                                    |
| GATEWAY-2                    | Latent low; fixed tokenless debug endpoint refusal.                                                                         | Gateway server tests                                                                                |
| GATEWAY-3                    | Latent low; removed RPC `sessions.send`, derived agent-tool target classification from actual session.                      | JSON-RPC/session tests                                                                              |
| GATEWAY-4                    | Dead notification-priority implementation; removed.                                                                         | `f8586c93`; no production consumer                                                                  |
| INTEGRATIONS-CLI-1           | Valid; fixed Git clone/pull destination confinement, including dangling-link follow-up.                                     | GitHub tools and path-jail tests                                                                    |
| INTEGRATIONS-CLI-2           | Low validation hardening; fixed branch validation and option separators.                                                    | GitHub tools tests                                                                                  |
| INTEGRATIONS-CLI-3           | Valid unused verifier design gap; **deferred** until there is a trust-root and identity/key binding design.                 | `routing/delegation.ts` and `delegation_crypto.ts`; no production consumer                          |
| INTEGRATIONS-CLI-4           | Low fail-closed gap; fixed unclassified workflow-run filtering.                                                             | Workflow store tests                                                                                |
| TOOLS-OTHER-1                | Valid; fixed option-shaped SSH host rejection and local-command disabling.                                                  | SSH arguments/executor/session tests                                                                |
| TOOLS-OTHER-2                | Valid; fixed Obsidian query/outlinks confinement and classification checks.                                                 | Obsidian notes/links/classification tests                                                           |
| TOOLS-OTHER-3                | Valid with narrower reachability; fixed INTERNAL log-read floor.                                                            | Non-owner ceiling tests                                                                             |
| TOOLS-OTHER-4                | Low; fixed INTERNAL healthcheck floor.                                                                                      | Non-owner ceiling tests                                                                             |
| TOOLS-OTHER-5                | Unwired guard missing; added skill-name validation before future use.                                                       | Skill-author tests                                                                                  |

Earlier authentication, Google OAuth PKCE/state, Google Chat API verification,
WhatsApp HMAC, symlink confinement, and canvas sanitization commits are retained
on this branch and covered by the same security sweep.

## Work still needed

1. **High: connection-level outbound enforcement.** DNS checking and subsequent
   connection establishment are separate in both safe fetch and Chrome. Chrome
   resolver rules match host strings rather than pinning resolved addresses;
   hostname-based WebSocket traffic is not protected by page interception.
   Implement a transport/proxy that connects only to the validated address while
   preserving TLS hostname verification, and make browser egress use it without
   direct/WebSocket bypass. Validate with a controlled rebinding DNS server and
   real browser/HTTP tests. Mock DNS checks do not prove this property.
2. **Feature deferred: real plugin isolation.** Untrusted execution is blocked,
   so there is no claim of a supported sandbox. A future runtime must isolate
   module import, initialization, and calls, mediate capabilities, and enforce
   CPU/time/memory/network limits. An error wrapper or regex scan is
   insufficient.
3. **Low, unused code: secret gate and delegation.** Decide whether to remove or
   intentionally integrate them. Do not wrap infrastructure authentication in a
   session-taint gate indiscriminately. Delegation needs a trusted root and
   cryptographic identity/key binding for subsequent signers, not only matching
   adjacent agent-name strings.
4. **Explicit legacy webhook mode:** body-only HMAC does not authenticate a
   timestamp. Its replay cache has TTL/size bounds and claim serialization is
   per daemon, not a distributed storage transaction. Providers needing this
   mode require authenticated delivery identifiers/appropriate persistence for
   stronger replay guarantees. Timestamp-bound signing remains the default.
5. **Marketplace authenticity:** a checksum and catalog served by the same
   compromised origin are not an independent signature. Trusted publisher
   signatures/keys remain a separate supply-chain improvement.
6. **Authenticated email ownership:** until the mail transport supplies verified
   sender identity, email must remain non-owner even when From matches the
   owner.
7. **Dependency-alert triage:** the successful push on 2026-11-14 reported
   [47 Dependabot alerts on the default branch](https://github.com/greghavens/triggerfish/security/dependabot):
   11 high, 24 moderate, and 12 low. These are separate from the source-review
   identifiers above. Their applicability to production versus build/docs
   dependencies and available upgrades has not been established by this audit.

## Validation

Baseline before these changes: type check and lint passed; the full suite had
3,833 passing, 21 failing, and 7 ignored tests. Repository-wide formatting had
74 pre-existing failures. Unrelated bulk formatting was kept off this branch.

The focused security sweep covers core, agent, channels, CLI, execution,
gateway, integrations, log poisoning, MCP, plugins, scheduler, web, browser,
Obsidian, skills, SSH, memory, and workflow-store tests. Final results:

| Check                                                  | Result                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| Focused security sweep                                 | **2,993 passed, 0 failed, 7 ignored**                                   |
| Full repository suite                                  | **3,857 passed, 14 failed, 7 ignored**; all failures match the baseline |
| `deno task check`                                      | Passed                                                                  |
| `deno task lint`                                       | Passed; 1,246 files checked                                             |
| Type-check both new regression test modules            | Passed                                                                  |
| Format check of changed code/docs and this status file | Passed; 36 files checked                                                |
| `git diff --check`                                     | Passed                                                                  |
| Repository-wide formatting                             | 73 existing failures, all in unchanged files                            |

Security sweep command:

```sh
deno task test tests/core/ tests/agent/ tests/channels/ tests/cli/ tests/exec/ \
  tests/gateway/ tests/integrations/ tests/log_poisoning/ tests/mcp/ tests/plugin/ \
  tests/scheduler/ tests/tools/browser/ tests/tools/web/ tests/tools/obsidian/ \
  tests/tools/skills/ tests/tools/ssh/ tests/tools/memory/ tests/workflow/store_test.ts
```

The remaining full-suite baseline failures are outside the security changes: two
Docker base-image expectations, one A2UI connection-envelope expectation, nine
legacy Tidepool UI/card/screen expectations, and two workflow-save error format
expectations. They remain visible; no tests were skipped to hide them.
