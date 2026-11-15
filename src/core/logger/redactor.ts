/**
 * Secret-redaction backstop for structured log arguments.
 *
 * Deep-walks the structured args passed to the logger and masks values
 * that look like credentials: values under secret-shaped keys (apiKey,
 * token, authorization, …) and bearer-like credential strings anywhere
 * in string values. This complements — never replaces — per-call-site
 * discipline about what gets logged.
 *
 * The audit log (`audit.ts`) intentionally bypasses this: it captures
 * raw forensic content and is never read by LLM-facing tools.
 *
 * @module
 */

/** Keys whose values are masked wholesale (case-insensitive). */
const SECRET_KEY_PATTERN =
  /secret|token|password|api[_-]?key|authorization|cookie|credential|client_token|secret_id|license[_-]?key|private[_-]?key/i;

/**
 * Credential-shaped substrings masked inside any string value:
 * Bearer/Basic auth headers, common API-key prefixes (sk-, xox*-, gh*_,
 * AKIA), and JWT triplets. Deliberately conservative so ordinary log
 * text is never mangled.
 */
const CREDENTIAL_TEXT_PATTERN =
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/._=-]{8,}|\bsk-[A-Za-z0-9_-]{16,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/;

/** Global twin of CREDENTIAL_TEXT_PATTERN for replacement passes. */
const CREDENTIAL_TEXT_PATTERN_GLOBAL = new RegExp(
  CREDENTIAL_TEXT_PATTERN.source,
  "g",
);

/** Replacement marker for masked values. */
const MASK = "[REDACTED]";

/** Maximum object depth walked before the subtree is dropped. */
const MAX_REDACTION_DEPTH = 8;

/** Mask credential-shaped substrings in a string (no-op when clean). */
export function redactCredentialText(text: string): string {
  // test() first keeps the hot path allocation-free for ordinary strings.
  if (!CREDENTIAL_TEXT_PATTERN.test(text)) return text;
  return text.replace(CREDENTIAL_TEXT_PATTERN_GLOBAL, MASK);
}

/** True when a key looks like it holds credential material. */
function isSecretShapedKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/** Walk one object, masking values under secret-shaped keys. */
function redactObjectEntries(
  obj: Record<string, unknown>,
  depth: number,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    // Numbers/booleans under secret-shaped keys stay (tokenCount etc.);
    // strings, objects, and arrays are masked wholesale.
    const maskable = typeof value === "string" ||
      (typeof value === "object" && value !== null);
    out[key] = isSecretShapedKey(key) && maskable
      ? MASK
      : walkRedaction(value, depth + 1, seen);
  }
  return out;
}

/** Recursive redaction step with cycle protection and a depth cap. */
function walkRedaction(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return redactCredentialText(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_REDACTION_DEPTH) return "[max-depth]";
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => walkRedaction(item, depth + 1, seen))
    : redactObjectEntries(value as Record<string, unknown>, depth, seen);
  // Track only the current path so shared (non-cyclic) references serialize.
  seen.delete(value);
  return result;
}

/**
 * Redact secret-shaped material from one structured log argument.
 *
 * Returns the argument unchanged when there is nothing to mask;
 * otherwise returns a new structure with masked values. Cycles are
 * replaced with "[circular]" and subtrees beyond the depth cap with
 * "[max-depth]" so unredacted material can never slip past the walk.
 */
export function redactSecretValue(value: unknown): unknown {
  if (typeof value === "string") return redactCredentialText(value);
  if (value === null || typeof value !== "object") return value;
  return walkRedaction(value, 0, new WeakSet<object>());
}
