import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  RetainedInventoryHttpTransport,
  retainedInventoryProtocolVersion,
} from "../../src/mcp/client/retained_inventory_http.ts";
import { createMcpClient } from "../../src/mcp/client/protocol.ts";
import { parseRetainedInventoryEndpoint } from "../../src/mcp/retained_inventory.ts";

Deno.test("Retained inventory HTTP binds every exchange to the same endpoint and current credential", async () => {
  const endpoint = "https://inventory.example/mcp";
  let key: string | undefined = "fixture-private-key-one";
  let remainingCalls = 0;
  let replyKind: "normal" | "echo" | "error" | "revoked" = "normal";
  const transport = new RetainedInventoryHttpTransport(
    endpoint,
    () => Promise.resolve(key),
    500,
    (url, init, _check, policy) => {
      assertEquals(url, endpoint);
      assertEquals(policy?.maxRedirects, 0);
      assert(policy?.isUrlAllowed?.(endpoint));
      assert(!policy?.isUrlAllowed?.("https://inventory.example/other"));
      assert(!policy?.isUrlAllowed?.("https://another.example/mcp"));
      assertEquals(init?.method, "POST");
      remainingCalls--;
      const headers = new Headers(init?.headers);
      assertEquals(headers.get("x-api-key"), key);
      const { id, method, params } = JSON.parse(String(init?.body));
      if (method === "initialize") {
        assertEquals(params.protocolVersion, retainedInventoryProtocolVersion);
        assertEquals(headers.get("mcp-session-id"), null);
        return Promise.resolve({
          ok: true,
          value: Response.json({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: retainedInventoryProtocolVersion,
              serverInfo: { name: "Inventory", version: "1" },
              capabilities: { tools: {} },
            },
          }, { headers: { "Mcp-Session-Id": "fixture-session" } }),
        });
      }
      assertEquals(headers.get("mcp-session-id"), "fixture-session");
      assertEquals(
        headers.get("mcp-protocol-version"),
        retainedInventoryProtocolVersion,
      );
      if (method === "notifications/initialized") {
        return Promise.resolve({
          ok: true,
          value: new Response(null, { status: 202 }),
        });
      }
      if (method === "tools/list") {
        return Promise.resolve({
          ok: true,
          value: Response.json({
            jsonrpc: "2.0",
            id,
            result: { tools: [{ name: "list_assets" }] },
          }),
        });
      }
      assertEquals(params.name, "list_assets");
      assertEquals(params.arguments, { pageIndex: 1 });
      const data = {
        jsonrpc: "2.0",
        id,
        ...(replyKind === "error"
          ? { error: { code: -32000, message: key } }
          : {
            result: {
              content: [{
                type: "text",
                text: replyKind === "echo" ? key : "retained",
              }],
            },
          }),
      };
      if (replyKind === "revoked") key = undefined;
      return Promise.resolve({
        ok: true,
        value: new Response(
          `: keepalive\r\n\r\ndata: ${JSON.stringify(data)}\r\n\r\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      });
    },
  );
  const client = createMcpClient(
    transport,
    500,
    undefined,
    retainedInventoryProtocolVersion,
  );
  try {
    remainingCalls = 4;
    assertEquals((await client.initialize()).serverInfo.name, "Inventory");
    assertEquals((await client.listTools()).map(({ name }) => name), [
      "list_assets",
    ]);
    key = "fixture-private-key-two";
    assertEquals(
      (await client.callTool("list_assets", {
        pageIndex: 1,
      })).content[0].text,
      "retained",
    );
    assertEquals(remainingCalls, 0);
    for (const kind of ["echo", "error"] as const) {
      replyKind = kind;
      remainingCalls++;
      const error = await assertRejects(
        () => client.callTool("list_assets", { pageIndex: 1 }),
        Error,
        "Retained inventory MCP is unavailable.",
      );
      assert(!error.message.includes(key));
    }
    await assertRejects(() => client.callTool("delete_asset", {}));
    replyKind = "revoked";
    remainingCalls++;
    await assertRejects(() => client.callTool("list_assets", { pageIndex: 1 }));
    await assertRejects(() => client.callTool("list_assets", { pageIndex: 1 }));
    assertEquals(remainingCalls, 0);
  } finally {
    await transport.disconnect();
  }
});

Deno.test("Retained inventory authentication is restricted to exact classified HTTPS configuration", () => {
  const ref = "keychain:operator/scope-inventory";
  const url = "https://inventory.example/mcp";
  assertEquals(
    parseRetainedInventoryEndpoint("scopesentry", url, ref, "INTERNAL"),
    {
      url,
      secretName: "operator/scope-inventory",
    },
  );
  for (
    const [id, endpoint, reference, classification] of [
      ["other", url, ref, "INTERNAL"],
      ["scopesentry", url, "raw-key", "INTERNAL"],
      ["scopesentry", url, "secret:pre-resolved", "INTERNAL"],
      ["scopesentry", url, ref, "CONFIDENTIAL"],
      ["scopesentry", "http://inventory.example/mcp", ref, "INTERNAL"],
      ["scopesentry", "https://inventory.example/mcp?key=abc", ref, "INTERNAL"],
      ["scopesentry", "https://user@inventory.example/mcp", ref, "INTERNAL"],
    ] as const
  ) {
    assertEquals(
      parseRetainedInventoryEndpoint(id, endpoint, reference, classification),
      undefined,
    );
  }
});
