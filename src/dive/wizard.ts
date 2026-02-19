/**
 * Interactive dive wizard for first-time Triggerfish setup.
 *
 * Walks the user through an 8-step onboarding flow:
 * 1. Choose LLM provider
 * 2. Name agent + personality → generates SPINE.md
 * 3. Connect first channel (CLI, WebChat, Telegram)
 * 4. Optional plugins (Obsidian, etc.)
 * 5. Connect Google Workspace (optional)
 * 6. Connect GitHub (optional)
 * 7. Search provider (Brave, SearXNG, skip)
 * 8. Install as daemon?
 *
 * @module
 */

import { Checkbox, Confirm, Input, Select } from "@cliffy/prompt";
import { join } from "@std/path";
import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from "@std/yaml";

import { expandTilde } from "../cli/paths.ts";
import { promptChannelConfig } from "../cli/config.ts";
import { verifyProvider } from "./verify.ts";
import { createKeychain } from "../secrets/keychain.ts";
import type { SecretStore } from "../secrets/keychain.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

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
}

// ─── Model mappings ──────────────────────────────────────────────────────────

const DEFAULT_MODELS: Readonly<Record<ProviderChoice, string>> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o",
  google: "gemini-2.0-flash",
  ollama: "llama3",
  lmstudio: "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF",
  openrouter: "anthropic/claude-sonnet-4-5",
  zenmux: "openai/gpt-5",
  zai: "glm-4.7",
};

const PROVIDER_LABELS: Readonly<Record<ProviderChoice, string>> = {
  anthropic: "Anthropic (Claude) — recommended",
  openai: "OpenAI (GPT-4o)",
  google: "Google (Gemini)",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  openrouter: "OpenRouter",
  zenmux: "ZenMux",
  zai: "Z.AI Coding Plan (GLM)",
};

// ─── Secret storage ──────────────────────────────────────────────────────────

/**
 * Store all collected API keys and tokens in the OS keychain.
 *
 * Uses the canonical key names that match the `secret:` references
 * written into triggerfish.yaml by `generateConfig()`.
 *
 * @param answers - Wizard answers containing plaintext secret values
 * @param store - Secret store to write to (defaults to OS keychain)
 * @returns Array of canonical keys that were stored
 */
export async function storeWizardSecrets(
  answers: WizardAnswers,
  store?: SecretStore,
): Promise<string[]> {
  const s = store ?? createKeychain();
  const stored: string[] = [];

  // Provider API key
  if (
    answers.apiKey.length > 0 &&
    answers.provider !== "ollama" &&
    answers.provider !== "lmstudio"
  ) {
    const key = `provider:${answers.provider}:apiKey`;
    await s.setSecret(key, answers.apiKey);
    stored.push(key);
  }

  // Telegram bot token
  if (answers.telegramBotToken.length > 0) {
    const key = "telegram:botToken";
    await s.setSecret(key, answers.telegramBotToken);
    stored.push(key);
  }

  // Discord bot token
  if (answers.discordBotToken.length > 0) {
    const key = "discord:botToken";
    await s.setSecret(key, answers.discordBotToken);
    stored.push(key);
  }

  // Brave Search API key
  if (answers.searchProvider === "brave" && answers.searchApiKey.length > 0) {
    const key = "web:search:apiKey";
    await s.setSecret(key, answers.searchApiKey);
    stored.push(key);
  }

  return stored;
}

// ─── Config generation (pure, testable) ──────────────────────────────────────

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

  // Build full config object
  const config: Record<string, unknown> = {
    models: {
      primary: {
        provider: answers.provider,
        model: answers.providerModel,
      },
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

/** Generate SPINE.md content from wizard answers. */
export function generateSpine(answers: WizardAnswers): string {
  const toneName = answers.tone === "custom"
    ? answers.customTone
    : answers.tone.charAt(0).toUpperCase() + answers.tone.slice(1);

  const toneGuidelines = getToneGuidelines(answers.tone, answers.customTone);

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

/** Get tone-specific guidelines for SPINE.md. */
function getToneGuidelines(tone: ToneChoice, customTone: string): string {
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

/** Generate a default TRIGGER.md with a minimal starting template. */
export function generateTrigger(): string {
  return `# Check on each wakeup

- Any unread messages older than 1 hour
- Calendar events in the next 4 hours
- Anything urgent in email
`;
}

// ─── Directory setup (side-effectful) ────────────────────────────────────────

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

// ─── Interactive wizard (uses cliffy prompts) ────────────────────────────────

/** Run the full 9-step interactive dive wizard. */
export async function runWizard(baseDir: string): Promise<DiveResult> {
  const configPath = join(baseDir, "triggerfish.yaml");
  const spinePath = join(baseDir, "SPINE.md");

  // Guard: interactive prompts require a TTY on stdin
  if (!Deno.stdin.isTerminal()) {
    console.error("");
    console.error("  Error: the dive wizard requires an interactive terminal.");
    console.error("");
    console.error("  If you installed via curl|bash, run the wizard manually:");
    console.error("    triggerfish dive");
    console.error("");
    Deno.exit(1);
  }

  console.log("");
  console.log("  Welcome to Triggerfish");
  console.log("  ======================");
  console.log("");
  console.log("  Let's get you set up. This takes about 2 minutes.");
  console.log("");

  // ── Step 1: LLM Provider ──────────────────────────────────────────────────

  console.log("  Step 1/8: Choose your LLM provider");
  console.log("");

  const provider = (await Select.prompt({
    message: "LLM provider",
    options: [
      { name: PROVIDER_LABELS.anthropic, value: "anthropic" },
      { name: PROVIDER_LABELS.google, value: "google" },
      { name: PROVIDER_LABELS.lmstudio, value: "lmstudio" },
      { name: PROVIDER_LABELS.ollama, value: "ollama" },
      { name: PROVIDER_LABELS.openai, value: "openai" },
      { name: PROVIDER_LABELS.openrouter, value: "openrouter" },
      { name: PROVIDER_LABELS.zai, value: "zai" },
      { name: PROVIDER_LABELS.zenmux, value: "zenmux" },
    ],
  })) as ProviderChoice;

  let providerModel = await Input.prompt({
    message: "Model name",
    default: DEFAULT_MODELS[provider],
  });

  let apiKey = "";
  let localEndpoint = "http://localhost:11434";

  if (provider === "anthropic") {
    apiKey = await Input.prompt({
      message: "Anthropic API key (or press Enter to configure later)",
    });
  } else if (provider === "ollama") {
    // No API key needed for local
    console.log("  ✓ Local provider — no API key needed");
    localEndpoint = await Input.prompt({
      message: "Ollama endpoint",
      default: "http://localhost:11434",
    });
  } else if (provider === "lmstudio") {
    // No API key needed for local
    console.log("  ✓ Local provider — no API key needed");
    localEndpoint = await Input.prompt({
      message: "LM Studio endpoint",
      default: "http://localhost:1234",
    });
  } else {
    const envVarName = provider === "openai"
      ? "OPENAI_API_KEY"
      : provider === "google"
      ? "GOOGLE_API_KEY"
      : provider === "zenmux"
      ? "ZENMUX_API_KEY"
      : provider === "zai"
      ? "ZAI_API_KEY"
      : "OPENROUTER_API_KEY";

    const existingKey = Deno.env.get(envVarName) ?? "";
    if (existingKey.length > 0) {
      console.log(`  ✓ Detected ${envVarName} in environment`);
      apiKey = existingKey;
    } else {
      apiKey = await Input.prompt({
        message: `API key (or press Enter to set ${envVarName} later)`,
      });
    }
  }

  // ── Verify provider connection ───────────────────────────────────────────
  const shouldVerify = provider === "ollama" || provider === "lmstudio" ||
    apiKey.length > 0;

  if (shouldVerify) {
    let verified = false;
    while (!verified) {
      console.log("");
      console.log("  Verifying connection...");
      const result = await verifyProvider(
        provider,
        apiKey,
        providerModel,
        provider === "ollama" || provider === "lmstudio"
          ? localEndpoint
          : undefined,
      );

      if (result.ok) {
        console.log("  ✓ Connection verified");
        verified = true;
      } else {
        console.log(`  ✗ ${result.error}`);
        console.log("");

        const retryOptions: Array<{ name: string; value: string }> = [];
        if (provider === "ollama" || provider === "lmstudio") {
          retryOptions.push({ name: "Re-enter endpoint", value: "endpoint" });
        } else {
          retryOptions.push({ name: "Re-enter API key", value: "apikey" });
        }
        retryOptions.push({ name: "Re-enter model name", value: "model" });
        retryOptions.push({ name: "Keep this setting anyway", value: "keep" });

        const action = await Select.prompt({
          message: "What would you like to do?",
          options: retryOptions,
        });

        if (action === "keep") {
          verified = true;
        } else if (action === "endpoint") {
          localEndpoint = await Input.prompt({
            message: "Endpoint URL",
            default: localEndpoint,
          });
        } else if (action === "model") {
          providerModel = await Input.prompt({
            message: "Model name",
            default: providerModel,
          });
        } else {
          apiKey = await Input.prompt({
            message: provider === "anthropic" ? "Anthropic API key" : "API key",
          });
        }
      }
    }
  }

  console.log("");

  // ── Step 2: Agent Name & Personality ───────────────────────────────────────

  console.log("  Step 2/8: Name your agent and set its personality");
  console.log("");

  const agentName = await Input.prompt({
    message: "Agent name",
    default: "Triggerfish",
  });

  const mission = await Input.prompt({
    message: "Mission (one sentence)",
    default: "A helpful AI assistant that keeps my data safe.",
  });

  const tone = (await Select.prompt({
    message: "Communication tone",
    options: [
      { name: "Professional", value: "professional" },
      { name: "Casual", value: "casual" },
      { name: "Terse", value: "terse" },
      { name: "Custom", value: "custom" },
    ],
  })) as ToneChoice;

  let customTone = "";
  if (tone === "custom") {
    customTone = await Input.prompt({
      message: "Describe the tone you want",
    });
  }

  console.log(`  → Will generate SPINE.md (edit anytime at ${spinePath})`);
  console.log("");

  // ── Step 3: Connect First Channel ──────────────────────────────────────────

  console.log("  Step 3/8: Connect your first channel");
  console.log("  (CLI is always available)");
  console.log("");

  const channelChoices = (await Checkbox.prompt({
    message: "Enable additional channels",
    options: [
      {
        name: "WebChat (browser-based, zero config)",
        value: "webchat",
        checked: true,
      },
      { name: "Telegram (requires bot token)", value: "telegram" },
      { name: "Discord (requires bot token)", value: "discord" },
      { name: "Signal (requires signal-cli)", value: "signal" },
    ],
  })) as ChannelChoice[];

  // Always include CLI
  const channels: ChannelChoice[] = ["cli", ...channelChoices];

  let telegramBotToken = "";
  let telegramOwnerId = "";
  let discordBotToken = "";
  let discordOwnerId = "";
  let webchatPort = 8765;
  let signalPhoneNumber = "";
  let signalEndpoint = "tcp://127.0.0.1:7583";

  if (channels.includes("telegram")) {
    telegramBotToken = await Input.prompt({
      message: "Telegram bot token (from @BotFather)",
    });
    telegramOwnerId = await Input.prompt({
      message:
        "Your Telegram user ID (numeric, message @getmyid_bot for your ID number)",
    });
    if (telegramBotToken.length > 0) {
      console.log("  ✓ Telegram bot token saved to config");
    }
  }

  if (channels.includes("discord")) {
    const discordConfig = await promptChannelConfig("discord");
    discordBotToken = (discordConfig.botToken as string) ?? "";
    discordOwnerId = (discordConfig.ownerId as string) ?? "";
    if (discordBotToken.length > 0) {
      console.log("  ✓ Discord bot token saved to config");
    }
  }

  if (channels.includes("webchat")) {
    const portStr = await Input.prompt({
      message: "WebChat port",
      default: "8765",
    });
    webchatPort = parseInt(portStr, 10) || 8765;
  }

  if (channels.includes("signal")) {
    console.log("");
    console.log("  Signal requires signal-cli to be installed and linked.");
    console.log("  Run: triggerfish connect signal   (after setup)");
    console.log("");
    signalPhoneNumber = await Input.prompt({
      message: "Your Signal phone number (E.164 format, e.g. +15551234567)",
    });
    signalEndpoint = await Input.prompt({
      message: "signal-cli daemon endpoint",
      default: "tcp://127.0.0.1:7583",
    });
    if (signalPhoneNumber.length > 0) {
      console.log("  ✓ Signal account saved to config");
    }
  }

  console.log("");

  // ── Step 4: Optional Plugins ──────────────────────────────────────────────

  console.log("  Step 4/8: Configure optional plugins");
  console.log("");

  const selectedPlugins = await Checkbox.prompt({
    message: "Which plugins would you like to configure?",
    options: [
      { name: "Obsidian (local vault integration)", value: "obsidian" },
    ],
  });

  let obsidianVaultPath = "";
  let obsidianClassification = "INTERNAL";

  if (selectedPlugins.includes("obsidian")) {
    // Validate vault path
    while (true) {
      obsidianVaultPath = await Input.prompt({
        message: "Path to your Obsidian vault",
      });
      if (obsidianVaultPath.length === 0) {
        console.log("  Vault path is required for Obsidian plugin.");
        continue;
      }
      // Expand ~ to home directory
      obsidianVaultPath = expandTilde(obsidianVaultPath);
      try {
        await Deno.stat(join(obsidianVaultPath, ".obsidian"));
        break;
      } catch {
        console.log(
          `  Not a valid Obsidian vault (no .obsidian/ folder found at ${obsidianVaultPath})`,
        );
        console.log("  Please enter the root folder of your Obsidian vault.");
      }
    }

    obsidianClassification = await Select.prompt({
      message: "Vault classification level",
      options: ["INTERNAL", "PUBLIC", "CONFIDENTIAL", "RESTRICTED"],
      default: "INTERNAL",
    });

    console.log("  ✓ Obsidian vault configured");
  }

  if (selectedPlugins.length === 0) {
    console.log(
      "  No plugins selected — add later with: triggerfish config add-plugin",
    );
  }

  console.log("");

  // ── Step 5: Google Workspace ─────────────────────────────────────────────

  console.log("  Step 5/8: Connect Google Workspace (optional)");
  console.log("");

  const connectGoogle = await Confirm.prompt({
    message:
      "Connect a Google account for Gmail, Calendar, Tasks, Drive, and Sheets?",
    default: false,
  });

  if (connectGoogle) {
    console.log("");
    console.log(
      "  To connect Google Workspace, you need OAuth2 credentials from Google Cloud Console.",
    );
    console.log("");
    console.log("  Quick setup:");
    console.log("    1. Go to https://console.cloud.google.com ");
    console.log("    2. Create a project (or select an existing one)");
    console.log('    3. Navigate to "APIs & Services" → "Credentials"');
    console.log(
      '    4. Click "+ CREATE CREDENTIALS" and select "OAuth client ID"',
    );
    console.log("    5. If prompted, configure the OAuth consent screen first");
    console.log(
      "       IMPORTANT: Add yourself as a test user on the consent screen,",
    );
    console.log('       or you\'ll get "Access blocked" when authorizing.');
    console.log(
      "       Full walkthrough: https://trigger.fish/integrations/google-workspace.html#google-workspace",
    );
    console.log(
      '    6. On the Create OAuth client ID screen, select "Desktop app" from',
    );
    console.log("       the Application type dropdown");
    console.log('    7. Name it "Triggerfish" (or anything you like)');
    console.log(
      "    8. Click Create, then copy the Client ID and Client Secret",
    );
    console.log("");
    console.log("  You also need to enable these APIs in your project:");
    console.log("    - Gmail API");
    console.log("    - Google Calendar API");
    console.log("    - Google Tasks API");
    console.log("    - Google Drive API");
    console.log("    - Google Sheets API");
    console.log("");
    console.log(
      "  Enable them at: https://console.cloud.google.com/apis/library",
    );
    console.log("");

    const readyNow = await Confirm.prompt({
      message: "Have your credentials ready? Connect now?",
      default: false,
    });

    if (readyNow) {
      console.log("");
      const { performGoogleOAuth } = await import("../cli/connect.ts");
      const success = await performGoogleOAuth();
      if (success) {
        console.log("");
        console.log("  → Google Workspace connected!");
      } else {
        console.log("");
        console.log(
          "  → Connection failed. Try again later with: triggerfish connect google",
        );
      }
    } else {
      console.log("  → Connect later with: triggerfish connect google");
    }
  } else {
    console.log("  → Skipped. Connect later with: triggerfish connect google");
  }

  console.log("");

  // ── Step 6: GitHub ─────────────────────────────────────────────────────

  console.log("  Step 6/8: Connect GitHub (optional)");
  console.log("");

  const connectGitHub = await Confirm.prompt({
    message: "Connect a GitHub account for repos, PRs, issues, and Actions?",
    default: false,
  });

  if (connectGitHub) {
    console.log("");
    console.log(
      "  To connect GitHub, you need a Personal Access Token (fine-grained).",
    );
    console.log("");
    console.log("  Quick setup:");
    console.log("    1. Go to https://github.com/settings/tokens?type=beta");
    console.log('    2. Click "Generate new token"');
    console.log('    3. Name it "triggerfish"');
    console.log("    4. Under Repository access, select the repos you want");
    console.log("    5. Under Permissions, grant:");
    console.log("       - Contents: Read and Write");
    console.log("       - Issues: Read and Write");
    console.log("       - Pull requests: Read and Write");
    console.log("       - Actions: Read-only");
    console.log("    6. Click Generate token and copy it");
    console.log("");

    const readyGitHub = await Confirm.prompt({
      message: "Have your token ready? Connect now?",
      default: false,
    });

    if (readyGitHub) {
      console.log("");
      const token = await Input.prompt({ message: "Paste your GitHub token" });
      const trimmed = token.trim();

      if (trimmed.length > 0) {
        // Validate against GitHub API
        console.log("  Verifying token...");
        try {
          const resp = await fetch("https://api.github.com/user", {
            headers: {
              "Authorization": `Bearer ${trimmed}`,
              "Accept": "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          });
          if (resp.ok) {
            const user = await resp.json();
            // Store in keychain
            const { createKeychain } = await import("../secrets/keychain.ts");
            const store = createKeychain();
            const storeResult = await store.setSecret("github-pat", trimmed);
            if (storeResult.ok) {
              console.log(
                `  → GitHub connected as ${
                  (user as Record<string, string>).login
                }!`,
              );
            } else {
              console.log(
                `  → Token valid but failed to store: ${storeResult.error}`,
              );
              console.log(
                "  → Try again later with: triggerfish connect github",
              );
            }
          } else {
            console.log(
              "  → Token verification failed. Check permissions and try again.",
            );
            console.log("  → Connect later with: triggerfish connect github");
          }
        } catch {
          console.log("  → Could not reach GitHub API. Check your network.");
          console.log("  → Connect later with: triggerfish connect github");
        }
      } else {
        console.log(
          "  → No token provided. Connect later with: triggerfish connect github",
        );
      }
    } else {
      console.log("  → Connect later with: triggerfish connect github");
    }
  } else {
    console.log("  → Skipped. Connect later with: triggerfish connect github");
  }

  console.log("");

  // ── Step 7: Search Provider ──────────────────────────────────────────────

  console.log("  Step 7/8: Set up web search");
  console.log("");

  const searchProvider = (await Select.prompt({
    message: "Which search engine should your agent use?",
    options: [
      {
        name: "Brave Search API (recommended, free tier available)",
        value: "brave",
      },
      { name: "SearXNG (self-hosted)", value: "searxng" },
      { name: "Skip for now", value: "skip" },
    ],
  })) as SearchProviderChoice;

  let searchApiKey = "";
  let searxngUrl = "";

  if (searchProvider === "brave") {
    searchApiKey = await Input.prompt({
      message: "Brave Search API key (or press Enter to configure later)",
    });
    if (searchApiKey.length > 0) {
      console.log("  ✓ API key saved to config");
    } else {
      console.log(
        "  → Skipped. Set later with: triggerfish config set web.search.api_key <key>",
      );
    }
  } else if (searchProvider === "searxng") {
    searxngUrl = await Input.prompt({
      message: "SearXNG instance URL",
      default: "http://localhost:8888",
    });
  }

  console.log("");

  // ── Step 8: Daemon Installation ──────────────────────────────────────────

  console.log("  Step 8/8: Install as daemon?");
  console.log("");

  const installDaemon = await Confirm.prompt({
    message: "Start on login and run in background?",
    default: true,
  });

  console.log("");

  // ── Generate and write files ───────────────────────────────────────────────

  const answers: WizardAnswers = {
    provider,
    providerModel,
    apiKey,
    agentName,
    mission,
    tone,
    customTone,
    channels,
    telegramBotToken,
    telegramOwnerId,
    discordBotToken,
    discordOwnerId,
    webchatPort,
    signalPhoneNumber,
    signalEndpoint,
    selectedPlugins,
    obsidianVaultPath,
    obsidianClassification,
    searchProvider,
    searchApiKey,
    searxngUrl,
    localEndpoint,
    installDaemon,
  };

  // Create directory tree
  await createDirectoryTree(baseDir);

  // Store secrets in OS keychain before writing config (so config only has refs)
  const storedKeys = await storeWizardSecrets(answers);
  if (storedKeys.length > 0) {
    console.log(`  ✓ Secrets stored in OS keychain (${storedKeys.length} key(s))`);
  }

  // Write config (uses secret: references, not plaintext values)
  const configContent = generateConfig(answers);
  await Deno.writeTextFile(configPath, configContent);
  console.log(`  ✓ Created: ${configPath}`);

  // Write SPINE.md
  const spineContent = generateSpine(answers);
  await Deno.writeTextFile(spinePath, spineContent);
  console.log(`  ✓ Created: ${spinePath}`);

  // Write TRIGGER.md (only if it doesn't already exist)
  const triggerPath = join(baseDir, "TRIGGER.md");
  try {
    await Deno.stat(triggerPath);
    // Already exists — don't overwrite
  } catch {
    const triggerContent = generateTrigger();
    await Deno.writeTextFile(triggerPath, triggerContent);
    console.log(`  ✓ Created: ${triggerPath}`);
  }

  if (apiKey.length > 0) {
    console.log(`  ✓ API key stored in OS keychain. triggerfish.yaml references it by name.`);
  }

  console.log("");
  console.log("  ✓ Setup complete!");
  console.log("");

  if (installDaemon) {
    console.log("  Starting Triggerfish daemon...");
  } else {
    console.log("  To start Triggerfish later:");
    console.log("    triggerfish start    # Background daemon");
    console.log("    triggerfish run      # Foreground (debug)");
  }

  console.log("");
  console.log(`  Edit your agent's identity: ${spinePath}`);
  console.log(`  Edit configuration:         ${configPath}`);
  console.log("  Run health check:           triggerfish patrol");
  console.log("  Connect integrations:       triggerfish connect google");
  console.log("                              triggerfish connect github");
  console.log("");

  return {
    configPath,
    spinePath,
    installDaemon,
    channels: channels.filter((c) => c !== "skip"),
  };
}

/** Section identifiers for selective reconfiguration. */
type WizardSection =
  | "llm"
  | "agent"
  | "channels"
  | "plugins"
  | "google"
  | "github"
  | "search"
  | "daemon";

/** Safely read a nested value from a config object by dot path. */
function getConfigValue(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Run a selective dive wizard that lets the user choose which sections to
 * reconfigure while preserving the rest of their existing config.
 * Defaults are pre-populated from the existing configuration.
 */
export async function runWizardSelective(
  baseDir: string,
): Promise<DiveResult> {
  const configPath = join(baseDir, "triggerfish.yaml");
  const spinePath = join(baseDir, "SPINE.md");

  if (!Deno.stdin.isTerminal()) {
    console.error("");
    console.error(
      "  Error: the dive wizard requires an interactive terminal.",
    );
    console.error("");
    Deno.exit(1);
  }

  // Load existing config
  let existingConfig: Record<string, unknown> = {};
  try {
    const raw = await Deno.readTextFile(configPath);
    existingConfig =
      (parseYaml(raw) as Record<string, unknown> | null) ?? {};
  } catch {
    // No existing config — fall through to full wizard
    return runWizard(baseDir);
  }

  // Load existing SPINE.md for agent defaults
  let existingSpine = "";
  try {
    existingSpine = await Deno.readTextFile(spinePath);
  } catch {
    // No existing SPINE.md
  }

  console.log("");
  console.log("  Reconfigure Triggerfish");
  console.log("  ======================");
  console.log("");
  console.log("  Select which sections you want to change.");
  console.log("  Unselected sections will keep their current settings.");
  console.log("");

  const sections = (await Checkbox.prompt({
    message: "Which sections do you want to update?",
    options: [
      { name: "LLM Provider (model, API key)", value: "llm" },
      { name: "Agent Name & Personality (SPINE.md)", value: "agent" },
      { name: "Channels (Telegram, Discord, Signal, WebChat)", value: "channels" },
      { name: "Plugins (Obsidian)", value: "plugins" },
      { name: "Google Workspace", value: "google" },
      { name: "GitHub", value: "github" },
      { name: "Search Provider", value: "search" },
      { name: "Daemon Settings", value: "daemon" },
    ],
  })) as WizardSection[];

  if (sections.length === 0) {
    console.log("");
    console.log("  No sections selected — config unchanged.");
    console.log("");
    return {
      configPath,
      spinePath,
      installDaemon: false,
      channels: [],
    };
  }

  // We'll merge changes into the existing config object
  const config = { ...existingConfig };

  // Track values needed for DiveResult
  let installDaemon = false;
  const activeChannels: string[] = [];

  // ── LLM Provider ──────────────────────────────────────────────────────────
  if (sections.includes("llm")) {
    console.log("");
    console.log("  LLM Provider");
    console.log("");

    const currentProvider = (getConfigValue(existingConfig, "models.primary.provider") as string | undefined) ?? "";
    const currentModel = (getConfigValue(existingConfig, "models.primary.model") as string | undefined) ?? "";

    const provider = (await Select.prompt({
      message: "LLM provider",
      default: currentProvider || undefined,
      options: [
        { name: PROVIDER_LABELS.anthropic, value: "anthropic" },
        { name: PROVIDER_LABELS.google, value: "google" },
        { name: PROVIDER_LABELS.lmstudio, value: "lmstudio" },
        { name: PROVIDER_LABELS.ollama, value: "ollama" },
        { name: PROVIDER_LABELS.openai, value: "openai" },
        { name: PROVIDER_LABELS.openrouter, value: "openrouter" },
        { name: PROVIDER_LABELS.zai, value: "zai" },
        { name: PROVIDER_LABELS.zenmux, value: "zenmux" },
      ],
    })) as ProviderChoice;

    let providerModel = await Input.prompt({
      message: "Model name",
      default: currentModel || DEFAULT_MODELS[provider],
    });

    let apiKey = "";
    const currentEndpoint = (getConfigValue(existingConfig, `models.providers.${provider}.endpoint`) as string | undefined) ?? "";
    let localEndpoint = currentEndpoint || "http://localhost:11434";

    if (provider === "anthropic") {
      apiKey = await Input.prompt({
        message: "Anthropic API key (or press Enter to keep existing)",
      });
    } else if (provider === "ollama" || provider === "lmstudio") {
      console.log("  ✓ Local provider — no API key needed");
      localEndpoint = await Input.prompt({
        message: `${provider === "ollama" ? "Ollama" : "LM Studio"} endpoint`,
        default: localEndpoint || (provider === "lmstudio"
          ? "http://localhost:1234"
          : "http://localhost:11434"),
      });
    } else {
      const envVarName = provider === "openai"
        ? "OPENAI_API_KEY"
        : provider === "google"
        ? "GOOGLE_API_KEY"
        : provider === "zenmux"
        ? "ZENMUX_API_KEY"
        : provider === "zai"
        ? "ZAI_API_KEY"
        : "OPENROUTER_API_KEY";
      const existingKey = Deno.env.get(envVarName) ?? "";
      if (existingKey.length > 0) {
        console.log(`  ✓ Detected ${envVarName} in environment`);
        apiKey = existingKey;
      } else {
        apiKey = await Input.prompt({
          message: `API key (or press Enter to set ${envVarName} later)`,
        });
      }
    }

    // Verify connection
    const shouldVerify = provider === "ollama" || provider === "lmstudio" ||
      apiKey.length > 0;
    if (shouldVerify) {
      let verified = false;
      while (!verified) {
        console.log("");
        console.log("  Verifying connection...");
        const result = await verifyProvider(
          provider,
          apiKey,
          providerModel,
          provider === "ollama" || provider === "lmstudio"
            ? localEndpoint
            : undefined,
        );
        if (result.ok) {
          console.log("  ✓ Connection verified");
          verified = true;
        } else {
          console.log(`  ✗ ${result.error}`);
          console.log("");
          const retryOptions: Array<{ name: string; value: string }> = [];
          if (provider === "ollama" || provider === "lmstudio") {
            retryOptions.push({
              name: "Re-enter endpoint",
              value: "endpoint",
            });
          } else {
            retryOptions.push({ name: "Re-enter API key", value: "apikey" });
          }
          retryOptions.push({ name: "Re-enter model name", value: "model" });
          retryOptions.push({
            name: "Keep this setting anyway",
            value: "keep",
          });
          const action = await Select.prompt({
            message: "What would you like to do?",
            options: retryOptions,
          });
          if (action === "keep") {
            verified = true;
          } else if (action === "endpoint") {
            localEndpoint = await Input.prompt({
              message: "Endpoint URL",
              default: localEndpoint,
            });
          } else if (action === "model") {
            providerModel = await Input.prompt({
              message: "Model name",
              default: providerModel,
            });
          } else {
            apiKey = await Input.prompt({
              message: provider === "anthropic"
                ? "Anthropic API key"
                : "API key",
            });
          }
        }
      }
    }

    // Build providers section
    const providers: Record<string, Record<string, string>> = {};
    if (provider === "ollama" || provider === "lmstudio") {
      providers[provider] = { model: providerModel, endpoint: localEndpoint };
    } else {
      const pc: Record<string, string> = { model: providerModel };
      if (apiKey.length > 0) pc["apiKey"] = apiKey;
      providers[provider] = pc;
    }

    config["models"] = {
      primary: { provider, model: providerModel },
      providers,
    };
  }

  // ── Agent Name & Personality ──────────────────────────────────────────────
  if (sections.includes("agent")) {
    console.log("");
    console.log("  Agent Name & Personality");
    console.log("");

    // Parse existing SPINE.md for defaults
    const spineNameMatch = existingSpine.match(/^# (.+)$/m);
    const currentAgentName = spineNameMatch?.[1] ?? "Triggerfish";
    // Mission is the first non-empty line after the heading
    const spineLines = existingSpine.split("\n");
    const headingIdx = spineLines.findIndex((l) => l.startsWith("# "));
    let currentMission = "A helpful AI assistant that keeps my data safe.";
    if (headingIdx >= 0) {
      for (let i = headingIdx + 1; i < spineLines.length; i++) {
        const line = spineLines[i].trim();
        if (line.length > 0 && !line.startsWith("#")) {
          currentMission = line;
          break;
        }
      }
    }

    const agentName = await Input.prompt({
      message: "Agent name",
      default: currentAgentName,
    });
    const mission = await Input.prompt({
      message: "Mission (one sentence)",
      default: currentMission,
    });
    const tone = (await Select.prompt({
      message: "Communication tone",
      options: [
        { name: "Professional", value: "professional" },
        { name: "Casual", value: "casual" },
        { name: "Terse", value: "terse" },
        { name: "Custom", value: "custom" },
      ],
    })) as ToneChoice;

    let customTone = "";
    if (tone === "custom") {
      customTone = await Input.prompt({
        message: "Describe the tone you want",
      });
    }

    const spineContent = generateSpine({
      agentName,
      mission,
      tone,
      customTone,
    } as WizardAnswers);
    await Deno.writeTextFile(spinePath, spineContent);
    console.log(`  ✓ Updated: ${spinePath}`);
  }

  // ── Channels ──────────────────────────────────────────────────────────────
  if (sections.includes("channels")) {
    console.log("");
    console.log("  Channels");
    console.log("");

    const existingChannels = (getConfigValue(existingConfig, "channels") ?? {}) as Record<string, unknown>;
    const hasWebchat = "webchat" in existingChannels;
    const hasTelegram = "telegram" in existingChannels;
    const hasDiscord = "discord" in existingChannels;
    const hasSignal = "signal" in existingChannels;

    const channelChoices = (await Checkbox.prompt({
      message: "Enable additional channels",
      options: [
        {
          name: "WebChat (browser-based, zero config)",
          value: "webchat",
          checked: hasWebchat,
        },
        {
          name: "Telegram (requires bot token)",
          value: "telegram",
          checked: hasTelegram,
        },
        {
          name: "Discord (requires bot token)",
          value: "discord",
          checked: hasDiscord,
        },
        {
          name: "Signal (requires signal-cli)",
          value: "signal",
          checked: hasSignal,
        },
      ],
    })) as ChannelChoice[];

    // Preserve channels that the wizard doesn't manage (Slack,
    // WhatsApp, Email, iMessage). Only webchat, telegram, discord, and signal
    // are editable here — everything else carries forward unchanged.
    const channels: Record<string, unknown> = { ...existingChannels };

    // Remove managed channels if user deselected them
    if (!channelChoices.includes("webchat")) {
      delete channels["webchat"];
    }
    if (!channelChoices.includes("telegram")) {
      delete channels["telegram"];
    }
    if (!channelChoices.includes("discord")) {
      delete channels["discord"];
    }
    if (!channelChoices.includes("signal")) {
      delete channels["signal"];
    }

    if (channelChoices.includes("webchat")) {
      activeChannels.push("webchat");
      const currentPort = String(
        (getConfigValue(existingConfig, "channels.webchat.port") as number | undefined) ?? 8765,
      );
      const portStr = await Input.prompt({
        message: "WebChat port",
        default: currentPort,
      });
      channels["webchat"] = {
        port: parseInt(portStr, 10) || 8765,
        classification: "PUBLIC",
      };
    }

    if (channelChoices.includes("telegram")) {
      activeChannels.push("telegram");
      const currentOwnerId = String(
        (getConfigValue(existingConfig, "channels.telegram.ownerId") as number | undefined) ?? "",
      );
      const telegramBotToken = await Input.prompt({
        message: "Telegram bot token (from @BotFather)",
      });
      const telegramOwnerId = await Input.prompt({
        message: "Your Telegram user ID (numeric)",
        default: currentOwnerId || undefined,
      });
      if (telegramBotToken.length > 0) {
        const tc: Record<string, unknown> = {
          botToken: telegramBotToken,
          classification: "INTERNAL",
        };
        if (telegramOwnerId.length > 0) {
          tc["ownerId"] = parseInt(telegramOwnerId, 10) || 0;
        }
        channels["telegram"] = tc;
        console.log("  ✓ Telegram bot token saved to config");
      }
    }

    if (channelChoices.includes("discord")) {
      activeChannels.push("discord");
      const discordConfig = await promptChannelConfig("discord");
      if ((discordConfig.botToken as string)?.length > 0) {
        channels["discord"] = discordConfig;
        console.log("  ✓ Discord bot token saved to config");
      }
    }

    if (channelChoices.includes("signal")) {
      activeChannels.push("signal");
      const currentPhone = (getConfigValue(existingConfig, "channels.signal.account") as string | undefined) ?? "";
      const currentEndpoint = (getConfigValue(existingConfig, "channels.signal.endpoint") as string | undefined) ?? "tcp://127.0.0.1:7583";
      const signalPhoneNumber = await Input.prompt({
        message: "Your Signal phone number (E.164 format, e.g. +15551234567)",
        default: currentPhone || undefined,
      });
      const signalEndpoint = await Input.prompt({
        message: "signal-cli daemon endpoint",
        default: currentEndpoint,
      });
      if (signalPhoneNumber.length > 0) {
        channels["signal"] = {
          endpoint: signalEndpoint,
          account: signalPhoneNumber,
          classification: "INTERNAL",
          ownerPhone: signalPhoneNumber,
        };
        console.log("  ✓ Signal account saved to config");
      }
    }

    config["channels"] = channels;
  }

  // ── Plugins ───────────────────────────────────────────────────────────────
  if (sections.includes("plugins")) {
    console.log("");
    console.log("  Plugins");
    console.log("");

    const hasObsidian = getConfigValue(existingConfig, "plugins.obsidian.enabled") === true;

    const selectedPlugins = await Checkbox.prompt({
      message: "Which plugins would you like to configure?",
      options: [
        {
          name: "Obsidian (local vault integration)",
          value: "obsidian",
          checked: hasObsidian,
        },
      ],
    });

    if (selectedPlugins.includes("obsidian")) {
      const currentVaultPath = (getConfigValue(existingConfig, "plugins.obsidian.vault_path") as string | undefined) ?? "";
      let obsidianVaultPath = "";
      while (true) {
        obsidianVaultPath = await Input.prompt({
          message: "Path to your Obsidian vault",
          default: currentVaultPath || undefined,
        });
        if (obsidianVaultPath.length === 0) {
          console.log("  Vault path is required for Obsidian plugin.");
          continue;
        }
        obsidianVaultPath = expandTilde(obsidianVaultPath);
        try {
          await Deno.stat(join(obsidianVaultPath, ".obsidian"));
          break;
        } catch {
          console.log(
            `  Not a valid Obsidian vault (no .obsidian/ folder at ${obsidianVaultPath})`,
          );
        }
      }
      const currentClassification = (getConfigValue(existingConfig, "plugins.obsidian.classification") as string | undefined) ?? "INTERNAL";
      const obsidianClassification = await Select.prompt({
        message: "Vault classification level",
        options: ["INTERNAL", "PUBLIC", "CONFIDENTIAL", "RESTRICTED"],
        default: currentClassification,
      });
      config["plugins"] = {
        obsidian: {
          enabled: true,
          vault_path: obsidianVaultPath,
          classification: obsidianClassification,
          daily_notes: { folder: "daily", date_format: "YYYY-MM-DD" },
        },
      };
      console.log("  ✓ Obsidian vault configured");
    } else {
      delete config["plugins"];
      console.log("  No plugins selected.");
    }
  }

  // ── Google Workspace ──────────────────────────────────────────────────────
  if (sections.includes("google")) {
    console.log("");
    console.log("  Google Workspace");
    console.log("");
    const connectGoogle = await Confirm.prompt({
      message: "Connect a Google account?",
      default: false,
    });
    if (connectGoogle) {
      console.log("");
      console.log("  Run: triggerfish connect google");
    } else {
      console.log("  → Skipped.");
    }
  }

  // ── GitHub ────────────────────────────────────────────────────────────────
  if (sections.includes("github")) {
    console.log("");
    console.log("  GitHub");
    console.log("");
    const connectGitHub = await Confirm.prompt({
      message: "Connect a GitHub account?",
      default: false,
    });
    if (connectGitHub) {
      console.log("");
      console.log("  Run: triggerfish connect github");
    } else {
      console.log("  → Skipped.");
    }
  }

  // ── Search Provider ───────────────────────────────────────────────────────
  if (sections.includes("search")) {
    console.log("");
    console.log("  Search Provider");
    console.log("");

    const currentSearchProvider = (getConfigValue(existingConfig, "web.search.provider") as string | undefined) ?? "";

    const searchProvider = (await Select.prompt({
      message: "Which search engine should your agent use?",
      default: currentSearchProvider || undefined,
      options: [
        {
          name: "Brave Search API (recommended, free tier available)",
          value: "brave",
        },
        { name: "SearXNG (self-hosted)", value: "searxng" },
        { name: "Skip for now", value: "skip" },
      ],
    })) as SearchProviderChoice;

    if (searchProvider === "brave") {
      const searchApiKey = await Input.prompt({
        message: "Brave Search API key (or press Enter to keep existing)",
      });
      if (searchApiKey.length > 0) {
        config["web"] = { search: { provider: "brave", api_key: searchApiKey } };
      }
    } else if (searchProvider === "searxng") {
      const currentSearxngUrl = (getConfigValue(existingConfig, "web.search.endpoint") as string | undefined) ?? "http://localhost:8888";
      const searxngUrl = await Input.prompt({
        message: "SearXNG instance URL",
        default: currentSearxngUrl,
      });
      config["web"] = { search: { provider: "searxng", endpoint: searxngUrl } };
    } else {
      delete config["web"];
    }
  }

  // ── Daemon ────────────────────────────────────────────────────────────────
  if (sections.includes("daemon")) {
    console.log("");
    console.log("  Daemon Settings");
    console.log("");
    installDaemon = await Confirm.prompt({
      message: "Start on login and run in background?",
      default: true,
    });
  }

  // ── Write updated config ──────────────────────────────────────────────────

  // Ensure classification defaults
  if (!config["classification"]) {
    config["classification"] = { mode: "personal", levels: "standard" };
  }

  const yaml = stringifyYaml(config as Record<string, unknown>);
  const content =
    `# Triggerfish Configuration\n# Generated by triggerfish dive\n\n${yaml}`;
  await Deno.writeTextFile(configPath, content);
  console.log("");
  console.log(`  ✓ Updated: ${configPath}`);
  console.log("");

  return {
    configPath,
    spinePath,
    installDaemon,
    channels: activeChannels,
  };
}
