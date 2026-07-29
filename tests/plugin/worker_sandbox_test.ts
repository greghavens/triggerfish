/**
 * Sandbox enforcement tests (issue #403).
 *
 * A never-trusted plugin runs inside a permission-restricted Deno
 * Worker: reading env, spawning subprocesses, and writing outside the
 * plugin directory must all fail even though the daemon runs with
 * full permissions.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import { acquirePluginExecutor } from "../../src/plugin/sandboxed_executor.ts";
import { resolveNetAllowlist } from "../../src/plugin/worker_host.ts";
import type { PluginContext } from "../../src/plugin/types.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";

/** Plugin that tries to touch host capabilities it should not have. */
const ESCAPE_PLUGIN_SOURCE = `
export const manifest = {
  name: "escape",
  version: "1.0.0",
  description: "Attempts to escape the sandbox",
  classification: "PUBLIC",
  trust: "sandboxed",
  declaredEndpoints: [],
};

export const toolDefinitions = [
  { name: "readenv", description: "Reads an env var", parameters: {} },
  { name: "spawn", description: "Spawns a subprocess", parameters: {} },
];

export function createExecutor(_context) {
  return async (name, _input) => {
    if (name === "readenv") {
      return Deno.env.get("HOME") ?? "no-home";
    }
    if (name === "spawn") {
      const cmd = new Deno.Command("echo", { args: ["pwned"] });
      await cmd.output();
      return "spawned";
    }
    return null;
  };
}
`;

async function writePlugin(source: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "plugin-sandbox-" });
  await Deno.writeTextFile(`${dir}/mod.ts`, source);
  return dir;
}

function testContext(): PluginContext {
  return {
    pluginName: "escape",
    getSessionTaint: () => "PUBLIC" as ClassificationLevel,
    escalateTaint: () => {},
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    config: {},
  };
}

Deno.test("sandbox: env access from a sandboxed plugin is blocked", async () => {
  const dir = await writePlugin(ESCAPE_PLUGIN_SOURCE);
  try {
    const acquired = await acquirePluginExecutor({
      pluginDir: dir,
      configTrust: "sandboxed",
      context: testContext(),
    });
    assert(acquired.ok, "plugin should load in the sandbox worker");
    if (!acquired.ok) return;

    const result = await acquired.value.executor("readenv", {});
    assert(
      typeof result === "string" && result.includes("error"),
      `env read should be denied, got: ${result}`,
    );
    acquired.value.dispose?.();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sandbox: subprocess spawn from a sandboxed plugin is blocked", async () => {
  const dir = await writePlugin(ESCAPE_PLUGIN_SOURCE);
  try {
    const acquired = await acquirePluginExecutor({
      pluginDir: dir,
      configTrust: "sandboxed",
      context: testContext(),
    });
    assert(acquired.ok);
    if (!acquired.ok) return;

    const result = await acquired.value.executor("spawn", {});
    assert(
      typeof result === "string" && result.includes("error"),
      `subprocess spawn should be denied, got: ${result}`,
    );
    acquired.value.dispose?.();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveNetAllowlist: maps URLs and bare hosts to hosts", () => {
  assertEquals(
    resolveNetAllowlist([
      "https://api.example.com/v1",
      "cdn.example.org",
      "",
    ]),
    ["api.example.com", "cdn.example.org"],
  );
});
