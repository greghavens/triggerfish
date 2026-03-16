/**
 * LLM tool definitions and executor for secret management.
 *
 * Provides three LLM-callable tools:
 * - `secret_save`  — prompt the user for a secret value outside LLM context, store it
 * - `secret_list`  — list stored secret names (never values)
 * - `secret_delete` — delete a stored secret by name
 *
 * The secret value is NEVER accepted from the LLM. The `secret_save` tool
 * triggers an out-of-band input mechanism (terminal prompt or browser form)
 * via a platform-supplied `PromptCallback`. The actual value flows directly
 * into the SecretStore without passing through the LLM context.
 *
 * @module
 */

import type { ToolDefinition } from "../core/types/tool.ts";
import type { SecretStore } from "../core/secrets/keychain/keychain.ts";
import { createLogger } from "../core/logger/logger.ts";

const log = createLogger("secrets");

/**
 * Platform-supplied callback to collect a secret value from the user
 * through a secure, out-of-LLM-context channel.
 *
 * For CLI: shows a hidden terminal prompt (input not echoed).
 * For Tidepool: sends a `secret_prompt` WebSocket event and awaits browser response.
 *
 * @param name - The secret name (shown to the user as a hint)
 * @param hint - Optional descriptive hint about what the secret is for
 * @returns The entered secret value, or null if the user cancelled
 */
export type SecretPromptCallback = (
  name: string,
  hint?: string,
) => Promise<string | null>;

/**
 * Platform-supplied callback to collect a username+password credential
 * from the user through a secure, out-of-LLM-context channel.
 *
 * For CLI: prompts for username (echoed) then password (hidden).
 * For Tidepool: sends a `credential_prompt` WebSocket event with two fields.
 *
 * @param name - The credential group name (e.g. "email_smtp")
 * @param hint - Optional descriptive hint about what the credential is for
 * @returns The entered username and password, or null if cancelled
 */
export type CredentialPromptCallback = (
  name: string,
  hint?: string,
) => Promise<{ readonly username: string; readonly password: string } | null>;

/** System prompt section explaining secret tool usage to the LLM. */
export const SECRET_TOOLS_SYSTEM_PROMPT = `## Secret Management

To use a stored secret in any tool argument, use the reference syntax \`{{secret:name}}\`.
The runtime resolves references to real values before execution — values never enter your context.
For credentials: \`{{secret:group:username}}\` and \`{{secret:group:password}}\`.

Never ask the user to type secrets in chat — always use secret_save or secret_save_credential.
Check secret_list before saving to avoid duplicates.

**Never use secret_list to check whether an integration is connected.** If you have tools for a service (e.g. google_gmail, github_issues), the connection is already established — just call the tool. If it fails, that tells you there is a problem. Secrets are for storing values, not for probing service availability.`;

function buildSecretSaveDef(): ToolDefinition {
  return {
    name: "secret_save",
    description:
      "Prompt the user to securely enter a secret value (password, API key, token) " +
      "through a private input channel and store it under the given name. " +
      "The value is NEVER passed through LLM context. " +
      "Use secret_list first to check if the secret already exists.",
    parameters: {
      name: {
        type: "string",
        description: "Unique name for this secret (lowercase, underscores). " +
          "Example: 'github_token', 'smtp_password', 'openai_key'.",
        required: true,
      },
      hint: {
        type: "string",
        description:
          "Optional human-readable description shown to the user when prompting " +
          "for the value. Example: 'GitHub personal access token with repo scope'.",
      },
    },
  };
}

function buildSecretListDef(): ToolDefinition {
  return {
    name: "secret_list",
    description: "List the names of all stored secrets. " +
      "Returns names only — secret values are never returned.",
    parameters: {},
  };
}

function buildSecretSaveCredentialDef(): ToolDefinition {
  return {
    name: "secret_save_credential",
    description:
      "Prompt the user to securely enter a username and password through a private " +
      "input channel and store them as two secrets: <name>:username and <name>:password. " +
      "The values are NEVER passed through LLM context. " +
      "Use this when a service requires login credentials (username + password).",
    parameters: {
      name: {
        type: "string",
        description:
          "Credential group name (lowercase, underscores). The username and password " +
          "will be stored as '<name>:username' and '<name>:password'. " +
          "Example: 'email_smtp', 'jira_login'.",
        required: true,
      },
      hint: {
        type: "string",
        description:
          "Optional human-readable description shown to the user when prompting. " +
          "Example: 'SMTP email login for notifications'.",
      },
    },
  };
}

function buildSecretDeleteDef(): ToolDefinition {
  return {
    name: "secret_delete",
    description: "Delete a stored secret by name.",
    parameters: {
      name: {
        type: "string",
        description: "The name of the secret to delete.",
        required: true,
      },
    },
  };
}

/** Tool definitions for the secret management tools. */
export function buildSecretToolDefinitions(): readonly ToolDefinition[] {
  return [
    buildSecretSaveDef(),
    buildSecretSaveCredentialDef(),
    buildSecretListDef(),
    buildSecretDeleteDef(),
  ];
}

/**
 * Create a tool executor for secret management tools.
 *
 * @param store - The SecretStore backend to read/write secrets.
 * @param prompt - Platform-supplied callback to collect the secret value from the user.
 * @param credentialPrompt - Optional callback to collect username+password credentials.
 * @returns An executor function returning null for non-secret tools (standard pattern).
 */
export function createSecretToolExecutor(
  store: SecretStore,
  prompt: SecretPromptCallback,
  credentialPrompt?: CredentialPromptCallback,
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    switch (name) {
      case "secret_save":
        return await executeSecretSave(store, prompt, input);

      case "secret_save_credential":
        return await executeSecretSaveCredential(
          store,
          credentialPrompt,
          input,
        );

      case "secret_list":
        return await executeSecretList(store);

      case "secret_delete":
        return await executeSecretDelete(store, input);

      default:
        return null;
    }
  };
}

/** Execute the secret_save tool. */
async function executeSecretSave(
  store: SecretStore,
  prompt: SecretPromptCallback,
  input: Record<string, unknown>,
): Promise<string> {
  const secretName = input.name;
  if (typeof secretName !== "string" || secretName.trim().length === 0) {
    return "Error: secret_save requires a 'name' argument (string).";
  }
  const trimmedName = secretName.trim();
  log.warn("Secret save requested via LLM tool", { name: trimmedName });
  const hint = typeof input.hint === "string" ? input.hint.trim() : undefined;

  const value = await prompt(trimmedName, hint);
  if (value === null) {
    return `Secret '${trimmedName}' was not saved — input was cancelled.`;
  }
  if (value.length === 0) {
    return `Error: Secret value cannot be empty. Secret '${trimmedName}' was not saved.`;
  }

  const result = await store.setSecret(trimmedName, value);
  if (!result.ok) {
    return `Error saving secret '${trimmedName}': ${result.error}`;
  }
  return `Secret '${trimmedName}' saved successfully. Reference it in tool arguments as {{secret:${trimmedName}}}.`;
}

/** Execute the secret_save_credential tool. */
async function executeSecretSaveCredential(
  store: SecretStore,
  credentialPrompt: CredentialPromptCallback | undefined,
  input: Record<string, unknown>,
): Promise<string> {
  const credName = input.name;
  if (typeof credName !== "string" || credName.trim().length === 0) {
    return "Error: secret_save_credential requires a 'name' argument (string).";
  }
  const trimmedName = credName.trim();
  log.warn("Credential save requested via LLM tool", { name: trimmedName });

  if (!credentialPrompt) {
    log.warn("Credential save rejected: prompt unavailable", {
      operation: "executeSecretSaveCredential",
      reason: "credentialPrompt unavailable",
      name: trimmedName,
    });
    return "Error: Credential prompting is not available in this environment.";
  }

  const hint = typeof input.hint === "string" ? input.hint.trim() : undefined;

  const credential = await credentialPrompt(trimmedName, hint);
  if (credential === null) {
    return `Credential '${trimmedName}' was not saved — input was cancelled.`;
  }
  if (credential.username.length === 0) {
    return `Error: Username cannot be empty. Credential '${trimmedName}' was not saved.`;
  }
  if (credential.password.length === 0) {
    return `Error: Password cannot be empty. Credential '${trimmedName}' was not saved.`;
  }

  const usernameKey = `${trimmedName}:username`;
  const passwordKey = `${trimmedName}:password`;

  const usernameResult = await store.setSecret(
    usernameKey,
    credential.username,
  );
  if (!usernameResult.ok) {
    return `Error saving credential username '${usernameKey}': ${usernameResult.error}`;
  }

  const passwordResult = await store.setSecret(
    passwordKey,
    credential.password,
  );
  if (!passwordResult.ok) {
    return `Error saving credential password '${passwordKey}': ${passwordResult.error}`;
  }

  return `Credential '${trimmedName}' saved successfully. Reference as {{secret:${usernameKey}}} and {{secret:${passwordKey}}}.`;
}

/** Execute the secret_list tool. */
async function executeSecretList(store: SecretStore): Promise<string> {
  const result = await store.listSecrets();
  if (!result.ok) {
    return `Error listing secrets: ${result.error}`;
  }
  if (result.value.length === 0) {
    return "No secrets stored. Use secret_save to store a secret.";
  }
  const names = result.value.map((n) => `  - ${n}`).join("\n");
  return `Stored secrets (${result.value.length}):\n${names}\n\nReference them as {{secret:name}} in tool arguments.`;
}

/** Execute the secret_delete tool. */
async function executeSecretDelete(
  store: SecretStore,
  input: Record<string, unknown>,
): Promise<string> {
  const secretName = input.name;
  if (typeof secretName !== "string" || secretName.trim().length === 0) {
    return "Error: secret_delete requires a 'name' argument (string).";
  }
  const trimmedName = secretName.trim();
  log.warn("Secret delete requested via LLM tool", { name: trimmedName });
  const result = await store.deleteSecret(trimmedName);
  if (!result.ok) {
    return `Error deleting secret '${trimmedName}': ${result.error}`;
  }
  return `Secret '${trimmedName}' deleted successfully.`;
}

/** @deprecated Use buildSecretToolDefinitions instead */
export const getSecretToolDefinitions = buildSecretToolDefinitions;
