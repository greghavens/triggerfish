/**
 * Obsidian read and write tool handlers — classification-gated note access.
 *
 * Implements the obsidian_read and obsidian_write operations with full
 * classification enforcement and lineage recording.
 *
 * @module
 */

import type { ClassificationLevel } from "../../../core/types/classification.ts";
import { canFlowTo } from "../../../core/types/classification.ts";
import type {
  LineageClassification,
  LineageOrigin,
} from "../../../core/session/lineage.ts";
import { resolveClassificationForPath } from "../vault.ts";
import { createLogger } from "../../../core/logger/logger.ts";
import type { ObsidianToolContext } from "./tools_defs.ts";

const log = createLogger("security");

/** Convert a note name to a vault-relative path. */
export function resolveNotePath(name: string): string {
  if (name.endsWith(".md")) return name;
  if (name.includes("/")) return name + ".md";
  return name + ".md";
}

/** Record a lineage entry for an obsidian operation. */
export async function recordLineage(
  ctx: ObsidianToolContext,
  notePath: string,
  noteContent: string,
  classification: ClassificationLevel,
  operation: string,
): Promise<void> {
  if (!ctx.lineageStore) return;

  const origin: LineageOrigin = {
    source_type: "obsidian_vault",
    source_name: notePath,
    accessed_at: new Date().toISOString(),
    accessed_by: ctx.sessionId as string,
    access_method: `obsidian_${operation}`,
  };

  const lineageClassification: LineageClassification = {
    level: classification,
    reason: `Obsidian vault ${operation}: ${notePath}`,
  };

  try {
    await ctx.lineageStore.create({
      content: noteContent,
      origin,
      classification: lineageClassification,
      sessionId: ctx.sessionId,
    });
  } catch {
    // Lineage failure should not block the operation
  }
}

/** Execute the obsidian_read tool — read a note with classification gating. */
export async function readObsidianNote(
  ctx: ObsidianToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const noteName = input.name;
  if (typeof noteName !== "string" || noteName.length === 0) {
    return "Error: obsidian_read requires a 'name' argument (non-empty string).";
  }

  const notePath = resolveNotePath(noteName);

  const noteClassification = resolveClassificationForPath(
    ctx.vaultContext,
    notePath,
  );
  if (!canFlowTo(noteClassification, ctx.getSessionTaint())) {
    log.warn("Obsidian read blocked: classification exceeds session taint", {
      notePath,
      noteClassification,
      sessionTaint: ctx.getSessionTaint(),
    });
    return `Error: Access denied — note classification ${noteClassification} exceeds session level ${ctx.getSessionTaint()}.`;
  }

  const result = await ctx.noteStore.read(notePath);
  if (!result.ok) return `Error: ${result.error}`;

  if (ctx.lineageStore) {
    await recordLineage(
      ctx,
      notePath,
      result.value.content,
      noteClassification,
      "read",
    );
  }

  return JSON.stringify({
    path: result.value.path,
    name: result.value.name,
    content: result.value.content,
    frontmatter: result.value.frontmatter,
    tags: result.value.tags,
    wikilinks: result.value.wikilinks,
    headings: result.value.headings,
  });
}

/** Execute the obsidian_write tool — write a note with write-down prevention. */
export async function writeObsidianNote(
  ctx: ObsidianToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const noteName = input.name;
  if (typeof noteName !== "string" || noteName.length === 0) {
    return "Error: obsidian_write requires a 'name' argument (non-empty string).";
  }

  const folder = typeof input.folder === "string" ? input.folder : undefined;
  const notePath = folder
    ? `${folder}/${resolveNotePath(noteName)}`
    : resolveNotePath(noteName);

  const folderClassification = resolveClassificationForPath(
    ctx.vaultContext,
    notePath,
  );
  if (!canFlowTo(ctx.getSessionTaint(), folderClassification)) {
    log.warn("Obsidian write-down blocked", {
      notePath,
      sessionTaint: ctx.getSessionTaint(),
      folderClassification,
    });
    return `Error: Write-down prevented — session taint ${ctx.getSessionTaint()} cannot write to folder classified ${folderClassification}.`;
  }

  const content = typeof input.content === "string" ? input.content : undefined;
  const append = typeof input.append === "string" ? input.append : undefined;
  const prepend = typeof input.prepend === "string" ? input.prepend : undefined;
  const template = typeof input.template === "string"
    ? input.template
    : undefined;
  const frontmatter =
    (input.frontmatter && typeof input.frontmatter === "object" &&
        !Array.isArray(input.frontmatter))
      ? input.frontmatter as Record<string, unknown>
      : undefined;

  const existing = await ctx.noteStore.read(notePath);
  let result;
  if (existing.ok) {
    result = await ctx.noteStore.update({
      path: notePath,
      content,
      append,
      prepend,
      frontmatter,
    });
  } else {
    result = await ctx.noteStore.create({
      path: notePath,
      content: content ?? "",
      frontmatter,
      template,
    });
  }

  if (!result.ok) return `Error: ${result.error}`;

  if (ctx.lineageStore) {
    const writeContent = content ?? append ?? prepend ?? "";
    await recordLineage(
      ctx,
      notePath,
      writeContent,
      folderClassification,
      "write",
    );
  }

  return JSON.stringify({
    written: true,
    path: result.value.path,
    name: result.value.name,
  });
}

/** @deprecated Use readObsidianNote instead */
export const executeObsidianRead = readObsidianNote;
/** @deprecated Use writeObsidianNote instead */
export const executeObsidianWrite = writeObsidianNote;
