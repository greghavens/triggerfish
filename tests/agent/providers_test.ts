/**
 * Phase 10: LLM Provider Tests
 *
 * Unit tests for all provider factory functions and config loader.
 * Integration tests (real API calls) run only when credentials are set.
 */
import { assertEquals, assertExists, assert, assertRejects } from "@std/assert";
import {
  createProviderRegistry,
  type LlmProvider,
} from "../../src/agent/llm.ts";
import { createAnthropicProvider } from "../../src/agent/providers/anthropic.ts";
import { createOpenAiProvider } from "../../src/agent/providers/openai.ts";
import { createGoogleProvider } from "../../src/agent/providers/google.ts";
import { createLocalProvider } from "../../src/agent/providers/local.ts";
import { createOpenRouterProvider } from "../../src/agent/providers/openrouter.ts";
import { createZenMuxProvider } from "../../src/agent/providers/zenmux.ts";
import { createZaiProvider } from "../../src/agent/providers/zai.ts";
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
      google: { model: "gemini-2.0-flash" },
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
      openrouter: { model: "anthropic/claude-3.5-sonnet", apiKey: "sk-or-test-key" },
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
    primary: { provider: "lmstudio", model: "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF" },
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

// --- Classification provider registry ---

Deno.test("Registry: getForClassification returns undefined when no classification providers set", () => {
  const registry = createProviderRegistry();
  const result = registry.getForClassification("RESTRICTED");
  assertEquals(result, undefined);
});

Deno.test("Registry: getForClassification returns exact match", () => {
  const registry = createProviderRegistry();
  const provider = createOpenAiProvider({ apiKey: "test-key" });
  registry.setClassificationProvider("RESTRICTED", provider);
  const result = registry.getForClassification("RESTRICTED");
  assertEquals(result?.name, "openai");
});

Deno.test("Registry: getForClassification falls back to highest configured level at or below taint", () => {
  const registry = createProviderRegistry();
  // Only INTERNAL configured — should apply to CONFIDENTIAL and RESTRICTED too
  const internalProvider = createOpenAiProvider({ apiKey: "test-key" });
  registry.setClassificationProvider("INTERNAL", internalProvider);

  // INTERNAL exact match
  assertEquals(registry.getForClassification("INTERNAL")?.name, "openai");
  // CONFIDENTIAL(3) > INTERNAL(2) — fallback to INTERNAL
  assertEquals(registry.getForClassification("CONFIDENTIAL")?.name, "openai");
  // RESTRICTED(4) > INTERNAL(2) — fallback to INTERNAL
  assertEquals(registry.getForClassification("RESTRICTED")?.name, "openai");
  // PUBLIC(1) < INTERNAL(2) — no configured level ≤ PUBLIC, return undefined
  assertEquals(registry.getForClassification("PUBLIC"), undefined);
});

Deno.test("Registry: getForClassification prefers highest configured level below taint", () => {
  const registry = createProviderRegistry();
  const internalProvider = createOpenAiProvider({ apiKey: "test-key" });
  const restrictedProvider = createAnthropicProvider({ apiKey: "test-key" });
  registry.setClassificationProvider("INTERNAL", internalProvider);
  registry.setClassificationProvider("RESTRICTED", restrictedProvider);

  // CONFIDENTIAL(3): highest configured ≤ 3 is INTERNAL(2) → openai
  assertEquals(registry.getForClassification("CONFIDENTIAL")?.name, "openai");
  // RESTRICTED(4): exact match → anthropic
  assertEquals(registry.getForClassification("RESTRICTED")?.name, "anthropic");
});

Deno.test("loadProvidersFromConfig: registers classification-specific provider", () => {
  const registry = createProviderRegistry();
  loadProvidersFromConfig({
    primary: { provider: "anthropic", model: "claude-sonnet-4-5" },
    providers: {
      anthropic: { model: "claude-sonnet-4-5" },
      openai: { model: "gpt-4o" },
    },
    classification: {
      RESTRICTED: { provider: "openai" },
    },
  }, registry);

  // Primary is still anthropic
  assertEquals(registry.getDefault()?.name, "anthropic");
  // RESTRICTED uses openai
  assertEquals(registry.getForClassification("RESTRICTED")?.name, "openai");
  // CONFIDENTIAL falls back to INTERNAL/closest — none configured below CONFIDENTIAL except openai at RESTRICTED
  // CONFIDENTIAL(3) — RESTRICTED(4) is above 3, so no fallback → undefined
  assertEquals(registry.getForClassification("CONFIDENTIAL"), undefined);
  // INTERNAL(2) < RESTRICTED(4) — no fallback → undefined
  assertEquals(registry.getForClassification("INTERNAL"), undefined);
});

Deno.test("loadProvidersFromConfig: classification model override uses specified model", () => {
  const registry = createProviderRegistry();
  loadProvidersFromConfig({
    primary: { provider: "anthropic", model: "claude-sonnet-4-5" },
    providers: {
      anthropic: { model: "claude-sonnet-4-5" },
      openai: { model: "gpt-4o" },
    },
    classification: {
      INTERNAL: { provider: "openai", model: "gpt-4o-mini" },
    },
  }, registry);

  const provider = registry.getForClassification("INTERNAL");
  assertExists(provider);
  assertEquals(provider!.name, "openai");
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
    const provider = createOpenAiProvider({});
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
    const provider = createGoogleProvider({});
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
    ];

    assertEquals(providers.length, 8);
    for (const p of providers) {
      assertExists(p.name);
      assertExists(p.complete);
      assertEquals(typeof p.supportsStreaming, "boolean");
    }
  },
});
