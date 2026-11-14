/**
 * config_manage tool executor tests.
 *
 * Tests the configuration management tool actions.
 */
import { assertEquals } from "@std/assert";
import { createConfigManageExecutor } from "../../../src/gateway/tools/executor/executor_config_manage.ts";
import { join } from "@std/path";

/** Create a temp config file for testing. */
async function setupTempConfig(): Promise<{
  configPath: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await Deno.makeTempDir({ prefix: "triggerfish-test-" });
  const configPath = join(dir, "triggerfish.yaml");
  await Deno.mkdir(join(dir, "backups"), { recursive: true });
  await Deno.writeTextFile(
    configPath,
    "# Test Config\nmodels:\n  primary:\n    provider: anthropic\n    model: claude-sonnet\nchannels:\n  telegram:\n    bot_token: secret:tg\nlogging:\n  level: normal\n",
  );
  return {
    configPath,
    cleanup: async () => {
      await Deno.remove(dir, { recursive: true });
    },
  };
}

// --- get ---

Deno.test("config_manage: get reads value by dotted path", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createConfigManageExecutor({ configPath });
    const result = await executor("config_manage", {
      action: "get",
      key: "models.primary.provider",
    });
    assertEquals(result !== null, true);
    const parsed = JSON.parse(result!);
    assertEquals(parsed.key, "models.primary.provider");
    assertEquals(parsed.value, "anthropic");
  } finally {
    await cleanup();
  }
});

Deno.test("config_manage: get returns null for missing key", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createConfigManageExecutor({ configPath });
    const result = await executor("config_manage", {
      action: "get",
      key: "nonexistent.path",
    });
    assertEquals(result !== null, true);
    const parsed = JSON.parse(result!);
    assertEquals(parsed.value, null);
  } finally {
    await cleanup();
  }
});

// --- set ---

Deno.test("config_manage: agent cannot grant itself plugin execution trust", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const original = await Deno.readTextFile(configPath);
    const executor = createConfigManageExecutor({ configPath });
    for (
      const key of [
        "plugins",
        "plugins.probe",
        "plugins.probe.trust",
        "plugins.probe.enabled",
      ]
    ) {
      const result = await executor("config_manage", {
        action: "set",
        key,
        value: "trusted",
      });
      assertEquals(result?.includes("configured directly by the user"), true);
      assertEquals(await Deno.readTextFile(configPath), original);
    }
  } finally {
    await cleanup();
  }
});

Deno.test("config_manage: prototype traversal cannot mutate shared objects", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  const marker = "__triggerfishPrototypeProbe";
  try {
    const original = await Deno.readTextFile(configPath);
    const executor = createConfigManageExecutor({ configPath });
    for (
      const action of [
        { action: "set", key: `__proto__.${marker}`, value: "true" },
        {
          action: "set",
          key: `constructor.prototype.${marker}`,
          value: "true",
        },
        {
          action: "add_channel",
          channel_type: `__proto__.${marker}`,
          channel_config: "{}",
        },
        { action: "set_integration", integration: "__proto__", enabled: true },
      ]
    ) {
      const result = await executor("config_manage", action);
      assertEquals(result?.includes("object prototypes"), true);
      assertEquals(Reflect.get(Object.prototype, marker), undefined);
      assertEquals(await Deno.readTextFile(configPath), original);
    }
  } finally {
    Reflect.deleteProperty(Object.prototype, marker);
    await cleanup();
  }
});

Deno.test("config_manage: set writes value and reports restart needed", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createConfigManageExecutor({ configPath });
    const result = await executor("config_manage", {
      action: "set",
      key: "models.primary.model",
      value: "gpt-4",
    });
    assertEquals(result !== null, true);
    const parsed = JSON.parse(result!);
    assertEquals(parsed.success, true);
    assertEquals(parsed.restart_needed, true);

    // Verify write persisted
    const readResult = await executor("config_manage", {
      action: "get",
      key: "models.primary.model",
    });
    const readParsed = JSON.parse(readResult!);
    assertEquals(readParsed.value, "gpt-4");
  } finally {
    await cleanup();
  }
});

Deno.test("config_manage: set rejects raw secret values", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createConfigManageExecutor({ configPath });
    const result = await executor("config_manage", {
      action: "set",
      key: "web.search.api_key",
      value: "raw-api-key-123",
    });
    assertEquals(result !== null, true);
    assertEquals(result!.includes("Error:"), true);
    assertEquals(result!.includes("secret:"), true);
  } finally {
    await cleanup();
  }
});

Deno.test("config_manage: set allows secret: references for secret keys", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createConfigManageExecutor({ configPath });
    const result = await executor("config_manage", {
      action: "set",
      key: "web.search.api_key",
      value: "secret:brave-key",
    });
    assertEquals(result !== null, true);
    const parsed = JSON.parse(result!);
    assertEquals(parsed.success, true);
  } finally {
    await cleanup();
  }
});

// --- show ---

Deno.test("config_manage: show returns full config with secrets redacted", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createConfigManageExecutor({ configPath });
    const result = await executor("config_manage", { action: "show" });
    assertEquals(result !== null, true);
    const parsed = JSON.parse(result!);
    assertEquals(parsed.models.primary.provider, "anthropic");
    // Secret token should be redacted (it starts with "secret:" so kept as-is)
    assertEquals(parsed.channels.telegram.bot_token, "secret:tg");
  } finally {
    await cleanup();
  }
});

// --- add_channel / remove_channel / list_channels ---

Deno.test("config_manage: add_channel writes channel config", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createConfigManageExecutor({ configPath });
    const result = await executor("config_manage", {
      action: "add_channel",
      channel_type: "slack",
      channel_config: JSON.stringify({
        bot_token: "secret:slack-tok",
        channel: "#general",
      }),
    });
    assertEquals(result !== null, true);
    const parsed = JSON.parse(result!);
    assertEquals(parsed.success, true);
    assertEquals(parsed.restart_needed, true);

    // Verify channel was added
    const listResult = await executor("config_manage", {
      action: "list_channels",
    });
    const listParsed = JSON.parse(listResult!);
    assertEquals(listParsed.channels.includes("slack"), true);
  } finally {
    await cleanup();
  }
});

Deno.test("config_manage: remove_channel removes channel", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createConfigManageExecutor({ configPath });
    const result = await executor("config_manage", {
      action: "remove_channel",
      channel_type: "telegram",
    });
    assertEquals(result !== null, true);
    const parsed = JSON.parse(result!);
    assertEquals(parsed.success, true);

    const listResult = await executor("config_manage", {
      action: "list_channels",
    });
    const listParsed = JSON.parse(listResult!);
    assertEquals(listParsed.channels.includes("telegram"), false);
  } finally {
    await cleanup();
  }
});

Deno.test("config_manage: list_channels returns configured channels", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createConfigManageExecutor({ configPath });
    const result = await executor("config_manage", {
      action: "list_channels",
    });
    assertEquals(result !== null, true);
    const parsed = JSON.parse(result!);
    assertEquals(parsed.channels.includes("telegram"), true);
  } finally {
    await cleanup();
  }
});

// --- set_search ---

Deno.test("config_manage: set_search configures search provider", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createConfigManageExecutor({ configPath });
    const result = await executor("config_manage", {
      action: "set_search",
      provider: "brave",
      api_key_secret: "brave-api-key",
    });
    assertEquals(result !== null, true);
    const parsed = JSON.parse(result!);
    assertEquals(parsed.success, true);

    const readResult = await executor("config_manage", {
      action: "get",
      key: "web.search.provider",
    });
    assertEquals(JSON.parse(readResult!).value, "brave");
  } finally {
    await cleanup();
  }
});

// --- set_models ---

Deno.test("config_manage: set_models configures primary model", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createConfigManageExecutor({ configPath });
    const result = await executor("config_manage", {
      action: "set_models",
      provider: "openai",
      model: "gpt-4o",
    });
    assertEquals(result !== null, true);
    const parsed = JSON.parse(result!);
    assertEquals(parsed.success, true);
  } finally {
    await cleanup();
  }
});

// --- set_domain_classification ---

Deno.test("config_manage: set_domain_classification validates classification", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createConfigManageExecutor({ configPath });
    const result = await executor("config_manage", {
      action: "set_domain_classification",
      domain_pattern: "*.corp.example.com",
      classification: "INVALID",
    });
    assertEquals(result !== null, true);
    assertEquals(result!.startsWith("Error:"), true);
  } finally {
    await cleanup();
  }
});

Deno.test("config_manage: set_domain_classification accepts valid classification", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createConfigManageExecutor({ configPath });
    const result = await executor("config_manage", {
      action: "set_domain_classification",
      domain_pattern: "*.corp.example.com",
      classification: "CONFIDENTIAL",
    });
    assertEquals(result !== null, true);
    const parsed = JSON.parse(result!);
    assertEquals(parsed.success, true);
  } finally {
    await cleanup();
  }
});

// --- set_tool_floor ---

Deno.test("config_manage: set_tool_floor validates classification", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createConfigManageExecutor({ configPath });
    const result = await executor("config_manage", {
      action: "set_tool_floor",
      tool_prefix: "github_",
      classification: "NOT_A_LEVEL",
    });
    assertEquals(result !== null, true);
    assertEquals(result!.startsWith("Error:"), true);
  } finally {
    await cleanup();
  }
});

// --- set_logging ---

Deno.test("config_manage: set_logging validates level", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createConfigManageExecutor({ configPath });
    const result = await executor("config_manage", {
      action: "set_logging",
      level: "invalid_level",
    });
    assertEquals(result !== null, true);
    assertEquals(result!.includes("Error:"), true);
  } finally {
    await cleanup();
  }
});

Deno.test("config_manage: set_logging accepts valid level", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createConfigManageExecutor({ configPath });
    const result = await executor("config_manage", {
      action: "set_logging",
      level: "debug",
    });
    assertEquals(result !== null, true);
    const parsed = JSON.parse(result!);
    assertEquals(parsed.success, true);
  } finally {
    await cleanup();
  }
});

// --- dispatch ---

Deno.test("config_manage: returns null for non-matching tool name", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createConfigManageExecutor({ configPath });
    const result = await executor("other_tool", { action: "get" });
    assertEquals(result, null);
  } finally {
    await cleanup();
  }
});

Deno.test("config_manage: requires action parameter", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createConfigManageExecutor({ configPath });
    const result = await executor("config_manage", {});
    assertEquals(result !== null, true);
    assertEquals(result!.includes("requires an 'action'"), true);
  } finally {
    await cleanup();
  }
});

Deno.test("config_manage: rejects unknown action", async () => {
  const { configPath, cleanup } = await setupTempConfig();
  try {
    const executor = createConfigManageExecutor({ configPath });
    const result = await executor("config_manage", {
      action: "destroy_everything",
    });
    assertEquals(result !== null, true);
    assertEquals(result!.includes("Unknown action"), true);
  } finally {
    await cleanup();
  }
});
