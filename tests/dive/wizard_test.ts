/**
 * Tests for the dive wizard — config and SPINE.md generation.
 *
 * Tests the pure generation functions, not the interactive prompts.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "@std/assert";
import { parse as parseYaml } from "@std/yaml";

import {
  createDirectoryTree,
  generateConfig,
  generateSpine,
  storeWizardSecrets,
} from "../../src/dive/wizard.ts";
import type { WizardAnswers } from "../../src/dive/wizard.ts";
import { createMemorySecretStore } from "../../src/secrets/keychain.ts";

// ─── Test fixtures ───────────────────────────────────────────────────────────

function makeAnswers(
  overrides: Partial<WizardAnswers> = {},
): WizardAnswers {
  return {
    provider: "anthropic",
    providerModel: "claude-sonnet-4-5",
    apiKey: "",
    agentName: "TestBot",
    mission: "A test agent for unit tests.",
    tone: "professional",
    customTone: "",
    channels: ["cli"],
    telegramBotToken: "",
    telegramOwnerId: "",
    discordBotToken: "",
    discordOwnerId: "",
    webchatPort: 8765,
    signalPhoneNumber: "",
    signalEndpoint: "tcp://127.0.0.1:7583",
    selectedPlugins: [],
    obsidianVaultPath: "",
    obsidianClassification: "INTERNAL",
    searchProvider: "skip",
    searchApiKey: "",
    searxngUrl: "",
    localEndpoint: "http://localhost:11434",
    installDaemon: false,
    ...overrides,
  };
}

// ─── generateConfig tests ────────────────────────────────────────────────────

Deno.test("Wizard: generateConfig produces valid YAML", () => {
  const answers = makeAnswers();
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml);
  assert(typeof parsed === "object" && parsed !== null);
});

Deno.test("Wizard: generateConfig sets correct primary model for Anthropic", () => {
  const answers = makeAnswers({
    provider: "anthropic",
    providerModel: "claude-sonnet-4-5",
  });
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const models = parsed.models as Record<string, unknown>;
  const primary = models.primary as Record<string, string>;
  assertEquals(primary.provider, "anthropic");
  assertEquals(primary.model, "claude-sonnet-4-5");
});

Deno.test("Wizard: generateConfig sets correct model for OpenAI", () => {
  const answers = makeAnswers({
    provider: "openai",
    providerModel: "gpt-4o",
  });
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const models = parsed.models as Record<string, unknown>;
  const primary = models.primary as Record<string, string>;
  assertEquals(primary.provider, "openai");
  assertEquals(primary.model, "gpt-4o");
  const providers = models.providers as Record<string, Record<string, string>>;
  assertEquals(providers.openai.model, "gpt-4o");
});

Deno.test("Wizard: generateConfig sets endpoint for Ollama provider", () => {
  const answers = makeAnswers({
    provider: "ollama",
    providerModel: "llama3",
  });
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const models = parsed.models as Record<string, unknown>;
  const providers = models.providers as Record<string, Record<string, string>>;
  assertEquals(providers.ollama.endpoint, "http://localhost:11434");
  assertEquals(providers.ollama.model, "llama3");
});

Deno.test("Wizard: generateConfig uses localEndpoint for Ollama provider", () => {
  const answers = makeAnswers({
    provider: "ollama",
    providerModel: "llama3",
    localEndpoint: "http://192.168.1.50:11434",
  });
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const models = parsed.models as Record<string, unknown>;
  const providers = models.providers as Record<string, Record<string, string>>;
  assertEquals(providers.ollama.endpoint, "http://192.168.1.50:11434");
  assertEquals(providers.ollama.model, "llama3");
});

Deno.test("Wizard: generateConfig sets endpoint for LM Studio provider", () => {
  const answers = makeAnswers({
    provider: "lmstudio",
    providerModel: "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF",
    localEndpoint: "http://localhost:1234",
  });
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const models = parsed.models as Record<string, unknown>;
  const providers = models.providers as Record<string, Record<string, string>>;
  assertEquals(providers.lmstudio.endpoint, "http://localhost:1234");
  assertEquals(providers.lmstudio.model, "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF");
});

Deno.test("Wizard: generateConfig uses localEndpoint for LM Studio provider", () => {
  const answers = makeAnswers({
    provider: "lmstudio",
    providerModel: "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF",
    localEndpoint: "http://192.168.1.50:1234",
  });
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const models = parsed.models as Record<string, unknown>;
  const providers = models.providers as Record<string, Record<string, string>>;
  assertEquals(providers.lmstudio.endpoint, "http://192.168.1.50:1234");
  assertEquals(providers.lmstudio.model, "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF");
});

Deno.test("Wizard: generateConfig includes webchat channel config", () => {
  const answers = makeAnswers({
    channels: ["cli", "webchat"],
    webchatPort: 9999,
  });
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const channels = parsed.channels as Record<string, Record<string, unknown>>;
  assertEquals(channels.webchat.port, 9999);
  assertEquals(channels.webchat.classification, "PUBLIC");
});

Deno.test("Wizard: generateConfig includes telegram channel config", () => {
  const answers = makeAnswers({
    channels: ["cli", "telegram"],
    telegramBotToken: "123:ABC",
    telegramOwnerId: "483291057",
  });
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const channels = parsed.channels as Record<string, Record<string, unknown>>;
  assertEquals(channels.telegram.classification, "INTERNAL");
  assertEquals(channels.telegram.ownerId, 483291057);
  // Token stored as secret: reference, not plaintext
  assertEquals(channels.telegram.botToken, "secret:telegram:botToken");
});

Deno.test("Wizard: generateConfig includes signal channel config", () => {
  const answers = makeAnswers({
    channels: ["cli", "signal"],
    signalPhoneNumber: "+15551234567",
    signalEndpoint: "tcp://127.0.0.1:7583",
  });
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const channels = parsed.channels as Record<string, Record<string, unknown>>;
  assertEquals(channels.signal.account, "+15551234567");
  assertEquals(channels.signal.endpoint, "tcp://127.0.0.1:7583");
  assertEquals(channels.signal.classification, "INTERNAL");
  assertEquals(channels.signal.ownerPhone, "+15551234567");
});

Deno.test("Wizard: generateConfig omits signal channel when phone number is empty", () => {
  const answers = makeAnswers({
    channels: ["cli", "signal"],
    signalPhoneNumber: "",
  });
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const channels = parsed.channels as Record<string, unknown>;
  assertEquals(channels.signal, undefined);
});

Deno.test("Wizard: generateConfig has empty channels when only CLI selected", () => {
  const answers = makeAnswers({ channels: ["cli"] });
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const channels = parsed.channels as Record<string, unknown>;
  assertEquals(Object.keys(channels).length, 0);
});

Deno.test("Wizard: generateConfig sets classification to standard", () => {
  const answers = makeAnswers();
  const parsed = parseYaml(generateConfig(answers)) as Record<string, unknown>;
  const classification = parsed.classification as Record<string, string>;
  assertEquals(classification.levels, "standard");
});

Deno.test("Wizard: generateConfig for Google provider", () => {
  const answers = makeAnswers({
    provider: "google",
    providerModel: "gemini-2.0-flash",
  });
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const models = parsed.models as Record<string, unknown>;
  const providers = models.providers as Record<string, Record<string, string>>;
  assertEquals(providers.google.model, "gemini-2.0-flash");
});

Deno.test("Wizard: generateConfig for Z.AI provider", () => {
  const answers = makeAnswers({
    provider: "zai",
    providerModel: "glm-4.7",
  });
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const models = parsed.models as Record<string, unknown>;
  const providers = models.providers as Record<string, Record<string, string>>;
  assertEquals(providers.zai.model, "glm-4.7");
});

Deno.test("Wizard: generateConfig for OpenRouter provider", () => {
  const answers = makeAnswers({
    provider: "openrouter",
    providerModel: "anthropic/claude-sonnet-4-5",
  });
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const models = parsed.models as Record<string, unknown>;
  const providers = models.providers as Record<string, Record<string, string>>;
  assertEquals(providers.openrouter.model, "anthropic/claude-sonnet-4-5");
});

Deno.test("Wizard: generateConfig includes obsidian plugin when selected", () => {
  const answers = makeAnswers({
    selectedPlugins: ["obsidian"],
    obsidianVaultPath: "/home/user/vault",
    obsidianClassification: "CONFIDENTIAL",
  });
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const plugins = parsed.plugins as Record<string, Record<string, unknown>>;
  assertEquals(plugins.obsidian.enabled, true);
  assertEquals(plugins.obsidian.vault_path, "/home/user/vault");
  assertEquals(plugins.obsidian.classification, "CONFIDENTIAL");
});

Deno.test("Wizard: generateConfig omits plugins when none selected", () => {
  const answers = makeAnswers({ selectedPlugins: [] });
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  assertEquals(parsed.plugins, undefined);
});

// ─── generateSpine tests ─────────────────────────────────────────────────────

Deno.test("Wizard: generateSpine includes agent name as heading", () => {
  const answers = makeAnswers({ agentName: "Cleo" });
  const spine = generateSpine(answers);
  assertStringIncludes(spine, "# Cleo");
});

Deno.test("Wizard: generateSpine includes mission statement", () => {
  const answers = makeAnswers({
    mission: "Help me manage my day efficiently.",
  });
  const spine = generateSpine(answers);
  assertStringIncludes(spine, "Help me manage my day efficiently.");
});

Deno.test("Wizard: generateSpine sets professional tone", () => {
  const answers = makeAnswers({ tone: "professional" });
  const spine = generateSpine(answers);
  assertStringIncludes(spine, "Tone: Professional");
  assertStringIncludes(spine, "formally");
});

Deno.test("Wizard: generateSpine sets casual tone", () => {
  const answers = makeAnswers({ tone: "casual" });
  const spine = generateSpine(answers);
  assertStringIncludes(spine, "Tone: Casual");
  assertStringIncludes(spine, "friendly");
});

Deno.test("Wizard: generateSpine sets terse tone", () => {
  const answers = makeAnswers({ tone: "terse" });
  const spine = generateSpine(answers);
  assertStringIncludes(spine, "Tone: Terse");
  assertStringIncludes(spine, "extremely brief");
});

Deno.test("Wizard: generateSpine sets custom tone", () => {
  const answers = makeAnswers({
    tone: "custom",
    customTone: "Speak like a pirate captain",
  });
  const spine = generateSpine(answers);
  assertStringIncludes(spine, "Speak like a pirate captain");
});

Deno.test("Wizard: generateSpine includes security boundaries", () => {
  const answers = makeAnswers();
  const spine = generateSpine(answers);
  assertStringIncludes(spine, "Never share sensitive data");
  assertStringIncludes(spine, "classification levels");
});

// ─── Config validation integration ───────────────────────────────────────────

Deno.test({ name: "Wizard: generated config passes validateConfig", sanitizeResources: false, fn: async () => {
  const { validateConfig } = await import("../../src/cli/main.ts");
  const answers = makeAnswers();
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const result = validateConfig(parsed);
  assertEquals(result.ok, true);
}});

Deno.test("Wizard: generated config loads via loadConfig", async () => {
  const { loadConfig } = await import("../../src/cli/main.ts");
  const answers = makeAnswers();
  const yaml = generateConfig(answers);

  const tmpDir = await Deno.makeTempDir();
  const configPath = `${tmpDir}/triggerfish.yaml`;
  await Deno.writeTextFile(configPath, yaml);

  const result = loadConfig(configPath);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.models.primary.provider, "anthropic");
    assertEquals(result.value.models.primary.model, "claude-sonnet-4-5");
  }
  await Deno.remove(tmpDir, { recursive: true });
});

// ─── Directory creation ──────────────────────────────────────────────────────

Deno.test("Wizard: createDirectoryTree creates all required directories", async () => {
  const tmpDir = await Deno.makeTempDir();
  const baseDir = `${tmpDir}/triggerfish-test`;

  await createDirectoryTree(baseDir);

  // Check all directories exist
  const dirs = ["", "/workspace", "/skills", "/data", "/logs"];
  for (const dir of dirs) {
    const stat = await Deno.stat(`${baseDir}${dir}`);
    assert(stat.isDirectory, `${baseDir}${dir} should be a directory`);
  }

  await Deno.remove(tmpDir, { recursive: true });
});

// ─── CLI flag parsing ────────────────────────────────────────────────────────

Deno.test("Wizard: dive --install-daemon flag parses correctly", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["dive", "--install-daemon"]);
  assertEquals(cmd.command, "dive");
  assertEquals(cmd.flags["install-daemon"], true);
});

Deno.test("Wizard: dive --force flag parses correctly", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["dive", "--force"]);
  assertEquals(cmd.command, "dive");
  assertEquals(cmd.flags["force"], true);
});

// ─── generateConfig: secret: reference syntax ─────────────────────────────────

Deno.test("Wizard: generateConfig writes secret: ref for provider apiKey, not plaintext", () => {
  const answers = makeAnswers({
    provider: "anthropic",
    apiKey: "sk-ant-real-key",
  });
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const models = parsed.models as Record<string, unknown>;
  const providers = models.providers as Record<string, Record<string, string>>;
  // Must be a secret reference, not the actual key
  assertEquals(providers.anthropic.apiKey, "secret:provider:anthropic:apiKey");
  assertEquals(providers.anthropic.apiKey.includes("sk-ant-real-key"), false);
});

Deno.test("Wizard: generateConfig writes secret: ref for telegram botToken", () => {
  const answers = makeAnswers({
    channels: ["cli", "telegram"],
    telegramBotToken: "1234567890:ABCDEFabcdef",
  });
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const channels = parsed.channels as Record<string, Record<string, string>>;
  assertEquals(channels.telegram.botToken, "secret:telegram:botToken");
  assertEquals(
    channels.telegram.botToken.includes("ABCDEFabcdef"),
    false,
  );
});

Deno.test("Wizard: generateConfig writes secret: ref for Brave search api_key", () => {
  const answers = makeAnswers({
    searchProvider: "brave",
    searchApiKey: "BSV-real-key-value",
  });
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const web = parsed.web as Record<string, unknown>;
  const search = web.search as Record<string, string>;
  assertEquals(search.api_key, "secret:web:search:apiKey");
  assertEquals(search.api_key.includes("BSV-real-key-value"), false);
});

Deno.test("Wizard: generateConfig omits apiKey field when no key provided", () => {
  const answers = makeAnswers({ provider: "anthropic", apiKey: "" });
  const yaml = generateConfig(answers);
  const parsed = parseYaml(yaml) as Record<string, unknown>;
  const models = parsed.models as Record<string, unknown>;
  const providers = models.providers as Record<string, Record<string, string>>;
  assertEquals(providers.anthropic.apiKey, undefined);
});

// ─── storeWizardSecrets tests ─────────────────────────────────────────────────

Deno.test("Wizard: storeWizardSecrets stores provider apiKey in keychain", async () => {
  const store = createMemorySecretStore();
  const answers = makeAnswers({
    provider: "anthropic",
    apiKey: "sk-ant-test-key",
  });

  const stored = await storeWizardSecrets(answers, store);
  assertEquals(stored.includes("provider:anthropic:apiKey"), true);

  const result = await store.getSecret("provider:anthropic:apiKey");
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, "sk-ant-test-key");
});

Deno.test("Wizard: storeWizardSecrets stores telegram botToken in keychain", async () => {
  const store = createMemorySecretStore();
  const answers = makeAnswers({
    channels: ["cli", "telegram"],
    telegramBotToken: "123:TOKEN",
  });

  const stored = await storeWizardSecrets(answers, store);
  assertEquals(stored.includes("telegram:botToken"), true);

  const result = await store.getSecret("telegram:botToken");
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, "123:TOKEN");
});

Deno.test("Wizard: storeWizardSecrets stores Brave search apiKey in keychain", async () => {
  const store = createMemorySecretStore();
  const answers = makeAnswers({
    searchProvider: "brave",
    searchApiKey: "brave-api-key-abc",
  });

  const stored = await storeWizardSecrets(answers, store);
  assertEquals(stored.includes("web:search:apiKey"), true);

  const result = await store.getSecret("web:search:apiKey");
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, "brave-api-key-abc");
});

Deno.test("Wizard: storeWizardSecrets does not store keys for local providers (ollama)", async () => {
  const store = createMemorySecretStore();
  const answers = makeAnswers({
    provider: "ollama",
    apiKey: "should-not-be-stored",
  });

  const stored = await storeWizardSecrets(answers, store);
  assertEquals(stored.includes("provider:ollama:apiKey"), false);
});

Deno.test("Wizard: storeWizardSecrets returns empty array when no secrets provided", async () => {
  const store = createMemorySecretStore();
  const answers = makeAnswers({ apiKey: "", telegramBotToken: "", searchApiKey: "" });

  const stored = await storeWizardSecrets(answers, store);
  assertEquals(stored, []);
});
