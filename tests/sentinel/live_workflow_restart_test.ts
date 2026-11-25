import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import {
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { listSentinelPlannerGraphFacts } from "../../src/sentinel/worker_graph_facts.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

for (
  const phase of [
    "resume",
    "resume_assigned",
    "resume_graph",
    "resume_graph_mutation",
    "resume_graph_unproven",
    "resume_mixed",
    "resume_multi",
    "resume_mutation",
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
    name: phase === "resume_graph_unproven"
      ? "A graph journal receipt with a different admitted request stays held"
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
      const graphPhase = phase === "resume_graph" ||
        phase === "resume_graph_mutation" || phase === "resume_graph_unproven";
      const dir = await Deno.makeTempDir();
      const path = resolveSentinelCasePath(dir);
      let child: Deno.ChildProcess | undefined;
      try {
        await Deno.mkdir(dirname(path), { recursive: true });
        await Deno.writeTextFile(
          path,
          JSON.stringify({
            version: 1,
            nodes: [
              {
                id: "delivery",
                kind: "asset",
                label: "Delivery pipeline",
              },
              ...(graphPhase
                ? [{
                  id: "pipeline-record",
                  kind: "evidence",
                  label: "Retained pipeline record",
                }]
                : []),
            ],
            edges: graphPhase
              ? [{
                from: "pipeline-record",
                to: "delivery",
                relation: "observed_on",
              }]
              : [],
          }),
        );
        const assessment = startSentinelAssessment(path);
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
          phase === "resume_graph_unproven"
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
          if (phase !== "resume_assigned" && !graphPhase) {
            assertEquals(
              store.prepare(
                "SELECT COUNT(*) AS count FROM adaptive_live_workflow_results",
              ).get()?.count,
              1,
            );
          }
          if (phase === "resume_graph_unproven") {
            const row = store.prepare(
              "SELECT rowid, note FROM adaptive_events WHERE event = 'model_mutation_pending'",
            ).get();
            assert(typeof row?.note === "string");
            const marker = JSON.parse(row.note);
            marker.graphPublication.requestId =
              "cba7ef0f-5479-4f75-93c9-1f144e97eee9";
            store.prepare("UPDATE adaptive_events SET note = ? WHERE rowid = ?")
              .run(JSON.stringify(marker), row.rowid);
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
          phase === "resume_assigned" || graphPhase
            ? ""
            : phase === "fresh"
            ? "read\nread\n"
            : "read\n",
        );
        const hooks = (await Deno.readTextFile(join(dir, "hook.log"))).trim()
          .split("\n");
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
          if (phase === "resume_graph_unproven") {
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
          if (phase === "resume_graph_mutation") {
            assertEquals(
              hooks.filter((line) => line.endsWith(":graph_committed")),
              ["interrupt_graph_mutation:graph_committed"],
            );
            assertEquals(
              hooks.filter((line) => line.endsWith(":graph_reauthorized")),
              ["resume_graph_mutation:graph_reauthorized"],
            );
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
