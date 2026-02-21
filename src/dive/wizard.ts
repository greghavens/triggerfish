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

import { expandTilde } from "../cli/config/paths.ts";
import { promptChannelConfig } from "../cli/config/config.ts";
import { verifyProvider } from "./verify.ts";
import { createKeychain } from "../core/secrets/keychain.ts";

import type {
  ChannelChoice,
  DiveResult,
  ProviderChoice,
  SearchProviderChoice,
  ToneChoice,
  WizardAnswers,
} from "./wizard_types.ts";

import {
  DEFAULT_MODELS,
  PROVIDER_LABELS,
} from "./wizard_types.ts";

import {
  createDirectoryTree,
  generateConfig,
  generateSpine,
  generateTrigger,
} from "./wizard_generators.ts";

import { storeWizardSecrets } from "./wizard_secrets.ts";

// Re-export all public API from sub-modules for backward compatibility
export type {
  ChannelChoice,
  ClassificationModelOverride,
  DiveResult,
  ProviderChoice,
  SearchProviderChoice,
  ToneChoice,
  WizardAnswers,
  WizardSection,
} from "./wizard_types.ts";

export {
  DEFAULT_MODELS,
  PROVIDER_LABELS,
} from "./wizard_types.ts";

export {
  buildClassificationBlock,
  buildToneGuidelines,
  createDirectoryTree,
  generateConfig,
  generateSpine,
  generateTrigger,
} from "./wizard_generators.ts";

export { storeWizardSecrets } from "./wizard_secrets.ts";
export { runWizardSelective } from "./wizard_selective.ts";

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

  // ── Optional: Per-classification model overrides ──────────────────────────

  const wantClassificationModels = await Confirm.prompt({
    message: "Configure different models per classification level? (optional)",
    default: false,
  });

  const classificationModels: Partial<Record<
    "RESTRICTED" | "CONFIDENTIAL" | "INTERNAL",
    { provider: ProviderChoice; model: string }
  >> = {};

  if (wantClassificationModels) {
    console.log("");
    console.log("  Set a model for each sensitivity level.");
    console.log("  Levels without an override inherit from the closest higher-configured level,");
    console.log("  then fall back to the primary model.");
    console.log("");

    const levels = ["RESTRICTED", "CONFIDENTIAL", "INTERNAL"] as const;
    for (const level of levels) {
      const wantOverride = await Confirm.prompt({
        message: `  ${level}: configure a specific model?`,
        default: false,
      });
      if (!wantOverride) continue;

      const overrideProvider = (await Select.prompt({
        message: `  ${level}: provider`,
        options: [
          { name: `Same as primary (${provider})`, value: provider },
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

      const overrideModel = await Input.prompt({
        message: `  ${level}: model name`,
        default: DEFAULT_MODELS[overrideProvider],
      });

      classificationModels[level] = { provider: overrideProvider, model: overrideModel };
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
      const { performGoogleOAuth } = await import("../cli/commands/connect.ts");
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
    classificationModels,
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
