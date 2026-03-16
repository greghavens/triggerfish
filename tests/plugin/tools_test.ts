/**
 * Tests for plugin management tools (build→scan→load flow).
 *
 * @module
 */

import { assertEquals } from "@std/assert";
import { createPluginRegistry } from "../../src/plugin/registry.ts";
import { createPluginToolExecutor } from "../../src/plugin/tools.ts";
import type { RegisteredPlugin } from "../../src/plugin/types.ts";

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
  scanPlugin = passingScanner,
) {
  const registry = createPluginRegistry();
  const toolClassifications = new Map<string, string>();
  const integrationClassifications = new Map<string, string>();
  const executor = createPluginToolExecutor({
    registry,
    getSessionTaint: () => "PUBLIC",
    pluginsConfig: {},
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

Deno.test("plugin_install: accepts path parameter without config", async () => {
  // This tests the core flow: agent builds plugin, loads it by path
  // Import will fail (no real mod.ts at path) but the key assertion is
  // that it does NOT reject for missing config
  const { executor } = makeToolExecutor();
  const result = await executor("plugin_install", {
    name: "agent-built",
    path: "/tmp/nonexistent-plugin-dir",
  });
  // Should fail at scan or import, NOT at "not enabled in config"
  assertEquals(result!.includes("not enabled"), false);
});

Deno.test("plugin_install: blocked by failing security scanner", async () => {
  const { executor } = makeToolExecutor(failingScanner);
  const result = await executor("plugin_install", {
    name: "bad-plugin",
    path: "/tmp/some-plugin",
  });
  assertEquals(result!.includes("failed security scan"), true);
  assertEquals(result!.includes("eval()"), true);
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
