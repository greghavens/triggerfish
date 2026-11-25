export const sleepToolName = "sleep";
export const maximumWaitSeconds = 3600;

export function sleepSeconds(args: Readonly<Record<string, unknown>>) {
  const { seconds } = args;
  return Object.keys(args).length === 1 && typeof seconds === "number" &&
      Number.isInteger(seconds) && seconds >= 1 && seconds <= maximumWaitSeconds
    ? seconds
    : undefined;
}

export function sleepResult(seconds: number): string {
  return `Waited ${seconds} second(s).`;
}

export function waitUntil(
  deadline: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => finish(true), remaining);
    const onAbort = () => finish(false);
    function finish(completed: boolean) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(completed);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
