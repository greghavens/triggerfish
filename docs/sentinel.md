# Sentinel

Type `/sentinel` inside terminal chat or the native Tidepool chat window to
switch modes. Switching clears the normal owner chat context and starts with a
fresh Sentinel context. Type `/sentinel` again to return to a fresh normal
context. `/sentinel status` shows the current mode. The mode is scoped to the
authenticated chat connection and resets on reconnect.
If the gateway uses a custom `TRIGGERFISH_DATA_DIR`, launch the native client
with the same value so it can read the gateway's Tidepool session key.

Set `sentinel.notify_incident_increases: true` in `triggerfish.yaml` and restart
the gateway to receive notifications when a refresh increases the incident
candidate count for an active case. A case can inherit this setting, mute its
notifications, or explicitly enable them within the gateway setting. Tidepool
shows the revision and latest delivery outcome. A queued update remains in
the notification service across gateway restarts. Authenticated Tidepool
reconnects retry eligible Sentinel updates through Tidepool and record the
result against the saved revision. Concurrent reconnects share the same
pending entry. The message uses INTERNAL classification and contains only a generic
description of the change. The coordinator submits a claimed revision at most once across restarts.

Sentinel's knowledge graph connects assets, findings, controls, and evidence.
The gateway uses an operator-published snapshot from its own data directory.
Publish a snapshot from the gateway host as the gateway OS user.

```sh
triggerfish sentinel publish --input=sentinel.json
triggerfish sentinel publish-alerts --input=alerts.jsonl
```

Inside Sentinel chat, `report`, `coverage`, `impact NODE [DEPTH]`, and
`trace NODE [DEPTH]` run directly against the snapshot. Put node IDs containing
spaces in double quotes. For natural-language analysis and subagents, enable
model access in `triggerfish.yaml` and restart the gateway.

```yaml
sentinel:
  allow_model_access: true
  output_language: es
  model_worker_limit: 2
```

`output_language` sets the language requested for model-generated chat replies
and review summaries. It defaults to English (`en`) and also accepts Spanish
(`es`), Korean (`ko`), Simplified Chinese (`zh`), and Japanese (`ja`).
Tidepool’s `Case model output language` overrides that default for a case.
Changes take effect on the next model turn and apply to case chat, planning,
and reviews. Deterministic `assessment` chat commands use the same language
for acknowledgments and headings. The slash commands, command help, and graph
query errors also use the selected language. Structured responses retain their JSON
fields and recorded evidence.
`model_worker_limit` caps concurrent background model calls across all
Sentinel cases, including planning and reviews. It defaults to 2. Interactive
Sentinel chat uses the gateway's chat execution limits.
Set `planner_heartbeat_seconds` to an integer from 600 through 86400 to
enable idle planner rounds for active assessments when model access is
enabled. After a planning round settles, the planner checks the same case
and evidence again at the next interval if no new input has triggered a
round. The saved round history preserves the interval across gateway
restarts. Paused, stopped, and completed assessments skip idle rounds.
When starting a linked Sentinel run with `operator_runs spawn`, pass
`plannerHeartbeatSeconds` to approve an interval for that run only. Omitting
it uses the gateway setting.
Pass `childGoal` to review and set the linked assessment's initial
objective. The planner uses that objective on its first round. Retrying
the same request requires the original objective, including its omission
if the first request did not set one.
Pass a `seedTask` with `kind` set to `trace` or `impact` and `nodeId`
set to an asset in the published child graph to run a depth-one investigation
before model planning. The approval includes the exact task, and retrying
the same linked start reuses the saved assignment.
To make an existing provider selectable for linked assessments, list its
name in `sentinel.model_profile_allowlists.INTERNAL` (for example,
`INTERNAL: [ollama]`). The owner tool lists permitted choices with
`operator_runs profiles`. Pass the provider name as `modelProfile` when
requesting a linked Sentinel run. Omit it to inherit the exact parent
selection, or use the standard classification route when the parent had
no explicit selection. Sentinel planner and worker turns use the approved
selection while its provider, model, and current grant still match.
For an explicitly selected or inherited primary route, pass up to three
approved provider names in `fallbackModelProfiles` in the order to try.
Sentinel advances the saved route after an availability failure before
that model call returns a response. It reuses completed tool exchanges.
New child runs inherit the chain with the parent profile when both are
omitted. A revoked or changed profile prevents model dispatch.
Use `operator_runs model_route` to inspect the current route and prior
operator decisions. To replace it, use `set_model_route` with the exact case,
run, revision, current `expectedVersion`, and request ID. The approval shows
the full previous and replacement routes. Set `activeModelProfile` to begin
with a specific approved provider in the chain.
Use `set_model_role` to review a model for the `interactive`, `planner`,
or `worker` role. Omit `modelProfile` to remove that role's override.
An override uses its own approved provider. It does not advance the
case's shared fallback chain. `model_route` shows how each role resolves.
To direct the child's shared discovery reads, pass up to four
`sourceCases` entries with an existing `caseId` and exact saved `revision`.
The approval includes the resolved source run identities. The planner
and leased workers can reuse approved asset, alias, and relationship
discoveries from those revisions when they still match the local asset
and the source approval is current. Parent links and source selections
carry no authority to read another case's full graph.
When a child asks for published findings, the selection also bounds
operator-published findings backed by local or retained connector evidence.
A connector-backed finding is usable while the exact source receipt, current
connector access, and root policy verify the published conclusion. The
planner rechecks that authorization before recording a cited follow-up.
Withdrawal hides a finding from fresh reads while saved citations remain
inspectable.
An owner can submit a committed local relationship fact for discovery review
with `operator_runs propose_graph_fact_discovery`. Provide the original
`factId`, an exact supporting evidence `node` observed on both assets, and
a `requestId`. Approve the pending discovery in Tidepool before another case
can reuse it. The approval retains the fact and its original tool-step reference.
Sentinel workers use an allowlist of read-only evidence tools. This registry
excludes HTTP clients, shells, target connections, and credential tools.
Background workers read their assigned case and evidence revision. Shared
citations resolve through the exact authorized archive and its recorded digest.
Leased reviews can call `sentinel_assigned_target` to read the exact target and
its directly linked saved evidence. The tool takes no target arguments and
records the target ID and a digest of its response in the review trace.
A linked evidence record returned by this tool can prompt a scoped follow-up.
The task retains the evidence ID and the originating review as a prerequisite.
With model access enabled, the Tidepool task queue lets you set a lower limit
for the selected case or restore the gateway default. A changed limit applies
to new worker reservations. Running workers finish normally.
The Tidepool task queue shows provider-reported background calls and input
and output tokens for the case. Historical views show totals for the selected
revision. Counts are recorded for completed provider responses.
Interactive Sentinel chat has its own counters under the selected case,
including when an assessment has yet to start.

This setting lets the configured INTERNAL model provider receive graph and
telemetry evidence relevant to the query. Sentinel uses a dedicated read-only
tool set and separate agent history. It can launch bounded investigative
subagents. From normal chat, `/sentinel-agent QUESTION` starts one isolated
worker without switching modes. Containment changes are operator actions.
In Sentinel mode, use `/sentinel case CASE` to switch to an existing named
case or `/sentinel case main` to return to the main case. Switching clears
the chat context. Structured queries, model analysis, and delegated reviews
use the selected case. Background assessments continue independently.

Use `/btw QUESTION` in authenticated chat to ask a side question while the
main agent continues. Bare `/btw` shows that selection's side history, and
`/btw cancel` cancels the side question. In ordinary chat, use
`/btw --session ID QUESTION` to select an owner session registered with the
gateway, or `/btw --session current` to return to the current chat. In
Sentinel mode, use `/btw --worker REVISION TASK_ID QUESTION`. The worker
must belong to the selected case and current evidence revision. The side
answer uses saved assignment metadata and committed progress.

Use `assessment workers status` to get the current assignment revision,
task IDs, and saved review progress. From the same case, use
`assessment workers steer <JSON>` with `revision`, `taskId`,
`controlRequestId`, and `note`. The note reaches that worker's next model
step. Use `assessment workers stop <JSON>` with the same identity fields
and a fresh request ID to stop that assignment. Committed steps remain
inspectable. A stopped assignment stays stopped after a gateway restart.
An exact retry returns the original control receipt. Case hints remain a
separate way to guide future planning.

Open **Shared asset inventory** in Tidepool to search published assets across
cases by ID, alias, label, or case name. Records with the same ID or an
unambiguous shared alias are grouped. Each case keeps its own ID and label. Choose a source to open that case’s graph
at the asset.
Choose **Show shared relationships** to see incoming and outgoing asset links
from published snapshots. Repeated links are grouped by exact direction and
relationship type. Unique aliases connect assets with different IDs, and each
reporting case opens at its original asset ID. A case can contribute
relationships through a grouped asset ID even if its snapshot omits the alias.
**Sync relationships into this case** saves links reported by other cases when
both endpoints resolve to assets in the selected case. Sentinel records the
reporting cases as evidence in the assessment graph, including when the
relationship is already present, and leaves the published
inventory file intact. Repeat the action to refresh or withdraw links as
source inventories change.
Published asset records may include an `aliases` array of exact identifiers.
Case reports and provenance resolve alert asset IDs through a unique alias.
The original reported ID stays on the alert, and exact asset IDs take precedence.
Synchronization prefers the original ID and can match a different ID through
an alias when the match is unambiguous in both cases. The synchronized graph
keeps local IDs and records the reporting case and original endpoints as
searchable fields on the relationship evidence. Provenance search in Tidepool
and Sentinel chat matches source case IDs, endpoint IDs, and snapshot digests. Select an endpoint to open
the reporting case’s archived snapshot at that asset. Close the snapshot to
return to the evidence you were viewing. Older evidence without a snapshot
digest opens the live graph. **Audit source archives** checks current overlays,
published graphs and retained revisions for missing and unreferenced snapshots.
It also follows references inside archived snapshots and checks their digests.
Use **Quarantine snapshot** to move an unreferenced snapshot out of the active
archive. **Restore snapshot** moves it back. Quarantined snapshots remain
readable by their existing case and digest.
Enable **Automatically refresh case relationships** to check opted-in cases
once a minute. The last successful overlay is retained if a source cannot be
read. Turning automatic refresh off keeps the last synchronized relationships.
Sentinel agents can request the same links with `sentinel_shared_asset_links`
for an exact asset already present in their case. Results identify which
published cases reported each link and include their snapshot digests.
Saved worker queries retain the source digests returned by this lookup.
Operators can inspect them on the model-review provenance node or in the
Markdown report, and workers can search saved query traces by digest.
**Open source snapshot** opens the original reporting asset in the archived
graph or a current publication with the same digest.
Revision-pinned assessment workers archive the published graphs returned on a
relationship results page. The archive audit counts references in saved
worker queries, including adaptive model reviews.
For revision-pinned workers, this lookup identifies live shared inventory as
context and excludes the assigned case's current publication. Workers can use
the saved graph for relationships retained in the assigned revision.

Use **Case hints** in the Tidepool task queue to leave investigative context.
Hints are saved with the case and tagged with the evidence revision when one
exists. Workers can retrieve them with `sentinel_case_hints`, and the planner
sees recent hints when it runs. A new hint makes the case eligible for a
fresh round after the model planning cooldown. The round keeps the same
evidence revision, and planner history identifies the hint that triggered it.
A newer hint supersedes an in-flight plan before its proposals can enter the
queue. New model assignments retain their originating round, attempt, and hint
in the task queue and provenance graph. A new plan can reorder queued model
assignments. Operator priorities and prerequisite readiness take precedence.
The planner can recommend retiring an obsolete queued model assignment. Sentinel
holds the assignment for review when no active task depends on it. Use **Keep
and run next** to resume it or **Cancel queued investigation** to retire it.
The planner can also propose coordinated prerequisite changes across eligible
queued tasks. Review the full group in the queue and choose **Apply
prerequisites** or **Keep current prerequisites**. The complete dependency
graph is validated before changes are applied together. If the plan includes
new assignments, they appear in the same review and enter the queue only when
you choose **Apply plan changes**. Priority and retirement recommendations in
the same proposal also take effect on approval. Saving a newer case hint
supersedes pending proposals and releases their tasks for the next round.

```sh
triggerfish sentinel report --input=sentinel.json
triggerfish sentinel trace --input=sentinel.json --node=app --depth=2
```

Both commands emit JSON. The report orders findings by reported severity and
then by the number of directly affected assets. Control and evidence references
describe relationships supplied by the snapshot producer. A control reference
alone does not establish that a mitigation was deployed or verified.

A trace follows edges in both directions and reports the shortest hop distance
for each visited node and the original orientation of edges between visited
nodes. The default depth is 2. Depth 0 limits the trace to the starting node and
its self-edges.

## Coordinate an assessment

Open **Sentinel** in Tidepool's navigation. Choose a case, import a graph or
inventory, enter a goal, and start. The workspace shows task assignments, worker
activity, evidence and dependency links, and detected coverage gaps. Search the
provenance graph by node ID or label and follow its directed edges. Export
findings as CSV or the investigation as Markdown. In the findings table, combine
severity, affected asset, assigned task, and task status filters for the current
or archived revision. Select a finding to inspect it in the provenance graph.
Use the disposition column to review a finding and record a decision for the
current evidence revision. Decisions carry forward while the finding, its
direct relationships, and linked records are unchanged. Each decision keeps
its original revision. Revision comparisons and their Markdown downloads list
disposition changes for findings present in both revisions. They also show
incident candidates that appeared, disappeared, or changed disposition. CSV includes the current disposition for the
exported revision. Markdown and provenance JSON include up to five recent
decisions per finding. In the provenance graph, search by disposition or review
note and open the matching finding to read those decisions. Use **Browse
decision history** on a finding or incident to page through older decisions.
Export the full history for the selected revision with **Decision history
JSON** or `triggerfish sentinel assess-export --format=decisions --revision=N`.

Incident decisions record the operator's disposition, note, timestamp, and
original revision. Decisions carry forward while the candidate, its contributing
alerts, and its linked graph evidence stay unchanged. Older revisions can
also carry decisions forward when their saved alert feed reconstructs the same
incident and contributing alerts.
The live and archived provenance graphs link up to five recent decisions per
incident to the relevant candidate. Markdown and provenance JSON exports
include those decisions for the selected evidence revision.

While Sentinel mode is active, chat rejects normal-session controls such as
`/bumpers` and `/compact` and ignores stale normal-session prompt replies.
`/sentinel` exits the mode. The case coordinator runs independently.

In chat, `assessment start [GOAL]` starts the main case. Use
`assessment goal GOAL` to steer its planner, `assessment status` to inspect the
queue, `assessment observations` to see graph results, and `assessment pause`,
`assessment resume`, or `assessment stop` to control it. Returning to normal
chat, switching screens, and disconnecting leave the gateway's assessment
running.

```sh
triggerfish sentinel assess-start --goal='Review "app"' --asset=app --node=F-1 --evidence=E-1
triggerfish sentinel assess-status
triggerfish sentinel assess-export --format=markdown > assessment.md
triggerfish sentinel assess-start --case=cloud-review --goal="Review cloud findings"
triggerfish sentinel publish --case=cloud-review --input=cloud-graph.json
```

### Withdraw a published inventory host

In authenticated owner chat, use `operator_runs preview_inventory_withdrawal`
with a Sentinel case ID and exact hostname or IP. Use `withdraw_inventory_host`
with that preview digest and a fresh request UUID, then confirm the reviewed
change. Sentinel preserves the original graph under its source digest before
publishing the change. Ambiguous host identities and changed publications
require a new, exact preview.

### Export selected findings

The authenticated Tidepool Sentinel `export` route accepts up to 16 exact
`findingIds` with a case ID and a saved evidence `revision`. Set `format` to
`findings-json`, `csv`, `markdown`, or `md-zip`. The export includes only the selected
findings, their saved report versions, linked rechecks, and retained traffic
references from that revision. An unavailable ID rejects the whole selection.
Use `findingFilter` in place of `findingIds` to match an exact `assetId`,
the source `kind` (`imported` or `worker`), or a case-insensitive text
`query` on saved report titles and summaries. Filter findings by their
saved `severity` or analyst `disposition`, and worker findings by
`findingCategory`. An empty
filter selects every finding in the case at that revision. Larger reports can
use narrower filters, exact IDs, or paged results.

To export a larger selection, set `findingPageSize` to 1–16 and repeat the
same request with the returned `findingPage.nextCursor` until it is null.
Each page names its offset, count, complete selection total and manifest
digest. The cursor binds the case, saved revision, filter or selected IDs,
format and reviewed report inputs. If selected evidence or decisions change,
start a new export. Each page can carry up to 256 KiB of report content. In
Tidepool, the **Findings CSV**, **Findings JSON**, **Findings Markdown**, and
**Findings ZIP** actions can assemble these pages into a single download of up
to 8 MiB when the direct export reaches its byte limit. The
download aborts if the report selection changes before all pages arrive.

The `md-zip` response provides a base64 ZIP with one Markdown file per finding,
a suggested `filename`, and `contentType: application/zip`. Each file retains the
same reviewed report and exact evidence references as the Markdown export.
Under `evidence/`, the ZIP also includes a JSON manifest for each retained
attachment. It identifies the exact traffic receipt, current report version
and original attachment version, and records any withdrawal or amendment.
Traffic entries contain link metadata and exclude network payloads.

In authenticated owner chat, add `receiptId` and reviewed `note` to an
`operator_runs assign` trace for a saved worker finding on the selected
asset. The assignment keeps the original finding, report version and
evidence references. A paused case holds the assignment until resume.
For a completed assessment, use `completed_graph_followup` with the same
finding and note. It records a read-only review of the saved graph and
keeps the assessment completed. This review does not perform a new control
check.

An operator can add an optional `note` to the exact, approved recheck
assignment, or append it after the request ID in `/sentinel-recheck … queue`.
The same note is retained in the approval receipt and exposed to the
assigned worker when it opens the recheck context.

Use `operator_runs finding_recheck_attempts` with the exact case, evidence
revision, and original finding's `receiptId` to review recheck work.
`activeOnly: true` limits the view to pending and running work in the
current assessment. The page reports worker state and its last recorded
settlement separately from the verdict. A failed or interrupted attempt
does not establish a verdict. If the page becomes stale, start again
without its cursor.

An exact leased recheck can record a separate inconclusive rationale when
it cannot establish a verified result. The attempt exposes the
`inconclusiveReceiptId`, which the owner can reopen with `finding_receipt`.
The rationale stays available after archive restore. It does not produce
a pass or fail, satisfy evidence requirements, or change the finding.

The worker finding report shows a separate remediation status as of the selected
evidence revision. A verified result identifies its exact recheck and evidence.
Missing, expired, or inaccessible evidence yields `unknown`. The owner report
reauthorizes retained connector sources before returning their status. Static
exports use `unknown` for connector-backed status because they cannot repeat
those checks. The analyst disposition stays independent of this status.

In authenticated owner chat, use `operator_runs finding_groups` with
`scopes` containing one to four exact case IDs and saved revisions. Each
group reports its count of imported and worker findings and has an independent
`offset` and `nextOffset`. The optional `limit` sets the page size per group.
For up to sixteen selected `findingIds`, use `operator_runs finding_asset_tree`
with `kind: sentinel`, the case `id`, and a saved `revision`. It shows the
affected assets and their declared in-scope ancestors. Aggregate counts count
each finding once per asset, even when it affects multiple descendants.

An authenticated owner can use `operator_runs amend_finding_report` with
`severity`, `findingCategory`, or `disposition`, the current
`reportVersion`, and the exact saved attachment `evidenceVersion` to
correct a worker finding in scope. A worker finding's disposition records
the analyst decision in the report without changing tasks or recheck receipts.
Use an empty category string to clear the label. Each approved correction
appends a report version while earlier versions keep their original
metadata and evidence.

Use `operator_runs attach_finding_traffic_batch` to attach two to four
already retained traffic references in one reviewed operation. Each reference
must match the finding's case, asset and evidence revision. The batch commits
all links together. Repeating a reference preserves the existing link and
its note.

Use `operator_runs annotate_finding_traffic` to review a role or note
correction on an existing retained traffic link. Provide the exact finding,
link, report version, and current `evidenceVersion` from `finding_traffic`.
Each amendment has its own receipt and changes the evidence version.
Authorized reads and saved finding exports show the amendment history
and the original attachment.

`operator_runs reorder_finding_traffic` takes a full permutation of the
current `trafficLinkIds`, up to the case journal's 4,096-link limit.
If a model cannot send the full list, use `moveTrafficLinkId` and optionally
`beforeTrafficLinkId` to move one exact link and save the resulting full
order. Omit `beforeTrafficLinkId` to move the link to the end. Large
requests show the count and order digest for approval. Use
`finding_traffic_set_receipt` with the saved receipt ID to page the exact
ordered IDs, even after later edits. New links append to the reviewed
order. `withdraw_finding_traffic` takes one exact `trafficLinkId`. Both require confirmation and the exact current report
and evidence versions. A withdrawal removes the link from active reads. An
owner can reopen its original metadata and withdrawal receipt with
`finding_traffic` and `includeWithdrawn: true`. Saved exports retain
withdrawn references and the ordered change history.

### Archive and restore a named assessment

The authenticated owner agent can use `operator_runs` to archive a stopped
named case. Inspect the case to get its case ID, run UUID, and evidence
revision. Request `archive` with those values and a fresh request UUID, then
confirm the operation. The receipt's archive ID identifies the saved package.
Archiving leaves the original case in place.

Use `restore` with the original case ID, run UUID, revision, archive ID, and a
new request UUID. Restore verifies the exact package, requires the original
named case path to be absent, and publishes stopped cases in a paused state.
Inspect the evidence and pending tasks before resuming. `archive_history` shows
recorded actions for the exact run and revision.

When starting a published linked Sentinel case through `operator_runs spawn`,
the operator can approve a wall-clock limit through `timeoutSeconds`. The limit
ranges from one second to seven days. Pause, restart, and duplicate requests
preserve the saved deadline. At expiry Sentinel stops background work and
reviews the committed completion record once. An automatic goal decision
committed by the deadline can complete the assessment if its exact evidence
still verifies. Cases without that proof retain their committed evidence under
`timed_out`. Timed-out cases can be archived and restored for inspection with
their terminal status.

The archive retains committed case records and evidence references. Credential
stores, pending approvals, live leases, and resumable tool spools stay outside
the restored run. Workspace-level source references still use their original
workspace stores. The default `main` case uses a different storage layout and
is outside this restore path.

The default case is `main`. Named cases keep their own graph, alert stream,
lifecycle, worker queue, and history. Use `--case=ID` with assessment commands,
`publish`, `publish-alerts`, and `detect --publish`. The gateway runs up to 12
active named coordinators alongside the main case. The operator workspace can
list retained cases and review worker events across evidence revisions.

Set `sentinel.assessment_concurrency` from 1 to 12 to use FIFO admission for
named assessment coordinators. The queue uses the saved start or resume
order and retains that order across gateway restart. Pausing a named case
releases its slot. Resuming it joins the end of the queue. The main case and
per-worker limits remain independent. Starting or refreshing a queued case can
save its inputs. Adaptive planning and execution wait for its coordinator slot.
Without this setting, the gateway uses its existing 12-slot rotation for named
cases.

In owner chat, use `operator_runs` with `assessment_concurrency` to read the
current limit and its version. `set_assessment_concurrency` accepts a limit,
the expected version, and a request ID. `reset_assessment_concurrency` uses
the same version and request ID fields and restores the configured limit.
Both changes require operator confirmation and survive restart. When the
limit goes down, excess named cases keep their place and finish in-flight
work before releasing their slots.

Resolved and dismissed findings and incidents do not generate new automatic
review assignments or follow-ups. Explicit operator assignments remain
available. Existing automatic reviews stay queued under **Held by analyst
decision** until the subject is reopened. **Assign held review** assigns the
existing task explicitly and preserves the recorded disposition. The queue
and provenance graph link held tasks to the decision and its original revision. Reopening also makes the subject
eligible for new planning. A saved decision makes a fresh model planning
round eligible in the same evidence revision, subject to the existing worker
limit and planning cooldown. Saved decisions also supersede pending plan
proposals from earlier rounds and record the change in worker history.
Planning history and Markdown comparisons
include the case hint and decision IDs captured when each round began. Select
a reference in Tidepool to see the original text and open its evidence revision
when it is still retained.

The planner creates targeted work when evidence changes. Incident reviews
prioritize candidates by their highest contributing alert severity, then by
most recent contributing alert. Tidepool shows the candidate severity and can
page through all reconstructed candidates in a retained alert feed. Analysts
can record a disposition for any verified candidate in the current revision.
Explicit worker assignments also support candidates outside the sample. The
automatic planner uses the bounded sample. Provenance also includes up to 25
outside-sample candidates explicitly assigned to workers, with their evidence
links. **Inspect incident in graph** opens any verified saved candidate in its
retained evidence revision. **Incidents JSON** exports every verified candidate
with its latest disposition and contributing alert references. The CLI
equivalent is `sentinel assess-export --format=incidents --revision=N`.
A previously assigned incident review can reopen when a contributing alert
changes, even when the incident identifier stays the same. For example, a finding
can produce a review assignment, whose result can then produce separate asset
tracing, linked evidence review, and mitigation coverage tasks. Each assignment
records its reason, prerequisites, worker attempts, and structured result. The
provenance graph links goals, tasks, worker observations, and imported evidence.
A selected `--evidence` node must have a supporting-evidence link before the
case evidence task can run.

Publishing new evidence re-evaluates a running case. Tidepool flags changed
published inputs in paused cases. Open or refresh **Case overview** to check
paused cases without switching to them. Sentinel chat exposes the same state as
`pendingInputs` in `assessment status`. Resuming evaluates those inputs before workers
continue. If the inputs cannot be evaluated, the case stays paused. The gateway also checks
every five seconds, and invalid updates leave the last valid revision available.
The assessment history retains 20 evidence revisions. Incident candidates
require distinct signal classes with independent evidence IDs for the same
asset within a bounded time window. A unique graph alias can link signals
from different collectors while preserving their reported asset IDs. In
Tidepool, **Incident candidates** lists the contributing signals and opens
the candidate’s graph links to its asset, findings, and sampled alerts. **Browse
contributing alerts** pages through the saved alert membership for that
candidate. Open or assign an incident investigation from the live candidate
panel. **Save incident review** records an operator disposition and note against
the current evidence revision. Reopening a retained revision shows its recent
decisions. With model reviews enabled, completed incident investigations can
receive a model review even when they were assigned by an operator or the
deterministic planner. The provenance graph links the candidate to its
review task and links model review evidence back to the candidate. Workers can page the same saved membership using
`sentinel_incident_alerts`. Older revisions can use the saved feed to
reconstruct membership.

With model access enabled, cases can ask a planner to propose a bounded set of
new assignments and dependencies from its goal and graph. Only supported
analyses against exact known record IDs enter the queue. Fresh read-only
subagents can review machine observations, and their notes stay tied to the
revision they reviewed. The main case and named cases use the configured
model worker pool for planning and background reviews.

Worker activity shows the tool, graph target when available, and outcome of
queries run during completed background and adaptive reviews. These records are
searchable in the workspace, including recent adaptive reviews from prior
evidence revisions.

## Snapshot format

Provide version 1 JSON from inventory, vulnerability management, or incident
records. Node IDs must be unique. Finding severities are `critical`, `high`,
`medium`, `low`, and `info`.

```json
{
  "version": 1,
  "nodes": [
    { "id": "app", "kind": "asset", "label": "Application" },
    { "id": "db", "kind": "asset", "label": "Database" },
    {
      "id": "F-1",
      "kind": "finding",
      "label": "Missing update",
      "severity": "high"
    },
    { "id": "C-1", "kind": "control", "label": "Apply update" },
    { "id": "E-1", "kind": "evidence", "label": "Inventory record 42" }
  ],
  "edges": [
    { "from": "app", "to": "db", "relation": "depends_on" },
    { "from": "F-1", "to": "app", "relation": "affects" },
    { "from": "C-1", "to": "F-1", "relation": "mitigates" },
    { "from": "E-1", "to": "F-1", "relation": "supports" }
  ]
}
```

## Monitor for changes

```sh
triggerfish sentinel compare --baseline=previous.json --input=current.json
triggerfish sentinel watch --input=current.json --interval=5
```

Use `compare` for a one-time check. To monitor continuously, start `watch` with
a valid snapshot and have your security tooling publish updates to the same
path. Publish each complete snapshot by atomically replacing the file. Use
stable node IDs and include all findings and their relationships in each
snapshot.

Sentinel alerts on new findings, increases in reported severity, newly affected
assets, and removed mitigation links. A removed link signals a change in the
imported data and warrants reviewing the underlying control. `watch` emits one
JSON alert per line to stdout and status messages to stderr. After a missing or
invalid file, it compares the next valid snapshot with the last valid one. On
restart it uses the current file as the initial baseline. Use `compare` with a
retained baseline to review changes that occurred while it was stopped.

## Coverage and dependency impact

```sh
triggerfish sentinel coverage --input=sentinel.json
triggerfish sentinel impact --input=sentinel.json --node=db --depth=3
```

Coverage reports findings without control or evidence links. Impact follows
reverse asset dependencies so a database investigation can identify its
dependent applications, their minimum dependency distances, and their findings.

### Record an assessed goal as complete

Use **Record goal completion** in Tidepool to save an operator note against
the current goal and evidence revision. If the goal or published evidence
changes before confirmation, refresh and review the updated case before
recording completion. A completed case stops scheduling work. Start a new
assessment in the same case to continue investigating under a new goal.
The completed revision retains its note in history, Markdown, and provenance
JSON.

```sh
triggerfish sentinel assess-complete --revision=4 \
  --goal="Review payment service controls" --note="Verified the controls in this revision."
```

Omit `--goal` only for an assessment with no explicit goal.

Register evidence criteria for the current assessment revision to let the
planner report progress against them. Choose `graph_evidence` with an exact
node ID or `adaptive_task` with an exact task ID. A task must have committed
its observation in the registered revision.

```sh
triggerfish sentinel assess-goal-register --policy=operator \
  --criteria='[{"id":"payment-controls","description":"Review control evidence","source":"graph_evidence","reference":"evidence:payment-controls"}]'
triggerfish sentinel assess-goal-state
```

The assessment remains open until all registered criteria have verified
citations. Operator policy waits for confirmation through Tidepool or
`assess-complete`. For a registered goal, review the saved criteria and
citations in `assess-goal-state`, then pass `goalCompletion.caseEvidence.runId`
and `proofDigest` from that response.

```sh
triggerfish sentinel assess-complete --revision=4 \
  --goal="Review payment service controls" --note="Verified the saved evidence." \
  --run-id="$reviewed_run_id" --proof-digest="$reviewed_proof_digest"
```

Automatic policy can close the case when the planner
reports the last required proof. Renew registration for the current
revision if the evidence revision changes.

### Approve and amend formal goals in chat

In Sentinel mode, enter `assessment goals propose <objective>` and put the
case description on subsequent lines. The command also accepts a JSON object
with `objective` and `description`. Sentinel returns a draft of verifiable
goals and any explicit operating restrictions for review. Edit any goal,
criterion, or initial restriction before approval.

Use `assessment goals start <JSON>` with a unique `requestId`, the
`objective`, and the approved `goals` array. Each goal has an `id`, `title`,
`policy`, and `criteria`. Criteria have an `id`, `description`, `source`,
and exact evidence `reference`. The planner reads the approved definitions
from the saved revision. Include the reviewed `initialConstraints` object
to start with version 1 of the case operating policy. Its `deniedKinds`
and optional `allowedAssetIds` use existing task kinds and exact published
assets. The goals and initial restrictions commit together before planning.
The active set awaits confirmation if any of its goals uses operator policy.

To extend an existing assessment, use `assessment goals add <JSON>` with a
fresh `requestId` and a `goal` object. This operator action resumes a paused
assessment or reopens a completed one at a new revision. Previously completed
goals and their proofs remain available. An exact request retry returns its
original applied revision. Use `assessment goals status` to inspect current
goals or `assessment goals evidence <revision>` for a saved proof.

## Detect activity from a telemetry feed

```sh
triggerfish sentinel detect --input=events.jsonl
your-event-exporter | triggerfish sentinel detect --input=-
```

Send one UTF-8 JSON object per line with `version` set to 1. Supply an event ID,
UTC timestamp, asset ID, event kind, and subject. Use the account as the subject
for authentication events and use the destination or policy label for denied
egress. For an integrity change, use the changed resource.

```json
{
  "version": 1,
  "id": "auth-1",
  "timestamp": "2026-11-24T17:00:00Z",
  "asset": "app",
  "kind": "auth_failure",
  "subject": "svc-backup"
}
```

Sentinel detects repeated authentication failures, a successful authentication
after a failure burst, repeated authorization denials, and repeated egress
denials. It also relays integrity changes and selected alerts already raised by
trusted upstream endpoint, network, IAM, DLP, or cloud sensors with their
evidence IDs. Alerts are JSON Lines on stdout. Invalid records and lines over 64
KiB go to stderr. Correlation uses chronological input per asset and subject,
keeps bounded state, and resets on restart.

The built-in detector uses these normalized fields. The exported Sigma pack uses
the same event families, group keys, thresholds, and nominal windows. Verify
correlation timing, ordering, and suppression in the deployed Sigma backend.

| Signal                                | Required telemetry                                                                            | Replay evidence and visibility limits                                                                                                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication failure burst          | Five `auth_failure` records within five minutes for the same asset and account.               | OpenSSH RFC5424 and CloudTrail ConsoleLogin fixtures reach the threshold. Duplicate events and unrelated accounts cannot fill a group. Sources that omit login outcomes or account identity leave gaps.         |
| Authentication success after failures | An `auth_success` record within five minutes of five failures for the same asset and account. | OpenSSH and CloudTrail fixtures raise the ordered alert. A different asset or account, or an expired failure, does not complete the sequence. A success without preceding failures does not raise this signal.  |
| Authorization denial burst            | Five `authorization_denied` records within one minute for the same asset and subject.         | A CloudTrail fixture correlates API denials for one account and principal. A successful call or denial in another account does not fill the group. Denials alone do not establish that an operation succeeded.  |
| Egress denial burst                   | Five `egress_denied` records within one minute for the same asset and subject.                | An ECS fixture correlates denied outbound traffic from a source IP to a destination IP. Allowed traffic, inbound denials, and distinct destinations do not fill the group. This signal records blocked traffic. |

Upstream alerts use the reporting sensor's rules. Import, severity preservation,
and case correlation can be replayed locally. Endpoint, network, or audit
coverage depends on the sensor rules and fields configured in the deployment.

The JSON from `sentinel defense` also lists exact upstream checks under
`upstreamChecks`. Replays verify CloudTrail logging stops, audit configuration
changes, and IAM policy changes, Kubernetes RBAC binding changes, Windows Security log clears and audit-policy removals, Windows Exploit
Protection blocks, Defender Network Protection, Attack Surface Reduction, and
Controlled Folder Access blocks, Defender malware detections, remediation
failures, real-time protection disablement, Windows privileged-group grants, Entra directory
role grants, Entra service principal credential addition and removal, Entra
application certificate or secret management changes, and Zeek SSH guessing
notices.
[Microsoft documents Security event 1102](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/auditing/event-1102)
as the Security audit log clear signal. Winlogbeat records normalized before the
exact action was added need replay from their original source to appear in this
check. Each check
requires the expected alert type and exact triggering action. The output
includes the matching asset and evidence IDs. Related alerts still appear in
broader coverage categories.

Tidepool shows total matches and a bounded sample for saved assessments that
contain upstream coverage results. Select a sample to open the exact alert
in its saved revision. Choose **Browse all matching alerts** to search and page
through the full retained set for that check.

Case-bound workers can use `sentinel_defense` with an `upstreamCheck` ID.
Results include a bounded page of matching evidence, stable alert references,
and a `nextOffset` when more matches exist. Workers read the alert feed for
their assigned case and revision. The planner receives the IDs and counts of
matching checks from that revision and can query their exact evidence through
the same read-only tool.

| Format       | Supported records                                                                  | Schema                                                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jsonl`      | Sentinel version 1 records supplied by a trusted collector                         | This guide                                                                                                                                                                                                             |
| `syslog`     | RFC 5424 messages with Sentinel JSON bodies or native OpenSSH authentication outcomes         | [RFC 5424](https://www.rfc-editor.org/rfc/rfc5424.html)                                                                                                                                                                |
| `suricata`   | EVE IDS alert records. Destination IP identifies the asset                         | [Suricata EVE](https://docs.suricata.io/en/latest/output/eve/eve-json-format.html)                                                                                                                                     |
| `zeek`       | JSON notices with an identified responder. Ordinary connection records are ignored | [Zeek Notice Framework](https://docs.zeek.org/en/lts/scripts/base/frameworks/notice/main.zeek.html)                                                                                                                    |
| `falco` | Falco single-line runtime alerts. Uses the sensor hostname or an explicit `--source=ASSET_ID`. | [Falco JSON output](https://falco.org/docs/concepts/outputs/channels/#json-output) |
| `wazuh` | Manager `alerts.json` records with agent, manager, alert ID, and rule data. Uses the agent name or an explicit `--source=ASSET_ID`. | [Wazuh alert management](https://documentation.wazuh.com/current/user-manual/manager/alert-management.html) |
| `ecs`        | Elastic authentication outcomes, explicit outbound network denials, and IDS alerts | [Elastic ECS event categories](https://www.elastic.co/docs/reference/ecs/ecs-allowed-values-event-category)                                                                                                            |
| `journald`   | OpenSSH authentication outcomes in journal JSON                                    | [systemd journal fields](https://www.freedesktop.org/software/systemd/man/259/systemd.journal-fields.html) · [OpenSSH auth logging](https://github.com/openssh/openssh-portable/blob/master/auth.c)                    |
| `winlogbeat` | Windows Security logon outcomes, privileged group additions, audit-log clearing, and Defender alerts                      | [Microsoft security events](https://learn.microsoft.com/en-us/azure/sentinel/windows-security-event-id-reference) · [Winlogbeat fields](https://www.elastic.co/docs/reference/beats/winlogbeat/exported-fields-winlog) |
| `okta`       | System Log session-start outcomes. Requires `--source=TENANT_ASSET_ID`             | [Okta System Log event types](https://developer.okta.com/docs/reference/api/event-types/#usersessionstart)                                                                                                             |
| `entra` | Azure Monitor diagnostic records and Log Analytics JSON rows for interactive user, service principal, or managed identity sign-ins, plus completed directory-role grants | [Microsoft Entra sign-in logs](https://learn.microsoft.com/azure/azure-monitor/reference/tables/aadserviceprincipalsigninlogs) |
| `guardduty`  | Active GuardDuty EventBridge findings with a supported affected resource           | [AWS GuardDuty](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_findings_eventbridge.html)                                                                                                                   |
| `scc`        | Active Google Security Command Center findings, decoded or Pub/Sub-wrapped         | [Google Security Command Center](https://docs.cloud.google.com/security-command-center/docs/how-to-api-manage-notifications)                                                                                           |
| `ocsf`       | OCSF Detection Finding creates/updates with a target resource or device            | [OCSF Detection Finding](https://schema.ocsf.io/classes/detection_finding)                                                                                                                                             |
| `cloudtrail` | AWS CloudTrail version 1 events or `Records` envelopes for identified console sign-ins, access denials, IAM policy changes, and audit logging configuration changes. Requires `--source=ACCOUNT_ASSET_ID`. | [AWS CloudTrail event fields](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-event-reference-record-contents.html) |
| `kubernetes-audit` | Kubernetes API audit `Event` lines or webhook `EventList` batches for authentication failures, forbidden responses, and RBAC binding changes. Requires `--source=CLUSTER_ASSET_ID`. | [Kubernetes audit Event schema](https://kubernetes.io/docs/reference/config-api/apiserver-audit.v1/#event) |

```sh
triggerfish sentinel detect --format=suricata --input=eve.json
triggerfish sentinel detect --format=zeek --input=notice.log
triggerfish sentinel detect --format=falco --input=falco.jsonl
triggerfish sentinel normalize --format=wazuh --input=alerts.json
triggerfish sentinel normalize --format=winlogbeat --input=windows.jsonl
triggerfish sentinel normalize --format=okta --source=identity-prod --input=okta.jsonl
triggerfish sentinel detect --format=cef --selectors=selectors.json --input=cef.log
triggerfish sentinel detect --format=kubernetes-audit --source=cluster-prod --input=audit.log
triggerfish sentinel defense --alerts=alerts.jsonl
triggerfish sentinel case --input=sentinel.json --alerts=alerts.jsonl
```

The `winlogbeat` format accepts Microsoft Defender Antivirus Operational events
1116 (threat detected), 1118 and 1119 (remediation failures), and 5001 (real-time
protection disabled). Sentinel assigns high review priority. Forwarded events
use the originating computer as the asset. Normalized records omit file paths
and account names from Defender events.
[Microsoft Defender Antivirus event reference](https://learn.microsoft.com/en-us/defender-endpoint/troubleshoot-microsoft-defender-antivirus)

Windows Security event 4719 generates an integrity alert when the change
removes success or failure auditing. The alert identifies the affected audit
subcategory when Windows supplies its GUID. Additions to audit coverage are
ignored by this rule.
[Microsoft audit policy change event](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-10/security/threat-protection/auditing/event-4719)

Windows Filtering Platform event 5157 feeds the existing outbound-denial burst
detector. Sentinel accepts outbound blocks with valid destination IPs, groups
them by originating host and destination, and omits application paths. Collect
failure events for **Filtering Platform Connection** on hosts where you need
this visibility.
[Microsoft filtering platform connection audit events](https://learn.microsoft.com/en-us/windows/security/threat-protection/auditing/audit-filtering-platform-connection)

Windows Security group-addition events produce a privilege-grant alert for
built-in Administrators (4732), Domain Admins (4728), and universal Schema Admins
or Enterprise Admins (4756). The adapter matches group SIDs and retains the
originating computer and record ID. A grant can be authorized and still warrants
review. Routine additions to other groups do not generate an alert.
[Microsoft security group audit events](https://learn.microsoft.com/windows-server/identity/ad-ds/plan/security-best-practices/advanced-audit-policy-configuration)
[Microsoft security identifier reference](https://learn.microsoft.com/windows-server/identity/ad-ds/manage/understand-security-identifiers)

For organization-defined privileged groups, pass `--privileged-groups=groups.json`
to `normalize` or `detect` with `--format=winlogbeat`. The file is a JSON array
of up to 256 distinct canonical group SIDs, for example
`["S-1-5-21-1-2-3-2100"]`. Configured groups add to the built-in rules. Sentinel
reports the configured group SID and the source event reference.

The same adapter recognizes Windows Defender Operational blocks from Attack
Surface Reduction (1121), Controlled Folder Access (1123 and 1127), and
Network Protection (1126). Network Protection blocks appear as network security
alerts. Audit-mode events do not produce alerts.
[Microsoft Defender block and audit event IDs](https://learn.microsoft.com/en-us/defender-endpoint/attack-surface-reduction-windows-events)

Winlogbeat also accepts enforced exploit-protection events from the Windows
Security-Mitigations KernelMode and UserMode channels, including forwarded
copies. The event must match the Security-Mitigations provider. Sentinel assigns
high review priority and retains the originating host, block type, and event
reference. Audit events are skipped. The adapter also accepts Control Flow Guard
blocks from WER Diagnostics Operational (event 5) and untrusted-font blocks
from Win32k Operational (event 260), with matching provider validation. Win32k
records must explicitly report `Blocked: true` to qualify.
[Microsoft untrusted font event details](https://learn.microsoft.com/en-us/windows/security/operating-system-security/device-management/block-untrusted-fonts-in-enterprise)
[Microsoft exploit protection events](https://learn.microsoft.com/en-us/defender-endpoint/attack-surface-reduction-windows-events#view-exploit-protection-events)

The `falco` and `wazuh` formats accept either raw JSON lines or the same
JSON in an RFC 5424 or RFC 3164 message body. For RFC 3164, supply
`--syslog-clock`. Sentinel uses the sensor body's asset and
timestamp, or an explicit `--source` asset override.

Falco and Wazuh alerts carry normalized sensor severity. Falco maps
Emergency/Alert/Critical to critical, Error to high, Warning to medium, and
Notice/Informational/Debug to low. Wazuh maps levels 15–16 to critical, 12–14
to high, 5–11 to medium, and 0–4 to low. The original priority or rule level
remains in the alert action. In Tidepool, combine severity, asset, and type
filters with alert search. Sort by highest severity to triage a saved feed.
When the same sensor evidence is replayed, live publishing keeps the highest
severity observed. Use a complete alert-feed replacement for a downward
correction.
Suricata alerts retain their rule identifier as `suricata:GID:SID` in the
triggering action. Replaying a matching alert can add this identifier to an
existing live-feed record without duplicating it.
Zeek notices use the responder when present and the source for host-level
notices without a responder. Sentinel skips notices that identify neither
address. Notice types appear as `zeek:NOTICE_TYPE` in the triggering action.
[Zeek Notice Framework](https://docs.zeek.org/en/v8.2.0/frameworks/notice.html)

For a switch mirror or SPAN port, run Suricata or Zeek on the sensor and feed
its event output into Sentinel. For live syslog, terminate and authenticate
transport in your existing collector and pipe one record per line. OpenSSH
records use the header hostname as their asset, with an optional
`--source=ASSET_ID` override. Sentinel skips ordinary syslog messages outside
its supported event formats and reports malformed headers or JSON objects. Use
`normalize` to combine sources into a common event stream before `detect`. Use
asset IDs that match the graph for case correlation. Publishers should map
vendor-specific formats such as CEF or proprietary EDR output through their SIEM
or collector into Sentinel JSON.

For RFC 3164 archives, pass a known local year and UTC offset with
`--format=syslog`, `--format=cef`, `--format=falco`, or `--format=wazuh`.
For example, `--syslog-clock=2026@-07:00` interprets the archive in 2026 at a
fixed offset of UTC−07:00. Split archived files where the calendar year or
offset changes. For continuous collection across those boundaries, have the
collector emit RFC 5424 with complete timestamps.
[RFC 3164 timestamp format](https://www.rfc-editor.org/rfc/rfc3164.html#section-4.1.2)

For CEF, supply a JSON array of selectors with exact `vendor`, `product`,
`classId`, and `asset` strings. Add a `source` string to match a specific RFC
5424 hostname. This identifies which event classes your deployment treats as
alerts and which graph asset they refer to.

For a continuous feed, `detect --publish` puts a rolling window of up to 512
recent alerts into the gateway's assessment evidence file. Concurrent live
publishers merge alerts for the same case. Correlation windows are local to each
detector, so normalize upstream into a single chronological stream when you
need to correlate events across collectors. Use a SIEM or log archive for full
evidence retention. Standard output records detections. Sentinel pauses input
to publish a full batch when writes are healthy. If publication retries fill
the pending buffer, Sentinel reports the number of unpublished alerts dropped
as `alert_publish_overflow` on standard error.
When the saved feed reaches its 1 MiB limit, `alert_publish_size_limit`
reports how many alerts from the incoming batch did not fit.

```sh
your-event-exporter | triggerfish sentinel detect --input=- --publish
```

The normalized event kinds are `auth_failure`, `auth_success`,
`authorization_denied`, `egress_denied`, `integrity_change`,
`endpoint_execution_alert`, `network_security_alert`,
`unexpected_privilege_grant`, `unexpected_remote_access`,
`sensitive_egress_alert`, `cloud_security_alert`, and `security_sensor_alert`.
The cloud and generic sensor types carry Sentinel's review priority, while the
source system owns the finding severity.

### Collect Windows events centrally

Set up a source-initiated Windows Event Collector subscription for the computers
you want in scope. In **Select Events > XML**, use the query below to select the
Windows Security, Defender, and exploit protection events Sentinel accepts.
Set the subscription destination to `ForwardedEvents` and use the
`RenderedText` content format.
[Microsoft source-initiated subscription setup](https://learn.microsoft.com/en-us/windows/win32/wec/setting-up-a-source-initiated-subscription)

```xml
<QueryList>
  <Query Id="0">
    <Select Path="Security">*[System[(EventID=1102 or EventID=4624 or EventID=4625 or EventID=4719 or EventID=4728 or EventID=4732 or EventID=4756 or EventID=5157)]]</Select>
    <Select Path="Microsoft-Windows-Windows Defender/Operational">*[System[(EventID=1116 or EventID=1118 or EventID=1119 or EventID=1121 or EventID=1123 or EventID=1126 or EventID=1127 or EventID=5001)]]</Select>
    <Select Path="Microsoft-Windows-Security-Mitigations/KernelMode">*[System[(EventID=2 or EventID=4 or EventID=6 or EventID=8 or EventID=10 or EventID=12 or EventID=14 or EventID=16 or EventID=18 or EventID=20 or EventID=22 or EventID=24)]]</Select>
    <Select Path="Microsoft-Windows-Security-Mitigations/UserMode">*[System[(EventID=2 or EventID=4 or EventID=6 or EventID=8 or EventID=10 or EventID=12 or EventID=14 or EventID=16 or EventID=18 or EventID=20 or EventID=22 or EventID=24)]]</Select>
    <Select Path="Microsoft-Windows-WER-Diag/Operational">*[System[EventID=5]]</Select>
    <Select Path="Microsoft-Windows-Win32k/Operational">*[System[EventID=260]]</Select>
  </Query>
</QueryList>
```

On the collector, configure a Winlogbeat input for the forwarded log. Export
one complete JSON event per line. Preserve `@timestamp`, `winlog.computer_name`,
`winlog.event_id`, `winlog.record_id`, `winlog.provider_name`, `winlog.channel`,
and `winlog.event_data`. Sentinel uses the originating computer for graph
correlation, so include the hostname or an unambiguous hostname alias in the
case inventory.
[Elastic Winlogbeat forwarded-event configuration](https://www.elastic.co/docs/reference/beats/winlogbeat/configuration-winlogbeat-options#_event_logs_forwarded)

```yaml
winlogbeat.event_logs:
  - name: ForwardedEvents
    forwarded: true
```

Check a saved export before publishing it. Point a continuous exporter at
standard input when the feed is ready.

```sh
triggerfish sentinel normalize --format=winlogbeat --input=windows.jsonl
triggerfish sentinel detect --format=winlogbeat --input=windows.jsonl --publish --case=windows
```

## Assess defense coverage

`defense` reports available signals, observed evidence, and limitations across
reconnaissance, exploitation, credential abuse, lateral movement, privilege
escalation, persistence, exfiltration, and host indicators. Sentinel uses
behavioral signals and sensor findings. Visibility depends on which assets and
network segments are instrumented and which rules the sensors run. An alert
requires investigation and does not identify the tool or actor that caused it.

```sh
triggerfish sentinel indicators --rules=rules.json --input=observations.jsonl
```

Indicator catalogs use `{"version":1,"rules":[...]}`. Each rule specifies `id`,
`kind`, `field`, `value`, `source`, and `severity`, with optional `asset`.
Supported fields are DNS `query`, HTTP `host`, `path` and `userAgent`, and host
`processName` and `sha256`. Input records provide `version`, `id`, `timestamp`,
`asset`, `kind`, and a `fields` object. Matches preserve the rule's provenance
and source evidence ID without including the matched value.

### Export an ATT&CK coverage layer

Use `sentinel coverage-layer --mapping=mapping.json --alerts=alerts.jsonl` to
export a Navigator layer. The mapping is an array of
`{"techniqueID":"T1110","signal":"authentication_failure_burst"}` records.
Optionally specify `triggeringAction` to count only the exact upstream action
for that signal.
Sentinel validates the format and records the distinct observed signals for each
operator-selected technique. The layer does not claim attribution or verify
prevention.
[ATT&CK Navigator layer format](https://github.com/mitre-attack/attack-navigator/blob/master/layers/spec/v4.5/layerformat.md)

## Import analyzer reports

```sh
triggerfish sentinel import-sarif --source=my-project --input=results.sarif > findings.json
triggerfish sentinel merge --input=inventory.json --with=findings.json > combined.json
triggerfish sentinel publish --input=combined.json
```

Import an existing OSV-Scanner JSON report with
`triggerfish sentinel import-osv --source=PROJECT --input=scan.json` or select
**OSV-Scanner** in Tidepool’s inventory import. The importer connects versioned
packages to their project, links advisory findings to affected packages, and
preserves report-source evidence. It retains matching versioned PURL aliases
and can infer them from npm, PyPI, Cargo, Maven, and lowercase Go module
coordinates when the report omits them. It skips withdrawn advisories. Severity comes from recognized
advisory categories or numeric scanner group scores. Unrated findings are
informational. Explicit scanner groups merge equivalent advisory IDs within
the imported report, preserving affected package links and original IDs in
the supporting evidence.
[OSV-Scanner output formats](https://google.github.io/osv-scanner/output/)

The SARIF importer reads inline findings, artifact references, and evidence
locations as text. Use a stable source name and stable analyzer fingerprints for
cross-snapshot comparison. Merge rejects conflicting metadata for shared node
IDs.
[SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html)

## Import inventory, captured evidence, and indicators

Tidepool defaults to **Merge with current inventory** for imports. Identical
records are deduplicated and conflicting IDs reject the merge. Choose **Replace
current inventory** to replace the case graph. **Preview import** shows record
and relationship counts before and after the proposed import. Applying a
reviewed preview requires the current inventory to match the preview.

Tidepool imports a Sentinel graph, SARIF analyzer results, CycloneDX or SPDX SBOMs, or
HAR captures into the selected case. An import publishes a replacement snapshot
for that case. Use `merge` before publishing when you want to retain records
from multiple snapshots and resolve conflicts explicitly.

- SPDX 2.2 and 2.3 JSON and compact SPDX 3.0.0 and 3.0.1 JSON-LD import package inventory and declared dependencies
  between packages in the document. Versioned package URLs are retained as
  asset aliases. Shared inventory can correlate SPDX and CycloneDX packages
  with the same exact versioned package URL. In Tidepool, expand an asset and
  open its shared relationships to see reported findings, including matching
  OSV-Scanner advisories. Select a finding to inspect its published evidence
  without switching cases, or select the reporting case to open the affected asset. The CLI supports `sentinel import-spdx --input=bom.spdx.json --source=PROJECT`.
  [SPDX 2.x relationships](https://spdx.github.io/spdx-spec/v2.3/relationships-between-SPDX-elements/)
  [SPDX 3.0.1 JSON-LD example](https://github.com/spdx/spdx-spec/blob/develop/examples/jsonld/package_sbom.json)
- CycloneDX imports components, declared dependencies, and supported
  vulnerability assertions.
  [CycloneDX JSON](https://www.cyclonedx.org/docs/1.7/json/)
- HAR imports a sanitized origin, method, response status, and timestamp. It
  links capture evidence to its observed asset.
  [HAR 1.2](https://www.softwareishard.com/blog/har-12-spec/)
- MISP import creates exact indicator rules from eligible local exports. Linux
  `host-triage` checks current process names against those rules.
  [MISP core format](https://www.misp-standard.org/rfc/misp-standard-core.html)

```sh
triggerfish sentinel import-cyclonedx --source=app --input=bom.json > inventory.json
triggerfish sentinel import-har --source=app --input=capture.har > observations.json
triggerfish sentinel import-misp --source=intel --input=misp.json > rules.json
triggerfish sentinel host-triage --asset=app-host --rules=rules.json
```

For local TCP ports, supply a catalog rule with `kind: "host"`,
`field: "tcpListenPort"` and a decimal string value such as `"8443"`.
The Linux command reads the current network namespace’s IPv4 and IPv6
socket tables. It matches ports in the listening state, reports unavailable
or truncated tables, and returns evidence IDs. A port match establishes that
a listener was present. Process ownership and service identity require additional
evidence.

For database table indicators, add `kind: "host"` rules using `sqliteTable`
with an exact table name or `postgresTable` with an unquoted, lowercase
`schema.table` name. Supply the evidence explicitly:

```sh
triggerfish sentinel host-triage --asset=app-host --rules=rules.json \
  --sqlite-snapshot=offline.sqlite --postgres-tables=postgres-tables.json
```

Provide a standalone SQLite snapshot with no WAL or rollback journal. Sentinel
opens the snapshot read-only and checks table names in `sqlite_schema`. The
PostgreSQL file is an operator-supplied JSON array such as
`["audit.inventory","public.events"]`. The command matches the exported names
locally. The report contains match IDs and scan counts. A PostgreSQL match
describes the export at collection time.

A live local PostgreSQL check can collect table names visible to the operating
system user mapped to a PostgreSQL role. With `psql` installed, run:

```sh
triggerfish sentinel host-triage --asset=app-host --rules=rules.json \
  --postgres-local-db=audit --postgres-socket=/run/postgresql --postgres-port=5432
```

This option uses one Unix socket and a fixed read-only metadata query. It checks
unquoted, lowercase schema and table names. The client runs without startup
files or password prompts. Set up local authentication for the invoking user.
Choose either live collection or `--postgres-tables` for PostgreSQL evidence.
[PostgreSQL psql documentation](https://www.postgresql.org/docs/current/app-psql.html)

## Contain outbound web fetches

Run `triggerfish sentinel containments` as the gateway OS user to initialize the
policy database. Enable enforcement in `triggerfish.yaml` and restart the
gateway.

```yaml
web:
  domains:
    sentinel_containment: true
```

```sh
triggerfish sentinel contain --target=blocked.example --reason="IR-104" --ttl=3600
triggerfish sentinel decision --target=blocked.example
triggerfish sentinel containments
triggerfish sentinel audit
triggerfish sentinel release --target=blocked.example --reason="IR-104 closed"
```

The CLI and gateway use the same Triggerfish data directory. Give the gateway OS
user control of that directory. The gateway applies active blocks to the
URL hostname and the approved connection IP for each Triggerfish web fetch
and redirect.
Blocks apply immediately, expire automatically, and require an operator reason.
When containment is enabled, an unavailable policy database blocks web fetches.
Existing SSRF checks still apply. The policy covers Triggerfish web fetches.
Browser, shell, and other integrations are outside this enforcement scope.
In Tidepool, **Web containment** displays active gateway quarantines and
recent policy changes. Reading this panel does not initialize a missing policy.
Use **Quarantine destination** to set a hostname or IP, reason, and expiry.
Use **Release quarantine** to select a rule and confirm its release with a
reason. Both actions apply gateway-wide and are recorded in the same audit
history as CLI changes.

### Stream HTTP observations

A trusted collector can send one HAR 1.2 entry per JSON line through a file or
stdin. Sentinel emits sanitized observations as they arrive.

```sh
triggerfish sentinel traffic --input=- --source=web-audit --publish --case=cloud-review
```

Publishers for a case share a rolling window of 100 distinct
observations in a separate graph input. The case coordinator merges that input
with the operator inventory on its next refresh. The retained fields are origin,
method, response status, and optional timestamp. Keep archival traffic records
in the collector.

### Export deployable indicator rules

```sh
triggerfish sentinel export-rules --rules=rules.json --format=sigma > sentinel.yml
triggerfish sentinel export-rules --rules=rules.json --format=suricata --sid-start=9100000 > sentinel.rules
```

Sigma rules target flattened, normalized Sentinel indicator events and use the
`cased` modifier. Configure a backend that supports that modifier. Suricata
exports exact DNS query and HTTP User-Agent matches from `$HOME_NET`. It reports
skipped indicator IDs on stderr, including any asset-scoped indicator whose
scope cannot be expressed by this exporter. Reserve a free SID range for the
export and check it against the sensor's rule configuration before loading.
[Sigma modifiers](https://sigmahq.io/docs/basics/modifiers.html) ·
[Suricata DNS rules](https://docs.suricata.io/en/latest/rules/dns-keywords.html)
·
[Suricata HTTP rules](https://docs.suricata.io/en/latest/rules/http-keywords.html)

A passive DNS collector can publish observed address answers with
`traffic --format=dns --input=- --source=resolver --publish --case=cloud-review`.
Send records such as
`{"hostname":"example.test","addresses":["192.0.2.8"],"timestamp":"2026-01-01T00:00:00Z"}`.
The coordinator adds hostname and address assets, observed resolution
relationships, and timestamped evidence to the case graph. DNS publishers
for a case share a rolling window of 50 distinct observations, including
when the publishers restart. These links represent historical
answers from the collector.

To ingest Zeek JSON `dns.log` from a mirror-port sensor, run
`triggerfish sentinel traffic --format=zeek-dns --input=dns.log --source=mirror-sensor --publish --case=network`.
Sentinel adds passive resolution and observation edges for positive A and AAAA
replies. It retains up to 16 distinct addresses per reply. Rejected, truncated,
and unanswered queries produce no resolution evidence.
[Zeek DNS log schema](https://docs.zeek.org/en/current/reference/logs/dns.html)

Suricata EVE can publish passive DNS evidence with
`triggerfish sentinel traffic --format=suricata-dns --input=eve.json --source=suricata-mirror --publish --case=network`.
Enable detailed DNS answers in EVE. Sentinel accepts v2 and v3 DNS replies,
follows recorded CNAME links within each reply, and attaches only matching A or
AAAA records to the query. Grouped-only answers lack the record owner needed for
this association.
[Suricata EVE DNS format](https://docs.suricata.io/en/latest/output/eve/eve-json-format.html#event-type-dns)

Zeek JSON `http.log` can publish into the same case with
`triggerfish sentinel traffic --format=zeek-http --input=http.log --source=mirror-sensor --publish --case=network`.
Sentinel uses the recorded Host authority to derive an HTTP origin. It keeps
the method, status, and timestamp. It omits paths, query strings, headers,
credentials, and payloads. CONNECT requests are skipped because they identify
a tunnel target.
[Zeek HTTP log schema](https://docs.zeek.org/en/master/reference/logs/http.html)

To ingest standalone Suricata EVE HTTP events, use
`triggerfish sentinel traffic --format=suricata-http --input=eve.json --source=suricata-mirror --publish --case=network`.
The adapter uses the reported hostname and optional HTTP port. It preserves
separate transactions within a flow and applies the same metadata limits as
the Zeek HTTP adapter.
[Suricata EVE HTTP format](https://docs.suricata.io/en/latest/output/eve/eve-json-format.html#event-type-http)

When HTTP and DNS observations share a case, the coordinator links a captured
HTTP origin to an exact matching DNS hostname. Graph traversal can follow that
hostname to observed addresses and their evidence. An observed DNS answer
supplies context for the origin. It does not establish which address served a
particular HTTP response.

### Capture Triggerfish web fetches

Enable native capture for approved origins in the gateway configuration:

```yaml
sentinel:
  capture_origins:
    - https://example.test
```

Capture applies to successful direct `web_fetch` responses in owner turns that
can flow to INTERNAL. Sentinel records the origin, GET method, status and start
time in the main case. Native capture keeps a rolling window of up to 100
observations per gateway process. Redirected responses are outside the capture
scope. Captures become graph evidence when the case refreshes. To inspect an
exact capture, select its evidence ID in Tidepool’s graph. The record links
to the observed origin. The native feed contains no URL paths, query values,
credentials, headers, cookies, or bodies.
Configured capture runs on Triggerfish's normal web-fetch path. A Sentinel
worker sees a capture only after the capture has been saved in the worker's
assigned assessment revision.

### Approved live GitHub Actions evidence

An operator can bind a case asset to one GitHub Actions workflow. Add the
binding to the gateway configuration and restart it:

```yaml
sentinel:
  allow_model_access: true
  github_workflow_reads:
    - case: main
      asset: delivery
      owner: example
      repo: pipeline
      workflow_id: 17
```

A leased worker assigned to `delivery` can call
`sentinel_live_workflow_status` with an empty object. The gateway checks the
case, asset, live lease, configured repository and workflow, trusted
`PRE_TOOL_CALL` input, and Sentinel egress policy. It uses the GitHub
credential already configured for Triggerfish. Use a credential with Actions
read access to the approved repository. This connector supports
`https://api.github.com`. It uses a fixed read with no redirects, and saves
up to ten exact run IDs, statuses and conclusions with the source, revision,
timestamp and digest.

The saved receipt becomes a case provenance observation. A subsequent planner
round can cite the originating review when it proposes a scoped follow-up.
An integration fixture verified that a failed run prompted a new round and
that an unapproved scope did not reach the credential or transport.
The follow-up records the exact receipt digest and prerequisite. A leased
worker can reopen the committed receipt with `sentinel_saved_workflow_receipt`
without another GitHub request.

An eligible interrupted workflow review resumes from its last complete tool
exchange. A new lease must match the case revision, task, prompt and approved
workflow. The gateway checks the current destination policy before restoring
the saved result. Checkpoints expire after 24 hours and clear on completion
or an evidence revision change. The subprocess regression terminates a
gateway worker after persistence, restarts it, and counts one transport read
in the unchanged revision. The changed-revision regression begins fresh.

Export the built-in burst detections as a multi-document Sigma correlation pack:

```sh
triggerfish sentinel export-rules --builtin --format=sigma > sentinel-bursts.yml
```

The pack covers authentication failures, egress denials, authorization denials,
and a successful login following a failure burst. Supply normalized events from
`sentinel normalize`, map `timestamp` to event time, and deduplicate by asset
and event ID upstream. Convert the whole pack together with a Sigma backend that
supports event-count correlations. The thresholds, nominal windows, and group keys match Sentinel's detector. Alert suppression and window scheduling depend on the
backend.
[Sigma correlation specification](https://sigmahq.io/sigma-specification/specification/sigma-correlation-rules-specification.html)

To use Sentinel’s native timing and deduplication with a backend that cannot
reproduce its correlations, index the normalized JSONL alerts emitted by
`sentinel detect` and export the selectors for that stream:

```sh
triggerfish sentinel export-rules --builtin --format=sigma --source=alerts > sentinel-alerts.yml
```

pySigma 2.1.1 with the Splunk backend 3.0.1 converted these four selectors to
field searches. The same backend generated fixed time buckets for the event
pack and placed a nested aggregation inside the ordered search. The conversion
test confirms that the backend generated searches. A deployed search and
SIEM field routing require separate verification.
[Official pySigma Splunk backend](https://github.com/SigmaHQ/pySigma-backend-splunk)

An isolated OpenSearch 2.19.4 instance executed all four converted alert
selectors with pySigma 1.5.1 and its OpenSearch backend 2.0.3. Each selected
one distinct Sentinel alert and excluded the unrelated network alert. The
fixture indexed alerts separately, mapped `type` and `asset` as keywords,
and mapped `observedAt` as a date. The OpenSearch Lucene backend returned an
unsupported-correlation error for the event pack.
[Official pySigma OpenSearch backend](https://github.com/SigmaHQ/pySigma-backend-opensearch)

Export the upstream source-action selectors from the same definitions as
`sentinel defense`:

```sh
triggerfish sentinel export-rules --builtin --format=sigma --source=upstream-alerts > sentinel-upstream-alerts.yml
```

Index `triggeringAction` and `type` as keyword fields for exact matching.
The isolated OpenSearch fixture matched each expected alert and excluded
twelve lookalikes with the wrong type or action.

The Tidepool Sentinel workspace displays **Traffic evidence** for the selected
case. Filter by HTTP or DNS and search by observation or linked asset. Select
the observation or asset to open its node in the provenance graph.

The adaptive planner selects recent HTTP and DNS evidence attached to case
assets for review. A completed capture review can create dependent asset-tracing
assignments. When the case targets an exact graph node, traffic assignments stay
within that selected asset or evidence record.

To steer an active case, select an imported node in the provenance graph. Choose
an investigation in the **Task queue** and select **Queue investigation**.
Available investigations depend on the node type. A paused case retains
assignments in its queue until it resumes. An identical assignment in the same
revision resolves to its existing task.

When new evidence changes the result of a completed operator investigation,
Sentinel queues it against the new revision. Worker activity records why it
reopened and links to the prior investigation. An unrelated graph change leaves
the investigation closed and preserves its result for comparison with later
revisions.

When supporting evidence disappears from the graph and the investigation can
still run, Worker Activity links the removed record to the revision that
contained it. If a relevant relationship changes and the evidence record
remains, the activity links to the record in the current graph.
If the investigation's own target disappears, **Inspect prior target** opens it
in the graph from the earlier assignment.

Sentinel also reopens completed model-planned investigations when their evidence
changes. It revalidates the prerequisite chain against the current graph and
resolves prerequisites before the dependent investigation. Sentinel reuses a
completed result after checking that its analysis is unchanged and its
prerequisites are complete in the current revision. Worker activity links
carried assignments and reused results to their previous runs. Planner citations remain available in the evidence revision in which they were
verified. Reopened tasks keep their original round identity and point back to the
archived assignment. An exact upstream alert citation can also appear in the
new revision after reconciling its ID, check, and asset with that revision’s
saved feed. Removed alerts are recorded in task history. A planner can attach
additional exact alerts from one or more checks to a compatible queued or
completed model task. Each alert retains the ID of the check that matched it. Sentinel keeps earlier citations, ignores duplicate references,
and keeps the existing prerequisites.

Each completed model-planned assignment is eligible for its own isolated model
review. Worker Activity stores the review with that assignment and shows any
graph queries the reviewer used. Each review has a 30-second deadline and up to
two attempts. Claims persist across gateway restarts, and a worker whose claim
expires cannot save its result. Review retries run independently of the planner.
Reviews can propose up to two follow-up investigations on records already linked
to the assignment's observation. Sentinel validates each proposal, skips tasks
already in the queue, and links new tasks to the review in the provenance graph.

Failed investigations with attempts remaining expose **Retry investigation** in
the task queue. A retry stays in the current revision, records an operator
event, and keeps the original attempt history. In a paused case it waits for
resume.

Select **Run next** on a queued investigation to give it priority over other
ready tasks. A prioritized task still waits for its prerequisites and a paused
case still waits for resume. The priority action is recorded in worker activity
and consumed when a worker claims the task.

**Cancel queued investigation** cancels the selected task and any queued tasks
that depend on it. Cancellation is recorded in worker activity and survives
reactivation of the same evidence revision. A worker that has already claimed a
task finishes under its existing lease.

Use **Evidence revisions** to inspect a retained case snapshot. The graph,
traffic evidence, and saved assessment reviews reflect the selected revision.
The live case and its task queue continue running. CSV and Markdown exports use
the selected revision, and choosing **Live case** returns to current evidence.
Revisions with linked adaptive records also show the saved investigation tasks,
task transitions, worker notes, and their graph provenance. Markdown includes
those records. Older revisions retain the assessment data and reviews captured
before this linkage.

In a saved revision, choose **Compare with earlier revision** to see added,
removed, and changed imported records and added or removed relationships.

The comparison also shows before and after values for assessment observations
and for adaptive tasks when both revisions have a linked plan.
Use **Download comparison** to save the displayed changes as Markdown.
Worker timelines load 100 transitions per page. Choose **Load older transitions**
to extend either timeline. The comparison download fetches all remaining pages for both revisions.
Use **Download worker history** in a saved revision to export all its recorded
transitions, including pages you have yet to open.
Adaptive task changes include prerequisite changes. Prerequisites are matched by
task kind, target, and depth across revisions. Goal changes appear separately.
The live task queue links each investigation to its prerequisites and dependent
tasks, with their current states. Use **Prioritize when ready** for queued work
that still has prerequisites.
Use **Model review state** to find reviews that are running, awaiting a retry,
exhausted, or completed. **Retry model review** queues one additional attempt
for an exhausted review while keeping the completed investigation and its
attempt history. The retry uses the case's existing model worker limit.
Resolving or dismissing a finding or incident holds its automatic model
reviews. Sentinel cancels an in-flight automatic review when it observes the
decision and discards a late result. Explicit operator assignments can still
run without changing the recorded disposition.
Pending planning rounds get a turn before the coordinator drains the model
review queue. Reviews continue while the planner is on cooldown.
Use **Find tasks** to search by target, task name, worker, or reason. The **Task
state** filter can show ready work, blocked work, or tasks eligible for a retry.

An isolated high- or critical-severity alert on a known in-scope asset can
trigger an impact review of that asset's immediate dependents. Sentinel samples
the highest-priority alert per asset before taking additional alerts from the
same asset. The planner keeps up to six alert-driven impact reviews queued or
running and fills freed slots with the next eligible assets from the saved
alert feed, including alerts outside the graph preview. Queue refills retain
prior task links, and changes to the prompting alert reopen the review. In
Tidepool, **Inspect supporting alert** opens the task's exact retained evidence
revision. **Inspect removed evidence** opens the earlier task revision where
the alert was still attached. Each task links to the source alert in the
provenance graph. When independent signals later form an
incident candidate, Sentinel schedules an incident review in the new revision.
The planner refills up to twelve automatic incident review slots as workers
finish. It uses the saved alert feed to consider candidates beyond the graph
preview, under the same case scope and investigation limits. The model planner
receives up to twelve case-scoped incident summaries and prioritizes incidents
with recent operator decisions. At most six summaries can be for resolved or
dismissed incidents, leaving room for actionable incidents. Incident proposals
must reference that context. Planning history and provenance exports retain the
ordered incident IDs selected for each planning attempt. In Tidepool, select an
incident ID in planning history to open its saved revision and provenance. The
focused graph adds up to 25 contributing alerts beyond its usual preview.
**Browse contributing alerts** pages through the complete saved membership.
Selecting an alert there keeps its incident and their relationship in view.
Existing cases pick up alert-driven reviews on their next refresh or resume.

When new evidence changes a plan, Sentinel revalidates queued and claimed
operator assignments against the new revision if the case goal is unchanged.
A prior worker lease cannot publish results to the new revision.

The gateway runs up to 12 named case coordinators at once. When more cases are
active, waiting cases take turns as coordinators reach their two-minute slice.
A coordinator with a model worker in flight keeps its slot until that work ends
during normal rotation. Paused and stopped cases release their slots at the next
case discovery pass.

**Provenance JSON** exports the selected revision’s provenance graph, assessment
observations, and saved reviews in a versioned, machine-readable report. Planning
attempts include the selected revision's rounds and earlier rounds referenced by
exported tasks. Join them on
`plannerRound.identity` and `plannerRound.attempt`. The `planningDecisions`
array includes saved decisions referenced by those attempts, with their original
revision and note. New attempts record the ordered `findingReviewIds` and
`incidentReviewIds` supplied to the planner. `planningHints` contains the saved case hints identified by
`hintIds` in those attempts, in the order supplied to the planner. Older rounds
link to their latest saved hint through `hintId`.

**Inventory JSON** downloads the evidence graph assessed in the selected
revision. It uses the Sentinel graph format and can be imported into another
case subject to the inventory upload size limit. **Provenance JSON** includes
the same inventory alongside the derived records.

For CloudTrail, a local `--input` path ending in `.gz` selects gzip archive
intake. The archive can contain up to 1,000 records and 16 MiB of decompressed
JSON. Use `--archive=json` for a complete uncompressed document or
`--archive=gzip` for a compressed stream, including input piped to stdin.

The case provenance graph shows up to 25 retained alert observations and links
them to matching assets and evidence records. CloudTrail alert labels include
the triggering API action when available.

**Alerts JSON** exports the full normalized alert feed saved with a retained
evidence revision. A saved empty feed exports an empty array. Revisions created
before full feeds were retained can still show their existing alert samples.

From the CLI, use `triggerfish sentinel assess-export --format=alerts
--revision=N` for the same JSON report. CSV and Markdown also accept a retained
revision number.

The CLI also accepts `--format=inventory` and `--format=provenance` with
`assess-export`. Both support `--revision=N`.

Revision comparisons use both complete saved alert feeds when available. If a
revision lacks a saved feed, the comparison uses both revisions’ graph samples.
Evidence comparisons show changes to asset aliases and relationship sources,
including when the only difference is the source snapshot digest.

Use **Continue assessment** or `triggerfish sentinel assess-continue` to
reactivate a stopped case with its existing plan and task history.

In **Provenance graph**, use **Trace relationships** to browse reachable nodes
by direction, depth, and relationship type. In Sentinel chat, append
`--relation depends_on` or another exact relationship type to a `path` query.
When multiple equally short routes exist, choose a **Shortest path option**.
**Download path JSON** saves the selected path, filters, and case revision or
archive digest for handoff. Each result shows the shortest hop count and the
preceding record on that path.
Choose **Set selected node as path origin**, then select another node to see
the shortest path between them. The path respects the trace direction and
depth and shows the original direction of each relationship.
For a local inventory file, use `triggerfish sentinel path --input=sentinel.json
--from=ID --to=ID`. Pass `--provenance` in place of `--input` to query the
current saved assessment graph, with optional `--case=CASE` and `--revision=N`.
Both accept `--direction`, `--depth`, and `--relation`. Separate multiple
relationship types with commas, for example `--relation=supports,affects`.
Use `--limit=3` in the CLI, `--limit 3` in Sentinel chat, or `limit: 3`
in a worker path query to request up to three equally short paths. The result
indicates when more paths exist.

In an active Sentinel chat, run `/sentinel path FROM TO [DEPTH] [DIRECTION]`
to trace imported inventory without a model session. Quote IDs that contain
spaces. The direction defaults to `both`.
Use `/sentinel path --provenance FROM TO` for the current assessment or add
`--revision N` immediately after `--provenance` to read a historical revision.
Use `/sentinel provenance find "search text"` to discover exact node IDs and
`/sentinel provenance show NODE` to inspect a node and its connections.
Either command accepts `--revision N`, `--offset N`, and `--limit N` in that
order before the text or ID.
Sentinel agents can use `sentinel_path` with exact source and destination IDs,
an optional direction, and a maximum depth to find a path through imported
graph records.
Use `graph: "provenance"` to include generated tasks, reviews, and
observations. An optional `revision` selects a saved evidence revision.
Assessment workers query their assigned revision. Inventory and defense
coverage queries use the saved graph and alert feed for that revision.
Use `sentinel_provenance_search` to look up exact node IDs by text, kind, or
origin. The tool returns the evidence revision and the next offset, which can
be passed back to retrieve another page from the same revision.
Use `sentinel_provenance_node` with an exact ID to read node details, any saved
review summary and queries, and a paginated list of direct connections and
unresolved references.
Use `sentinel_worker_trace_search` to search prior workers' saved graph
queries by tool, target, or outcome. Each match identifies the assignment,
review node, and step index within the saved revision.
Use `sentinel_worker_observation` with `query` to find saved results or with
`task` set to the assignment ID to retrieve the exact result in pages. Pass
`nextOffset` as `offset` to continue. Assessment workers can read observations
from their assigned case and evidence revision.

Markdown investigation reports support English, Spanish, Korean, Simplified
Chinese, and Japanese. Select a language in Tidepool’s export menu or pass
`--language=en|es|ko|zh|ja` to `sentinel assess-export`. Evidence and notes
keep their original text.

## Verification

### Deployment verification

| Workflow                                    | Evidence reviewed                                                                                                                                                                                                                                                                         | Remaining verification or implementation                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-app mode and isolated workers            | Gateway and Tidepool WebSocket tests cover routing, context changes, case switching, and disconnect cleanup. PTY and piped terminal smoke tests verified tool switching and standalone workers against a real gateway.                                                                    | A native Linux build verified mode switching, context clearing, standalone worker tools, and background revision advancement against a real gateway with a local model stub. Other native platforms remain open.                                                                                                                                    |
| Persistent assessment and adaptive planning | Assessment service and runtime tests cover worker limits, evidence-driven reopening, operator hints, prerequisite tasks, and rejection of obsolete results.                                                                                                                               | Gateway restart tests recovered an expired deterministic lease and resumed interrupted planner and worker calls through a loopback model stub. Verification with a deployed model provider remains open.                                                                                                                                            |
| Shared graph and evidence provenance        | Provenance tests cover traversal, explicit task and evidence links, and unresolved references. Tidepool browser checks opened exact alerts from live, saved, and removed task evidence and reopened an archived worker source by digest after the reporting case published a replacement. | An authenticated Chromium session opened the original Suricata alert and exported its incident, independent Winlogbeat alert, and completed review from a running gateway. Production case verification remains open.                                                                                                                               |
| Telemetry and detection                     | Adapter tests and the Tidepool workspace tests cover normalization and case-scoped incident review from published telemetry.                                                                                                                                                              | Suricata packet replay and an independent Winlogbeat fixture produced a case-linked incident and completed gateway review. The running gateway processed both streams before stdin closed. A separate Zeek replay verified source-only notice attribution through incident review. Live mirror-port hardware and production collectors remain open. |
| Findings, reporting, and operator activity  | Tidepool exposes findings, task activity, and saved-revision exports. A Chromium download verified worker history escapes embedded text-direction controls and markup. Active cases can opt in to INTERNAL incident count notifications.                                                  | Verified delivery through a running gateway to authenticated Tidepool with synthetic alerts. Verify external channels in a configured deployment.                                                                                                                                                                                                   |
| Containment                                 | A gateway-backed worker rejected an unlisted tool call from a loopback model stub. Authenticated WebSocket tests cover access denial. Web-fetch enforcement covers URL hosts and redirect targets.                                                                                        | With isolated DNS and HTTP, a quarantine applied in authenticated Tidepool blocked the next configured fetch to a hostname resolving to that IP. The server received requests before quarantine and after release only. A separate check verified redirect enforcement. Production DNS and other deployment egress controls remain open.            |

### Capability verification

| Capability                                | Sentinel behavior and verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Remaining gap and evidence needed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observation-driven planning               | The committed observation set contributes to the durable round identity. The planner receives recent results that fit the input budget and can search or retrieve exact older and larger results. A planner assignment can cite an observation, which gives it a completed source prerequisite and a provenance link. A loopback model fixture received the exact stored observation and produced a follow-up whose claim waited for a second prerequisite. Authenticated Tidepool opened the cited observation from that follow-up. | A restarted gateway processed a pending observation round once and retried an in-flight round with the same input after a hard crash. Live evidence superseded an older provider call. Committed model review summaries also enter the next planning round. Planner citations distinguish the raw worker result from the saved model review. Both preserve the completed source prerequisite and open the cited record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Cross-worker observations                 | Workers can search saved review steps and observation content, inspect provenance nodes, and read exact persisted results in bounded pages. A pinned worker fixture received the exact result and rejected another case and evidence revision.                                                                                                                                                                                                                                                                                       | A gateway-backed follow-up worker retrieved the preceding worker's exact result and saved a trace for the retrieval. A revision-change regression verifies that an unchanged result is carried forward byte-for-byte under a new assignment ID. Each revision rejects the other revision’s assignment ID. An isolated running gateway with a local model stub also verified cross-revision reuse: the new source assignment had zero attempts, the later worker retrieved the original observation exactly through its current-revision ID, and authenticated Tidepool returned both the saved follow-up lineage and the original archived assignment. A regression verifies that a reopened model-review-cited task remaps its prerequisites and keeps the original citation in the archive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Shared inventory and per-case provenance  | Cases can share selected inventory through topology links and archive exact source digests. Each case keeps its own revision history, observations and assignments. Graphs support filtered traversal, shortest paths and direct references from provenance to imported assets.                                                                                                                                                                                                                                                      | Tidepool links an exact source case, snapshot digest, and asset back to saved evidence in a consuming case. Browser and gateway-handler fixtures reopened the historical citation after the source changed. Adaptive worker trace citations also reopen the saved review after source replacement. Assessment-level review trace links also reopen and expand the exact saved review after source replacement. Tidepool can load citation pages across cases. The gateway fixture returned all 22 fixture citations without duplicates, and Chromium opened a review from the final page. Pages reflect the retained citations available at request time.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Durable task list and analyst review      | Dependencies gate claims. Queue changes can be prioritized, held or sent for analyst approval. Lease recovery and stale-write rejection have store and runtime tests.                                                                                                                                                                                                                                                                                                                                                                | The gateway approval handler applied a model-generated prerequisite change, a new task, and a citation on an existing task together. A worker commit on the same evidence revision superseded the pending proposal and left all three unchanged. Tidepool displays the proposed citation before approval. A citation-only proposal inherits the cited task’s existing prerequisites when `dependsOn` is omitted. A gateway regression covers preserved prerequisites under approval and supersession. An existing worker-cited task can accept a supplemental upstream alert while retaining both provenance links. The regression verifies both links in the approved plan and confirms that a superseded proposal leaves the worker citation intact. A planner can create a new task citing both a completed worker observation and an exact upstream alert. A gateway and Tidepool regression verifies both links, the worker prerequisite, and simultaneous supplemental citations. Fact-driven reopening retries when the newer revision has derived the deterministic prerequisite. The regression also removes the supporting graph relationship and verifies that the dependent is not restored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Detection rules, indicators, and coverage | Sentinel ingests sensor and identity events, correlates alerts, imports indicators and exports detection rules and an ATT&CK Navigator layer.                                                                                                                                                                                                                                                                                                                                                                                        | The four native correlations have field and blind-spot mappings and positive and benign replay fixtures. Forty-three exact upstream checks have adapter-to-coverage replay evidence. Navigator mappings can additionally filter by triggering action within an alert type. Splunk conversion exposed fixed buckets in the event pack. A separate export matches the four already-correlated native alerts and converted to four simple searches. Isolated OpenSearch executed four native alert selectors and six upstream source-action selectors against positive and benign fixtures. Authenticated Tidepool opened the exact saved alert from an upstream check; revision and Chromium fixtures covered paging across all exact matches, excluding a different action and opening a match outside the initial graph sample. Worker tests also paged exact source-action evidence from an archived assigned revision after newer alerts arrived. A running gateway with a local model stub retrieved the exact saved alert and persisted its check and alert IDs on a scoped follow-up. A gateway planner and Tidepool regression verifies the archived alert-to-task relationship after the live feed changes and rejects citations for a different check or asset. An isolated running gateway and a regression changed and removed an exact alert with inventory held constant. The affected task reopened, retained a valid citation, and recorded removal of the invalidated citation. Tidepool still resolved the original archived alert. A running gateway with a local model stub attached a second same-check alert to an existing task and preserved the prior revision. A regression verifies duplicate delivery, removal, and reopening each exact archived alert in Tidepool. A running gateway with a local model stub attached a second check to an existing task. A regression verifies independent removal and preservation and exact Tidepool drill-down for both archived citations. Broader upstream coverage remains open. Windows Security log clear events (1102) replayed through Winlogbeat normalization, exact coverage, and Sigma export. A running gateway with a local model stub retrieved and cited the replayed alert. An isolated Winlogbeat replay matched all 14 Exploit Protection actions, the Attack Surface Reduction block, two Controlled Folder Access actions, and the existing Network Protection block. Audit-only, wrong-provider, and non-blocking font controls were excluded, and the three new exact checks agreed with the generated Sigma export. A Winlogbeat replay and Sigma export verified separate checks for Defender malware detection, remediation failure, and real-time protection disablement. Previously normalized disablement records need source replay to gain their exact action. CloudTrail IAM policy changes and Kubernetes RBAC binding changes now have exact coverage and Sigma exports. Adapter fixtures cover all 14 IAM and 10 Kubernetes action selectors, and a CLI replay excludes denied, failed, and read-only requests. Kubernetes records normalized before the action was added require source replay. Entra replay verified all three supported active directory role grant actions, exact evidence references, and Sigma export. Failed and eligibility-only events were excluded. Entra grant evidence retains validated GUIDs from explicit role and administrative unit targets. Those IDs describe targets in the same audit record. An isolated running gateway returned them to the planner and authenticated Tidepool from the saved revision. Display names and unrelated target fields are omitted. The Entra adapter also reads the new values of `Role.ObjectID` and `Role.TemplateId` from each grantee’s modified properties and labels their source separately from explicit targets. Fixtures based on captured audit records verify canonical IDs, exclusion of old values and unrelated fields, and no leakage between grantees. Administrative scopes encoded only in modified properties still need a representative source record before an exact selector can be verified. Upstream citations now resolve unique inventory aliases using the saved graph. A gateway and Tidepool regression verifies exact archived lookup and withdrawal when a newer graph makes an alias ambiguous. Production SIEM routing remains a separate deployment check. Closure requires representative production events and confirmed routing, plus positive and benign replay fixtures for each additional check. |
| Host triage                               | The standalone Linux host-triage CLI checked current process names from /proc without a collector. An isolated fixture matched the expected process indicator, skipped an unmatched rule, and returned evidence IDs.                                                                                                                                                                                                                                                                                                                 | Local process triage samples current process names. An isolated CLI fixture confirmed exact TCP listener matching and exclusion of established client sockets. The standalone CLI matched table names from a read-only SQLite snapshot and an operator-supplied PostgreSQL export. An isolated live PostgreSQL fixture verified Unix-socket collection under a restricted role. The CLI matched only the visible table while inherited connection overrides were present. Deployment visibility depends on the local role grants.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Evidence capture                          | Sentinel imports HTTP and DNS evidence. An isolated gateway web fetch verified opt-in metadata redaction before publication and excluded redirects, unlisted origins, and requests without opt-in. Authenticated Tidepool opened the exact saved record and its asset relationship.                                                                                                                                                                                                                                                  | The rolling feed retains up to 100 observations per gateway process. Broader retention and other capture paths remain separate scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Operator reporting and settings           | Tidepool offers authenticated case controls, live status, revision exports, notifications and localized Markdown reports.                                                                                                                                                                                                                                                                                                                                                                                                            | Chromium verified the case view and Markdown downloads in all five languages. Gateway regressions kept saved CSV and JSON exports byte-identical across language settings. Operator-confirmed goal completion is revision-bound, stops scheduling, and is retained in the archived report. The gateway handler verified stale-evidence rejection, and Chromium and the CLI verified completion. Case notification overrides are isolated and can inherit the gateway setting. A running gateway verified that a manually refreshed incident increase was queued without a recipient and that a later increase reached authenticated Tidepool. An isolated gateway restart verified that authenticated Tidepool reconnects retry eligible queued Sentinel receipts and save the final outcome. Concurrent reconnect tests cover duplicate suppression. Older queue entries without a Sentinel receipt remain in the regular notification workflow.                                                                                                                                                                     |

### Cross-worker and exact detection evidence

Workers can find and read saved observations and review traces within the
assigned case and revision. Trace search can retrieve selected saved step
indices for one exact assignment. Saved traces retain the tool, target, outcome,
and applicable source citations. Successful pinned graph trace, impact, and
path reads retain a bounded output excerpt and a digest of the returned result.
Exact step lookup recovers this evidence within the saved case revision and records the referenced review on the worker trace. Broad worker searches exclude their own assignment while leaving peer traces discoverable. The gateway fixtures prove same-revision reads,
reuse through a current-revision assignment ID, and archived lineage in
Tidepool. A new task can cite multiple completed worker results or saved model reviews
plus exact upstream evidence. Each worker source must independently support
the target and remains a prerequisite. The gateway and Tidepool regression
verifies two worker results and an alert on one assignment, plus archived
lineage. The mixed raw-result and model-review regression verifies both provenance edges and their prerequisites. A pinned worker fixture independently retrieves the exact observation and review content through read-only tools while rejecting out-of-scope reads. Reopened tasks recover current prerequisite IDs and preserve old citations in the archive. Reopened assignments reattach raw worker citations when the current evidence still supports the target and the new prerequisite reused the exact bytes. Tests verify current IDs, zero source attempts, cross-revision access rejection, and the new provenance edge. A changed result or a saved model review remains attributable to its original revision. After a prerequisite reruns, a fresh planning round can attach the validated current result to the existing dependent. The regression verifies the exact new input, one attachment after duplicate delivery, preserved prerequisites and archived lineage, and exclusion of a completed source outside those prerequisites. One planner response can attach evidence to an existing prerequisite and create a new dependent. The regression verifies the attachment was recorded before the dependent claim and that a missing cited review leaves both changes unapplied.

Each exact check below uses the same selector for saved alert retrieval and
Sigma export. The fixtures verify selector behavior on normalized evidence.
Deployment routing and original source collection are tracked separately.

| Exact check | Local evidence and remaining coverage |
| --- | --- |
| CloudTrail logging stopped | Adapter replay and gateway citation cover a successful stop. Coverage after logging stops depends on retained external evidence. |
| CloudTrail audit configuration changed | Raw replay covers all seven exact mutation selectors and excludes denied, read-only, partial-error, wrong-service, and unrelated records. Change significance requires comparison with the approved configuration. |
| Kubernetes RBAC binding changed | Adapter replay covers all ten resource and operation pairs. Effective access and approval require binding, role, and subject evidence. |
| Kubernetes RBAC role changed | Replay verifies Role and ClusterRole mutations on the primary resource and excludes observed dry-runs and failed requests. Resulting access requires separate evidence. |
| Kubernetes NetworkPolicy changed | Replay verifies exact successful API mutations and excludes observed dry-runs, subresources, and read-only requests. Persistence and enforcement require separate evidence. |
| Kubernetes validating admission webhook configuration changed | Raw metadata replay verifies five exact primary-resource mutation actions and excludes failed and dry-run requests. The resulting admission behavior requires separate evidence. |
| Kubernetes mutating admission webhook configuration changed | Raw metadata replay verifies five exact primary-resource mutation actions without retaining webhook configuration bodies. The resulting admission behavior requires separate evidence. |
| CloudTrail IAM policy changed | Adapter replay covers all fourteen allowlisted actions. Effective access and approval require policy and identity evidence. |
| CloudTrail IAM access key created | Raw replay verifies successful creation and excludes failed or read-only records. The normalized alert omits credential material and target username. |
| CloudTrail IAM access key set active | Raw replay verifies an exact successful request to set status to Active. The prior key state requires independent evidence. |
| Entra directory role granted | Replay covers three successful grant actions with failure and eligibility controls. An administrative scope encoded solely in modified properties needs a representative source record. |
| Windows privileged group grant | Adapter replay covers Windows group event IDs and canonical privileged group SIDs. A grant alone provides no evidence of subsequent use. |
| Zeek SSH guessing notice | Adapter replay distinguishes the notice from ordinary connections. Login outcomes require authentication evidence. |
| Windows auditing removed | Exact raw replay covers success-only, failure-only, and combined auditing removal. The resulting policy requires separate evidence. |
| Windows scheduled task created or updated | Raw Winlogbeat replay covers events 4698 and 4702 with the required provider and channel. Task paths, commands, and account names are omitted. Task execution requires separate evidence. |
| Windows Security log cleared | Winlogbeat replay checks event ID, channel, and provider. A local gateway retrieved and cited the saved alert. The cleared content requires an independent copy. |
| Windows Exploit Protection block | Replay covers fourteen supported mitigation actions and rejects audit-only, wrong-provider, and unblocked font records. Related activity requires host evidence. |
| Defender Controlled Folder Access block | Replay covers both enforced outcomes and excludes audit-mode events. The scope of related activity requires host evidence. |
| Defender real-time protection disabled | Replay distinguishes disablement from enablement and generic configuration changes. Duration requires subsequent status evidence. |
| Defender remediation failed | Replay distinguishes standard and critical failures from successful response events. Later remediation success requires separate evidence. |
| Defender malware detected | Replay distinguishes a detection from remediation outcomes. The alert does not establish execution. |
| Defender Attack Surface Reduction block | Replay distinguishes block mode from audit mode. Related activity requires host evidence. |
| Defender Network Protection block | Replay distinguishes a block from audit mode and other Defender alerts. The outcome of other traffic remains separate. |
| Defender Tamper Protection block | Validated provider replay identifies event 5013 and excludes unrelated configuration changes. |
| CloudTrail GuardDuty detector reduced | Replay covers successful detector deletion and disabling updates. It excludes failed requests and updates that leave protection enabled. |
| CloudTrail KMS key disabled | Raw replay verifies the exact successful DisableKey action without retaining the key identifier. Current key state and dependent services require separate evidence. |
| CloudTrail KMS key deletion scheduled | Raw replay verifies the exact successful ScheduleKeyDeletion action. A scheduled request does not establish deletion or data loss. |
| CloudTrail KMS key policy written | Raw replay verifies the exact successful PutKeyPolicy action without retaining the policy document or key ID. Assessing effective access requires separate policy and grant evidence. |
| CloudTrail Macie disabled | Raw replay verifies the exact successful DisableMacie request and excludes failed or duplicate calls. Current monitoring state requires separate evidence. |
| CloudTrail Macie paused | Raw replay verifies the exact successful UpdateMacieSession request with status PAUSED and excludes enabled or malformed updates. |
| CloudTrail S3 bucket Block Public Access removed | Raw replay verifies the exact successful bucket-level removal action without retaining the bucket name. Effective public exposure requires separate policy evidence. |
| CloudTrail EC2 EBS snapshot public-access block disabled | Raw replay verifies the exact successful regional account-level disable action and excludes dry runs. Individual snapshot permissions require separate evidence. |
| CloudTrail EC2 AMI public-access block disabled | Raw replay verifies the exact successful regional account-level disable action and excludes dry runs. Individual image permissions require separate evidence. |
| CloudTrail Security Hub CSPM disabled | Raw replay verifies the exact successful DisableSecurityHub action. Confirming resumed or continuing coverage requires current service evidence. |
| CloudTrail Security Hub standards disable requested | Raw replay verifies the exact successful BatchDisableStandards action without retaining subscription ARNs. Resulting subscription state and shared-control coverage require separate evidence. |
| CloudTrail AWS Config recorder reduced | Replay covers successful recorder stoppage and deletion. It excludes failed and unrelated requests. |
| Entra Conditional Access policy changed | Replay covers successful exact update and deletion activities. Policy effects and approval require separate evidence. |
| Entra authentication policy changed | Replay covers successful authentication methods, strength, and security defaults mutations. Ambiguous targets retain tenant-level evidence. |
| Entra application permissions granted | Raw replay verifies app-only role assignments, delegated permission grants, and application consent as distinct actions. Effective access requires separate grant evidence. |
| Entra service principal credential added | Diagnostic and table replay verify the exact successful addition action. Credential use requires subsequent sign-in evidence. |
| Entra service principal credential removed | Diagnostic and table replay verify the exact successful removal action. Whether other credentials remain requires separate inventory evidence. |
| Entra application certificate or secret management changed | Replay verifies documented label variants with separate failure and generic-update controls. The event identifies a management change. Its exact effect requires independent evidence. |

Case inventories can retain typed domains, IPs, services, applications, and
endpoints. Explicit parent IDs produce validated `contained_in` graph paths
in saved case provenance and shared inventory reads. Impact analysis still
uses dependency links. Hierarchy declarations belong to the source case.

Finding and passive traffic review queues refill as completed work frees
capacity. Fixtures verify that tasks beyond the initial finding and traffic
limits are reached and that holds do not consume review slots. A large finding
can still schedule follow-ups after its worker result is compacted, provided
the exact pinned graph facts reproduce the recorded digest. Shared topology
changes create evidence reviews and scoped endpoint traces. The replay verifies
reopening on a changed source digest, removal from active work when evidence
is withdrawn, and retention of the original observation and source snapshot.

Bounded trace and impact observations retain a connected sample with exact IDs,
full graph counts, and an explicit truncation flag. Oversized graph records no
longer discard the structured observation.

Native authentication failure bursts, success after failures, authorization
denial bursts, and egress denial bursts have independent positive and negative
tests. They correlate the configured asset and subject. The incident layer can
then connect isolated alerts from directly dependent assets in the same case
when they share an exact subject, fit the time window, and carry independent
evidence across distinct signal classes. A replay verifies saved membership,
links to both canonical assets, and a review scoped to the second asset. It
excludes unrelated assets, subjects, shared evidence and out-of-window
alerts without a matching session reference. For different subjects, a trusted
normalized event or alert can supply `sessionReference` in the form
`session:` followed by 64 lowercase hexadecimal characters. Collectors should
derive it from an authority-scoped, non-secret session identifier. Linked
assets must agree on the full reference. Sentinel keeps the timing and
evidence requirements and records that the candidate used a shared reference.
A multi-event detector burst carries a reference only if all contributing
events share it. CloudTrail derives an opaque reference for documented AWS
STS assumed-role identifiers, scoped by the owning account, principal, temporary
access key ID, and credential creation date. It emits neither the key ID nor
credential values. A replay connects a unanimous authorization-denial burst
with an IAM policy change on related case assets and excludes mixed credentials,
long-term keys, and incomplete identity records.
[AWS CloudTrail identity fields](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-event-reference-user-identity.html)
For classified web telemetry, the existing normalized JSONL ingestion accepts
`web_enumeration_observed`, `web_probe_observed`, and
`web_authentication_observed` with a collector-supplied opaque session reference.
Sentinel emits a review alert when all three occur in that order on the same
case asset and session within five minutes. It deduplicates events and retains
the ordered evidence IDs. The normalized detector and both Sigma exports have
local replay or structural coverage. External SIEM evaluation is separate.

An identity-only link uses a matching `identity:` reference. CloudTrail derives
it from the owning account and immutable IAM user principal ID. The linked-asset
replay verifies different reported subjects, excludes mixed identities and
conflicting session references, and recovers exact alert membership from the
matching saved revision. Subject-only links are recorded as
`shared_reported_subject` with `subject_authority_unverified`. Planner inputs,
worker reviews, provenance and incident exports expose this distinction. The
existing incident IDs and alert membership remain stable. If an alert names a session, that explicit session
is the join key. Additional collectors need documented authority-scoped ID
fields before emitting references. A completed linked-incident review can schedule an impact follow-up for each in-scope asset, with the incident review as prerequisite. The regression verifies both case-wide follow-ups and a focused review limited to the secondary asset. When multiple completed incidents support the same impact task, Sentinel records each incident in its evidence and provenance. The replay verifies two incidents on one task per asset and idempotent delivery. A store regression verifies that evidence attachment waits for a running impact lease to finish, then preserves the committed result and prerequisites.

Shared findings retain the reporting snapshot digest and the original affected
asset. Tidepool can reopen the supporting evidence after the source publication
changes. Its exact source lookup validates the case, digest, and asset-to-finding
relationship, and rejects missing or mismatched source evidence. Shared nodes that carry inherited topology provenance are excluded as independent relationship sources. A replay verifies that withdrawal of the original edge clears it even when another case has republished its overlay, while the original archive remains readable.

Controls can cite dated verification evidence through a `verifies` link.
A finding distinguishes no linked control, unverified, pass, fail, and stale
coverage. The latest eligible record controls the result, with failure winning
a same-time tie. Assessments retain the evaluated state in history. A replay
shows that expiry alone creates a new revision and triggers a stale-control
review based on the exact evidence. Saved reports export the evaluated control,
state, source evidence ID, observation time, and validity period. Completing
the assessment preserves the original control evaluation time. Later revisions record changes in control state or selected evidence and expose both states and exact evidence IDs in Markdown. Additional
checks use operator-provided records with explicit outcomes and validity periods. A failed record prioritizes the affected finding and queues review of its exact source after the verification worker confirms it. An expired record also makes an otherwise skipped low- or medium-severity finding eligible. The resulting verification cites the expired evidence and preserves the archived passing result.

Normalized authentication failures can also carry an opaque, collector-issued
`sourceReference` scoped to its authority and tenant. Sentinel detects failures
against five distinct accounts from that source on one case asset in under five
minutes, retaining one exact evidence ID per account. Local fixtures and CLI
replay cover repeats, mixed sources, expiry, and duplicate delivery. Sigma
structure is verified locally. The existing Entra collector derives the source
reference from the tenant and reported registered device GUID for interactive
sign-ins in diagnostic and Log Analytics records. It omits the raw device ID
and source IP. The CLI replay verifies production-format input connects five
distinct accounts to one alert and rejects duplicate delivery. Production
routing and backend evaluation remain separate. A strictly later successful
sign-in on the same asset and device for one of the five cited accounts
produces a separate review alert with all six evidence IDs. Local replay
verifies the sequence and exclusions. The Sigma alert selector matches the
correlated Sentinel output.
Tidepool can reopen the exact five-failure source from the retained revision,
even when it falls outside the initial graph sample. The same success alert
in a later revision has no source link if that revision lacks the failures.
[Microsoft Entra device schema](https://learn.microsoft.com/en-us/graph/api/resources/devicedetail)

One verification record can support more than one finding. Sentinel keeps one
evidence review per record and links all applicable completed verification
workers to it. Replay verifies both live and archived worker links and confirms
that supplemental provenance preserves the existing dependencies and lease.

A pinned worker can reopen a shared relationship by its local evidence ID and
reporting case. The exact archived digest and original directed edge are
required. The worker sees the cited relationship and endpoints. Its trace
records both exact source references for later review.

Pinned workers can find peer findings for an exact local asset with
`sentinel_shared_asset_links` and `includeFindings: true`. A worker may use
`sentinel_shared_finding_source` to open the reporting case's exact finding
and supporting evidence from a digest returned in the same turn. The
regression replaces the peer publication and recovers the original evidence.
It rejects tuples from a different case, asset, page, or turn, as well as
symlinked archive files and directories. The saved read trace retains the
source digest for archive audit.

Authenticated Tidepool can look up an exact asset ID in one source case's
current, archived, and quarantined snapshots, even when the operator starts
without a digest. The lookup paginates by digest and reports unavailable
snapshots. A loopback WebSocket test verifies authentication, exact asset and
case matching, and reopening a quarantined snapshot by its returned digest.

The adaptive coordinator fills available case and gateway slots with independent
reviews. A due planning round waits for the running batch to commit and takes
priority over starting more reviews. A concurrent replay proves the two-worker
case cap, planner access to both committed observations, and cancellation and
stale-result rejection for each worker on a newer revision. An expired stored
lease cannot dispatch a duplicate while its provider call is still active.
When gateway capacity is full, waiting cases receive the next available slot
in request order. The reservation fixture verifies that a completing case
yields to a waiting peer and that cancelled or expired waiters release their
turn. A sustained multi-case gateway replay remains open.

Each dispatched model planning attempt records the SHA-256 of its final
prompt and the IDs that survived the input budget. Worker source entries
distinguish embedded results and review summaries from ID-only references.
Attempt history and the provenance JSON export retain that manifest across
restarts. A loopback model confirmed that the persisted digest matched the
actual gateway request. After restarting the isolated gateway, the
authenticated Tidepool export returned that digest and the source
observation's `prompted` edge. A separate regression covers a result too large to
embed and confirms that an exact saved target beyond the preview can still
support a scoped assignment with the worker result as a prerequisite.
A superseded attempt that never reached dispatch has no input manifest.

The planning attempt also records up to 32 tool reads in call order, with
exact source IDs and result digests when available. Raw queries and tool
response bodies are omitted. Source snapshot references in those receipts
protect the exact archive in case audits. A local model fixture verifies a
planner tool response against the stored digest, and the regression verifies
an oversized result referenced by ID can still support a scoped follow-up.

The planner can cite an exact peer finding it opened during its planning turn
on an impact or trace assignment for the matching local asset. Task history
and provenance retain the reporting case, finding, asset, and snapshot
digest. The assigned follow-up worker can reopen that source with its live
review lease. A loopback gateway replay saved the worker's exact read trace,
preserved the historical citation, and expired the live citation after the
matching alias was removed. Authenticated Tidepool can reopen the exact
finding from a live or historical task or its provenance node. The gateway
fixture checks the historical export and rejects a mismatched reporting asset.
After restarting the gateway, an authenticated WebSocket reopened the original
archived finding and its supporting record using the digest from that export.

When a completed investigation carries forward, Sentinel rechecks each peer
finding against the exact retained source and the new pinned local graph. The
store accepts only citations already on the same prior investigation. A
loopback gateway replay retained the still-valid citation and preserved both
original citations in history after removing one matching alias. After restart,
authenticated Tidepool showed the retained current citation, both historical
citations, and reopened the exact surviving source digest. Each advancement
checks up to 32 uncached archives. The gateway persists completed checks and
holds the new plan until all relevant citations have been verified. A
33-archive replay interrupted the first gateway after it staged 32 results.
The restarted gateway verified the last archive and published all 33
citations. The runtime regression also verifies result reuse after
an unrelated inventory revision and preserves a valid citation on a queued
investigation explicitly assigned by an operator.

Queued and running model assignments carry their approved prerequisite
chains into a new revision. Reissued work receives a new lease and exact
evidence is checked again. The rollover regression rejects an old lease and
an unapproved dependency change. It also checks that a child with a missing
prerequisite and a task held for retirement stay out of the new plan.
Rollover checks for concurrent changes to the prior queue at commit. A
dependency approval made during rollover causes the new plan to be rebuilt
from the committed prerequisites.

Exact worker-to-worker trace reads retain the source task, evidence revision
and the indices actually returned after paging. A loopback gateway replay
verified a target read prompting an evidence review, followed by a second
worker reopening the exact saved step. Typed same-revision provenance links
resolve independently of imported graph IDs. Within the saved revision,
later planner rounds receive the exact delivered IDs as structured
model-review evidence. A citation keeps the source task as a prerequisite
and must still match a linked evidence node in the pinned graph. Omitted
neighbors cannot supply that citation through graph proximity alone. The
planner input manifest records which delivered IDs survived prompt budgeting.
When a model assignment carries to a new revision, the original source task,
evidence revision and saved step index carry with it only if the exact target,
evidence record and direct relationships still match. The current task
retains that provenance without presenting the original review as a current
worker result. A running gateway and a scoped regression verified retention
after an unrelated graph change and invalidation after the evidence changed.
The active leased worker can reopen that exact historical citation with
`sentinel_prior_assigned_evidence`. The tool revalidates the original review
step and both graph revisions, then returns the authorized evidence and its
direct relationships. The gateway replay verified the worker reopening the
original revision and recording the read.
Later planning rounds receive revalidated carried citations. A planner can
copy the exact historical tuple and cite its current carrier task as a
prerequisite. The gateway rejects tuples absent from the delivered prompt
and records the delivered tuple in the planning input manifest.
The downstream assignment stores the exact original receipt and its
completed carrier prerequisite. A dependency approval cannot detach that
carrier. On a later evidence revision, the gateway revalidates the original
receipt against the new graph before carrying it forward again.
Mixed-evidence assignments can cite exact historical receipts on one or more
worker-result sources alongside ordinary worker results and model reviews.
Each source must independently support the scoped target and remains an
explicit prerequisite.
Operator takeover preserves a revalidated historical receipt when either a
queued or completed assignment carries into another evidence revision.
Approved prerequisite chains also carry across an operator takeover. Each
prerequisite must still qualify in the new revision. If a chain cannot be
rebuilt, the assignment is recorded as unavailable. A takeover increments
the queue watermark so a concurrently staged rollover must rebuild the plan
using the saved ownership and prerequisites.
When an approved prerequisite returns, the gateway can resume that exact
operator assignment from its saved unavailable event. It rebuilds the
approved chain with fresh leases. Cancelled, failed, or retired prerequisites
continue to block recovery.

A completed depth-one evidence trace can satisfy equivalent queued work for
the exact same evidence node and pinned revision. Sentinel checks the
committed source digest, task requirements and prerequisites before marking
the target complete with zero worker attempts. The resulting history entry
records why the fact qualified. Tidepool links the satisfied task to the
exact source observation. A gateway fixture verified dependent release and
rejection of unrelated, duplicate and stale input.

During a leased workflow review, a worker can publish its staged result with
`sentinel_publish_workflow_observation`. A peer reviewing the same asset in
the same case revision can list and open the exact observation through
`sentinel_intermediate_workflow_observation`. The published record retains
the source task, target, revision, live tool step and result digest. It
does not finish the source review. A two-worker gateway fixture verified exact
retrieval while the source review was still running. After interruption, a
fresh process recovered the cited record in the Tidepool provenance export.

Workers can stage exact asset, alias, and relationship observations with
`sentinel_submit_asset_discovery` after reading the supporting evidence
from their assigned target. The observations reference the source case,
assignment, evidence revision, snapshot digest and exact evidence record.
Operators review, approve or withdraw them in the case's Asset discoveries
panel. Approval publishes a shared record alongside existing inventory.

Workers find approved records with `sentinel_shared_asset_discoveries`.
The gateway requires a unique identity match to the current target and
rechecks the reporting inventory. A corrected or withdrawn source stops
appearing in future reads. Saved consumer revisions retain their exact
source citations. The two-case gateway regression verifies approval,
idempotent submission, ambiguous identity, a downstream follow-up, and
historical provenance after correction.

Opening either Entra alert can resolve its exact counterpart from the
selected revision. If the fan-out has multiple distinct matching successes,
Tidepool leaves the out-of-sample candidates unexpanded.
