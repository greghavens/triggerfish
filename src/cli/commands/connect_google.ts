/**
 * Google Workspace OAuth2 connect/disconnect flow.
 *
 * Provides GOOGLE_SCOPES, OAUTH_SUCCESS_HTML, createOAuthCallbackServer,
 * performGoogleOAuth, runConnectGoogle, disconnectGoogle.
 * @module
 */

import { Input } from "@cliffy/prompt";
import { createKeychain } from "../../core/secrets/keychain/keychain.ts";
import type { SecretStore } from "../../core/secrets/keychain/keychain.ts";
import { createGoogleAuthManager } from "../../integrations/google/mod.ts";
import type { GoogleAuthConfig } from "../../integrations/google/mod.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("cli.connect");

/** Google OAuth2 scopes for all Workspace services. */
export const GOOGLE_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
];

/** HTML page shown after successful OAuth callback. */
export const OAUTH_SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>Triggerfish</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5}
.card{text-align:center;padding:2rem;background:white;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1)}
h1{color:#22c55e;margin-bottom:0.5rem}p{color:#666}</style></head>
<body><div class="card"><h1>Connected</h1><p>Google account linked to Triggerfish.<br>You can close this window.</p></div></body></html>`;

/** Build the OAuth callback HTTP request handler. */
function buildOAuthRequestHandler(
  resolveCode: (code: string) => void,
  rejectCode: (err: Error) => void,
): (req: Request) => Response {
  return (req: Request): Response => {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      rejectCode(new Error(`Google returned error: ${error}`));
      return new Response(
        "Authorization failed. You can close this window.",
        { status: 400, headers: { "Content-Type": "text/plain" } },
      );
    }
    if (code) {
      resolveCode(code);
      return new Response(OAUTH_SUCCESS_HTML, {
        headers: { "Content-Type": "text/html" },
      });
    }
    return new Response("Waiting for OAuth callback...", {
      headers: { "Content-Type": "text/plain" },
    });
  };
}

/**
 * Create a temporary localhost server that captures the OAuth callback code.
 *
 * Returns the server, its port, and a promise that resolves with the auth code.
 */
export function createOAuthCallbackServer(): {
  server: Deno.HttpServer;
  port: number;
  codePromise: Promise<string>;
} {
  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const handler = buildOAuthRequestHandler(resolveCode!, rejectCode!);
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    handler,
  );
  const addr = server.addr as Deno.NetAddr;

  const timeout = setTimeout(() => {
    rejectCode(new Error("OAuth callback timed out after 5 minutes"));
  }, 5 * 60 * 1000);
  codePromise.finally(() => clearTimeout(timeout));

  return { server, port: addr.port, codePromise };
}

/** Prompt for Google OAuth client credentials. Returns null if cancelled. */
async function promptGoogleCredentials(): Promise<
  {
    clientId: string;
    clientSecret: string;
  } | null
> {
  const clientId = await Input.prompt({ message: "Google OAuth Client ID" });
  if (!clientId.trim()) {
    console.log("Client ID is required.");
    return null;
  }
  const clientSecret = await Input.prompt({
    message: "Google OAuth Client Secret",
  });
  if (!clientSecret.trim()) {
    console.log("Client Secret is required.");
    return null;
  }
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}

/** Wait for the OAuth callback code, racing against server shutdown. */
// deno-lint-ignore require-await
async function awaitOAuthCode(
  codePromise: Promise<string>,
  server: Deno.HttpServer,
): Promise<string> {
  return Promise.race([
    codePromise,
    server.finished.then(() => {
      throw new Error("OAuth callback server stopped unexpectedly");
    }),
  ]);
}

/** Try to load stored OAuth client credentials from an existing token set. */
async function loadStoredGoogleCredentials(
  store: SecretStore,
): Promise<{ clientId: string; clientSecret: string } | null> {
  const authManager = createGoogleAuthManager(store);
  return await authManager.getStoredCredentials();
}

/**
 * Run the Google OAuth2 flow: prompt for credentials, open browser, exchange code.
 *
 * If credentials are already stored in the keychain (from a previous connect),
 * they are reused automatically. Otherwise the user is prompted.
 *
 * Shared by both `triggerfish connect google` and the dive wizard.
 *
 * @param secretStore - Where to store tokens (defaults to OS keychain)
 */
export async function initiateGoogleOAuth(
  secretStore?: SecretStore,
): Promise<boolean> {
  const store = secretStore ?? createKeychain();
  const storedCreds = await loadStoredGoogleCredentials(store);
  let creds: { clientId: string; clientSecret: string } | null;
  if (storedCreds) {
    console.log("Using existing Google credentials from keychain.");
    creds = storedCreds;
  } else {
    creds = await promptGoogleCredentials();
  }
  if (!creds) return false;
  const authManager = createGoogleAuthManager(store);
  const { server, port, codePromise } = createOAuthCallbackServer();
  const keepAlive = setInterval(() => {}, 60_000);

  try {
    const config: GoogleAuthConfig = {
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      redirectUri: `http://127.0.0.1:${port}`,
      scopes: GOOGLE_SCOPES,
    };

    const consentUrl = authManager.getConsentUrl(config);
    console.log("\nOpen this URL in your browser to authorize Triggerfish:\n");
    console.log(`  ${consentUrl}\n`);
    console.log("Waiting for authorization...\n");

    const code = await awaitOAuthCode(codePromise, server);
    console.log("Authorization received. Exchanging code for tokens...");
    const result = await authManager.exchangeCode(code, config);

    if (result.ok) {
      console.log("\nGoogle account connected successfully.");
      console.log(
        "Your agent can now use Gmail, Calendar, Tasks, Drive, and Sheets.",
      );
      return true;
    } else {
      log.error("Google OAuth token exchange failed", {
        operation: "connectGoogle",
        err: result.error,
      });
      console.log(`\nFailed to connect: ${result.error.message}`);
      console.log(
        "Please verify your Client ID and Client Secret, then try again.",
      );
      return false;
    }
  } finally {
    clearInterval(keepAlive);
    await server.shutdown();
  }
}

/** Print the OAuth credential creation steps. */
function printOAuthCredentialSteps(): void {
  console.log("  Quick setup:");
  console.log("    1. Go to https://console.cloud.google.com ");
  console.log("    2. Create a project (or select an existing one)");
  console.log('    3. Navigate to "APIs & Services" → "Credentials"');
  console.log(
    '    4. Click "+ CREATE CREDENTIALS" and select "OAuth client ID"',
  );
  console.log("    5. If prompted, configure the OAuth consent screen first");
  console.log(
    "       IMPORTANT: Add yourself as a test user on the consent screen,",
  );
  console.log('       or you\'ll get "Access blocked" when authorizing.');
  console.log(
    "       Full walkthrough: https://trigger.fish/integrations/google-workspace.html#google-workspace",
  );
  console.log(
    '    6. On the Create OAuth client ID screen, select "Desktop app" from',
  );
  console.log("       the Application type dropdown");
  console.log('    7. Name it "Triggerfish" (or anything you like)');
  console.log(
    "    8. Click Create, then copy the Client ID and Client Secret\n",
  );
}

/** Print the required Google API list. */
function printRequiredGoogleApis(): void {
  console.log("  You'll also need to enable these APIs in your project:");
  console.log("    • Gmail API");
  console.log("    • Google Calendar API");
  console.log("    • Google Tasks API");
  console.log("    • Google Drive API");
  console.log("    • Google Sheets API");
  console.log(
    "  Enable them at: https://console.cloud.google.com/apis/library\n",
  );
}

/** Print Google Workspace OAuth setup instructions. */
function printGoogleSetupInstructions(): void {
  console.log("Connect Google Workspace\n");
  console.log(
    "This will connect your Google account for Gmail, Calendar, Tasks, Drive, and Sheets.\n",
  );
  console.log("You'll need OAuth2 credentials from Google Cloud Console.\n");
  printOAuthCredentialSteps();
  printRequiredGoogleApis();
}

/** Interactive Google OAuth2 authentication flow. */
export async function initializeGoogleAuth(): Promise<void> {
  printGoogleSetupInstructions();
  await initiateGoogleOAuth();
}

/** Remove Google OAuth tokens from the OS keychain. */
export async function disconnectGoogle(): Promise<void> {
  const secretStore = createKeychain();
  const authManager = createGoogleAuthManager(secretStore);
  const hadTokens = await authManager.hasTokens();
  await authManager.clearTokens();
  if (hadTokens) {
    console.log("Google account disconnected. Tokens removed from keychain.");
  } else {
    console.log("No Google account was connected.");
  }
}

/** @deprecated Use initiateGoogleOAuth instead */
export const performGoogleOAuth = initiateGoogleOAuth;

/** @deprecated Use initializeGoogleAuth instead */
export const runConnectGoogle = initializeGoogleAuth;
