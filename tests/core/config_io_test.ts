/**
 * Config IO tests.
 *
 * Tests the shared config read/write module used by both
 * CLI commands and LLM tool executors.
 */
import { enforceConfig } from "../../src/core/config.ts";
import { assertEquals } from "@std/assert";
import {
  deleteConfigValue,
  readConfigValue,
  readConfigYaml,
  writeConfigValue,
  writeConfigYaml,
} from "../../src/core/config_io.ts";
import { join } from "@std/path";

/** Create a temp dir and write a basic config YAML. */
async function setupTempConfig(): Promise<{
  dir: string;
  configPath: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await Deno.makeTempDir({ prefix: "triggerfish-test-" });
  const configPath = join(dir, "triggerfish.yaml");
  // Also create backups dir for backupConfig
  await Deno.mkdir(join(dir, "backups"), { recursive: true });
  await Deno.writeTextFile(
    configPath,
    "# Test Config\nmodels:\n  primary:\n    provider: anthropic\n    model: claude-sonnet\nchannels:\n  telegram:\n    bot_token: secret:tg\n",
  );
  return {
    dir,
    configPath,
    cleanup: async () => {
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test("Sentinel repository visibility configuration requires unique exact asset grants", () => {
  const models = { primary: { provider: "openai", model: "gpt-4.1" } };
  const grant = {
    case: "repository-review",
    asset: "application",
    owner: "fixture-org",
    repo: "fixture-repository",
    repository_id: 17,
  };
  const check = (github_repository_visibility_reads: unknown) =>
    enforceConfig({ models, sentinel: { github_repository_visibility_reads } });

  assertEquals(
    check([grant, { ...grant, asset: "another-application" }]).ok,
    true,
  );
  for (
    const invalid of [
      [grant, { ...grant, repository_id: 18 }],
      [{ ...grant, repository_id: 0 }],
      [{ ...grant, repository_id: "17" }],
      [{ ...grant, repo: ".." }],
      [{ ...grant, url: "https://example.invalid/" }],
      [{ ...grant, repository_id: undefined, workflow_id: 17 }],
    ]
  ) {
    const result = check(invalid);
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(
        result.error.includes("github_repository_visibility_reads"),
        true,
      );
    }
  }
});

// --- readConfigYaml ---

Deno.test("readConfigYaml: reads valid YAML", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const result = readConfigYaml(configPath);
    assertEquals(result.ok, true);
    if (result.ok) {
      const models = result.value.models as Record<string, unknown>;
      const primary = models.primary as Record<string, unknown>;
      assertEquals(primary.provider, "anthropic");
      assertEquals(primary.model, "claude-sonnet");
    }
  } finally {
    await cleanup();
  }
});

Deno.test("readConfigYaml: returns error for missing file", () => {
  const result = readConfigYaml("/nonexistent/path/triggerfish.yaml");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("Config not found"), true);
  }
});

// --- writeConfigYaml ---

Deno.test("writeConfigYaml: writes YAML with header", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const result = await writeConfigYaml(configPath, {
      models: { primary: { provider: "openai" } },
    });
    assertEquals(result.ok, true);
    const content = await Deno.readTextFile(configPath);
    assertEquals(content.startsWith("# Triggerfish Configuration"), true);
    assertEquals(content.includes("openai"), true);
  } finally {
    await cleanup();
  }
});

// --- readConfigValue ---

Deno.test("readConfigValue: reads nested value by dotted path", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const result = readConfigValue(configPath, "models.primary.provider");
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, "anthropic");
    }
  } finally {
    await cleanup();
  }
});

Deno.test("readConfigValue: returns undefined for missing path", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const result = readConfigValue(configPath, "nonexistent.deep.path");
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, undefined);
    }
  } finally {
    await cleanup();
  }
});

// --- writeConfigValue ---

Deno.test("writeConfigValue: sets nested value by dotted path", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const result = await writeConfigValue(
      configPath,
      "models.primary.model",
      "gpt-4",
    );
    assertEquals(result.ok, true);

    const readResult = readConfigValue(configPath, "models.primary.model");
    assertEquals(readResult.ok, true);
    if (readResult.ok) {
      assertEquals(readResult.value, "gpt-4");
    }
  } finally {
    await cleanup();
  }
});

Deno.test("writeConfigValue: creates intermediate objects", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const result = await writeConfigValue(
      configPath,
      "web.search.provider",
      "brave",
    );
    assertEquals(result.ok, true);

    const readResult = readConfigValue(configPath, "web.search.provider");
    assertEquals(readResult.ok, true);
    if (readResult.ok) {
      assertEquals(readResult.value, "brave");
    }
  } finally {
    await cleanup();
  }
});

// --- deleteConfigValue ---

Deno.test("deleteConfigValue: removes a nested key", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const result = await deleteConfigValue(
      configPath,
      "channels.telegram",
    );
    assertEquals(result.ok, true);

    const readResult = readConfigValue(configPath, "channels.telegram");
    assertEquals(readResult.ok, true);
    if (readResult.ok) {
      assertEquals(readResult.value, undefined);
    }
  } finally {
    await cleanup();
  }
});

Deno.test("deleteConfigValue: no-op for missing path", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const result = await deleteConfigValue(
      configPath,
      "nonexistent.deep.path",
    );
    assertEquals(result.ok, true);
  } finally {
    await cleanup();
  }
});

Deno.test("Sentinel model output language accepts only supported locales", () => {
  const models = { primary: "test-model" };
  for (const output_language of ["en", "es", "ko", "zh", "ja"]) {
    assertEquals(
      enforceConfig({ models, sentinel: { output_language } }).ok,
      true,
    );
  }
  assertEquals(enforceConfig({ models, sentinel: { output_language: "pt" } }), {
    ok: false,
    error: "sentinel.output_language must be en, es, ko, zh, or ja",
  });
});

Deno.test("Sentinel validates the background model worker limit", () => {
  const models = { primary: "test-model" };
  for (const model_worker_limit of [1, 2, 8]) {
    assertEquals(
      enforceConfig({ models, sentinel: { model_worker_limit } }).ok,
      true,
    );
  }
  for (
    const model_worker_limit of [0, -1, 1.25, "2", Number.MAX_SAFE_INTEGER + 1]
  ) {
    assertEquals(
      enforceConfig({ models, sentinel: { model_worker_limit } }).ok,
      false,
    );
  }
});

Deno.test("Sentinel validates the opt-in idle planner heartbeat interval", () => {
  const models = { primary: "test-model" };
  for (const planner_heartbeat_seconds of [600, 900, 86_400]) {
    assertEquals(
      enforceConfig({ models, sentinel: { planner_heartbeat_seconds } }).ok,
      true,
    );
  }
  for (const planner_heartbeat_seconds of [0, 599, 600.5, "600", 86_401]) {
    assertEquals(
      enforceConfig({ models, sentinel: { planner_heartbeat_seconds } }).ok,
      false,
    );
  }
});

Deno.test("Sentinel validates named model profile grants by data classification", () => {
  const models = { primary: "test-model" };
  const valid = { PUBLIC: ["public"], INTERNAL: ["local", "review"] };
  assertEquals(
    enforceConfig({ models, sentinel: { model_profile_allowlists: valid } }).ok,
    true,
  );
  for (
    const model_profile_allowlists of [
      { internal: ["review"] },
      { INTERNAL: ["review", "review"] },
      { INTERNAL: "review" },
      { INTERNAL: ["external/provider"] },
    ]
  ) {
    assertEquals(
      enforceConfig({ models, sentinel: { model_profile_allowlists } }).ok,
      false,
    );
  }
});
