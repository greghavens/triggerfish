/** Local JSON-RPC stdio server for the configured connector restart fixture. */
import { createInterface } from "node:readline";
import { stdin } from "node:process";

const [kind, retryLog] = Deno.args;
const input = createInterface({ input: stdin });
for await (const line of input) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  if (kind === "retry" && method === "initialize") {
    await Deno.writeTextFile(retryLog, "attempt\n", { append: true });
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: "Fixture connection rejected" },
    }));
    break;
  }
  let result: unknown;
  if (method === "initialize") {
    result = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "configured-fixture", version: "1" },
    };
  } else if (method === "tools/list") {
    result = {
      tools: [{
        name: "check",
        description: "Read fixture inventory.",
        inputSchema: {
          type: "object",
          properties: { slow: { type: "boolean" } },
        },
      }],
    };
  } else if (method === "tools/call") {
    if (params.arguments.slow) {
      await new Promise((resolve) => setTimeout(resolve, 1_450));
    }
    result = {
      content: [{
        type: "text",
        text: Deno.env.get("MCP_FIXTURE_CREDENTIAL") ===
            "fixture-mcp-private-value"
          ? (kind === "inventory-v2"
            ? "Replacement inventory is available."
            : "Configured inventory is available.")
          : "Configured credential is unavailable.",
      }],
    };
  }
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
