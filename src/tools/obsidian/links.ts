/**
 * Wikilink resolution and backlink discovery.
 *
 * Resolves wikilinks using case-insensitive name matching across the vault.
 * When multiple matches exist, the shortest path wins.
 *
 * @module
 */

import { SEPARATOR } from "@std/path";
import type { Result } from "../../core/types/classification.ts";
import type { Backlink, WikilinkTarget } from "./types.ts";
import type { VaultContext } from "./vault.ts";
import { isExcluded, resolveVaultPath } from "./vault.ts";
import { extractWikilinks } from "./markdown.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("security");

/** Interface for link resolution operations. */
export interface LinkResolver {
  /** Resolve a wikilink to its target note path. */
  resolveWikilink(link: string): Promise<Result<WikilinkTarget, string>>;
  /** Find all notes that link to a given note name. */
  getBacklinks(noteName: string): Promise<Result<readonly Backlink[], string>>;
  /** Get all outgoing wikilinks from a note. */
  getOutlinks(
    notePath: string,
  ): Promise<Result<readonly WikilinkTarget[], string>>;
}

/** Find the shortest matching .md path for a wikilink target name. */
async function findShortestMatchingNote(
  ctx: VaultContext,
  targetName: string,
): Promise<string | null> {
  let bestMatch: string | null = null;

  for await (const entry of walkMdFiles(ctx)) {
    const relativePath = entry.path.substring(ctx.realVaultPath.length + 1);
    if (isExcluded(ctx, relativePath)) continue;

    const name = entry.name.replace(/\.md$/, "");
    if (name.toLowerCase() !== targetName) continue;

    if (bestMatch === null || relativePath.length < bestMatch.length) {
      bestMatch = relativePath;
    }
  }

  return bestMatch;
}

/** Resolve a wikilink to its target note path. */
async function resolveVaultWikilink(
  ctx: VaultContext,
  link: string,
): Promise<Result<WikilinkTarget, string>> {
  try {
    const resolvedPath = await findShortestMatchingNote(
      ctx,
      link.toLowerCase(),
    );
    return { ok: true, value: { link, resolvedPath } };
  } catch (err) {
    return {
      ok: false,
      error: `Wikilink resolution failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/** Collect backlink entries for a single source file. */
function collectBacklinksFromNote(
  entry: { name: string; path: string },
  relativePath: string,
  targetLower: string,
  wikilinks: readonly string[],
): Backlink | null {
  for (const wl of wikilinks) {
    if (wl.toLowerCase() === targetLower) {
      return {
        sourcePath: relativePath,
        sourceName: entry.name.replace(/\.md$/, ""),
        linkText: wl,
      };
    }
  }
  return null;
}

/** Scan all vault notes and collect backlinks to a target name. */
async function scanVaultForBacklinks(
  ctx: VaultContext,
  targetLower: string,
): Promise<Backlink[]> {
  const backlinks: Backlink[] = [];

  for await (const entry of walkMdFiles(ctx)) {
    const relativePath = entry.path.substring(ctx.realVaultPath.length + 1);
    if (isExcluded(ctx, relativePath)) continue;

    const content = await Deno.readTextFile(entry.path);
    const wikilinks = extractWikilinks(content);
    const backlink = collectBacklinksFromNote(
      entry,
      relativePath,
      targetLower,
      wikilinks,
    );
    if (backlink) backlinks.push(backlink);
  }

  return backlinks;
}

/** Find all notes that link to a given note name. */
async function findVaultBacklinks(
  ctx: VaultContext,
  noteName: string,
): Promise<Result<readonly Backlink[], string>> {
  try {
    const backlinks = await scanVaultForBacklinks(
      ctx,
      noteName.toLowerCase(),
    );
    return { ok: true, value: backlinks };
  } catch (err) {
    return {
      ok: false,
      error: `Backlink search failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/** Build a name-to-shortest-path index of all vault notes. */
async function buildVaultNoteIndex(
  ctx: VaultContext,
): Promise<Map<string, string>> {
  const noteIndex = new Map<string, string>();

  for await (const entry of walkMdFiles(ctx)) {
    const relativePath = entry.path.substring(ctx.realVaultPath.length + 1);
    if (isExcluded(ctx, relativePath)) continue;
    const name = entry.name.replace(/\.md$/, "").toLowerCase();
    const existing = noteIndex.get(name);
    if (!existing || relativePath.length < existing.length) {
      noteIndex.set(name, relativePath);
    }
  }

  return noteIndex;
}

/** Get all outgoing wikilinks from a note, resolved against the vault. */
async function findVaultOutlinks(
  ctx: VaultContext,
  notePath: string,
): Promise<Result<readonly WikilinkTarget[], string>> {
  const confined = await resolveVaultPath(ctx, notePath);
  if (!confined.ok) return confined;
  try {
    const content = await Deno.readTextFile(confined.value);
    const wikilinks = extractWikilinks(content);
    const noteIndex = await buildVaultNoteIndex(ctx);

    const targets: WikilinkTarget[] = wikilinks.map((link) => ({
      link,
      resolvedPath: noteIndex.get(link.toLowerCase()) ?? null,
    }));

    return { ok: true, value: targets };
  } catch (err) {
    return {
      ok: false,
      error: `Outlink extraction failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * Create a LinkResolver for the given vault context.
 */
export function createLinkResolver(ctx: VaultContext): LinkResolver {
  return {
    resolveWikilink(link: string) {
      return resolveVaultWikilink(ctx, link);
    },
    getBacklinks(noteName: string) {
      return findVaultBacklinks(ctx, noteName);
    },
    getOutlinks(notePath: string) {
      return findVaultOutlinks(ctx, notePath);
    },
  };
}

/** Recursively walk .md files in the vault, asserting vault confinement. */
async function* walkMdFiles(
  ctx: VaultContext,
): AsyncGenerator<{ name: string; path: string }> {
  yield* walkMdDir(ctx, ctx.realVaultPath);
}

/** Walk one directory level, yielding only entries inside the vault. */
async function* walkMdDir(
  ctx: VaultContext,
  dirPath: string,
): AsyncGenerator<{ name: string; path: string }> {
  try {
    for await (const entry of Deno.readDir(dirPath)) {
      const fullPath = `${dirPath}/${entry.name}`;
      if (entry.isDirectory) {
        yield* walkMdDir(ctx, fullPath);
      } else if (entry.isFile && entry.name.endsWith(".md")) {
        if (!fullPath.startsWith(ctx.realVaultPath + SEPARATOR)) {
          log.warn("Obsidian walk entry escapes vault boundary", {
            operation: "walkMdFiles",
            entryPath: fullPath,
          });
          continue;
        }
        yield { name: entry.name, path: fullPath };
      }
    }
  } catch {
    // Skip directories we can't read
  }
}
