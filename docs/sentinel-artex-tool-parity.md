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
| `get_worker_output`, `get_worker_trace`, `search_all_worker_traces`             | Coordinator and planner use output and trace tools. Workers have exact trace and cross-worker search.                                                                                                                                      | Model-callable `sentinel_worker_observation` reopens a committed observation. `sentinel_worker_trace_search` searches saved review traces in the permitted scope. Coverage is structured Sentinel observations and bounded review traces. [Agent fixture](../tests/sentinel/agent_test.ts), [shared observation fixture](../tests/sentinel/intermediate_workflow_gateway_test.ts).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
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
| `get_finding_traffic`, `bind_finding_traffic` | Finding traffic reads have broader role bindings. The default binding writer is the reporter.                     | `sentinel_finding_traffic_links` lists attachments for the selected revision, narrowed to the assigned asset for leased workers. `sentinel_attach_finding_traffic` is leased-worker only. It requires an authorized exact receipt read in the current turn and checks the finding or recheck, assignment, evidence revision, and report version. Tidepool and CLI provenance exports retain the exact revision links. [Authenticated gateway workflow](../tests/gateway/sentinel_finding_traffic_test.ts), [journal and revision export tests](../tests/sentinel/finding_traffic_links_test.ts). |

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
