import { openSentinelAssetDiscoveryStore } from "../../src/sentinel/asset_discovery_store.ts";
import {
  readSentinelTrafficReceiptPage,
  recordSentinelTrafficReceipt,
} from "../../src/sentinel/traffic_receipts.ts";
import {
  listSentinelFindingTrafficLinks,
  openSentinelFindingTrafficLinks,
} from "../../src/sentinel/finding_traffic_links.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import {
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { listSentinelPlannerGraphFacts } from "../../src/sentinel/worker_graph_facts.ts";
import {
  openSentinelWorkerFindingStore,
  readSentinelWorkerFindingWriteReceipt,
} from "../../src/sentinel/worker_finding_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

for (
  const phase of [
    "resume",
    "resume_assigned",
    "resume_graph",
    "resume_graph_mutation",
    "resume_graph_batch",
    "resume_discovery",
    "resume_graph_batch_corrupt",
    "resume_graph_unproven",
    "resume_finding",
    "resume_finding_batch",
    "resume_finding_partial",
    "resume_recheck",
    "resume_recheck_batch",
    "resume_traffic_batch",
    "resume_traffic_search",
    "resume_traffic_listing",
    "resume_traffic_unavailable",
    "resume_amendment",
    "resume_mixed",
    "resume_multi",
    "resume_mutation",
    "resume_workflow_batch",
    "resume_first_batch",
    "resume_workflow_unapproved",
    "resume_unproven",
    "fresh",
    "blocked_pre",
    "revoked",
    "missing_credential",
    "blocked",
    "blocked_original",
  ] as const
) {
  Deno.test({
    name: phase === "resume_workflow_unapproved"
      ? "Sentinel keeps a mixed batch held without proof the read passed response policy"
      : phase === "resume_first_batch"
      ? "Sentinel recovers a first tool batch before any tool checkpoint exists"
      : phase === "resume_workflow_batch"
      ? "Sentinel recovers a live status read and publication in the same batch"
      : phase === "resume_finding_batch"
      ? "Sentinel reconciles every receipt in a committed mixed mutation batch"
      : phase === "resume_finding_partial"
      ? "Sentinel holds a partially committed mutation batch without retrying it"
      : phase === "resume_traffic_unavailable"
      ? "Sentinel holds an interrupted attachment when its exact retained traffic is missing"
      : phase === "resume_traffic_listing"
      ? "Sentinel recovers the original finding-traffic listing alongside its attachment"
      : phase === "resume_traffic_search"
      ? "Sentinel recovers a paginated traffic search with its read and attachment"
      : phase === "resume_traffic_batch"
      ? "Sentinel recovers a sanitized traffic read and finding attachment after restart"
      : phase === "resume_recheck_batch"
      ? "Sentinel resumes a finding context read and recheck committed in the same batch"
      : phase === "resume_finding" || phase === "resume_recheck" ||
          phase === "resume_amendment"
      ? `Sentinel recovers a committed ${phase.slice(7)} write after restart`
      : phase === "resume_graph_unproven"
      ? "A graph journal receipt with a different admitted request stays held"
      : phase === "resume_discovery"
      ? "Sentinel reuses the original discovery submission receipt after operator approval"
      : phase === "resume_graph_batch"
      ? "Sentinel recovers a first batch that reads and publishes an assigned relationship"
      : phase === "resume_graph_batch_corrupt"
      ? "Sentinel holds an interrupted graph batch when the retained read digest changes"
      : phase === "resume_graph_mutation"
      ? "Sentinel reconciles an interrupted graph publication from the request-bound journal receipt"
      : phase === "resume_graph"
      ? "Sentinel publishes an exact relationship from reauthorized assigned evidence after restart"
      : phase === "resume_mutation"
      ? "Sentinel reconciles a committed publication without dispatching it again"
      : phase === "resume_unproven"
      ? "An unproven publication remains held without dispatching it again"
      : phase === "resume_mixed"
      ? "Sentinel resumes both reads from one mixed tool batch"
      : phase === "resume_multi"
      ? "Sentinel resumes both reads across multiple model iterations"
      : phase === "resume_assigned"
      ? "A Sentinel worker resumes its committed assigned target after process restart"
      : phase === "fresh"
      ? "A new evidence revision starts a fresh workflow conversation after interruption"
      : phase === "blocked"
      ? "A stricter post-tool policy blocks a saved workflow receipt after process restart"
      : phase === "blocked_pre"
      ? "Root pre-call denial blocks saved workflow replay before the source is checked"
      : phase === "revoked" || phase === "missing_credential"
      ? `Saved workflow replay is blocked after restart with ${phase} access`
      : phase === "blocked_original"
      ? "Post-tool policy withholds a live workflow result from the model and review trace"
      : "An interrupted gateway worker resumes the saved workflow conversation without repeating transport",
    ignore: Deno.build.os === "windows",
    async fn() {
      const graphPhase = phase === "resume_discovery" ||
        phase === "resume_graph" ||
        phase === "resume_graph_mutation" ||
        phase === "resume_graph_unproven" ||
        phase === "resume_graph_batch" ||
        phase === "resume_graph_batch_corrupt";
      const trafficPhase = phase === "resume_traffic_batch" ||
        phase === "resume_traffic_search" ||
        phase === "resume_traffic_listing" ||
        phase === "resume_traffic_unavailable";
      const historicalTrafficId = `har:evidence:${"e".repeat(64)}`;
      const trafficId = `har:evidence:${"a".repeat(64)}`;
      const assetId = trafficPhase ? `har:asset:${"b".repeat(64)}` : "delivery";
      const findingPhase = [
        "resume_finding",
        "resume_finding_batch",
        "resume_finding_partial",
        "resume_recheck",
        "resume_recheck_batch",
        "resume_amendment",
        "resume_traffic_batch",
        "resume_traffic_search",
        "resume_traffic_listing",
        "resume_traffic_unavailable",
      ].includes(phase);
      const dir = await Deno.makeTempDir();
      const path = resolveSentinelCasePath(dir);
      let child: Deno.ChildProcess | undefined;
      try {
        await Deno.mkdir(dirname(path), { recursive: true });
        const now = Date.now();
        const observedAt = new Date(now - 60_000).toISOString();
        const validUntil = new Date(now + 3_600_000).toISOString();
        const snapshot = {
          version: 1,
          nodes: [
            {
              id: assetId,
              kind: "asset",
              label: "Delivery pipeline",
            },
            ...(trafficPhase
              ? [{
                id: trafficId,
                kind: "evidence",
                label: "Sanitized traffic",
              }]
              : []),
            ...(graphPhase
              ? [{
                id: "pipeline-record",
                kind: "evidence",
                label: "Retained pipeline record",
              }]
              : []),
            ...(findingPhase
              ? [
                {
                  id: "review-gap",
                  kind: "finding",
                  label: "Control gap",
                  severity: "high",
                },
                {
                  id: "check-control",
                  kind: "control",
                  label: "Control under review",
                },
                {
                  id: "check",
                  kind: "evidence",
                  label: "Retained verification",
                  controlVerification: {
                    outcome: phase === "resume_recheck" ||
                        phase === "resume_recheck_batch"
                      ? "pass"
                      : "fail",
                    observedAt,
                    validUntil,
                  },
                },
              ]
              : []),
          ],
          edges: graphPhase
            ? [{
              from: "pipeline-record",
              to: assetId,
              relation: "observed_on",
            }]
            : findingPhase
            ? [
              { from: "review-gap", to: assetId, relation: "affects" },
              {
                from: "check-control",
                to: "review-gap",
                relation: "mitigates",
              },
              { from: "check", to: "check-control", relation: "verifies" },
              { from: "check", to: assetId, relation: "observed_on" },
            ]
            : [],
        };
        if (trafficPhase) {
          snapshot.edges.push({
            from: trafficId,
            to: assetId,
            relation: "observed_on",
          });
          recordSentinelTrafficReceipt(
            path,
            "har",
            loadSentinelGraph(snapshot).snapshot(),
            {
              assetId,
              evidenceId: trafficId,
              origin: "https://service.example",
              method: "GET",
              status: 403,
              startedAt: observedAt,
            },
          );
        }
        if (
          phase === "resume_traffic_search" ||
          phase === "resume_traffic_listing"
        ) {
          const evidenceId = historicalTrafficId;
          snapshot.nodes.push({
            id: evidenceId,
            kind: "evidence",
            label: "Another sanitized record",
          });
          snapshot.edges.push({
            from: evidenceId,
            to: assetId,
            relation: "observed_on",
          });
          recordSentinelTrafficReceipt(
            path,
            "har",
            loadSentinelGraph(snapshot).snapshot(),
            {
              assetId,
              evidenceId,
              origin: "https://service.example",
              method: "GET",
              status: 403,
              startedAt: observedAt,
            },
          );
        }
        await Deno.writeTextFile(path, JSON.stringify(snapshot));
        const assessment = startSentinelAssessment(path);
        if (
          phase === "resume_recheck" || phase === "resume_recheck_batch" ||
          phase === "resume_amendment" || trafficPhase
        ) {
          assert(assessment.plan.runId);
          const journal = openSentinelWorkerFindingStore(path);
          try {
            const finding = journal.recordFinding({
              caseId: "main",
              runId: assessment.plan.runId,
              evidenceRevision: assessment.revision,
              taskId: "original-task",
              targetId: assetId,
              graphFindingId: "review-gap",
              controlId: "check-control",
              evidenceId: "old-check",
              snapshotDigest: "a".repeat(64),
              observedAt: new Date(now - 120_000).toISOString(),
              evaluatedAt: observedAt,
              validUntil,
              requestId: "original-request",
              title: "Prior control gap",
              summary: "Original failure",
            });
            if (trafficPhase) {
              const traffic = readSentinelTrafficReceiptPage(
                path,
                assessment.revision,
                {
                  assetId,
                  evidenceId: trafficId,
                },
              )?.receipts[0];
              assert(traffic);
              if (phase === "resume_traffic_listing") {
                const historical = readSentinelTrafficReceiptPage(
                  path,
                  assessment.revision,
                  {
                    assetId,
                    evidenceId: historicalTrafficId,
                  },
                )?.receipts[0];
                assert(historical);
                const links = openSentinelFindingTrafficLinks(path);
                try {
                  assert(links.record({
                    caseId: "main",
                    assetId,
                    evidenceRevision: assessment.revision,
                    findingId: finding.id,
                    reportVersion: 1,
                    trafficId: historical.evidenceId,
                    trafficSource: historical.family,
                    trafficDigest: historical.digest,
                    authority: { kind: "operator" },
                    requestId: "4bcb28fe-744b-474e-91b0-96457230407a",
                  }, () => true));
                } finally {
                  links.close();
                }
              }

              await Deno.writeTextFile(
                join(dir, "fixture-traffic.json"),
                JSON.stringify({
                  assetId,
                  evidenceId: trafficId,
                  digest: traffic.digest,
                  findingId: finding.id,
                }),
              );
            }
          } finally {
            journal.close();
          }
        }
        const fixture = fromFileUrl(
          new URL(
            "./fixtures/live_workflow_worker_process.ts",
            import.meta.url,
          ),
        );
        const spawn = (phase: string) =>
          new Deno.Command(Deno.execPath(), {
            args: ["run", "-A", fixture, dir, phase],
            stdout: "null",
            stderr: "piped",
          }).spawn();
        if (phase === "blocked_original") {
          child = spawn(phase);
          const blocked = await child.output();
          child = undefined;
          assert(blocked.success, new TextDecoder().decode(blocked.stderr));
          assertEquals(
            await Deno.readTextFile(join(dir, "transport.log")),
            "read\n",
          );
          const hooks = (await Deno.readTextFile(join(dir, "hook.log"))).trim()
            .split("\n");
          assertEquals(hooks, [
            "blocked_original:provider",
            "blocked_original:pre_tool",
            "blocked_original:pre_outbound",
            "blocked_original:resolve_credential",
            "blocked_original:post_deny",
            "blocked_original:provider",
            "blocked_original:output_internal",
          ]);
          return;
        }
        child = spawn(
          phase === "resume_traffic_unavailable"
            ? "interrupt_traffic_batch"
            : phase === "resume_graph_batch_corrupt"
            ? "interrupt_graph_batch"
            : phase === "resume_workflow_unapproved"
            ? "interrupt_workflow_batch"
            : phase === "resume_graph_unproven"
            ? "interrupt_graph_mutation"
            : phase === "resume_graph"
            ? "interrupt_assigned"
            : phase === "resume_unproven"
            ? "interrupt_mutation"
            : phase.startsWith("resume_")
            ? phase.replace("resume_", "interrupt_")
            : "interrupt",
        );
        let ready = false;
        for (let attempt = 0; attempt < 200 && !ready; attempt++) {
          try {
            await Deno.stat(join(dir, "checkpoint-ready"));
            ready = true;
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        if (!ready) {
          const diagnostics = await child.output();
          throw new Error(new TextDecoder().decode(diagnostics.stderr));
        }
        child.kill("SIGKILL");
        assert(!(await child.status).success);
        child = undefined;

        const database = join(dirname(path), "sentinel-adaptive.db");
        for (const file of [database, `${database}-wal`]) {
          try {
            const bytes = await Deno.readFile(file);
            assert(!new TextDecoder().decode(bytes).includes("fixture-only-"));
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound) || file === database) {
              throw error;
            }
          }
        }
        const store = new DatabaseSync(database);
        try {
          assertEquals(
            store.prepare(
              "SELECT COUNT(*) AS count FROM adaptive_worker_checkpoints",
            ).get()?.count,
            1,
          );
          if (phase === "resume_first_batch") {
            const baseline = JSON.parse(
              String(
                store.prepare(
                  "SELECT checkpoint FROM adaptive_worker_checkpoints",
                ).get()?.checkpoint,
              ),
            );
            assertEquals(baseline.completedIterations, 0);
            assertEquals(
              baseline.history.map(({ role }: { role: string }) => role),
              ["user"],
            );
            assertEquals(baseline.toolCallCounts, []);
          }
          if (phase === "resume_recheck_batch") {
            assertEquals(
              store.prepare(
                "SELECT stepIndex FROM adaptive_recheck_context_batch_receipts",
              ).get()?.stepIndex,
              1,
            );
          }
          if (phase !== "resume_assigned" && !graphPhase && !findingPhase) {
            assertEquals(
              store.prepare(
                "SELECT COUNT(*) AS count FROM adaptive_live_workflow_results",
              ).get()?.count,
              1,
            );
          }
          if (
            phase === "resume_graph_batch" ||
            phase === "resume_graph_batch_corrupt"
          ) {
            assertEquals(
              store.prepare(
                "SELECT stepIndex FROM adaptive_assigned_target_batch_receipts",
              ).get()?.stepIndex,
              0,
            );
            assertEquals(
              JSON.parse(
                String(
                  store.prepare(
                    "SELECT checkpoint FROM adaptive_worker_checkpoints",
                  ).get()?.checkpoint,
                ),
              ).completedIterations,
              0,
            );
            if (phase === "resume_graph_batch_corrupt") {
              store.exec(
                "UPDATE adaptive_assigned_target_batch_receipts SET result = result || ' '",
              );
            }
          }
          if (phase === "resume_graph_unproven") {
            const row = store.prepare(
              "SELECT rowid, note FROM adaptive_events WHERE event = 'model_mutation_pending'",
            ).get();
            assert(typeof row?.note === "string");
            const marker = JSON.parse(row.note);
            marker.journalRequests[0].requestId =
              "cba7ef0f-5479-4f75-93c9-1f144e97eee9";
            store.prepare("UPDATE adaptive_events SET note = ? WHERE rowid = ?")
              .run(JSON.stringify(marker), row.rowid);
          }
          if (phase === "resume_workflow_unapproved") {
            const row = store.prepare(
              "SELECT taskId, steps FROM adaptive_worker_progress",
            ).get();
            assert(typeof row?.steps === "string");
            const steps = JSON.parse(row.steps);
            assertEquals(steps[1]?.tool, "sentinel_live_workflow_status");
            store.prepare(
              "UPDATE adaptive_worker_progress SET steps = ? WHERE taskId = ?",
            )
              .run(JSON.stringify(steps.slice(0, 1)), row.taskId);
          }
          if (phase === "resume_unproven") {
            store.exec(
              "DELETE FROM adaptive_events WHERE event = 'workflow_observation_committed'",
            );
          }
          // Advance only the expired lease clock in the isolated fixture.
          store.exec(
            "UPDATE adaptive_model_reviews SET availableAt = 0 WHERE token IS NOT NULL",
          );
        } finally {
          store.close();
        }
        if (phase === "fresh") {
          const previous = JSON.parse(await Deno.readTextFile(path));
          previous.nodes[0].label = "Updated delivery pipeline";
          await Deno.writeTextFile(path, JSON.stringify(previous));
          refreshSentinelAssessment(path);
          const clock = new DatabaseSync(
            join(dirname(path), "sentinel-adaptive.db"),
          );
          try {
            clock.exec("UPDATE adaptive_model_attempts SET started = 0");
          } finally {
            clock.close();
          }
        }
        if (phase === "resume_traffic_unavailable") {
          const missing = new DatabaseSync(
            join(dirname(path), "sentinel-traffic-receipts.db"),
          );
          try {
            missing.exec("DELETE FROM traffic_receipts_v1");
          } finally {
            missing.close();
          }
        }
        if (phase === "resume_discovery") {
          const store = openSentinelAssetDiscoveryStore(dir);
          try {
            const pending = store.readProposalReceipt(
              "15673bf0-5479-4f75-93c9-1f144e97eee9",
            );
            assert(pending);
            assertEquals(pending.status, "pending");
            assertEquals(
              store.approve(pending.id, pending.version)?.status,
              "approved",
            );
          } finally {
            store.close();
          }
        }
        child = spawn(phase);
        const resumed = await child.output();
        child = undefined;
        assert(resumed.success, new TextDecoder().decode(resumed.stderr));
        const transport = await Deno.readTextFile(join(dir, "transport.log"))
          .catch((error) => {
            if (error instanceof Deno.errors.NotFound) return "";
            throw error;
          });
        assertEquals(
          transport,
          phase === "resume_assigned" || graphPhase || findingPhase
            ? ""
            : phase === "fresh"
            ? "read\nread\n"
            : "read\n",
        );
        const hooks = (await Deno.readTextFile(join(dir, "hook.log"))).trim()
          .split("\n");
        if (
          phase === "resume_finding_batch" || phase === "resume_finding_partial"
        ) {
          assert(assessment.plan.runId);
          const facts = listSentinelPlannerGraphFacts(path, {
            caseId: "main",
            runId: assessment.plan.runId,
            evidenceRevision: assessment.revision,
          });
          assertEquals(facts.length, 1);
          const db = new DatabaseSync(database);
          try {
            const rows = db.prepare(
              "SELECT taskId, note FROM adaptive_events WHERE event = 'model_mutation_settled'",
            ).all();
            if (phase === "resume_finding_partial") {
              assertEquals(rows, []);
              assertEquals(
                hooks.filter((line) => line.startsWith(`${phase}:`)),
                [],
              );
              assertEquals(
                hooks.filter((line) => line.endsWith(":finding_committed")),
                [],
              );
            } else {
              assertEquals(rows.length, 1);
              const receipts = JSON.parse(String(rows[0].note));
              assertEquals(receipts[0], facts[0].id);
              const finding = readSentinelWorkerFindingWriteReceipt(path, {
                caseId: "main",
                runId: assessment.plan.runId,
                evidenceRevision: assessment.revision,
                taskId: String(rows[0].taskId),
                targetId: "delivery",
              }, "15673bf0-5479-4f75-93c9-1f144e97eee9");
              assertEquals(receipts[1], finding?.id);
              assertEquals(
                hooks.filter((line) => line.endsWith(":finding_committed"))
                  .length,
                1,
              );
              assertEquals(
                hooks.filter((line) => line.endsWith(":finding_reauthorized"))
                  .length,
                1,
              );
            }
          } finally {
            db.close();
          }
          return;
        }
        if (trafficPhase) {
          const links = listSentinelFindingTrafficLinks(path, {
            assetId,
            evidenceRevision: assessment.revision,
          });
          assertEquals(
            links.length,
            phase === "resume_traffic_listing" ? 2 : 1,
          );
          const attached = links.find((link) => link.trafficId === trafficId);
          assertEquals(attached?.reportVersion, 1);
          if (phase === "resume_traffic_unavailable") {
            assertEquals(
              hooks.filter((line) => line.startsWith(`${phase}:`)),
              [],
            );
            return;
          }
          assertEquals(hooks.filter((line) => line.endsWith(":traffic_read")), [
            `${phase.replace("resume_", "interrupt_")}:traffic_read`,
            `${phase}:traffic_read`,
          ]);
          assertEquals(
            hooks.filter((line) => line.endsWith(":traffic_attachment")),
            [
              `${phase.replace("resume_", "interrupt_")}:traffic_attachment`,
              `${phase}:traffic_attachment`,
            ],
          );
          if (phase === "resume_traffic_listing") {
            assertEquals(
              hooks.filter((line) => line.endsWith(":traffic_listing")),
              [
                "interrupt_traffic_listing:traffic_listing",
                "resume_traffic_listing:traffic_listing",
              ],
            );
            const db = new DatabaseSync(database);
            try {
              assertEquals(
                db.prepare(
                  "SELECT COUNT(*) AS count FROM adaptive_traffic_links_batch_receipts",
                ).get()?.count,
                0,
              );
            } finally {
              db.close();
            }
          }
          if (phase === "resume_traffic_search") {
            assertEquals(
              hooks.filter((line) => line.endsWith(":traffic_search")),
              [
                "interrupt_traffic_search:traffic_search",
                "resume_traffic_search:traffic_search",
              ],
            );
          }
          return;
        }
        if (findingPhase) {
          assertEquals(
            hooks.filter((line) => line.endsWith(":finding_committed")),
            [
              `${phase.replace("resume_", "interrupt_")}:finding_committed`,
            ],
          );
          assertEquals(
            hooks.filter((line) => line.endsWith(":finding_reauthorized")),
            [
              `${phase}:finding_reauthorized`,
            ],
          );
          const db = new DatabaseSync(database);
          try {
            const settled = db.prepare(
              "SELECT taskId, note FROM adaptive_events WHERE event = 'model_mutation_settled'",
            ).get();
            assert(typeof settled?.taskId === "string");
            assert(assessment.plan.runId);
            const receipt = readSentinelWorkerFindingWriteReceipt(path, {
              caseId: "main",
              runId: assessment.plan.runId,
              evidenceRevision: assessment.revision,
              taskId: settled.taskId,
              targetId: "delivery",
            }, "15673bf0-5479-4f75-93c9-1f144e97eee9");
            assertEquals(receipt?.id, settled.note);
            if (phase === "resume_recheck_batch") {
              assertEquals(
                db.prepare(
                  "SELECT COUNT(*) AS count FROM adaptive_recheck_context_batch_receipts",
                ).get()?.count,
                0,
              );
              assertEquals(
                hooks.filter((line) => line.endsWith(":recheck_context")),
                [
                  "interrupt_recheck_batch:recheck_context",
                  "resume_recheck_batch:recheck_context",
                ],
              );
            }

            assertEquals(
              receipt?.kind,
              phase === "resume_amendment"
                ? "report_amendment"
                : phase === "resume_recheck_batch"
                ? "recheck"
                : phase.slice(7),
            );
          } finally {
            db.close();
          }
          return;
        }
        if (phase === "resume_discovery") {
          const store = openSentinelAssetDiscoveryStore(dir);
          try {
            const receipt = store.readProposalReceipt(
              "15673bf0-5479-4f75-93c9-1f144e97eee9",
            );
            assert(receipt);
            assertEquals(receipt.status, "pending");
            assertEquals(store.get(receipt.id)?.status, "approved");
            assertEquals(
              store.history(receipt.id).map(({ status }) => status),
              ["pending", "approved"],
            );
          } finally {
            store.close();
          }
          assertEquals(
            hooks.filter((line) => line.endsWith(":discovery_result")),
            [
              "interrupt_discovery:discovery_result",
              "resume_discovery:discovery_result",
            ],
          );
          return;
        }
        if (graphPhase) {
          assert(assessment.plan.runId);
          const facts = listSentinelPlannerGraphFacts(path, {
            caseId: "main",
            runId: assessment.plan.runId,
            evidenceRevision: assessment.revision,
          });
          assertEquals(facts.length, 1);
          assertEquals(facts[0].relationship, {
            from: "pipeline-record",
            to: "delivery",
            relation: "observed_on",
          });
          assertEquals(facts[0].sourceStepIndex, 0);
          if (
            phase === "resume_graph_unproven" ||
            phase === "resume_graph_batch_corrupt"
          ) {
            assertEquals(
              hooks.filter((line) => line.startsWith(`${phase}:`)),
              [],
            );
            return;
          }
          assertEquals(
            hooks.filter((line) => line === `${phase}:pre_tool`).length,
            1,
          );
          assertEquals(
            hooks.filter((line) => line === `${phase}:post_allow`).length,
            1,
          );
          if (
            phase === "resume_graph_mutation" || phase === "resume_graph_batch"
          ) {
            assertEquals(
              hooks.filter((line) => line.endsWith(":graph_committed")),
              [`${phase.replace("resume_", "interrupt_")}:graph_committed`],
            );
            assertEquals(
              hooks.filter((line) => line.endsWith(":graph_reauthorized")),
              [`${phase}:graph_reauthorized`],
            );
          }
          if (phase === "resume_graph_batch") {
            const db = new DatabaseSync(database);
            try {
              assertEquals(
                db.prepare(
                  "SELECT COUNT(*) AS count FROM adaptive_assigned_target_batch_receipts",
                ).get()?.count,
                0,
              );
              assertEquals(
                db.prepare(
                  "SELECT note FROM adaptive_events WHERE event = 'model_mutation_settled'",
                ).get()?.note,
                facts[0].id,
              );
            } finally {
              db.close();
            }
          }
          return;
        }
        if (phase === "resume_workflow_unapproved") {
          assertEquals(
            hooks.filter((line) => line.startsWith(`${phase}:`)),
            [],
          );
          const db = new DatabaseSync(database);
          try {
            assertEquals(
              db.prepare(
                "SELECT COUNT(*) AS count FROM adaptive_workflow_observations",
              ).get()?.count,
              1,
            );
            assertEquals(
              db.prepare(
                "SELECT COUNT(*) AS count FROM adaptive_events WHERE event = 'model_mutation_settled'",
              ).get()?.count,
              0,
            );
          } finally {
            db.close();
          }
          return;
        }
        if (
          phase === "resume_workflow_batch" || phase === "resume_first_batch"
        ) {
          assertEquals(
            hooks.filter((line) => line.endsWith(":mutation_committed")),
            [
              `${phase.replace("resume_", "interrupt_")}:mutation_committed`,
            ],
          );
          assertEquals(
            hooks.filter((line) => line.endsWith(":publication_reauthorized")),
            [
              `${phase}:publication_reauthorized`,
            ],
          );
          assertEquals(
            hooks.filter((line) => line.endsWith(":probe_metadata")),
            [
              `${phase}:probe_metadata`,
            ],
          );
          const db = new DatabaseSync(database);
          try {
            const observations = db.prepare(
              "SELECT id, stepIndex FROM adaptive_workflow_observations",
            ).all();
            assertEquals(observations.length, 1);
            assertEquals(
              observations[0].stepIndex,
              phase === "resume_first_batch" ? 0 : 1,
            );
            assertEquals(
              db.prepare(
                "SELECT note FROM adaptive_events WHERE event = 'model_mutation_settled'",
              ).get()?.note,
              observations[0].id,
            );
          } finally {
            db.close();
          }
          return;
        }
        if (phase === "resume_mutation" || phase === "resume_unproven") {
          assertEquals(
            hooks.filter((line) => line.endsWith(":mutation_committed")),
            ["interrupt_mutation:mutation_committed"],
          );
          assertEquals(
            hooks.filter((line) => line.startsWith(`${phase}:`)),
            phase === "resume_unproven" ? [] : [
              "resume_mutation:pre_tool",
              "resume_mutation:post_allow",
              "resume_mutation:publication_reauthorized",
              "resume_mutation:pre_metadata",
              "resume_mutation:resolve_credential",
              "resume_mutation:probe_metadata",
              "resume_mutation:provider",
              "resume_mutation:output_internal",
            ],
          );
          const db = new DatabaseSync(database);
          try {
            assertEquals(
              db.prepare(
                "SELECT COUNT(*) AS count FROM adaptive_workflow_observations",
              ).get()?.count,
              1,
            );
            assertEquals(
              db.prepare(
                "SELECT event FROM adaptive_events WHERE event LIKE 'model_mutation_%' ORDER BY rowid",
              ).all().map(({ event }) => event),
              phase === "resume_unproven"
                ? ["model_mutation_pending"]
                : ["model_mutation_pending", "model_mutation_settled"],
            );
          } finally {
            db.close();
          }
          return;
        }
        if (phase === "resume_mixed" || phase === "resume_multi") {
          assertEquals(hooks.filter((line) => line.startsWith(`${phase}:`)), [
            `${phase}:pre_target`,
            `${phase}:pre_tool`,
            `${phase}:post_target`,
            `${phase}:post_allow`,
            `${phase}:pre_metadata`,
            `${phase}:resolve_credential`,
            `${phase}:probe_metadata`,
            `${phase}:provider`,
            `${phase}:output_internal`,
          ]);
          return;
        }
        if (phase === "resume_assigned") {
          assertEquals(hooks, [
            "interrupt_assigned:provider",
            "interrupt_assigned:pre_tool",
            "interrupt_assigned:post_allow",
            "interrupt_assigned:provider",
            "resume_assigned:pre_tool",
            "resume_assigned:post_allow",
            "resume_assigned:provider",
            "resume_assigned:output_internal",
          ]);
          return;
        }
        assertEquals(hooks.filter((line) => line.startsWith("interrupt:")), [
          "interrupt:provider",
          "interrupt:pre_tool",
          "interrupt:pre_outbound",
          "interrupt:resolve_credential",
          "interrupt:post_allow",
          "interrupt:provider",
        ]);
        const restartHooks = hooks.filter((line) =>
          line.startsWith(`${phase}:`)
        );
        if (phase === "blocked_pre") {
          assertEquals(restartHooks, ["blocked_pre:pre_tool"]);
        } else if (phase === "blocked") {
          assertEquals(restartHooks, [
            "blocked:pre_tool",
            "blocked:post_deny",
          ]);
        } else if (phase === "revoked" || phase === "missing_credential") {
          assertEquals(restartHooks, [
            `${phase}:pre_tool`,
            `${phase}:post_allow`,
            `${phase}:pre_metadata`,
            `${phase}:resolve_credential`,
            ...(phase === "revoked" ? ["revoked:probe_metadata"] : []),
          ]);
        } else if (phase === "resume") {
          assertEquals(restartHooks, [
            "resume:pre_tool",
            "resume:post_allow",
            "resume:pre_metadata",
            "resume:resolve_credential",
            "resume:probe_metadata",
            "resume:provider",
            "resume:output_internal",
          ]);
        }
      } finally {
        if (child) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The child already exited.
          }
          await child.status;
        }
        await Deno.remove(dir, { recursive: true });
      }
    },
  });
}
