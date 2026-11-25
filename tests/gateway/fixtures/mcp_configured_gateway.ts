import { join } from "@std/path";
import { createProviderRegistry } from "../../../src/agent/llm.ts";
import { loadConfigWithSecrets } from "../../../src/core/config.ts";
import { initLogger } from "../../../src/core/logger/mod.ts";
import { createPolicyEngine } from "../../../src/core/policy/engine.ts";
import { createHookRunner } from "../../../src/core/policy/hooks/hooks.ts";
import { createMemorySecretStore } from "../../../src/core/secrets/mod.ts";
import { createLineageStore } from "../../../src/core/session/mod.ts";
import { createMemoryStorage } from "../../../src/core/storage/memory.ts";
import type { ClassificationLevel } from "../../../src/core/types/classification.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../../src/core/types/session.ts";
import { createChatSession } from "../../../src/gateway/chat.ts";
import { createGatewayServer } from "../../../src/gateway/server/server.ts";
import { wireMcpServers } from "../../../src/gateway/startup/infra/mcp.ts";
import { getMcpManageToolDefinitions } from "../../../src/gateway/tools/defs/mcp_manage_defs.ts";
import { createMcpManageExecutor } from "../../../src/gateway/tools/executor/executor_mcp_manage.ts";

const [dir, token] = Deno.args;
const configPath = join(dir, "triggerfish.yaml");
initLogger({ level: "WARN", console: false });
const session = createSession({
  userId: "owner" as UserId,
  channelId: "mcp-reload-test" as ChannelId,
});
const secretStore = createMemorySecretStore();
await secretStore.setSecret("fixture-mcp-key", "fixture-mcp-private-value");
const config = await loadConfigWithSecrets(configPath, secretStore);
if (!config.ok) throw new Error(config.error);
const servers = config.value.mcp?.servers ?? config.value.mcp_servers;
if (!servers) throw new Error("The MCP fixture configuration has no servers.");
const hookRunner = createHookRunner(createPolicyEngine());
const toolClassifications = new Map<string, ClassificationLevel>();
const integrationClassifications = new Map<string, ClassificationLevel>();
const wiring = wireMcpServers(
  servers,
  hookRunner,
  () => session,
  toolClassifications,
  integrationClassifications,
  { chatSession: null, gatewayServer: null, tidepoolHost: null },
  secretStore,
  createLineageStore(createMemoryStorage()),
);
const deadline = performance.now() + 8_000;
while (
  !wiring.getToolDefinitions().some(({ name }) =>
    name === "mcp_inventory_check"
  ) ||
  !wiring.manager.getStatus().some(({ id, state }) =>
    id === "retry_probe" && state === "failed"
  )
) {
  if (performance.now() > deadline) {
    throw new Error("MCP fixture did not settle.");
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const registry = createProviderRegistry();
registry.register({
  name: "configured-mcp-fixture",
  supportsStreaming: false,
  complete(messages, definitions) {
    const usage = { inputTokens: 1, outputTokens: 1 };
    const last = messages.at(-1);
    if (last?.role === "tool") {
      return Promise.resolve({
        content: `Fixture result: ${String(last.content)}`,
        toolCalls: [],
        usage,
      });
    }
    const request = String(last?.content);

    const toolsServer = request === "List inventory tools"
      ? "inventory"
      : request === "List retry probe tools"
      ? "retry_probe"
      : undefined;
    const manage = request === "Update inventory timeout" ||
      request === "Update retry limit" || toolsServer !== undefined;
    const name = manage ? "mcp_manage" : "mcp_inventory_check";
    if (
      !definitions?.some((definition) =>
        (definition as { function?: { name: string } }).function?.name === name
      )
    ) throw new Error("Expected MCP tool was not registered.");
    const args = request === "Update inventory timeout"
      ? {
        action: "update",
        server_id: "inventory",
        tool_call_timeout_ms: 1_000,
      }
      : request === "Update retry limit"
      ? { action: "update", server_id: "retry_probe", max_retries: 1 }
      : toolsServer
      ? { action: "tools", server_id: toolsServer }
      : { slow: request === "Read slow inventory" };
    return Promise.resolve({
      content: "",
      toolCalls: [{
        type: "function",
        id: crypto.randomUUID(),
        function: { name, arguments: JSON.stringify(args) },
      }],
      usage,
    });
  },
});
registry.setDefault("configured-mcp-fixture");
const manage = createMcpManageExecutor({
  configPath,
  getConfirmPrompt: () => () => Promise.resolve(true),
  getConnectorTools: wiring.getConnectorTools,
});
const gateway = createGatewayServer({
  port: 0,
  token,
  chatSession: createChatSession({
    session,
    providerRegistry: registry,
    hookRunner,
    enableStreaming: false,
    targetClassification: "CONFIDENTIAL",
    tools: getMcpManageToolDefinitions(),
    getExtraTools: wiring.getToolDefinitions,
    toolClassifications,
    integrationClassifications,
    async toolExecutor(name, args, context) {
      return await manage(name, args, context) ??
        await wiring.executor?.(name, args) ?? "Unknown MCP tool";
    },
  }),
});
const { port } = await gateway.start();
console.log(JSON.stringify({ port }));
const stop = new Uint8Array(1);
await Deno.stdin.read(stop);
await gateway.stop();
await wiring.manager.disconnectAll();
Deno.exit(0);
