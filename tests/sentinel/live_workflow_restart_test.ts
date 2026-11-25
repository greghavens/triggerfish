import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import {
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

for (
  const phase of ["resume", "fresh", "blocked", "blocked_original"] as const
) {
  Deno.test({
    name: phase === "fresh"
      ? "A new evidence revision starts a fresh workflow conversation after interruption"
      : phase === "blocked"
      ? "A stricter post-tool policy blocks a saved workflow receipt after process restart"
      : phase === "blocked_original"
      ? "Post-tool policy withholds a live workflow result from the model and review trace"
      : "An interrupted gateway worker resumes the saved workflow conversation without repeating transport",
    ignore: Deno.build.os === "windows",
    async fn() {
      const dir = await Deno.makeTempDir();
      const path = resolveSentinelCasePath(dir);
      let child: Deno.ChildProcess | undefined;
      try {
        await Deno.mkdir(dirname(path), { recursive: true });
        await Deno.writeTextFile(
          path,
          JSON.stringify({
            version: 1,
            nodes: [{
              id: "delivery",
              kind: "asset",
              label: "Delivery pipeline",
            }],
            edges: [],
          }),
        );
        startSentinelAssessment(path);
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
        child = spawn("interrupt");
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

        const store = new DatabaseSync(
          join(dirname(path), "sentinel-adaptive.db"),
        );
        try {
          assertEquals(
            store.prepare(
              "SELECT COUNT(*) AS count FROM adaptive_worker_checkpoints",
            ).get()?.count,
            1,
          );
          assertEquals(
            store.prepare(
              "SELECT COUNT(*) AS count FROM adaptive_live_workflow_results",
            ).get()?.count,
            1,
          );
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
        assertEquals(
          await Deno.readTextFile(join(dir, "transport.log")),
          phase === "fresh" ? "read\nread\n" : "read\n",
        );
        const hooks = (await Deno.readTextFile(join(dir, "hook.log"))).trim()
          .split("\n");
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
        if (phase === "blocked") {
          assertEquals(restartHooks, [
            "blocked:pre_tool",
            "blocked:pre_outbound",
            "blocked:post_deny",
          ]);
        } else if (phase === "resume") {
          assertEquals(restartHooks, [
            "resume:pre_tool",
            "resume:pre_outbound",
            "resume:post_allow",
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
