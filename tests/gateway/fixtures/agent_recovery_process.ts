import { join } from "@std/path";
import { createProviderRegistry } from "../../../src/agent/llm.ts";
import { createMessageStore } from "../../../src/core/conversation/mod.ts";
import {
  createFileWriter,
  initAuditLog,
  initLogger,
  shutdownAuditLog,
  shutdownLogger,
} from "../../../src/core/logger/mod.ts";
import { createPolicyEngine } from "../../../src/core/policy/engine.ts";
import { createHookRunner } from "../../../src/core/policy/hooks/hooks.ts";
import { createMemorySecretStore } from "../../../src/core/secrets/keychain/keychain.ts";
import { createMemoryStorage } from "../../../src/core/storage/memory.ts";
import {
  type ChannelId,
  restoreSession,
  type SessionId,
  type UserId,
} from "../../../src/core/types/session.ts";
import { runRecoverableAgentTurn } from "../../../src/gateway/agent_recovery.ts";
import { createChatSession } from "../../../src/gateway/chat.ts";
import { createGatewayServer } from "../../../src/gateway/server/server.ts";
import { createWorkflowRecoveryPolicy } from "../../../src/gateway/workflow_recovery_policy.ts";
import { resolveGitHubToken } from "../../../src/integrations/github/auth.ts";

const [dir, mode, sessionId, token] = Deno.args;
const fixtureSecret = Deno.env.get("TRIGGERFISH_RECOVERY_FIXTURE_SECRET");
if (!dir || !fixtureSecret || !sessionId || !token) {
  throw new Error("Missing fixture input");
}
const repo = "fixture-owner/fixture-repo";
const secrets = createMemorySecretStore();
await secrets.setSecret("github-pat", fixtureSecret);
const credential = () => resolveGitHubToken({ secretStore: secrets });
await initAuditLog({ logDir: dir });
initLogger({
  level: "TRACE",
  console: false,
  fileWriter: await createFileWriter({ logDir: dir, baseName: "gateway" }),
});
const registry = createProviderRegistry();
const usage = { inputTokens: 1, outputTokens: 1 };
registry.register({
  name: "fixture",
  supportsStreaming: false,
  async complete(messages) {
    if (
      messages.some(({ content }) =>
        typeof content === "string" &&
        content.includes(
          '{"runs":[{"id":42,"status":"completed","conclusion":"success"}]}',
        )
      )
    ) {
      if (mode === "interrupt") {
        // The shared loop awaits the durable batch callback before calling us.
        console.log("CHECKPOINT_SAVED");
        await new Promise(() => {});
      }
      return {
        content: "Restored the exact workflow status.",
        toolCalls: [],
        usage,
      };
    }
    return {
      content: "",
      usage,
      toolCalls: [{
        type: "function",
        id: "fixture_call",
        function: {
          name: "github_actions",
          arguments: JSON.stringify({ action: "list_runs", repo }),
        },
      }],
    };
  },
});
registry.setDefault("fixture");
const session = restoreSession({
  id: sessionId as SessionId,
  userId: "owner" as UserId,
  channelId: "process-fixture" as ChannelId,
});
const policy = createWorkflowRecoveryPolicy({
  repositories: [repo],
  classification: () => "INTERNAL",
  authorizeRepository: async (name) => name === repo && (await credential()).ok,
});
const server = createGatewayServer({
  port: 0,
  token,
  chatSession: createChatSession({
    session,
    providerRegistry: registry,
    hookRunner: createHookRunner(createPolicyEngine()),
    enableStreaming: false,
    messageStore: createMessageStore(createMemoryStorage()),
    tools: [{
      name: "github_actions",
      description: "Read status.",
      parameters: {},
    }],
    async toolExecutor() {
      const supplied = await credential();
      if (!supplied.ok) return "Credential unavailable";
      await Deno.writeTextFile(join(dir, "calls"), "read\n", { append: true });
      return JSON.stringify({
        runs: [{ id: 42, status: "completed", conclusion: "success" }],
        credential: supplied.value,
      });
    },
    recoverAgentTurn: (id, orchestrator, options) =>
      runRecoverableAgentTurn(
        join(dir, "agent-recovery.db"),
        id,
        policy,
        orchestrator,
        options,
      ),
  }),
});
const stop = Promise.withResolvers<void>();
Deno.addSignalListener("SIGTERM", stop.resolve);
const { port } = await server.start();
console.log(`PORT ${port}`);
await stop.promise;
await server.stop();
await shutdownAuditLog();
await shutdownLogger();
