/**
 * Google OAuth2 authentication module.
 *
 * Auth manager, API client, token types, and tool context.
 *
 * @module
 */

export type {
  GoogleApiClient,
  GoogleApiError,
  GoogleApiResult,
  GoogleAuthConfig,
  GoogleAuthConsentResult,
  GoogleAuthManager,
  GoogleAuthResult,
  GoogleTokens,
} from "./types_auth.ts";

export type { GoogleToolContext } from "./types_context.ts";

export { createGoogleAuthManager } from "./auth.ts";

export { createGoogleApiClient } from "./client.ts";
