/**
 * Phase 10: LLM Provider Tests
 *
 * Unit tests for all provider factory functions and config loader.
 * Integration tests (real API calls) run only when credentials are set.
 */
import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  createProviderRegistry,
  type LlmProvider,
} from "../../src/agent/llm.ts";
import { createAnthropicProvider } from "../../src/agent/providers/anthropic.ts";
import { createOpenAiProvider } from "../../src/agent/providers/openai.ts";
import { createGoogleProvider } from "../../src/agent/providers/google/google.ts";
import { createLocalProvider } from "../../src/agent/providers/local.ts";
import { createOpenRouterProvider } from "../../src/agent/providers/openrouter/openrouter.ts";
import { createZenMuxProvider } from "../../src/agent/providers/zenmux.ts";
import { createZaiProvider } from "../../src/agent/providers/zai.ts";
import { createFireworksProvider } from "../../src/agent/providers/fireworks.ts";
import { loadProvidersFromConfig } from "../../src/agent/providers/config.ts";

// --- Factory function tests (no API calls) ---

Deno.test("AnthropicProvider: factory creates provider with correct name", () => {
  const provider = createAnthropicProvider({ apiKey: "test-key" });
  assertEquals(provider.name, "anthropic");
  assertEquals(provider.supportsStreaming, true);
});

Deno.test("OpenAiProvider: factory creates provider with correct name", () => {
  const provider = createOpenAiProvider({ apiKey: "test-key" });
  assertEquals(provider.name, "openai");
  assertEquals(provider.supportsStreaming, true);
});

Deno.test("GoogleProvider: factory creates provider with correct name", () => {
  const provider = createGoogleProvider({ apiKey: "test-key" });
  assertEquals(provider.name, "google");
  assertEquals(provider.supportsStreaming, true);
});

Deno.test("LocalProvider: factory creates provider with correct name", () => {
  const provider = createLocalProvider({ model: "llama3" });
  assertEquals(provider.name, "ollama");
  assertEquals(provider.supportsStreaming, true);
});

Deno.test("LocalProvider: name override creates provider with lmstudio name", () => {
  const provider = createLocalProvider({ model: "test", name: "lmstudio" });
  assertEquals(provider.name, "lmstudio");
  assertEquals(provider.supportsStreaming, true);
});

Deno.test("OpenRouterProvider: factory creates provider with correct name", () => {
  const provider = createOpenRouterProvider({
    apiKey: "test-key",
    model: "anthropic/claude-3.5-sonnet",
  });
  assertEquals(provider.name, "openrouter");
  assertEquals(provider.supportsStreaming, true);
});

Deno.test("ZenMuxProvider: factory creates provider with correct name", () => {
  const provider = createZenMuxProvider({
    apiKey: "test-key",
    model: "openai/gpt-5",
  });
  assertEquals(provider.name, "zenmux");
  assertEquals(provider.supportsStreaming, true);
});

Deno.test("ZaiProvider: factory creates provider with correct name", () => {
  const provider = createZaiProvider({
    apiKey: "test-key",
    model: "glm-4.7",
  });
  assertEquals(provider.name, "zai");
  assertEquals(provider.supportsStreaming, true);
});

Deno.test("FireworksProvider: factory creates provider with correct name", () => {
  const provider = createFireworksProvider({
    apiKey: "test-key",
    model: "accounts/fireworks/models/llama-v3p1-70b-instruct",
  });
  assertEquals(provider.name, "fireworks");
  assertEquals(provider.supportsStreaming, true);
});

// --- No env-var fallback (AGENT-EXEC-1) ---
// API keys come from triggerfish.yaml/keychain only. A legacy env var must
// never be picked up; an unconfigured provider yields a clear error.

/** Run fn with an env var temporarily set, restoring the original value. */
async function withEnvVar(
  name: string,
  value: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  const original = Deno.env.get(name);
  Deno.env.set(name, value);
  try {
    await fn();
  } finally {
    if (original === undefined) Deno.env.delete(name);
    else Deno.env.set(name, original);
  }
}

Deno.test("AnthropicProvider: no apiKey rejects even when env var set", async () => {
  await withEnvVar("ANTHROPIC_API_KEY", "env-key-must-be-ignored", async () => {
    const provider = createAnthropicProvider({});
    await assertRejects(
      () => provider.complete([{ role: "user", content: "hi" }], [], {}),
      Error,
      "Anthropic API key not configured",
    );
  });
});

Deno.test("OpenAiProvider: no apiKey rejects even when env var set", async () => {
  await withEnvVar("OPENAI_API_KEY", "env-key-must-be-ignored", async () => {
    const provider = createOpenAiProvider({});
    await assertRejects(
      () => provider.complete([{ role: "user", content: "hi" }], [], {}),
      Error,
      "OpenAI API key not configured",
    );
  });
});

Deno.test("GoogleProvider: no apiKey throws even when env var set", async () => {
  await withEnvVar("GOOGLE_API_KEY", "env-key-must-be-ignored", () => {
    assertThrows(
      () => createGoogleProvider({}),
      Error,
      "Google API key not configured",
    );
  });
});

Deno.test("OpenRouterProvider: no apiKey throws even when env var set", async () => {
  await withEnvVar("OPENROUTER_API_KEY", "env-key-must-be-ignored", () => {
    assertThrows(
      () => createOpenRouterProvider({ model: "openai/gpt-4o" }),
      Error,
      "OpenRouter API key not configured",
    );
  });
});

Deno.test("ZenMuxProvider: no apiKey throws even when env var set", async () => {
  await withEnvVar("ZENMUX_API_KEY", "env-key-must-be-ignored", () => {
    assertThrows(
      () => createZenMuxProvider({ model: "openai/gpt-5" }),
      Error,
      "ZenMux API key not configured",
    );
  });
});

Deno.test("ZaiProvider: no apiKey throws even when env var set", async () => {
  await withEnvVar("ZAI_API_KEY", "env-key-must-be-ignored", () => {
    assertThrows(
      () => createZaiProvider({ model: "glm-4.7" }),
      Error,
      "Z.AI API key not configured",
    );
  });
});

Deno.test("FireworksProvider: no apiKey throws even when env var set", async () => {
  await withEnvVar("FIREWORKS_API_KEY", "env-key-must-be-ignored", () => {
    assertThrows(
      () => createFireworksProvider({ model: "accounts/fireworks/models/x" }),
      Error,
      "Fireworks API key not configured",
    );
  });
});

// --- Config loader tests ---

Deno.test("loadProvidersFromConfig: registers anthropic provider", () => {
  const registry = createProviderRegistry();
  loadProvidersFromConfig({
    primary: { provider: "anthropic", model: "claude-sonnet-4-5" },
    providers: {
      anthropic: { model: "claude-sonnet-4-5" },
    },
  }, registry);

  const provider = registry.get("anthropic");
  assertExists(provider);
  assertEquals(provider!.name, "anthropic");
});

Deno.test("loadProvidersFromConfig: sets default from primary provider", () => {
  const registry = createProviderRegistry();
  loadProvidersFromConfig({
    primary: { provider: "anthropic", model: "claude-sonnet-4-5" },
    providers: {
      anthropic: { model: "claude-sonnet-4-5" },
    },
  }, registry);

  const defaultProvider = registry.getDefault();
  assertExists(defaultProvider);
  assertEquals(defaultProvider!.name, "anthropic");
});

Deno.test("loadProvidersFromConfig: resolves openai as default", () => {
  const registry = createProviderRegistry();
  loadProvidersFromConfig({
    primary: { provider: "openai", model: "gpt-4o" },
    providers: {
      openai: { model: "gpt-4o" },
    },
  }, registry);

  const defaultProvider = registry.getDefault();
  assertExists(defaultProvider);
  assertEquals(defaultProvider!.name, "openai");
});

Deno.test("loadProvidersFromConfig: resolves google as default", () => {
  const registry = createProviderRegistry();
  loadProvidersFromConfig({
    primary: { provider: "google", model: "gemini-2.0-flash" },
    providers: {
      google: { model: "gemini-2.0-flash", apiKey: "g-test-key" },
    },
  }, registry);

  const defaultProvider = registry.getDefault();
  assertExists(defaultProvider);
  assertEquals(defaultProvider!.name, "google");
});

Deno.test("loadProvidersFromConfig: registers multiple providers", () => {
  const registry = createProviderRegistry();
  loadProvidersFromConfig({
    primary: { provider: "anthropic", model: "claude-sonnet-4-5" },
    providers: {
      anthropic: { model: "claude-sonnet-4-5" },
      openai: { model: "gpt-4o" },
      ollama: { model: "llama3", endpoint: "http://localhost:11434" },
    },
  }, registry);

  assertExists(registry.get("anthropic"));
  assertExists(registry.get("openai"));
  assertExists(registry.get("ollama"));
  assertEquals(registry.getDefault()!.name, "anthropic");
});

Deno.test("loadProvidersFromConfig: resolves openrouter as default", () => {
  const registry = createProviderRegistry();
  loadProvidersFromConfig({
    primary: { provider: "openrouter", model: "anthropic/claude-3.5-sonnet" },
    providers: {
      openrouter: {
        model: "anthropic/claude-3.5-sonnet",
        apiKey: "sk-or-test-key",
      },
    },
  }, registry);

  const defaultProvider = registry.getDefault();
  assertExists(defaultProvider);
  assertEquals(defaultProvider!.name, "openrouter");
});

Deno.test("loadProvidersFromConfig: registers zai provider and sets default", () => {
  const registry = createProviderRegistry();
  loadProvidersFromConfig({
    primary: { provider: "zai", model: "glm-4.7" },
    providers: {
      zai: { model: "glm-4.7", apiKey: "zai-test-key" },
    },
  }, registry);

  const provider = registry.get("zai");
  assertExists(provider);
  assertEquals(provider!.name, "zai");

  const defaultProvider = registry.getDefault();
  assertExists(defaultProvider);
  assertEquals(defaultProvider!.name, "zai");
});

Deno.test("loadProvidersFromConfig: sets zai as default with different model", () => {
  const registry = createProviderRegistry();
  loadProvidersFromConfig({
    primary: { provider: "zai", model: "glm-4.5" },
    providers: {
      zai: { model: "glm-4.5", apiKey: "zai-test-key" },
    },
  }, registry);

  const defaultProvider = registry.getDefault();
  assertExists(defaultProvider);
  assertEquals(defaultProvider!.name, "zai");
});

Deno.test("loadProvidersFromConfig: registers lmstudio provider", () => {
  const registry = createProviderRegistry();
  loadProvidersFromConfig({
    primary: {
      provider: "lmstudio",
      model: "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF",
    },
    providers: {
      lmstudio: { model: "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF" },
    },
  }, registry);

  const provider = registry.get("lmstudio");
  assertExists(provider);
  assertEquals(provider!.name, "lmstudio");

  const defaultProvider = registry.getDefault();
  assertExists(defaultProvider);
  assertEquals(defaultProvider!.name, "lmstudio");
});

Deno.test("loadProvidersFromConfig: registers lmstudio with multiple providers", () => {
  const registry = createProviderRegistry();
  loadProvidersFromConfig({
    primary: { provider: "anthropic", model: "claude-sonnet-4-5" },
    providers: {
      anthropic: { model: "claude-sonnet-4-5" },
      lmstudio: { model: "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF" },
    },
  }, registry);

  assertExists(registry.get("anthropic"));
  assertExists(registry.get("lmstudio"));
  assertEquals(registry.getDefault()!.name, "anthropic");
});

Deno.test("loadProvidersFromConfig: registers zenmux provider", () => {
  const registry = createProviderRegistry();
  loadProvidersFromConfig({
    primary: { provider: "zenmux", model: "openai/gpt-5" },
    providers: {
      zenmux: { model: "openai/gpt-5", apiKey: "zm-test-key" },
    },
  }, registry);

  const provider = registry.get("zenmux");
  assertExists(provider);
  assertEquals(provider!.name, "zenmux");

  const defaultProvider = registry.getDefault();
  assertExists(defaultProvider);
  assertEquals(defaultProvider!.name, "zenmux");
});

Deno.test("loadProvidersFromConfig: registers fireworks provider and sets default", () => {
  const registry = createProviderRegistry();
  loadProvidersFromConfig({
    primary: {
      provider: "fireworks",
      model: "accounts/fireworks/models/llama-v3p1-70b-instruct",
    },
    providers: {
      fireworks: {
        model: "accounts/fireworks/models/llama-v3p1-70b-instruct",
        apiKey: "fw-test-key",
      },
    },
  }, registry);

  const provider = registry.get("fireworks");
  assertExists(provider);
  assertEquals(provider!.name, "fireworks");

  const defaultProvider = registry.getDefault();
  assertExists(defaultProvider);
  assertEquals(defaultProvider!.name, "fireworks");
});

// --- LocalProvider: HTTP error handling ---

Deno.test("LocalProvider: throws on non-200 response", async () => {
  // Use a port that's unlikely to be listening
  const provider = createLocalProvider({
    endpoint: "http://127.0.0.1:1",
    model: "test",
  });

  await assertRejects(
    () => provider.complete([{ role: "user", content: "hi" }], [], {}),
    Error,
  );
});

// --- Integration tests (skip if no credentials) ---

Deno.test({
  name: "AnthropicProvider: real API call with API key (integration)",
  ignore: !Deno.env.get("ANTHROPIC_API_KEY"),
  async fn() {
    const provider = createAnthropicProvider({
      apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
    });
    const result = await provider.complete(
      [{ role: "user", content: "Say just the word 'hello'" }],
      [],
      {},
    );

    assert(result.content.length > 0, "Should get non-empty response");
    assert(result.usage.inputTokens > 0, "Should report input tokens");
    assert(result.usage.outputTokens > 0, "Should report output tokens");
  },
});

Deno.test({
  name: "OpenAiProvider: real API call (integration)",
  ignore: !Deno.env.get("OPENAI_API_KEY"),
  async fn() {
    const provider = createOpenAiProvider({
      apiKey: Deno.env.get("OPENAI_API_KEY"),
    });
    const result = await provider.complete(
      [{ role: "user", content: "Say just the word 'hello'" }],
      [],
      {},
    );

    assert(result.content.length > 0, "Should get non-empty response");
    assert(result.usage.inputTokens > 0, "Should report input tokens");
    assert(result.usage.outputTokens > 0, "Should report output tokens");
  },
});

Deno.test({
  name: "GoogleProvider: real API call (integration)",
  ignore: !Deno.env.get("GOOGLE_API_KEY"),
  async fn() {
    const provider = createGoogleProvider({
      apiKey: Deno.env.get("GOOGLE_API_KEY"),
    });
    const result = await provider.complete(
      [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Say just the word 'hello'" },
      ],
      [],
      {},
    );

    assert(result.content.length > 0, "Should get non-empty response");
  },
});

Deno.test({
  name: "ZenMuxProvider: real API call (integration)",
  ignore: !Deno.env.get("ZENMUX_API_KEY"),
  async fn() {
    const provider = createZenMuxProvider({
      model: "openai/gpt-4o",
      apiKey: Deno.env.get("ZENMUX_API_KEY"),
    });
    const result = await provider.complete(
      [{ role: "user", content: "Say just the word 'hello'" }],
      [],
      {},
    );

    assert(result.content.length > 0, "Should get non-empty response");
    assert(result.usage.inputTokens > 0, "Should report input tokens");
    assert(result.usage.outputTokens > 0, "Should report output tokens");
  },
});

Deno.test({
  name: "ZaiProvider: real API call (integration)",
  ignore: !Deno.env.get("ZAI_API_KEY"),
  async fn() {
    const provider = createZaiProvider({
      model: "glm-4.7",
      apiKey: Deno.env.get("ZAI_API_KEY"),
    });
    const result = await provider.complete(
      [{ role: "user", content: "Say just the word 'hello'" }],
      [],
      {},
    );

    assert(result.content.length > 0, "Should get non-empty response");
    assert(result.usage.inputTokens > 0, "Should report input tokens");
    assert(result.usage.outputTokens > 0, "Should report output tokens");
  },
});

Deno.test({
  name: "FireworksProvider: real API call (integration)",
  ignore: !Deno.env.get("FIREWORKS_API_KEY"),
  async fn() {
    const provider = createFireworksProvider({
      model: "accounts/fireworks/models/llama-v3p1-70b-instruct",
      apiKey: Deno.env.get("FIREWORKS_API_KEY"),
    });
    const result = await provider.complete(
      [{ role: "user", content: "Say just the word 'hello'" }],
      [],
      {},
    );

    assert(result.content.length > 0, "Should get non-empty response");
    assert(result.usage.inputTokens > 0, "Should report input tokens");
    assert(result.usage.outputTokens > 0, "Should report output tokens");
  },
});

Deno.test({
  name: "Providers: all conform to LlmProvider interface",
  fn() {
    // Verify all providers satisfy the interface at compile time
    const providers: readonly LlmProvider[] = [
      createAnthropicProvider({ apiKey: "test" }),
      createOpenAiProvider({ apiKey: "test" }),
      createGoogleProvider({ apiKey: "test" }),
      createLocalProvider({ model: "test" }),
      createLocalProvider({ model: "test", name: "lmstudio" }),
      createOpenRouterProvider({ apiKey: "test", model: "test" }),
      createZenMuxProvider({ apiKey: "test", model: "test" }),
      createZaiProvider({ apiKey: "test", model: "test" }),
      createFireworksProvider({ apiKey: "test", model: "test" }),
    ];

    assertEquals(providers.length, 9);
    for (const p of providers) {
      assertExists(p.name);
      assertExists(p.complete);
      assertEquals(typeof p.supportsStreaming, "boolean");
    }
  },
});
