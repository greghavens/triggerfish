import { createInterface } from "node:readline";
import { stdin } from "node:process";
import {
  fixtureInventoryCredential,
  fixtureInventoryResult,
} from "./scopesentry_inventory_responses.ts";

for await (const line of createInterface({ input: stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "tools/call") {
    Deno.writeTextFileSync(
      Deno.args[0],
      JSON.stringify(params.arguments) + "\n",
      {
        append: true,
      },
    );
  }
  const result = fixtureInventoryResult(
    method,
    params,
    Deno.env.get("CONNECTOR_CREDENTIAL") === fixtureInventoryCredential,
    "2024-11-05",
  );
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
