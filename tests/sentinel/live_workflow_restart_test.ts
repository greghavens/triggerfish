import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import {
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

for (const changed of [false, true]) {
  Deno.test({
    name: changed
      ? "A new evidence revision starts a fresh workflow conversation after interruption"
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
        if (changed) {
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
        child = spawn(changed ? "fresh" : "resume");
        const resumed = await child.output();
        child = undefined;
        assert(resumed.success, new TextDecoder().decode(resumed.stderr));
        assertEquals(
          await Deno.readTextFile(join(dir, "transport.log")),
          changed ? "read\nread\n" : "read\n",
        );
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
