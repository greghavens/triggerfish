/**
 * Shell command path extraction and classification.
 *
 * Parses file/directory paths from opaque shell command strings so that
 * `run_command` can participate in resource classification, taint
 * escalation, and write-down prevention.
 *
 * @module
 */

import { resolve } from "@std/path";
import type { ClassificationLevel } from "../types/classification.ts";
import { maxClassification } from "../types/classification.ts";
import type { PathClassifier } from "./path_classification.ts";
import { expandTilde } from "./path_classification.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Result of classifying paths extracted from a shell command. */
export interface CommandClassificationResult {
  readonly classification: ClassificationLevel;
  readonly resolvedPaths: readonly string[];
}

// ─── Shell operator splitting ────────────────────────────────────────────────

/**
 * Split a command string on shell operators (`|`, `;`, `&&`, `||`),
 * respecting single and double quoted regions.
 */
export function splitOnShellOperators(command: string): readonly string[] {
  const segments: string[] = [];
  const state = { inSingle: false, inDouble: false, substDepth: 0 };
  let current = "";
  let i = 0;

  while (i < command.length) {
    const ch = command[i];
    const consumed = consumeNonOperatorChar(command, i, state);
    if (consumed !== null) {
      current += consumed.text;
      i += consumed.width;
      continue;
    }
    if (!isInQuotedOrSubst(state)) {
      const op = matchSplitOperator(command, i);
      if (op > 0) {
        segments.push(current);
        current = "";
        i += op;
        continue;
      }
    }
    current += ch;
    i++;
  }

  segments.push(current);
  return segments;
}

/** Quote/substitution tracking state for the operator splitter. */
interface SplitState {
  inSingle: boolean;
  inDouble: boolean;
  substDepth: number;
}

/** True while inside quotes or a command-substitution span. */
function isInQuotedOrSubst(state: SplitState): boolean {
  return state.inSingle || state.inDouble || state.substDepth > 0;
}

/**
 * Consume a quote, escape, or substitution-boundary character, mutating the
 * tracking state. Returns the literal text to append and its width, or null
 * when the character is an ordinary one the caller must handle.
 */
function consumeNonOperatorChar(
  command: string,
  i: number,
  state: SplitState,
): { text: string; width: number } | null {
  const ch = command[i];
  if (ch === "'" && !state.inDouble) {
    state.inSingle = !state.inSingle;
    return { text: ch, width: 1 };
  }
  if (ch === '"' && !state.inSingle) {
    state.inDouble = !state.inDouble;
    return { text: ch, width: 1 };
  }
  if (ch === "\\" && !state.inSingle && i + 1 < command.length) {
    return { text: ch + command[i + 1], width: 2 };
  }
  return consumeSubstBoundary(command, i, state);
}

/** Track `$( … )` nesting depth so operators inside do not split a segment. */
function consumeSubstBoundary(
  command: string,
  i: number,
  state: SplitState,
): { text: string; width: number } | null {
  if (state.inSingle || state.inDouble) return null;
  if (command[i] === "$" && command[i + 1] === "(") {
    state.substDepth++;
    return { text: "$(", width: 2 };
  }
  if (command[i] === ")" && state.substDepth > 0) {
    state.substDepth--;
    return { text: ")", width: 1 };
  }
  return null;
}

/** Return the width of a split operator at position i, or 0 if none. */
function matchSplitOperator(command: string, i: number): number {
  if (isTwoCharOperator(command, i)) return 2;
  if (isSingleCharOperator(command[i])) return 1;
  return 0;
}

/** Check for `&&` or `||` at position i. */
function isTwoCharOperator(command: string, i: number): boolean {
  const pair = command.slice(i, i + 2);
  return pair === "&&" || pair === "||";
}

/** Check for `|` or `;` (single-char operators). */
function isSingleCharOperator(ch: string): boolean {
  return ch === "|" || ch === ";";
}

// ─── Token-level parsing ─────────────────────────────────────────────────────

/** Redirect operator prefixes that indicate the next token is a file path. */
const REDIRECT_OPERATORS: ReadonlySet<string> = new Set([
  ">",
  ">>",
  "<",
  "<<",
  "2>",
  "2>>",
  "&>",
]);

/**
 * Trailing shell metacharacters that leak into extracted tokens when an
 * operator abuts a path without surrounding whitespace (e.g. `cat /etc/shadow)`
 * inside a `$( … )` span). Stripping them prevents a real path like
 * `/etc/shadow)` from failing path-likeness checks and silently downgrading.
 */
const TRAILING_METACHARS = /[)`;&|]+$/;

/** Remove trailing shell metacharacters from an extracted path token. */
function stripTrailingMetachars(token: string): string {
  return token.replace(TRAILING_METACHARS, "");
}

/**
 * Tokenize a subcommand on whitespace, respecting single/double quotes
 * and backslash escapes. Strips surrounding quotes from tokens.
 */
function tokenizeRespectingQuotes(segment: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < segment.length) {
    const ch = segment[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      i++;
      continue;
    }
    if (ch === "\\" && !inSingle && i + 1 < segment.length) {
      current += segment[i + 1];
      i += 2;
      continue;
    }

    if (!inSingle && !inDouble && isWhitespace(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/** Whitespace test for ASCII space and tab. */
function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t";
}

// ─── Path detection ──────────────────────────────────────────────────────────

/** Windows drive letter prefix pattern: `C:\`, `D:/`, etc. */
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[/\\]/;

/**
 * Determine whether a token looks like a filesystem path.
 *
 * YES:
 * - Starts with `/` (absolute Unix)
 * - Starts with `./`, `../`, or `~`
 * - Starts with a Windows drive letter (`C:\`, `D:/`)
 * - Contains `/` or `\`, does not start with `-`, does not contain `://`
 *
 * NO:
 * - Starts with `-` (flags)
 * - Contains `://` (URLs)
 * - Pure word with no path separators
 */
function isPathLikeToken(token: string): boolean {
  if (token.length === 0) return false;
  if (token.startsWith("-")) return false;
  if (token.includes("://")) return false;
  if (token === "." || token === "..") return true;
  if (token.startsWith("/")) return true;
  if (token.startsWith("./") || token.startsWith("../")) return true;
  if (token === "~" || token.startsWith("~/") || token.startsWith("~\\")) {
    return true;
  }
  if (WINDOWS_DRIVE_RE.test(token)) return true;
  if (
    (token.includes("/") || token.includes("\\")) && !token.startsWith("-")
  ) {
    return true;
  }
  return false;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract filesystem paths from a shell command string.
 *
 * Splits on shell operators, tokenizes each subcommand respecting quotes,
 * identifies redirect targets and path-like tokens, and returns a
 * deduplicated list.
 */
export function extractCommandPaths(command: string): readonly string[] {
  const segments = splitOnShellOperators(command);
  const paths = new Set<string>();

  for (const segment of segments) {
    const tokens = tokenizeRespectingQuotes(segment);
    collectPathsFromTokens(tokens, paths);
    for (const inner of extractSubstitutionSpans(segment)) {
      for (const path of extractCommandPaths(inner)) {
        paths.add(path);
      }
    }
  }

  return [...paths];
}

/**
 * Extract the inner command text of every `$( … )` and backtick span.
 *
 * Command substitutions execute their contents as a subcommand, so any path
 * they reference (`cat $(echo /etc/shadow)`) is a real resource access that
 * must be classified. Returns the inner text for each span so the caller can
 * recurse. Nested `$( … )` are matched by depth; backticks are paired.
 */
export function extractSubstitutionSpans(segment: string): readonly string[] {
  const spans: string[] = [];
  collectDollarParenSpans(segment, spans);
  collectBacktickSpans(segment, spans);
  return spans;
}

/** Collect inner text of `$( … )` spans, honoring nested parentheses. */
function collectDollarParenSpans(segment: string, spans: string[]): void {
  let i = 0;
  while (i < segment.length) {
    if (segment[i] === "$" && segment[i + 1] === "(") {
      const inner = readBalancedParen(segment, i + 2);
      if (inner === null) return;
      spans.push(inner.text);
      i = inner.end;
      continue;
    }
    i++;
  }
}

/** Read a parenthesized span starting after `$(`; returns inner text + end. */
function readBalancedParen(
  segment: string,
  start: number,
): { text: string; end: number } | null {
  let depth = 1;
  let i = start;
  while (i < segment.length) {
    const ch = segment[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { text: segment.slice(start, i), end: i + 1 };
    }
    i++;
  }
  return null;
}

/** Collect inner text of paired backtick spans. */
function collectBacktickSpans(segment: string, spans: string[]): void {
  let i = 0;
  while (i < segment.length) {
    if (segment[i] === "`") {
      const close = segment.indexOf("`", i + 1);
      if (close === -1) return;
      spans.push(segment.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    i++;
  }
}

/** Walk tokens, marking redirect targets and filtering path-like tokens. */
function collectPathsFromTokens(
  tokens: readonly string[],
  paths: Set<string>,
): void {
  let expectRedirectTarget = false;

  for (const token of tokens) {
    if (expectRedirectTarget) {
      addPath(stripTrailingMetachars(token), paths);
      expectRedirectTarget = false;
      continue;
    }
    if (REDIRECT_OPERATORS.has(token)) {
      expectRedirectTarget = true;
      continue;
    }
    // Handle attached redirect: `>output.txt`, `2>/dev/null`, `xxd</etc/shadow`.
    // Redirect targets are file paths by definition, even bare filenames.
    const attached = extractAttachedRedirectTarget(token);
    if (attached !== null) {
      addPath(stripTrailingMetachars(attached), paths);
      continue;
    }
    addIfPathLike(stripTrailingMetachars(token), paths);
  }
}

/** Add a non-empty token to the set unconditionally (redirect targets). */
function addPath(token: string, paths: Set<string>): void {
  if (token.length > 0) paths.add(token);
}

/** Add a token to the set only when it looks like a filesystem path. */
function addIfPathLike(token: string, paths: Set<string>): void {
  if (isPathLikeToken(token)) paths.add(token);
}

/**
 * Extract a path from a token with an attached redirect operator.
 *
 * Handles both output redirects (`>output.txt`, `2>/dev/null`) and input
 * redirects attached to the reading command (`xxd</etc/shadow`, `cmd<<in`).
 * The operator may appear mid-token (`xxd<` … `path`), so we scan for the
 * first redirect operator and return everything after it.
 */
function extractAttachedRedirectTarget(token: string): string | null {
  for (const op of REDIRECT_OPERATORS) {
    if (token.startsWith(op) && token.length > op.length) {
      return token.slice(op.length);
    }
  }
  return extractMidTokenInputRedirect(token);
}

/** Split an input redirect attached to a command word: `xxd</etc/shadow`. */
function extractMidTokenInputRedirect(token: string): string | null {
  const idx = token.indexOf("<");
  if (idx <= 0 || idx >= token.length - 1) return null;
  const after = token[idx + 1] === "<"
    ? token.slice(idx + 2)
    : token.slice(idx + 1);
  return after.length > 0 ? after : null;
}

/**
 * Classify paths extracted from a shell command.
 *
 * Resolves each path (expanding `~` and resolving relative paths against
 * `workspaceCwd`), classifies via the provided `PathClassifier`, and
 * returns the highest classification found.
 *
 * CRITICAL: Uses classifyRealPath(), NOT classify(). run_command operates
 * on the real filesystem — "/" is the real root, not the sandbox workspace.
 * Using classify() would remap "/" to workspacePaths.basePath → PUBLIC,
 * bypassing taint escalation entirely. This bug has regressed multiple
 * times. DO NOT change classifyRealPath back to classify.
 */
export function classifyCommandPaths(opts: {
  readonly paths: readonly string[];
  readonly classifier: PathClassifier;
  readonly workspaceCwd: string;
}): CommandClassificationResult {
  const { paths, classifier, workspaceCwd } = opts;
  let highest: ClassificationLevel = "PUBLIC";
  const resolvedPaths: string[] = [];

  for (const raw of paths) {
    const expanded = expandTilde(raw);
    const absolute = expanded.startsWith("/")
      ? expanded
      : resolve(workspaceCwd, expanded);
    resolvedPaths.push(absolute);
    // CRITICAL: classifyRealPath — NOT classify(). See JSDoc above.
    const result = classifier.classifyRealPath(absolute);
    highest = maxClassification(highest, result.classification);
  }

  return { classification: highest, resolvedPaths };
}
