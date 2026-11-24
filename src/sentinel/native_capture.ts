/** Retain metadata for approved Triggerfish web fetches in a private case feed. */
import { importSentinelHar } from "./har.ts";
import { mergeSentinelSnapshots } from "./merge.ts";
import { publishSentinelInput } from "./published_input.ts";

type Snapshot = ReturnType<typeof importSentinelHar>["snapshot"];
const publishers = new Map<string, {
  pending: Promise<void>;
  recent: Map<string, Snapshot>;
}>();

export function sentinelCaptureOrigins(value: unknown): ReadonlySet<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error(
      "sentinel.capture_origins must list up to 128 exact HTTP origins",
    );
  }
  return new Set(value.map((item: unknown) => {
    const url = typeof item === "string" ? URL.parse(item) : null;
    if (
      !url || !["https:", "http:"].includes(url.protocol) || item !== url.origin
    ) {
      throw new Error(
        "sentinel.capture_origins entries must be canonical HTTP origins",
      );
    }
    return url.origin;
  }));
}

export function publishSentinelWebCapture(
  path: string,
  origin: string,
  status: number,
  timestamp: string,
): Promise<void> {
  let state = publishers.get(path);
  if (!state) {
    state = { pending: Promise.resolve(), recent: new Map() };
    publishers.set(path, state);
  }
  const { recent } = state;
  const { snapshot, observations } = importSentinelHar({
    log: {
      version: "1.2",
      entries: [{
        startedDateTime: timestamp,
        request: { url: origin, method: "GET" },
        response: { status },
      }],
    },
  }, "triggerfish-web-fetch");
  const observation = observations[0];
  if (!observation) return Promise.resolve();

  const pending = state.pending.then(async () => {
    recent.set(observation.evidenceId, snapshot);
    if (recent.size > 100) recent.delete(recent.keys().next().value!);
    await publishSentinelInput(
      path,
      mergeSentinelSnapshots([...recent.values()]),
    );
  });
  state.pending = pending.catch(() => {});
  return pending;
}
