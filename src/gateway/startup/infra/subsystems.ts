/**
 * Subsystem setup helpers for gateway startup.
 *
 * Extracts larger setup blocks from the monolithic runStart() function
 * into focused helper functions: Obsidian vault, skill discovery, and
 * the CLI secret prompt callback.
 *
 * @module
 */

import { join } from "@std/path";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { SessionId } from "../../../core/types/session.ts";
import type {
  CredentialPromptCallback,
  SecretPromptCallback,
} from "../../../tools/secrets.ts";
import {
  createDailyNoteManager,
  createLinkResolver,
  createNoteStore,
  createObsidianToolExecutor,
  createVaultContext,
} from "../../../tools/obsidian/mod.ts";
import { createSkillLoader } from "../../../tools/skills/loader.ts";
import { createSkillDraftApprovals } from "../../../tools/skills/draft_approvals.ts";
import type { Skill, SkillLoader } from "../../../tools/skills/loader.ts";
import { createLogger } from "../../../core/logger/mod.ts";

const log = createLogger("startup-subsystems");

// ─── Obsidian vault setup ────────────────────────────────────────────────────

/** Obsidian plugin configuration from triggerfish.yaml. */
export interface ObsidianPluginConfig {
  readonly enabled?: boolean;
  readonly vault_path?: string;
  readonly classification?: string;
  readonly daily_notes?: {
    readonly folder?: string;
    readonly date_format?: string;
    readonly template?: string;
  };
  readonly exclude_folders?: readonly string[];
  readonly folder_classifications?: Readonly<Record<string, string>>;
}

/**
 * Build the Obsidian vault tool executor from config.
 *
 * Returns the executor function or undefined if Obsidian is not configured
 * or the vault cannot be opened.
 */
export async function buildObsidianExecutor(
  obsConfig: ObsidianPluginConfig,
  getSessionTaint: () => ClassificationLevel,
  sessionId: SessionId,
): Promise<
  | ((name: string, input: Record<string, unknown>) => Promise<string | null>)
  | undefined
> {
  if (!obsConfig.enabled || !obsConfig.vault_path) return undefined;

  const vaultResult = await createVaultContext({
    vaultPath: obsConfig.vault_path,
    classification:
      (obsConfig.classification ?? "INTERNAL") as ClassificationLevel,
    dailyNotes: obsConfig.daily_notes
      ? {
        folder: obsConfig.daily_notes.folder ?? "daily",
        dateFormat: obsConfig.daily_notes.date_format ?? "YYYY-MM-DD",
        template: obsConfig.daily_notes.template,
      }
      : undefined,
    excludeFolders: obsConfig.exclude_folders as string[] | undefined,
    folderClassifications: obsConfig.folder_classifications as
      | Record<string, ClassificationLevel>
      | undefined,
  });

  if (!vaultResult.ok) {
    log.error(`Obsidian vault error: ${vaultResult.error}`);
    return undefined;
  }

  const noteStore = createNoteStore(vaultResult.value);
  const executor = createObsidianToolExecutor({
    vaultContext: vaultResult.value,
    noteStore,
    dailyNoteManager: createDailyNoteManager(vaultResult.value, noteStore),
    linkResolver: createLinkResolver(vaultResult.value),
    getSessionTaint,
    sessionId,
  });

  log.info(`Obsidian vault connected: ${obsConfig.vault_path}`);
  return executor;
}

// ─── Skill discovery ─────────────────────────────────────────────────────────

/** Result from discoverSkills. */
export interface SkillDiscoveryResult {
  readonly skills: readonly Skill[];
  readonly loader: SkillLoader;
}

/**
 * Discover skills from bundled, managed, and workspace directories.
 *
 * Returns the discovered skills and the loader instance (needed for
 * the healthcheck and skill tool executors).
 */
export async function discoverSkills(
  baseDir: string,
): Promise<SkillDiscoveryResult> {
  const bundledSkillsDir = join(
    import.meta.dirname ?? ".",
    "..",
    "..",
    "..",
    "skills",
    "bundled",
  );
  const managedSkillsDir = join(baseDir, "skills");
  const workspaceSkillsDir = join(baseDir, "workspaces", "main", "skills");
  const loader = createSkillLoader({
    draftApprovals: {
      workspace: workspaceSkillsDir,
      registry: createSkillDraftApprovals(join(baseDir, "skill-approvals.db")),
    },
    directories: [bundledSkillsDir, managedSkillsDir, workspaceSkillsDir],
    dirTypes: {
      [bundledSkillsDir]: "bundled",
      [managedSkillsDir]: "managed",
      [workspaceSkillsDir]: "workspace",
    },
  });

  let skills: readonly Skill[] = [];
  try {
    skills = await loader.discover();
    if (skills.length > 0) {
      log.info(`Discovered ${skills.length} skill(s)`);
    }
  } catch {
    // Skill discovery failure is non-fatal
  }

  return { skills, loader };
}

// ─── CLI secret prompt ───────────────────────────────────────────────────────

/** Write a string to stderr (visible even when stdout is piped). */
function writeStderr(text: string): void {
  Deno.stderr.writeSync(new TextEncoder().encode(text));
}

/** Build the prompt text for a secret input request. */
function buildSecretPromptText(name: string, hint?: string): string {
  return hint
    ? `Enter value for '${name}' (${hint}): `
    : `Enter value for '${name}': `;
}

/** Enable or disable raw mode on stdin, ignoring errors (non-TTY). */
function setStdinRawMode(enabled: boolean): void {
  try {
    Deno.stdin.setRaw(enabled);
  } catch { /* Non-TTY environments may not support raw mode */ }
}

/** Read bytes from stdin in raw mode until Enter or EOF. Returns null on Ctrl-C. */
async function readSecretBytes(): Promise<number[] | null> {
  const chars: number[] = [];
  const buf = new Uint8Array(1);
  while (true) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;
    const byte = buf[0];
    if (byte === 13 || byte === 10) break;
    if (byte === 3) return null;
    if (byte === 127 || byte === 8) {
      if (chars.length > 0) chars.pop();
    } else {
      chars.push(byte);
    }
  }
  return chars;
}

/**
 * Create the CLI secret prompt callback.
 *
 * Reads a secret value from the terminal with echo suppressed via raw mode.
 * The prompt writes to stderr so it shows on terminal even when stdout is piped.
 * The entered value never appears in logs or LLM context.
 */
export function createCliSecretPrompt(): SecretPromptCallback {
  return async (name: string, hint?: string): Promise<string | null> => {
    writeStderr(buildSecretPromptText(name, hint));
    setStdinRawMode(true);
    try {
      const chars = await readSecretBytes();
      if (chars === null) {
        writeStderr("\n");
        return null;
      }
      return new TextDecoder().decode(new Uint8Array(chars));
    } finally {
      setStdinRawMode(false);
      writeStderr("\n");
    }
  };
}

// ─── CLI credential prompt ──────────────────────────────────────────────────

/** Build the prompt text for a credential username input. */
function buildUsernamePromptText(name: string, hint?: string): string {
  return hint
    ? `Enter username for '${name}' (${hint}): `
    : `Enter username for '${name}': `;
}

/** Build the prompt text for a credential password input. */
function buildPasswordPromptText(name: string): string {
  return `Enter password for '${name}': `;
}

/** Read a line from stdin with echo (no raw mode). Returns null on Ctrl-C. */
async function readVisibleLine(): Promise<string | null> {
  setStdinRawMode(true);
  try {
    const chars: number[] = [];
    const buf = new Uint8Array(1);
    while (true) {
      const n = await Deno.stdin.read(buf);
      if (n === null) break;
      const byte = buf[0];
      if (byte === 13 || byte === 10) break;
      if (byte === 3) return null;
      if (byte === 127 || byte === 8) {
        if (chars.length > 0) {
          chars.pop();
          writeStderr("\b \b");
        }
      } else {
        chars.push(byte);
        writeStderr(String.fromCharCode(byte));
      }
    }
    return new TextDecoder().decode(new Uint8Array(chars));
  } finally {
    setStdinRawMode(false);
    writeStderr("\n");
  }
}

/**
 * Create the CLI credential prompt callback.
 *
 * Prompts for username (echoed) then password (hidden) from the terminal.
 * Both prompts write to stderr so they show even when stdout is piped.
 * The entered values never appear in logs or LLM context.
 */
export function createCliCredentialPrompt(): CredentialPromptCallback {
  return async (
    name: string,
    hint?: string,
  ): Promise<
    { readonly username: string; readonly password: string } | null
  > => {
    // Phase 1: username (echoed)
    writeStderr(buildUsernamePromptText(name, hint));
    const username = await readVisibleLine();
    if (username === null) return null;

    // Phase 2: password (hidden, same as secret prompt)
    writeStderr(buildPasswordPromptText(name));
    setStdinRawMode(true);
    try {
      const chars = await readSecretBytes();
      if (chars === null) {
        writeStderr("\n");
        return null;
      }
      const password = new TextDecoder().decode(new Uint8Array(chars));
      return { username, password };
    } finally {
      setStdinRawMode(false);
      writeStderr("\n");
    }
  };
}

// ─── CLI confirm prompt ──────────────────────────────────────────────────────

/**
 * Create the CLI confirm prompt callback.
 *
 * Shows a [y/N] prompt on stderr and reads a single keypress.
 * Returns true for 'y'/'Y', false for anything else.
 */
export function createCliConfirmPrompt(): (
  message: string,
) => Promise<boolean> {
  return async (message: string): Promise<boolean> => {
    writeStderr(`${message} [y/N] `);
    setStdinRawMode(true);
    try {
      const buf = new Uint8Array(1);
      const n = await Deno.stdin.read(buf);
      if (n === null) return false;
      const char = String.fromCharCode(buf[0]);
      return char === "y" || char === "Y";
    } finally {
      setStdinRawMode(false);
      writeStderr("\n");
    }
  };
}
