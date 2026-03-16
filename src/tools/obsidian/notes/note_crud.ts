/**
 * Note CRUD operations — read, create, update a single note.
 *
 * All paths are validated through {@link resolveVaultPath} for confinement.
 * Excluded folders are rejected automatically.
 *
 * @module
 */

import type { Result } from "../../../core/types/classification.ts";
import type {
  NoteCreateOptions,
  NoteUpdateOptions,
  ObsidianNote,
} from "../types.ts";
import type { VaultContext } from "../vault.ts";
import { isExcluded, resolveVaultPath } from "../vault.ts";
import {
  buildNote,
  mergeFrontmatter,
  parseFrontmatter,
  serializeFrontmatter,
} from "../markdown.ts";

/** Ensure a path ends with .md */
export function ensureMdExtension(path: string): string {
  return path.endsWith(".md") ? path : path + ".md";
}

/** Read a note file from the vault, returning the parsed note. */
export async function readNoteFromVault(
  ctx: VaultContext,
  path: string,
): Promise<Result<ObsidianNote, string>> {
  if (isExcluded(ctx, path)) {
    return { ok: false, error: `Path is excluded: ${path}` };
  }
  const resolved = await resolveVaultPath(ctx, path);
  if (!resolved.ok) return resolved;
  return readAndParseNote(resolved.value, path);
}

/** Read file content and stat, then build a parsed note. */
async function readAndParseNote(
  absolutePath: string,
  relativePath: string,
): Promise<Result<ObsidianNote, string>> {
  try {
    const content = await Deno.readTextFile(absolutePath);
    const stat = await Deno.stat(absolutePath);
    return {
      ok: true,
      value: buildNote(relativePath, content, {
        mtime: stat.mtime,
        birthtime: stat.birthtime,
      }),
    };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to read note: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/** Read a template file from the vault. */
async function readTemplate(
  ctx: VaultContext,
  templatePath: string,
): Promise<Result<string, string>> {
  const resolved = await resolveVaultPath(ctx, templatePath);
  if (!resolved.ok) return resolved;

  try {
    return { ok: true, value: await Deno.readTextFile(resolved.value) };
  } catch (err) {
    return {
      ok: false,
      error: `Template not found: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/** Resolve note content from template or direct content, applying frontmatter. */
async function resolveNoteContent(
  ctx: VaultContext,
  options: NoteCreateOptions,
): Promise<Result<string, string>> {
  let content: string;
  if (options.template) {
    const templateResult = await readTemplate(ctx, options.template);
    if (!templateResult.ok) return templateResult;
    content = templateResult.value;
  } else {
    content = options.content;
  }
  if (options.frontmatter && Object.keys(options.frontmatter).length > 0) {
    const { data, body } = parseFrontmatter(content);
    content = serializeFrontmatter(
      mergeFrontmatter(data, options.frontmatter),
      body,
    );
  }
  return { ok: true, value: content };
}

/** Create a new note in the vault. */
export async function createNoteInVault(
  ctx: VaultContext,
  options: NoteCreateOptions,
): Promise<Result<ObsidianNote, string>> {
  const notePath = ensureMdExtension(options.path);
  if (isExcluded(ctx, notePath)) {
    return { ok: false, error: `Path is excluded: ${notePath}` };
  }
  const resolved = await resolveVaultPath(ctx, notePath);
  if (!resolved.ok) return resolved;
  const existsResult = await assertNoteDoesNotExist(resolved.value, notePath);
  if (!existsResult.ok) return existsResult;
  const contentResult = await resolveNoteContent(ctx, options);
  if (!contentResult.ok) return contentResult;
  return writeNewNote(resolved.value, notePath, contentResult.value);
}

/** Assert that a note file does not already exist. */
async function assertNoteDoesNotExist(
  absolutePath: string,
  notePath: string,
): Promise<Result<void, string>> {
  try {
    await Deno.stat(absolutePath);
    return { ok: false, error: `Note already exists: ${notePath}` };
  } catch {
    return { ok: true, value: undefined };
  }
}

/** Write a new note file, creating parent directories as needed. */
async function writeNewNote(
  absolutePath: string,
  notePath: string,
  content: string,
): Promise<Result<ObsidianNote, string>> {
  const parentDir = absolutePath.substring(0, absolutePath.lastIndexOf("/"));
  try {
    await Deno.mkdir(parentDir, { recursive: true });
  } catch { /* Directory may already exist */ }
  try {
    await Deno.writeTextFile(absolutePath, content, { createNew: true });
    const stat = await Deno.stat(absolutePath);
    return {
      ok: true,
      value: buildNote(notePath, content, {
        mtime: stat.mtime,
        birthtime: stat.birthtime,
      }),
    };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to create note: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/** Apply content changes (replace, prepend, append) and frontmatter to existing note content. */
export function applyNoteContentUpdates(
  existingContent: string,
  options: NoteUpdateOptions,
): string {
  let { data, body } = parseFrontmatter(existingContent);
  if (options.frontmatter) {
    data = mergeFrontmatter(data, options.frontmatter);
  }
  if (options.content !== undefined) body = options.content;
  if (options.prepend) body = options.prepend + "\n" + body;
  if (options.append) body = body.trimEnd() + "\n" + options.append + "\n";
  return serializeFrontmatter(data, body);
}

/** Update an existing note in the vault. */
export async function persistNoteToVault(
  ctx: VaultContext,
  options: NoteUpdateOptions,
): Promise<Result<ObsidianNote, string>> {
  if (isExcluded(ctx, options.path)) {
    return { ok: false, error: `Path is excluded: ${options.path}` };
  }
  const resolved = await resolveVaultPath(ctx, options.path);
  if (!resolved.ok) return resolved;
  const existingResult = await readExistingContent(resolved.value);
  if (!existingResult.ok) return existingResult;
  const finalContent = applyNoteContentUpdates(existingResult.value, options);
  return writeUpdatedNote(resolved.value, options.path, finalContent);
}

/** Read existing file content for an update operation. */
async function readExistingContent(
  absolutePath: string,
): Promise<Result<string, string>> {
  try {
    return { ok: true, value: await Deno.readTextFile(absolutePath) };
  } catch (err) {
    return {
      ok: false,
      error: `Note not found: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/** Write updated content to an existing note file. */
async function writeUpdatedNote(
  absolutePath: string,
  notePath: string,
  content: string,
): Promise<Result<ObsidianNote, string>> {
  try {
    await Deno.writeTextFile(absolutePath, content);
    const stat = await Deno.stat(absolutePath);
    return {
      ok: true,
      value: buildNote(notePath, content, {
        mtime: stat.mtime,
        birthtime: stat.birthtime,
      }),
    };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to update note: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/** @deprecated Use persistNoteToVault instead */
export const updateNoteInVault = persistNoteToVault;
