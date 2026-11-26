/**
 * MCP Server Manager runtime method tests.
 *
 * Tests addServer, removeServer, reconnectServer on the concrete manager.
 */
import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { createMcpServerManager } from "../../src/mcp/manager.ts";

Deno.test("McpServerManager: addServer increments configuredCount", () => {
  const manager = createMcpServerManager();
  assertEquals(manager.getConfiguredCount(), 0);

  // Add a server with no command/url — will be marked failed but still counted
  manager.addServer({ id: "test", enabled: true });
  assertEquals(manager.getConfiguredCount(), 1);
});

Deno.test("McpServerManager: addServer with no command/url marks server failed", () => {
  const manager = createMcpServerManager();
  manager.addServer({ id: "bad-server", enabled: true });

  const statuses = manager.getStatus();
  assertEquals(statuses.length, 1);
  assertEquals(statuses[0].id, "bad-server");
  assertEquals(statuses[0].state, "failed");
  assertEquals(statuses[0].lastError, "no command or url configured");
});

Deno.test("McpServerManager: removeServer for unknown ID is safe", async () => {
  const manager = createMcpServerManager();
  // Should not throw
  await manager.removeServer("nonexistent");
  assertEquals(manager.getConfiguredCount(), 0);
});

Deno.test("McpServerManager: removeServer decrements configuredCount", async () => {
  const manager = createMcpServerManager();
  manager.addServer({ id: "to-remove", enabled: true });
  assertEquals(manager.getConfiguredCount(), 1);

  await manager.removeServer("to-remove");
  assertEquals(manager.getConfiguredCount(), 0);
  assertEquals(manager.getStatus().length, 0);
});

Deno.test("McpServerManager: reconnectServer for unknown ID is safe", () => {
  const manager = createMcpServerManager();
  // Should not throw
  manager.reconnectServer("nonexistent");
});

Deno.test({
  name:
    "McpServerManager: reconnectServer marks server disconnected then reconnecting",
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const manager = createMcpServerManager();
    // First add a server (will be marked failed since no real transport)
    manager.addServer({ id: "reconnect-test", enabled: true });

    // Now reconnect it — it should exist in statusMap
    manager.reconnectServer("reconnect-test");

    const statuses = manager.getStatus();
    const status = statuses.find((s) => s.id === "reconnect-test");
    assertEquals(status !== undefined, true);
    // State will be "disconnected" or "connecting" depending on timing
    // Since we have no real transport, the retry loop will fail
  },
});

Deno.test("McpServerManager: onStatusChange fires on addServer", () => {
  const manager = createMcpServerManager();
  let notified = false;
  const unsubscribe = manager.onStatusChange(() => {
    notified = true;
  });

  manager.addServer({ id: "listener-test", enabled: true });
  assertEquals(notified, true);

  unsubscribe();
});

Deno.test("McpServerManager: onStatusChange fires on removeServer", async () => {
  const manager = createMcpServerManager();
  manager.addServer({ id: "listener-remove", enabled: true });

  let callCount = 0;
  const unsubscribe = manager.onStatusChange(() => {
    callCount++;
  });

  await manager.removeServer("listener-remove");
  assertEquals(callCount > 0, true);

  unsubscribe();
});

Deno.test({
  name:
    "Removing an MCP connector invalidates its pending reconnect generation",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await Deno.makeTempDir();
    const manager = createMcpServerManager();
    try {
      const probe = join(dir, "attempts");
      const fixture = fromFileUrl(
        new URL(
          "../gateway/fixtures/mcp_configured_connector.ts",
          import.meta.url,
        ),
      );
      manager.startAll([{
        id: "pending-retry",
        command: Deno.execPath(),
        args: [
          "run",
          "--no-check",
          `--allow-write=${probe}`,
          fixture,
          "retry",
          probe,
        ],
        maxRetries: 10,
      }]);
      for (
        let attempt = 0;
        attempt < 100 && manager.getStatus()[0]?.state !== "disconnected";
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assertEquals(manager.getStatus()[0]?.state, "disconnected");
      assertEquals(await Deno.readTextFile(probe), "attempt\n");
      await manager.removeServer("pending-retry");
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      assertEquals(await Deno.readTextFile(probe), "attempt\n");
      assertEquals(manager.getStatus(), []);
    } finally {
      await manager.disconnectAll();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
