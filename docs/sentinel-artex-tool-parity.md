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
| `list_goals`, `set_goals`, `prove_goal`, `goal_met`, `TodoWrite`                | Planner can inspect goals and submit proof. Coordinator and the isolated goal runner can set goals and constraints. The catalog defaults `goal_met` to unbound. The SDK todo store is configured separately for planner and session roles. | Model-callable `sentinel_goal_state` reads formal goal state. Operators approve start/append via chat, and the completion adapter evaluates criteria against saved evidence. Tidepool shows the adaptive queue. There is no generic model mutation of goal definitions or a freeform todo store. [Formal goal fixture](../tests/gateway/sentinel_formal_goal_test.ts), [completion fixture](../tests/sentinel/goal_completion_adapter_test.ts), [workspace fixture](../tests/sentinel/tidepool_workspace_test.ts).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
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
| `traffic_blob`                                | Returns retained transaction data where the source captured it.                                                   | Current ingestion retains structured metadata. The exact receipt reader therefore covers that metadata, with no raw transaction bodies, headers, or packet payloads available to page. [Receipt retention tests](../tests/sentinel/traffic_receipts_test.ts).                                                                                                                                                                                                                                                                                                                                    |
| `get_finding_traffic`, `bind_finding_traffic` | Finding traffic reads have broader role bindings. The default binding writer is the reporter.                     | `sentinel_finding_traffic_links` lists attachments for the selected revision, narrowed to the assigned asset for leased workers. `sentinel_attach_finding_traffic` is the leased-worker path. Authenticated operators can use `operator_runs finding_traffic_candidates` and `attach_finding_traffic` with explicit confirmation. It requires an authorized exact receipt read in the current turn and checks the finding or recheck, assignment, evidence revision, and report version. Tidepool and CLI provenance exports retain the exact revision links. [Authenticated gateway workflow](../tests/gateway/sentinel_finding_traffic_test.ts), [journal and revision export tests](../tests/sentinel/finding_traffic_links_test.ts). |

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
artifacts. Additional agent types still need run-specific capture and restore
integrations.

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
and the planner receives the exact receipt ID, original finding ID, and
outcome. The [findings fixture](../tests/gateway/sentinel_worker_findings_test.ts)
drives the coordinator through an initial round, a duplicate worker
submission, and one new round that cites the receipt for operator confirmation.

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
resumed model receives the saved result without those fields. Durable
checkpointing for other approved Sentinel worker exchanges remains open.

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
Checkpoints still cover these two approved tool types. Recovery after an
interrupted state-changing tool remains open.

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
saved result when response policy changes before restart. A completed peer task
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
or a bounded set of alternatives. The gateway reruns the read against the
assigned revision after root policy checks and accepts replay only when the
projection is byte-identical. The restart fixture checks both forms across a
change elsewhere in the case graph.

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
