/**
 * Google OAuth2 authentication types.
 *
 * Configuration, token storage, auth manager interface, and result types
 * for Google API authentication flows.
 *
 * @module
 */

// ─── Auth ────────────────────────────────────────────────────────────────────

/** OAuth2 client configuration for Google APIs. */
export interface GoogleAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
}

/** OAuth2 token pair stored in the secret store. */
export interface GoogleTokens {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: number;
  readonly scope: string;
  readonly token_type: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Google auth manager for obtaining and refreshing access tokens. */
export interface GoogleAuthManager {
  /** Build the Google OAuth2 consent URL with CSRF state and PKCE challenge. */
  readonly getConsentUrl: (
    config: GoogleAuthConfig,
  ) => Promise<GoogleAuthConsentResult>;
  /** Exchange an authorization code for tokens (includes PKCE code_verifier). */
  readonly exchangeCode: (
    code: string,
    config: GoogleAuthConfig,
    codeVerifier: string,
  ) => Promise<GoogleAuthResult>;
  /** Get a valid access token, refreshing if needed. */
  readonly getAccessToken: () => Promise<GoogleAuthResult>;
  /** Store tokens in the secret store. */
  readonly storeTokens: (tokens: GoogleTokens) => Promise<void>;
  /** Clear stored tokens. */
  readonly clearTokens: () => Promise<void>;
  /** Check if tokens are stored. */
  readonly hasTokens: () => Promise<boolean>;
  /** Retrieve the stored OAuth client credentials (clientId/clientSecret), or null if none. */
  readonly getStoredCredentials: () => Promise<
    { readonly clientId: string; readonly clientSecret: string } | null
  >;
}

/** Result of consent URL generation — includes the code_verifier for PKCE. */
export type GoogleAuthConsentResult =
  | {
    readonly ok: true;
    readonly value: {
      readonly url: string;
      readonly codeVerifier: string;
      readonly state: string;
    };
  }
  | { readonly ok: false; readonly error: GoogleApiError };

/** Result of an auth operation — either a token string or an error. */
export type GoogleAuthResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: GoogleApiError };

// ─── API Client ──────────────────────────────────────────────────────────────

/** Authenticated HTTP client for Google APIs. */
export interface GoogleApiClient {
  /** HTTP GET with query parameters. */
  readonly get: <T>(
    url: string,
    params?: Record<string, string>,
  ) => Promise<GoogleApiResult<T>>;
  /** HTTP POST with JSON body. */
  readonly post: <T>(
    url: string,
    body: unknown,
  ) => Promise<GoogleApiResult<T>>;
  /** HTTP PATCH with JSON body. */
  readonly patch: <T>(
    url: string,
    body: unknown,
  ) => Promise<GoogleApiResult<T>>;
  /** HTTP PUT with JSON body. */
  readonly put: <T>(
    url: string,
    body: unknown,
  ) => Promise<GoogleApiResult<T>>;
}

/** Result of a Google API call. */
export type GoogleApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: GoogleApiError };

/** Error from a Google API call. */
export interface GoogleApiError {
  readonly code: string;
  readonly message: string;
  readonly status?: number;
}
