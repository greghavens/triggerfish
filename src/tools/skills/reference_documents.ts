/** Documents embedded in the exact, reviewed workspace skill digest. */

export interface SkillReferenceDocument {
  readonly path: string;
  readonly content: string;
}

export function validSkillReferencePath(path: unknown): path is string {
  return typeof path === "string" && path.length <= 180 &&
    /^references\/(?:[a-z0-9][a-z0-9_-]{0,47}\/){0,2}[a-z0-9][a-z0-9_-]{0,47}\.(?:md|txt)$/
      .test(path);
}

/** Accept only bounded UTF-8 text and unique virtual paths. */
export function parseSkillReferences(
  value: unknown,
): readonly SkillReferenceDocument[] | undefined {
  if (!Array.isArray(value) || value.length > 12) return;
  const paths = new Set<string>();
  const documents: SkillReferenceDocument[] = [];
  const encoder = new TextEncoder();
  let size = 0;
  for (const entry of value) {
    if (
      !entry || typeof entry !== "object" || Array.isArray(entry) ||
      Object.keys(entry).length !== 2 ||
      !Object.hasOwn(entry, "path") || !Object.hasOwn(entry, "content") ||
      !validSkillReferencePath(entry.path) || paths.has(entry.path) ||
      typeof entry.content !== "string" || !entry.content.trim() ||
      /\p{Cc}/u.test(entry.content.replace(/[\r\n\t]/g, ""))
    ) return;
    const bytes = encoder.encode(entry.content).length;
    size += bytes;
    if (bytes > 8_192 || size > 20_480) return;
    paths.add(entry.path);
    documents.push({ path: entry.path, content: entry.content });
  }
  return documents;
}
