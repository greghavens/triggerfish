/**
 * Todo display formatters — ANSI, HTML rendering, and event extraction.
 *
 * Provides CLI box-rendered ANSI output, HTML for the Tidepool web client,
 * and TodoItem extraction from orchestrator events.
 *
 * @module
 */

import type { TodoItem } from "./todo_defs.ts";
import { verifyTodoItem } from "./todo_validation.ts";

// ─── ANSI constants ─────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const STRIKETHROUGH = "\x1b[9m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";

// ─── ANSI helpers ───────────────────────────────────────────────────────────

/** Strip ANSI escape sequences to get visible character count. */
function visibleLength(s: string): number {
  // deno-lint-ignore no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Format a single todo item as an ANSI-styled content line. */
function formatTodoItemAnsi(todo: TodoItem): string {
  switch (todo.status) {
    case "completed":
      return `${DIM}${GREEN}✓${RESET} ${DIM}${STRIKETHROUGH}${todo.content}${RESET}`;
    case "in_progress":
      return `${YELLOW}${BOLD}▶${RESET} ${BOLD}${todo.content}${RESET}`;
    case "pending":
      return `${DIM}○${RESET} ${todo.content}`;
  }
}

/** Wrap content lines in a box with a header, returning the rendered lines. */
function wrapTodoContentInBox(
  header: string,
  contentLines: readonly string[],
): string {
  const allVisible = [header, ...contentLines];
  const maxWidth = Math.max(...allVisible.map(visibleLength));
  const boxInner = Math.max(maxWidth + 2, 20);
  const lines: string[] = [];
  const dashesAfter = boxInner - visibleLength(header) - 3;
  lines.push(
    `  ${CYAN}╭─ ${RESET}${header}${CYAN} ${
      "─".repeat(Math.max(dashesAfter, 1))
    }╮${RESET}`,
  );
  for (const line of contentLines) {
    const pad = boxInner - visibleLength(line) - 2;
    lines.push(
      `  ${CYAN}│${RESET} ${line}${
        " ".repeat(Math.max(pad, 0))
      } ${CYAN}│${RESET}`,
    );
  }
  lines.push(`  ${CYAN}╰${"─".repeat(boxInner)}╯${RESET}`);
  return lines.join("\n");
}

/**
 * Format a todo list as ANSI-styled text for CLI display inside a box.
 *
 * - Completed items: checkmark with strikethrough + dim
 * - In-progress items: arrow bold + yellow (highlighted)
 * - Pending items: circle normal
 */
export function formatTodoListAnsi(todos: readonly TodoItem[]): string {
  if (todos.length === 0) {
    return `  ${DIM}╭─ 📋 No tasks ─╮${RESET}\n  ${DIM}╰────────────────╯${RESET}`;
  }
  const contentLines = todos.map(formatTodoItemAnsi);
  return wrapTodoContentInBox("📋 Tasks", contentLines);
}

// ─── HTML formatter ─────────────────────────────────────────────────────────

/** HTML-escape a string. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Format a single todo item as an HTML div element. */
function formatTodoItemHtml(todo: TodoItem): string {
  switch (todo.status) {
    case "completed":
      return `<div class="todo-item todo-done"><span class="todo-check">✓</span> <s>${
        escapeHtml(todo.content)
      }</s></div>`;
    case "in_progress":
      return `<div class="todo-item todo-active"><span class="todo-arrow">▶</span> ${
        escapeHtml(todo.content)
      }</div>`;
    case "pending":
      return `<div class="todo-item todo-pending"><span class="todo-circle">○</span> ${
        escapeHtml(todo.content)
      }</div>`;
  }
}

/**
 * Format a todo list as HTML for the Tidepool web client.
 *
 * Returns a styled div with completed/active/pending items.
 */
export function formatTodoListHtml(todos: readonly TodoItem[]): string {
  if (todos.length === 0) {
    return '<div class="todo-list"><span class="todo-empty">📋 No tasks</span></div>';
  }
  const items = todos.map(formatTodoItemHtml).join("");
  return `<div class="todo-list"><div class="todo-header">📋 Tasks</div>${items}</div>`;
}

// ─── Event extraction ───────────────────────────────────────────────────────

/** Parse and validate todo items from a JSON result string. */
function parseTodosFromResult(result: string): readonly TodoItem[] | null {
  try {
    const parsed = JSON.parse(result);
    if (!parsed.todos || !Array.isArray(parsed.todos)) return null;
    const validated = (parsed.todos as unknown[])
      .map(verifyTodoItem)
      .filter((t): t is TodoItem => t !== null);
    if (validated.length > 0) return validated;
  } catch {
    // not JSON — e.g. "No todos" message
  }
  return null;
}

/**
 * Extract TodoItem[] from a tool_call args object or a tool_result JSON string.
 *
 * Returns the items if parseable, or null otherwise.
 */
export function extractTodosFromEvent(
  toolName: string,
  data: { args?: Record<string, unknown>; result?: string },
): readonly TodoItem[] | null {
  if (toolName !== "todo_read" && toolName !== "todo_write") return null;
  if (data.result) return parseTodosFromResult(data.result);
  return null;
}
