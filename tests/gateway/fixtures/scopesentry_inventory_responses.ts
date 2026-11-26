export interface FixtureInventoryToolCall {
  readonly name?: string;
  readonly arguments?: {
    readonly asset_type?: string;
    readonly filter?: { readonly project?: string[]; readonly task?: string[] };
    readonly pageIndex?: number;
    readonly pageSize?: number;
  };
}
export const fixtureInventoryCredential = "synthetic-inventory-fixture";

export function fixtureInventoryResult(
  method: string,
  params: FixtureInventoryToolCall,
  authorized: boolean,
  protocolVersion: string,
): unknown {
  if (method === "initialize") {
    return {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "scopesentry-fixture", version: "1" },
    };
  } else if (method === "tools/list") {
    return {
      tools: ["list_assets", "list_projects_data", "list_tasks"].map((
        name,
      ) => ({
        name,
        description: "Read retained inventory metadata.",
        inputSchema: { type: "object" },
      })),
    };
  } else if (method === "tools/call") {
    const { asset_type, filter, pageIndex, pageSize } = params.arguments ?? {};
    if (params.name !== "list_assets") {
      const page = !authorized || pageSize !== 50 || pageIndex !== 1 ? [] : [{
        id: "0123456789abcdef01234567",
        name: params.name === "list_tasks" ? "Fiber verification" : "Fiber",
        extra: "private fixture field",
      }];
      const data = params.name === "list_tasks"
        ? { list: page }
        : { result: { All: page } };
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }
    const selected = filter?.project?.[0] === "0123456789abcdef01234567" ||
      filter?.task?.[0] === "Fiber verification";
    const list = !selected || !authorized || pageSize !== 100 || pageIndex !== 1
      ? []
      : asset_type === "subdomain"
      ? [{ host: "public.safe.example", type: "A" }, {
        host: "unrelated.example",
      }]
      : asset_type === "asset"
      ? [
        {
          url: "https://api.safe.example/",
          status: 204,
          products: ["Fixture"],
        },
        { url: "https://unrelated.example/", domain: "safe.example" },
      ]
      : [{
        name: "Fiber client",
        icp: "fixture-registration",
        category: "Operator application",
      }];
    return { content: [{ type: "text", text: JSON.stringify({ list }) }] };
  }
  return {};
}
