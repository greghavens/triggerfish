/**
 * CLI connect / disconnect command dispatcher.
 *
 * Re-exports Google and GitHub connect modules and provides
 * runConnect and runDisconnect routers.
 * @module
 */

export {
  createOAuthCallbackServer,
  disconnectGoogle,
  GOOGLE_SCOPES,
  initializeGoogleAuth,
  initiateGoogleOAuth,
  OAUTH_SUCCESS_HTML,
  performGoogleOAuth,
  runConnectGoogle,
} from "./connect_google.ts";

export {
  disconnectGithub,
  initializeGithubAuth,
  runConnectGithub,
} from "./connect_github.ts";
export {
  disconnectNotion,
  initializeNotionAuth,
  runConnectNotion,
} from "./connect_notion.ts";

import { disconnectGoogle, initializeGoogleAuth } from "./connect_google.ts";
import { disconnectGithub, initializeGithubAuth } from "./connect_github.ts";
import { disconnectNotion, initializeNotionAuth } from "./connect_notion.ts";

/** Print connect usage help. */
function printConnectUsage(): void {
  console.log(`
CONNECT USAGE:
  triggerfish connect google    Authenticate with Google Workspace
  triggerfish connect github    Authenticate with GitHub
  triggerfish connect notion    Authenticate with Notion
`);
}

/** Print disconnect usage help. */
function printDisconnectUsage(): void {
  console.log(`
DISCONNECT USAGE:
  triggerfish disconnect google    Remove Google authentication
  triggerfish disconnect github    Remove GitHub authentication
  triggerfish disconnect notion    Remove Notion authentication
`);
}

/**
 * Handle `triggerfish connect <service>`.
 */
export async function establishServiceConnection(
  subcommand: string | undefined,
  _flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  switch (subcommand) {
    case "google":
      await initializeGoogleAuth();
      break;
    case "github":
      await initializeGithubAuth();
      break;
    case "notion":
      await initializeNotionAuth();
      break;
    default:
      printConnectUsage();
      break;
  }
}

/**
 * Handle `triggerfish disconnect <service>`.
 */
export async function terminateServiceConnection(
  subcommand: string | undefined,
  _flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  switch (subcommand) {
    case "google":
      await disconnectGoogle();
      break;
    case "github":
      await disconnectGithub();
      break;
    case "notion":
      await disconnectNotion();
      break;
    default:
      printDisconnectUsage();
      break;
  }
}

/** @deprecated Use establishServiceConnection instead */
export const runConnect = establishServiceConnection;

/** @deprecated Use terminateServiceConnection instead */
export const runDisconnect = terminateServiceConnection;
