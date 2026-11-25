import {
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  openOperatorRunLinkStore,
  OperatorRunController,
  type OperatorRunRef,
} from "../../src/core/operator_runs.ts";

const sentinel = { kind: "sentinel", id: "case-a", revision: 6 } as const;
const workflow = { kind: "workflow", id: "run-a" } as const;
const other = { kind: "workflow", id: "run-b" } as const;

Deno.test("operator run links are immutable and scoped across restarts", () => {
  const root = Deno.makeTempDirSync();
  const path = join(root, "links.db");
  try {
    const first = openOperatorRunLinkStore(path, () => 1000);
    const second = openOperatorRunLinkStore(path, () => 2000);
    const input = {
      scope: "workspace-a",
      operatorId: "owner",
      requestId: "request-a",
      left: sentinel,
      right: workflow,
    };
    const link = first.record(input);
    try {
      assertEquals(
        second.record({ ...input, left: workflow, right: sentinel }),
        link,
      );
      assertEquals(second.record({ ...input, requestId: "request-b" }), link);
      assertThrows(
        () => second.record({ ...input, requestId: "request-b", right: other }),
        Error,
        "Conflicting",
      );
      assertThrows(
        () => second.record({ ...input, right: { ...sentinel, revision: 7 } }),
        Error,
        "distinct",
      );
      assertEquals(second.list("workspace-b"), []);
      assertEquals(
        second.list("workspace-a", { ...sentinel, revision: 7 }),
        [],
      );
    } finally {
      first.close();
      second.close();
    }
    const reopened = openOperatorRunLinkStore(path);
    try {
      assertEquals(reopened.list("workspace-a", workflow), [link]);
      assertEquals(
        reopened.readRequest("workspace-a", "owner", "request-b"),
        link,
      );
      assertEquals(
        reopened.readRequest("workspace-a", "other-owner", "request-b"),
        undefined,
      );
    } finally {
      reopened.close();
    }
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("run controller pins revisions and revalidates both linked endpoints", async () => {
  const root = Deno.makeTempDirSync();
  const links = openOperatorRunLinkStore(join(root, "links.db"));
  try {
    let workflowAllowed = true;
    let approvals = 0;
    let exactMutation: OperatorRunRef | undefined;
    let lastTask: string | undefined;
    const sentinelSummary = {
      ref: sentinel,
      status: "active",
      label: "Case A",
      classification: "INTERNAL" as const,
      details: { counts: [1, 2] },
      evidence: [{ source: "snapshot", reference: "digest", raw: "omitted" }],
      raw: "omitted",
    };
    const workflowSummary = {
      ref: workflow,
      status: "running",
      label: "Workflow",
    };
    const controller = new OperatorRunController({
      scope: "workspace",
      operatorId: "owner",
      links,
      async authorize(_action, ref) {
        return await Promise.resolve(
          workflowAllowed || ref.kind === "sentinel",
        );
      },
      approveLink() {
        return ++approvals === 1;
      },
      providers: {
        sentinel: {
          list: () => [sentinelSummary],
          inspect: () => sentinelSummary,
          mutations: {
            steer: (ref, context) => {
              exactMutation = ref;
              lastTask = context?.taskId;
              return sentinelSummary;
            },
          },
        },
        workflow: {
          list: () => [workflowSummary],
          inspect: () => workflowSummary,
        },
      },
    });
    const unresolved = { kind: "sentinel", id: sentinel.id } as const;
    const result = await controller.mutate("steer", unresolved, {
      taskId: "worker",
      note: "Check the saved evidence",
    });
    assertEquals(exactMutation, sentinel);
    assertEquals(lastTask, "worker");
    assertExists(result);
    assertEquals(Object.hasOwn(result, "raw"), false);
    assertEquals(result.evidence, [{
      source: "snapshot",
      reference: "digest",
    }]);
    await assertRejects(
      () => controller.inspect({ ...sentinel, revision: 8 }),
      Error,
      "different run",
    );
    const request = {
      left: unresolved,
      right: workflow,
      requestId: "approved-link",
    };
    const link = await controller.link(request);
    assertExists(link);
    assertEquals(link.left, sentinel);
    assertEquals(await controller.link(request), link);
    assertEquals(approvals, 1);
    assertEquals(await controller.listLinks(), [link]);
    workflowAllowed = false;
    assertEquals(await controller.listLinks(), []);
    assertEquals(await controller.inspect(workflow), undefined);
    assertEquals(await controller.link(request), undefined);
    assertEquals((await controller.list()).map(({ ref }) => ref), [sentinel]);
  } finally {
    links.close();
    Deno.removeSync(root, { recursive: true });
  }
});
