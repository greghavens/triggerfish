# Sentinel and ARTEX tool audit

This audit compares ARTEX Global revision
[06b36d72](https://github.com/jiwoochris/artex-global/tree/06b36d72) with
Triggerfish Sentinel. It distinguishes model-callable tools from operator
controls and identifies full or partial workflow coverage. A similarly named
tool, a provider-visible declaration, and a tested dispatch are separate claims.

ARTEX starts with role defaults, adds host and SDK tools, resolves configured
bindings, and applies workflow-specific filters. The roles below describe the
checked source defaults and runtime assembly. Live deployments may change
bindings. The goals runner has its own direct capture path.
[Role catalog](https://github.com/jiwoochris/artex-global/blob/06b36d72/agent/toolcatalog.go),
[assembly](https://github.com/jiwoochris/artex-global/blob/06b36d72/agent/assembly.go),
[server resolver](https://github.com/jiwoochris/artex-global/blob/06b36d72/server/assembly.go),
[goals runner](https://github.com/jiwoochris/artex-global/blob/06b36d72/agent/goals.go).

Sentinel has a fixed model allowlist and checks the same role again at dispatch.
Interactive sessions can delegate one level. Leased workers receive their pinned
assignment and additional tools only when the required service and policy are
configured. The planner receives structured case facts and submits a validated
plan. Operator functions enter through the authenticated chat, Tidepool, or CLI
routes. [Model registration and dispatch](../src/gateway/sentinel_agent.ts),
[planner and lease execution](../src/gateway/sentinel_adaptive_runtime.ts),
[Tidepool handlers](../src/gateway/startup/services/tidepool_sentinel.ts),
[CLI](../src/cli/commands/sentinel.ts).

## Worker management, goals, and planning

| ARTEX tool                                                                      | ARTEX binding and runtime path                                                                                                                                                                                                             | Sentinel equivalent and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_worker_output`, `get_worker_trace`, `search_all_worker_traces`             | Coordinator and planner use output and trace tools. Workers have exact trace and cross-worker search.                                                                                                                                      | Model-callable `sentinel_worker_observation` reopens a committed observation. Authenticated operator agents can search and page exact outputs across selected case revisions through `operator_runs worker_observations`. [Archive gateway fixture](../tests/gateway/sentinel_run_archive_test.ts). `sentinel_worker_trace_search` searches saved review traces in the permitted scope. Coverage is structured Sentinel observations and bounded review traces. [Agent fixture](../tests/sentinel/agent_test.ts), [shared observation fixture](../tests/sentinel/intermediate_workflow_gateway_test.ts).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `list_worker_traces`                                                            | The implementation is exported for delegated task reads. The worker default explicitly removes it.                                                                                                                                         | The Sentinel trace search supports bounded enumeration. Tidepool can inspect the selected case timeline. There is no global unscoped trace listing. [Agent fixture](../tests/sentinel/agent_test.ts), [workspace fixture](../tests/sentinel/tidepool_workspace_test.ts).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `add_intent`, `add_hint`                                                        | Coordinator and planner intent authoring and coordinator hint tools use separate role bindings.                                                                                                                                            | The authenticated owner agent can call `operator_runs assign` to queue an exact defensive graph investigation after approval. The durable receipt binds the case, run, evidence and adaptive revisions, request UUID, and task ID. `operator_runs hint`, Tidepool hints, and the model-callable `sentinel_case_hints` reader carry case-wide guidance separately. Planner suggestions use typed assignments. [Gateway fixture](../tests/gateway/operator_run_tool_test.ts), [atomic queue and receipt tests](../tests/sentinel/operator_assignment_intent_test.ts).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `steer_work`, `kill_work`                                                       | Steering is part of coordinator and planner work control. The planner tool set includes termination.                                                                                                                                       | The authenticated owner agent can call `operator_runs steer` or `stop` with approval for an exact Sentinel case, run, revision, and assignment. Native chat and Tidepool share the durable receipt path. Steering reaches the selected worker at its next boundary. Stopping preserves committed progress and prevents re-claim. Leased workers have no steering or stop grant. [Authenticated owner and Tidepool fixture](../tests/gateway/sentinel_live_worker_control_test.ts), [checkpoint and stop regressions](../tests/sentinel/worker_controls_test.ts).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `list_goals`, `set_goals`, `prove_goal`, `goal_met`, `TodoWrite`                | Planner can inspect goals and submit proof. Coordinator and the isolated goal runner can set goals and constraints. The catalog defaults `goal_met` to unbound. The SDK todo store is configured separately for planner and session roles. | Model-callable `sentinel_goal_state` reads formal goal state. Operators approve start/append via chat, and the completion adapter evaluates criteria against saved evidence. Tidepool shows the adaptive queue. Sentinel's planner uses the standard `todo_read` and `todo_write` tools for a bounded checklist within the active case, run, and evidence revision. Reopening the planner preserves its list. Checklist entries never dispatch work or satisfy goal criteria. [Planner checklist fixture](../tests/gateway/sentinel_planner_todo_test.ts). [Formal goal fixture](../tests/gateway/sentinel_formal_goal_test.ts), [completion fixture](../tests/sentinel/goal_completion_adapter_test.ts), [workspace fixture](../tests/sentinel/tidepool_workspace_test.ts).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `set_constraints`                                                               | The coordinator and isolated goal runner can submit run-scoped allow/deny constraints, which are injected into planner and worker context.                                                                                                 | The authenticated ordinary owner agent can list/read and revise typed Sentinel restrictions through `operator_runs` with explicit confirmation and exact case, run, evidence revision, and version. Planning and worker dispatch enforce task-kind and assigned-asset restrictions within baseline policy. Planner manifests and completed model reviews record the exact version and digest. Standalone Sentinel chat and leased workers do not have a constraint mutation grant. [Gateway and policy fixture](../tests/gateway/operator_run_tool_test.ts), [runtime fixture](../tests/sentinel/sentinel_constraint_runtime_test.ts), [provenance tests](../tests/sentinel/planner_constraint_provenance_test.ts).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `list_tasks`, `spawn_task`, `pause_task`, `add_task_hint`, `list_llm_profiles`  | Server orchestration dispatch defaults these to the Auto role.                                                                                                                                                                             | The authenticated ordinary owner agent can call `operator_runs` through root dispatch to list, start, inspect, link, pause, and resume published Sentinel cases and explicitly configured deterministic workflows. It can submit revision-bound Sentinel hints and discover the effective model routes permitted by the current owner destination ceiling. Operator confirmation gates state changes. Workflow pause/resume applies in process, while admitted history and links survive restart. [Planner fixture](../tests/sentinel/live_workflow_planning_test.ts), [agent fixture](../tests/sentinel/agent_test.ts), [workspace fixture](../tests/sentinel/tidepool_workspace_test.ts).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `get_task_worker_trace`, `list_task_worker_traces`, `search_task_worker_traces` | Auto orchestration delegates to the selected task trace runtime.                                                                                                                                                                           | The owner agent can call `operator_runs traces` for either a Sentinel case or an admitted workflow. Sentinel uses exact case/revision/task and optional query or step indices. Workflows use the exact run ID, classification and configured plan fingerprint, with bounded pages and exact sequence lookup after restart. Workflow timelines retain typed step and lifecycle events. The authenticated owner can discover delegated, cron, trigger, and verified webhook runs with `operator_runs execution_traces`. The same root tool pages durable metadata and reopens one exact step using the admitted role and run ID. Its INTERNAL ceiling applies to the whole run. Receipts contain tool names, classifications, and outcomes. Verified webhook recovery retains the original step receipt without recording a second dispatch when the checkpoint is reused. Owners can reopen approved GitHub Actions status projections by exact role, run and step through `operator_runs execution_trace_payload`. Reopen checks the current root tool policy, credential access, classification, and immutable repository ID. It uses a permission check without repeating the saved listing. Additional approved payload families remain open. [Historical access fixture](../tests/gateway/execution_trace_payload_authorizer_test.ts). [Webhook recovery fixture](../tests/scheduler/webhook_recovery_test.ts). [Delegated fixture](../tests/gateway/root_hook_roles_test.ts), [scheduler fixture](../tests/scheduler/execution_traces_test.ts). Links between runs confer no evidence access. [Authenticated gateway fixture](../tests/gateway/operator_run_tool_test.ts), [workflow durability and scoping](../tests/gateway/operator_workflow_runs_test.ts), [Sentinel agent fixture](../tests/sentinel/agent_test.ts). |

[ARTEX scoped tools](https://github.com/jiwoochris/artex-global/blob/06b36d72/agent/tools.go),
[worker and coordinator tools](https://github.com/jiwoochris/artex-global/blob/06b36d72/agent/tools_insert.go),
[orchestration dispatch and defaults](https://github.com/jiwoochris/artex-global/blob/06b36d72/server/orchestration.go),
[planner todo state](https://github.com/jiwoochris/artex-global/blob/06b36d72/agent/planner.go).

## Host tools and extensions

| ARTEX tool                                                                                                  | ARTEX binding and runtime path                                                                                                                                        | Sentinel equivalent and boundary                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Read`, `Write`, `Edit`, `MultiEdit`, `LS`, `Glob`, `Grep`, `Bash`, `Sleep`, `skill`, `MCP`                 | SDK defaults are assembled by role. The worker excludes `MultiEdit`, `Glob`, and `Grep` from its SDK default set. Assembly augments with enabled skill and MCP tools. | Sentinel model tools read typed, scoped evidence through dedicated readers. The host triage reader is a CLI path. Generic filesystem mutation, shell, open-ended delays, and unrestricted extension discovery are outside the isolated model surface. [Agent fixture](../tests/sentinel/agent_test.ts), [host triage fixture](../tests/sentinel/host_triage_test.ts).     |
| `create_skill`, `update_skill_file`, `create_custom_tool`, `update_custom_tool`, `create_mcp`, `update_mcp` | Server platform tools are bound to Auto by default.                                                                                                                   | Sentinel model roles cannot modify the tool catalog or add a connector. Operator-configured live GitHub workflow reads use a fixed connector and destination with policy verification. Extending that approach would require one typed connector and policy per approved operation. [Approved and denied read fixture](../tests/sentinel/live_workflow_planning_test.ts). |

[ARTEX worker assembly](https://github.com/jiwoochris/artex-global/blob/06b36d72/agent/worker.go),
[platform tools](https://github.com/jiwoochris/artex-global/blob/06b36d72/server/platform_tools.go).

The ordinary owner agent can update two settings on one configured
MCP connector through `mcp_manage update`, the tool-call timeout and
retry count. Root dispatch checks the owner session, shows the exact
change for confirmation, and rechecks the config and owner before
writing. The gateway fixture covers denial, stale confirmation,
duplicate requests, response classification, and destination policy.
The settings are read on daemon restart. The update accepts these two
runtime settings and preserves connector transport, command, credentials,
and classification. [Owner gateway fixture](../tests/gateway/tools/mcp_manage_update_test.ts).
The configured connector fixture starts two separate gateway processes.
It proves that a 1,450 ms tool response succeeds under the original
timeout and expires under the approved 1,000 ms timeout after restart.
A second configured connector records the approved lower retry count.
The persisted YAML retains the credential reference.
[Connector restart fixture](../tests/gateway/tools/mcp_manage_reload_test.ts).

The ordinary owner agent can call `mcp_manage tools` for an exact
configured connector. It lists the tool names in the live registry used
to advertise this connector to chat. A failed or unclassified connector
has no advertised MCP grants. A later invocation still passes its own
root and connector policy checks. The configured gateway fixture
discovers a live tool and then invokes it, and the owner approval
fixture exercises the root policy hooks on the discovery result.
[Gateway fixtures](../tests/gateway/tools/mcp_manage_reload_test.ts) and
[owner dispatch tests](../tests/gateway/tools/mcp_manage_update_test.ts).

The owner agent can also use `list_skills` through root dispatch to page
active skill metadata under the current classification ceiling. Pending and
rejected authored drafts are excluded before resolving name precedence.
An activation whose source changed after discovery is denied. The gateway
fixture verifies owner and role scope, root hooks, and a pending workspace
draft that cannot activate or hide an active bundled skill.
[Skill discovery gateway fixture](../tests/gateway/skill_discovery_gateway_test.ts).

The owner can inspect and approve one exact authored draft digest through
root dispatch. Approval rechecks current policy and the draft bytes after
confirmation. Its receipt records the owner session, SHA-256, and timestamp.
A changed file needs a new approval. The gateway fixture reopens the
persisted approval in a new server session within the same process.
[Skill approval gateway fixture](../tests/gateway/skill_approval_gateway_test.ts).

For an already approved workspace skill, the owner can inspect a Markdown
proposal at the fixed `SKILL.revision.md` path and stage it with
`stage_skill_revision`. Confirmation binds the approved source digest and
the proposed digest. The write preserves capability metadata and the earlier
approval receipt. The replacement remains inactive until it receives its
own approval. The gateway fixture verifies changes during confirmation,
stale replay, and the pending replacement after reconnect.






## Graph, inventory, and findings

| ARTEX tool                                                                                                                               | ARTEX binding and runtime path                                                                                                                           | Sentinel equivalent and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graph_overview`, `list_findings`, `list_facts`, `node_detail`, `expand_digest`                                                          | Coordinator and planner receive graph read tools. Workers get a narrower selection including findings and node detail.                                   | Model-callable `sentinel_report`, `sentinel_provenance_search`, `sentinel_provenance_node`, `sentinel_trace`, `sentinel_path`, and `sentinel_impact` read the pinned graph and saved provenance. Nodes and saved observations reopen by exact ID. The authenticated owner can save compact, content-addressed case revision digests through `operator_runs` and expand frozen members through bound cursors. Sentinel chat and planners can list and expand digests in their selected case through read-only root tools. The planner automatically folds saved inventory outside its inline window into reopenable, content-addressed member digests. The planning manifest records the digest IDs shown to the model. Completed tasks and their committed observations that fall outside the prompt also fold into separate history digests. Running and queued tasks stay outside history digests. Additional verified fact families remain open. [Cold inventory fixture](../tests/sentinel/planner_cold_digest_test.ts). [Authenticated digest fixture](../tests/gateway/sentinel_discovery_withdrawal_test.ts), [Sentinel role fixture](../tests/gateway/sentinel_model_evidence_digests_test.ts). [Agent fixture](../tests/sentinel/agent_test.ts), [fact reuse fixture](../tests/sentinel/fact_satisfaction_gateway_test.ts).                                                                                                                                                            |
| `get_task_graph`, `list_task_findings`, `get_task_node_detail`                                                                           | Auto orchestration delegates scoped reads to the selected task graph.                                                                                    | Sentinel model readers operate on their authorized case and revision. The owner’s `operator_runs` tool exposes paginated graph, finding, and exact node reads under an explicit case and revision. [Root gateway scope and hook fixture](../tests/gateway/operator_run_tool_test.ts). [Workspace fixture](../tests/sentinel/tidepool_workspace_test.ts), [finding source fixture](../tests/sentinel/shared_finding_source_test.ts).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `insert_assets`, `list_assets`, `list_companies`, `add_company_scope`, `add_task_scope`, `list_untested_assets`, `delete_assets_by_host` | Coordinator, planner and inventory-capable roles use distinct scopes. Goals can capture task scope. Host-based deletion is an Auto platform action.      | Workers can submit verified discoveries for operator approval, reopen original source provenance, and query their assigned asset through `sentinel_case_inventory`. The authenticated owner agent uses `operator_runs inventory` to page saved assets, declared organizations and review coverage for a case or its approved membership. `preview_membership` and `set_case_membership` resolve exact local asset IDs or organization declarations, then confirm the fixed set against the same run, revision, snapshot and policy version. New assets are excluded until approved. Archived views retain the original proof. The owner can preview and confirm bulk withdrawal of verified discoveries for one exact host and source case. The batch records an immutable receipt, rejects stale selections, and retains historical source evidence. The owner can also preview and confirm withdrawal of one unambiguous exact host from a case’s operator-published inventory. Commit checks the previewed source digest, archives the original graph, and publishes only the exact reviewed change. [Withdrawal gateway fixture](../tests/gateway/sentinel_discovery_withdrawal_test.ts). [Gateway fixture](../tests/gateway/operator_run_tool_test.ts), [historical inventory](../tests/gateway/operator_sentinel_inventory_test.ts), [membership provenance](../tests/sentinel/operating_constraints_test.ts), [cross-case discovery](../tests/sentinel/asset_discovery_gateway_test.ts). |
| `record_fact`, `report_finding`                                                                                                          | Workers and coordinator have write-back tools. Finding publication also has bindings for other roles.                                                    | Configured leased workers can publish a typed validated workflow observation via `sentinel_publish_workflow_observation`. Another worker can reopen it before final review. A leased worker can publish an exact asset-scoped failed control verification through `sentinel_report_finding`. The worker first reads the linked evidence under the same lease. Leased workers can also publish an exact graph relationship from a post-authorized assigned-target read. Same-target peers can reopen it while the producer is running, and the planner receives exact fact IDs in its input manifest. Follow-up assignments preserve the accepted fact citation and source prerequisite. Current and historical provenance link the exact receipt to its producing task, cited assignment, and original graph endpoints. [Graph fact gateway fixture](../tests/gateway/sentinel_graph_fact_test.ts). The owner’s root-dispatched `operator_runs facts` pages case/revision-scoped receipts and reopens an exact saved ID outside the planner’s recent window. Other fact families remain open. [Worker finding fixture](../tests/gateway/sentinel_worker_findings_test.ts). [Intermediate observation fixture](../tests/sentinel/intermediate_workflow_gateway_test.ts), [workspace fixture](../tests/sentinel/tidepool_workspace_test.ts).                                                                                                                                                      |
| `get_finding_retest_context`, `record_finding_retest_result`, `update_finding_report`                                                    | Retest read and write require the enabled dedicated retest role and a retest session. Auto report updates dispatch through the orchestration host tools. | A later leased worker uses `sentinel_finding_recheck_context` and `sentinel_record_finding_recheck` to record a separate outcome for newer retained evidence on the same control and asset. `sentinel_update_finding_report` appends an exact-version edit. Historic report and evidence stay intact. [Authenticated findings and revision export fixture](../tests/gateway/sentinel_worker_findings_test.ts).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

[ARTEX graph and scoped tools](https://github.com/jiwoochris/artex-global/blob/06b36d72/agent/tools.go),
[inventory and fact write-back](https://github.com/jiwoochris/artex-global/blob/06b36d72/agent/tools_insert.go),
[task delegation and report update](https://github.com/jiwoochris/artex-global/blob/06b36d72/server/orchestration.go),
[retest workflow](https://github.com/jiwoochris/artex-global/blob/06b36d72/server/finding_retests.go).

## Captured traffic and finding evidence

| ARTEX tool                                    | ARTEX binding and runtime path                                                                                    | Sentinel equivalent and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `traffic_search`, `traffic_get`               | Capture-backed host readers resolve to worker and reporter defaults. Capture and workflow policy gate visibility. | `sentinel_traffic_search` pages sanitized HTTP/DNS receipts. `sentinel_traffic_get` reopens the exact evidence ID and digest. The Sentinel chat agent can read the selected case and saved revision. Leased workers read only their assigned asset at their pinned revision. [Root dispatch and scope tests](../tests/gateway/sentinel_traffic_tool_test.ts).                                                                                                                                                                                                                                    |
| `traffic_blob`                                | Returns retained transaction data where the source captured it.                                                   | Reviewed HAR request and response text, binary responses, and allowlisted headers can be retained explicitly and paged through `sentinel_traffic_blob` or owner `operator_runs traffic_blob`. The case revision, evidence ID, and digest bind the exact text. Default feeds retain metadata. [Receipt retention tests](../tests/sentinel/traffic_receipts_test.ts).                                                                                                                                                                                                                                                                                                                                    |
| `get_finding_traffic`, `bind_finding_traffic` | Finding traffic reads have broader role bindings. The default binding writer is the reporter.                     | `sentinel_finding_traffic_links` lists attachments for the selected revision, narrowed to the assigned asset for leased workers. The same read tool pages reviewed payloads by exact finding and link ID. `sentinel_attach_finding_traffic` is the leased-worker path. Authenticated operators can use `operator_runs finding_traffic_candidates` and `attach_finding_traffic` with explicit confirmation. It requires an authorized exact receipt read in the current turn and checks the finding or recheck, assignment, evidence revision, and report version. Tidepool and CLI provenance exports retain the exact revision links. [Authenticated gateway workflow](../tests/gateway/sentinel_finding_traffic_test.ts), [journal and revision export tests](../tests/sentinel/finding_traffic_links_test.ts). |

[ARTEX finding-workflow binding migration](https://github.com/jiwoochris/artex-global/blob/06b36d72/server/finding_workflow.go),
[capture-backed tools](https://github.com/jiwoochris/artex-global/blob/06b36d72/server/manager.go).

The local audit reran 38 tests across isolated agents, asset discovery, fact
satisfaction, intermediate observations, approved workflow reads, formal goals,
configured capture, host triage, and rule export. These fixtures exercise local
dispatch and replay with synthetic evidence and mocked connector transport. The
additional linked fixtures identify coverage for flows outside that rerun.

## Run archival and restoration

The authenticated owner agent can call `operator_runs` with `archive`,
`restore`, or `archive_history` for an exact named Sentinel case, run ID, and
evidence revision. Archive requires a stopped case and confirmation. It creates
a verified package and leaves the stopped source in place. Restore requires the
archive ID, a new request ID, and confirmation. The destination case and run
identity must be available. Restoration installs a paused case. Resume through
the existing run lifecycle control to make pending work eligible.

The shared archive layer verifies the artifact inventory, sizes, and digests.
Sentinel retains approved goals, decisions, task history, and case-local
evidence references. Its archive projection strips execution checkpoints and
active lease authority. The action journal retains success and failure receipts.

The [gateway round trip](../tests/gateway/sentinel_run_archive_test.ts) verifies
approved goals, the finding decision, completed worker output, an exact evidence
node, and execution of a dependent task after resume. It also covers root
pre-call denial, duplicate requests, identity collision, and corrupt or missing
artifacts. The workflow, delegated, and scheduled integrations below cover
their corresponding durable run records.

Admitted operator workflows can now resume an interrupted deterministic run
using its current configured plan fingerprint, classification, and committed
step states. The gateway skips the completed prefix and restarts an unfinished
side-effect-free step. A per-run file lock prevents competing live executors.
The [owner gateway fixture](../tests/gateway/operator_run_tool_test.ts) verifies
live-run exclusion and exact replay-free step history using an interrupted
journal fixture.

Interrupted admitted operator workflows also use the shared archive actions. The
archive retains committed admission metadata, step states, and exact trace
sequences. Restore requires the same currently configured plan fingerprint and
an unused run and admission request identity. It inserts paused state and trace
history in one transaction. The owner gateway fixture verifies hook denial,
duplicate requests, collision and corrupt-artifact rejection, exact trace
retrieval, and execution of the unfinished step after restore. This integration
covers configured deterministic operator workflows.

Workflow, delegated, and scheduled restores commit a receipt keyed to the
request and verified archive digest in the same transaction as the restored
state. Retrying an approved pending request finalizes the action receipt
without overwriting the run or requesting approval again. The owner gateway
fixture exercises the gap between those two commits for all three run types.

Terminal delegated and scheduled runs can use the same archive actions by
selecting their role as the run kind. The package preserves the exact trace
receipt IDs, ordinals, timestamps, classification, and approved evidence
projections. Restore verifies receipt identity and installs the terminal history
atomically. Reopening a restored GitHub Actions payload still requires the
current connector authorization and root tool hooks. The gateway fixture checks
both roles, collision rejection, whole-run classification, and payload
reauthorization. The checkpoint integration below also covers interrupted runs
with a committed continuation.

The shared recovery journal can now install a validated committed checkpoint
paused. A pause blocks new batches and completion writes. An exclusive execution
lock serializes active continuation across gateway processes. Delegated owner
recovery can explicitly resume with
`/recover-subagent --resume-paused <execution UUID> <original task>`. It
requires the original binding and current authorization for saved tool receipts.
The delegated recovery fixture installs into a fresh journal and verifies denied
ordinary retry, changed binding, revoked access, and replay-free continuation.
The owner archive tool packages the committed checkpoint and exact trace for
quiescent interrupted runs. Active recovery and uncertain tool batches are
ineligible. Restore installs both journals in one transaction and keeps the
checkpoint paused.

Restored webhook occurrences accept explicit resume on the existing
bearer-authenticated recovery endpoint with `resume_paused=true`. The original
admitted body and current source policy must match. The webhook fixture archives
a real committed batch, restores fresh journals, and verifies HTTP resume
without repeating the tool call or delivering output twice.

Cron and trigger occurrences resume at `POST /recovery/scheduled/<execution-id>`
with the gateway bearer token. The scheduler checks the exact cron configuration
or trigger instructions and history. Automatic recovery leaves paused
occurrences untouched.

Scheduled archives now include the validated preexisting admission metadata for
cron, trigger, or webhook. Restore commits the admission, checkpoint, and trace
together. It preserves an identical pending admission and rejects a conflicting
or completed admission. The scheduler fixtures remove all three live journals
before restore and verify authenticated, replay-free resume. The webhook fixture
verifies atomic rejection of an admission collision and checks the archive for
absence of the original body, signature, and credential. Current scheduler
configuration and webhook secrets remain runtime inputs.

Owner chat can select a delegated or scheduled execution for independent side
questions with `/btw --run <delegated|scheduled> <run ID> [question]`. The
context includes the latest 12 committed trace receipts and the latest
authorized run status. History is bound to the owner, role, run, and original
session. The
[gateway side-question fixture](../tests/gateway/side_question_test.ts) verifies
role isolation, independent history, and revalidation when the run
classification changes during the model call. An explicit `--receipt <ordinal>`
selects the exact approved GitHub Actions result. Its side history is keyed to
the exact receipt and requires current source authorization. The gateway fixture
verifies original pre-call and response policy checks, revocation during a turn,
and history access denial, with zero calls to the original tool handler.
Receipt side questions also support a saved Actions run and attempt from
either delegated or scheduled execution. They use the same approved projection
validator as the trace journal. The gateway checks exact source arguments,
source authorization, output denial, and unchanged parent execution history.
`/btw --run <delegated|scheduled> <id> --latest-receipt [question]`
selects the newest approved retained step. Subsequent bare `/btw` commands
stay pinned to that exact receipt. Trusted trigger and verified webhook
executions use the scheduled trace role. The gateway fixture covers both
sources, rejects revoked access, and verifies no repeat connector call.


The owner can search committed execution metadata with
`operator_runs execution_traces` and a `query`. Search spans delegated and
scheduled runs or can be constrained to a role and exact run. Matches carry the
receipt ID and ordinal for exact reopening. Admitted workflows support
`operator_runs traces` with a query over event names and step IDs. The
[gateway fixture](../tests/gateway/operator_run_tool_test.ts) verifies both
search paths, cursor binding, whole-run classification, and root tool hooks.
Approved GitHub Actions results are searchable through
`operator_runs execution_trace_payload` with a query. Search checks current
source authorization and original saved-tool hooks before matching repository or
workflow selectors, run IDs, status, and conclusion. It returns exact receipt
references. Pagination follows visible trace metadata, so revocation does not
change the page cursor. The same gateway fixture covers cross-role search, exact
run filtering, denied and revoked matches, and replay-free retrieval. Additional
tool families require approved projections.

`operator_runs profiles` reads the live provider registry used by owner chat. It
reports the provider and configured model for each permitted classification,
including active overrides and fallback to the default. Gateway-managed routes
can omit a model identifier. The
[gateway fixture](../tests/gateway/operator_run_tool_test.ts) verifies an active
override, ceiling filtering, and root call, response, and output policy.

`operator_runs spawn` starts a configured deterministic workflow and links it to
the exact inspected parent run in one confirmed request. The workflow admission
and parent link commit together before any step runs. The stable request UUID
can reopen the same child and link after restart. The
[gateway fixture](../tests/gateway/operator_run_tool_test.ts) verifies pre-call
denial, rollback on a link conflict after confirmation, and idempotent reopen.

Linked creation also supports a published Sentinel case with no previous
assessment. Confirmation pins the case graph digest. The first assessment
revision and parent link commit before planning starts. The gateway fixture
verifies rollback on a graph change or link collision and idempotent reopen
after restart. Publication of a new case remains a separate operator action.

`operator_runs cancel` is the owner control for a whole run. Sentinel requires
the current case revision and exact run ID. A changed revision invalidates a
confirmation before the assessment is stopped. An admitted workflow can be
cancelled while live, paused, or interrupted. The durable cancellation event
prevents resume and preserves the previously committed steps. The gateway
fixture verifies pre-call denial, stale revision rejection, duplicate requests,
and cancellation history after restart.

Completed, failed, and cancelled admitted workflows can be archived as terminal
history. Restore verifies the matching terminal event and completion timestamp,
preserves the exact trace sequence and committed step states, and keeps the
terminal outcome. The gateway fixture restores all three outcomes into a fresh
workflow journal and verifies that resume is unavailable.

Workflow archives retain incident operator links and their request aliases.
Restoration commits the workflow, trace sequence, and link records together and
rejects link collisions. The gateway fixture removes the link journal, verifies
rollback on a conflicting alias, and restores the original link and alias into a
fresh journal. Link visibility still requires authorized access to both
endpoints.

Sentinel case archives preserve operator links and request aliases for retained
evidence revisions belonging to the archived run. Restore checks each revision
against the saved run history and rejects link collisions before publishing the
case. The gateway fixture restores both current and earlier links at their
original revisions, alongside the case decision, worker result, and dependent
work. A collision rolls back earlier link writes and leaves the case
uninstalled.

Sentinel restore publishes the case snapshot after links commit. The original
confirmed request can resume a marked, unpublished installation whose files
match their recorded digests. If publication completed before the gateway
stopped, the retry reconciles the receipt without replacing the case. An
exclusive request lock prevents takeover of a live restore. The gateway fixture
kills real restore processes before and after publication, verifies a live
duplicate remains pending, and checks that a locally changed staged file remains
intact.

Authenticated Sentinel chat accepts `assessment goals revise <JSON>` for
existing active formal goals. The request must identify the exact current run
and evidence revision. The update retains goal IDs, completed goals, and
historical definitions, then publishes the revised criteria for planning. The
[gateway goal fixture](../tests/gateway/sentinel_formal_goal_test.ts) verifies
planning with the revised criteria, preserved completion evidence,
stale-revision rejection, and idempotency after restart. `operator_runs goals`
pages exact revision goal definitions and criteria. The authenticated owner
agent can append or revise them through `append_goals` and `revise_goals`, with
confirmation of the normalized definitions. The owner gateway fixture verifies
root policy, stale revision denial, historical definitions, and replay without a
second approval.

Leased Sentinel workers can submit an operator-reviewed formal goal through
`sentinel_propose_goal` after reading exact linked evidence for their
assignment. The proposal records the run, evidence revision, assignment, and
target. Owner agents review proposals through `operator_runs goal_proposals` and
approve an exact proposal through `approve_goal_proposal`. Approval atomically
publishes the next goal revision and records which proposal it used. The
[gateway fixture](../tests/gateway/sentinel_graph_fact_test.ts) verifies worker
pre-call denial, missing or foreign evidence rejection, operator decline,
changed-evidence rejection, and idempotent approval after reconnect.

Leased workers can call `sentinel_prove_goal` to submit exact graph evidence for
an active formal goal criterion. The worker must first read the linked evidence
on the assignment. The shared verifier checks the registered criterion and
current assessment inputs, records the assignment and revision, and applies the
existing completion policy. The authenticated owner can read verified
observations through `operator_runs goals` with `goalId` and `includeProof`. The
gateway fixture verifies pre-call denial, missing evidence and wrong-criterion
rejection, duplicate proof, and persisted evidence awaiting operator
confirmation.

`operator_runs confirm_goal_completion` lets the authenticated owner confirm the
saved proof for an exact Sentinel run and revision. The digest returned with
`includeProof` binds the full set of active criteria and verified observations.
Confirmation rechecks the digest and current evidence before recording
completion. The gateway fixture verifies invalid digest rejection, operator
decline, an evidence change during confirmation, and a restart retry that
preserves the worker's evidence and returns the original decision.

An owner chat can register a successor after its current goal completes by
sending `/goal register` with a new UUID `requestId`. Earlier decisions stay
readable through `/goal status <requestId|legacy>` and `/goal history`. An
exact replay returns the existing decision and keeps the current goal in
place. Each registration pins a conversation sequence so earlier matching
tool results cannot satisfy the next goal. Goal decisions retain the
classification of their registration and verified evidence. Older records
with no saved classification require a Restricted session.
[Gateway lifecycle fixture](../tests/gateway/chat_goal_lifecycle_test.ts).

An owner can revise an incomplete goal through `/goal revise` with a fresh
UUID `requestId` and its current `expectedRequestId`. The new goal links to
the exact prior registration and starts with a fresh evidence boundary.
The previous decision and evidence remain available under their original
request ID. A stale expected ID or a conflicting retry leaves the current
goal intact. [Gateway lifecycle fixture](../tests/gateway/chat_goal_lifecycle_test.ts).

Owner chat includes a request ID and proof digest when an operator-policy
goal awaits confirmation. `/goal confirm <requestId> <decisionSha256>` applies
that exact decision after revalidating its saved observations. A revised or
expired decision cannot complete through an earlier confirmation. Replaying a
completed decision returns the saved receipt without touching the active goal.
[Gateway lifecycle fixture](../tests/gateway/chat_goal_lifecycle_test.ts).

Configured scheduler and delegated goals use the same proof digest contract
in authenticated owner chat. The goal's configured role and scope are part
of its digest. Confirmation rechecks retained evidence and keeps completed
receipts readable within the saved evidence classification after reconnect.
The corresponding `/goal scheduler list` and `/goal delegated list` commands
page configured scopes at the current classification. The listing shows
goal previews and status. Evidence and proof digests are available through
exact status reads. The ordinary owner model has the read-only
`managed_goal_state` tool for the same scoped lists and decisions. The
gateway fixture verifies role filtering and read-hook denials.
[Managed confirmation gateway fixture](../tests/gateway/managed_goal_confirmation_test.ts).

An owner can cite an exact retained GitHub Actions run attempt from a
completed scheduled run with `/goal scheduler cite`. The configured
operator-policy criterion binds the scheduler source and canonical result
digest. Citation and confirmation reopen the same approved receipt through
current source hooks and GitHub authorization. The fixture removes the live
trace database, restores the archived run, and completes the criterion with
an empty scheduler transcript.
[Archived goal gateway fixture](../tests/gateway/managed_goal_trace_archive_test.ts).

Leased workers can also prove an `adaptive_task` criterion with a completed
same-target task in the current case revision. The proof binds the exact task
ID and result digest after the worker opens the first page through root
dispatch. The verifier rechecks the digest against the committed result. The
[gateway fixture](../tests/gateway/sentinel_graph_fact_test.ts) verifies that a
withheld response cannot support proof, a different target cannot satisfy the
worker's criterion, and the owner can inspect the saved proof.

An operator can approve a formal `adaptive_task` criterion before the task
exists by using `task:trace:DEPTH:NODE` or `task:impact:DEPTH:NODE` as its
reference. The approved requirement specifies the exact kind, depth (1 or 2), and node.
Proof still cites an exact completed task in the current revision. The
[worker fixture](../tests/gateway/sentinel_graph_fact_test.ts) approves the
criterion before creating the task, rejects a result with the wrong depth, and
retrieves the accepted exact task citation through the owner gateway.

A formal criterion can require passing control coverage with the
`adaptive_task` reference `task:verify_control_coverage:pass:FINDING_ID`.
The verifier requires the exact completed task for that finding and checks
the deterministic coverage outcome at the assessment revision's evaluation
time. The [control verification fixture](../tests/sentinel/control_verification_test.ts)
checks that failed, stale, unverified, and wrong-finding results leave the
criterion open even when their tasks completed.

A Sentinel goal can require a passing remediation recheck using the
`finding_recheck` source and `pass:WORKER_FINDING_ID` requirement. The
planner can cite the exact current-revision recheck receipt. The verifier
reopens the original finding, checks its run, target and control binding,
and replays the retained evidence against the pinned graph. The
[findings fixture](../tests/gateway/sentinel_worker_findings_test.ts) verifies
that the original finding and an unknown receipt cannot satisfy the
criterion, duplicate proof is idempotent, and the accepted citation and both
finding records survive reopening.

Current-revision recheck receipts also contribute to the adaptive planner's
round identity. The existing scheduler can reconsider the goal after cooldown
and the planner receives the exact receipt ID, original finding, supporting
evidence ID, asset, control, source assignment, case revision, and outcome.
The [findings fixture](../tests/gateway/sentinel_worker_findings_test.ts)
covers duplicate publication, planner citation for operator confirmation, and
suppression in later planner input when the operating policy denies evidence
review. Existing citations remain available in saved provenance.

For queued work whose sole requirement is an already committed remediation
recheck, the planner can place its exact `passingRecheckId` on a depth-one
trace for the receipt's asset. The scheduler replays the matching pass
against the current case revision, inventory, and operating scope before
completing the prerequisite without a worker claim. The authentication
fixture proves that the dependent completes, a different asset cannot use
the same receipt, and the task-to-recheck link resolves after reconnecting
to Tidepool. A prerequisite can also name the original worker finding with
`passingRecheckForFindingId` and wait for a matching receipt. The selector and
its dependents carry into a new revision when the original finding, asset,
control, and case policy still match. Only a pass from the new revision can
settle the carried prerequisite. The same gateway fixture proves rollover,
duplicate recheck submission, and the retained link to the exact pass in
Tidepool. The running assessment coordinator wakes on newly committed evidence
for its exact case, run, and revision. The gateway fixture proves that a
fresh recheck releases queued work before the periodic poll and replay
does not schedule another advance.
Before leasing a dependent, Sentinel reopens that exact recheck under
current policy and reevaluates its validity. At the receipt's expiry or
after evidence review is denied, downstream work remains queued and the
earlier satisfaction stays in provenance.
When the work does start, the durable claim records the requirement task,
original finding, accepted recheck, source assignment, evidence revision,
and receipt digest. The gateway verifies the saved claim separately from
the original satisfaction.


The planner can also queue an original finding outside its recent input
window after reopening the exact receipt through `sentinel_worker_findings`.
A denied read supplies no selector authority. The real planner-agent
fixture submits the same proposal after both a response denial and an
allowed read, then reopens the exact read in planning history.



Sentinel planners and leased workers can reopen a retained finding or recheck
with `sentinel_worker_findings` and its exact `receiptId`, optionally pinning
the receipt's evidence revision. The lookup is independent of the recent
results window and enforces the current case, run, and assigned target. The
[worker fixture](../tests/gateway/sentinel_worker_findings_test.ts) verifies
latest and historical retrieval, revision mismatch, stale lease rejection,
pre-call denial, and response withholding through root dispatch.

The same tool lists current-run receipts newest first and returns
`nextBeforeReceiptId` for continuing past the recent page. The cursor must
resolve within the selected revision filter and the caller's case, run, and
assignment scope. The [worker fixture](../tests/gateway/sentinel_worker_findings_test.ts)
discovers the archived original finding from the continuation after its
passing recheck and rejects a cursor from outside the revision filter.

The saved planner input manifest records `findingRecheckIds` from the
dispatched prompt. Authenticated Tidepool provenance exports include those
attempts alongside the retained rechecks. The
[findings fixture](../tests/gateway/sentinel_worker_findings_test.ts) verifies
the original attempt has no recheck reference and the next attempt resolves
to the exact saved receipt after the gateway is reopened.

Authenticated operator agents can use `operator_runs finding_receipt` to
resolve a worker finding or recheck by exact case ID, evidence revision, and
receipt ID. The lookup checks the run recorded for that revision and works
for retained revisions. The [operator gateway fixture](../tests/gateway/operator_run_tool_test.ts)
covers cross-case and wrong-revision rejection, exact historical lookup, and
the pre-call, response, and output hooks.

Authenticated operator agents can discover IDs using
`operator_runs finding_receipts` on an exact Sentinel case revision. The page
returns receipt metadata and a `nextCursor` for the same case and revision.
The [operator gateway fixture](../tests/gateway/operator_run_tool_test.ts)
follows a two-page listing into an exact receipt read and verifies that
continuation fails across case or revision boundaries.

Authenticated operator agents can use `operator_runs finding_report` to
read the report as of an exact case revision, with an optional report version.
Each result identifies the original finding, the receipt for the selected
version, the source assignment, and its evidence revision. The
[operator gateway fixture](../tests/gateway/operator_run_tool_test.ts)
reads the amended report and original text, and rejects the amendment when
viewing the earlier revision or another case.

Authenticated operator agents can use `operator_runs finding_traffic` to
page through an exact finding's retained traffic links at a selected case
revision. Supplying a link ID reopens the sanitized receipt and verifies its
asset, source, and digest. The
[operator gateway fixture](../tests/gateway/operator_run_tool_test.ts)
checks historical retrieval, case, finding, and revision isolation, and
response withholding for the exact lookup.

Authenticated operator agents can request `operator_runs attach_finding_traffic`
for an exact current revision, report version, and retained traffic digest.
After operator confirmation, the gateway revalidates the run, report, target,
and receipt under the case lock and records operator authority. The
[operator gateway fixture](../tests/gateway/operator_run_tool_test.ts)
covers pre-call denial, operator decline, duplicate receipt reuse, a report
amendment during confirmation, and attachment to the updated recheck.

Authenticated operator agents can use `operator_runs finding_traffic_candidates`
to discover sanitized receipts for the finding's exact asset and selected
case revision. The [operator gateway fixture](../tests/gateway/operator_run_tool_test.ts)
uses a discovered digest in an approved attachment and verifies paging,
filter-bound cursors, cross-case rejection, and response withholding.

The [Sentinel archive gateway fixture](../tests/gateway/sentinel_run_archive_test.ts)
attaches sanitized traffic through the owner tool, archives the stopped run,
and reopens the identical link and receipt after restoring the case paused.
Removing the packaged traffic receipts database fails restoration without
changing a peer case. The fixture also checks that the synthetic request
token is absent from every archived file.

Authenticated operator agents can reopen a cited relationship through
`operator_runs topology_source` using the exact Sentinel case revision,
topology evidence ID, and reporting case. Resolution verifies that the
archived snapshot contains the cited edge and returns only that edge and its
endpoints. The [archive gateway fixture](../tests/gateway/sentinel_run_archive_test.ts)
verifies that a corrected live source leaves the original citation intact
after restoring the stopped case in the same workspace.

New Sentinel run archives include the digest-verified topology source
snapshots cited by the run's retained revisions. Restore validates the
bundle against those revisions and installs it with the case. Exact
topology reads can recover from the case copy when workspace snapshots are
missing. The [archive fixture](../tests/gateway/sentinel_run_archive_test.ts)
removes the workspace snapshot and verifies the same citation after restore.

New archives also retain exact shared finding source snapshots cited by
adaptive assignments in the archived run. Restored assignments and
carryover checks use the case copy when the original workspace archive
is absent. The [archive fixture](../tests/gateway/sentinel_run_archive_test.ts)
deletes the separate finding source and proves the restored citation still
resolves against the exact local asset and retained reporting snapshot.

Sentinel archives also retain snapshots cited solely by returned steps
in committed adaptive worker reviews. The restore validates these
references against the archived run and installs the source bundle with
the case. Tidepool source lookup can use that case-local copy. The
[archive fixture](../tests/gateway/sentinel_run_archive_test.ts) deletes
the worker trace's distinct workspace snapshot and verifies both the
restored step's exact citation and the recovered source digest.

Sentinel archives include a separate bundle for sources cited by returned
steps in committed assessment reviews. The [archive gateway fixture](../tests/gateway/sentinel_run_archive_test.ts)
deletes a source referenced only by an assessment review, restores the case,
and verifies that the Tidepool handler resolves the exact snapshot and
returns the original assessment review citation.

Tidepool shows the saved goal criteria and evidence before operator
confirmation. The confirmation includes the run and proof digest, and the
gateway revalidates both before recording the decision. The
[Tidepool fixture](../tests/sentinel/tidepool_workspace_test.ts) verifies
missing and mismatched proof rejection, exact retry, and rejection of a
changed digest on retry.

The Sentinel CLI exposes saved criteria, observations, and the review
digest through `assess-goal-state`. Registered operator completion requires
the reviewed run ID and digest. The
[CLI process fixture](../tests/cli/sentinel_goal_proof_test.ts) checks missing
and incorrect proof rejection and verifies that an identical retry returns
the original decision across independent CLI invocations.

Sentinel archives also retain sources cited only by returned planner tool
reads. Collection binds each read's planning identity to the archived run
and retained evidence revisions. The
[archive gateway fixture](../tests/gateway/sentinel_run_archive_test.ts)
deletes the distinct planner source from the workspace, then verifies the
restored planning history and exact source digest.

Authenticated operator agents can use `operator_runs planner_reads` to
discover attempts for an exact case revision and reopen one saved tool
receipt by identity, attempt, and one-based ordinal. The
[archive gateway fixture](../tests/gateway/sentinel_run_archive_test.ts)
retrieves the exact read after restore and verifies case and revision
isolation, ordinal validation, and response withholding.

Operators can supply the cited `sourceCase`, `snapshotDigest`, and `assetId`
with an exact `operator_runs planner_reads` request to reopen the asset
record from that immutable snapshot. The
[archive gateway fixture](../tests/gateway/sentinel_run_archive_test.ts)
verifies retrieval from the restored bundle and rejects uncited cases,
digests, and assets before returning data.

Authenticated operator agents can use `operator_runs worker_trace_source`
with an exact case revision, task ID, single step index, and cited source
tuple. It reopens only the cited asset record. The
[archive gateway fixture](../tests/gateway/sentinel_run_archive_test.ts)
resolves the source after restore and checks case, revision, step, and
digest isolation.

Authenticated operator agents can use `operator_runs assessment_review`
to list committed reviews at a case revision, inspect a saved step's
citations, and reopen an exact cited asset. The
[archive gateway fixture](../tests/gateway/sentinel_run_archive_test.ts)
discovers the citation from the restored review, follows it to its
bundled source, and verifies scope rejection and response withholding.

Authenticated operator agents can page or reopen a committed intermediate
workflow observation using `operator_runs intermediate_observations` at
its exact case revision. The
[gateway fixture](../tests/sentinel/intermediate_workflow_gateway_test.ts)
reads the same receipt as the peer worker while the producing assignment
is still running and verifies that policy can withhold the response.

The [intermediate workflow gateway fixture](../tests/sentinel/intermediate_workflow_gateway_test.ts)
also archives the stopped run, reopens the exact intermediate receipt through
a new gateway after paused restore, and inspects the peer citation in Tidepool
provenance. It checks that the synthetic credential is absent from the archive
and that the status connector was called only once.

A Sentinel criterion can require a committed relationship receipt with
source `graph_fact` and the exact fact ID. The goal verifier checks the
case, run, evidence revision, source graph digest, and relationship.
The [graph fact gateway fixture](../tests/gateway/sentinel_graph_fact_test.ts)
verifies that the planner's exact fact citation moves the goal to operator
confirmation while an unknown fact ID is discarded.

A `graph_fact` criterion can also name the exact directed relationship
before any receipt exists. Its reference is a JSON string containing
`[from, relation, to]`. Proof still supplies a committed receipt ID. The
[graph fact gateway fixture](../tests/gateway/sentinel_graph_fact_test.ts)
registers the relationship first, then verifies matching worker proof
through the planner after the receipt is published.

Leased workers can submit a `graph_fact` criterion through
`sentinel_prove_goal` after opening the exact receipt with
`sentinel_graph_facts` in the current turn. The verifier checks the
active lease, assigned target, revision, and directed relationship. The
[worker fixture](../tests/gateway/sentinel_graph_fact_test.ts) verifies
that a withheld receipt cannot support proof and duplicate submissions
return the saved proof.

Leased workers can submit a `finding_recheck` criterion via
`sentinel_prove_goal` after opening the exact passing receipt through
`sentinel_worker_findings`. Proof is scoped to the assigned asset and
current evidence revision. The
[findings fixture](../tests/gateway/sentinel_worker_findings_test.ts)
verifies that a withheld receipt cannot support proof and a duplicate
submission returns the original worker proof.

Equivalent trace reuse checks all explicit evidence node requirements and
keeps work queued when it also requires an upstream check or independent
citation. The [queue store tests](../tests/sentinel/fact_satisfaction_store_test.ts)
cover matching roots with missing evidence, an asset mislabeled as required
evidence, and a required upstream check.
A single saved trace also cannot satisfy a task with another explicit
worker-result citation. The gateway fact fixture checks that a two-source
task runs through the normal queue and keeps both prerequisites. The queue
store rejects an ordinary trace as proof for a receipt-only relationship
requirement and leaves that requirement ineligible for worker claims.
New trace and graph fact satisfaction records also retain the verified
source evidence revision. Historical provenance checks this against the
pinned case and keeps the exact source ID and digest. The gateway tests
reopen the saved receipt after revision rollover and verify that a
mismatched revision cannot produce a satisfaction link. The view also
requires the copied trace to match its source and the graph receipt to
match the case, run, assignment, and endpoints. The gateway fixtures
reject a changed trace and a graph receipt attributed to another run.



A planner can queue a depth-one trace with `graphFactOnly: true` and the
exact `graphFactId` when the relationship receipt is its sole evidence
requirement. The scheduler verifies the current graph and receipt, records
the source and revision, and releases dependents without assigning a worker
to that task. The
[graph fact gateway fixture](../tests/gateway/sentinel_graph_fact_test.ts)
proves completion with zero attempts and a dependent that becomes runnable.

A receipt-only planner assignment can wait for a future receipt by
specifying `graphRelationship: {from, to, relation}` instead of a receipt
ID. It stays queued until a worker publishes a matching relationship in
the current case revision. The
[graph fact gateway fixture](../tests/gateway/sentinel_graph_fact_test.ts)
queues the requirement and dependent first, then proves that an unrelated
receipt for the same asset leaves both queued and that the matching one
releases the dependent and records provenance without a worker claim.

A Sentinel graph prerequisite with `requireCurrentPass` checks the newest
observed verification for its asset and control. An exact older receipt
cannot satisfy it, and a newer observation can hold a dependent that has
yet to start even before the original receipt expires. A control selector
without an exact source can adopt the qualifying newer receipt. The
gateway fixture retains the original proof and checks the supersession
boundary.


When the case revision changes, a pending relationship requirement and its
dependents can carry forward after the new graph and operating scope validate
the selector. The new task remains queued for a receipt from the new revision.
The graph fact gateway fixture proves that a fresh relationship receipt releases
the carried dependent with zero worker attempts on the prerequisite.

Receipt-only work uses a task ID that includes the exact relationship or
receipt ID. Ordinary trace IDs remain stable, and repeat planning recognizes
the stored IDs of legacy receipt-only tasks. The
[graph fact gateway fixture](../tests/gateway/sentinel_graph_fact_test.ts)
queues two relationships and an ordinary trace at the same asset and depth,
then proves that each receipt releases only its own dependent task.

An authenticated operator can also queue the requirement with
`operator_runs assign` by providing `taskKind: "trace"`, `node`, and an exact
`graphRelationship`. Operator approval binds the directed edge to the case,
run, and revision. The
[graph fact gateway fixture](../tests/gateway/sentinel_graph_fact_test.ts)
covers denial, exact replay, conflicting replay, and release of dependent work
when the matching receipt is committed.

The model-facing `operator_runs` goal schema exposes all supported
criterion sources, including `graph_fact` for an exact receipt or
directed edge and `finding_recheck` for a passing check of an exact
finding. The [graph fact gateway fixture](../tests/gateway/sentinel_graph_fact_test.ts)
checks the schema delivered to the operator agent and registers a
relationship criterion through an authenticated, confirmed chat turn.

GitHub Actions recovery receipts also bind the saved result to the immutable
repository ID. Resumption rechecks that identity and current permission
before delivering the result to the model. Older checkpoints and results
without a verified repository ID cannot be reused. The
[delegated recovery fixture](../tests/gateway/delegated_agent_recovery_test.ts)
restores a paused run, denies access after a same-name repository replacement,
and resumes with its original repository and a single recorded tool call.

Shared execution history now supports opt-in repository status from
`github_repos get` for configured recovery repositories. The delegated
recovery fixture exercises interrupted execution and exact reuse without
repeating the tool call. The authenticated operator gateway fixture restores
an archived record and exercises the original tool's pre-call and response
checks before returning the saved projection.

The shared resume path now checks each saved tool result against its committed
receipt before delivering it to the model. Native tool exchanges also check
the paired call ID, tool name, and projected arguments. The
[gateway recovery fixture](../tests/gateway/agent_recovery_test.ts) changes the
saved result, call ID, and repository independently, verifies each is rejected,
and verifies a current response-hook denial. The original checkpoint resumes
with one tool execution.

Shared owner, delegated, and scheduled recovery checks root tool policy
and the saved response before probing current connector access. The
[gateway recovery fixture](../tests/gateway/agent_recovery_test.ts) counts
source permission checks and confirms that denied or mismatched checkpoints
reach neither the connector authorization callback nor the model.

Sentinel's durable workflow-status checkpoint now uses the shared root
resume gates. Pre-call or response denial stops replay before the connector
scope check. After those gates pass, Sentinel checks the current lease and
revision and matches the checkpoint output to the exact retained receipt.
The [worker restart fixture](../tests/sentinel/live_workflow_restart_test.ts)
kills the original gateway worker, verifies both denial paths, and verifies
same-revision resumption with one transport read. A superseding revision
starts a fresh turn.

Replay also requires the current credential to read metadata for the exact
configured workflow. Sentinel applies outbound policy to the metadata URL
before resolving the credential and verifies the returned workflow ID. The
restart fixture proves that missing credentials and an upstream 403 block
replay without repeating the runs request or delivering the receipt to the
model.

Sentinel's workflow checkpoint writes a blank assistant frame and a local
call ID. It retains the exact approved result, the task prompt, and verified
operator guidance. It drops model drafts, reasoning, and provider call IDs
during both write and load. The worker restart fixture checks the SQLite
database and write-ahead log for synthetic markers and verifies that the
resumed model receives the saved result without those fields.

A single `sentinel_assigned_target` read can also be resumed durably.
The checkpoint matches the exact result digest in the committed worker
progress for that assignment and revision. Resumption reauthorizes the
exchange and restores the evidence links used by later worker actions and
the final review. The [process restart fixture](../tests/sentinel/live_workflow_restart_test.ts)
kills the worker after the checkpoint is committed and verifies that the
resumed worker receives the saved target through the root hooks with one
retained review step.

A checkpoint can also retain an assigned-target read and a workflow status
read in the same tool batch or in separate model iterations. Both results
stay in their original order and are authorized before the model sees them.
The process restart fixture checks both forms, verifies one workflow-runs
request, and checks that the completed review cites both source steps.

Shared recovery distinguishes an interrupted batch of explicitly replay-safe
reads from a batch that may have changed state. The GitHub status recovery
policy opts in for approved read operations. Recovery discards only the
uncommitted read batch and dispatches again through root policy. Previously
committed exchanges still reauthorize and resume without replay. The owner
gateway fixture disconnects during an approved read and during a synthetic
mutation, then verifies that only the read can run again.

A shared recovery policy can opt a standalone mutation into reconciliation
when its projected request contains an exact operation identity. The journal
binds that request to its execution, batch, and classification at the
authorized root dispatch boundary, after pre-call policy, approval, and
write-down checks. The gateway fixture holds a call at the pre-call hook and
verifies it has no authorized operation record and no handler side effect.
Older pending records created before this boundary stay held. If root
dispatch required operator approval, the exact durable operation records the
approval rule. Recovery may use that confirmation for the saved exchange
only when the same rule applies to that exact call. A deny or a different
approval rule blocks replay. The socket fixture approves the initial
mutation through the inbox, interrupts it, and verifies that a rule change
withholds the reconciled result while the original rule permits reuse. Recovery asks the policy to read the original outcome under current
authorization. A verified, projected result becomes a checkpoint and passes
root policy before model reuse. The owner gateway fixture uses a local
authoritative receipt, blocks unauthorized reconciliation and response
replay, then resumes without dispatching the mutation a second time.
With `agent_recovery.sentinel_assignment_cases` configured for exact case
IDs, owner chat uses the production assignment journal to reconcile
`trace` and `impact` intents, including trace intents with a typed
graph relationship and evidence prerequisite. The reopened receipt must match the original
request, current case and adaptive revision, and current operating
constraints. The gateway fixture interrupts after assignment commit and
before response authorization, then reopens the receipt without a second
root tool dispatch or confirmation. The evidence-gated case also verifies
that the original relationship remains bound to the queued task. A
committed remediation recheck assignment can also recover from the same
journal. Recovery reopens the exact connector evidence, applies the original
source tool's pre-call and response policy, and checks that the evidence
still qualifies for the named finding. The owner gateway fixture interrupts
before the checkpoint, denies the reopened connector evidence, then restores
access and verifies the original receipt without another confirmation. The
native GitHub Actions fixture also verifies that recovery reuses the saved
runs, checks current workflow metadata access, withholds the receipt when
access is revoked, and never repeats the assignment dispatch.
External connectors still need their own outcome verifiers.


Leased Sentinel workers now record a pending mutation before dispatching
a batch that can change case state. Once root dispatch records the outcomes,
a completed batch clears the hold. An interrupted or unconfirmed batch
remains visible in the review state as uncertain and cannot be reclaimed
or retried. The event history retains tool names without arguments.
The worker restart fixture kills the process after publication commits
and before response authorization finishes, then verifies that exactly one
observation exists and the publication handler is never dispatched again.
For an interrupted standalone workflow publication, the scheduler reconciles
against the exact observation event committed after the pending marker and
the source workflow result in the same assignment and revision. It commits
the reconstructed exchange and clears the hold atomically. The resumed
agent sees the saved receipt only after the root hooks and current connector
authorization pass. Without exact commit evidence, the hold persists.
Other state-changing tools still need tool-specific reconciliation.

A resumed assigned-target read also restores the verified relationship
proofs associated with that exact source step. The
[process restart fixture](../tests/sentinel/live_workflow_restart_test.ts)
publishes a graph fact after reauthorizing the saved target result and
verifies that the journal cites the original step. For a standalone graph
publication interrupted after journal commit, reconciliation uses the
admitted request ID and argument digest, exact case/run/assignment scope,
current snapshot digest, and source result digest. The restart fixture
verifies that a matching receipt reaches the resumed worker through root
policy and that a receipt for a different request leaves the hold intact.

The finding journal can reopen a committed finding, remediation recheck,
or report amendment by its request ID within the exact case, run, evidence
revision, assignment, and asset. The read verifies the content-derived ID,
supports deduplicated requests and older journals, and leaves the journal
unchanged. [Finding journal tests](../tests/sentinel/worker_finding_store_test.ts)
cover all three receipt types and reject wrong scope and missing requests.
The worker scheduler now uses these receipts to reconcile standalone
finding, recheck, and report amendment writes. The pending event keeps the
request ID and argument digest. The journal supplies the exact approved
exchange. The worker restart fixture interrupts each write after journal
commit, then verifies that the resumed worker receives the receipt through
root policy and that the completed review retains its ID. Writes without
a qualifying prior checkpoint or a verifiable receipt remain held.

Sentinel also reconciles a batch of distinct supported writes by verifying
every receipt against the original ordered request list before committing
the continuation. The restart fixture covers a graph publication followed
by a finding write in one batch. If the process stops after only the graph
publication commits, the hold persists and neither write is retried.
A batch can also mix a GitHub Actions status read with a publication.
Recovery requires the exact staged result and the returned progress step
at the original position. It verifies that the publication cites that
step, then reauthorizes both exchanges and the current connector access.
The restart fixture verifies a single runs read and single publication.
Removing proof of the authorized read leaves the assignment held. For an
eligible first batch, Sentinel stores the generated assignment prompt
under its digest in the same transaction that admits the batch. That
starting checkpoint contains no tool exchange and cannot be resumed on
its own. The restart fixture proves recovery when the process stops after
the read and publication commit in the first batch.

An assigned-target read in the same batch as a write retains its approved
result under the exact lease, pending event, and step index. Reconciliation
checks the result against the committed progress digest and the relationship
receipt's source digest. The restart fixture verifies a first-batch read
and graph publication, rejects an altered retained result, and confirms
that successful recovery removes the temporary receipt. Run archives
exclude these temporary payloads. A finding recheck context read now
uses the same recovery path when batched with a remediation recheck.
The pending batch binds the exact finding argument, and the returned
step stores its result digest. The restart fixture verifies that the
worker receives the original finding context and the committed recheck
through root policy without executing either again. Other read types
still need support when they share a batch with writes.

The traffic attachment journal can reopen an exact worker write by request
ID and check its case, evidence revision, asset, and assignment. It resolves
deduplicated request aliases and excludes operator-authored links from the
worker recovery path. The journal tests cover older databases, restart,
aliases, and scope denial. Worker recovery now pairs the write with its
exact retained traffic read, verifies the digest of the response delivered
through root policy, and reauthorizes both exchanges. The process restart
fixture interrupts a first batch after attachment commit and verifies one
attachment, the original report version, and restored evidence lineage.
Removing the exact traffic receipt leaves the assignment held. Traffic
search pages also recover in a mixed batch. Sentinel retains validated
filters and a response digest, then reopens the same asset-scoped page
and compares its exact projection before replay. The process restart
fixture verifies a paginated search, exact read, and attachment in one
batch. It compares the page digest across restart, including its cursor.
Finding-traffic link listings retain the exact authorized page when
batched with a write. Recovery matches its filter and digest, then checks
each listed link against the same asset and evidence revision. The restart
fixture adds an attachment that changes the current listing and verifies
that the resumed worker still receives the original page. The temporary
page is removed after settlement and excluded from run archives.

A worker discovery submission can carry a request UUID for durable
recovery. The shared inventory journal commits the UUID and exact returned
version with the proposal. Recovery verifies the source case, assignment,
revision, snapshot, and claim before reauthorizing the saved exchange. The
restart fixture interrupts the first batch after submission and approves
the proposal before restart. The worker receives the original pending
receipt while the current inventory remains approved.

Worker goal proposal recovery uses the exact request UUID, run, revision,
assignment, target, and normalized criterion. The saved result retains
operator review as its policy. The process restart fixture interrupts a
first batch after the proposal commits and verifies one saved proposal,
the original evidence criterion, and root reauthorization without
resubmission. Worker goal proofs can also carry a request UUID. The shared
completion store commits the proof and its original status in the same
transaction. The restart fixture advances the live goal from open to
awaiting confirmation and verifies that the worker still receives its
original open receipt. The archive gateway fixture verifies that the
proof receipt survives restoration of a paused case.

A worker can recover a batch that reads an exact peer graph fact and commits a
goal proof before interruption. The restart fixture verifies that the original
receipt passes root pre-call and response hooks again, keeps its source
assignment, and matches the bytes the model receives. Gateway restart fixtures
also verify recovery from an exact passing remediation recheck and withhold the
saved result when response policy changes before restart. The denied-replay
fixtures distinguish fresh model calls from calls carrying restored tool
results. They verify that revoked source access and changed response policy
both keep the saved evidence out of model context. A completed peer task
proof recovers both exact pages and their full-result digest. Only page zero
can establish the prerequisite read for a task goal proof. A bounded plain-text
peer search can recover its original page even if another matching assignment
completes before restart. The gateway fixture verifies that the worker receives
the original bytes after root authorization and that the saved rows still
resolve within the same case, run, and revision. Temporary search receipts are
removed after settlement and scrubbed from run archives. Queries outside the
checkpoint's plain-text format remain available for live searches.

Bounded Sentinel worker-trace searches and explicit step lookups now use the
same recovery receipts. On restart the gateway rechecks current root policy
and validates every saved row against the traces visible in the assigned
case and revision. The gateway fixture adds a matching peer review during
downtime and verifies that the original search page and pagination metadata
reach the resumed model unchanged.

Exact reads of published intermediate workflow observations survive restart.
The gateway reopens the normalized receipt under the consuming assignment's
current case, run, target, and evidence revision. The fixture preserves the
source assignment and tool step in the resumed worker's provenance and checks
that no live transport runs. Paged listings preserve the original rows and
continuation offset when another peer publishes during downtime. Recovery
reauthorizes the page and checks that each listed receipt still resolves within
the assigned scope. Temporary page receipts are cleared after settlement and
scrubbed from run archives.

Exact approved shared-discovery reads now survive worker interruption. The
gateway reauthorizes the saved result through root hooks and reopens the
discovery under the current lease, approval, source-evidence, and destination
matching rules. The restart fixtures show that an unchanged discovery and its
source provenance survive, while a withdrawal during downtime withholds the
saved result from the model. Listings recover the originally returned rows
and truncation flag, including when another matching discovery is approved
during downtime. Each saved listing row must still resolve through the
authorized exact read. A withdrawn row blocks replay of the saved list.

Carried assignments can resume with an exact prior-evidence citation after a
gateway restart. The resumed read checks current root policy and revalidates
the saved citation, source step, and unchanged graph evidence under the active
lease. The gateway fixture verifies that the same bounded evidence projection
reaches the worker after interruption.

Workers can resume exact pinned topology sources and assignment-cited shared
findings. After restart the gateway reauthorizes each result and reopens the
source from its retained snapshot under the current lease. The restart fixture
replaces the reporting case's live snapshot during downtime and verifies that
both original responses and their source citations survive.

A dependent worker can resume an exact saved workflow receipt cited by its
prerequisite. The gateway reapplies root policy with the current case,
assignment, and revision, then confirms the original prerequisite, source
step, and receipt digest. The restart fixture checks the exact result and
requires zero live connector calls.

Workers can resume an original graph-fact page after restart. The gateway
reapplies root policy and checks each row against the retained journal in the
worker's case, run, revision, and target. The fixture inserts an additional
fact during downtime and verifies that the original offset page still reaches
the model alongside the separately opened exact fact and committed proof.

Worker finding and recheck lists retain the original page and continuation
cursor after restart. The gateway verifies each returned receipt and any
supplied cursor against the assigned case, run, target, and evidence revision.
The restart fixture adds a new finding during downtime and verifies the
original page, exact passing recheck, and committed proof. A separate fixture
withholds the saved page when response policy changes.

Exact finding reads can recover original findings and rechecks from retained
revisions allowed by the current leased assignment. The restart fixture
reopens a historical finding alongside its current passing recheck and
preserves both results. Goal-proof eligibility still requires a passing
recheck from the current evidence revision.

Sentinel resumes an authorized goal-state page with its original status and
criterion verification flags. The gateway checks the current lease, scope,
and saved page against the registered criteria. The restart fixture advances
the live goal to awaiting confirmation during downtime and verifies that the
worker receives the original open page and committed proof receipt.

Case-wide hint reads retain the original rows and continuation cursor across
worker restart. The gateway reauthorizes the saved response and rebuilds its
page from the append-only hint journal at the original first row. The restart
fixture publishes a newer hint during downtime and verifies that the resumed
worker receives the original page unchanged.

Exact provenance node reads resume with their original projected node,
connection page, and continuation offset. Recovery requires the same node and
each delivered connection to remain visible in the assigned revision. The
gateway fixture adds a graph-fact connection during downtime and verifies
that the original one-row page still reaches the worker through root policy.

Provenance searches resume with the original matching rows, total, and cursor.
The gateway reapplies policy and verifies each saved row against the current
case evidence and original search filters. The restart fixture adds a matching
graph fact during downtime and verifies that the original search page survives.
Credential-shaped queries and responses are excluded from checkpointing.

Workers can resume exact provenance path queries for a single shortest path
or a bounded set of alternatives. The gateway reauthorizes the saved call
and verifies the original arguments and result digest against committed
progress for the current lease and evidence revision. Older checkpoints
without the retained path still require a byte-identical recomputation.
The process restart fixture adds a fact that changes the alternate paths
and verifies that the resumed worker receives the original response.

Inventory path recovery covers the default graph and explicit inventory
selection. The gateway reauthorizes the original call and recomputes its
projection against the saved assessment snapshot. The restart fixture
changes the live inventory file and verifies that the resumed worker still
receives the original shortest path and bounded alternatives.

Inventory trace and impact reads now resume from the assigned snapshot. The
gateway reapplies root policy and checks the original projection against that
snapshot. The restart fixture replaces the live inventory and verifies that
both original neighborhood results reach the resumed worker byte for byte.

Inventory finding and control-coverage pages resume from the saved assessment
snapshot. The gateway reapplies root policy and verifies the original page
against its original evaluation timestamp. The restart fixture replaces the
live inventory and verifies that the original finding and passing control
projection still reach the resumed worker.

Defense summary, behavior detail, and upstream-check pages resume from saved
assessment telemetry. The gateway reapplies root policy and validates each
original projection against the assigned evidence revision. The restart
fixture clears the live telemetry input and verifies that all three original
results still reach the resumed worker.

Incident alert pages resume from the saved incident and its contributing
telemetry. The gateway reapplies root policy with the case, assignment, and
revision before checking the exact projection. The restart fixture clears
the live alert input and verifies that both original pages and the first
page's continuation offset still reach the worker.

Shared asset link pages resume from their retained reporting snapshots. Each
relationship and finding must still verify with the assigned case inventory.
The restart fixture removes the live publication, recovers the original page,
and follows an exact finding that was authorized by that page. Finding authority
is granted only after the listing passes response policy. For pages using
cross-publication aliases, recovery rebuilds the mapping from digest-pinned
source snapshots. The gateway restart fixture removes an alias-only publication
that does not appear among the reported links and verifies that the original
remapped endpoint is still returned. Cross-publication recovery currently
retains the asset-bearing publications within Sentinel's 128-case proof
limit. A larger proof uses a dedicated rollover batch so every contributor
is revalidated together. The restart, rollover, and run archive tests each
exercise manifests with more than 32 publications. Portable archive bundles
remain subject to their existing aggregate size limits.

A worker can reopen an exact finding whose reporting asset was matched through
a cross-publication alias after the listing passes response policy. Restart
validates the original listing and restores that exact authority before
replaying the finding read. The gateway test removes the alias publication and
verifies both saved responses. The planner carries the authorized listing's
mapping sources into the exact finding citation on a follow-up assignment.
The worker verifies the retained sources against its assigned revision before
reopening the finding. Run archives and the source retention audit include
those dependencies. Evidence revision rollover checks every retained source
against the destination graph before carrying the citation. The runtime test
keeps an indirect citation across compatible revisions, drops it when an exact
local identity changes the asset match, and checks that the historical
citation remains intact.

Shared link responses now carry an opaque proof digest. Sentinel stores the
source manifest in the case database and checks the digest against the exact
case, evidence revision, and delivered page before granting finding authority
or replaying the page. Worker prompts and provenance graph nodes show the
finding citation without its alias manifest. The restart test verifies that
the alias-only publication is absent from the model's responses and the
original page and finding still recover. Older checkpoints containing
inline manifests require a fresh read.

Portable source bundles compress large snapshots individually when that
shrinks the entry. Restore accepts existing plain entries, bounds decoded
snapshots to 1 MiB for compressed entries, and verifies the original graph
digest. The gateway archive test now exercises alias sources whose plain
entries would exceed the 16 MiB bundle limit, removes the workspace copies,
and reopens the exact finding from the restored case.

Asset-scoped workers can publish the exact evidence-to-finding support
relationship when the assigned-target response delivers both records and
their direct links to the asset. The broker checks the original edge and
both links against the pinned graph after response policy. The gateway
fixture rejects evidence attached elsewhere, verifies same-target peer
reuse, and shows the fact completing queued work and releasing a dependent
task with saved provenance.

Asset-scoped workers can publish a retained control outcome when the
assigned-target read shows that the evidence was observed on the asset and
that the control mitigates a finding affecting that asset. The receipt keeps
the exact pass or fail observation, its observation and validity timestamps,
and the pinned source digests and producing tool step. Peers and planners can
reuse the receipt, and operators can retrieve it by ID. Historical outcomes
retain their original validity window. The gateway fixture checks denied
source reads, cross-asset rejection, idempotency, peer reuse, and planning
input.

Planner proposals and owner-approved trace intents can now wait for an exact
asset-scoped control receipt with `requireCurrentPass: true`. The scheduler
requires a passing outcome whose observation has begun and whose validity
has not expired at the time the task is satisfied. The saved decision records
that time and cites the exact receipt. The gateway fixture verifies that
expired, failed, and future observations leave their work queued and that
the valid receipt satisfies its task without a worker lease and releases
the dependent task.

A current-pass requirement may omit the evidence ID to select the latest
observed check for the exact control and assigned asset in the pinned
revision. The scheduler waits for the receipt for that observation. An
older passing receipt cannot override a newer observation, and simultaneous
conflicting outcomes favor failure. The receipt ID and decision time still
appear in provenance. The gateway fixture exercises a control-scoped
operator intent and planner proposal, proves the older passing receipt
leaves the requirement queued, and reopens the exact newer receipt in
provenance after it satisfies the task.

Pending control-scoped current-pass requirements and their dependent work
can carry to a new evidence revision within the same assessment. The
scheduler revalidates the control-to-asset relationship and operating scope,
remaps dependency IDs, and requires a receipt from the destination revision.
If the control falls out of scope, its existing dependent chain cannot carry
as ungated automatic work. The gateway fixture queues two controls on one
asset, moves the case to a newer graph, rejects reuse of the old citation,
and verifies that only the compatible chain can complete on fresh evidence.

At claim time Sentinel reopens the exact current-pass prerequisite for both
deterministic task leases and model reviews. If the receipt is expired,
unavailable, or no longer the latest scoped observation when required,
direct and transitive dependents stay held. The original satisfaction
decision remains available in provenance. The gateway fixture publishes
a passing receipt and uses the store clock at its exact expiry to verify
both claim paths and confirm that independent work can still run.

A control-scoped prerequisite can release held work in the same evidence
revision when the latest scoped observation has a new, valid passing
receipt. The scheduler appends one renewal event with the original and
replacement receipt IDs, source task, result digest, and evidence revision.
Exact-evidence requirements continue to bind to their original receipt.
The gateway fixture verifies both claim paths after renewal and checks
that the original satisfaction decision and the new audit event are
retained.

Both task and model-review claim events now record the control prerequisites
that authorized the specific lease, including transitive requirements. The
claim and its receipt references commit in the same transaction. A renewal
event is added once when a claim actually uses the renewed receipt. The
gateway fixture reopens the case store and verifies the exact original and
replacement receipt IDs on both claims, with no control receipt attached to
the independent task.

An active model-review lease keeps the exact current-pass receipt bindings
recorded at claim time. Root-dispatched worker calls and review completion
revalidate those bindings. Expiry or replacement of a covering receipt
invalidates the lease's authority and a later claim must establish its own
bindings. The gateway fixture moves the clock between two worker calls
and verifies that the second call cannot open its assigned target and that
an expired review cannot commit a summary.

Sentinel worker checkpoints now carry a digest of the control receipt
bindings on the producing lease. A later lease under the same receipt can
restore the exact saved tool results. A lease authorized by a replacement
receipt starts a fresh conversation. Pending-mutation reconciliation keeps
the original checkpoint binding, so reconciling an outcome cannot make the
old results replayable under a replacement receipt. The gateway fixture
saves a real assigned-target exchange and verifies both decisions.

Partial worker traces use the same control receipt binding as the
checkpoint. A lease under a replacement receipt starts with an empty
progress buffer and assigns new tool step indexes from that buffer.
Receipt reconciliation reads the original binding for an interrupted
batch. Operator history can still inspect the previous partial buffer
until the fresh lease records its own progress. The gateway fixture
verifies same-receipt reuse and replacement-receipt isolation.

Staged GitHub Actions results now use the control receipt binding for the
producing lease. Same-receipt recovery can reopen the original projection
through the existing connector policy checks. A replacement receipt must
obtain and stage a fresh result before publication. Reconciliation looks up
the result under the original checkpoint binding, and published observations
retain their original provenance. The gateway fixture verifies cache reuse,
rejection of stale publication, and first-result idempotency under the new
binding.

A process restart fixture combines control renewal and the configured live
workflow reader with a local transport stub. It kills the first worker after
the original transport result and checkpoint are durable, advances the clock
past the original control window, then opens a new gateway process. The
replacement claim uses a different control receipt in the same revision,
performs one fresh outbound listing, and presents only the new run to the
model. The same-receipt recovery fixture continues to verify replay without
a second listing.

Shared history now supports opt-in GitHub pull request status through
`github_pulls get` for an approved repository. The durable projection
keeps the exact pull number, state, mergeability, and immutable base
repository identity. The delegated recovery fixture verifies one original
read and safe replay, while the owner gateway fixture reopens the exact
payload after archival and exercises the source hooks. Current access
checks probe repository identity and Pull Requests permission without
repeating the original pull detail read.

Approved release history now retains published release IDs, timestamps,
and prerelease flags for an exact repository. The source uses the numeric
repository identity and confirms it again before exposing the projection.
Reopening checks current Contents access without relisting releases.
Delegated recovery verifies exact replay and omission of drafts and free
text, and the connector fixture checks the immutable repository binding.

Approved branch protection history now retains the protected and
unprotected counts for a bounded page from an exact GitHub repository.
Delegated recovery verifies that branch names are absent and that replay
does not relist branches. The owner gateway reopens the exact payload after
restoration and checks both tool hooks. The Contents access probe uses a
different read operation on the same repository ID.

Operators can allowlist exact branch names per repository for retained
branch protection evidence. A saved page includes protection status for
approved branches present in that page and omits all other names.
Removing an approval denies replay or exact historical retrieval of the
previously named projection. The delegated fixture exercises approval
withdrawal, the access fixture checks historical retrieval policy, and
the owner gateway verifies archive restoration of the named receipt.

Shared result search now scans approved GitHub Actions, repository, and pull
request tool steps. It reauthorizes each candidate before matching the
projection, including retained branch names. Continuation uses visible
step metadata and is bound to the query, so denied results do not change
the cursor. The owner gateway fixture searches the named branch after
archive restore and verifies denial with the same continuation cursor.

The owner agent can attach an exact approved branch protection receipt
through `operator_runs attach_branch_evidence`. The approval names the case,
asset, mitigating control, source run and step, branch, and validity window.
The source is reauthorized before publication. The case graph records the
pass or fail observation and an exact execution receipt reference with a
projection digest. The gateway fixture verifies denial, duplicate handling,
and publication by a leased Sentinel worker through the existing fact broker.
The original projection remains available through the source execution trace.

Sentinel run archives retain approved branch protection projections cited
by the current graph or any saved case revision. An owner can resolve an
exact citation with `operator_runs case_execution_evidence` after restore,
even when the original source execution trace is unavailable. The read
rechecks current source authorization and applies the root dispatch hooks.
Restore rejects a missing or mismatched projection before publishing the
case. Archive creation can recover older receipts from their source trace
while that trace is available.

Leased Sentinel workers can reopen an exact execution evidence citation with
`sentinel_assigned_execution_evidence`. The evidence must be attached to
the assigned asset in the worker's pinned case revision. The read reapplies
source authorization and root dispatch hooks. Checkpoint restoration
reauthorizes the source and compares the exact saved result before reuse.
The operator-run gateway fixture interrupts a leased worker after its
receipt checkpoint is saved, reopens the store, and recreates the worker.
It verifies that a mismatched revision cannot obtain the checkpoint, revoked
source access blocks the next model step, and restored access lets the
worker consume the exact result without dispatching the read again.

The worker process restart fixture kills the worker after the approved
execution receipt checkpoint is committed and starts a replacement using
the same case store. The next model step receives the exact saved receipt
after one source authorization check. Revoked source access blocks the
saved receipt before it reaches the model.
[Process restart fixture](../tests/sentinel/live_workflow_restart_test.ts).

The owner can attach an exact approved GitHub Actions, repository, pull
request, release, or branch protection result as an asset observation with
`operator_runs attach_execution_evidence`. The observation keeps the
original role, run, step, receipt digest and timestamp. Control verification
uses the existing branch-specific action. The gateway fixture attaches
each additional approved result type and resolves the exact historical
citation after archive restore with the source journal removed.

An owner can also use `operator_runs attach_workflow_attempt_evidence` to
attach an exact completed Actions `get_run` result to a case control.
Success and failure are verified outcomes. The receipt records the
repository ID, workflow run ID, attempt, and source execution step.
A remediation recheck requires a higher attempt of the same run and
repository. The gateway verifies that an unrelated successful run cannot
recheck the original finding, then an authorized worker records a pass
using the exact scheduled retry. [Gateway fixture](../tests/gateway/operator_run_tool_test.ts).

Before attaching a receipt, an authenticated owner can call
`operator_runs finding_recheck_sources` for the exact case revision,
worker finding, delegated or scheduled trace run, and intended expiration.
It reauthorizes the original finding evidence and each qualified retained
source. Results contain the exact attachment arguments and receipt lineage.
The gateway verifies pagination, a revoked source, an unrelated run, and
attachment of the selected retry. [Gateway fixture](../tests/gateway/operator_run_tool_test.ts).

An archive taken before the planner catches up with committed evidence
can restore its prior queue. Restore accepts a predecessor only when the
archive retains that evidence revision for the same run. The assessment
stays paused until the operator resumes it. The existing scheduler
revalidates retained work against current evidence before carrying it
forward. The gateway fixture restores a case with newer GitHub observations
and carries a queued assignment onto the current revision.

Committed shared asset reads now retain the alias proof digest and the exact
source snapshots used to resolve the aliases. Case archives carry these
sources even when no subsequent assignment cites the shared finding.
An owner can resolve a retained alias source through an exact worker,
planner, or assessment trace by supplying its source case and snapshot
digest. The response identifies the proof without exposing the entire
source graph. The archive gateway fixture removes the original workspace
snapshots and verifies that exact worker and planner citations still resolve
after restore.

Tidepool opens a retained alias source from an exact historical worker
step, planner attempt and step, or assessment review step. The source pane
shows the archived graph, snapshot digest, and alias proof. The gateway
checks the selected case and revision before opening the step and matches
the exact source case and digest in its proof. The restore fixture verifies
all three trace types and rejects mismatched case, revision, step, and
digest requests.

A Sentinel planning round can reopen an exact approved execution receipt
with `sentinel_case_execution_evidence`. The read checks the active case
run, pinned evidence revision, operating constraints, and current source
authorization through the root hooks. The planner's saved read records
the evidence node and result digest. The gateway fixture restores the
receipt without its source journal, consumes it in the next planner model
step, and queues a review citing that exact evidence node. The fixture
also checks source denial and supersession during authorization.

A leased `review_evidence` assignment can reopen the exact retained execution
receipt for its assigned evidence node with `sentinel_assigned_execution_evidence`.
The gateway fixture exercises the planner-to-worker handoff after archive
restore. The worker records the exact read in its review trace and rejects
a different receipt in the same case before checking source access.

A leased execution evidence review can publish a finding for a current
failed branch check after reopening the exact assigned receipt. Sentinel
requires one unambiguous affected asset and validates the finding and
control relationships against the saved case revision. It records the
assignment, evidence node, and snapshot digest in the existing finding
journal. The gateway fixture verifies that a graph preview alone cannot
authorize the write, duplicate submissions return one finding, an
asset-scoped peer can reopen it, and Tidepool lists the saved record.

The restart fixture kills the worker after its receipt-backed finding
commits and before the write response is checkpointed. A replacement
worker receives the exact saved receipt and finding after reauthorization.
The journal retains one finding with the original evidence and asset.
Revoking source access during downtime prevents the saved tool exchanges
from reaching the replacement model while retaining the committed finding.

A leased receipt review can use a newer verification to recheck an existing
finding for the same case, asset, and control. The worker must reopen the
assigned receipt before reading recheck context or writing the result.
Sentinel verifies the current saved check and its outcome, keeps the
original finding intact, and records the new evidence in a separate
recheck. The authenticated gateway fixture verifies both revisions,
rejects a mismatched evidence ID, and confirms duplicate submission is
idempotent. Branch rechecks verify the same named branch against both
attachment identities, including attachments created before this change.
A newer receipt on a different branch cannot clear the finding or block
a valid recheck on the original branch.

After reopening its exact assigned receipt, a leased evidence reviewer
can use `sentinel_worker_findings` to discover original findings that
the receipt can recheck. The list and exact lookup share the recheck
scope and validate the current asset, control, and named branch. The
gateway fixture calls the list without a finding ID and checks that
findings stay hidden before authorization and for a different branch.

Receipt-scoped finding discovery resumes from the saved page when another
worker publishes a newer finding. Recovery checks the original cursor and
each saved record through the current assignment and receipt scope.
A process-restart fixture adds a finding that changes the live first page
and verifies that the replacement model receives the exact prior page.

Exact finding lookups now retain their authorized result when a batch
also writes a recheck. The mixed-batch restart fixture kills the worker
after the recheck commits and verifies that the replacement receives the
original finding and exact journaled recheck. Recovery retains the prior
journal-only lookup for older pending batches.

A newly committed execution verification wakes planning without waiting
for the normal cooldown. The adaptive store remembers which receipt IDs
have already triggered that exception across restarts. The planner can
open an exact receipt through root dispatch and receive matching finding
IDs only after source authorization. The gateway fixture commits two
receipts and verifies that the valid branch is suggested during the next
round while a different branch yields no recheck candidate.

A planner can select a returned finding ID with `recheckFindingId`.
Sentinel accepts the selection only when the current round recorded
that finding in an authorized read of the proposed evidence node.
The stored assignment binds both IDs. The worker receives the finding
ID and its finding tools enforce that scope. The gateway fixture submits
the same finding with two different receipts and verifies that only the
matching receipt creates a bound assignment.

The process-restart fixture now starts with an authorized planner receipt
read and a model-selected finding. It checks the stored planning decision,
then kills the leased worker after it commits the bound recheck. The
replacement reloads the same assignment and both tool results. The case
journal retains one recheck tied to the original finding and task.

Tidepool can open recheck lineage from the bound task in a saved revision.
It shows the original finding, the assignment's exact evidence, and
rechecks committed by that task. The socket fixture verifies case isolation
and excludes rechecks from a different assignment. The process-restart
fixture verifies the recovered finding and recheck through the same
Tidepool handler.

An authorized operator can queue the same bound recheck through
`operator_runs` with `action: "assign"`, `taskKind: "review_evidence"`,
`recheckFindingId`, and the exact execution evidence node. The root
dispatcher checks access to the receipt before requesting confirmation and
again before queueing. The gateway fixture covers a mismatched receipt,
declined confirmation, permission revocation during confirmation, and a
successful replay that reauthorizes the source and returns the original
assignment receipt without reopening approval or adding a task.

The owner can use `operator_runs finding_recheck_candidates` with an exact
finding receipt and the current case revision. The paginated lookup exposes
the exact retained evidence IDs and payload digests eligible for a branch protection
or repository visibility recheck. It reauthorizes each source and omits receipts that already
have a recheck in the selected revision. The gateway fixture verifies
discovery after restore, withholding on source denial, and rejection of an
older case revision.

Authenticated chat also accepts
`/sentinel-recheck <case> <revision> <finding ID> [offset]`. To queue a
selected receipt, append
`queue <evidence ID> <run ID> <adaptive revision> <request UUID>` in place
of the offset. Both commands use the root dispatcher and destination policy.
The queue command uses the same exact assignment approval as operator tools.

Tidepool's historical recheck lineage can look up eligible receipts in
the current revision and request approval for a selected receipt. It shows
the receipt digest and the resulting task ID. The authenticated Tidepool
socket fixture exercises discovery and queueing, response correlation,
destination denial, and replay through the same root dispatcher.

`operator_runs attach_repository_visibility_evidence` attaches an approved
GitHub repository status receipt to a case asset and control. A private
repository passes the check. The evidence ID binds the stable repository
ID, asset, control, receipt digest, and validity window. The gateway
fixture verifies receipt-family and source-policy denials before approval,
idempotent attachment, and exact readback from the resulting revision.
Repository visibility rechecks require a newer receipt for the same stable
repository ID, case asset, and control. The owner gateway fixture queues an
exact recheck from a later private receipt after a public receipt produced a
failed check. The leased worker fixture verifies planner selection, rejection
of a readable receipt from another repository, idempotent recheck publication,
and the original finding and recheck links in Tidepool provenance.

The repository visibility restart fixture uses a public original receipt
and a newer private receipt for the same GitHub repository. It verifies
the planner's finding binding, kills the worker after its recheck commits,
and verifies that the replacement reauthorizes the receipt and restores
the original finding and exact recheck. Tidepool returns the same lineage,
and the recheck journal contains one record.

Receipt-backed branch protection rechecks match both the original branch
name and stable GitHub repository ID. Sentinel verifies the original
case-local receipt against the graph citation before comparing identities.
This preserves existing evidence IDs and archived links. A missing or
invalid original receipt makes the recheck ineligible. The leased worker
fixture proves that an authorized newer receipt for the same branch name in
another repository cannot produce a candidate or a recheck.

`operator_runs attach_workflow_control_evidence` can attach an approved
single completed GitHub Actions run as a success or failure control check.
It requires a numeric workflow ID and includes the exact run in the approval.
Recheck eligibility matches the stable repository and workflow IDs and
requires a later observation of a different run with a strictly newer
GitHub creation timestamp. Triggerfish retains the canonical UTC timestamp
in approved Actions receipts. Earlier receipts without timestamps remain
readable and require timestamped evidence to establish run ordering. The owner
gateway fixture proves attachment and exact readback. The leased worker
fixture covers planner selection, committed rechecks, wrong workflow,
repeated-run, and timestamped older-run rejection, and Tidepool provenance.

The timestamped Actions restart fixture kills the worker after a
planner-bound recheck commits. It verifies source authorization on
restart, byte-for-byte replay of the original committed recheck, a single
journal record, and exact finding and recheck lineage in Tidepool.

The authenticated owner agent can call `operator_runs search_case_traces`
to search up to four explicitly selected Sentinel cases and revisions in
one root-dispatched read. Each case has its own offset and returns exact
case, revision, task, and step references. The owner gateway fixture
exercises two populated cases, exact step reopening, rejection of an
unavailable scope without partial disclosure, and root policy denial.

`search_case_traces` also accepts exact configured workflow run IDs.
A mixed request uses independent Sentinel offsets and workflow cursors
with the same query. A blank query enumerates both sources. Workflow cursors
keep their existing run, plan, and query binding. The gateway fixture
verifies mixed pagination, exact workflow event reopening, and whole-request
rejection when a workflow scope or cursor is unavailable.

The same lookup accepts exact delegated and scheduled run IDs. These
scopes use the execution trace journal's metadata-only list and search
paths with the existing whole-run classification ceiling. Exact steps
reopen through `execution_traces`. The gateway fixture verifies both
roles in a mixed request, exact step reopening, rejection of a cursor from
another role, and rejection of an above-ceiling run without partial results.

`operator_runs list_trace_workers` enumerates saved worker reviews for
an exact Sentinel case revision. Entries show the task ID, target, status,
completion time, and retained step count. The result can be filtered and
paged, and the exact task ID works with `operator_runs traces`. The
gateway fixture checks case and revision isolation, pagination,
classification, and policy denial.

Worker enumeration includes assignments with committed progress before
their final review. The owner can use `operator_runs worker_trace_progress`
to page the saved step metadata or reopen exact indices in the case
revision. The gateway fixture reads a leased worker's committed step while
it runs, reconnects after the worker is stopped, and reads the same step
with its persisted status. Result bodies and checkpoints have their own
authorization and retrieval paths.

`operator_runs worker_trace_result` reopens an exact retained
`sentinel_assigned_execution_evidence` result by case revision, assignment,
and step index. The reconstructed result must match the committed digest.
Root dispatch reauthorizes the original source call and response under
current policy before returning evidence. The gateway fixture verifies the
exact result and distinguishes a different task and source-hook denial.

Exact worker result retrieval also supports retained live GitHub workflow
steps. Triggerfish checks the case, asset, workflow, revision, and run-list
digest. It checks the currently configured destination through the outbound
hook, verifies credential access against workflow metadata, and applies
response and output policy before returning the saved runs. The gateway
fixture checks exact readback, outbound denial before transport, response
denial, and withdrawn upstream access. It uses a local metadata verifier
and fails if retrieval calls the workflow runs endpoint.

Exact worker result retrieval supports retained `sentinel_traffic_get`
steps. The case, evidence revision, original assignment asset, receipt
digest, and committed response digest must match. Triggerfish runs the
traffic source hooks before and after the scoped read. The authenticated
gateway fixture reopens an ingested sanitized receipt and verifies both
source denials and omission of the original secret.

Exact worker result retrieval also supports `sentinel_traffic_search`.
Sentinel reopens the original filters and cursor under the assigned asset,
then compares the reconstructed page with the committed response digest.
The gateway fixture verifies two distinct pages, rejects a mismatched
page digest, and exercises both source policy hooks.

Exact worker result retrieval also supports saved finding-traffic link
pages that carry ordered link IDs and their continuation offset. Sentinel
reopens each immutable link under the original asset, finding, and revision,
then verifies the committed page digest and current policy. New attachments
do not change the saved page. Older trace rows without page references remain
available as step metadata. Gateway and process restart fixtures verify
historical readback, policy denial, and retention of the original link IDs.

A committed `sentinel_attach_finding_traffic` step reopens its original
write receipt under the case, revision, assignment, and asset. Triggerfish
checks the linked traffic digest and the saved response digest when present.
The gateway fixture verifies the exact receipt, rejects an operator-owned
link substituted into a worker trace, and exercises both source policy hooks.

Exact worker trace results can reopen committed finding publications,
remediation rechecks, and report amendments. Journal lookup verifies the
original case, run, revision, assignment, and target. The gateway fixture
checks all three response forms, rejects a receipt from another assignment,
and verifies source policy denial without dispatching a mutation.

An operator can reopen a graph fact publication by exact worker trace
step. The retained journal must match the case, run, evidence revision,
assignment, and target. Sentinel checks the committed response digest
when present and applies both source policy hooks. The gateway fixture
uses a fact published by a leased worker and verifies exact readback,
assignment isolation, and source denial.

Exact worker trace results can reopen the publication receipt for a
committed intermediate workflow observation. Sentinel records the first
authorized publication step on the retained observation so it survives
archival even when transient checkpoints and progress are cleared. The
gateway fixture verifies exact readback while the publisher is running
and after archive restoration, and rejects a different assignment.

Exact worker trace results can reopen the original goal proposal receipt.
Lookup binds the proposal to its case, run, revision, assignment, and target.
Later operator approval changes the proposal's decision state without
altering the returned publication receipt. The gateway fixture verifies
readback before and after approval and denies access at either source hook.

A worker trace can reopen a request-bound `sentinel_prove_goal` response.
The saved request binds the original case revision, assignment, and target.
The gateway verifies the recorded evidence and applies current source
policy. Later proof submissions do not change the original response.
Older steps without a saved submission request ID remain visible as
trace metadata.

An exact request-bound asset discovery submission can be reopened from its
worker trace. Sentinel verifies the original assignment, revision, graph
digest, and claim, then applies current source policy. The operator gateway
fixture confirms that approval leaves the original pending response intact.
The leased discovery fixture verifies that the original request ID is saved
on both trace steps when a submission is replayed.

When a worker exits after committing a goal proof or asset discovery,
Sentinel pairs the recovered response with its original tool call and
matches the exact request against the journal before retaining the request
ID in the completed trace. The process restart fixture verifies both
request IDs are restored with the committed result.

Sentinel case archives retain interrupted worker step metadata in a
dedicated archive trace table. The record preserves the step order, tool,
outcome, and scoped target references. Capture strips result excerpts,
checkpoint data, and other transient worker progress. Restore exposes the
metadata as interrupted trace history while worker resumption reads only
the live progress store. The gateway round trip verifies exact step
readback and checks the packaged database for a synthetic secret.

Archived interrupted traces retain allowlisted receipt identifiers and
digests for exact execution evidence, goal proofs, asset discovery, traffic
receipts, and finding-traffic pages. They omit free-text search filters and
response bodies. The gateway round trip reopens a committed goal proof
after restore by its archived request binding and rechecks the original
source policy.

Archived traffic search steps retain ordered evidence IDs, receipt digests,
the original continuation cursor, and the response digest. Search filters
and result bodies are absent from the archived trace. Restore reconstructs
the original page from the retained traffic journal, applies the search
policy and exact receipt read policy, and verifies the response digest.
The gateway archive round trip verifies readback and absence of search
arguments. The worker restart fixture verifies capture of the page references.

Interrupted archives retain normalized, digest-checked GitHub Actions
receipts for committed live workflow steps. The archive still clears live
results used for worker resumption. The gateway fixture restores a paused
case, reopens the exact retained result through a local metadata verifier,
and denies the same read when upstream access is withdrawn. The runs
endpoint is never called during retrieval.

Native Sentinel live workflow receipts retain stable GitHub repository IDs
and canonical run creation timestamps when the scoped runs response confirms
one repository identity for all rows. Both fields are included in the run
digest and can survive archive restoration. The transport rejects conflicting
repository IDs. Legacy receipts without identity fields remain readable.

An operator can select one numeric GitHub run ID from an exact native
workflow trace with `worker_trace_result.workflowRunNumber`. Sentinel
checks current workflow access and emits a control candidate containing
the stable repository and workflow IDs, canonical creation time, outcome,
and original receipt digest. The archive fixture verifies selection after
restore, rejection of a missing run, and denial when access is withdrawn.
The operator can attach an approved candidate to an existing control using
`attach_native_workflow_control`. The graph retains the case run, source
revision, assignment, tool step, native run ID, and result digest. The
gateway fixture checks withdrawn access, the verification edge, and
idempotent attachment after restore. The planner and leased worker can now
reopen this evidence through their case-scoped receipt tools, with connector
metadata authorization and response classification. The planner treats a new
native receipt as a reason to reconsider work. Rechecks require a distinct,
newer run of the same repository and workflow. The local planner-model
fixture proves receipt retrieval and both hook denials. The native workflow
case in `tests/gateway/sentinel_worker_findings_test.ts` starts with retained
tool exchanges and proves that a new receipt bypasses the durable planning
cooldown, an older GitHub run is excluded, and the scheduled worker records
a passing recheck exactly once. Tidepool resolves the recheck to the original
finding and leased assignment. Authenticated operators can list and queue
native candidates with `/sentinel-recheck` or root-dispatched `operator_runs`.
The gateway fixture opens the exact receipt from ordinary chat, checks that
policy denial prevents listing or queueing, and proves that retrying the
approved request returns the existing assignment.

Restoration verifies native workflow graph citations against the retained
worker exchange. The gateway round trip resolves the exact cited run after
restart. A package with valid checksums and a removed source trace is
rejected before case publication.

The owner can reopen the exact saved native workflow response from a
completed remediation worker with `operator_runs worker_trace_result`.
The gateway checks the committed response digest and reauthorizes the
connector and response before returning the reconstructed record. The
worker findings fixture compares the operator result with the worker's
original tool response and verifies that a later policy denial withholds it.

The native remediation receipt restart fixture commits the worker read,
kills the worker process, and checks that the resumed model receives the
byte-identical receipt. The configured connector probes metadata through
root policy and performs zero workflow listings. An upstream 403 during
restart withholds the checkpoint's tool result from the model.

Asset-scoped workers can publish a control's exact `mitigates` relationship
after the assigned-target read delivers the linked finding and mitigation.
The fact records the relationship and its source digest. A pass or fail
requires a separate control verification. The graph fact gateway fixture
rejects a mitigation for another asset and evidence withheld by response
policy, verifies same-target peer reuse, and shows the committed fact
satisfying a planning assignment without leasing a worker.

Workers can publish an exact retained DNS resolution through an asset's
delivered `uses_hostname` edge. Sentinel checks both edges against the pinned
graph and applies the asset allowlist to the hostname and address before
projecting the resolution. The gateway fixture exercises policy denial,
unrelated hostnames, the asset allowlist, deduplication, peer retrieval, and
scheduler satisfaction using the exact committed DNS fact.

Cross-case discovery reads retain the exact approval version used by the worker.
The provenance export resolves that version from the approval journal, including
its original timestamp and source citation, after the live discovery is corrected
or withdrawn. The two-case gateway fixture verifies that the follow-up cites the
consuming assignment and that historical export returns the exact approval the
worker used. Portable archives retain cited approval records and their verified
source graphs. Restore checks the approval version and source graph digest
against the retained worker steps before publishing the case. The two-case
fixture restores with the workspace discovery journal and source assessment
removed, and rejects an incomplete archive.

The owner can reopen an exact consumed discovery from both live and
restored worker traces. Sentinel reconstructs the destination mapping from both pinned
graphs, matches the committed response digest, and reapplies source read and
response policy. The two-case gateway fixture compares the reopened result
with the worker's original response after source correction and withdrawal,
then repeats the check after archive restoration. Response policy can
withhold the saved result.

Live discovery reads require the approved source graph and the current source
graph to map to the same destination asset and relationship endpoint. An alias
added after approval cannot authorize a new mapping. The two-case fixture
verifies this rejection and checks that the earlier worker response remains
retrievable from the exact trace.

Discovery listings verify candidates from one bounded registry snapshot and
apply the five-result limit after case and asset matching. A withdrawal
during verification is rechecked before delivery. The two-case fixture
places 31 unrelated approvals before the matching discovery and verifies
that the worker still receives it. When more than five approvals match,
`nextAfter` continues from the last delivered discovery. The gateway fixture
verifies two pages with seven unique approvals and exact readback of the
selected record.

The worker process restart fixture saves both discovery pages and commits a
submission before interruption. It approves another matching discovery during
downtime, then verifies that the resumed model receives the original pages
and pending submission receipt. The review preserves the continuation argument
and the gateway reapplies read and response policy to each saved page.

An operator can reopen a peer worker's exact intermediate workflow observation
using its case, revision, assignment, and saved tool step. The gateway checks
the producer, asset, source step, and committed response digest, then applies
the original tool's read and response policy. The gateway fixture proves
retrieval before the producer finishes and after archive restoration.

An operator can reopen an exact graph fact from a peer worker's saved
tool step. The gateway checks the case, revision, assigned target, pinned
snapshot digest, and response digest before reapplying the read policy.
The graph fact gateway fixture verifies response equality, rejects a
different assignment, and exercises response denial.


Graph-fact list steps retain ordered fact IDs, the page offset and
continuation, and the approved response digest. The operator trace tool
reconstructs the exact page from the scoped journal and checks the pinned
snapshot before reauthorizing the response. The gateway fixture reopens
the same page after another fact is committed and the case advances.

Intermediate workflow list steps retain their arguments, ordered observation
IDs, continuation offset, and response digest. Operator trace retrieval
reconstructs the original page from the retained case journal, verifies the
assignment scope, and reapplies read and response policy. The gateway
fixture compares the page before and after run restoration.

Operator trace retrieval reopens original shared discovery list pages
from their approved summaries, continuation arguments, and response
digests. The gateway reapplies current read and response policy. The
two-case fixture verifies both pages after withdrawal and again after
archive restoration with the shared journal removed.

Operator trace retrieval can reopen an exact completed task observation page
the worker read. It rebuilds the page from the completed observation in the
same run and evidence revision, verifies the committed digest, and reapplies
the original tool's read and response policy. The gateway fixture checks the
exact peer page and a response denial.

Operators can reopen an exact finding or recheck journal record from the
worker step that read it. The gateway resolves the assigned asset, checks
the run, revision, and committed response digest, and reapplies the
original tool policy. The remediation fixture compares the retained
finding response with the worker's result and exercises policy denial.

Finding list steps retain the ordered journal IDs, filters, cursor, and
response digest. Historical lookups rebuild the page from those IDs under
the original case, revision, and asset, and reapply read and response
policy. The gateway remediation fixture compares the exact page seen by
the worker and verifies that policy denial withholds it.

Operator traces can reopen a worker's saved defense and incident alert reads
from the original assessment telemetry. The gateway uses the recorded
filters and revision, verifies the response digest, and reapplies read and
response policy. The restart fixture removes live telemetry before checking
the exact upstream and incident pages through operator chat.

Operator traces reopen inventory trace, impact, finding, and coverage reads
from the saved graph and its original control evaluation time. The gateway
checks the response digest and reapplies tool policy. The worker restart
fixture replaces the live inventory, retrieves all four original responses
through operator chat, and verifies a response denial.

Operator traces also reopen shortest and alternate inventory paths from
the original graph revision. The gateway reapplies source policy and checks
the committed response digest. The pinned-source restart fixture replaces
the live inventory, then verifies both original path projections through
operator chat.

Historical operator reads support shortest and alternate provenance paths.
New worker steps retain the exact authorized projection and its digest.
Readback rechecks scope, response policy, and the digest without replacing
the original answer as provenance grows. Normal trace listings omit the
saved body. The gateway restart fixture verifies that both saved path
projections match their original digests and can be reopened through owner
chat. Older steps without the saved body still require an exact digest
match against the recomputed projection.

Operator trace retrieval reopens a worker's exact prerequisite workflow
receipt. It verifies the assigned asset, source review prerequisite, retained
tool step, and response digest, and reapplies the original tool policy.
The restart fixture compares the receipt through ordinary operator chat
after resumption and confirms a later policy denial.

Operator traces reopen the exact carried-assignment evidence response by
resolving the original citation and checking the cited graph evidence
against the assigned revision. The gateway checks the saved digest and
reapplies source policy. The worker restart fixture verifies exact operator
readback of the carried response and a subsequent policy denial.

Operator traces can reopen the exact assigned-target response from the
pinned case graph. The gateway uses the same projection as the worker,
checks current asset restrictions and the committed response digest,
and reapplies source policy. The restart fixture compares the result
through operator chat and verifies that a later policy denial withholds it.

Operator traces reopen a worker's original case hint page using its
first row as an anchor in the append-only hint journal. The gateway
checks the committed response digest and reapplies read and response
policy. The restart fixture publishes a newer hint during downtime and
verifies that operator chat still receives the original page.

Operator traces reopen the original goal-state page using the saved
decision status and per-criterion verification flags with the registered
criteria for the assigned revision. The gateway checks the response
digest and reapplies source policy. The restart fixture verifies readback
of the original page after the goal advances to awaiting confirmation.

Operator traces reopen task-observation search pages using the original
query, ordered task IDs, and continuation offset. The gateway verifies
the results against the same run and revision, checks the response
digest, and reapplies tool policy. The restart fixture adds another
matching observation during downtime and verifies the original search
page through operator chat.

Operator trace retrieval reopens original worker-trace searches by the
retained assignment and step indices. It preserves the original count
and cursor, applies the same worker visibility filter, verifies the
response digest, and reapplies source policy. The peer-evidence restart
fixture checks exact readback and policy denial through operator chat.

Operator traces reopen provenance search pages from the saved ordered node
IDs, count, and cursor. Each node must still match the recorded filters in
the assigned revision. The gateway verifies the committed response digest
and reapplies current policy. The pinned-source restart fixture verifies
exact results and denial through operator chat.

Operator traces reopen provenance node detail pages using the saved
connection fingerprints, original count, and cursor. The gateway
reconstructs the worker-filtered page, verifies its full digest, and
reapplies source policy. The pinned-source restart fixture verifies
exact node-detail readback and policy denial through operator chat.

Operators can reopen the exact pinned topology and shared finding
responses from worker traces. Both paths reuse the worker's response
projection and verify the retained source and response digest before
applying current tool policy. The pinned-source restart fixture replaces
the live reporting inventory and verifies both original responses.

Operators can reopen a committed worker's shared asset-link page through
`operator_runs`. Sentinel retains the bounded, credential-checked page
with the normalized request and response digest. Readback reapplies source
policy and verifies the exact case revision and trace step. The restart
fixture removes a contributing live publication, then proves exact readback
and response-policy denial through operator chat. The archive gateway fixture
also reopens an interrupted worker's committed page after restore, rejects
a digest-mismatched step, and verifies response-policy denial.

Interrupted asset-link pages also retain their cited asset and alias mapping
snapshots. The archive gateway fixture removes both workspace copies, restores
the stopped run, and follows the pinned sources through `worker_trace_source`.
The fixture checks that a different source digest and a response-policy denial
both withhold the source.

Interrupted pinned topology and finding reads survive archive restore. The
gateway fixture removes workspace copies of their sources and verifies exact
responses through `worker_trace_result`. It also follows the finding's cited
asset through `worker_trace_source` and confirms the archived copy resolves.

Completed and interrupted worker source drill-downs reapply the originating
tool's pre-call and response policy using the exact case, revision, and
assignment. The archive gateway fixture denies each hook for a completed
trace and verifies that pre-call denial skips response classification.
Historical source drill-down requires saved arguments or a legacy shared
inventory trace with its original asset target.

Operator chat also reapplies source-tool policy when following archived
planner or assessment review citations. Planner calls retain normalized
source selectors, and the gateway supplies the exact planner round and
attempt to the hooks. The archive fixture verifies pre-call and response
denial for both paths after restore. It uses a saved planner receipt and a
legacy assessment trace with an explicit asset target.

A gateway round-trip fixture dispatches a real model planner with a local
provider stub. It checks the exact topology tool selector and response
digest in the planner journal, removes the reporting case and workspace
snapshot, then restores the archive through operator chat. Source readback
resolves the original asset and honors pre-call and response denials.

An exact `planner_reads` request can set `includeResult: true` to reopen a
pinned topology or finding response. The gateway reconstructs the original
projection, checks its committed digest, and reapplies the source hooks.
The dispatched planner archive fixture verifies byte-for-byte topology
readback after restore, policy denial, and rejection of a mismatched attempt.

The planner journal retains exact shared asset-link pages from approved
calls. Regular history exposes their receipts and source references.
Explicit result readback checks the selector, evidence revision, digest,
and current hooks. The dispatched planner gateway fixture removes live
inventory and both workspace snapshots, restores the archive, and verifies
the exact page and its independently retained source.

Worker history, review notes, trace search, and provenance detail expose
asset-link receipts and source references. The full saved page is available
through explicit, policy-checked result readback. The restart fixture checks
these projections and verifies that response denial withholds the exact page.

Sentinel history and provenance projections retain response digests while
withholding saved excerpts. Trace search matches step metadata and source
references. The worker provenance fixture verifies that an assigned-target
receipt remains citable without returning its saved excerpt.

Exact planner result readback also supports relationship trace and impact
queries. The planner records their normalized selectors and response
digests. Readback reconstructs each result from the archived assessment
revision and reapplies current tool policy. The gateway fixture verifies
both original responses after restore and denial by the response hook.

Planner result readback also covers inventory paths, finding reports, and
control coverage. The gateway fixture records real dispatched calls against
an assessment with a finding, restores the archive, and verifies exact
results and response-policy denial for all three. Provenance paths depend
on derived history and need separate retention for exact replay.

Planner provenance paths retain the approved, bounded response with the
original selector and digest. Ordinary planner history omits the payload.
The gateway archive fixture dispatches a provenance path query, restores
the case, and verifies its exact result and current response-policy denial.

Planner provenance search and node detail retain the original page order,
counts, and cursor using node IDs or connection fingerprints. Exact
readback rebuilds the page from retained evidence, checks the response
digest, and reapplies the source tool's hooks. The dispatched planner
fixture verifies both pages and response denial after archive restore.
Readback fails closed when retained records cannot reproduce the digest.

Exact planner readback covers worker-observation and worker-trace search
pages. It retains the authorized task and step ordering and original
pagination, then checks the reconstructed digest and current policy.
The dispatched planner archive fixture verifies both nonempty pages and
response-policy denial after restore.

Direct planner observation readback retains the exact assignment selector
and page offset. It reopens the completed result in the saved revision,
checks the response digest, and reapplies the original tool's hooks. The
gateway fixture verifies a nonzero offset and response denial after restore.

Planner goal-state and case-hint results can be reopened from the original
round and attempt. The gateway uses the saved goal verification projection
or first hint ID, verifies the response digest, and reapplies current
policy. The archive fixture commits a newer hint before archiving and
verifies readback still returns the original page.

Planner execution-evidence readback verifies the original response digest
and reauthorizes the underlying execution source before returning the
result. The native workflow archive fixture verifies exact readback after
restore, denial when repository metadata access is revoked, and denial at
the planner tool's response hook. The connector only verifies current
access during readback.

Planner defense summaries and incident alert pages reopen from retained
assessment telemetry. The defense summary uses the containment configuration
recorded at the original read. The archive gateway fixture removes the live
alert input and verifies exact readback and response-policy denial for both
tools after restore.

Planner traffic search and exact receipt reads retain selectors, receipt
references, pagination, and response digests. Explicit readback checks
the original case revision and reapplies current source-tool policy.
The gateway fixture proves exact sanitized readback and response denial
after restore. Finding-to-traffic link pages have a separate receipt format.

Planner finding-to-traffic link pages reopen from the original ordered link
IDs, finding selector, and pagination cursor. The gateway verifies the
case revision and response digest, then reapplies the source hooks.
The archive fixture dispatches a planner read of an approved attachment
and verifies exact readback and response-policy denial after restore.

The planner can reopen a committed relationship fact by exact ID through
`sentinel_graph_facts`. The read is bound to the case, run, evidence
revision, graph digest, and operating constraints. The gateway fixture
dispatches a read against a seeded committed fact and verifies exact
planner readback and response-policy denial after archive restore.

Planner graph fact pagination filters the saved case revision and applies
operating constraints before computing the offset and continuation.
Readback uses the original ordered IDs and rechecks their scope and digest.
The archive fixture verifies a nonzero offset, exclusion of a stale graph
digest, and response-policy denial after restore.

Planner finding and remediation recheck reads retain exact receipt IDs
or ordered page IDs. Explicit historical readback uses the read-only
journal and reapplies case, revision, operating constraints, and tool
policy. The archive gateway fixture verifies an exact recheck and a
paginated finding response after restore, including response denial.

A planner can read an exact approved peer discovery under current case
scope and operating constraints. Its journal pins the approval version
and source evidence. The archive gateway fixture withdraws the live
approval, restores the consumer run, and verifies exact readback and
response-policy denial of the original receipt.

Planner discovery listing uses the existing approved-peer cursor and checks
case operating constraints during live reads. The planner journal retains
bounded page summaries for explicit, policy-checked readback. The gateway
fixture verifies the first page and its continuation after an approval is
withdrawn and the consumer run is restored.

A planner can reopen an exact committed workflow observation while its
source worker is still running. The planner journal binds the source task
and step, revision, workflow receipt digest, and response digest. The
gateway fixture verifies exact readback after archive restore, response
denial, and revoked connector access. Readback makes no workflow runs
request.

Planner intermediate workflow observation lists filter the exact evidence
revision and authorized asset set before pagination. They expose the
committed observation identity and source step. Explicit readback rebuilds
the original page from its ordered IDs and checks its digest and current
policy. The gateway verifies a populated page and a nonzero offset after
restore while connector-backed exact reads retain their access check.

Planner evidence digest lists and expansions retain bounded, validated
member projections. Explicit result readback verifies the case, run,
revision, selector, and digest before applying current tool policy.
The gateway fixture removes the workspace digest database and verifies
both original responses after restore. The retained pages support history
readback independently of the workspace registry.

The Sentinel archive includes a case-local digest catalog for its retained
revisions. Restore verifies each scope, digest identity, and member list
before installing the catalog. New queries can list restored digests,
continue an existing expansion cursor, and page from new workspace
digests into the archived catalog. The gateway fixture verifies these
paths after removing the original workspace registry.

A new assessment in a restored case can query and archive its own digests
while the earlier run's catalog remains on disk. Query and capture filter
the case-local catalog by run and revision. Restore validates the archive
against its manifest identity. Gateway coverage starts a new run in the
restored case, denies the earlier digest at the new revision, and verifies
that the new archive contains only its own catalog.

Sentinel coordinator and planner tool bindings expose
`sentinel_graph_overview`. Operator agents use `operator_runs graph_overview`
with an exact case and revision. The response summarizes node kinds,
relationship types, and unresolved references without returning graph
payloads. Gateway coverage verifies planner hooks, archived operator
readback, revision rejection, and response-policy denial.

Planner graph overview readback retains validated aggregate counts and the
original response digest. The archive gateway fixture adds an adaptive
task after the planner's read, verifies that the current overview grows,
and reopens the exact earlier overview under current tool policy.

Coverage pages accept a `coverageGap` filter for unreviewed assets, assets
without linked evidence in the selected revision, or either condition.
The filter applies before pagination and is bound to the cursor. Planner
queries apply the current allowed asset set. Operator queries can use
approved case membership. Root-dispatch fixtures cover the planner scope,
membership, gap results, and mismatched cursors.

Planner coverage pages retain the original bounded projection, selector,
and response digest. The archive fixture records a later finding review
in the same revision, verifies that the live view reflects it, and
reopens the planner's earlier page under current policy. Planner node-detail
reads now retain the bounded response and verify its digest on readback, so
the same fixture reopens the exact node page after the review changes.
Older receipts require a matching reconstructed response.

Interrupted worker archives also retain the exact bounded provenance node
page returned through root dispatch. The gateway fixture updates the finding
review, restores the case, and reopens the worker's original page through
pre-call and response authorization. Ordinary trace listings expose metadata
only.

Planner and leased-worker provenance search receipts retain the bounded
search projection beside its selector, revision, and digest. The gateway
fixture confirms that a review can age out of live search while the original
worker page remains available after restore under current policy.

Recoverable owner chat executions use `operator_runs archive` and `restore`
with kind `owner_chat` and the execution UUID. The active owner's persistent
session supplies the scope. The archive retains the committed, policy-projected
checkpoint and tool receipts. Restore installs the checkpoint paused.
`/recover --resume-paused <UUID> <original request>` revalidates the original
binding and tool access before continuing. The [gateway fixture](../tests/gateway/agent_recovery_test.ts)
verifies replay-free resume after restart, corrupt package rejection, session
isolation, and credential revocation. Ordinary chat history stays in the
conversation store.

Authenticated owners can pause a recoverable owner chat execution at an
existing committed checkpoint with `operator_runs pause`, kind
`owner_chat`, and the exact execution UUID. Confirmation is checked
against the same checkpoint under the execution lock. The gateway fixture
covers owner-session scope, root policy denial, declined approval, and
idempotent replay. The paused execution survives reconnect and requires
explicit resume, which reuses the exact saved GitHub Actions result.

Archive publication records the intended manifest digest before publishing the
package. After an interruption, retrying the same request verifies the published
package against that digest and finalizes the original receipt. Incomplete or
changed packages fail verification without recapturing the run.

Inventory coverage can filter for assets without a current control verification
at an explicit UTC instant. It evaluates controls linked to each asset's
findings and counts current pass and fail results as evidence. Future and
expired verifications leave the gap open. The instant is part of the page
cursor, and the query honors the worker's scope or the operator's selected
case membership.

Owners can search and reopen retained case traffic through root-dispatched
`operator_runs traffic_search`, `traffic_get`, and `traffic_blob`. Sentinel
workers use the matching case tools under their exact asset assignment. For
reviewed capture files, `sentinel traffic --format=har --publish
--retain-reviewed-response` retains up to 64 KiB of unencoded response text
per receipt. Search and receipt metadata omit the body. The gateway test
reassembles the exact text across pages, verifies policy and case denial,
and reopens the same content after restore. Legacy metadata, unapproved HAR headers and packet payloads have no
body readback.

Owner traffic search and exact receipt reads advertise the retained response's
UTF-8 byte length and SHA-256. Each blob page carries the same descriptor so
investigators can verify the reassembled text. Sentinel's existing search and
receipt projections keep their original shape for historical readback.

Reviewed HAR request text is independently opt-in with
`--retain-reviewed-request`. Select it with `payloadPart: "request"` on the
blob read. The gateway fixture checks exact pagination and archived readback
for both bodies.

Reviewed HAR header retention uses `--retain-reviewed-headers` and
`payloadPart: "headers"`. The projection keeps allowlisted content and cache
headers in captured order, including their original names and values. The
gateway archive fixture verifies the exact projection and digest while excluding
authorization and cookie headers.

Reviewed binary HAR responses use `--retain-reviewed-binary-response`.
The response blob returns independently decodable base64 pages at byte
offsets, with a SHA-256 over the full decoded response. Retention accepts
canonical base64 up to 32 KiB decoded per response. The gateway fixture
reassembles the bytes and verifies the same first page after archive restore.

An owner can page a finding's attached payload directly with
`operator_runs finding_traffic`, the exact finding and traffic link IDs,
and a `payloadPart`. The read verifies the case, revision, attachment asset,
and receipt digest. The gateway fixture proves reassembly through the link,
scope rejection, policy denial, and exact readback after restore.

A leased Sentinel worker can also reopen an attached payload with
`sentinel_finding_traffic_links`, supplying the exact revision, finding ID,
traffic link ID, and payload part. The response carries the attachment
provenance and the digest of the full retained payload. The worker gateway
fixture proves exact multi-page reconstruction, pre-call and response denials,
output blocking, and rejection of another asset or evidence revision.

Owner agents can query saved detection evidence directly through
`operator_runs defense_coverage` and `incident_alerts`. The gateway archive
fixture restores a saved case after removing the live alert input, then
reopens an upstream check match and an exact incident alert page. Coverage
counts describe retained evidence. Deployment checks remain separate.

The existing CloudTrail feed recognizes successful CloudWatch Logs
`DeleteLogGroup` and `DeleteSubscriptionFilter` events as separate integrity
signals. The checks preserve the triggering action and normalized event
reference. Denials stay authorization events, and request parameters stay
outside the retained projection. The gateway archive fixture ingests
synthetic CloudTrail records and reopens both exact coverage matches after
restoring the case. [AWS CloudTrail source documentation](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/logging_cw_api_calls_cwl.html).

The same CloudTrail feed reports account-level S3 Block Public Access
writes and removals separately from bucket-level removals. The coverage
check records the exact source action and event reference. The change
record alone cannot establish effective public access. The archive
gateway fixture reopens the account-level match after restore.
[AWS S3 CloudTrail event reference](https://docs.aws.amazon.com/AmazonS3/latest/userguide/cloudtrail-logging-s3-info.html).


The Kubernetes audit feed records successful changes to
ValidatingAdmissionPolicy and ValidatingAdmissionPolicyBinding as two
distinct checks. It excludes dry runs, leaves denied operations in the
authorization path, and drops policy bodies and resource names from the
retained projection. The gateway archive fixture restores both qualified
matches and verifies their source evidence IDs.
[Kubernetes admission policy reference](https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/).

The Winlogbeat feed accepts Defender Operational and forwarded events
for disabled malware or virus scanning and expired endpoint protection.
The source provider and channel are checked, and event bodies stay
outside the projection. The archived coverage gateway fixture reopens
exact source evidence for both checks.
[Defender event reference](https://learn.microsoft.com/en-us/defender-endpoint/troubleshoot-microsoft-defender-antivirus).




The owner `operator_runs incidents` action lists the incident candidates in a
saved case revision with an optional exact asset filter. Pages include the
incident ID, time range, alert count, and latest review disposition for that
revision. The gateway fixture discovers an incident from a restored case and
uses its ID to reopen the exact alert page.

The owner `operator_runs review_incident` action confirms a disposition and
note for the current incident revision. Its request UUID binds the exact
decision. The same approved request reopens its saved review after archive
restore, while altered or stale requests are rejected. A committed review
feeds the existing adaptive planner input.

Owner incident discovery combines the saved candidate sample with candidates
reconstructed from the revision's retained alerts. The gateway fixture
lists all 26 incidents from a restored case, then reads and reviews the
incident outside the 25-candidate planner sample.

An owner can assign a retained incident outside the planner sample. A leased
incident-review worker can open the alerts for its exact assignment and
revision. The gateway fixture assigns the 26th incident, verifies that
the worker can read it and rejects a second incident, then reopens the
worker's exact alert page after archive restore under current policy.

Owner assignment retries read the committed request binding before
confirmation. The gateway fixture verifies that an identical request
returns its original receipt after restart, and an altered request with
the same UUID is rejected without asking for confirmation again.

Owner agents can confirm dispositions for saved Sentinel graph findings with
`operator_runs review_finding`. Finding and incident decisions share the
revision and request binding. `operator_runs decision_history` pages the
retained decisions for one exact subject. The gateway fixture verifies
finding review confirmation, changed-request rejection, and archived review
receipt and history readback.

Owner `operator_runs case_alert` follows an upstream check's content-derived
alert reference to the exact saved alert, including isolated alerts. The
gateway fixture verifies lookup after restore, rejection in another revision,
and response-policy denial.

Planners and workers can pass the exact `alertId` with `upstreamCheck` to
`sentinel_defense`. The reader checks that the alert actually matches the
named check in the selected revision. The gateway fixture verifies exact
planner readback after restore and rejects a mismatched check and mixed
pagination arguments.

Owner `operator_runs tasks` pages the durable Sentinel queue by exact case
revision, with optional task and status filters. It shows dependencies,
unfinished dependencies, and fact-satisfaction references. The gateway fixture
reads a dependent task after archive restore and verifies the same task's
transition from queued to completed after resume.

Owner agents can inspect pending dependency changes in `operator_runs tasks`
and apply or dismiss one exact proposal through the existing queue controls.
Confirmation shows the complete proposal group. Commit rechecks the active
revision and planner input and preserves the store's cycle and evidence
requirements. The gateway fixture verifies root denial, application,
dismissal, and replay rejection.

Owner agents can also change the priority of a queued task, withdraw that
priority, retry an eligible failure, or cancel queued work. Confirmation
lists the exact affected tasks, including queued dependents of a cancellation.
The commit rechecks that selection under the assessment write lock. The
gateway fixture verifies each action, rejection of repeated changes, and
cancellation of the target and its dependent while preserving independent work.

Owner task pages show model-review status and retry eligibility. The
`retry_model_review` action confirms one additional attempt for an exhausted
review when Sentinel model access is enabled. It uses the same decision,
stop, and uncertain-mutation safeguards as Tidepool. The gateway fixture
verifies configuration denial, the transition to retry pending, and
rejection of a repeated retry.

Owner agents can inspect, set, and reset a case's Sentinel worker limit.
Changes require confirmation and a current case revision, and the scheduler
uses the lower of the case and gateway limits. The gateway fixture verifies
the configured ceiling, rejection after a concurrent change, persistence
across reconnect, and reset to the gateway default.

Owner task diagnostics expose analyst holds, retirement recommendations,
and the scheduler's current-control prerequisite hold. An explicit
`asOf` evaluates control validity at a fixed instant. Exact task reads
also identify originating workers and upstream alerts. The gateway fixture
shows a transitive hold after a passing receipt expires while independent
work remains unaffected.

Exact task diagnostics identify the transitive prerequisite tasks that
trigger a control hold, their requirements, and the original fact and
source task that satisfied each requirement. The read uses the same
validity evaluation as dispatch and leaves the queue intact.


Finding-specific traffic pages return an attachment set digest for the exact
evidence revision, including links outside the requested page. Worker report
amendments compare that digest under the case write lock and retain it on the
saved receipt. The [worker gateway fixture](../tests/gateway/sentinel_finding_traffic_test.ts)
rejects a digest read before an attachment was added in the same revision,
rejects omission when attachments exist, and verifies idempotent retry with
the current digest.

The owner agent uses `operator_runs amend_finding_report` with the exact
finding, revision, report version, attachment digest and request UUID.
Confirmation shows the proposed report text. The gateway rechecks the exact
report and evidence after approval and records the amendment in the finding
journal. The [gateway archive fixture](../tests/gateway/sentinel_run_archive_test.ts)
exercises stale evidence, root policy denial, operator refusal, retry, and
readback after restore. Planner trace readback retains the attachment digest
that was included in the original tool response.

A worker's exact finding-linked payload read records the link selector and
response SHA-256 in its execution trace. The authenticated owner can use
`operator_runs worker_trace_result` to reopen the page from retained traffic.
Readback checks the assignment asset and evidence revision, verifies the
original response digest, and reruns source policy. The gateway archive fixture
records a real leased worker read, restores the case, verifies exact page
readback, and exercises pre-call and response denials. The worker trace stores
the reference alongside its existing history. The payload stays in the retained
traffic journal.

Worker checkpoints can restore an exact finding-linked payload result using
its committed trace selector and digest. The checkpoint stores a digest
marker. Recovery reconstructs the page from the scoped traffic journal and
the shared turn runner reruns policy before returning it to the model. The
gateway archive fixture interrupts the worker after checkpoint commit,
reopens the checkpoint store, exercises response-policy denial, and verifies
an authorized resume without a second tool dispatch.

Planner history retains the same reference for a finding-linked payload page.
The owner can reopen the exact result with `operator_runs planner_reads`,
selecting the case revision, planner attempt, and read ordinal. The gateway
rechecks current case constraints and source policy, then verifies the
original response digest. The archive fixture reads a nonzero payload offset
through a planner agent and verifies identical readback after restore,
cross-case rejection, and both source-policy denials.

A committed verified finding in the active evidence revision queues one
durable report assignment. Sentinel keys the assignment by the finding
receipt, gives its worker only the finding and traffic tools and the report
amendment tool, and checks the exact report version and attachment digest
before writing. The finding journal preserves the amendment and its
assignment. The gateway worker fixture publishes a duplicate finding,
starts the reporting coordinator from the retained queue, exercises a stale
digest, verifies the amendment and root policy hooks, and checks that
restarting the coordinator does not dispatch the completed report again.


Reporter recovery also handles interruption after the amendment commits and
before assignment completion. The gateway fixture stops the coordinator in
the response hook and starts a new coordinator from persisted state. Recovery
matches the committed request and argument digest, retains the amendment
reference in the trace, and completes the assignment without a second write.

Owner agents can discover delegated and scheduled runs through
`operator_runs list` with an explicit kind and reopen the same run through
`operator_runs inspect`. Listing accepts the trace journal's role-bound
cursor. Both actions return a canonical run reference and lifecycle metadata
under the existing INTERNAL ceiling. The owner gateway fixture checks
delegated and scheduled discovery, exact inspection, role mismatch rejection,
and confidential-run exclusion.

The shared confirmed run-link flow accepts delegated and scheduled run
references. Both endpoints are checked against the current trace
classification before confirmation and before commit. Inspecting either
endpoint rechecks visibility before showing the link. The owner gateway
fixture links a delegated and scheduled run that share the same run ID,
rejects a confidential endpoint, and verifies durable, idempotent readback
after reconnect.

Owners can cancel an admitted delegated or scheduled run through the confirmed
`operator_runs cancel` action. The trace journal records the decision before
signalling the live turn, and later admissions for that exact execution
recognize the cancellation. The owner gateway fixture cancels both roles
through their normal execution wrappers, verifies pre-call denial and
idempotent retry, and inspects the durable result after reconnect. The
scheduler recovery suite also exercises takeover of an older wrapper.

Owner agents can pause a delegated or scheduled run with an idle committed
checkpoint. That decision uses the existing recovery lock and pause journal.
The owner tool can resume paused cron and trigger occurrences through their
original scheduler admission. The cron gateway fixture pauses an occurrence,
archives and restores it, resumes over owner chat, and verifies that its
previously committed tool call executes once. Owner chat can also resume a
paused delegated run using the original execution ID and task. The gateway
test reopens the owner chat, rejects mismatched identity and task inputs,
then resumes the saved turn without replaying a completed tool call.
An owner can also request a pause while a recoverable tool batch is in
flight. The request is durable and the batch can commit before execution
stops. The delegated gateway fixture holds the batch open, requests a
pause through owner chat, then verifies the committed result is reused
on resume. If the gateway stops during an uncommitted replay-safe read
batch, a renewed owner pause can settle at the previous committed
checkpoint. The gateway fixture seeds that interrupted state, resumes
the exact checkpoint, and verifies that the committed call is reused.
An interrupted batch with an uncertain mutation outcome still requires
reconciliation. For a paused verified webhook, an operator can send the
original body through authenticated `POST /recovery/webhooks/{id}?stage=true`
and then approve `operator_runs resume` in owner chat using only the exact
scheduled run ID. The gateway retains staged bodies in memory for up to
five minutes. Resume consumes the body and rechecks the admission and current
source policy. The webhook recovery fixture restores a paused run, rejects
a changed body and a pre-call denial, then resumes through owner chat without
repeating the committed tool call or exposing the body to the owner model.

Triggerfish core owns recoverable agent turns, their recovery identity,
assignment checkpoint storage, and the asynchronous assignment guard.
Sentinel supplies its case lease, evidence revision, control prerequisites,
and exact receipt reconciliation. Its existing checkpoint table and archive
format remain readable. Delegated and scheduled recovery use the core turn
runner and retain their own execution-admission and tool persistence policies.

A cron job can read one committed Sentinel workflow observation through
`read_committed_observation`. The operator configures the exact
`cron_job_id`, `case`, `run_id`, `revision`, and `observation_id` under
`sentinel.scheduled_observation_reads` and grants the repository through
the existing GitHub recovery configuration. The tool inherits the cron
ceiling and root policy. It checks current access against the saved
repository ID and workflow before returning the observation and source
assignment and step. Durable recovery rechecks access and the exact
projection under the original grant.

A Sentinel planner can cite a committed workflow observation when proposing
a same-asset trace or impact assignment. The planner must first reopen it
through the scoped tool. The scheduler retains the exact observation, source
assignment, source step, revision, and result digest with the follow-up.
The existing dependency queue tracks the source assignment. Tidepool
provenance links the follow-up directly to the retained observation.

An INTERNAL operator workflow step can require an exact committed Sentinel
observation with the `satisfiedBy` configuration. The requirement names
`case`, `run_id`, `revision`, `observation_id`, and `workflow_run_id`. The
resolver checks the current case revision, current repository permission, and
the exact completed successful workflow run before settling the step. The
workflow journal saves a `step_satisfied` event with the source assignment
and digest. A failed, stale, or unavailable proof leaves subsequent steps
pending. The owner gateway fixture verifies the step is skipped, its
dependent runs, and the exact receipt survives reopening the journal. The
gate releases a dependent only after the satisfaction receipt and updated
step state commit together. The same gateway fixture forces the journal
to decline that write and verifies that both steps remain pending and no
dependent execution is recorded.

The same gate accepts an exact `graph_fact_id` in place of
`observation_id` and `workflow_run_id`. The case, run, and evidence
revision must still be current. The resolver checks the fact against the
pinned graph and current operating constraints. The journal retains the
fact ID, producing assignment and step, and source result digest. The
graph fact gateway fixture starts a workflow while the source assignment
is still leased, verifies that the fact satisfies its prerequisite while
a stale revision leaves its dependent pending, and reopens the exact
receipt after reconnecting to a new workflow adapter. The fixture also
reopens a journal captured while a workflow was waiting, then publishes the
matching fact through a leased worker. The recovered run keeps its original
deadline, wakes before the fallback poll, records one satisfaction, and
releases its dependent. A second wait starts with an eligible fact,
then an approved owner-chat constraint change denies evidence review before
the gate rechecks it. The wait expires with both steps pending and no
satisfaction or dependent execution in the journal.

An INTERNAL operator workflow can also require an exact
`finding_recheck_id` in the current case, run, and revision. The verifier
replays the retained pass against the pinned graph and current operating
scope. The workflow journal keeps the exact recheck, original finding,
supporting evidence, source assignment, and receipt digest. Later steps
revalidate the proof before running. The owner gateway fixture publishes the
finding and recheck through leased tools, rejects an unknown or stale receipt,
and proves an expired recheck blocks dependent work after the workflow is
reopened and resumed. [Gateway fixture](../tests/gateway/sentinel_graph_fact_test.ts).

A workflow can name the original worker `finding_id` and configure
`evidenceWaitSeconds` before any matching pass exists. The waiter keeps
its deadline through restart and wakes when a leased worker commits a pass
for that exact finding and revision. Satisfaction pins the matching recheck
receipt. The gateway verifies unrelated, stale, and expired proofs leave
dependents pending, while a matching publication releases the dependent
once and records the source assignment. [Gateway fixture](../tests/gateway/sentinel_graph_fact_test.ts).

An exact graph fact gate can also set `require_current_pass: true`.
At satisfaction, the exact receipt must report a currently valid pass
from the latest observed check for its asset and control. The receipt
records the evaluation time. The gateway fixture accepts a current pass
and keeps dependent work pending for a superseded pass or a pass at its
exact expiry boundary. With `asset_id`, `control_id`, and
`require_current_pass: true`, the gate can wait before the exact fact
ID exists. A matching committed verification wakes the scoped waiter.
The gateway fixture starts after the prior pass expires, publishes a
renewal, and verifies that its exact fact and source step are recorded
before the dependent completes.

Before downstream work starts, including after pause or restart, the
workflow reopens its committed proof. An exact fact gate keeps its original
fact and digest. An asset-and-control gate can adopt a fresh pass for the
same scope after appending a `step_proof_renewed` receipt. The original
satisfaction remains in history. The gateway fixture pauses both gate
types, advances to expiry, and resumes from the saved journal. The exact
gate leaves its dependent pending. The asset-and-control gate resumes
after the worker publishes a fresh pass, records one renewal, and uses
that receipt for later steps.


An evidence-gated step can opt into a deadline with `evidenceWaitSeconds`
from 1 to 60. The step and its successors remain pending during the wait.
A committed observation wakes matching waiters by case, run, revision,
and observation ID. Each wake rechecks the current proof and permissions.
Bounded polling covers publications from another process, and cancellation
or timeout ends the wait.

A waiting workflow persists its original deadline as a `step_waiting` trace
event. An owner resume uses the remaining time. If that deadline has already
expired, the workflow fails without probing the evidence source or releasing
its dependent. The owner gateway fixture reopens an interrupted journal and
verifies the original deadline and pending dependent.

Gateway startup automatically resumes an interrupted running workflow when
its next pending step has a durable evidence wait. The resume lock checks
the current plan and original deadline. Explicitly paused and restored-paused
runs still require operator resume. The restart fixture covers an available
proof, an expired wait, and an explicitly paused run.

The shared approval inbox records when the exact claimed dispatch returns
from its tool handler, before response policy runs. The receipt contains a
timestamp and the existing approval identity. Reconnects can distinguish
a call that returned from a claim with no return receipt, and the final
dispatch outcome still depends on the response policy. The approval gateway
fixture holds the response hook open and verifies the return receipt survives
reconnect without releasing the response or repeating the handler.

The shared GitHub connector exposes `github_actions get_run` through root
dispatch. It reads an exact run ID and optional attempt, checks the upstream
repository identity, and returns only the identifiers and classified
status and conclusion. The gateway fixture rejects mismatched identities
and exercises pre-call, response, and output policy. A run status read can
verify upstream state for later reconciliation. It gives no attribution
for who caused that state.

With `agent_recovery.github_run_status: true`, a durable turn can retain
an exact `get_run` result for an approved GitHub repository. The durable
request includes the attempt number. Recovery checks current repository
identity, classification, and Actions access before returning the saved
state through root policy. The gateway fixture removes the connector
credential after checkpointing, verifies that replay is denied, restores
access, and shows that the completed run read executes only once.

The same opt-in retains that exact run and attempt in shared execution
history. The delegated gateway fixture proves that resumption records one
trace and makes one upstream run read. The authenticated operator gateway
fixture reopens a saved payload after archive restore, applying the
original tool's pre-call and response hooks. The payload authorizer
rechecks repository identity and Actions access with current metadata.


Owner chat can reconcile an interrupted GitHub Actions cancellation when
`agent_recovery.github_cancel_runs` lists the exact `repo`,
`repository_id`, `run_id`, and `attempt` and the repository is also in
`github_repositories`. The original root dispatch requires an operator
approval. After approval, an upstream read checks that the configured
repository and current attempt match and that the run is still active.
Recovery uses read-only checks and leaves the action held unless the same
attempt is completed with a cancelled conclusion. That state establishes
the outcome, without attributing the remote transition to this call.
The gateway fixture uses synthetic transport and verifies a single
cancellation POST, no replay while the run is still active, and no receipt
for a different attempt or revoked metadata access.

A reconcilable cancellation has to be the only call in its tool batch.
Root dispatch rechecks policy after the upstream identity read and commits
the authorized-operation record only if the call is still permitted. The
gateway fixture verifies that a mixed batch and a policy change during the
identity read both prevent cancellation. The late denial also leaves no
authorized-operation record for recovery.

The recovery journal marks a guarded batch before it requests approval.
If it later stops without an authorized dispatch record, the same execution
can discard the undispatched batch and obtain fresh authorization. Once the
dispatch record exists, recovery requires an outcome receipt. Legacy
batches without either marker remain held. The GitHub gateway fixture
retries a late policy denial and verifies a new approval request while
the cancellation POST count stays unchanged.

Owner chat can inspect an exact recovery execution with `operator_runs
inspect`, `kind: owner_chat`, and the execution UUID. The response reports
checkpoint and pending batch numbers and distinguishes fresh dispatch
authorization, a retryable read, and an unresolved external outcome. The
owner gateway fixture verifies that another session cannot reopen the
status and that the projection contains neither operation arguments nor
approval rule IDs.


Authenticated owner chat can also inspect recovery status for exact
delegated and scheduled runs through `operator_runs inspect`. The gateway
fixture reconnects, reads the shared checkpoint status for both roles,
and exercises wrong-role and policy denials. The response retains
metadata only.
