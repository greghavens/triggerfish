/**
 * Interactive dive wizard for first-time Triggerfish setup.
 *
 * Walks the user through an 8-step onboarding flow:
 * 1. Choose LLM provider
 * 2. Name agent + personality -> generates SPINE.md
 * 3. Connect first channel (CLI, WebChat, Telegram)
 * 4. Optional plugins (Obsidian, etc.)
 * 5. Connect Google Workspace (optional)
 * 6. Connect GitHub (optional)
 * 7. Search provider (Brave, SearXNG, skip)
 * 8. Install as daemon?
 *
 * @module
 */

import { Confirm, Input, Select } from "@cliffy/prompt";
import { join } from "@std/path";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("dive");

import type { DiveResult, ToneChoice, WizardAnswers } from "./wizard_types.ts";

import type { LlmProviderResult } from "./wizard_llm.ts";
import { promptLlmProviderStep } from "./wizard_llm.ts";

import type { ClassificationModelsResult } from "./wizard_classification_models.ts";
import { promptClassificationModelsStep } from "./wizard_classification_models.ts";

import type { ChannelSelectionResult } from "./wizard_channels.ts";
import { promptChannelSelectionStep } from "./wizard_channels.ts";

import type { PluginResult } from "./wizard_plugins.ts";
import { promptPluginStep } from "./wizard_plugins.ts";

import type { SearchProviderResult } from "./wizard_integrations.ts";
import {
  promptGitHubConnectionStep,
  promptGoogleWorkspaceStep,
  promptSearchProviderStep,
} from "./wizard_integrations.ts";

import { writeWizardOutputFiles } from "./wizard_output.ts";

// Re-export all public API from sub-modules for backward compatibility
export type {
  ChannelChoice,
  DiveResult,
  ProviderChoice,
  SearchProviderChoice,
  ToneChoice,
  WizardAnswers,
  WizardSection,
} from "./wizard_types.ts";

export { DEFAULT_MODELS, PROVIDER_LABELS } from "./wizard_types.ts";

export {
  buildToneGuidelines,
  createDirectoryTree,
  generateConfig,
  generateSpine,
  generateTrigger,
} from "./wizard_generators.ts";

export { storeWizardSecrets } from "./wizard_secrets.ts";
export {
  launchSelectiveWizard,
  runWizardSelective,
} from "../selective/wizard_selective.ts";

// ── Step result interfaces ────────────────────────────────────────────────────

interface AgentIdentityResult {
  readonly agentName: string;
  readonly mission: string;
  readonly tone: ToneChoice;
  readonly customTone: string;
}

// ── Step 2: Agent Identity ────────────────────────────────────────────────────

/** Prompt for communication tone choice. */
async function selectAgentTone(): Promise<{
  tone: ToneChoice;
  customTone: string;
}> {
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
  return { tone, customTone };
}

/** Run the agent identity wizard step (Step 2/8). */
async function promptAgentIdentityStep(
  spinePath: string,
): Promise<AgentIdentityResult> {
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
  const { tone, customTone } = await selectAgentTone();

  console.log(`  \u2192 Will generate SPINE.md (edit anytime at ${spinePath})`);
  console.log("");
  return { agentName, mission, tone, customTone };
}

// ── Guard ─────────────────────────────────────────────────────────────────────

/** Abort if stdin is not an interactive terminal. */
function enforceTerminalRequirement(): void {
  if (!Deno.stdin.isTerminal()) {
    log.error("Terminal requirement not met", {
      operation: "enforceTerminalRequirement",
      reason: "stdin is not a TTY",
    });
    console.error("");
    console.error(
      "  Error: the dive wizard requires an interactive terminal.",
    );
    console.error("");
    console.error(
      "  If you installed via curl|bash, run the wizard manually:",
    );
    console.error("    triggerfish dive");
    console.error("");
    Deno.exit(1);
  }
}

/** Print the welcome banner at wizard start. */
function printWelcomeBanner(): void {
  console.log("");
  console.log("  Welcome to Triggerfish");
  console.log("  ======================");
  console.log("");
  console.log("  Let's get you set up. This takes about 2 minutes.");
  console.log("");
}

// ── Assemble WizardAnswers ────────────────────────────────────────────────────

/** Map LLM step result to WizardAnswers fields. */
function mapLlmToAnswerFields(llm: LlmProviderResult): Partial<WizardAnswers> {
  return {
    provider: llm.provider,
    providerModel: llm.providerModel,
    apiKey: llm.apiKey,
    localEndpoint: llm.localEndpoint,
    licenseKey: llm.licenseKey,
    gatewayUrl: llm.gatewayUrl,
  };
}

/** Map agent identity step result to WizardAnswers fields. */
function mapIdentityToAnswerFields(
  identity: AgentIdentityResult,
): Partial<WizardAnswers> {
  return {
    agentName: identity.agentName,
    mission: identity.mission,
    tone: identity.tone,
    customTone: identity.customTone,
  };
}

/** Map plugins step result to WizardAnswers fields. */
function mapPluginsToAnswerFields(
  plugins: PluginResult,
): Partial<WizardAnswers> {
  return {
    selectedPlugins: plugins.selectedPlugins,
    obsidianVaultPath: plugins.obsidianVaultPath,
    obsidianClassification: plugins.obsidianClassification,
  };
}

/** Assemble all step results into a single WizardAnswers object. */
function assembleWizardAnswers(options: {
  llm: LlmProviderResult;
  classificationModels: ClassificationModelsResult;
  identity: AgentIdentityResult;
  channelSelection: ChannelSelectionResult;
  plugins: PluginResult;
  search: SearchProviderResult;
  installDaemon: boolean;
}): WizardAnswers {
  return {
    ...mapLlmToAnswerFields(options.llm),
    ...options.classificationModels,
    ...mapIdentityToAnswerFields(options.identity),
    ...options.channelSelection,
    ...mapPluginsToAnswerFields(options.plugins),
    ...options.search,
    installDaemon: options.installDaemon,
  } as WizardAnswers;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Prompt whether to install as a background daemon (Step 8/8). */
async function promptDaemonInstallStep(): Promise<boolean> {
  console.log("  Step 8/8: Install as daemon?");
  console.log("");
  const installDaemon = await Confirm.prompt({
    message: "Start on login and run in background?",
    default: true,
  });
  console.log("");
  return installDaemon;
}

/** Collect all 8 wizard steps sequentially. */
async function collectAllWizardSteps(
  baseDir: string,
): Promise<WizardAnswers> {
  const llm = await promptLlmProviderStep();
  console.log("");

  const classificationModels = await promptClassificationModelsStep();

  const spinePath = join(baseDir, "SPINE.md");
  const identity = await promptAgentIdentityStep(spinePath);
  const channelSelection = await promptChannelSelectionStep();
  const plugins = await promptPluginStep();

  await promptGoogleWorkspaceStep();
  await promptGitHubConnectionStep();

  // Triggerfish Gateway includes search — skip the search provider step
  let search: SearchProviderResult;
  if (llm.provider === "triggerfish") {
    console.log("  Step 7/8: Web search");
    console.log("");
    console.log("  \u2713 Web search included with Triggerfish Gateway");
    console.log("");
    search = { searchProvider: "skip", searchApiKey: "", searxngUrl: "" };
  } else {
    search = await promptSearchProviderStep();
  }
  const installDaemon = await promptDaemonInstallStep();

  return assembleWizardAnswers({
    llm,
    classificationModels,
    identity,
    channelSelection,
    plugins,
    search,
    installDaemon,
  });
}

/** Build the final DiveResult from answers and generated file paths. */
function buildDiveResult(
  answers: WizardAnswers,
  configPath: string,
  spinePath: string,
): DiveResult {
  return {
    configPath,
    spinePath,
    installDaemon: answers.installDaemon,
    channels: answers.channels.filter((c) => c !== "skip"),
  };
}

/** Run the full 8-step interactive dive wizard. */
export async function launchInteractiveWizard(
  baseDir: string,
): Promise<DiveResult> {
  enforceTerminalRequirement();
  printWelcomeBanner();

  const answers = await collectAllWizardSteps(baseDir);
  const { configPath, spinePath } = await writeWizardOutputFiles(
    baseDir,
    answers,
  );
  return buildDiveResult(answers, configPath, spinePath);
}

/** @deprecated Use launchInteractiveWizard instead */
export const runWizard = launchInteractiveWizard;
