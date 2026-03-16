/**
 * Headless Claude Code CLI session management.
 *
 * Spawns `claude` as a child process using stream-json I/O format
 * for interactive sessions. Supports multiple concurrent sessions,
 * follow-up prompts, timeout enforcement, and workspace isolation.
 *
 * Sub-modules:
 * - claude_tools.ts: Tool definitions, system prompt, and tool executor
 * - session_types.ts: Session interfaces and configuration types
 * - stream_parser.ts: Stream-JSON output parsing
 * - process_spawn.ts: CLI argument building and process spawning
 * - session_lifecycle.ts: Termination, polling, and ID generation
 *
 * @module
 */

import type { Result } from "../core/types/classification.ts";
import { createLogger } from "../core/logger/logger.ts";
import type {
  ClaudeSession,
  ClaudeSessionConfig,
  ClaudeSessionManager,
  ClaudeSessionManagerOptions,
  SessionEntry,
} from "./session_types.ts";
import { encodeUserMessage, parseStreamOutput } from "./stream_parser.ts";
import {
  buildClaudeArgs,
  buildClaudeEnv,
  spawnClaudeProcess,
} from "./process_spawn.ts";
import {
  generateSessionId,
  pollForClaudeResponse,
  terminateClaudeSession,
} from "./session_lifecycle.ts";

const log = createLogger("exec");

// ─── Re-exports ──────────────────────────────────────────────────
export type {
  ClaudeSession,
  ClaudeSessionConfig,
  ClaudeSessionManager,
  ClaudeSessionManagerOptions,
} from "./session_types.ts";

export {
  buildClaudeToolDefinitions,
  CLAUDE_SESSION_SYSTEM_PROMPT,
  createClaudeToolExecutor,
  getClaudeToolDefinitions,
} from "./claude_tools.ts";

// ─── Closure helpers for createClaudeSessionManager ──────────────

/** Start reading stdout in the background, appending to entry.output. */
function startOutputReader(
  entry: SessionEntry,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  const decoder = new TextDecoder();
  const read = async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        entry.output += decoder.decode(value, { stream: true });
      }
    } catch {
      // Stream closed — expected on process exit
    }
  };
  read();
}

/** Drain stderr in background to prevent resource leaks. */
function drainStderr(
  entry: SessionEntry,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  const decoder = new TextDecoder();
  const read = async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        entry.stderr += decoder.decode(value, { stream: true });
      }
    } catch {
      // Stream closed — expected on process exit
    }
  };
  read();
}

/** Watch for process exit and update session status. */
function watchProcessExit(entry: SessionEntry): void {
  entry.process.status.then((status) => {
    const exitCode = status.code ?? -1;
    const finalStatus = exitCode === 0 ? "completed" : "failed";
    entry.session = {
      ...entry.session,
      status: entry.session.status === "terminated"
        ? "terminated"
        : finalStatus,
      endedAt: new Date(),
      exitCode,
    };
    if (entry.timeoutId !== null) {
      clearTimeout(entry.timeoutId);
    }
    entry.stdinWriter.close().catch((err: unknown) => {
      log.debug("Stdin writer close failed on session exit", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

/** Set up timeout enforcement that escalates SIGTERM to SIGKILL. */
function setupSessionTimeout(
  entry: SessionEntry,
  timeoutMs: number,
): number {
  return setTimeout(async () => {
    if (entry.session.status !== "running") return;
    try {
      entry.process.kill("SIGTERM");
    } catch {
      // Already dead
    }
    await new Promise((r) => setTimeout(r, 5000));
    if (entry.session.status === "running") {
      try {
        entry.process.kill("SIGKILL");
      } catch {
        // Already dead
      }
    }
    entry.session = {
      ...entry.session,
      status: "terminated",
      endedAt: new Date(),
    };
  }, timeoutMs) as unknown as number;
}

// ─── Factory ─────────────────────────────────────────────────────

/**
 * Create a Claude session manager.
 *
 * @param options - Manager configuration
 */
export function createClaudeSessionManager(
  options: ClaudeSessionManagerOptions,
): ClaudeSessionManager {
  const sessions = new Map<string, SessionEntry>();
  const binary = options.claudeBinary ?? "claude";

  return {
    start(
      prompt: string,
      config?: Partial<ClaudeSessionConfig>,
    ): Promise<Result<ClaudeSession, string>> {
      const fullConfig: ClaudeSessionConfig = {
        timeoutMs: 300_000,
        permissionMode: "bypassPermissions",
        ...config,
      };

      if (
        fullConfig.workingDir &&
        !fullConfig.workingDir.startsWith(options.workspacePath)
      ) {
        return Promise.resolve({
          ok: false as const,
          error:
            `Working directory "${fullConfig.workingDir}" is outside the workspace "${options.workspacePath}"`,
        });
      }

      const args = buildClaudeArgs(prompt, fullConfig, options.workspacePath);
      const cwd = fullConfig.workingDir ?? options.workspacePath;
      const spawnResult = spawnClaudeProcess(
        binary,
        args,
        cwd,
        buildClaudeEnv(),
      );
      if (!spawnResult.ok) return Promise.resolve(spawnResult);
      const process = spawnResult.value;

      const id = generateSessionId();
      const session: ClaudeSession = {
        id,
        pid: process.pid,
        status: "running",
        startedAt: new Date(),
        endedAt: null,
        config: fullConfig,
        exitCode: null,
      };

      const entry: SessionEntry = {
        session,
        process,
        stdinWriter: process.stdin.getWriter(),
        output: "",
        stderr: "",
        timeoutId: null,
      };

      (entry as { timeoutId: number | null }).timeoutId = setupSessionTimeout(
        entry,
        fullConfig.timeoutMs ?? 300_000,
      );
      startOutputReader(entry, process.stdout.getReader());
      drainStderr(entry, process.stderr.getReader());
      watchProcessExit(entry);
      sessions.set(id, entry);

      return Promise.resolve({ ok: true as const, value: session });
    },

    async send(
      sessionId: string,
      input: string,
    ): Promise<Result<string, string>> {
      const entry = sessions.get(sessionId);
      if (!entry) {
        return { ok: false, error: `Session not found: ${sessionId}` };
      }
      if (entry.session.status !== "running") {
        return {
          ok: false,
          error:
            `Session ${sessionId} is not running (status: ${entry.session.status})`,
        };
      }

      const outputBefore = entry.output.length;
      try {
        await entry.stdinWriter.write(encodeUserMessage(input));
      } catch (err) {
        return {
          ok: false,
          error: `Failed to write to session stdin: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }

      const newOutput = await pollForClaudeResponse(
        entry,
        outputBefore,
        60_000,
      );
      const parsed = parseStreamOutput(newOutput);
      return { ok: true, value: parsed || newOutput };
    },

    getOutput(sessionId: string): Result<string, string> {
      const entry = sessions.get(sessionId);
      if (!entry) {
        return { ok: false, error: `Session not found: ${sessionId}` };
      }
      const parsed = parseStreamOutput(entry.output);
      return { ok: true, value: parsed || entry.output };
    },

    status(sessionId: string): Result<ClaudeSession, string> {
      const entry = sessions.get(sessionId);
      if (!entry) {
        return { ok: false, error: `Session not found: ${sessionId}` };
      }
      return { ok: true, value: entry.session };
    },

    async stop(sessionId: string): Promise<Result<void, string>> {
      const entry = sessions.get(sessionId);
      if (!entry) {
        return { ok: false, error: `Session not found: ${sessionId}` };
      }
      if (entry.session.status !== "running") {
        return { ok: true, value: undefined };
      }
      await terminateClaudeSession(entry);
      return { ok: true, value: undefined };
    },

    list(): readonly ClaudeSession[] {
      return Array.from(sessions.values()).map((e) => e.session);
    },
  };
}
