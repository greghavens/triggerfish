import { assertEquals } from "@std/assert";
import {
  importPluginModule,
  loadPluginsFromDirectory,
} from "../../src/plugin/loader.ts";
import { initializePlugins } from "../../src/gateway/startup/tools/tool_infra_plugins.ts";
import type { TriggerFishConfig } from "../../src/core/config.ts";
import { initializePluginExecutor } from "../../src/plugin/sandboxed_executor.ts";
import type { LoadedPlugin, PluginContext } from "../../src/plugin/types.ts";

const marker = "__triggerfishPluginImportProbe";

async function withImportProbe(
  body: (root: string, modPath: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  const dir = `${root}/probe`;
  await Deno.mkdir(dir);
  const modPath = `${dir}/mod.ts`;
  await Deno.writeTextFile(
    modPath,
    `
    globalThis[${JSON.stringify(marker)}] = true;
    export const manifest = {
      name: "probe", version: "1.0.0", description: "Import probe",
      classification: "INTERNAL", trust: "trusted", declaredEndpoints: [],
    };
    export const toolDefinitions = [];
    export const createExecutor = () => async () => null;
  `,
  );
  try {
    await body(root, modPath);
  } finally {
    Reflect.deleteProperty(globalThis, marker);
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("plugin import: missing trust cannot execute module top-level code", async () => {
  await withImportProbe(async (_root, modPath) => {
    const result = await importPluginModule(modPath);
    assertEquals(Reflect.get(globalThis, marker), undefined);
    assertEquals(result.ok, false);
  });
});

Deno.test("plugin directory: unconfigured plugins cannot execute code", async () => {
  await withImportProbe(async (root) => {
    const result = await loadPluginsFromDirectory(root);
    assertEquals(Reflect.get(globalThis, marker), undefined);
    assertEquals(result.ok && result.value.length, 0);
  });
});

Deno.test("plugin import: disabled and sandboxed grants cannot execute code", async () => {
  await withImportProbe(async (_root, modPath) => {
    for (
      const grant of [
        { enabled: false, trust: "trusted" as const },
        { enabled: true, trust: "sandboxed" as const },
        { enabled: true },
      ]
    ) {
      const result = await importPluginModule(modPath, grant);
      assertEquals(Reflect.get(globalThis, marker), undefined);
      assertEquals(result.ok, false);
    }
  });
});

Deno.test("plugin directory: explicitly trusted plugin loads and executes normally", async () => {
  await withImportProbe(async (root) => {
    const loaded = await loadPluginsFromDirectory(root, {
      probe: { enabled: true, trust: "trusted" },
    });
    assertEquals(loaded.ok, true);
    if (!loaded.ok) return;
    assertEquals(loaded.value.length, 1);
    const initialized = await initializePluginExecutor(
      loaded.value[0],
      {} as PluginContext,
      "trusted",
    );
    assertEquals(initialized.ok, true);
    if (initialized.ok) assertEquals(await initialized.value("test", {}), null);
    assertEquals(Reflect.get(globalThis, marker), true);
  });
});

Deno.test("plugin executor: sandbox request cannot call the executor factory", async () => {
  let called = false;
  const plugin: LoadedPlugin = {
    sourcePath: "/unused/probe/mod.ts",
    exports: {
      manifest: {
        name: "probe",
        version: "1.0.0",
        description: "Probe",
        classification: "INTERNAL",
        trust: "sandboxed",
        declaredEndpoints: [],
      },
      toolDefinitions: [],
      createExecutor: () => {
        called = true;
        return () => Promise.resolve(null);
      },
    },
  };
  const result = await initializePluginExecutor(
    plugin,
    {} as PluginContext,
    "sandboxed",
  );
  assertEquals(called, false);
  assertEquals(result.ok, false);
});

Deno.test("plugin startup: disabled plugin cannot execute code before filtering", async () => {
  await withImportProbe(async (root) => {
    const oldHome = Deno.env.get("HOME");
    const home = await Deno.makeTempDir();
    await Deno.mkdir(`${home}/.triggerfish`);
    await Deno.rename(root, `${home}/.triggerfish/plugins`);
    Deno.env.set("HOME", home);
    try {
      const config = {
        plugins: { probe: { enabled: false, trust: "trusted" } },
      } as unknown as TriggerFishConfig;
      const registry = await initializePlugins(
        config,
        () => "PUBLIC",
        new Map(),
        new Map(),
      );
      assertEquals(Reflect.get(globalThis, marker), undefined);
      assertEquals(registry.getPluginNames(), []);
    } finally {
      if (oldHome === undefined) Deno.env.delete("HOME");
      else Deno.env.set("HOME", oldHome);
      await Deno.rename(`${home}/.triggerfish/plugins`, root);
      await Deno.remove(home, { recursive: true });
    }
  });
});
