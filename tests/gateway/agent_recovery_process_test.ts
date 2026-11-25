import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";

async function beforeDeadline<T>(result: Promise<T>): Promise<T> {
  const deadline = Promise.withResolvers<T>();
  const timer = setTimeout(
    () => deadline.reject(new Error("Recovery fixture timed out.")),
    5000,
  );
  try {
    return await Promise.race([result, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}

Deno.test({
  name:
    "Gateway process restart reuses a committed credential-backed tool exchange",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await Deno.makeTempDir();
    const secret = `synthetic_fixture_${crypto.randomUUID()}`;
    const session = crypto.randomUUID();
    const token = crypto.randomUUID();
    const request =
      `/recover ${crypto.randomUUID()} Verify the workflow status.`;
    const fixture = new URL(
      "./fixtures/agent_recovery_process.ts",
      import.meta.url,
    );

    async function launch(mode: "interrupt" | "resume") {
      const child = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", fixture.href, dir, mode, session, token],
        env: { TRIGGERFISH_RECOVERY_FIXTURE_SECRET: secret },
        stdout: "piped",
        stderr: "inherit",
      }).spawn();
      const reader = child.stdout.pipeThrough(new TextDecoderStream())
        .getReader();
      let buffered = "";
      const readLine = async () => {
        while (!buffered.includes("\n")) {
          const chunk = await reader.read();
          if (chunk.done) {
            throw new Error("Fixture exited before reporting state.");
          }
          buffered += chunk.value;
        }
        const end = buffered.indexOf("\n");
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        return line.trim();
      };
      const terminate = async (signal: "SIGKILL" | "SIGTERM") => {
        try {
          child.kill(signal);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        } finally {
          await child.status;
          await reader.cancel();
        }
      };
      try {
        const port = /^PORT (\d+)$/.exec(await beforeDeadline(readLine()))?.[1];
        if (!port) throw new Error("Fixture did not publish its port.");
        const socket = new WebSocket(
          `ws://127.0.0.1:${port}/chat?token=${token}`,
        );
        const response = Promise.withResolvers<string>();
        let text = "";
        socket.onmessage = ({ data }) => {
          const event = JSON.parse(data);
          if (event.type === "response") text = event.text;
          if (event.type === "error") response.reject(new Error(event.message));
          if (event.type === "turn_end") response.resolve(text);
        };
        socket.onerror = () =>
          response.reject(new Error("Fixture disconnected."));
        // The interrupted process exits before sending any terminal response.
        response.promise.catch(() => {});
        socket.onopen = () =>
          socket.send(JSON.stringify({ type: "message", content: request }));
        return {
          readLine,
          response: response.promise,
          async stop(signal: "SIGKILL" | "SIGTERM") {
            const closed = Promise.withResolvers<void>();
            if (socket.readyState === WebSocket.CLOSED) closed.resolve();
            else socket.onclose = () => closed.resolve();
            await terminate(signal);
            await closed.promise;
          },
        };
      } catch (error) {
        await terminate("SIGKILL");
        throw error;
      }
    }
    try {
      const first = await launch("interrupt");
      try {
        assertEquals(
          await beforeDeadline(first.readLine()),
          "CHECKPOINT_SAVED",
        );
      } finally {
        await first.stop("SIGKILL");
      }
      const second = await launch("resume");
      try {
        assertEquals(
          await beforeDeadline(second.response),
          "Restored the exact workflow status.",
        );
      } finally {
        await second.stop("SIGTERM");
      }
      assertEquals(await Deno.readTextFile(join(dir, "calls")), "read\n");
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile) {
          assert(
            !(await Deno.readTextFile(join(dir, entry.name))).includes(secret),
          );
        }
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
