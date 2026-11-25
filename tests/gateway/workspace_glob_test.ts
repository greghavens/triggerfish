import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { mapToolPrefixClassifications } from "../../src/agent/orchestrator/classification_map.ts";
import type { HookType } from "../../src/core/policy/rules.ts";
import { createPathClassifier } from "../../src/core/security/path_classification.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createFilesystemSandbox } from "../../src/exec/sandbox/client.ts";
import { createExecTools } from "../../src/exec/tools.ts";
import { createWorkspace } from "../../src/exec/workspace.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { resolveToolsForProfile } from "../../src/gateway/tools/agent_tools.ts";
import { createToolExecutor } from "../../src/gateway/tools/executor/executor.ts";

Deno.test("Gateway glob ranks workspace-relative matches and prevents path and policy disclosure", async () => {
  const directory = await Deno.makeTempDir();
  const workspace = await createWorkspace({
    basePath: directory,
    agentId: "glob-workspace",
  });
  const root = workspace.publicPath;
  await Deno.mkdir(join(root, "src", "deep"), { recursive: true });
  await Deno.mkdir(join(root, "classified"));
  const outside = join(directory, "other");
  await Deno.mkdir(outside);
  await Deno.writeTextFile(
    join(outside, "outside-only.txt"),
    "Protected outside contents",
  );
  await Deno.symlink(outside, join(root, "alias"));
  await Deno.symlink(join(root, "old.txt"), join(root, "alias.txt"));
  const timestamps = {
    "old.txt": 1,
    "src/middle.txt": 2,
    "src/deep/latest.txt": 3,
    "src/.hidden.txt": 4,
    "classified/private.txt": 5,
    "triggerfish.yaml": 6,
  };
  for (const [file, order] of Object.entries(timestamps)) {
    const path = join(root, file);
    await Deno.writeTextFile(path, "File contents must not be returned.");
    const time = new Date(Date.UTC(2026, 0, order));
    await Deno.utime(path, time, time);
  }
  const sandbox = createFilesystemSandbox({ resolveWorkspacePath: () => root });
  const execute = createToolExecutor({
    execTools: createExecTools(workspace),
    filesystemSandbox: sandbox,
  });
  const registry = createProviderRegistry();
  let args: Record<string, unknown> = {};
  let observed = "";
  let calls = 0;
  let deny: HookType | undefined;
  const responseLevels: string[] = [];
  registry.register({
    name: "glob-fixture",
    supportsStreaming: false,
    complete(messages, definitions) {
      const last = messages.at(-1);
      const tool = last?.role === "tool" ? last : undefined;
      if (tool) observed = String(tool.content);
      else {assert(
          definitions?.some((item) =>
            (item as { function?: { name: string } }).function?.name ===
              "glob_files"
          ),
        );}
      return Promise.resolve({
        content: tool ? "Workspace discovery complete." : "",
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: tool ? [] : [{
          type: "function",
          id: crypto.randomUUID(),
          function: { name: "glob_files", arguments: JSON.stringify(args) },
        }],
      });
    },
  });
  registry.setDefault("glob-fixture");
  const chat = createChatSession({
    session: createSession({
      userId: "owner" as UserId,
      channelId: "fixture" as ChannelId,
    }),
    providerRegistry: registry,
    enableStreaming: false,
    tools: resolveToolsForProfile("cli").filter(({ name }) =>
      name === "glob_files"
    ),
    toolClassifications: mapToolPrefixClassifications({}).all,
    getWorkspacePath: () => root,
    pathClassifier: createPathClassifier(
      {
        defaultClassification: "PUBLIC",
        paths: new Map([[
          join(root, "classified", "private.txt"),
          "RESTRICTED",
        ]]),
      },
      undefined,
      { resolveCwd: () => root },
    ),
    hookRunner: {
      evaluateHook(hook, input) {
        if (hook === "POST_TOOL_RESPONSE") {
          responseLevels.push(input.session.taint);
        }
        return Promise.resolve({
          allowed: hook !== deny,
          action: hook !== deny ? "ALLOW" : "BLOCK",
          ruleId: null,
          duration: 0,
        });
      },
    },
    toolExecutor(name, data, context) {
      calls++;
      return execute(name, data, context);
    },
  });
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({ port: 0, token, chatSession: chat });
  const { port } = await gateway.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = reject;
    });
    const turn = async (input: Record<string, unknown>) => {
      args = { path: ".", ...input };
      observed = "";
      const events: string[] = [];
      const done = Promise.withResolvers<void>();
      const listener = ({ data }: MessageEvent) => {
        events.push(String(data));
        if (JSON.parse(data).type === "turn_end") done.resolve();
      };
      socket.addEventListener("message", listener);
      const timer = setTimeout(
        () => done.reject(new Error("Glob gateway timeout")),
        3000,
      );
      try {
        socket.send(
          JSON.stringify({
            type: "message",
            content: "Find files in the workspace.",
          }),
        );
        await done.promise;
        return { result: observed, events: events.join("\n") };
      } finally {
        socket.removeEventListener("message", listener);
        clearTimeout(timer);
      }
    };
    deny = "PRE_TOOL_CALL";
    await turn({ pattern: "**/*.txt" });
    assertEquals(calls, 0);
    deny = undefined;
    const glob = await turn({ pattern: "./**/*.txt", limit: 3 });
    const page = JSON.parse(glob.result);
    assertEquals(page.files.map(({ path }: { path: string }) => path), [
      "classified/private.txt",
      "src/deep/latest.txt",
      "src/middle.txt",
    ]);
    assertEquals(page.truncated, true);
    assertEquals(page._classification, "RESTRICTED");
    assertEquals(responseLevels.at(-1), "RESTRICTED");
    assert(!glob.result.includes("File contents"));
    assert(!glob.result.includes(outside));
    assertEquals(
      JSON.parse((await turn({ path: "src", pattern: ".h?dden.txt" })).result)
        .files[0].path,
      "src/.hidden.txt",
    );
    for (const pattern of ["**/[l-m]*.txt", "**/[!op]*.txt"]) {
      const matched = JSON.parse((await turn({ path: "src", pattern })).result);
      assertEquals(matched.files.map(({ path }: { path: string }) => path), [
        "src/deep/latest.txt",
        "src/middle.txt",
      ]);
    }
    assertStringIncludes(
      (await turn({ pattern: "**/[m-l]*.txt" })).result,
      "Invalid glob character class.",
    );
    assertStringIncludes(
      (await turn({ pattern: "../*.txt" })).result,
      "relative",
    );
    assertStringIncludes(
      (await turn({ path: outside, pattern: "**" })).result,
      "outside",
    );
    assertStringIncludes(
      (await turn({ path: "alias", pattern: "**" })).result,
      "canonical",
    );
    const broad = JSON.parse((await turn({ pattern: "**" })).result);
    assertEquals(broad.files.map(({ path }: { path: string }) => path), [
      "classified/private.txt",
      "src/deep/latest.txt",
      "src/middle.txt",
      "old.txt",
    ]);
    deny = "POST_TOOL_RESPONSE";
    assertEquals(
      (await turn({ pattern: "**/*.txt" })).result,
      "Tool response withheld by policy.",
    );
    deny = "PRE_OUTPUT";
    const blocked = await turn({ pattern: "**/*.txt" });
    assert(!blocked.events.includes("private.txt"));
    assert(!blocked.events.includes("Workspace discovery complete."));
    deny = undefined;
    const sent: unknown[] = [];
    await chat.registerChannel("fixture", {
      channelName: "Fixture",
      classification: "PUBLIC",
      userClassifications: { public: "PUBLIC" },
      adapter: {
        classification: "PUBLIC",
        isOwner: false,
        status: () => ({ connected: true, channelType: "fixture" }),
        connect: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
        send(message) {
          sent.push(message);
          return Promise.resolve();
        },
        onMessage() {},
      },
    });
    args = { path: ".", pattern: "**/*.txt" };
    observed = "";
    await chat.handleChannelMessage({
      content: "Find files.",
      sessionId: "fixture-public",
      senderId: "public",
      isOwner: false,
    }, "fixture");
    const publicPage = JSON.parse(observed);
    assertEquals(publicPage._classification, "PUBLIC");
    assertEquals(publicPage.files.map(({ path }: { path: string }) => path), [
      "src/deep/latest.txt",
      "src/middle.txt",
      "old.txt",
    ]);
    assert(sent.length > 0);
  } finally {
    socket.close();
    await gateway.stop();
    await sandbox.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
});
