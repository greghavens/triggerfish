import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import {
  addSentinelCaseHint,
  readSentinelCaseHints,
  recordOperatorSentinelRunHint,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  pauseSentinelAssessment,
  refreshSentinelAssessment,
  startSentinelAssessment,
  stopSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";

Deno.test("operator case hints bind requests to the current assessment revision and owner", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "sentinel.json");
  const request = "48d11280-f691-478a-a170-2ac8c568ad74";
  try {
    const save = (label: string) =>
      Deno.writeTextFile(
        path,
        JSON.stringify({
          version: 1,
          nodes: [{ id: "app", kind: "asset", label }],
          edges: [],
        }),
      );
    await save("Application");
    const initial = startSentinelAssessment(path);
    assertEquals(
      recordOperatorSentinelRunHint(
        path,
        initial.revision + 1,
        request,
        "Check the application.",
      ),
      undefined,
    );
    assertEquals(
      recordOperatorSentinelRunHint(
        path,
        initial.revision,
        "invalid",
        "Check the application.",
      ),
      undefined,
    );
    const receipt = recordOperatorSentinelRunHint(
      path,
      initial.revision,
      request,
      "Check the application.",
      "owner-a",
    );
    assertExists(receipt);
    assertEquals(
      recordOperatorSentinelRunHint(
        path,
        initial.revision,
        request,
        "Check the application.",
        "owner-a",
      ),
      receipt,
    );
    assertEquals(
      recordOperatorSentinelRunHint(
        path,
        initial.revision,
        request,
        "Changed instruction.",
        "owner-a",
      ),
      undefined,
    );
    assertEquals(
      recordOperatorSentinelRunHint(
        path,
        initial.revision,
        request,
        "Check the application.",
        "owner-b",
      ),
      undefined,
    );
    assertEquals(readSentinelCaseHints(path, 10), [receipt]);
    await save("Updated application");
    const current = refreshSentinelAssessment(path);
    assertExists(current);
    assertEquals(current.revision > initial.revision, true);
    const unused = "f1514794-e837-4ce9-94d2-b172c4cecd04";
    assertEquals(
      recordOperatorSentinelRunHint(
        path,
        initial.revision,
        unused,
        "Old revision.",
        "owner-a",
      ),
      undefined,
    );
    assertEquals(
      recordOperatorSentinelRunHint(
        path,
        current.revision,
        request,
        "Check the application.",
        "owner-a",
      ),
      undefined,
    );
    pauseSentinelAssessment(path);
    const paused = recordOperatorSentinelRunHint(
      path,
      current.revision,
      unused,
      "Continue at resume.",
      "owner-a",
    );
    assertExists(paused);
    addSentinelCaseHint(path, "Native hint.");
    assertEquals(readSentinelCaseHints(path, 10).map((entry) => entry.text), [
      "Native hint.",
      "Continue at resume.",
      "Check the application.",
    ]);
    stopSentinelAssessment(path);
    assertEquals(
      recordOperatorSentinelRunHint(
        path,
        current.revision,
        "62f4209c-d834-471f-b7b4-686aa5de2bd8",
        "Stopped.",
      ),
      undefined,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
