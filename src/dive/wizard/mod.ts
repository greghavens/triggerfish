/**
 * Wizard submodule — interactive 8-step onboarding flow.
 *
 * @module
 */

export {
  type ChannelChoice,
  DEFAULT_MODELS,
  type DiveResult,
  PROVIDER_LABELS,
  type ProviderChoice,
  type SearchProviderChoice,
  type ToneChoice,
  type WizardAnswers,
  type WizardSection,
} from "./wizard_types.ts";

export {
  buildToneGuidelines,
  createDirectoryTree,
  generateConfig,
  generateSpine,
  generateTrigger,
} from "./wizard_generators.ts";

export { storeWizardSecrets } from "./wizard_secrets.ts";

export { type LlmProviderResult, promptLlmProviderStep } from "./wizard_llm.ts";

export {
  type ChannelSelectionResult,
  promptChannelSelectionStep,
} from "./wizard_channels.ts";

export { type PluginResult, promptPluginStep } from "./wizard_plugins.ts";

export {
  promptGitHubConnectionStep,
  promptGoogleWorkspaceStep,
  promptSearchProviderStep,
  type SearchProviderResult,
} from "./wizard_integrations.ts";

export {
  type ClassificationModelsResult,
  promptClassificationModelsStep,
} from "./wizard_classification_models.ts";

export { writeWizardOutputFiles } from "./wizard_output.ts";

export { launchInteractiveWizard, runWizard } from "./wizard.ts";
