/**
 * Triggerfish Gateway setup — barrel re-export.
 *
 * Re-exports API client functions from cloud_api.ts and
 * callback server from cloud_server.ts.
 *
 * @module
 */

export {
  type CheckoutSessionResponse,
  createCheckoutSession,
  type DeviceCodeResponse,
  type DevicePollResponse,
  type LicenseValidation,
  pollDeviceCode,
  pollDeviceCodeLoop,
  requestDeviceCode,
  sendMagicLink,
  validateLicenseKey,
  verifyLicenseKey,
} from "./cloud_api.ts";

export {
  type CallbackServer,
  openInBrowser,
  PRODUCTION_GATEWAY_URL,
  resolveGatewayUrl,
  SANDBOX_GATEWAY_URL,
  startCallbackServer,
} from "./cloud_server.ts";
