/**
 * Google OAuth2 authentication manager.
 *
 * Handles consent URL generation, authorization code exchange,
 * token refresh, and secure token storage via SecretStore.
 *
 * @module
 */

import type { SecretStore } from "../../../core/secrets/keychain/keychain.ts";
import { createLogger } from "../../../core/logger/logger.ts";
import type {
  GoogleAuthConfig,
  GoogleAuthManager,
  GoogleAuthResult,
  GoogleTokens,
} from "../types.ts";
import { buildConsentUrl } from "./auth_pkce.ts";

const log = createLogger("google-auth");

/** Key used in the SecretStore for Google tokens. */
const TOKEN_KEY = "google:tokens";

/** Seconds before expiry to trigger a proactive refresh. */
const REFRESH_MARGIN_SECONDS = 60;

/** Google OAuth2 token endpoint. */
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Options threaded into the authorization code exchange. */
interface ExchangeCodeOptions {
  readonly codeVerifier: string;
  readonly fetchFn: typeof globalThis.fetch;
  readonly persistTokens: (tokens: GoogleTokens) => Promise<void>;
}

/** Exchange an authorization code for Google OAuth2 tokens. */
async function exchangeAuthorizationCode(
  code: string,
  config: GoogleAuthConfig,
  opts: ExchangeCodeOptions,
): Promise<GoogleAuthResult> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
    code_verifier: opts.codeVerifier,
  });
  const response = await opts.fetchFn(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 200);
    log.error("Google token exchange failed", {
      operation: "exchangeGoogleAuthCode",
      err: { status: response.status, body: text },
    });
    return {
      ok: false,
      error: {
        code: "TOKEN_EXCHANGE_FAILED",
        message: `Token exchange failed (${response.status}): ${text}`,
        status: response.status,
      },
    };
  }
  const data = await response.json();
  const tokens: GoogleTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    scope: data.scope ?? "",
    token_type: data.token_type ?? "Bearer",
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  };
  await opts.persistTokens(tokens);
  log.info("Google token exchange succeeded", {
    operation: "exchangeGoogleAuthCode",
  });
  return { ok: true, value: tokens.access_token };
}

/** Build a refresh error result based on HTTP status. */
function buildRefreshErrorResult(
  status: number,
  text: string,
): GoogleAuthResult {
  if (status === 400 || status === 401) {
    return {
      ok: false,
      error: {
        code: "REFRESH_REVOKED",
        message:
          "Google refresh token revoked or expired. Run 'triggerfish connect google' to reconnect.",
        status,
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "REFRESH_FAILED",
      message: `Token refresh failed (${status}): ${text}`,
      status,
    },
  };
}

/** Refresh an expired Google access token using the refresh token. */
async function refreshGoogleAccessToken(
  tokens: GoogleTokens,
  fetchFn: typeof globalThis.fetch,
  persistTokens: (tokens: GoogleTokens) => Promise<void>,
): Promise<GoogleAuthResult> {
  const body = new URLSearchParams({
    refresh_token: tokens.refresh_token,
    client_id: tokens.clientId,
    client_secret: tokens.clientSecret,
    grant_type: "refresh_token",
  });
  const response = await fetchFn(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 200);
    log.error("Google token refresh failed", {
      operation: "refreshGoogleToken",
      err: { status: response.status, body: text },
    });
    return buildRefreshErrorResult(response.status, text);
  }
  const data = await response.json();
  const updated: GoogleTokens = {
    access_token: data.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    scope: data.scope ?? tokens.scope,
    token_type: data.token_type ?? "Bearer",
    clientId: tokens.clientId,
    clientSecret: tokens.clientSecret,
  };
  await persistTokens(updated);
  return { ok: true, value: updated.access_token };
}

/** Load stored Google tokens from the secret store, clearing corrupt entries. */
async function loadGoogleTokens(
  secretStore: SecretStore,
): Promise<GoogleTokens | null> {
  const result = await secretStore.getSecret(TOKEN_KEY);
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.value) as Record<string, unknown>;
    if (
      typeof parsed.access_token !== "string" ||
      typeof parsed.clientId !== "string"
    ) {
      log.warn(
        "Google tokens missing required fields, clearing corrupt entry",
        {
          operation: "loadGoogleTokens",
          err: { keys: Object.keys(parsed) },
        },
      );
      await secretStore.deleteSecret(TOKEN_KEY);
      return null;
    }
    return parsed as unknown as GoogleTokens;
  } catch (err: unknown) {
    log.warn("Google token JSON parse failed, clearing corrupt entry", {
      operation: "loadGoogleTokens",
      err,
    });
    await secretStore.deleteSecret(TOKEN_KEY);
    return null;
  }
}

/**
 * Create a Google OAuth2 auth manager.
 *
 * @param secretStore - SecretStore for persisting tokens
 * @param fetchFn - Injectable fetch for testing (defaults to globalThis.fetch)
 */
export function createGoogleAuthManager(
  secretStore: SecretStore,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): GoogleAuthManager {
  let refreshPromise: Promise<GoogleAuthResult> | null = null;

  async function persistTokens(tokens: GoogleTokens): Promise<void> {
    await secretStore.setSecret(TOKEN_KEY, JSON.stringify(tokens));
  }

  return {
    getConsentUrl: buildConsentUrl,
    exchangeCode: (code, config, codeVerifier) =>
      exchangeAuthorizationCode(code, config, {
        codeVerifier,
        fetchFn,
        persistTokens,
      }),
    async getAccessToken(): Promise<GoogleAuthResult> {
      const stored = await loadGoogleTokens(secretStore);
      if (!stored) {
        return {
          ok: false,
          error: {
            code: "NO_TOKENS",
            message:
              "No Google tokens found. Run 'triggerfish connect google' to authenticate.",
          },
        };
      }
      if (stored.expires_at > Date.now() + REFRESH_MARGIN_SECONDS * 1000) {
        return { ok: true, value: stored.access_token };
      }
      if (!stored.refresh_token) {
        return {
          ok: false,
          error: {
            code: "NO_REFRESH_TOKEN",
            message: "No refresh token available. Reconnect Google account.",
          },
        };
      }
      if (refreshPromise) return refreshPromise;
      refreshPromise = refreshGoogleAccessToken(stored, fetchFn, persistTokens);
      try {
        return await refreshPromise;
      } finally {
        refreshPromise = null;
      }
    },
    storeTokens: persistTokens,
    async clearTokens(): Promise<void> {
      await secretStore.deleteSecret(TOKEN_KEY);
    },
    async hasTokens(): Promise<boolean> {
      return (await secretStore.getSecret(TOKEN_KEY)).ok;
    },
    async getStoredCredentials(): Promise<
      { readonly clientId: string; readonly clientSecret: string } | null
    > {
      const tokens = await loadGoogleTokens(secretStore);
      if (!tokens?.clientId || !tokens?.clientSecret) return null;
      return { clientId: tokens.clientId, clientSecret: tokens.clientSecret };
    },
  };
}
