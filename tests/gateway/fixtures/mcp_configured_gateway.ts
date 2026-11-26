import { join } from "@std/path";
import { createProviderRegistry } from "../../../src/agent/llm.ts";
import { loadConfigWithSecrets } from "../../../src/core/config.ts";
import { initLogger } from "../../../src/core/logger/mod.ts";
import { createPolicyEngine } from "../../../src/core/policy/engine.ts";
import {
  createDefaultRules,
  createHookRunner,
} from "../../../src/core/policy/hooks/hooks.ts";
import { createToolApprovalService } from "../../../src/core/tool_approval_service.ts";
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
import { getConfigManageToolDefinitions } from "../../../src/gateway/tools/defs/config_manage_defs.ts";
import { getMcpManageToolDefinitions } from "../../../src/gateway/tools/defs/mcp_manage_defs.ts";
import { createConfigManageExecutor } from "../../../src/gateway/tools/executor/executor_config_manage.ts";
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
const engine = createPolicyEngine();
for (const rule of createDefaultRules()) engine.addRule(rule);
const baseHooks = createHookRunner(engine);
const hookRunner: typeof baseHooks = {
  ...baseHooks,
  toolApprovalInbox: createToolApprovalService(join(dir, "tool-approvals.db")),
  evaluateHook(hook, context) {
    if (hook === "PRE_TOOL_CALL" && context.input.mcp_lifecycle_action) {
      try {
        if (Deno.lstatSync(join(dir, "deny-lifecycle")).isFile) {
          return Promise.resolve({
            allowed: false,
            action: "BLOCK",
            ruleId: "fixture.revoked",
            duration: 0,
          });
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    if (
      (hook === "POST_TOOL_RESPONSE" &&
        context.input.tool_name === "mcp_manage") ||
      hook === "PRE_OUTPUT"
    ) {
      try {
        const block = hook === "PRE_OUTPUT"
          ? "deny-catalog-output"
          : "deny-catalog-response";
        if (Deno.lstatSync(join(dir, block)).isFile) {
          if (
            hook === "POST_TOOL_RESPONSE" &&
            context.session.taint !== "CONFIDENTIAL"
          ) {
            throw new Error(
              "Connector catalog was not classified before response policy.",
            );
          }
          return Promise.resolve({
            allowed: false,
            action: "BLOCK",
            ruleId: "fixture.refresh.output",
            duration: 0,
          });
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    const tool = context.input.tool_call as
      | { name: string; args: Record<string, unknown> }
      | undefined;
    if (
      hook === "PRE_TOOL_CALL" && tool?.name === "mcp_manage" &&
      tool.args.action === "refresh_tools"
    ) {
      try {
        if (Deno.lstatSync(join(dir, "deny-catalog")).isFile) {
          return Promise.resolve({
            allowed: false,
            action: "BLOCK",
            ruleId: "fixture.refresh.revoked",
            duration: 0,
          });
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    return baseHooks.evaluateHook(hook, context);
  },
};
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
  (servers.inventory && servers.inventory.enabled !== false &&
    !wiring.getToolDefinitions().some(({ name }) =>
      name === "mcp_inventory_check"
    )) ||
  (servers.retry_probe &&
    !wiring.manager.getStatus().some(({ id, state }) =>
      id === "retry_probe" && state === "failed"
    ))
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
    const lifecycle =
      /^(Disable|Enable|Remove|Add|Replace) inventory ([a-f0-9]{64})$/
        .exec(
          request,
        );
    const forceUnavailable = request === "Call omitted tool" ||
      request === "Call unreviewed tool";
    const refresh = request === "Refresh inventory tools";
    const manage = refresh || request === "Update inventory timeout" ||
      request === "Update retry limit" || toolsServer !== undefined ||
      request === "Review inventory lifecycle" ||
      request === "Review inventory creation" ||
      request === "Review inventory replacement" ||
      request === "Add with raw transport" ||
      request === "Replace with raw transport" || lifecycle !== null;
    const configKey = new Map([
      ["Write raw MCP config", "mcp.servers.raw.command"],
      ["Write raw legacy MCP config", "mcp_servers.raw.command"],
      ["Write recovery grants", "agent_recovery.github_repositories"],
      ["Write Sentinel read grants", "sentinel.scheduled_observation_reads"],
      ["Replace Sentinel config", "sentinel"],
    ]).get(request);
    const name = configKey
      ? "config_manage"
      : manage
      ? "mcp_manage"
      : request === "Call unreviewed tool"
      ? "mcp_inventory_unreviewed"
      : "mcp_inventory_check";
    const advertised = definitions?.some((definition) =>
      (definition as { function?: { name: string } }).function?.name === name
    );
    if (forceUnavailable ? advertised : !advertised) {
      throw new Error("Unexpected MCP tool registration.");
    }
    const args = configKey
      ? { action: "set", key: configKey, value: "fixture" }
      : refresh
      ? { action: "refresh_tools", server_id: "inventory" }
      : request === "Update inventory timeout"
      ? {
        action: "update",
        server_id: "inventory",
        tool_call_timeout_ms: 1_000,
      }
      : request === "Update retry limit"
      ? { action: "update", server_id: "retry_probe", max_retries: 1 }
      : toolsServer
      ? { action: "tools", server_id: toolsServer }
      : request === "Review inventory lifecycle"
      ? { action: "lifecycle_status", server_id: "inventory" }
      : request === "Review inventory creation" ||
          request === "Review inventory replacement"
      ? { action: "creation_status", server_id: "inventory" }
      : request === "Add with raw transport"
      ? { action: "add", server_id: "raw", command: "node" }
      : request === "Replace with raw transport"
      ? { action: "replace", server_id: "inventory", command: "node" }
      : lifecycle
      ? {
        action: lifecycle[1].toLowerCase(),
        server_id: "inventory",
        lifecycle_revision: lifecycle[2],
      }
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
  listCredentialNames: () => secretStore.listSecrets(),
  getConfirmPrompt: () => async (message) => {
    if (message.startsWith("Refresh tool availability")) {
      try {
        if (Deno.lstatSync(join(dir, "revoke-catalog-on-review")).isFile) {
          await Deno.writeTextFile(join(dir, "deny-catalog"), "");
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    return true;
  },
  getConnectorTools: wiring.getConnectorTools,
  prepareToolRefresh: wiring.prepareToolRefresh,
});
const manageConfig = createConfigManageExecutor({ configPath });
const gateway = createGatewayServer({
  port: 0,
  token,
  chatSession: createChatSession({
    session,
    providerRegistry: registry,
    hookRunner,
    enableStreaming: false,
    targetClassification: "CONFIDENTIAL",
    tools: [
      ...getMcpManageToolDefinitions(),
      ...getConfigManageToolDefinitions(),
    ],
    getExtraTools: wiring.getToolDefinitions,
    toolClassifications,
    integrationClassifications,
    async toolExecutor(name, args, context) {
      return await manage(name, args, context) ??
        await manageConfig(name, args) ??
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
