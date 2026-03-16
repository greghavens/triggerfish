/**
 * Tests for the plugin registry.
 *
 * @module
 */

import { assertEquals, assertThrows } from "@std/assert";
import { createPluginRegistry } from "../../src/plugin/registry.ts";
import type { RegisteredPlugin } from "../../src/plugin/types.ts";

function makePlugin(
  name: string,
  opts?: { classification?: string; systemPrompt?: string },
): RegisteredPlugin {
  return {
    loaded: {
      exports: {
        manifest: {
          name,
          version: "1.0.0",
          description: `Plugin ${name}`,
          classification: (opts?.classification ?? "PUBLIC") as
            & "PUBLIC"
            & "INTERNAL"
            & "CONFIDENTIAL"
            & "RESTRICTED",
          trust: "sandboxed",
          declaredEndpoints: [],
        },
        toolDefinitions: [
          { name: "action", description: "Do action", parameters: {} },
        ],
        // deno-lint-ignore require-await
        createExecutor: () => async () => null,
        systemPrompt: opts?.systemPrompt,
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

Deno.test("createPluginRegistry register and get round-trip", () => {
  const registry = createPluginRegistry();
  const plugin = makePlugin("test");
  registry.registerPlugin(plugin);
  assertEquals(registry.getPlugin("test"), plugin);
});

Deno.test("createPluginRegistry rejects duplicate name", () => {
  const registry = createPluginRegistry();
  registry.registerPlugin(makePlugin("test"));
  assertThrows(
    () => registry.registerPlugin(makePlugin("test")),
    Error,
    "already registered",
  );
});

Deno.test("createPluginRegistry getAllPlugins returns all", () => {
  const registry = createPluginRegistry();
  registry.registerPlugin(makePlugin("alpha"));
  registry.registerPlugin(makePlugin("beta"));
  assertEquals(registry.getAllPlugins().length, 2);
});

Deno.test("createPluginRegistry getToolDefinitions aggregates", () => {
  const registry = createPluginRegistry();
  registry.registerPlugin(makePlugin("alpha"));
  registry.registerPlugin(makePlugin("beta"));
  const tools = registry.getToolDefinitions();
  assertEquals(tools.length, 2);
  assertEquals(tools[0].name, "plugin_alpha_action");
  assertEquals(tools[1].name, "plugin_beta_action");
});

Deno.test("createPluginRegistry getClassifications returns prefix map", () => {
  const registry = createPluginRegistry();
  registry.registerPlugin(makePlugin("alpha", { classification: "INTERNAL" }));
  registry.registerPlugin(
    makePlugin("beta", { classification: "CONFIDENTIAL" }),
  );
  const classifications = registry.getClassifications();
  assertEquals(classifications.get("plugin_alpha_"), "INTERNAL");
  assertEquals(classifications.get("plugin_beta_"), "CONFIDENTIAL");
});

Deno.test("createPluginRegistry getSystemPrompts collects non-undefined", () => {
  const registry = createPluginRegistry();
  registry.registerPlugin(makePlugin("alpha", { systemPrompt: "Use alpha." }));
  registry.registerPlugin(makePlugin("beta"));
  const prompts = registry.getSystemPrompts();
  assertEquals(prompts.length, 1);
  assertEquals(prompts[0], "Use alpha.");
});

Deno.test("createPluginRegistry getPluginNames returns names", () => {
  const registry = createPluginRegistry();
  registry.registerPlugin(makePlugin("alpha"));
  registry.registerPlugin(makePlugin("beta"));
  assertEquals(registry.getPluginNames(), ["alpha", "beta"]);
});

Deno.test("createPluginRegistry getPlugin returns undefined for unknown", () => {
  const registry = createPluginRegistry();
  assertEquals(registry.getPlugin("nonexistent"), undefined);
});
