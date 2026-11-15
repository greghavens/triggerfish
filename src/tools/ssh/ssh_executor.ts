/**
 * SSH tool executor — routes ssh_execute, ssh_session_* calls.
 *
 * All credentials arrive as resolved secret values (the dispatch pipeline
 * substitutes {{secret:name}} before the executor sees the input).
 *
 * @module
 */

import { createLogger } from "../../core/logger/logger.ts";
import { validateSshHost } from "./ssh_args.ts";
import {
  buildAskpassEnv,
  buildExecuteArgs,
  cleanupCredentials,
  resolveCredentials,
  type SshSessionId,
  SshSessionManager,
} from "./ssh_session.ts";

const log = createLogger("ssh-executor");

/** Default timeout for one-shot ssh_execute calls (30s). */
const DEFAULT_EXECUTE_TIMEOUT_MS = 30_000;

/** Default timeout for reading from an interactive session (5s). */
const DEFAULT_READ_TIMEOUT_MS = 5_000;

/** Maximum allowed timeout for one-shot execution (5 min). */
const MAX_EXECUTE_TIMEOUT_MS = 300_000;

/** Extract credential fields from tool input. */
function extractCredentials(input: Record<string, unknown>): {
  readonly key?: string;
  readonly password?: string;
  readonly passphrase?: string;
} {
  return {
    key: typeof input.key === "string" ? input.key : undefined,
    password: typeof input.password === "string" ? input.password : undefined,
    passphrase: typeof input.passphrase === "string"
      ? input.passphrase
      : undefined,
  };
}

/** Execute a one-shot SSH command and return the result. */
async function executeSshExecute(
  input: Record<string, unknown>,
): Promise<string> {
  const host = input.host;
  if (typeof host !== "string" || host.trim().length === 0) {
    return "Error: ssh_execute requires a non-empty 'host' argument (string).";
  }
  const hostCheck = validateSshHost(host);
  if (!hostCheck.ok) {
    log.warn("SSH execute host rejected", {
      operation: "executeSshExecute",
      host,
      reason: hostCheck.error,
    });
    return `Error: ${hostCheck.error}`;
  }
  const command = input.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    return "Error: ssh_execute requires a non-empty 'command' argument (string).";
  }

  const timeoutMs = typeof input.timeout_ms === "number"
    ? Math.min(Math.max(input.timeout_ms, 1000), MAX_EXECUTE_TIMEOUT_MS)
    : DEFAULT_EXECUTE_TIMEOUT_MS;

  const port = typeof input.port === "number" ? input.port : undefined;
  const creds = extractCredentials(input);
  const resolved = await resolveCredentials(creds);
  const args = buildExecuteArgs(hostCheck.value, command, { port }, resolved);
  const env = buildAskpassEnv(resolved);

  log.info("Executing SSH command", {
    operation: "executeSshExecute",
    host,
    commandPreview: command.slice(0, 80),
    hasKey: !!creds.key,
    hasPassword: !!creds.password,
    hasPassphrase: !!creds.passphrase,
  });

  try {
    const proc = new Deno.Command("ssh", {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      env: Object.keys(env).length > 0 ? env : undefined,
    });

    const child = proc.spawn();

    const result = await Promise.race([
      child.output(),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeoutMs)
      ),
    ]);

    if (result === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Process may have already exited.
      }
      await cleanupCredentials(resolved);
      return `Error: ssh_execute timed out after ${timeoutMs}ms. Host: ${host}, command: ${command}`;
    }

    const decoder = new TextDecoder();
    const stdout = decoder.decode(result.stdout);
    const stderr = decoder.decode(result.stderr);

    await cleanupCredentials(resolved);

    return JSON.stringify({
      exitCode: result.code,
      stdout,
      stderr,
    });
  } catch (err) {
    await cleanupCredentials(resolved);
    log.error("SSH execute failed", {
      operation: "executeSshExecute",
      host,
      err,
    });
    return `Error: ssh_execute failed for ${host}: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}

/** Open an interactive SSH session. */
async function executeSshSessionOpen(
  manager: SshSessionManager,
  input: Record<string, unknown>,
): Promise<string> {
  const host = input.host;
  if (typeof host !== "string" || host.trim().length === 0) {
    return "Error: ssh_session_open requires a non-empty 'host' argument (string).";
  }
  const hostCheck = validateSshHost(host);
  if (!hostCheck.ok) {
    log.warn("SSH session open host rejected", {
      operation: "executeSshSessionOpen",
      host,
      reason: hostCheck.error,
    });
    return `Error: ${hostCheck.error}`;
  }

  const port = typeof input.port === "number" ? input.port : undefined;
  const creds = extractCredentials(input);

  try {
    const session = await manager.openSession({
      host: hostCheck.value,
      port,
      ...creds,
    });

    const initialOutput = session.stdoutBuffer;
    session.stdoutBuffer = "";

    return JSON.stringify({
      session_id: session.id,
      host: session.host,
      status: "connected",
      initial_output: initialOutput,
    });
  } catch (err) {
    log.error("SSH session open failed", {
      operation: "executeSshSessionOpen",
      host,
      err,
    });
    return `Error: ssh_session_open failed for ${host}: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}

/** Write input to an interactive SSH session. */
async function executeSshSessionWrite(
  manager: SshSessionManager,
  input: Record<string, unknown>,
): Promise<string> {
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return "Error: ssh_session_write requires a non-empty 'session_id' argument (string).";
  }
  const text = input.input;
  if (typeof text !== "string") {
    return "Error: ssh_session_write requires an 'input' argument (string).";
  }

  try {
    await manager.writeToSession(sessionId as SshSessionId, text);
    return JSON.stringify({ status: "sent", bytes: text.length });
  } catch (err) {
    return `Error: ssh_session_write failed: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}

/** Read buffered output from an interactive SSH session. */
async function executeSshSessionRead(
  manager: SshSessionManager,
  input: Record<string, unknown>,
): Promise<string> {
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return "Error: ssh_session_read requires a non-empty 'session_id' argument (string).";
  }

  const timeoutMs = typeof input.timeout_ms === "number"
    ? Math.min(Math.max(input.timeout_ms, 100), 60_000)
    : DEFAULT_READ_TIMEOUT_MS;

  try {
    const { stdout, stderr } = await manager.readFromSession(
      sessionId as SshSessionId,
      timeoutMs,
    );

    const session = manager.getSession(sessionId as SshSessionId);
    return JSON.stringify({
      stdout,
      stderr,
      closed: session?.closed ?? true,
    });
  } catch (err) {
    return `Error: ssh_session_read failed: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}

/** Close an interactive SSH session. */
async function executeSshSessionClose(
  manager: SshSessionManager,
  input: Record<string, unknown>,
): Promise<string> {
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return "Error: ssh_session_close requires a non-empty 'session_id' argument (string).";
  }

  try {
    const { stdout, stderr } = await manager.closeSession(
      sessionId as SshSessionId,
    );
    return JSON.stringify({
      status: "closed",
      remaining_stdout: stdout,
      remaining_stderr: stderr,
    });
  } catch (err) {
    return `Error: ssh_session_close failed: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}

/** Dispatch table for SSH tools. */
const SSH_EXECUTORS: Record<
  string,
  (
    manager: SshSessionManager,
    input: Record<string, unknown>,
  ) => Promise<string>
> = {
  ssh_session_open: executeSshSessionOpen,
  ssh_session_write: executeSshSessionWrite,
  ssh_session_read: executeSshSessionRead,
  ssh_session_close: executeSshSessionClose,
};

/**
 * Create an SSH tool executor.
 *
 * Returns a SubsystemExecutor that handles ssh_execute and ssh_session_* tools.
 * The session manager is created internally and manages all interactive sessions.
 */
export function createSshToolExecutor(): (
  name: string,
  input: Record<string, unknown>,
) => Promise<string | null> {
  const manager = new SshSessionManager();

  return (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    if (name === "ssh_execute") {
      return executeSshExecute(input);
    }

    const handler = SSH_EXECUTORS[name];
    if (!handler) return Promise.resolve(null);
    return handler(manager, input);
  };
}
