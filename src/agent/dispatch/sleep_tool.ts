/** A cancelable pause within the active agent turn. */
import type { ToolDefinition } from "../../core/types/tool.ts";

const maximumWaitSeconds = 3600;

export const sleepTool: ToolDefinition = {
  name: "sleep",
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

export function executeSleep(
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const { seconds } = args;
  if (
    Object.keys(args).length !== 1 || typeof seconds !== "number" ||
    !Number.isInteger(seconds) || seconds < 1 || seconds > maximumWaitSeconds
  ) {
    return Promise.resolve(
      `Error: Supply an integer seconds value from 1 through ${maximumWaitSeconds}.`,
    );
  }
  if (signal?.aborted) return Promise.resolve("Sleep interrupted.");
  return new Promise<string>((resolve) => {
    const timer = setTimeout(
      () => finish(`Waited ${seconds} second(s).`),
      seconds * 1000,
    );
    const onAbort = () => finish("Sleep interrupted.");
    function finish(message: string) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(message);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
