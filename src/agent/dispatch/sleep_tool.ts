/** A cancelable pause within the active agent turn. */
import type { ToolDefinition } from "../../core/types/tool.ts";

import {
  maximumWaitSeconds,
  sleepResult,
  sleepSeconds,
  sleepToolName,
  waitUntil,
} from "../../core/sleep_deadline.ts";

export const sleepTool: ToolDefinition = {
  name: sleepToolName,
  description:
    "Wait within the current turn. A pause, cancellation, or shutdown interrupts the wait.",
  parameters: {
    seconds: {
      type: "integer",
      description: `Seconds to wait, from 1 through ${maximumWaitSeconds}.`,
      required: true,
    },
  },
};

export async function executeSleep(
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const seconds = sleepSeconds(args);
  if (seconds === undefined) {
    return `Error: Supply an integer seconds value from 1 through ${maximumWaitSeconds}.`;
  }
  return await waitUntil(Date.now() + seconds * 1000, signal)
    ? sleepResult(seconds)
    : "Sleep interrupted.";
}
