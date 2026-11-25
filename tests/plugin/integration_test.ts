/**
 * Integration tests for the plugin build→scan→load→call flow.
 *
 * These tests write real plugin code to temp directories, scan it,
 * load it via the plugin tools, and call the resulting tools.
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createPluginRegistry } from "../../src/plugin/registry.ts";
import { createPluginToolExecutor } from "../../src/plugin/tools.ts";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { HookType } from "../../src/core/policy/rules.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { buildExtraToolsGetter } from "../../src/gateway/startup/tools/tool_executor.ts";
import { scanPluginDirectory } from "../../src/plugin/scanner.ts";
import { createPluginExecutor } from "../../src/plugin/executor.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";

/** Plugin source that exports two tools: greet and add. */
const VALID_PLUGIN_SOURCE = `
export const manifest = {
  name: "test-math",
  version: "1.0.0",
  description: "A test plugin with math tools",
  classification: "PUBLIC",
  trust: "trusted",
  declaredEndpoints: [],
};

export const toolDefinitions = [
  {
    name: "greet",
    description: "Returns a greeting",
    parameters: {
      name: { type: "string", description: "Name to greet", required: true },
    },
  },
  {
    name: "add",
    description: "Adds two numbers",
    parameters: {
      a: { type: "number", description: "First number", required: true },
      b: { type: "number", description: "Second number", required: true },
    },
  },
];

export const systemPrompt = "Use greet and add tools for testing.";

export function createExecutor(_context) {
  return async (name, input) => {
    switch (name) {
      case "greet":
        return "Hello, " + input.name + "!";
      case "add":
        return String(Number(input.a) + Number(input.b));
      default:
        return null;
    }
  };
}
`;

/** Plugin source with eval() — should fail security scan. */
const MALICIOUS_PLUGIN_SOURCE = `
export const manifest = {
  name: "evil",
  version: "1.0.0",
  description: "Tries to eval",
  classification: "PUBLIC",
  trust: "trusted",
  declaredEndpoints: [],
};

export const toolDefinitions = [
  { name: "run", description: "Runs code", parameters: {} },
];

export function createExecutor() {
  return async (name, input) => {
    return eval(input.code);
  };
}
`;

/** Updated plugin source for reload testing — changes greet output. */
const UPDATED_PLUGIN_SOURCE = `
export const manifest = {
  name: "test-math",
  version: "2.0.0",
  description: "Updated test plugin",
  classification: "PUBLIC",
  trust: "trusted",
  declaredEndpoints: [],
};

export const toolDefinitions = [
  {
    name: "greet",
    description: "Returns an updated greeting",
    parameters: {
      name: { type: "string", description: "Name to greet", required: true },
    },
  },
  {
    name: "add",
    description: "Adds two numbers",
    parameters: {
      a: { type: "number", description: "First number", required: true },
      b: { type: "number", description: "Second number", required: true },
    },
  },
];

export function createExecutor(_context) {
  return async (name, input) => {
    switch (name) {
      case "greet":
        return "Hey there, " + input.name + "!";
      case "add":
        return String(Number(input.a) + Number(input.b));
      default:
        return null;
    }
  };
}
`;

/** Write a plugin mod.ts into the plugins root and return its directory. */
async function writePluginToDir(
  pluginsRoot: string,
  source: string,
  dirName: string,
): Promise<string> {
  const dir = `${pluginsRoot}/${dirName}`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/mod.ts`, source);
  return dir;
}

/**
 * Run a test body with HOME pointed at a temp dir containing a plugins root.
 * plugin_install is jailed to ~/.triggerfish/plugins, so integration tests
 * must place plugins inside a controlled plugins root.
 */
async function withPluginsRoot(
  fn: (pluginsRoot: string) => Promise<void>,
): Promise<void> {
  const origHome = Deno.env.get("HOME");
  const home = await Deno.makeTempDir({ prefix: "plugin-integ-home-" });
  const pluginsRoot = `${home}/.triggerfish/plugins`;
  await Deno.mkdir(pluginsRoot, { recursive: true });
  Deno.env.set("HOME", home);
  try {
    await fn(pluginsRoot);
  } finally {
    if (origHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", origHome);
    await Deno.remove(home, { recursive: true });
  }
}

/** Create the full tool executor stack for integration testing. */
function createTestStack() {
  const registry = createPluginRegistry();
  const toolClassifications = new Map<string, ClassificationLevel>();
  const integrationClassifications = new Map<string, ClassificationLevel>();

  const pluginToolExecutor = createPluginToolExecutor({
    registry,
    getSessionTaint: () => "PUBLIC" as ClassificationLevel,
    pluginsConfig: {
      "test-math": { enabled: true, trust: "trusted" },
      "wrong-name": { enabled: true, trust: "trusted" },
      evil: { enabled: true, trust: "trusted" },
    },
    toolClassifications,
    integrationClassifications,
    scanPlugin: scanPluginDirectory,
  });

  const pluginExecutor = createPluginExecutor(registry);

  return { registry, pluginToolExecutor, pluginExecutor, toolClassifications };
}

Deno.test("integration: scan → install → call tools from disk", async () => {
  await withPluginsRoot(async (pluginsRoot) => {
    const dir = await writePluginToDir(
      pluginsRoot,
      VALID_PLUGIN_SOURCE,
      "test-math",
    );
    const stack = createTestStack();

    // Step 1: Scan the plugin
    const scanResult = await stack.pluginToolExecutor("plugin_scan", {
      path: dir,
    });
    const scan = JSON.parse(scanResult!);
    assertEquals(scan.ok, true, `Scan should pass: ${scanResult}`);

    // Step 2: Install the plugin
    const installResult = await stack.pluginToolExecutor("plugin_install", {
      name: "test-math",
      path: dir,
    });
    assertEquals(
      installResult!.includes("installed successfully"),
      true,
      `Install should succeed: ${installResult}`,
    );
    assertEquals(
      installResult!.includes("plugin_test-math_greet"),
      true,
      `Should list greet tool: ${installResult}`,
    );

    // Step 3: Verify plugin is listed
    const listResult = await stack.pluginToolExecutor("plugin_list", {});
    const list = JSON.parse(listResult!);
    assertEquals(list.length, 1);
    assertEquals(list[0].name, "test-math");
    assertEquals(list[0].version, "1.0.0");
    assertEquals(list[0].tools.length, 2);

    // Step 4: Call the greet tool via the plugin executor
    const greetResult = await stack.pluginExecutor(
      "plugin_test-math_greet",
      { name: "World" },
    );
    assertEquals(greetResult, "Hello, World!");

    // Step 5: Call the add tool
    const addResult = await stack.pluginExecutor(
      "plugin_test-math_add",
      { a: 3, b: 7 },
    );
    assertEquals(addResult, "10");

    // Step 6: Non-plugin tools return null
    const nullResult = await stack.pluginExecutor("web_search", { q: "test" });
    assertEquals(nullResult, null);
  });
});

Deno.test("integration: scan blocks malicious plugin", async () => {
  await withPluginsRoot(async (pluginsRoot) => {
    const dir = await writePluginToDir(
      pluginsRoot,
      MALICIOUS_PLUGIN_SOURCE,
      "evil",
    );
    const stack = createTestStack();

    // Scan should fail
    const scanResult = await stack.pluginToolExecutor("plugin_scan", {
      path: dir,
    });
    const scan = JSON.parse(scanResult!);
    assertEquals(scan.ok, false);
    assertEquals(scan.warnings.length > 0, true);

    // Install should also be blocked by the mandatory scan
    const installResult = await stack.pluginToolExecutor("plugin_install", {
      name: "evil",
      path: dir,
    });
    assertEquals(
      installResult!.includes("failed security scan"),
      true,
      `Install should be blocked: ${installResult}`,
    );

    // Registry should be empty
    const listResult = await stack.pluginToolExecutor("plugin_list", {});
    assertEquals(listResult, "No plugins are currently registered.");
  });
});

Deno.test("integration: reload hot-swaps plugin code", async () => {
  await withPluginsRoot(async (pluginsRoot) => {
    const dir = await writePluginToDir(
      pluginsRoot,
      VALID_PLUGIN_SOURCE,
      "test-math",
    );
    const stack = createTestStack();

    // Install v1
    const installResult = await stack.pluginToolExecutor("plugin_install", {
      name: "test-math",
      path: dir,
    });
    assertEquals(installResult!.includes("installed successfully"), true);

    // Call greet — should return v1 response
    const v1Result = await stack.pluginExecutor(
      "plugin_test-math_greet",
      { name: "Alice" },
    );
    assertEquals(v1Result, "Hello, Alice!");

    // Overwrite with v2 source
    await Deno.writeTextFile(`${dir}/mod.ts`, UPDATED_PLUGIN_SOURCE);

    // Reload
    const reloadResult = await stack.pluginToolExecutor("plugin_reload", {
      name: "test-math",
    });
    assertEquals(
      reloadResult!.includes("reloaded successfully"),
      true,
      `Reload should succeed: ${reloadResult}`,
    );

    // Call greet — should return v2 response
    const v2Result = await stack.pluginExecutor(
      "plugin_test-math_greet",
      { name: "Alice" },
    );
    assertEquals(v2Result, "Hey there, Alice!");

    // Verify version updated in list
    const listResult = await stack.pluginToolExecutor("plugin_list", {});
    const list = JSON.parse(listResult!);
    assertEquals(list[0].version, "2.0.0");
  });
});

Deno.test("integration: install rejects duplicate plugin name", async () => {
  await withPluginsRoot(async (pluginsRoot) => {
    const dir = await writePluginToDir(
      pluginsRoot,
      VALID_PLUGIN_SOURCE,
      "test-math",
    );
    const stack = createTestStack();

    // Install first time
    await stack.pluginToolExecutor("plugin_install", {
      name: "test-math",
      path: dir,
    });

    // Try to install again
    const result = await stack.pluginToolExecutor("plugin_install", {
      name: "test-math",
      path: dir,
    });
    assertEquals(result!.includes("already registered"), true);
  });
});

Deno.test("integration: install rejects name/manifest mismatch", async () => {
  await withPluginsRoot(async (pluginsRoot) => {
    const dir = await writePluginToDir(
      pluginsRoot,
      VALID_PLUGIN_SOURCE,
      "test-math",
    );
    const stack = createTestStack();

    // Install with wrong name (plugin manifest says "test-math")
    const result = await stack.pluginToolExecutor("plugin_install", {
      name: "wrong-name",
      path: dir,
    });
    assertEquals(
      result!.includes("does not match configured plugin directory"),
      true,
      `Should reject mismatch: ${result}`,
    );
  });
});

Deno.test("integration: classification injected on install", async () => {
  await withPluginsRoot(async (pluginsRoot) => {
    const dir = await writePluginToDir(
      pluginsRoot,
      VALID_PLUGIN_SOURCE,
      "test-math",
    );
    const stack = createTestStack();

    await stack.pluginToolExecutor("plugin_install", {
      name: "test-math",
      path: dir,
    });

    // Tool classifications should have the plugin prefix
    assertEquals(
      stack.toolClassifications.has("plugin_test-math_"),
      true,
    );
    assertEquals(
      stack.toolClassifications.get("plugin_test-math_"),
      "PUBLIC",
    );
  });
});

Deno.test("Owner gateway installs, discovers, invokes and reloads a configured plugin through root dispatch", async () => {
  await withPluginsRoot(async (pluginsRoot) => {
    const dir = await writePluginToDir(
      pluginsRoot,
      VALID_PLUGIN_SOURCE,
      "test-math",
    );
    const stack = createTestStack();
    const providers = createProviderRegistry();
    let operation = "";
    let args: Record<string, unknown> = {};
    let result = "";
    let deniedHook: HookType | undefined;
    let handlerCalls = 0;
    providers.register({
      name: "plugin-gateway-fixture",
      supportsStreaming: false,
      complete(messages, definitions) {
        const reply = messages.at(-1);
        const done = reply?.role === "tool";
        if (done) result = String(reply.content);
        else {
          assert(
            definitions?.some((definition) =>
              (definition as { function?: { name: string } }).function?.name ===
                operation
            ),
          );
        }
        return Promise.resolve({
          content: done ? "Plugin review complete." : "",
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: done ? [] : [{
            type: "function",
            id: crypto.randomUUID(),
            function: { name: operation, arguments: JSON.stringify(args) },
          }],
        });
      },
    });
    providers.setDefault("plugin-gateway-fixture");
    const token = crypto.randomUUID();
    const gateway = createGatewayServer({
      port: 0,
      token,
      chatSession: createChatSession({
        session: createSession({
          userId: "owner" as UserId,
          channelId: "plugin-gateway" as ChannelId,
        }),
        providerRegistry: providers,
        enableStreaming: false,
        targetClassification: "RESTRICTED",
        toolClassifications: stack.toolClassifications,
        getExtraTools: buildExtraToolsGetter(
          null,
          { value: false },
          { value: undefined },
          stack.registry,
        ),
        hookRunner: {
          evaluateHook(hook) {
            const allowed = hook !== deniedHook;
            return Promise.resolve({
              allowed,
              action: allowed ? "ALLOW" : "BLOCK",
              ruleId: null,
              duration: 0,
            });
          },
        },
        async toolExecutor(name, input) {
          handlerCalls++;
          return await stack.pluginToolExecutor(name, input) ??
            await stack.pluginExecutor(name, input) ?? "Unavailable";
        },
      }),
    });
    const { port } = await gateway.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      const turn = async (name: string, input: Record<string, unknown>) => {
        operation = name;
        args = input;
        result = "";
        const events: Record<string, unknown>[] = [];
        const end = Promise.withResolvers<void>();
        const receive = ({ data }: MessageEvent) => {
          const event = JSON.parse(data);
          events.push(event);
          if (event.type === "turn_end") end.resolve();
        };
        socket.addEventListener("message", receive);
        const timer = setTimeout(
          () => end.reject(new Error("Gateway turn timed out")),
          3000,
        );
        try {
          socket.send(
            JSON.stringify({ type: "message", content: "Review plugin." }),
          );
          await end.promise;
          return { result, events };
        } finally {
          clearTimeout(timer);
          socket.removeEventListener("message", receive);
        }
      };
      deniedHook = "PRE_TOOL_CALL";
      await turn("plugin_install", { name: "test-math", path: dir });
      assertEquals(handlerCalls, 0);
      assertEquals(stack.registry.getToolDefinitions(), []);
      deniedHook = undefined;
      assertStringIncludes(
        (await turn("plugin_install", { name: "test-math", path: dir })).result,
        "installed successfully",
      );
      assertEquals(
        (await turn("plugin_test-math_greet", { name: "World" })).result,
        "Hello, World!",
      );
      deniedHook = "POST_TOOL_RESPONSE";
      assertEquals(
        (await turn("plugin_test-math_greet", { name: "World" })).result,
        "Tool response withheld by policy.",
      );
      deniedHook = "PRE_OUTPUT";
      const deniedOutput = await turn("plugin_test-math_greet", {
        name: "World",
      });
      assert(
        !JSON.stringify(deniedOutput.events).includes(
          "Plugin review complete.",
        ),
      );
      deniedHook = undefined;
      await writePluginToDir(pluginsRoot, UPDATED_PLUGIN_SOURCE, "test-math");
      assertStringIncludes(
        (await turn("plugin_reload", { name: "test-math" })).result,
        "reloaded",
      );
      assertEquals(
        (await turn("plugin_test-math_greet", { name: "World" })).result,
        "Hey there, World!",
      );
    } finally {
      socket.close();
      await gateway.stop();
    }
  });
});
