/**
 * ASCII art banner and session info display.
 * @module
 */

import { BLUE, BOLD, CYAN, DIM, RESET, writeln } from "./ansi.ts";
import { VERSION } from "../../version.ts";

/** Print the Triggerfish ASCII art banner with session info. */
export function printBanner(
  provider: string,
  model: string | undefined,
  workspace: string,
): void {
  writeln();
  writeln(
    `  ${CYAN}${BOLD}╭──────────────────────────────────────────────────╮${RESET}`,
  );
  writeln(
    `  ${CYAN}${BOLD}│${RESET}                                                  ${CYAN}${BOLD}│${RESET}`,
  );
  writeln(
    `  ${CYAN}${BOLD}│${RESET}   ${BLUE}${BOLD}▀█▀ █▀▄ █ █▀▀ █▀▀ █▀▀ █▀▄ █▀▀ █ █▀▀ █ █${RESET}        ${CYAN}${BOLD}│${RESET}`,
  );
  writeln(
    `  ${CYAN}${BOLD}│${RESET}   ${BLUE}${BOLD} █  █▀▄ █ █ █ █ █ █▀▀ █▀▄ █▀  █ ▀▀█ █▀█${RESET}        ${CYAN}${BOLD}│${RESET}`,
  );
  writeln(
    `  ${CYAN}${BOLD}│${RESET}   ${BLUE}${BOLD} █  ▀ ▀ ▀ ▀▀▀ ▀▀▀ ▀▀▀ ▀ ▀ ▀   ▀ ▀▀▀ ▀ ▀${RESET}        ${CYAN}${BOLD}│${RESET}`,
  );
  writeln(
    `  ${CYAN}${BOLD}│${RESET}                                                  ${CYAN}${BOLD}│${RESET}`,
  );
  const tagline = `Secure Multi-Channel AI Agent  ${VERSION}`;
  const tagPad = " ".repeat(Math.max(0, 47 - tagline.length));
  writeln(
    `  ${CYAN}${BOLD}│${RESET}   ${DIM}${tagline}${RESET}${tagPad}${CYAN}${BOLD}│${RESET}`,
  );
  writeln(
    `  ${CYAN}${BOLD}│${RESET}                                                  ${CYAN}${BOLD}│${RESET}`,
  );
  writeln(
    `  ${CYAN}${BOLD}╰──────────────────────────────────────────────────╯${RESET}`,
  );
  writeln();
  const providerLabel = model ? `${provider} ${DIM}(${model})${RESET}` : provider;
  writeln(`  ${DIM}Provider :${RESET} ${providerLabel}`);
  writeln(`  ${DIM}Workspace:${RESET} ${workspace}`);
  writeln(
    `  ${DIM}Commands :${RESET} ${DIM}/quit${RESET} exit  ${DIM}/clear${RESET} reset  ${DIM}Ctrl+O${RESET} tool detail  ${DIM}ESC${RESET} interrupt`,
  );
  writeln();
}

/** Return the banner as a string (for screen manager output). */
export function formatBanner(
  provider: string,
  model: string | undefined,
  workspace: string,
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `  ${CYAN}${BOLD}╭──────────────────────────────────────────────────╮${RESET}`,
  );
  lines.push(
    `  ${CYAN}${BOLD}│${RESET}                                                  ${CYAN}${BOLD}│${RESET}`,
  );
  lines.push(
    `  ${CYAN}${BOLD}│${RESET}   ${BLUE}${BOLD}▀█▀ █▀▄ █ █▀▀ █▀▀ █▀▀ █▀▄ █▀▀ █ █▀▀ █ █${RESET}        ${CYAN}${BOLD}│${RESET}`,
  );
  lines.push(
    `  ${CYAN}${BOLD}│${RESET}   ${BLUE}${BOLD} █  █▀▄ █ █ █ █ █ █▀▀ █▀▄ █▀  █ ▀▀█ █▀█${RESET}        ${CYAN}${BOLD}│${RESET}`,
  );
  lines.push(
    `  ${CYAN}${BOLD}│${RESET}   ${BLUE}${BOLD} █  ▀ ▀ ▀ ▀▀▀ ▀▀▀ ▀▀▀ ▀ ▀ ▀   ▀ ▀▀▀ ▀ ▀${RESET}        ${CYAN}${BOLD}│${RESET}`,
  );
  lines.push(
    `  ${CYAN}${BOLD}│${RESET}                                                  ${CYAN}${BOLD}│${RESET}`,
  );
  const tagline = `Secure Multi-Channel AI Agent  ${VERSION}`;
  const tagPad = " ".repeat(Math.max(0, 47 - tagline.length));
  lines.push(
    `  ${CYAN}${BOLD}│${RESET}   ${DIM}${tagline}${RESET}${tagPad}${CYAN}${BOLD}│${RESET}`,
  );
  lines.push(
    `  ${CYAN}${BOLD}│${RESET}                                                  ${CYAN}${BOLD}│${RESET}`,
  );
  lines.push(
    `  ${CYAN}${BOLD}╰──────────────────────────────────────────────────╯${RESET}`,
  );
  lines.push("");
  const providerLabel = model ? `${provider} ${DIM}(${model})${RESET}` : provider;
  lines.push(`  ${DIM}Provider :${RESET} ${providerLabel}`);
  lines.push(`  ${DIM}Workspace:${RESET} ${workspace}`);
  lines.push(
    `  ${DIM}Commands :${RESET} ${DIM}/quit${RESET} exit  ${DIM}/clear${RESET} reset  ${DIM}Ctrl+O${RESET} tool detail  ${DIM}ESC${RESET} interrupt`,
  );
  lines.push("");
  return lines.join("\n");
}
