/**
 * Dive module — onboarding and diagnostics.
 *
 * Patrol health checks and setup wizard.
 *
 * @module
 */

export {
  createPatrolCheck,
  type HealthStatus,
  type PatrolChecker,
  type PatrolCheckResult,
  type PatrolInput,
  type PatrolReport,
} from "./patrol.ts";

export { verifyProvider, type VerifyResult } from "./verify.ts";

export {
  buildToneGuidelines,
  type ChannelChoice,
  createDirectoryTree,
  DEFAULT_MODELS,
  type DiveResult,
  generateConfig,
  generateSpine,
  generateTrigger,
  PROVIDER_LABELS,
  type ProviderChoice,
  type SearchProviderChoice,
  storeWizardSecrets,
  type ToneChoice,
  type WizardAnswers,
  type WizardSection,
} from "./wizard/mod.ts";

export { launchInteractiveWizard, runWizard } from "./wizard/mod.ts";
export { launchSelectiveWizard, runWizardSelective } from "./selective/mod.ts";

export type { VaultPatrolOptions } from "./patrol_vault.ts";
export { conductVaultPatrol } from "./patrol_vault.ts";

export {
  type CallbackServer,
  type CheckoutSessionResponse,
  createCheckoutSession,
  type DeviceCodeResponse,
  type DevicePollResponse,
  type LicenseValidation,
  openInBrowser,
  pollDeviceCode,
  pollDeviceCodeLoop,
  PRODUCTION_GATEWAY_URL,
  requestDeviceCode,
  resolveGatewayUrl,
  SANDBOX_GATEWAY_URL,
  sendMagicLink,
  startCallbackServer,
  validateLicenseKey,
  verifyLicenseKey,
} from "./cloud.ts";
