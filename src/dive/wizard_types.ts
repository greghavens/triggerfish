/**
 * Type definitions and constants for the dive wizard.
 *
 * @module
 */

/** Result returned by the dive wizard. */
export interface DiveResult {
  readonly configPath: string;
  readonly spinePath: string;
  readonly installDaemon: boolean;
  readonly channels: ReadonlyArray<string>;
}

/** LLM provider choice. */
export type ProviderChoice =
  | "anthropic"
  | "openai"
  | "google"
  | "ollama"
  | "lmstudio"
  | "openrouter"
  | "zenmux"
  | "zai";

/** Tone choice for SPINE.md. */
export type ToneChoice = "professional" | "casual" | "terse" | "custom";

/** Channel choice for setup. */
export type ChannelChoice = "cli" | "webchat" | "telegram" | "discord" | "signal" | "skip";

/** Search provider choice. */
export type SearchProviderChoice = "brave" | "searxng" | "skip";

/** All answers collected from the wizard steps. */
export interface WizardAnswers {
  readonly provider: ProviderChoice;
  readonly providerModel: string;
  readonly apiKey: string;
  readonly agentName: string;
  readonly mission: string;
  readonly tone: ToneChoice;
  readonly customTone: string;
  readonly channels: ReadonlyArray<ChannelChoice>;
  readonly telegramBotToken: string;
  readonly telegramOwnerId: string;
  readonly discordBotToken: string;
  readonly discordOwnerId: string;
  readonly webchatPort: number;
  readonly signalPhoneNumber: string;
  readonly signalEndpoint: string;
  readonly selectedPlugins: ReadonlyArray<string>;
  readonly obsidianVaultPath: string;
  readonly obsidianClassification: string;
  readonly searchProvider: SearchProviderChoice;
  readonly searchApiKey: string;
  readonly searxngUrl: string;
  readonly localEndpoint: string;
  readonly installDaemon: boolean;
  /**
   * Optional per-classification provider overrides chosen in the wizard.
   * Only levels with explicit overrides are present.
   * PUBLIC is excluded — that's what `primary` covers.
   */
  readonly classificationModels: Partial<Record<
    "RESTRICTED" | "CONFIDENTIAL" | "INTERNAL",
    ClassificationModelOverride
  >>;
}

/** Default models per provider. */
export const DEFAULT_MODELS: Readonly<Record<ProviderChoice, string>> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o",
  google: "gemini-2.0-flash",
  ollama: "llama3",
  lmstudio: "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF",
  openrouter: "anthropic/claude-sonnet-4-5",
  zenmux: "openai/gpt-5",
  zai: "glm-4.7",
};

/** Human-readable labels for provider selection. */
export const PROVIDER_LABELS: Readonly<Record<ProviderChoice, string>> = {
  anthropic: "Anthropic (Claude) — recommended",
  openai: "OpenAI (GPT-4o)",
  google: "Google (Gemini)",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  openrouter: "OpenRouter",
  zenmux: "ZenMux",
  zai: "Z.AI Coding Plan (GLM)",
};

/** Per-classification model override collected by the wizard. */
export interface ClassificationModelOverride {
  readonly provider: ProviderChoice;
  readonly model: string;
}

/** Section identifiers for selective reconfiguration. */
export type WizardSection =
  | "llm"
  | "agent"
  | "channels"
  | "plugins"
  | "google"
  | "github"
  | "search"
  | "daemon";
