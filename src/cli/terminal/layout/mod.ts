/**
 * Terminal layout — ANSI escapes, cursor positioning, and visual row calculation.
 * @module
 */

export {
  CLEAR_LINE,
  configureScrollRegion,
  HIDE_CURSOR,
  moveTo,
  RESET_SCROLL,
  setScrollRegion,
  SHOW_CURSOR,
} from "./ansi_escape.ts";

export type { CursorPosition } from "./cursor_position.ts";
export {
  advanceStreamCursor,
  computeCursorPosition,
} from "./cursor_position.ts";

export type { VisualRowLayout } from "./visual_row_layout.ts";
export {
  clearRowRange,
  clearStaleSeparatorRows,
  computeVisualRowLayout,
} from "./visual_row_layout.ts";
