/**
 * X (Twitter) OAuth 2.0 PKCE connect/disconnect flow.
 *
 * Runs the full PKCE authorization: prompts for Client ID, opens browser
 * consent URL, captures the callback code via localhost server, exchanges
 * for tokens, fetches the authenticated user, and stores everything in
 * the OS keychain.
 *
 * @module
 */

import { createKeychain } from "../../core/secrets/keychain/keychain.ts";
import type { SecretStore } from "../../core/secrets/keychain/keychain.ts";
import { createXAuthManager } from "../../integrations/x/auth/auth.ts";
import type {
  XAuthConfig,
  XAuthManager,
} from "../../integrations/x/auth/types_auth.ts";
import { createLogger } from "../../core/logger/mod.ts";
import {
  createXOAuthCallbackServer,
  extractPort,
  promptXClientId,
} from "./connect_x_oauth.ts";
import { verifyAndStoreXUser } from "../../integrations/x/auth/user_verify.ts";

const log = createLogger("cli.connect-x");

// console.log is used intentionally throughout this file for interactive CLI
// output (user-facing prompts and results). Daemon logging uses `log.*`.

/** Default X OAuth 2.0 scopes for full integration access. */
export const X_SCOPES: readonly string[] = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "follows.read",
  "follows.write",
  "like.read",
  "like.write",
  "list.read",
  "list.write",
  "bookmark.read",
  "bookmark.write",
  "offline.access",
];

/** Default redirect URI for the PKCE callback. */
const DEFAULT_REDIRECT_URI = "http://127.0.0.1:3000/auth/x/callback";

// ─── Main flow ───────────────────────────────────────────────────────────────

/** Wait for the OAuth callback code from the localhost server. */
function awaitOAuthCallback(
  codePromise: Promise<string>,
  serverFinished: Promise<void>,
): Promise<string> {
  return Promise.race([
    codePromise,
    serverFinished.then(() => {
      throw new Error("OAuth callback server stopped unexpectedly");
    }),
  ]);
}

/** Exchange the authorization code and verify the user. */
async function exchangeAndVerifyXUser(
  authManager: XAuthManager,
  config: XAuthConfig,
  code: string,
  codeVerifier: string,
  store: SecretStore,
): Promise<boolean> {
  console.log("Authorization received. Exchanging code for tokens...");
  const tokenResult = await authManager.exchangeCode(
    code,
    config,
    codeVerifier,
  );
  if (!tokenResult.ok) {
    log.error("X token exchange failed", {
      operation: "connectX",
      err: tokenResult.error,
    });
    console.log(`\nFailed to exchange code: ${tokenResult.error.message}`);
    return false;
  }
  return reportXUserVerification(tokenResult.value, store);
}

/** Verify user and print connection result. */
async function reportXUserVerification(
  accessToken: string,
  store: SecretStore,
): Promise<boolean> {
  console.log("Tokens stored. Verifying user...");
  const username = await verifyAndStoreXUser(accessToken, store);
  if (username) {
    console.log(`\nX account connected as @${username}.`);
    console.log("Your agent can now post, search, engage, and manage lists.");
  } else {
    console.log("\nTokens saved but user verification failed.");
    console.log("X tools will attempt to work. You may need to reconnect.");
  }
  return true;
}

/** Run the X OAuth 2.0 PKCE flow. */
export async function initiateXOAuth(
  secretStore?: SecretStore,
): Promise<boolean> {
  const store = secretStore ?? createKeychain();
  const clientId = await promptXClientId(store);
  if (!clientId) return false;

  const authManager = createXAuthManager(store);
  const config: XAuthConfig = {
    clientId,
    redirectUri: DEFAULT_REDIRECT_URI,
    scopes: X_SCOPES,
  };

  const consentResult = await authManager.getConsentUrl(config);
  if (!consentResult.ok) {
    log.error("X consent URL generation failed", {
      operation: "connectX",
      err: consentResult.error,
    });
    console.log(
      `\nFailed to generate consent URL: ${consentResult.error.message}`,
    );
    return false;
  }

  const { url, codeVerifier, state } = consentResult.value;
  const port = extractPort(DEFAULT_REDIRECT_URI);
  const { server, codePromise, timeoutHandle } = createXOAuthCallbackServer(
    port,
    state,
  );
  const keepAlive = setInterval(() => {}, 60_000);

  try {
    console.log("\nOpen this URL in your browser to authorize Triggerfish:\n");
    console.log(`  ${url}\n`);
    console.log("Waiting for authorization...\n");
    const code = await awaitOAuthCallback(codePromise, server.finished);
    return await exchangeAndVerifyXUser(
      authManager,
      config,
      code,
      codeVerifier,
      store,
    );
  } catch (err: unknown) {
    log.error("X OAuth flow failed", { operation: "connectX", err });
    const message = err instanceof Error ? err.message : String(err);
    console.log(`\nX connection failed: ${message}`);
    return false;
  } finally {
    clearTimeout(timeoutHandle);
    clearInterval(keepAlive);
    await server.shutdown();
  }
}

// ─── Setup instructions ──────────────────────────────────────────────────────

/** Print X developer app setup instructions. */
function printXSetupInstructions(): void {
  console.log("Connect X (Twitter)\n");
  console.log(
    "This will connect your X account for posting, searching, engagement, and lists.\n",
  );
  console.log(
    "You need an OAuth 2.0 Client ID from the X Developer Portal.\n",
  );
  console.log("  Quick setup:");
  console.log(
    "    1. Go to https://developer.x.com/en/portal/projects-and-apps",
  );
  console.log("    2. Create a project and app (or select existing)");
  console.log(
    '    3. Under "User authentication settings", click Set up',
  );
  console.log("    4. Enable OAuth 2.0");
  console.log('    5. Set Type of App to "Native App" (public client)');
  console.log(`    6. Set Callback URL to: ${DEFAULT_REDIRECT_URI}`);
  console.log(
    "    7. Copy the Client ID (from the OAuth 2.0 section, NOT the API Key)\n",
  );
  console.log("  Note: X OAuth 2.0 PKCE does not require a Client Secret.");
  console.log(
    "  You only need the Client ID.\n",
  );
}

/** Interactive X OAuth 2.0 PKCE authentication flow. */
export async function initializeXAuth(): Promise<void> {
  printXSetupInstructions();
  await initiateXOAuth();
}

/** Remove X tokens and user ID from the OS keychain. */
export async function disconnectX(): Promise<void> {
  const store = createKeychain();
  const authManager = createXAuthManager(store);
  const hadTokens = await authManager.hasTokens();
  const errors: unknown[] = [];
  try {
    await authManager.clearTokens();
  } catch (err: unknown) {
    errors.push(err);
  }
  try {
    await store.deleteSecret("x:user_id");
  } catch (err: unknown) {
    errors.push(err);
  }
  try {
    await store.deleteSecret("x:quota");
  } catch (err: unknown) {
    errors.push(err);
  }

  if (errors.length > 0) {
    log.error("X disconnect keychain cleanup partially failed", {
      operation: "disconnectX",
      err: { errors },
    });
    console.log("Warning: some X credentials may not have been fully removed.");
    return;
  }
  if (hadTokens) {
    console.log("X account disconnected. Tokens removed from keychain.");
  } else {
    console.log("No X account was connected.");
  }
}
