/**
 * Tests for the sandbox worker — verifies filesystem operations
 * within the workspace and error handling via Worker postMessage.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type {
  SandboxRequest,
  SandboxResponse,
} from "../../../src/exec/sandbox/protocol.ts";

/** Spawn a Worker restricted to the given workspace. */
function spawnWorker(workspacePath: string): {
  worker: Worker;
  send: (req: SandboxRequest) => void;
  receive: () => Promise<SandboxResponse>;
  close: () => void;
} {
  const workerUrl = new URL(
    "../../../src/exec/sandbox/worker.ts",
    import.meta.url,
  );
  const worker = new Worker(workerUrl.href, {
    type: "module",
    name: "sandbox-test",
    deno: {
      permissions: {
        read: [workspacePath],
        write: [workspacePath],
        run: ["grep", "find"],
        net: false,
        env: false,
        ffi: false,
      },
    },
  });

  const responseQueue: SandboxResponse[] = [];
  const waiters: ((resp: SandboxResponse) => void)[] = [];

  worker.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (data?.type === "ready") return; // Skip init acknowledgment
    const resp = data as SandboxResponse;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(resp);
    } else {
      responseQueue.push(resp);
    }
  };

  worker.onerror = (event: ErrorEvent) => {
    event.preventDefault();
    const err = new Error(`Sandbox worker error: ${event.message}`);
    for (const waiter of waiters) {
      waiter({ id: "unknown", ok: false, error: err.message });
    }
    waiters.length = 0;
  };

  // Initialize with workspace path
  worker.postMessage({ type: "init", workspacePath });

  return {
    worker,
    send(req: SandboxRequest) {
      worker.postMessage(req);
    },
    receive(): Promise<SandboxResponse> {
      const queued = responseQueue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    close() {
      worker.terminate();
    },
  };
}

Deno.test("worker: read file within workspace", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "sandbox-test-" });
  const testFile = join(tmpDir, "hello.txt");
  await Deno.writeTextFile(testFile, "hello world");

  const w = spawnWorker(tmpDir);
  try {
    w.send({ id: "1", op: "read", args: { path: testFile } });
    const resp = await w.receive();
    assertEquals(resp.id, "1");
    assertEquals(resp.ok, true);
    assertEquals(resp.result, "hello world");
  } finally {
    w.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("worker: write file within workspace", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "sandbox-test-" });
  const testFile = join(tmpDir, "output.txt");

  const w = spawnWorker(tmpDir);
  try {
    w.send({
      id: "2",
      op: "write",
      args: { path: testFile, content: "written content" },
    });
    const resp = await w.receive();
    assertEquals(resp.id, "2");
    assertEquals(resp.ok, true);
    assertStringIncludes(resp.result!, "bytes");

    const content = await Deno.readTextFile(testFile);
    assertEquals(content, "written content");
  } finally {
    w.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("worker: write creates parent directories", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "sandbox-test-" });
  const nestedFile = join(tmpDir, "a", "b", "deep.txt");

  const w = spawnWorker(tmpDir);
  try {
    w.send({
      id: "3",
      op: "write",
      args: { path: nestedFile, content: "deep" },
    });
    const resp = await w.receive();
    assertEquals(resp.ok, true);

    const content = await Deno.readTextFile(nestedFile);
    assertEquals(content, "deep");
  } finally {
    w.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("worker: list directory within workspace", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "sandbox-test-" });
  await Deno.writeTextFile(join(tmpDir, "a.txt"), "a");
  await Deno.mkdir(join(tmpDir, "subdir"));

  const w = spawnWorker(tmpDir);
  try {
    w.send({ id: "4", op: "list", args: { path: tmpDir } });
    const resp = await w.receive();
    assertEquals(resp.ok, true);
    assertStringIncludes(resp.result!, "a.txt");
    assertStringIncludes(resp.result!, "subdir/");
  } finally {
    w.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("worker: edit file with unique replacement", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "sandbox-test-" });
  const testFile = join(tmpDir, "edit.txt");
  await Deno.writeTextFile(testFile, "foo bar baz");

  const w = spawnWorker(tmpDir);
  try {
    w.send({
      id: "5",
      op: "edit",
      args: { path: testFile, old_text: "bar", new_text: "qux" },
    });
    const resp = await w.receive();
    assertEquals(resp.ok, true);
    assertStringIncludes(resp.result!, "Edited");

    const content = await Deno.readTextFile(testFile);
    assertEquals(content, "foo qux baz");
  } finally {
    w.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("worker: edit fails when old_text not found", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "sandbox-test-" });
  const testFile = join(tmpDir, "edit2.txt");
  await Deno.writeTextFile(testFile, "foo bar baz");

  const w = spawnWorker(tmpDir);
  try {
    w.send({
      id: "6",
      op: "edit",
      args: { path: testFile, old_text: "MISSING", new_text: "x" },
    });
    const resp = await w.receive();
    assertEquals(resp.ok, false);
    assertStringIncludes(resp.error!, "not found");
  } finally {
    w.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("worker: edit fails when old_text is not unique", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "sandbox-test-" });
  const testFile = join(tmpDir, "edit3.txt");
  await Deno.writeTextFile(testFile, "aaaa");

  const w = spawnWorker(tmpDir);
  try {
    w.send({
      id: "7",
      op: "edit",
      args: { path: testFile, old_text: "aaa", new_text: "bbb" },
    });
    const resp = await w.receive();
    assertEquals(resp.ok, false);
    assertStringIncludes(resp.error!, "more than once");
    assertEquals(await Deno.readTextFile(testFile), "aaaa");
  } finally {
    w.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("worker: read nonexistent file returns error", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "sandbox-test-" });

  const w = spawnWorker(tmpDir);
  try {
    w.send({
      id: "8",
      op: "read",
      args: { path: join(tmpDir, "nope.txt") },
    });
    const resp = await w.receive();
    assertEquals(resp.ok, false);
  } finally {
    w.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("worker: path traversal blocked by app validation", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "sandbox-test-" });

  const w = spawnWorker(tmpDir);
  try {
    w.send({
      id: "9",
      op: "read",
      args: { path: join(tmpDir, "..", "..", "etc", "passwd") },
    });
    const resp = await w.receive();
    assertEquals(resp.ok, false);
    // Either app-level or Deno permission level blocks it
    const errText = resp.error ?? "";
    const isBlocked = errText.includes("Permission denied") ||
      errText.includes("No such file or directory");
    assertEquals(isBlocked, true, `Expected blocked, got: ${errText}`);
  } finally {
    w.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("worker: search files (name search)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "sandbox-test-" });
  await Deno.writeTextFile(join(tmpDir, "test.ts"), "code");
  await Deno.writeTextFile(join(tmpDir, "README.md"), "readme");

  const w = spawnWorker(tmpDir);
  try {
    w.send({
      id: "10",
      op: "search",
      args: { path: tmpDir, pattern: "*.ts" },
    });
    const resp = await w.receive();
    assertEquals(resp.ok, true);
    assertStringIncludes(resp.result!, "test.ts");
  } finally {
    w.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("worker: search files (content search)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "sandbox-test-" });
  await Deno.writeTextFile(join(tmpDir, "data.txt"), "findme needle");

  const w = spawnWorker(tmpDir);
  try {
    w.send({
      id: "11",
      op: "search",
      args: { path: tmpDir, pattern: "needle", content_search: true },
    });
    const resp = await w.receive();
    assertEquals(resp.ok, true);
    assertStringIncludes(resp.result!, "data.txt");
  } finally {
    w.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});
