/**
 * PKCE utility functions for Google OAuth2 authentication.
 *
 * Provides code verifier generation, state parameter generation,
 * SHA-256 code challenge computation, base64url encoding, and
 * consent URL construction. Mirrors the X OAuth 2.0 PKCE flow.
 *
 * @module
 */

import type {
  GoogleAuthConfig,
  GoogleAuthConsentResult,
} from "./types_auth.ts";

/** Google OAuth2 authorization endpoint. */
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

/** Base64url encode without padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  const binString = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binString)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Generate a cryptographically random string for the PKCE code_verifier. */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** Generate a random state parameter for CSRF protection. */
export function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** Compute the SHA-256 code_challenge from a code_verifier. */
export async function computeCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

/** Build the Google OAuth2 consent URL with CSRF state and PKCE challenge. */
export async function buildConsentUrl(
  config: GoogleAuthConfig,
): Promise<GoogleAuthConsentResult> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await computeCodeChallenge(codeVerifier);
  const state = generateState();

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: config.scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return {
    ok: true,
    value: {
      url: `${AUTH_ENDPOINT}?${params.toString()}`,
      codeVerifier,
      state,
    },
  };
}
