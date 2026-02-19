/**
 * Workflow execution context and expression evaluator.
 *
 * Implements jq-compatible ${ } expression evaluation with support for
 * $input, $secrets, $context.* built-in variables and common jq operations.
 *
 * Secrets are resolved internally and never exposed in output or logs.
 *
 * @module
 */

import type { ClassificationLevel } from "../core/types/classification.ts";
import type { SessionId } from "../core/types/session.ts";
import type { Result } from "../core/types/classification.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Context variables available as $context.* in expressions. */
export interface ContextVars {
  readonly date: string;
  readonly time: string;
  readonly workflow: { readonly name: string; readonly version: string };
  readonly session: { readonly id: string; readonly taint: ClassificationLevel };
  readonly agent: { readonly id: string };
}

/** Secret resolver — resolves $secrets.name → value. */
export interface SecretResolver {
  readonly resolve: (name: string) => Promise<string | null>;
}

/** Mutable workflow data + immutable context for expression evaluation. */
export interface WorkflowContext {
  /** Current mutable data context (the `.` in jq expressions). */
  readonly data: Record<string, unknown>;
  /** Original workflow input — accessible as $input. */
  readonly input: Record<string, unknown>;
  /** Secret resolver — accessible as $secrets.name. */
  readonly secrets: SecretResolver;
  /** Built-in context variables — accessible as $context.*. */
  readonly contextVars: ContextVars;
}

// ─── Context creation ─────────────────────────────────────────────────────────

/**
 * Create a workflow execution context.
 */
export function createWorkflowContext(options: {
  readonly input: Record<string, unknown>;
  readonly sessionId: SessionId;
  readonly sessionTaint: ClassificationLevel;
  readonly agentId: string;
  readonly workflowName: string;
  readonly workflowVersion: string;
  readonly secretResolver?: SecretResolver;
}): WorkflowContext {
  const now = new Date();
  const noop: SecretResolver = { resolve: async (_name) => null };

  return {
    data: { ...options.input },
    input: { ...options.input },
    secrets: options.secretResolver ?? noop,
    contextVars: {
      date: now.toISOString().slice(0, 10),
      time: now.toISOString(),
      workflow: { name: options.workflowName, version: options.workflowVersion },
      session: { id: options.sessionId as string, taint: options.sessionTaint },
      agent: { id: options.agentId },
    },
  };
}

/**
 * Return a new WorkflowContext with a key set in the data object.
 */
export function mergeOutput(
  ctx: WorkflowContext,
  key: string,
  value: unknown,
): WorkflowContext {
  return {
    ...ctx,
    data: {
      ...ctx.data,
      [key]: value,
    },
  };
}

// ─── Expression evaluator ─────────────────────────────────────────────────────

/**
 * Resolve all ${ } template expressions in a string.
 *
 * Returns the resolved string, or a Result error if evaluation fails.
 */
export async function resolveTemplateString(
  template: string,
  ctx: WorkflowContext,
): Promise<Result<string, string>> {
  const pattern = /\$\{([^}]+)\}/g;
  const parts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(template)) !== null) {
    // Add literal text before this expression
    parts.push(template.slice(lastIndex, match.index));

    const expr = match[1].trim();
    const result = await evaluateExpression(expr, ctx);
    if (!result.ok) return result;

    parts.push(stringify(result.value));
    lastIndex = match.index + match[0].length;
  }

  parts.push(template.slice(lastIndex));
  return { ok: true, value: parts.join("") };
}

/**
 * Evaluate a single jq-compatible expression against the workflow context.
 *
 * Supports:
 * - `.field` — access current data context
 * - `$input.field` — access original workflow input
 * - `$context.field.subfield` — access context variables
 * - `$secrets.name` — resolve secret (async)
 * - `.field | select(.x >= 4)` — pipe with select filter
 * - `.field | map(.x)` — pipe with map
 * - `.field | join("sep")` — join array elements
 * - `.field | toJson` — JSON stringify
 * - `.field | any(.x >= 4)` — any predicate
 * - `"str" + .field` — string concatenation
 * - `$var + " more"` — variable concatenation
 * - Comparison operators: >=, <=, >, <, ==, !=
 */
export async function evaluateExpression(
  expr: string,
  ctx: WorkflowContext,
): Promise<Result<unknown, string>> {
  const trimmed = expr.trim();

  try {
    // Handle pipe chains: expr | filter | filter ...
    if (trimmed.includes(" | ")) {
      return await evaluatePipeChain(trimmed, ctx);
    }

    // Handle string concatenation with +
    // e.g. $competitor + " news" or "prefix" + .field
    if (trimmed.includes(" + ") && (trimmed.includes('"') || trimmed.startsWith("$") || trimmed.startsWith("."))) {
      return await evaluateConcatenation(trimmed, ctx);
    }

    return await evaluateSingleExpr(trimmed, ctx);
  } catch (err) {
    return { ok: false, error: `Expression error: ${(err as Error).message}` };
  }
}

async function evaluatePipeChain(
  expr: string,
  ctx: WorkflowContext,
): Promise<Result<unknown, string>> {
  // Split on top-level pipes (not nested in parens)
  const parts = splitPipe(expr);
  if (parts.length < 2) {
    return evaluateSingleExpr(expr, ctx);
  }

  const leftResult = await evaluateSingleExpr(parts[0].trim(), ctx);
  if (!leftResult.ok) return leftResult;

  let value = leftResult.value;

  for (let i = 1; i < parts.length; i++) {
    const filter = parts[i].trim();
    const filterResult = applyFilter(value, filter, ctx);
    if (!filterResult.ok) return filterResult;
    value = filterResult.value;
  }

  return { ok: true, value };
}

function splitPipe(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "|" && depth === 0 && expr[i - 1] === " " && expr[i + 1] === " ") {
      parts.push(expr.slice(start, i - 1));
      start = i + 2;
    }
  }
  parts.push(expr.slice(start));
  return parts;
}

function applyFilter(
  value: unknown,
  filter: string,
  _ctx: WorkflowContext,
): Result<unknown, string> {
  // toJson
  if (filter === "toJson") {
    return { ok: true, value: JSON.stringify(value) };
  }

  // select(.field op value)
  if (filter.startsWith("select(") && filter.endsWith(")")) {
    const pred = filter.slice(7, -1);
    if (!Array.isArray(value)) {
      // Single value: return value if predicate is true, null otherwise
      const matches = evalPredicate(value, pred);
      return { ok: true, value: matches ? value : null };
    }
    return { ok: true, value: (value as unknown[]).filter((item) => evalPredicate(item, pred)) };
  }

  // map(.field)
  if (filter.startsWith("map(") && filter.endsWith(")")) {
    const proj = filter.slice(4, -1).trim();
    if (!Array.isArray(value)) {
      return { ok: false, error: `map() requires an array, got ${typeof value}` };
    }
    const mapped = (value as unknown[]).map((item) => {
      if (proj.startsWith(".")) {
        const field = proj.slice(1);
        if (item && typeof item === "object") {
          return (item as Record<string, unknown>)[field];
        }
        return null;
      }
      return item;
    });
    return { ok: true, value: mapped };
  }

  // join("sep")
  if (filter.startsWith("join(") && filter.endsWith(")")) {
    const sepRaw = filter.slice(5, -1).trim();
    const sep = sepRaw.replace(/^["']|["']$/g, "");
    if (!Array.isArray(value)) {
      return { ok: false, error: `join() requires an array, got ${typeof value}` };
    }
    return { ok: true, value: (value as unknown[]).map(String).join(sep) };
  }

  // any(.field op value)
  if (filter.startsWith("any(") && filter.endsWith(")")) {
    const pred = filter.slice(4, -1);
    if (!Array.isArray(value)) {
      return { ok: true, value: evalPredicate(value, pred) };
    }
    return { ok: true, value: (value as unknown[]).some((item) => evalPredicate(item, pred)) };
  }

  // all(.field op value)
  if (filter.startsWith("all(") && filter.endsWith(")")) {
    const pred = filter.slice(4, -1);
    if (!Array.isArray(value)) {
      return { ok: true, value: evalPredicate(value, pred) };
    }
    return { ok: true, value: (value as unknown[]).every((item) => evalPredicate(item, pred)) };
  }

  // .field access on the current value
  if (filter.startsWith(".")) {
    const field = filter.slice(1);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { ok: true, value: (value as Record<string, unknown>)[field] ?? null };
    }
    return { ok: true, value: null };
  }

  return { ok: false, error: `Unknown filter: ${filter}` };
}

/**
 * Evaluate a simple predicate like `.significance >= 4` or `.x == "foo"`.
 */
function evalPredicate(item: unknown, pred: string): boolean {
  const ops = [">=", "<=", "!=", "==", ">", "<"];
  for (const op of ops) {
    const idx = pred.indexOf(op);
    if (idx === -1) continue;
    const left = pred.slice(0, idx).trim();
    const right = pred.slice(idx + op.length).trim();

    let leftVal: unknown = item;
    if (left.startsWith(".")) {
      const field = left.slice(1);
      if (item && typeof item === "object") {
        leftVal = (item as Record<string, unknown>)[field];
      }
    }

    let rightVal: unknown;
    if (right.startsWith('"') || right.startsWith("'")) {
      rightVal = right.slice(1, -1);
    } else if (!isNaN(Number(right))) {
      rightVal = Number(right);
    } else {
      rightVal = right;
    }

    const l = typeof leftVal === "number" ? leftVal : String(leftVal);
    const r = typeof rightVal === "number" ? rightVal : String(rightVal);

    switch (op) {
      case ">=": return (l as number) >= (r as number);
      case "<=": return (l as number) <= (r as number);
      case "!=": return l !== r;
      case "==": return l === r;
      case ">": return (l as number) > (r as number);
      case "<": return (l as number) < (r as number);
    }
  }
  return false;
}

async function evaluateConcatenation(
  expr: string,
  ctx: WorkflowContext,
): Promise<Result<unknown, string>> {
  // Split on " + " (with spaces to avoid splitting JSON)
  const parts = expr.split(" + ");
  const values: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    const result = await evaluateSingleExpr(trimmed, ctx);
    if (!result.ok) return result;
    values.push(stringify(result.value));
  }
  return { ok: true, value: values.join("") };
}

/**
 * Evaluate a single, non-pipe expression.
 */
async function evaluateSingleExpr(
  expr: string,
  ctx: WorkflowContext,
): Promise<Result<unknown, string>> {
  // String literal
  if ((expr.startsWith('"') && expr.endsWith('"')) ||
      (expr.startsWith("'") && expr.endsWith("'"))) {
    return { ok: true, value: expr.slice(1, -1) };
  }

  // Numeric literal
  if (!isNaN(Number(expr)) && expr.length > 0) {
    return { ok: true, value: Number(expr) };
  }

  // Boolean literals
  if (expr === "true") return { ok: true, value: true };
  if (expr === "false") return { ok: true, value: false };
  if (expr === "null") return { ok: true, value: null };

  // $secrets.name
  if (expr.startsWith("$secrets.")) {
    const name = expr.slice(9);
    const value = await ctx.secrets.resolve(name);
    // Never expose secret value in expressions — it stays internal
    // If null (not found), return an empty string to avoid leaking the name
    return { ok: true, value: value ?? "" };
  }

  // $input or $input.field
  if (expr === "$input") return { ok: true, value: ctx.input };
  if (expr.startsWith("$input.")) {
    const path = expr.slice(7);
    return { ok: true, value: getNestedPath(ctx.input, path) };
  }

  // $context.*
  if (expr === "$context") return { ok: true, value: ctx.contextVars };
  if (expr.startsWith("$context.")) {
    const path = expr.slice(9);
    return { ok: true, value: getNestedPath(ctx.contextVars as unknown as Record<string, unknown>, path) };
  }

  // $var — for loop iteration variable (e.g. $competitor)
  // These are stored in data with the variable name (without $)
  if (expr.startsWith("$") && !expr.startsWith("$context") && !expr.startsWith("$input") && !expr.startsWith("$secrets")) {
    const varName = expr.slice(1);
    return { ok: true, value: ctx.data[varName] ?? null };
  }

  // . — current data context
  if (expr === ".") return { ok: true, value: ctx.data };

  // .field or .["field"] or nested .field.subfield
  if (expr.startsWith(".")) {
    const path = expr.slice(1);
    if (path.length === 0) return { ok: true, value: ctx.data };
    return { ok: true, value: getNestedPath(ctx.data, path) };
  }

  return { ok: false, error: `Unknown expression: ${expr}` };
}

/**
 * Navigate a nested path like "field.subfield" or `["key"]` on an object.
 */
function getNestedPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (!part) continue;
    // Handle ["key"] syntax
    const bracketMatch = part.match(/^\["(.+)"\]$/);
    const key = bracketMatch ? bracketMatch[1] : part;
    if (current && typeof current === "object" && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return null;
    }
  }
  return current ?? null;
}

/**
 * Convert a value to its string representation for template interpolation.
 */
function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Apply an `output.as` transform: takes the task output and merges it
 * into the workflow context under the specified key.
 *
 * Handles:
 * - `.key` — store output under `key` in data
 * - `.results["${ $competitor }"]` — store under a dynamic key
 * - Returns a new WorkflowContext with the updated data
 */
export async function applyOutputTransform(
  ctx: WorkflowContext,
  asExpr: string | Record<string, unknown> | undefined,
  output: unknown,
): Promise<WorkflowContext> {
  if (!asExpr) return ctx;

  if (typeof asExpr === "string") {
    const trimmed = asExpr.trim();

    // .key — store output under that key
    if (trimmed.startsWith(".")) {
      // Handle dynamic keys like .results["${ $competitor }"]
      const resolveResult = await resolveTemplateString(trimmed.slice(1), ctx);
      if (!resolveResult.ok) return ctx;

      const key = resolveResult.value;
      return mergeOutput(ctx, key, output);
    }
  }

  return ctx;
}

/**
 * Scrub resolved secret values from data before persisting to storage.
 *
 * Recursively replaces any string value that exactly matches a resolved
 * secret value with "[REDACTED]".
 */
export function scrubSecrets(
  data: unknown,
  resolvedSecrets: readonly string[],
): unknown {
  if (resolvedSecrets.length === 0) return data;

  if (typeof data === "string") {
    for (const secret of resolvedSecrets) {
      if (data.includes(secret)) {
        return data.replaceAll(secret, "[REDACTED]");
      }
    }
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => scrubSecrets(item, resolvedSecrets));
  }

  if (data && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      result[k] = scrubSecrets(v, resolvedSecrets);
    }
    return result;
  }

  return data;
}

/**
 * Resolve all ${ } expressions in a value recursively.
 * Used to resolve task `with` parameters before dispatch.
 */
export async function resolveExpressions(
  value: unknown,
  ctx: WorkflowContext,
): Promise<unknown> {
  if (typeof value === "string") {
    // If the entire string is a single expression, resolve to typed value
    const singleExpr = value.match(/^\$\{([^}]+)\}$/);
    if (singleExpr) {
      const result = await evaluateExpression(singleExpr[1].trim(), ctx);
      return result.ok ? result.value : value;
    }
    // Otherwise resolve as template string
    const result = await resolveTemplateString(value, ctx);
    return result.ok ? result.value : value;
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => resolveExpressions(item, ctx)));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = await resolveExpressions(v, ctx);
    }
    return result;
  }

  return value;
}

/**
 * Evaluate an `if` condition expression.
 * Returns true (continue) or false (skip) or true if expression can't be evaluated.
 */
export async function evaluateCondition(
  condition: string | undefined,
  ctx: WorkflowContext,
): Promise<boolean> {
  if (condition === undefined) return true;

  const trimmed = condition.trim();
  // Resolve template expressions first
  const resolved = await resolveTemplateString(trimmed, ctx);
  if (!resolved.ok) return true; // On error, don't skip

  const val = resolved.value;
  if (val === "false" || val === "" || val === "null") return false;
  if (val === "true") return true;

  // Direct expression evaluation
  const result = await evaluateExpression(trimmed, ctx);
  if (!result.ok) return true;

  const v = result.value;
  if (v === null || v === undefined || v === false || v === "false" || v === "") return false;
  return true;
}
