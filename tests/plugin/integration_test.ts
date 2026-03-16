/**
 * Integration tests for the plugin build→scan→load→call flow.
 *
 * These tests write real plugin code to temp directories, scan it,
 * load it via the plugin tools, and call the resulting tools.
 *
 * @module
 */

import { assertEquals } from "@std/assert";
import { createPluginRegistry } from "../../src/plugin/registry.ts";
import { createPluginToolExecutor } from "../../src/plugin/tools.ts";
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
  trust: "sandboxed",
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
  trust: "sandboxed",
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
  trust: "sandboxed",
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

/** Write a plugin mod.ts to a temp directory and return the path. */
async function writePluginToDir(
  source: string,
  dirName: string,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: `plugin-integ-${dirName}-` });
  await Deno.writeTextFile(`${dir}/mod.ts`, source);
  return dir;
}

/** Create the full tool executor stack for integration testing. */
function createTestStack() {
  const registry = createPluginRegistry();
  const toolClassifications = new Map<string, ClassificationLevel>();
  const integrationClassifications = new Map<string, ClassificationLevel>();

  const pluginToolExecutor = createPluginToolExecutor({
    registry,
    getSessionTaint: () => "PUBLIC" as ClassificationLevel,
    pluginsConfig: {},
    toolClassifications,
    integrationClassifications,
    scanPlugin: scanPluginDirectory,
  });

  const pluginExecutor = createPluginExecutor(registry);

  return { registry, pluginToolExecutor, pluginExecutor, toolClassifications };
}

Deno.test("integration: scan → install → call tools from disk", async () => {
  const dir = await writePluginToDir(VALID_PLUGIN_SOURCE, "valid");
  try {
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
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("integration: scan blocks malicious plugin", async () => {
  const dir = await writePluginToDir(MALICIOUS_PLUGIN_SOURCE, "evil");
  try {
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
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("integration: reload hot-swaps plugin code", async () => {
  const dir = await writePluginToDir(VALID_PLUGIN_SOURCE, "reload");
  try {
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
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("integration: install rejects duplicate plugin name", async () => {
  const dir = await writePluginToDir(VALID_PLUGIN_SOURCE, "dupe");
  try {
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
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("integration: install rejects name/manifest mismatch", async () => {
  const dir = await writePluginToDir(VALID_PLUGIN_SOURCE, "mismatch");
  try {
    const stack = createTestStack();

    // Install with wrong name (plugin manifest says "test-math")
    const result = await stack.pluginToolExecutor("plugin_install", {
      name: "wrong-name",
      path: dir,
    });
    assertEquals(
      result!.includes("does not match manifest name"),
      true,
      `Should reject mismatch: ${result}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("integration: classification injected on install", async () => {
  const dir = await writePluginToDir(VALID_PLUGIN_SOURCE, "classify");
  try {
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
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
