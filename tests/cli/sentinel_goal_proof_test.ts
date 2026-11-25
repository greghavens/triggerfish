import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname } from "@std/path";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

Deno.test("Sentinel CLI binds registered completion to the reviewed run and proof", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  const cli = new URL("../../src/cli/main.ts", import.meta.url);
  const decoder = new TextDecoder();
  const command = async (action: string, ...flags: string[]) => {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", cli.pathname, "sentinel", action, ...flags],
      env: { TRIGGERFISH_DATA_DIR: baseDir },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: result.code,
      output: decoder.decode(result.stdout),
      error: decoder.decode(result.stderr),
    };
  };
  const read = async (action: string, ...flags: string[]) => {
    const result = await command(action, ...flags);
    assertEquals(result.code, 0, result.error);
    return JSON.parse(result.output);
  };
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{ id: "saved", kind: "evidence", label: "Verified record" }],
        edges: [],
      }),
    );
    const started = await read(
      "assess-start",
      "--goal=Review retained evidence",
    );
    const registered = await read(
      "assess-goal-register",
      "--criteria=" + JSON.stringify([{
        id: "record",
        description: "Review the saved record",
        source: "graph_evidence",
        reference: "saved",
      }]),
    );
    const common = [
      `--revision=${started.revision}`,
      "--goal=Review retained evidence",
      "--note=Verified the exact record.",
    ];
    const rejected = await command("assess-complete", ...common);
    assert(rejected.code !== 0);
    assertStringIncludes(rejected.error, "assess-goal-state");
    await read(
      "assess-goal-report",
      `--scope=${registered.scope}`,
      "--observations=" + JSON.stringify([{
        criterionId: "record",
        evidence: [{
          source: "graph_evidence",
          reference: "saved",
          detail: "",
        }],
      }]),
    );
    const reviewed = await read("assess-goal-state");
    assertEquals(reviewed.goalCompletion.status, "awaiting_confirmation");
    assertEquals(
      reviewed.goalCompletion.observations[0].evidence[0].reference,
      "saved",
    );
    const run = `--run-id=${reviewed.goalCompletion.caseEvidence.runId}`;
    const proof = `--proof-digest=${reviewed.proofDigest}`;
    assert((await command("assess-complete", ...common)).code !== 0);
    assert(
      (await command(
        "assess-complete",
        ...common,
        run,
        `--proof-digest=${"0".repeat(64)}`,
      )).code !== 0,
    );
    const completed = await read("assess-complete", ...common, run, proof);
    assertEquals(completed.active, false);
    assertEquals(
      (await read("assess-complete", ...common, run, proof)).completion,
      completed.completion,
    );
    assert(
      (await command(
        "assess-complete",
        ...common,
        run,
        `--proof-digest=${"0".repeat(64)}`,
      )).code !== 0,
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
