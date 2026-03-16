/**
 * ANSI escape sequence primitives for terminal control.
 *
 * Low-level CSI sequences for cursor movement, line clearing,
 * scroll region management, and cursor visibility.
 *
 * @module
 */

const CSI = "\x1b[";

/** Move cursor to an absolute row and column (1-based). */
export function moveTo(row: number, col: number): string {
  return `${CSI}${row};${col}H`;
}

/** Clear from cursor to end of line. */
export const CLEAR_LINE = `${CSI}K`;

/** Set scroll region from top to bottom row (1-based, inclusive). */
export function configureScrollRegion(top: number, bottom: number): string {
  return `${CSI}${top};${bottom}r`;
}

/** @deprecated Use configureScrollRegion instead */
export const setScrollRegion = configureScrollRegion;

/** Reset scroll region to full screen. */
export const RESET_SCROLL = `${CSI}r`;

/** Show cursor. */
export const SHOW_CURSOR = `${CSI}?25h`;

/** Hide cursor. */
export const HIDE_CURSOR = `${CSI}?25l`;
