/**
 * Tests for plugin management tools (build→scan→load flow).
 *
 * @module
 */

import { assertEquals } from "@std/assert";
import { createPluginRegistry } from "../../src/plugin/registry.ts";
import { createPluginToolExecutor } from "../../src/plugin/tools.ts";
import type { RegisteredPlugin } from "../../src/plugin/types.ts";
import { createToolFloorRegistry } from "../../src/core/security/tool_floors.ts";

/**
 * Run a test body with HOME pointed at a temp dir containing a plugins root.
 * plugin_install is jailed to ~/.triggerfish/plugins, so install tests need
 * a controlled HOME.
 */
async function withTempHome<T>(
  fn: (pluginsRoot: string) => Promise<T>,
): Promise<T> {
  const origHome = Deno.env.get("HOME");
  const home = await Deno.makeTempDir();
  const pluginsRoot = `${home}/.triggerfish/plugins`;
  await Deno.mkdir(pluginsRoot, { recursive: true });
  Deno.env.set("HOME", home);
  try {
    return await fn(pluginsRoot);
  } finally {
    if (origHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", origHome);
    await Deno.remove(home, { recursive: true });
  }
}

function makePlugin(name: string): RegisteredPlugin {
  return {
    loaded: {
      exports: {
        manifest: {
          name,
          version: "1.0.0",
          description: `Plugin ${name}`,
          classification: "PUBLIC",
          trust: "sandboxed",
          declaredEndpoints: [],
        },
        toolDefinitions: [
          { name: "action", description: "Do action", parameters: {} },
        ],
        // deno-lint-ignore require-await
        createExecutor: () => async () => null,
      },
      sourcePath: `/plugins/${name}/mod.ts`,
    },
    // deno-lint-ignore require-await
    executor: async () => null,
    namespacedTools: [
      {
        name: `plugin_${name}_action`,
        description: `[Plugin: ${name}] Do action`,
        parameters: {},
      },
    ],
  };
}

/** Mock scanner that always passes. */
// deno-lint-ignore require-await
async function passingScanner(_dir: string) {
  return {
    ok: true as const,
    warnings: [] as string[],
    scannedFiles: ["mod.ts"],
  };
}

/** Mock scanner that always fails. */
// deno-lint-ignore require-await
async function failingScanner(_dir: string) {
  return {
    ok: false as const,
    warnings: ["eval() detected in mod.ts:1"],
    scannedFiles: ["mod.ts"],
  };
}

function makeToolExecutor(
  scanPlugin: Parameters<typeof createPluginToolExecutor>[0]["scanPlugin"] =
    passingScanner,
  pluginsConfig = { alpha: { enabled: true, trust: "trusted" as const } },
) {
  const registry = createPluginRegistry();
  const toolClassifications = new Map<string, string>();
  const integrationClassifications = new Map<string, string>();
  const executor = createPluginToolExecutor({
    registry,
    getSessionTaint: () => "PUBLIC",
    pluginsConfig,
    toolClassifications: toolClassifications as unknown as Map<
      string,
      "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED"
    >,
    integrationClassifications: integrationClassifications as unknown as Map<
      string,
      "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED"
    >,
    scanPlugin,
  });
  return {
    registry,
    executor,
    toolClassifications,
    integrationClassifications,
  };
}

Deno.test("plugin_list: shows empty when no plugins", async () => {
  const { executor } = makeToolExecutor();
  const result = await executor("plugin_list", {});
  assertEquals(result, "No plugins are currently registered.");
});

Deno.test("plugin_list: shows registered plugins", async () => {
  const { registry, executor } = makeToolExecutor();
  registry.registerPlugin(makePlugin("alpha"));
  const result = await executor("plugin_list", {});
  assertEquals(result !== null, true);
  const parsed = JSON.parse(result!);
  assertEquals(parsed.length, 1);
  assertEquals(parsed[0].name, "alpha");
});

Deno.test("plugin_install: rejects missing name", async () => {
  const { executor } = makeToolExecutor();
  const result = await executor("plugin_install", {});
  assertEquals(result!.includes("requires"), true);
});

Deno.test("plugin_install: rejects already registered", async () => {
  const { registry, executor } = makeToolExecutor();
  registry.registerPlugin(makePlugin("alpha"));
  const result = await executor("plugin_install", { name: "alpha" });
  assertEquals(result!.includes("already registered"), true);
});

Deno.test("plugin_install: rejects execution without explicit user config", async () => {
  // This tests the core flow: agent builds plugin, loads it by path
  // Import will fail (no real mod.ts at path) but the key assertion is
  // that it does NOT reject for missing config
  await withTempHome(async (pluginsRoot) => {
    const { executor } = makeToolExecutor();
    const result = await executor("plugin_install", {
      name: "agent-built",
      path: `${pluginsRoot}/agent-built`,
    });
    // Path containment alone never grants permission to execute code.
    assertEquals(
      result!.includes("explicit") || result!.includes("configure enabled"),
      true,
    );
    assertEquals(result!.includes("escapes the plugins root"), false);
  });
});

Deno.test("plugin_install: blocked by failing security scanner", async () => {
  await withTempHome(async (pluginsRoot) => {
    const dir = `${pluginsRoot}/bad-plugin`;
    await Deno.mkdir(dir, { recursive: true });
    const { executor } = makeToolExecutor(failingScanner);
    const result = await executor("plugin_install", {
      name: "bad-plugin",
      path: dir,
    });
    assertEquals(result!.includes("failed security scan"), true);
    assertEquals(result!.includes("eval()"), true);
  });
});

Deno.test("plugin_install: blocks absolute path outside the plugins root", async () => {
  await withTempHome(async (_pluginsRoot) => {
    const outside = await Deno.makeTempDir();
    try {
      const { executor } = makeToolExecutor();
      const result = await executor("plugin_install", {
        name: "evil",
        path: outside,
      });
      assertEquals(result!.includes("Plugin install blocked"), true);
      assertEquals(result!.includes("escapes the plugins root"), true);
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });
});

Deno.test("plugin_install: blocks ../ traversal escaping the plugins root", async () => {
  await withTempHome(async (pluginsRoot) => {
    const { executor } = makeToolExecutor();
    const result = await executor("plugin_install", {
      name: "evil",
      path: `${pluginsRoot}/../../../etc`,
    });
    assertEquals(result!.includes("Plugin install blocked"), true);
  });
});

Deno.test("plugin_install: blocks traversal via the name parameter", async () => {
  await withTempHome(async (_pluginsRoot) => {
    const { executor } = makeToolExecutor();
    const result = await executor("plugin_install", {
      name: "../../escape",
    });
    assertEquals(result!.includes("Plugin install blocked"), true);
  });
});

Deno.test("plugin_install: blocks symlink escape from inside the plugins root", async () => {
  await withTempHome(async (pluginsRoot) => {
    const outside = await Deno.makeTempDir();
    try {
      await Deno.symlink(outside, `${pluginsRoot}/sneaky`);
      const { executor } = makeToolExecutor();
      const result = await executor("plugin_install", {
        name: "sneaky",
        path: `${pluginsRoot}/sneaky`,
      });
      assertEquals(result!.includes("Plugin install blocked"), true);
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });
});

Deno.test("plugin tools carry a RESTRICTED hardcoded floor", () => {
  const registry = createToolFloorRegistry();
  for (const tool of ["plugin_install", "plugin_reload", "plugin_scan"]) {
    assertEquals(registry.getFloor(tool), "RESTRICTED");
    assertEquals(registry.canInvoke(tool, "CONFIDENTIAL"), false);
    assertEquals(registry.canInvoke(tool, "RESTRICTED"), true);
  }
});

Deno.test("plugin_reload: rejects unregistered plugin", async () => {
  const { executor } = makeToolExecutor();
  const result = await executor("plugin_reload", { name: "nonexistent" });
  assertEquals(result!.includes("not registered"), true);
});

Deno.test("plugin_reload: rejects missing name", async () => {
  const { executor } = makeToolExecutor();
  const result = await executor("plugin_reload", {});
  assertEquals(result!.includes("requires"), true);
});

Deno.test("plugin_scan: returns scan result for path", async () => {
  const { executor } = makeToolExecutor();
  const result = await executor("plugin_scan", { path: "/tmp/some-plugin" });
  const parsed = JSON.parse(result!);
  assertEquals(parsed.ok, true);
  assertEquals(parsed.scannedFiles.length, 1);
});

Deno.test("plugin_scan: returns warnings on failure", async () => {
  const { executor } = makeToolExecutor(failingScanner);
  const result = await executor("plugin_scan", { path: "/tmp/bad-plugin" });
  const parsed = JSON.parse(result!);
  assertEquals(parsed.ok, false);
  assertEquals(parsed.warnings.length, 1);
});

Deno.test("plugin_scan: rejects missing path", async () => {
  const { executor } = makeToolExecutor();
  const result = await executor("plugin_scan", {});
  assertEquals(result!.includes("requires"), true);
});

Deno.test("returns null for unknown tool names", async () => {
  const { executor } = makeToolExecutor();
  const result = await executor("web_fetch", {});
  assertEquals(result, null);
});

Deno.test("plugin_list: returns null for non-matching tools", async () => {
  const { executor } = makeToolExecutor();
  assertEquals(await executor("unknown_tool", {}), null);
});

Deno.test("plugin_reload: revoked trust deactivates the old executor", async () => {
  const {
    registry,
    executor,
    toolClassifications,
    integrationClassifications,
  } = makeToolExecutor(passingScanner, {
    alpha: { enabled: false, trust: "trusted" },
  });
  let disposed = 0;
  registry.registerPlugin({
    ...makePlugin("alpha"),
    dispose: () => disposed++,
  });
  toolClassifications.set("plugin_alpha_", "PUBLIC");
  integrationClassifications.set("plugin_alpha_", "PUBLIC");
  const result = await executor("plugin_reload", { name: "alpha" });
  assertEquals(result!.includes("execution grant revoked"), true);
  assertEquals(disposed, 1);
  assertEquals(registry.getPlugin("alpha"), undefined);
  assertEquals(toolClassifications.has("plugin_alpha_"), false);
  assertEquals(integrationClassifications.has("plugin_alpha_"), false);
});
