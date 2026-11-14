/**
 * X (Twitter) OAuth 2.0 PKCE helpers: callback server, credential
 * prompting, user verification, and URI utilities.
 *
 * Extracted from connect_x.ts to keep each file under 300 lines.
 *
 * @module
 */

import { Input } from "@cliffy/prompt";
import type { SecretStore } from "../../core/secrets/keychain/keychain.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("cli.connect-x-oauth");

// console.log is used intentionally throughout this file for interactive CLI
// output (user-facing prompts and results). Daemon logging uses `log.*`.

/** HTML page shown after successful OAuth callback. */
export const OAUTH_SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>Triggerfish</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5}
.card{text-align:center;padding:2rem;background:white;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1)}
h1{color:#22c55e;margin-bottom:0.5rem}p{color:#666}</style></head>
<body><div class="card"><h1>Connected</h1><p>X account linked to Triggerfish.<br>You can close this window.</p></div></body></html>`;

// ─── OAuth callback server ───────────────────────────────────────────────────

/** Build a plain text response with optional HTTP status. */
function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

/** Handle an OAuth error callback from X. */
function handleOAuthError(
  url: URL,
  rejectCode: (err: Error) => void,
): Response {
  const rawDescription = url.searchParams.get("error_description") ??
    url.searchParams.get("error") ?? "unknown";
  const description = rawDescription.slice(0, 500);
  rejectCode(new Error(`X returned error: ${description}`));
  return textResponse("Authorization failed. You can close this window.", 400);
}

/** Handle a successful OAuth callback — validate state and resolve. */
function handleOAuthSuccess(
  code: string,
  state: string | null,
  expectedState: string,
  resolveCode: (code: string) => void,
  rejectCode: (err: Error) => void,
): Response {
  if (!state || state !== expectedState) {
    log.warn("X OAuth CSRF state mismatch detected", {
      operation: "handleOAuthSuccess",
      expectedState,
      receivedState: state,
    });
    rejectCode(new Error("OAuth state mismatch — possible CSRF"));
    return textResponse("State mismatch. Authorization rejected.", 400);
  }
  resolveCode(code);
  return new Response(OAUTH_SUCCESS_HTML, {
    headers: { "Content-Type": "text/html" },
  });
}

/** Build the OAuth callback HTTP request handler. */
export function buildXOAuthRequestHandler(
  resolveCode: (code: string) => void,
  rejectCode: (err: Error) => void,
  expectedState: string,
): (req: Request) => Response {
  let settled = false;
  return (req: Request): Response => {
    if (settled) return textResponse("Authorization already processed.");
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (error) {
      settled = true;
      return handleOAuthError(url, rejectCode);
    }
    if (!code) return textResponse("Waiting for X OAuth callback...");
    settled = true;
    return handleOAuthSuccess(
      code,
      url.searchParams.get("state"),
      expectedState,
      resolveCode,
      rejectCode,
    );
  };
}

/** Create a temporary localhost server that captures the OAuth callback code. */
export function createXOAuthCallbackServer(
  port: number,
  expectedState: string,
): {
  server: Deno.HttpServer;
  codePromise: Promise<string>;
  timeoutHandle: ReturnType<typeof setTimeout>;
} {
  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const handler = buildXOAuthRequestHandler(
    resolveCode!,
    rejectCode!,
    expectedState,
  );
  const server = Deno.serve(
    { hostname: "127.0.0.1", port, onListen() {} },
    handler,
  );

  const timeout = setTimeout(() => {
    rejectCode(new Error("X OAuth callback timed out after 5 minutes"));
  }, 5 * 60 * 1000);
  codePromise.finally(() => clearTimeout(timeout));

  return { server, codePromise, timeoutHandle: timeout };
}

// ─── Credential prompting ────────────────────────────────────────────────────

/** Load a previously stored X Client ID from the keychain. */
export async function loadStoredClientId(
  store: SecretStore,
): Promise<string | null> {
  const result = await store.getSecret("x:client_id");
  return result.ok ? result.value : null;
}

/** Prompt for X OAuth Client ID. Returns null if cancelled. */
export async function promptXClientId(
  store: SecretStore,
): Promise<string | null> {
  const stored = await loadStoredClientId(store);
  if (stored) {
    console.log(
      `Using existing X Client ID from keychain (${stored.slice(0, 8)}...).`,
    );
    return stored;
  }
  const clientId = await Input.prompt({ message: "X OAuth Client ID" });
  if (!clientId.trim()) {
    console.log("Client ID is required.");
    return null;
  }
  const trimmed = clientId.trim();
  await store.setSecret("x:client_id", trimmed);
  return trimmed;
}

// ─── URI utilities ───────────────────────────────────────────────────────────

/** Extract the port from a redirect URI. */
export function extractPort(redirectUri: string): number {
  try {
    const parsed = new URL(redirectUri);
    return parsed.port ? parseInt(parsed.port, 10) : 3000;
  } catch (err: unknown) {
    log.warn("Redirect URI parse failed, defaulting to port 3000", {
      operation: "extractPort",
      err,
    });
    return 3000;
  }
}
