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

export { type VerifyResult, verifyProvider } from "./verify.ts";

export {
  type CallbackServer,
  type CheckoutSessionResponse,
  type CloudSetupOptions,
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
} from "./cloud.ts";

export {
  type ChannelChoice,
  createDirectoryTree,
  type DiveResult,
  generateConfig,
  generateSpine,
  generateTrigger,
  type ProviderChoice,
  runWizard,
  runWizardSelective,
  type ToneChoice,
  type WizardAnswers,
} from "./wizard.ts";
