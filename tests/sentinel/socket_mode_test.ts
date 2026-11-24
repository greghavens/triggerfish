import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import type { ChatEvent } from "../../src/core/types/chat_event.ts";
import { createSentinelSocketMode } from "../../src/gateway/sentinel_socket_mode.ts";

import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";

Deno.test("Slash toggles change contexts and a normal chat can create an isolated worker", async () => {
  let contextResets = 0;
  const created: boolean[] = [];
  const cleared: boolean[] = [];
  const events: ChatEvent[] = [];
  const signal = new AbortController().signal;
  const mode = createSentinelSocketMode("operator-snapshot.json", {
    clearContext() {
      contextResets++;
      return Promise.resolve();
    },
    createAgent(worker = false) {
      created.push(worker);
      return {
        execute(content, send) {
          send({ type: "response", text: String(content) });
          return Promise.resolve();
        },
        clear() {
          cleared.push(worker);
        },
      };
    },
  });
  const handle = (content: string) =>
    mode.handle(content, (event) => events.push(event), signal);

  assertEquals(await handle("ordinary message"), false);
  assertEquals(await handle("/sentinel-agent summarize evidence"), true);
  assertEquals(created, [true]);
  assertEquals(cleared, [true]);
  assertEquals(mode.active, false);

  assertEquals(await handle("/sentinel"), true);
  assertEquals(mode.active, true);
  assertEquals(await handle("path origin target"), true);
  assertStringIncludes(
    JSON.stringify(events.at(-1)),
    "snapshot is unavailable",
  );
  assertEquals(created, [true]);
  assertEquals(await handle("summarize recent observations"), true);
  assertEquals(await handle("follow up"), true);
  assertEquals(created, [true, false]);
  assertEquals(await handle("/sentinel"), true);
  assertEquals(mode.active, false);
  assertEquals(cleared, [true, false]);
  assertEquals(contextResets, 2);
  assertEquals(events.filter((event) => event.type === "sentinel_mode"), [
    { type: "sentinel_mode", active: true },
    { type: "sentinel_mode", active: false },
  ]);
  assertEquals(await handle("ordinary message"), false);
});

Deno.test("Unauthenticated chat has no access to Sentinel", async () => {
  const mode = createSentinelSocketMode();
  const sent: ChatEvent[] = [];
  const handled = await mode.handle(
    "/sentinel",
    (event) => sent.push(event),
    new AbortController().signal,
  );
  assertEquals(handled, true);
  assertEquals(mode.active, false);
  assertStringIncludes(JSON.stringify(sent), "authenticated operator chat");
});

function readTurn(socket: WebSocket, content: string): Promise<ChatEvent[]> {
  return new Promise((resolve, reject) => {
    const events: ChatEvent[] = [];
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("Sentinel WebSocket turn timed out"));
    }, 3000);

    function onMessage(event: MessageEvent) {
      const message = JSON.parse(event.data as string) as ChatEvent | {
        type: "turn_end";
      };
      if (message.type === "turn_end") {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        resolve(events);
        return;
      }
      events.push(message);
    }

    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ type: "message", content }));
  });
}

Deno.test("Gateway chat routes a slash switch and graph query over an authenticated WebSocket", async () => {
  const directory = await Deno.makeTempDir();
  const path = directory + "/sentinel.json";
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      version: 1,
      nodes: [{
        id: "finding",
        kind: "finding",
        label: "Misconfiguration",
        severity: "high",
      }],
      edges: [],
    }),
  );
  let normalTurns = 0;
  let clears = 0;
  const chat = {
    sentinelSnapshotPath: path,
    clearForSentinelMode() {
      clears++;
      return Promise.resolve();
    },
    executeAgentTurn() {
      normalTurns++;
      return Promise.resolve();
    },
    getMcpStatus: () => null,
    bumpersEnabled: true,
    loadChatHistory: () => Promise.resolve([]),
  } as unknown as ChatSession;
  const gateway = createGatewayServer({
    port: 0,
    token: "mock-token",
    chatSession: chat,
  });
  let socket: WebSocket | undefined;
  try {
    const { port } = await gateway.start();
    socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=mock-token`);
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener("open", () => resolve(), { once: true });
      socket!.addEventListener("error", reject, { once: true });
    });

    const switched = await readTurn(socket, "/sentinel");
    assertEquals(
      switched.some((event) => event.type === "sentinel_mode" && event.active),
      true,
    );
    assertStringIncludes(
      JSON.stringify(await readTurn(socket, "report")),
      "Misconfiguration",
    );
    assertStringIncludes(
      JSON.stringify(
        await readTurn(socket, "/sentinel path finding finding 0"),
      ),
      "Misconfiguration",
    );
    const original = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, original);
    const task = readAdaptiveSentinel(path, original)!.tasks.find(({ kind }) =>
      kind === "review_finding"
    )!;
    const updated = (await Deno.readTextFile(path)).replace(
      "Misconfiguration",
      "Updated finding",
    );
    await Deno.writeTextFile(path, updated);
    assertEquals(
      refreshSentinelAssessment(path)!.revision,
      original.revision + 1,
    );
    const historical = await readTurn(
      socket,
      `/sentinel path --provenance --revision ${original.revision} task:adaptive:${task.id} finding:finding 2 outgoing`,
    );
    const response = historical.find(({ type }) => type === "response");
    if (response?.type !== "response") {
      throw new Error("Expected a provenance response");
    }
    const saved = JSON.parse(response.text.split("\n").slice(1, -1).join("\n"));
    assertEquals(saved.revision, original.revision);
    assertEquals(
      saved.path.edges.map(({ relation }: { relation: string }) => relation),
      ["produces", "references"],
    );
    assertEquals(saved.path.nodes.at(-1).label, "Misconfiguration");
    const provenanceQuery = async (command: string) => {
      const turn = await readTurn(socket!, command);
      const reply = turn.find((event) => event.type === "response");
      if (reply?.type !== "response") {
        throw new Error("Expected a provenance response");
      }
      return JSON.parse(reply.text.split("\n").slice(1, -1).join("\n"));
    };
    const found = await provenanceQuery(
      `/sentinel provenance find --revision ${original.revision} --limit 1 review_finding`,
    );
    assertEquals(found.nodes[0].id, `task:adaptive:${task.id}`);
    const record = await provenanceQuery(
      `/sentinel provenance show --revision ${original.revision} --limit 1 ${
        found.nodes[0].id
      }`,
    );
    assertEquals(record.node.id, found.nodes[0].id);
    assertEquals(record.nextOffset, 1);
    const next = await provenanceQuery(
      `provenance show --revision ${original.revision} --offset 1 --limit 1 ${
        found.nodes[0].id
      }`,
    );
    assertEquals(next.offset, 1);
    assertEquals(next.connections.length, 1);
    assert(next.connections[0].relation !== record.connections[0].relation);
    assertEquals(normalTurns, 0);
    await readTurn(socket, "/sentinel");
    await readTurn(socket, "normal chat");
    assertEquals(normalTurns, 1);
    assertEquals(clears, 2);
  } finally {
    socket?.close();
    await gateway.stop();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Sentinel socket binds graph reads and fresh workers to the selected case", async () => {
  const dir = await Deno.makeTempDir();
  const main = dir + "/main.json";
  const named = dir + "/named.json";
  for (
    const [path, label] of [[main, "Main finding"], [named, "Named finding"]]
  ) {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{ id: "record", kind: "finding", label, severity: "high" }],
        edges: [],
      }),
    );
  }
  const agents: { worker: boolean; path?: string }[] = [];
  let clears = 0;
  let namedAvailable = true;
  const mode = createSentinelSocketMode(main, {
    resolveCase: (id) => id === "named" && namedAvailable ? named : undefined,
    clearContext: () => {
      clears++;
      return Promise.resolve();
    },
    createAgent(worker = false, path) {
      agents.push({ worker, path });
      return {
        execute(_content, send) {
          send({ type: "response", text: "Reviewed" });
          return Promise.resolve();
        },
        clear() {},
      };
    },
  });
  const turn = async (text: string) => {
    const events: ChatEvent[] = [];
    await mode.handle(
      text,
      (event) => events.push(event),
      new AbortController().signal,
    );
    return JSON.stringify(events);
  };
  try {
    assertStringIncludes(
      await turn("/sentinel case named"),
      "Turn on Sentinel",
    );
    await turn("/sentinel on");
    await turn("Summarize the main assessment.");
    assertStringIncludes(
      await turn("/sentinel case named"),
      "Sentinel case: named.",
    );
    assertStringIncludes(await turn("report"), "Named finding");
    await turn("Summarize this case.");
    await turn("/sentinel-agent Review the case.");
    assertEquals(agents, [
      { worker: false, path: main },
      { worker: false, path: named },
      { worker: true, path: named },
    ]);
    assertEquals(clears, 2);
    assertStringIncludes(
      await turn("/sentinel case ../main"),
      "case is unavailable",
    );
    namedAvailable = false;
    assertStringIncludes(
      await turn("/sentinel path record record 0"),
      "case is unavailable",
    );
    await turn("/sentinel off");
    assertEquals(mode.active, false);
    await turn("/sentinel-agent Review the main case.");
    assertEquals(agents.at(-1), { worker: true, path: main });
  } finally {
    mode.reset();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Sentinel assessment chat uses the selected case language without changing structured data", async () => {
  const dir = await Deno.makeTempDir();
  const main = dir + "/main.json";
  const named = dir + "/named.json";
  let language: "es" | "ja" = "es";
  const mode = createSentinelSocketMode(main, {
    resolveCase: (id) => id === "named" ? named : undefined,
    readOutputLanguage: (path) => path === named ? language : undefined,
  });
  async function turn(text: string) {
    const events: ChatEvent[] = [];
    await mode.handle(
      text,
      (event) => events.push(event),
      new AbortController().signal,
    );
    const reply = events.find((event) => event.type === "response");
    assert(reply);
    return reply.text;
  }
  try {
    await turn("/sentinel on");
    assertEquals(
      await turn("assessment status"),
      "There is no Sentinel assessment. Use `assessment start`.",
    );
    assertEquals(
      await turn("/sentinel case named"),
      "Caso de Sentinel: named.",
    );
    assertStringIncludes(await turn("help"), "Comandos de Sentinel");
    assertStringIncludes(await turn("help"), "trace NODE [DEPTH]");
    assertStringIncludes(await turn("report"), "La instantánea de Sentinel");
    assertStringIncludes(
      await turn("provenance find record"),
      "La revisión de Sentinel solicitada",
    );
    await Deno.writeTextFile(
      named,
      JSON.stringify({
        version: 1,
        nodes: [{
          id: "record",
          kind: "finding",
          label: "Source label",
          severity: "high",
        }],
        edges: [],
      }),
    );
    assertStringIncludes(await turn("report"), '"label": "Source label"');
    assertStringIncludes(
      await turn("assessment status"),
      "No hay una evaluación de Sentinel.",
    );
    const started = await turn("assessment start Review source evidence");
    assertStringIncludes(started, "Estado de la evaluación · Activo");
    assertStringIncludes(started, '"active": true');
    assertStringIncludes(started, '"revision": 1');
    language = "ja";
    assertEquals(
      await turn("assessment pause"),
      "Sentinel の評価を一時停止しました。",
    );
    assertStringIncludes(
      await turn("assessment status"),
      '"pendingInputs": false',
    );
    const currentGraph = await Deno.readTextFile(named);
    await Deno.writeTextFile(named, "{");
    assertStringIncludes(
      await turn("assessment status"),
      '"pendingInputs": true',
    );
    await turn("assessment resume");
    assertStringIncludes(await turn("assessment status"), '"paused": true');
    await Deno.writeTextFile(named, currentGraph);
    assertStringIncludes(await turn("assessment history"), "評価履歴");
    assertStringIncludes(
      await turn("assessment observations"),
      "評価の観察結果",
    );
    assertEquals(
      await turn("assessment resume"),
      "Sentinel の評価を再開しました。",
    );
    assertStringIncludes(await turn("assessment status"), '"paused": false');
    assertEquals(
      await turn("assessment stop"),
      "Sentinel の評価を停止しました。",
    );
  } finally {
    mode.reset();
    await Deno.remove(dir, { recursive: true });
  }
});

for (const boundary of ["reset", "case switch"] as const) {
  Deno.test(`Sentinel ${boundary} clears its worker and drops stale output`, async () => {
    const completion = Promise.withResolvers<void>();
    const events: ChatEvent[] = [];
    let clears = 0;
    const mode = createSentinelSocketMode("operator-snapshot.json", {
      resolveCase: (id) => id === "named" ? "named.json" : undefined,
      createAgent(worker) {
        assert(worker);
        return {
          async execute(_content, send) {
            await completion.promise;
            send({ type: "response", text: "Stale case evidence" });
          },
          clear() {
            clears++;
          },
        };
      },
    });
    const turn = (command: string) =>
      mode.handle(
        command,
        (event) => events.push(event),
        new AbortController().signal,
      );
    if (boundary === "case switch") await turn("/sentinel on");
    const pending = turn("/sentinel-agent Review the saved observations");
    if (boundary === "case switch") {
      await turn("/sentinel case named");
      assertStringIncludes(JSON.stringify(events), "Sentinel case: named.");
    } else {
      mode.reset();
    }
    assertEquals(clears, 1);
    const eventCount = events.length;
    completion.resolve();
    assert(await pending);
    assertEquals(clears, 1);
    assertEquals(events.length, eventCount);
  });
}
