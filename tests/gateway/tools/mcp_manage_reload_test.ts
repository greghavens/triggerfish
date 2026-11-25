import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import type { ApprovalInboxRecord } from "../../../src/core/approval_inbox.ts";
import { readConfigYaml } from "../../../src/core/config_io.ts";

const gatewayFixture = fromFileUrl(
  new URL("../fixtures/mcp_configured_gateway.ts", import.meta.url),
);
const connectorFixture = fromFileUrl(
  new URL("../fixtures/mcp_configured_connector.ts", import.meta.url),
);

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 12_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function stopGatewayProcess(process: Deno.ChildProcess): Promise<void> {
  try {
    await process.stdin.close();
    const status = await within(process.status, "MCP gateway did not stop.");
    assertEquals(status.code, 0);
  } catch (error) {
    try {
      process.kill();
    } catch {
      // The process may already have exited.
    }
    await process.status;
    throw error;
  }
}

interface ApprovalControls {
  list(): Promise<readonly ApprovalInboxRecord[]>;
  decide(
    id: string,
    approved: boolean,
  ): Promise<{ readonly ok: boolean; readonly result?: unknown }>;
}

async function nextApproval(
  controls: ApprovalControls,
  accept: (record: ApprovalInboxRecord) => boolean,
): Promise<ApprovalInboxRecord> {
  const deadline = Date.now() + 2_500;
  do {
    const found = (await controls.list()).find(accept);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error("MCP lifecycle approval did not reach the expected state.");
}

async function withConfiguredGateway(
  dir: string,
  fixture: (
    turn: (content: string) => Promise<string>,
    controls: ApprovalControls,
  ) => Promise<void>,
): Promise<void> {
  const token = crypto.randomUUID();
  const process = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-check",
      "--allow-env",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-ffi",
      "--allow-import",
      "--allow-net=127.0.0.1",
      gatewayFixture,
      dir,
      token,
    ],
    env: { TRIGGERFISH_DATA_DIR: dir },
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const output = process.stdout.pipeThrough(new TextDecoderStream())
    .getReader();
  const readPort = async (): Promise<number> => {
    let line = "";
    while (!line.includes("\n")) {
      const chunk = await output.read();
      assert(!chunk.done, "MCP gateway exited before startup.");
      line += chunk.value;
    }
    return JSON.parse(line.split("\n")[0]).port;
  };
  let socket: WebSocket | undefined;
  try {
    const port = await within(readPort(), "MCP gateway did not start.");
    socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    const connected = socket;
    await within(
      new Promise<void>((resolve, reject) => {
        connected.addEventListener("open", () => resolve(), { once: true });
        connected.addEventListener("error", reject, { once: true });
      }),
      "Could not connect to the MCP gateway.",
    );
    const approvalRequest = async (body: Record<string, unknown>) => {
      const requestId = crypto.randomUUID();
      const accepted = Promise.withResolvers<
        { ok: boolean; result?: unknown }
      >();
      const receive = ({ data }: MessageEvent) => {
        const event = JSON.parse(data);
        if (
          event.type === "approval_inbox_result" &&
          event.requestId === requestId
        ) {
          accepted.resolve(event);
        }
      };
      connected.addEventListener("message", receive);
      try {
        connected.send(JSON.stringify({ ...body, requestId }));
        return await within(
          accepted.promise,
          "MCP approval inbox did not respond.",
        );
      } finally {
        connected.removeEventListener("message", receive);
      }
    };
    const controls: ApprovalControls = {
      async list() {
        const reply = await approvalRequest({ type: "approval_inbox_list" });
        assert(reply.ok);
        return (reply.result as { records: readonly ApprovalInboxRecord[] })
          .records;
      },
      decide: (approvalId, approved) =>
        approvalRequest({
          type: "approval_inbox_decide",
          approvalId,
          approved,
        }),
    };
    await fixture(async (content) => {
      let response: string | undefined;
      const end = Promise.withResolvers<void>();
      const receive = ({ data }: MessageEvent) => {
        const event = JSON.parse(data);
        if (event.type === "response") response = event.text;
        if (event.type === "turn_end") end.resolve();
      };
      connected.addEventListener("message", receive);
      try {
        connected.send(JSON.stringify({ type: "message", content }));
        await within(end.promise, "MCP gateway did not complete the turn.");
        assert(
          typeof response === "string" &&
            response.startsWith("Fixture result: "),
          "MCP gateway turn produced no fixture result.",
        );
        return response.slice("Fixture result: ".length);
      } finally {
        connected.removeEventListener("message", receive);
      }
    }, controls);
  } finally {
    try {
      if (socket && socket.readyState < WebSocket.CLOSING) {
        const close = Promise.withResolvers<void>();
        socket.addEventListener("close", () => close.resolve(), { once: true });
        socket.close();
        await within(close.promise, "MCP gateway socket did not close.");
      }
    } finally {
      try {
        await stopGatewayProcess(process);
      } finally {
        await output.cancel();
      }
    }
  }
}

Deno.test({
  name:
    "Configured MCP updates and reviewed lifecycle decisions take effect after gateway restart",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await Deno.makeTempDir();
    try {
      const probe = join(dir, "retry-attempts");
      const configPath = join(dir, "triggerfish.yaml");
      const expectedInventory = "Configured inventory is available.";
      await Deno.writeTextFile(
        configPath,
        `models:
  primary: fixture
mcp_servers:
  inventory:
    command: ${JSON.stringify(Deno.execPath())}
    args: ${
          JSON.stringify([
            "run",
            "--no-check",
            "--allow-env=MCP_FIXTURE_CREDENTIAL",
            connectorFixture,
            "inventory",
          ])
        }
    env:
      MCP_FIXTURE_CREDENTIAL: secret:fixture-mcp-key
    classification: CONFIDENTIAL
    tool_call_timeout_ms: 3000
  retry_probe:
    command: ${JSON.stringify(Deno.execPath())}
    args: ${
          JSON.stringify([
            "run",
            "--no-check",
            `--allow-write=${probe}`,
            connectorFixture,
            "retry",
            probe,
          ])
        }
    classification: INTERNAL
    max_retries: 2
`,
      );
      await withConfiguredGateway(dir, async (turn) => {
        assertEquals(await Deno.readTextFile(probe), "attempt\nattempt\n");
        assertEquals(JSON.parse(await turn("List inventory tools")), {
          server_id: "inventory",
          role: "owner",
          connected: true,
          tools: ["mcp_inventory_check"],
          _classification: "CONFIDENTIAL",
        });
        assertEquals(JSON.parse(await turn("List retry probe tools")), {
          server_id: "retry_probe",
          role: "owner",
          connected: false,
          tools: [],
          _classification: "INTERNAL",
        });
        assertEquals(await turn("Read slow inventory"), expectedInventory);
        assertEquals(
          JSON.parse(await turn("Update inventory timeout"))
            .tool_call_timeout_ms,
          1_000,
        );
        assertEquals(
          JSON.parse(await turn("Update retry limit")).max_retries,
          1,
        );
        assertEquals(await turn("Read slow inventory"), expectedInventory);
      });
      const saved = readConfigYaml(configPath);
      assert(saved.ok);
      assertStringIncludes(
        JSON.stringify(saved.value),
        "secret:fixture-mcp-key",
      );
      assert(
        !JSON.stringify(saved.value).includes("fixture-mcp-private-value"),
      );

      let disabledId = "";
      await withConfiguredGateway(dir, async (turn, inbox) => {
        assertEquals(
          await Deno.readTextFile(probe),
          "attempt\nattempt\nattempt\n",
        );
        assertEquals(await turn("Read fast inventory"), expectedInventory);
        const expired = await turn("Read slow inventory");
        assertStringIncludes(
          expired,
          "MCP request timed out after 1000ms: tools/call",
        );
        assert(!expired.includes("fixture-mcp-private-value"));
        const before = await Deno.readTextFile(configPath);
        const review = JSON.parse(await turn("Review inventory lifecycle"));
        assertEquals(review.enabled, true);
        assertEquals(Object.keys(review).sort(), [
          "_classification",
          "enabled",
          "lifecycle_revision",
          "server_id",
        ]);
        const request = `Disable inventory ${review.lifecycle_revision}`;

        const declinedTurn = turn(request);
        const declined = await nextApproval(
          inbox,
          ({ status }) => status === "pending",
        );
        assertEquals(declined.mcpLifecycle, {
          action: "disable",
          connectorId: "inventory",
        });
        assertStringIncludes(
          declined.description,
          "configured MCP connector 'inventory'",
        );
        assert(!JSON.stringify(declined).includes(review.lifecycle_revision));
        assert(!JSON.stringify(declined).includes("fixture-mcp-key"));
        assertEquals(await Deno.readTextFile(configPath), before);
        assertEquals((await inbox.decide(declined.id, false)).ok, true);
        assertStringIncludes(await declinedTurn, "approval was denied");
        assertEquals(await Deno.readTextFile(configPath), before);

        const revokedTurn = turn(request);
        const pending = await nextApproval(
          inbox,
          ({ status }) => status === "pending",
        );
        const revocation = join(dir, "deny-lifecycle");
        await Deno.writeTextFile(revocation, "");
        assertEquals((await inbox.decide(pending.id, true)).ok, true);
        assertStringIncludes(await revokedTurn, "approval was denied");
        const revoked = await nextApproval(
          inbox,
          ({ id, status }) => id === pending.id && status === "stale",
        );
        assertEquals(revoked.handlerReturnedAt, undefined);
        assertEquals(await Deno.readTextFile(configPath), before);
        await Deno.remove(revocation);

        const changedTurn = turn(request);
        const changed = await nextApproval(
          inbox,
          ({ status }) => status === "pending",
        );
        const external = before + "\ndebug: true\n";
        await Deno.writeTextFile(configPath, external);
        assertEquals((await inbox.decide(changed.id, true)).ok, true);
        assertStringIncludes(await changedTurn, "configuration changed");
        assertEquals(await Deno.readTextFile(configPath), external);
        await Deno.writeTextFile(configPath, before);

        const apply = turn(request);
        const approved = await nextApproval(
          inbox,
          ({ status }) => status === "pending",
        );
        assertEquals((await inbox.decide(approved.id, true)).ok, true);
        const result = JSON.parse(await apply);
        disabledId = approved.id;
        assertEquals(result, {
          success: true,
          server_id: "inventory",
          enabled: false,
          changed: true,
          approval_request_id: disabledId,
          restart_needed: true,
          _classification: "INTERNAL",
        });
        const completed = await nextApproval(
          inbox,
          ({ id, status }) => id === disabledId && status === "completed",
        );
        assertEquals(completed.dispatchOutcome, "returned");
        const savedDisabled = await Deno.readTextFile(configPath);
        assertEquals((await inbox.decide(disabledId, true)).result, completed);
        assertEquals(await Deno.readTextFile(configPath), savedDisabled);
        const original = readConfigYaml(configPath);
        assert(original.ok);
        const inventory = (original.value.mcp_servers as Record<
          string,
          Record<string, unknown>
        >).inventory;
        assertEquals(inventory.enabled, false);
        assertEquals(inventory.classification, "CONFIDENTIAL");
        assertEquals(inventory.env, {
          MCP_FIXTURE_CREDENTIAL: "secret:fixture-mcp-key",
        });
        assertEquals(inventory.tool_call_timeout_ms, 1000);
      });
      await withConfiguredGateway(dir, async (turn, inbox) => {
        assertEquals(JSON.parse(await turn("List inventory tools")).tools, []);
        assertEquals(
          JSON.parse(await turn("List inventory tools")).connected,
          false,
        );
        const persisted = await nextApproval(
          inbox,
          ({ id }) => id === disabledId,
        );
        assertEquals(persisted.decision, "approved");
        assertEquals(persisted.mcpLifecycle, {
          action: "disable",
          connectorId: "inventory",
        });
        assertEquals(persisted.dispatchOutcome, "returned");
        assertEquals((await inbox.decide(disabledId, true)).result, persisted);
        const status = JSON.parse(await turn("Review inventory lifecycle"));
        assertEquals(status.enabled, false);
        const enabling = turn(`Enable inventory ${status.lifecycle_revision}`);
        const pending = await nextApproval(
          inbox,
          ({ status }) => status === "pending",
        );
        assertEquals(pending.mcpLifecycle, {
          action: "enable",
          connectorId: "inventory",
        });
        assertEquals((await inbox.decide(pending.id, true)).ok, true);
        const enabled = JSON.parse(await enabling);
        assertEquals(enabled.enabled, true);
        assertEquals(enabled.approval_request_id, pending.id);
        assertEquals(enabled.restart_needed, true);
        assertEquals(
          JSON.parse(await turn("List inventory tools")).connected,
          false,
        );
      });
      let removedId = "";
      const proposals = join(dir, "mcp-proposals");
      const proposalPath = join(proposals, "inventory.yaml");
      let proposed = {} as Record<string, unknown>;
      await withConfiguredGateway(dir, async (turn, inbox) => {
        assertEquals(JSON.parse(await turn("List inventory tools")).tools, [
          "mcp_inventory_check",
        ]);
        assertEquals(await turn("Read fast inventory"), expectedInventory);
        const status = JSON.parse(await turn("Review inventory lifecycle"));
        const command = `Remove inventory ${status.lifecycle_revision}`;
        const original = await Deno.readTextFile(configPath);
        const selectRemoval = (record: ApprovalInboxRecord) =>
          record.status === "pending" &&
          record.mcpLifecycle?.action === "remove";
        const refusedCall = turn(command);
        const refused = await nextApproval(inbox, selectRemoval);
        assertEquals(refused.mcpLifecycle, {
          action: "remove",
          connectorId: "inventory",
        });
        assertStringIncludes(
          refused.description,
          "configured MCP connector 'inventory'",
        );
        assert(!JSON.stringify(refused).includes("fixture-mcp-key"));
        assertEquals((await inbox.decide(refused.id, false)).ok, true);
        assertStringIncludes(await refusedCall, "approval was denied");
        assertEquals(await Deno.readTextFile(configPath), original);

        const staleCall = turn(command);
        const stale = await nextApproval(inbox, selectRemoval);
        const externalRevision = original + "\ndebug: true\n";
        await Deno.writeTextFile(configPath, externalRevision);
        assertEquals((await inbox.decide(stale.id, true)).ok, true);
        assertStringIncludes(await staleCall, "configuration changed");
        assertEquals(await Deno.readTextFile(configPath), externalRevision);
        await Deno.writeTextFile(configPath, original);

        const expected = readConfigYaml(configPath);
        assert(expected.ok);
        const configured = expected.value.mcp_servers as Record<
          string,
          Record<string, unknown>
        >;
        const { enabled: _enabled, ...proposal } = configured.inventory;
        proposed = proposal;
        delete configured.inventory;
        const removal = turn(command);
        const pending = await nextApproval(inbox, selectRemoval);
        assertEquals((await inbox.decide(pending.id, true)).ok, true);
        removedId = pending.id;
        assertEquals(JSON.parse(await removal), {
          success: true,
          server_id: "inventory",
          removed: true,
          changed: true,
          approval_request_id: removedId,
          restart_needed: true,
          _classification: "INTERNAL",
        });
        const completed = await nextApproval(
          inbox,
          ({ id, status }) => id === removedId && status === "completed",
        );
        const updated = await Deno.readTextFile(configPath);
        assertEquals((await inbox.decide(removedId, true)).result, completed);
        assertEquals(await Deno.readTextFile(configPath), updated);
        assertEquals(readConfigYaml(configPath), expected);
        assertEquals(
          JSON.parse(await turn("List inventory tools")).connected,
          true,
        );
      });
      await Deno.mkdir(proposals, { mode: 0o700 });
      const proposalSource = JSON.stringify(proposed);
      await Deno.writeTextFile(proposalPath, proposalSource, { mode: 0o600 });
      let createdId = "";
      await withConfiguredGateway(dir, async (turn, inbox) => {
        assertStringIncludes(
          await turn("Review inventory lifecycle"),
          "configuration is unavailable",
        );
        assertStringIncludes(
          await turn("List inventory tools"),
          "selected MCP server is unavailable",
        );
        assertEquals(
          JSON.parse(await turn("List retry probe tools")).server_id,
          "retry_probe",
        );
        const receipt = await nextApproval(inbox, ({ id }) => id === removedId);
        assertEquals(receipt.mcpLifecycle, {
          action: "remove",
          connectorId: "inventory",
        });
        assertEquals(receipt.decision, "approved");
        assertEquals(receipt.dispatchOutcome, "returned");
        const before = await Deno.readTextFile(configPath);
        assertStringIncludes(
          await turn("Add with raw transport"),
          "reviewed operator proposal",
        );
        for (
          const request of [
            "Write raw MCP config",
            "Write raw legacy MCP config",
          ]
        ) {
          assertStringIncludes(await turn(request), "Use mcp_manage");
        }
        for (
          const request of [
            "Write recovery grants",
            "Write Sentinel read grants",
            "Replace Sentinel config",
          ]
        ) {
          assertStringIncludes(
            await turn(request),
            "configured directly by the operator",
          );
        }
        assertEquals(await Deno.readTextFile(configPath), before);
        const review = JSON.parse(await turn("Review inventory creation"));
        assertEquals(review.transport, "stdio");
        assertEquals(review.classification, "CONFIDENTIAL");
        assertEquals(review.enabled, false);
        assertEquals(review.command, undefined);
        assertEquals(review.env, undefined);
        const command = `Add inventory ${review.lifecycle_revision}`;
        const find = ({ status, mcpLifecycle }: ApprovalInboxRecord) =>
          status === "pending" && mcpLifecycle?.action === "add";
        const declinedTurn = turn(command);
        const declined = await nextApproval(inbox, find);
        assertEquals(declined.mcpLifecycle, {
          action: "add",
          connectorId: "inventory",
        });
        assertStringIncludes(declined.description, "as disabled");
        assert(!JSON.stringify(declined).includes("fixture-mcp-key"));
        assert(!JSON.stringify(declined).includes(review.lifecycle_revision));
        assertEquals((await inbox.decide(declined.id, false)).ok, true);
        assertStringIncludes(await declinedTurn, "approval was denied");
        assertEquals(await Deno.readTextFile(configPath), before);

        const staleTurn = turn(command);
        const stale = await nextApproval(inbox, find);
        await Deno.writeTextFile(
          proposalPath,
          proposalSource + "\n# changed after review",
        );
        assertEquals((await inbox.decide(stale.id, true)).ok, true);
        assertStringIncludes(
          await staleTurn,
          "proposal or saved configuration changed",
        );
        assertEquals(await Deno.readTextFile(configPath), before);
        await Deno.writeTextFile(proposalPath, proposalSource);

        const create = turn(command);
        const pending = await nextApproval(inbox, find);
        assertEquals((await inbox.decide(pending.id, true)).ok, true);
        createdId = pending.id;
        assertEquals(JSON.parse(await create), {
          success: true,
          server_id: "inventory",
          created: true,
          enabled: false,
          approval_request_id: createdId,
          restart_needed: false,
          _classification: "INTERNAL",
        });
        const saved = readConfigYaml(configPath);
        assert(saved.ok);
        assertEquals(
          (saved.value.mcp_servers as Record<string, unknown>).inventory,
          {
            ...proposed,
            enabled: false,
          },
        );
        assertEquals(JSON.parse(await turn("List inventory tools")).tools, []);
        const record = await nextApproval(
          inbox,
          ({ id, status }) => id === createdId && status === "completed",
        );
        assertEquals((await inbox.decide(createdId, true)).result, record);
      });
      await withConfiguredGateway(dir, async (turn, inbox) => {
        assertEquals(
          JSON.parse(await turn("List inventory tools")).connected,
          false,
        );
        const receipt = await nextApproval(inbox, ({ id }) => id === createdId);
        assertEquals(receipt.decision, "approved");
        assertEquals(receipt.dispatchOutcome, "returned");
        const status = JSON.parse(await turn("Review inventory lifecycle"));
        const enabling = turn(`Enable inventory ${status.lifecycle_revision}`);
        const pending = await nextApproval(
          inbox,
          ({ status }) => status === "pending",
        );
        assertEquals(pending.mcpLifecycle?.action, "enable");
        assertEquals((await inbox.decide(pending.id, true)).ok, true);
        assertEquals(JSON.parse(await enabling).enabled, true);
      });
      const replacement = {
        ...proposed,
        args: (proposed.args as string[]).map((arg) =>
          arg === "inventory" ? "inventory-v2" : arg
        ),
      };
      const replacementSource = JSON.stringify(replacement);
      await Deno.writeTextFile(proposalPath, replacementSource);
      await withConfiguredGateway(dir, async (turn, inbox) => {
        assertEquals(JSON.parse(await turn("List inventory tools")).tools, [
          "mcp_inventory_check",
        ]);
        assertEquals(await turn("Read fast inventory"), expectedInventory);
        assertStringIncludes(
          await turn("Review inventory replacement"),
          "Disable the configured connector",
        );
        const status = JSON.parse(await turn("Review inventory lifecycle"));
        const disabling = turn(
          "Disable inventory " + status.lifecycle_revision,
        );
        const request = await nextApproval(
          inbox,
          ({ status }) => status === "pending",
        );
        assertEquals((await inbox.decide(request.id, true)).ok, true);
        assertEquals(JSON.parse(await disabling).enabled, false);
      });

      let replacedId = "";
      await withConfiguredGateway(dir, async (turn, inbox) => {
        const before = await Deno.readTextFile(configPath);
        assertStringIncludes(
          await turn("Replace with raw transport"),
          "reviewed operator proposal",
        );
        assertEquals(await Deno.readTextFile(configPath), before);
        const review = JSON.parse(await turn("Review inventory replacement"));
        assertEquals(review.proposal_action, "replace");
        assertEquals(review.enabled, false);
        assert(!JSON.stringify(review).includes("fixture-mcp-key"));
        assert(!JSON.stringify(review).includes("inventory-v2"));
        const command = "Replace inventory " + review.lifecycle_revision;
        const replacing = () =>
          nextApproval(
            inbox,
            ({ status, mcpLifecycle }) =>
              status === "pending" && mcpLifecycle?.action === "replace",
          );

        const declined = turn(command);
        const denied = await replacing();
        assertEquals(denied.mcpLifecycle?.connectorId, "inventory");
        assertStringIncludes(denied.description, "disabled operator proposal");
        assert(!JSON.stringify(denied).includes(review.lifecycle_revision));
        assert(!JSON.stringify(denied).includes("fixture-mcp-key"));
        assertEquals((await inbox.decide(denied.id, false)).ok, true);
        assertStringIncludes(await declined, "approval was denied");
        assertEquals(await Deno.readTextFile(configPath), before);

        const formerlyReviewed = turn(command);
        const stale = await replacing();
        await Deno.writeTextFile(
          proposalPath,
          replacementSource + "\n# moved after review",
        );
        assertEquals((await inbox.decide(stale.id, true)).ok, true);
        assertStringIncludes(
          await formerlyReviewed,
          "proposal or saved configuration changed",
        );
        assertEquals(await Deno.readTextFile(configPath), before);
        await Deno.writeTextFile(proposalPath, replacementSource);

        const apply = turn(command);
        const approved = await replacing();
        assertEquals((await inbox.decide(approved.id, true)).ok, true);
        replacedId = approved.id;
        assertEquals(JSON.parse(await apply), {
          success: true,
          server_id: "inventory",
          replaced: true,
          enabled: false,
          approval_request_id: replacedId,
          restart_needed: true,
          _classification: "INTERNAL",
        });
        const saved = readConfigYaml(configPath);
        assert(saved.ok);
        assertEquals(
          (saved.value.mcp_servers as Record<string, unknown>).inventory,
          {
            ...replacement,
            enabled: false,
          },
        );
        assertEquals(JSON.parse(await turn("List inventory tools")).tools, []);
        const receipt = await nextApproval(
          inbox,
          ({ id, status }) => id === replacedId && status === "completed",
        );
        assertEquals((await inbox.decide(replacedId, true)).result, receipt);
      });

      await withConfiguredGateway(dir, async (turn, inbox) => {
        assertEquals(
          JSON.parse(await turn("List inventory tools")).connected,
          false,
        );
        const receipt = await nextApproval(
          inbox,
          ({ id }) => id === replacedId,
        );
        assertEquals(receipt.decision, "approved");
        assertEquals(receipt.dispatchOutcome, "returned");
        const status = JSON.parse(await turn("Review inventory lifecycle"));
        const enabling = turn("Enable inventory " + status.lifecycle_revision);
        const pending = await nextApproval(
          inbox,
          ({ status }) => status === "pending",
        );
        assertEquals(pending.mcpLifecycle?.action, "enable");
        assertEquals((await inbox.decide(pending.id, true)).ok, true);
        assertEquals(JSON.parse(await enabling).enabled, true);
      });
      await withConfiguredGateway(dir, async (turn) => {
        assertEquals(JSON.parse(await turn("List inventory tools")).tools, [
          "mcp_inventory_check",
        ]);
        assertEquals(
          await turn("Read fast inventory"),
          "Replacement inventory is available.",
        );
      });
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
