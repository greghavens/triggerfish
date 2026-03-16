/**
 * Notion internal integration token connect/disconnect flow.
 *
 * Provides runConnectNotion and disconnectNotion for the CLI.
 * @module
 */

import { Input } from "@cliffy/prompt";
import { createKeychain } from "../../core/secrets/keychain/keychain.ts";
import { createLogger } from "../../core/logger/mod.ts";
import { safeFetch } from "../../core/security/safe_fetch.ts";
import { isValidNotionTokenFormat } from "../../integrations/notion/auth.ts";

const log = createLogger("cli.connect");

// console.log is used intentionally throughout this file for interactive CLI
// output (user-facing prompts and results). Daemon logging uses `log.*`.

/** Print Notion integration setup instructions. */
function printNotionSetupInstructions(): void {
  console.log("Connect Notion\n");
  console.log(
    "This will connect your Notion workspace for pages, databases, and blocks.\n",
  );
  console.log(
    "You need an Internal Integration Token from Notion.\n",
  );
  console.log("  Quick setup:");
  console.log("    1. Go to https://www.notion.so/my-integrations");
  console.log('    2. Click "New integration"');
  console.log('    3. Name it "triggerfish"');
  console.log("    4. Select your workspace");
  console.log("    5. Click Submit");
  console.log("    6. Copy the Internal Integration Token\n");
  console.log(
    "  After connecting, share pages/databases with your integration",
  );
  console.log(
    '  by clicking "..." → "Connections" → "triggerfish" on each page.\n',
  );
}

/** Fetch the Notion users/me endpoint to verify a token (SSRF-safe). */
async function fetchNotionUser(
  token: string,
): Promise<{ ok: true; value: Response } | { ok: false; error: string }> {
  return await safeFetch("https://api.notion.com/v1/users/me", {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
    },
  });
}

/** Report a failed Notion token verification. */
async function reportNotionTokenFailure(resp: Response): Promise<null> {
  const body = await resp.json().catch((err: unknown) => {
    log.warn("Notion token verification response JSON parse failed", {
      operation: "reportNotionTokenFailure",
      err,
    });
    return {} as Record<string, unknown>;
  });
  log.warn("Notion token verification failed", {
    operation: "connectNotion",
    status: resp.status,
  });
  console.log(
    `\nToken verification failed (${resp.status}): ${
      (body as Record<string, string>).message ?? "Unknown error"
    }`,
  );
  console.log(
    "Check that your token is correct and the integration is active.",
  );
  return null;
}

/** Verify a Notion token against the API. Returns bot name or null on failure. */
async function verifyNotionToken(token: string): Promise<string | null> {
  const result = await fetchNotionUser(token);
  if (!result.ok) {
    log.error("Notion API request failed", {
      operation: "connectNotion",
      err: result.error,
    });
    console.log(`\nCould not reach Notion API: ${result.error}`);
    console.log("Check your network connection and try again.");
    return null;
  }
  const resp = result.value;
  if (!resp.ok) return await reportNotionTokenFailure(resp);
  try {
    const user = await resp.json();
    return (user as Record<string, string>).name ??
      (user as { bot?: { owner?: { user?: { name?: string } } } }).bot?.owner
        ?.user?.name ??
      "Notion Bot";
  } catch (err: unknown) {
    log.error("Notion API response parse failed", {
      operation: "connectNotion",
      err,
    });
    console.log("\nFailed to parse Notion API response.");
    return null;
  }
}

/** Prompt for a Notion token and warn if it looks malformed. */
async function promptNotionToken(): Promise<string | null> {
  const token = await Input.prompt({ message: "Paste your token" });
  if (!token.trim()) {
    console.log("No token provided. Aborted.");
    return null;
  }
  const trimmed = token.trim();
  if (!isValidNotionTokenFormat(trimmed)) {
    log.warn("Notion token format unexpected", {
      operation: "connectNotion",
    });
    console.log(
      "Warning: token doesn't look like a Notion integration token (expected ntn_... or secret_...)",
    );
    console.log("Continuing anyway...\n");
  }
  return trimmed;
}

/** Store a verified Notion token in the OS keychain. */
async function storeNotionToken(token: string): Promise<boolean> {
  const secretStore = createKeychain();
  const result = await secretStore.setSecret("notion-api-key", token);
  if (!result.ok) {
    log.error("Notion token keychain store failed", {
      operation: "connectNotion",
      err: result.error,
    });
    console.log(`\nFailed to store token: ${result.error}`);
    return false;
  }
  console.log(
    "Notion connected. Your agent can now access shared pages and databases.",
  );
  return true;
}

/** Interactive Notion integration token setup flow. */
export async function initializeNotionAuth(): Promise<void> {
  printNotionSetupInstructions();
  const trimmed = await promptNotionToken();
  if (!trimmed) return;

  console.log("Verifying token...");
  const name = await verifyNotionToken(trimmed);
  if (name === null) return;
  console.log(`\nAuthenticated as: ${name}`);

  const stored = await storeNotionToken(trimmed);
  if (!stored) return;
}

/** Remove the Notion token from the OS keychain. */
export async function disconnectNotion(): Promise<void> {
  const secretStore = createKeychain();
  const result = await secretStore.deleteSecret("notion-api-key");
  if (result.ok) {
    console.log("Notion disconnected. Token removed from keychain.");
  } else {
    log.warn("Notion token removal failed or key not found", {
      operation: "disconnectNotion",
      err: result.error,
    });
    console.log("No Notion account was connected.");
  }
}

/** @deprecated Use initializeNotionAuth instead */
export const runConnectNotion = initializeNotionAuth;
