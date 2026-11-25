import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { readConfigYaml } from "../../../src/core/config_io.ts";

const gatewayFixture = fromFileUrl(
  new URL("../fixtures/mcp_configured_gateway.ts", import.meta.url),
);
const connectorFixture = fromFileUrl(
  new URL("../fixtures/mcp_configured_connector.ts", import.meta.url),
);

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 12_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function stopGatewayProcess(process: Deno.ChildProcess): Promise<void> {
  try {
    await process.stdin.close();
    const status = await within(process.status, "MCP gateway did not stop.");
    assertEquals(status.code, 0);
  } catch (error) {
    try {
      process.kill();
    } catch {
      // The process may already have exited.
    }
    await process.status;
    throw error;
  }
}

async function withConfiguredGateway(
  dir: string,
  fixture: (turn: (content: string) => Promise<string>) => Promise<void>,
): Promise<void> {
  const token = crypto.randomUUID();
  const process = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-check",
      "--allow-env",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-ffi",
      "--allow-import",
      "--allow-net=127.0.0.1",
      gatewayFixture,
      dir,
      token,
    ],
    env: { TRIGGERFISH_DATA_DIR: dir },
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const output = process.stdout.pipeThrough(new TextDecoderStream())
    .getReader();
  const readPort = async (): Promise<number> => {
    let line = "";
    while (!line.includes("\n")) {
      const chunk = await output.read();
      assert(!chunk.done, "MCP gateway exited before startup.");
      line += chunk.value;
    }
    return JSON.parse(line.split("\n")[0]).port;
  };
  let socket: WebSocket | undefined;
  try {
    const port = await within(readPort(), "MCP gateway did not start.");
    socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    const connected = socket;
    await within(
      new Promise<void>((resolve, reject) => {
        connected.addEventListener("open", () => resolve(), { once: true });
        connected.addEventListener("error", reject, { once: true });
      }),
      "Could not connect to the MCP gateway.",
    );
    await fixture(async (content) => {
      let response: string | undefined;
      const end = Promise.withResolvers<void>();
      const receive = ({ data }: MessageEvent) => {
        const event = JSON.parse(data);
        if (event.type === "response") response = event.text;
        if (event.type === "turn_end") end.resolve();
      };
      connected.addEventListener("message", receive);
      try {
        connected.send(JSON.stringify({ type: "message", content }));
        await within(end.promise, "MCP gateway did not complete the turn.");
        assert(
          typeof response === "string" &&
            response.startsWith("Fixture result: "),
          "MCP gateway turn produced no fixture result.",
        );
        return response.slice("Fixture result: ".length);
      } finally {
        connected.removeEventListener("message", receive);
      }
    });
  } finally {
    try {
      if (socket && socket.readyState < WebSocket.CLOSING) {
        const close = Promise.withResolvers<void>();
        socket.addEventListener("close", () => close.resolve(), { once: true });
        socket.close();
        await within(close.promise, "MCP gateway socket did not close.");
      }
    } finally {
      try {
        await stopGatewayProcess(process);
      } finally {
        await output.cancel();
      }
    }
  }
}

Deno.test({
  name:
    "Configured MCP calls use approved timeout and retry settings after gateway restart",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await Deno.makeTempDir();
    try {
      const probe = join(dir, "retry-attempts");
      const configPath = join(dir, "triggerfish.yaml");
      const expectedInventory = "Configured inventory is available.";
      await Deno.writeTextFile(
        configPath,
        `models:
  primary: fixture
mcp_servers:
  inventory:
    command: ${JSON.stringify(Deno.execPath())}
    args: ${
          JSON.stringify([
            "run",
            "--no-check",
            "--allow-env=MCP_FIXTURE_CREDENTIAL",
            connectorFixture,
            "inventory",
          ])
        }
    env:
      MCP_FIXTURE_CREDENTIAL: secret:fixture-mcp-key
    classification: CONFIDENTIAL
    tool_call_timeout_ms: 3000
  retry_probe:
    command: ${JSON.stringify(Deno.execPath())}
    args: ${
          JSON.stringify([
            "run",
            "--no-check",
            `--allow-write=${probe}`,
            connectorFixture,
            "retry",
            probe,
          ])
        }
    classification: INTERNAL
    max_retries: 2
`,
      );
      await withConfiguredGateway(dir, async (turn) => {
        assertEquals(await Deno.readTextFile(probe), "attempt\nattempt\n");
        assertEquals(await turn("Read slow inventory"), expectedInventory);
        assertEquals(
          JSON.parse(await turn("Update inventory timeout"))
            .tool_call_timeout_ms,
          1_000,
        );
        assertEquals(
          JSON.parse(await turn("Update retry limit")).max_retries,
          1,
        );
        assertEquals(await turn("Read slow inventory"), expectedInventory);
      });
      const saved = readConfigYaml(configPath);
      assert(saved.ok);
      assertStringIncludes(
        JSON.stringify(saved.value),
        "secret:fixture-mcp-key",
      );
      assert(
        !JSON.stringify(saved.value).includes("fixture-mcp-private-value"),
      );

      await withConfiguredGateway(dir, async (turn) => {
        assertEquals(
          await Deno.readTextFile(probe),
          "attempt\nattempt\nattempt\n",
        );
        assertEquals(await turn("Read fast inventory"), expectedInventory);
        const expired = await turn("Read slow inventory");
        assertStringIncludes(
          expired,
          "MCP request timed out after 1000ms: tools/call",
        );
        assert(!expired.includes("fixture-mcp-private-value"));
      });
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
