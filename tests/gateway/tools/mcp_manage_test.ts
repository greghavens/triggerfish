/**
 * mcp_manage tool executor tests.
 *
 * Tests the MCP server config management tool actions.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createMcpManageExecutor } from "../../../src/gateway/tools/executor/executor_mcp_manage.ts";
import { join } from "@std/path";

/** Create a temp config file for testing. */
async function setupTempConfig(): Promise<{
  configPath: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await Deno.makeTempDir({ prefix: "triggerfish-test-" });
  const configPath = join(dir, "triggerfish.yaml");
  await Deno.mkdir(join(dir, "backups"), { recursive: true });
  await Deno.writeTextFile(
    configPath,
    "# Test Config\nmcp:\n  servers:\n    existing:\n      command: npx\n      args:\n        - test-server\n      classification: INTERNAL\n      enabled: true\n",
  );
  return {
    configPath,
    cleanup: async () => {
      await Deno.remove(dir, { recursive: true });
    },
  };
}

// --- list ---

Deno.test("mcp_manage: list returns servers from config file", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createMcpManageExecutor({ configPath });
    const result = await executor("mcp_manage", { action: "list" });
    assertEquals(result !== null, true);
    const parsed = JSON.parse(result!);
    assertEquals(parsed.total, 1);
    assertEquals(parsed.servers[0].id, "existing");
    assertEquals(parsed.servers[0].command, "npx");
  } finally {
    await cleanup();
  }
});

Deno.test("mcp_manage: list returns empty for no servers", async () => {
  const dir = await Deno.makeTempDir({ prefix: "triggerfish-test-" });
  const configPath = join(dir, "triggerfish.yaml");
  await Deno.mkdir(join(dir, "backups"), { recursive: true });
  await Deno.writeTextFile(
    configPath,
    "# Empty\nmodels:\n  primary:\n    provider: test\n    model: test\n",
  );
  try {
    const executor = createMcpManageExecutor({ configPath });
    const result = await executor("mcp_manage", { action: "list" });
    const parsed = JSON.parse(result!);
    assertEquals(parsed.servers.length, 0);
    assertEquals(parsed.message, "No MCP servers configured.");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- add ---

Deno.test("mcp_manage: add writes server to config and returns restart_needed", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createMcpManageExecutor({ configPath });
    const result = await executor("mcp_manage", {
      action: "add",
      server_id: "context7",
      command: "npx",
      args: "-y @upstash/context7-mcp",
      classification: "INTERNAL",
    });
    assertEquals(result !== null, true);
    const parsed = JSON.parse(result!);
    assertEquals(parsed.success, true);
    assertEquals(parsed.server_id, "context7");
    assertEquals(parsed.restart_needed, true);

    // Verify it's in config
    const listResult = await executor("mcp_manage", { action: "list" });
    const listParsed = JSON.parse(listResult!);
    assertEquals(listParsed.total, 2);
    const context7 = listParsed.servers.find((s: Record<string, unknown>) =>
      s.id === "context7"
    );
    assertEquals(context7.command, "npx");
  } finally {
    await cleanup();
  }
});

Deno.test("mcp_manage: add rejects invalid classification", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createMcpManageExecutor({ configPath });
    const result = await executor("mcp_manage", {
      action: "add",
      server_id: "bad",
      command: "npx",
      classification: "INVALID_LEVEL",
    });
    assertEquals(result !== null, true);
    assertEquals(result!.startsWith("Error:"), true);
  } finally {
    await cleanup();
  }
});

Deno.test("mcp_manage: add requires command or url", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createMcpManageExecutor({ configPath });
    const result = await executor("mcp_manage", {
      action: "add",
      server_id: "no-transport",
    });
    assertEquals(result !== null, true);
    assertEquals(result!.includes("requires either"), true);
  } finally {
    await cleanup();
  }
});

// --- status ---

Deno.test("mcp_manage: status returns server config details", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createMcpManageExecutor({ configPath });
    const result = await executor("mcp_manage", {
      action: "status",
      server_id: "existing",
    });
    assertEquals(result !== null, true);
    const parsed = JSON.parse(result!);
    assertEquals(parsed.id, "existing");
    assertEquals(parsed.classification, "INTERNAL");
  } finally {
    await cleanup();
  }
});

Deno.test("mcp_manage: status returns error for unknown server", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createMcpManageExecutor({ configPath });
    const result = await executor("mcp_manage", {
      action: "status",
      server_id: "unknown",
    });
    assertEquals(result !== null, true);
    const parsed = JSON.parse(result!);
    assertEquals(parsed.error !== undefined, true);
  } finally {
    await cleanup();
  }
});

// --- enable/disable ---

Deno.test("mcp_manage: lifecycle revision alone cannot authorize a change", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createMcpManageExecutor({ configPath });
    const original = await Deno.readTextFile(configPath);
    const context = { isCurrentInteractiveOwner: () => true };
    const status = JSON.parse(
      (await executor("mcp_manage", {
        action: "lifecycle_status",
        server_id: "existing",
      }, context))!,
    );
    assertEquals(Object.keys(status).sort(), [
      "_classification",
      "enabled",
      "lifecycle_revision",
      "server_id",
    ]);
    for (const action of ["enable", "disable", "remove"]) {
      const result = await executor("mcp_manage", {
        action,
        server_id: "existing",
        lifecycle_revision: status.lifecycle_revision,
      }, context);
      assertStringIncludes(result!, "owner inbox approval");
      assertEquals(await Deno.readTextFile(configPath), original);
    }
    const overwrite = await executor("mcp_manage", {
      action: "add",
      server_id: "existing",
      command: "node",
    });
    assertStringIncludes(overwrite!, "existing MCP server");
    assertEquals(await Deno.readTextFile(configPath), original);
  } finally {
    await cleanup();
  }
});

// --- dispatch ---

Deno.test("mcp_manage: returns null for non-matching tool name", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createMcpManageExecutor({ configPath });
    const result = await executor("other_tool", { action: "list" });
    assertEquals(result, null);
  } finally {
    await cleanup();
  }
});

Deno.test("mcp_manage: requires action parameter", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createMcpManageExecutor({ configPath });
    const result = await executor("mcp_manage", {});
    assertEquals(result !== null, true);
    assertEquals(result!.includes("requires an 'action'"), true);
  } finally {
    await cleanup();
  }
});

Deno.test("mcp_manage: requires server_id for non-list actions", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createMcpManageExecutor({ configPath });
    const result = await executor("mcp_manage", { action: "remove" });
    assertEquals(result !== null, true);
    assertEquals(result!.includes("requires a 'server_id'"), true);
  } finally {
    await cleanup();
  }
});

// --- legacy config path ---

Deno.test("mcp_manage: list reads legacy mcp_servers path", async () => {
  const dir = await Deno.makeTempDir({ prefix: "triggerfish-test-" });
  const configPath = join(dir, "triggerfish.yaml");
  await Deno.mkdir(join(dir, "backups"), { recursive: true });
  await Deno.writeTextFile(
    configPath,
    "# Legacy\nmcp_servers:\n  old-server:\n    command: node\n    classification: PUBLIC\n",
  );
  try {
    const executor = createMcpManageExecutor({ configPath });
    const result = await executor("mcp_manage", { action: "list" });
    const parsed = JSON.parse(result!);
    assertEquals(parsed.total, 1);
    assertEquals(parsed.servers[0].id, "old-server");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mcp_manage: live discovery needs trusted owner dispatch", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  let inspected = false;
  try {
    const executor = createMcpManageExecutor({
      configPath,
      getConnectorTools() {
        inspected = true;
        return { tools: ["mcp_existing_search"] };
      },
    });
    const result = await executor("mcp_manage", {
      action: "tools",
      server_id: "existing",
    });
    assertEquals(inspected, false);
    assertStringIncludes(result!, "requires the active owner session");
  } finally {
    await cleanup();
  }
});
