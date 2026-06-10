/**
 * Pure functions for generating config files from wizard answers.
 *
 * All functions are side-effect-free and testable in isolation.
 *
 * @module
 */

import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";

import type {
  ClassificationModelEntry,
  ToneChoice,
  WizardAnswers,
} from "./wizard_types.ts";

// ─── Config section builders ─────────────────────────────────────────────────

/** Build the providers section of the config from wizard answers. */
function buildProviderConfigSection(
  answers: WizardAnswers,
): Record<string, Record<string, string>> {
  const providers: Record<string, Record<string, string>> = {};
  if (answers.provider === "triggerfish") {
    const cfg: Record<string, string> = {};
    if (answers.gatewayUrl.length > 0) {
      cfg["gatewayUrl"] = answers.gatewayUrl;
    }
    if (answers.licenseKey.length > 0) {
      cfg["licenseKey"] = "secret:cloud:licenseKey";
    }
    providers["triggerfish"] = cfg;
  } else if (answers.provider === "ollama" || answers.provider === "lmstudio") {
    providers[answers.provider] = {
      model: answers.providerModel,
      endpoint: answers.localEndpoint,
    };
  } else {
    const cfg: Record<string, string> = { model: answers.providerModel };
    if (answers.apiKey.length > 0) {
      cfg["apiKey"] = `secret:provider:${answers.provider}:apiKey`;
    }
    providers[answers.provider] = cfg;
  }

  // Add provider entries for classification model overrides
  if (answers.classificationModels) {
    for (const entry of Object.values(answers.classificationModels)) {
      if (!entry || providers[entry.provider]) continue;
      if (entry.provider === "ollama" || entry.provider === "lmstudio") {
        providers[entry.provider] = {
          model: entry.model,
          endpoint: entry.provider === "lmstudio"
            ? "http://localhost:1234"
            : "http://localhost:11434",
        };
      } else {
        providers[entry.provider] = { model: entry.model };
      }
    }
  }

  return providers;
}

/** Build the channels section of the config from wizard answers. */
function buildChannelConfigSection(
  answers: WizardAnswers,
): Record<string, Record<string, unknown>> {
  const channels: Record<string, Record<string, unknown>> = {};
  for (const ch of answers.channels) {
    if (ch === "webchat") {
      channels["webchat"] = {
        port: answers.webchatPort,
        classification: "PUBLIC",
      };
    } else if (ch === "telegram" && answers.telegramBotToken.length > 0) {
      const cfg: Record<string, unknown> = {
        botToken: "secret:telegram:botToken",
        classification: "INTERNAL",
      };
      // Only write a valid numeric owner ID. A blank or unparseable value is
      // omitted so the channel wires fail-closed (non-owner-only) and the
      // startup guard surfaces a WARN, instead of silently storing 0.
      const telegramOwnerId = parseInt(answers.telegramOwnerId, 10);
      if (Number.isFinite(telegramOwnerId) && telegramOwnerId > 0) {
        cfg["ownerId"] = telegramOwnerId;
      }
      channels["telegram"] = cfg;
    } else if (ch === "discord" && answers.discordBotToken.length > 0) {
      const cfg: Record<string, unknown> = {
        botToken: "secret:discord:botToken",
        classification: "PUBLIC",
      };
      if (answers.discordOwnerId.length > 0) {
        cfg["ownerId"] = answers.discordOwnerId;
      }
      channels["discord"] = cfg;
    } else if (ch === "signal" && answers.signalPhoneNumber.length > 0) {
      channels["signal"] = {
        endpoint: answers.signalEndpoint || "tcp://127.0.0.1:7583",
        account: answers.signalPhoneNumber,
        classification: "INTERNAL",
        ownerPhone: answers.signalPhoneNumber,
      };
    } else if (
      ch === "googlechat" && answers.googlechatCredentialsRef.length > 0
    ) {
      const cfg: Record<string, unknown> = {
        enabled: true,
        credentials_ref: `secret:googlechat:credentials`,
        pubsub_subscription: answers.googlechatPubsubSubscription,
        classification: "INTERNAL",
      };
      if (answers.googlechatOwnerEmail.length > 0) {
        cfg["owner_email"] = answers.googlechatOwnerEmail;
      }
      channels["googlechat"] = cfg;
    }
  }
  return channels;
}

/** Build the web search section of the config from wizard answers. */
function buildWebSearchConfigSection(
  answers: WizardAnswers,
): Record<string, unknown> {
  // Triggerfish Gateway includes search via the gateway — no separate config needed
  if (answers.provider === "triggerfish") {
    return { search: { provider: "cloud" } };
  }
  if (answers.searchProvider === "brave" && answers.searchApiKey.length > 0) {
    return {
      search: { provider: "brave", api_key: "secret:web:search:apiKey" },
    };
  }
  if (answers.searchProvider === "searxng" && answers.searxngUrl.length > 0) {
    return { search: { provider: "searxng", endpoint: answers.searxngUrl } };
  }
  return {};
}

/** Build per-classification model overrides for the config. */
function buildClassificationModelsSection(
  answers: WizardAnswers,
): Record<string, { provider: string; model: string }> | undefined {
  if (!answers.classificationModels) return undefined;
  const entries = Object.entries(answers.classificationModels) as [
    string,
    ClassificationModelEntry | undefined,
  ][];
  const result: Record<string, { provider: string; model: string }> = {};
  for (const [level, entry] of entries) {
    if (!entry) continue;
    result[level] = { provider: entry.provider, model: entry.model };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Append plugins config to the config object if applicable. */
function appendPluginsConfig(
  config: Record<string, unknown>,
  answers: WizardAnswers,
): void {
  if (
    answers.selectedPlugins.includes("obsidian") &&
    answers.obsidianVaultPath.length > 0
  ) {
    config["plugins"] = {
      obsidian: {
        enabled: true,
        vault_path: answers.obsidianVaultPath,
        classification: answers.obsidianClassification || "INTERNAL",
        daily_notes: { folder: "daily", date_format: "YYYY-MM-DD" },
      },
    };
  }
}

// ─── Config generation ───────────────────────────────────────────────────────

/**
 * Generate triggerfish.yaml content from wizard answers.
 *
 * All API keys and tokens are written as `secret:<key>` references
 * rather than plaintext. The actual values must be stored in the OS
 * keychain separately (see `storeWizardSecrets()`).
 */
export function generateConfig(answers: WizardAnswers): string {
  const providers = buildProviderConfigSection(answers);
  const channels = buildChannelConfigSection(answers);
  const web = buildWebSearchConfigSection(answers);

  const classificationModels = buildClassificationModelsSection(answers);
  const modelsSection: Record<string, unknown> = {
    primary: {
      provider: answers.provider,
      model: answers.providerModel,
    },
    providers,
  };
  if (classificationModels) {
    modelsSection["classification_models"] = classificationModels;
  }

  const config: Record<string, unknown> = {
    models: modelsSection,
    channels: Object.keys(channels).length > 0 ? channels : {},
    classification: { mode: "personal", levels: "standard" },
  };

  if (Object.keys(web).length > 0) config["web"] = web;
  appendPluginsConfig(config, answers);
  config["logging"] = { level: "normal" };

  const yaml = stringifyYaml(config);
  return `# Triggerfish Configuration\n# Generated by triggerfish dive\n\n${yaml}`;
}

// ─── SPINE.md generation ─────────────────────────────────────────────────────

/** Generate SPINE.md content from wizard answers. */
export function generateSpine(answers: WizardAnswers): string {
  const toneName = answers.tone === "custom"
    ? answers.customTone
    : answers.tone.charAt(0).toUpperCase() + answers.tone.slice(1);

  const toneGuidelines = buildToneGuidelines(answers.tone, answers.customTone);

  return `# ${answers.agentName}

${answers.mission}

## Communication Style

Tone: ${toneName}
${toneGuidelines}

## Boundaries

- Never share sensitive data with unauthorized recipients
- Always respect classification levels
- Ask for clarification when instructions are ambiguous
- Log actions transparently
`;
}

/** Build tone-specific guidelines for SPINE.md. */
export function buildToneGuidelines(
  tone: ToneChoice,
  customTone: string,
): string {
  switch (tone) {
    case "professional":
      return `- Respond clearly, concisely, and formally
- Use complete sentences
- Maintain a helpful but businesslike demeanor`;
    case "casual":
      return `- Be friendly and conversational
- Use natural language, contractions are fine
- Keep things light but stay helpful`;
    case "terse":
      return `- Be extremely brief
- No filler words or pleasantries
- Get straight to the point`;
    case "custom":
      return `- ${customTone}`;
  }
}

// ─── TRIGGER.md generation ───────────────────────────────────────────────────

/** Generate a default TRIGGER.md with a minimal starting template. */
export function generateTrigger(): string {
  return `# Check on each wakeup

- Any unread messages older than 1 hour
- Calendar events in the next 4 hours
- Anything urgent in email
`;
}

// ─── Directory setup ─────────────────────────────────────────────────────────

/** Create the ~/.triggerfish directory tree. */
export async function createDirectoryTree(baseDir: string): Promise<void> {
  const dirs = [
    baseDir,
    join(baseDir, "workspace"),
    join(baseDir, "skills"),
    join(baseDir, "data"),
    join(baseDir, "logs"),
  ];
  for (const dir of dirs) {
    await Deno.mkdir(dir, { recursive: true });
  }
}
