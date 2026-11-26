import { createInterface } from "node:readline";
import { stdin } from "node:process";

for await (const line of createInterface({ input: stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  let result: unknown;
  if (method === "initialize") {
    result = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "scopesentry-fixture", version: "1" },
    };
  } else if (method === "tools/list") {
    result = {
      tools: [{
        name: "list_assets",
        description: "Read retained assets for one exact source.",
        inputSchema: { type: "object" },
      }],
    };
  } else if (method === "tools/call") {
    const { asset_type, filter, pageIndex, pageSize } = params.arguments;
    Deno.writeTextFileSync(
      Deno.args[0],
      JSON.stringify(params.arguments) + "\n",
      { append: true },
    );
    const selected = filter.project?.[0] === "0123456789abcdef01234567" ||
      filter.task?.[0] === "Fiber verification";
    const authorized =
      Deno.env.get("CONNECTOR_CREDENTIAL") === "synthetic-inventory-fixture";
    const list = !selected || !authorized || pageSize !== 100 || pageIndex !== 1
      ? []
      : asset_type === "subdomain"
      ? [{ host: "public.safe.example" }, { host: "unrelated.example" }]
      : asset_type === "asset"
      ? [
        {
          url: "https://api.safe.example/",
          status: 204,
          products: ["Fixture"],
        },
        { url: "https://unrelated.example/", domain: "safe.example" },
      ]
      : [{ name: "Fiber client", icp: "fixture-registration" }];
    result = { content: [{ type: "text", text: JSON.stringify({ list }) }] };
  }
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
