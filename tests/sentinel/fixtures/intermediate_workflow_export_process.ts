import type { BootstrapResult } from "../../../src/gateway/startup/bootstrap.ts";
import { createTidepoolSentinelHandler } from "../../../src/gateway/startup/services/tidepool_sentinel.ts";

const [baseDir, revision] = Deno.args;
const handler = createTidepoolSentinelHandler(
  { baseDir, config: {} } as BootstrapResult,
);
const socket = {
  readyState: WebSocket.OPEN,
  send: (event: string) => {
    if (JSON.parse(event).type === "export") console.log(event);
  },
} as unknown as WebSocket;
await handler({
  type: "export",
  format: "provenance",
  revision: Number(revision),
}, socket);
