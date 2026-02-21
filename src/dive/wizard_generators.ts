/**
 * Pure functions for generating config files from wizard answers.
 *
 * All functions are side-effect-free and testable in isolation.
 *
 * @module
 */

import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";

import type { ClassificationModelOverride, ToneChoice, WizardAnswers } from "./wizard_types.ts";

// ─── Config generation ───────────────────────────────────────────────────────

/**
 * Generate triggerfish.yaml content from wizard answers.
 *
 * All API keys and tokens are written as `secret:<key>` references
 * rather than plaintext. The actual values must be stored in the OS
 * keychain separately (see `storeWizardSecrets()`).
 */
export function generateConfig(answers: WizardAnswers): string {
  // Build providers section
  const providers: Record<string, Record<string, string>> = {};

  if (answers.provider === "anthropic") {
    const anthropicConfig: Record<string, string> = {
      model: answers.providerModel,
    };
    if (answers.apiKey.length > 0) {
      // Store reference, not plaintext
      anthropicConfig["apiKey"] = `secret:provider:${answers.provider}:apiKey`;
    }
    providers["anthropic"] = anthropicConfig;
  } else if (answers.provider === "ollama") {
    providers["ollama"] = {
      model: answers.providerModel,
      endpoint: answers.localEndpoint,
    };
  } else if (answers.provider === "lmstudio") {
    providers["lmstudio"] = {
      model: answers.providerModel,
      endpoint: answers.localEndpoint,
    };
  } else {
    const providerConfig: Record<string, string> = {
      model: answers.providerModel,
    };
    if (answers.apiKey.length > 0) {
      // Store reference, not plaintext
      providerConfig["apiKey"] = `secret:provider:${answers.provider}:apiKey`;
    }
    providers[answers.provider] = providerConfig;
  }

  // Build channels section
  const channels: Record<string, Record<string, unknown>> = {};

  for (const ch of answers.channels) {
    if (ch === "webchat") {
      channels["webchat"] = {
        port: answers.webchatPort,
        classification: "PUBLIC",
      };
    } else if (ch === "telegram" && answers.telegramBotToken.length > 0) {
      const telegramConfig: Record<string, unknown> = {
        // Store reference, not plaintext
        botToken: "secret:telegram:botToken",
        classification: "INTERNAL",
      };
      if (answers.telegramOwnerId.length > 0) {
        telegramConfig["ownerId"] = parseInt(answers.telegramOwnerId, 10) || 0;
      }
      channels["telegram"] = telegramConfig;
    } else if (ch === "discord" && answers.discordBotToken.length > 0) {
      const discordConfig: Record<string, unknown> = {
        // Store reference, not plaintext
        botToken: "secret:discord:botToken",
        classification: "PUBLIC",
      };
      if (answers.discordOwnerId.length > 0) {
        discordConfig["ownerId"] = answers.discordOwnerId;
      }
      channels["discord"] = discordConfig;
    } else if (ch === "signal" && answers.signalPhoneNumber.length > 0) {
      const signalConfig: Record<string, unknown> = {
        endpoint: answers.signalEndpoint || "tcp://127.0.0.1:7583",
        account: answers.signalPhoneNumber,
        classification: "INTERNAL",
        ownerPhone: answers.signalPhoneNumber,
      };
      channels["signal"] = signalConfig;
    }
    // CLI is always available, no config needed
  }

  // Build web section (if search provider selected)
  const web: Record<string, unknown> = {};
  if (answers.searchProvider === "brave" && answers.searchApiKey.length > 0) {
    web["search"] = {
      provider: "brave",
      // Store reference, not plaintext
      api_key: "secret:web:search:apiKey",
    };
  } else if (
    answers.searchProvider === "searxng" && answers.searxngUrl.length > 0
  ) {
    web["search"] = {
      provider: "searxng",
      endpoint: answers.searxngUrl,
    };
  }

  // Build per-classification model block if any overrides were configured
  const classificationBlock = buildClassificationBlock(answers.classificationModels);

  // Build full config object
  const config: Record<string, unknown> = {
    models: {
      primary: {
        provider: answers.provider,
        model: answers.providerModel,
      },
      ...(classificationBlock ? { classification: classificationBlock } : {}),
      providers,
    },
    channels: Object.keys(channels).length > 0 ? channels : {},
    classification: {
      mode: "personal",
      levels: "standard",
    },
  };

  if (Object.keys(web).length > 0) {
    config["web"] = web;
  }

  // Build plugins section
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

  // Logging defaults
  config["logging"] = { level: "normal" };

  // Generate YAML with a header comment
  const yaml = stringifyYaml(config);
  return `# Triggerfish Configuration\n# Generated by triggerfish dive\n\n${yaml}`;
}

// ─── Classification block helpers ────────────────────────────────────────────

/**
 * Build the `models.classification` config block from wizard answers.
 *
 * Returns undefined when no overrides are configured (omits the block entirely).
 */
export function buildClassificationBlock(
  classificationModels: Partial<Record<
    "RESTRICTED" | "CONFIDENTIAL" | "INTERNAL",
    ClassificationModelOverride
  >>,
): Record<string, { provider: string; model: string }> | undefined {
  const entries = Object.entries(classificationModels) as Array<
    ["RESTRICTED" | "CONFIDENTIAL" | "INTERNAL", ClassificationModelOverride]
  >;
  if (entries.length === 0) return undefined;

  const block: Record<string, { provider: string; model: string }> = {};
  for (const [level, override] of entries) {
    block[level] = { provider: override.provider, model: override.model };
  }
  return block;
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
export function buildToneGuidelines(tone: ToneChoice, customTone: string): string {
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
