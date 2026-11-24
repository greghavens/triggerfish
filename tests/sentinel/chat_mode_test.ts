import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  handleSentinelChatTurn,
  readSentinelChatSnapshot,
} from "../../src/sentinel/chat_mode.ts";

const snapshot = {
  version: 1,
  nodes: [
    {
      id: "primary db",
      kind: "asset",
      label: "<b>Production ``` database</b>",
    },
    { id: "app", kind: "asset", label: "Application" },
    { id: "v1", kind: "finding", label: "Missing update", severity: "high" },
  ],
  edges: [
    { from: "app", to: "primary db", relation: "depends_on" },
    { from: "v1", to: "app", relation: "affects" },
  ],
};
const readSnapshot = () => Promise.resolve(snapshot);

Deno.test("Sentinel chat mode toggles per supplied session state", async () => {
  assertEquals(
    await handleSentinelChatTurn("normal chat", false, readSnapshot),
    undefined,
  );
  const active = await handleSentinelChatTurn("/sentinel", false, readSnapshot);
  assertEquals(active?.enabled, true);
  assertStringIncludes(active?.response ?? "", "Sentinel commands");
  assertEquals(
    await handleSentinelChatTurn("/sentinel status", true, readSnapshot),
    { enabled: true, response: "Sentinel mode is on." },
  );
  assertEquals(
    await handleSentinelChatTurn("/sentinel", true, readSnapshot),
    { enabled: false, response: "Sentinel mode is off." },
  );
  assertEquals(
    (await handleSentinelChatTurn("/sentinel on", false, readSnapshot))
      ?.enabled,
    true,
  );
  assertEquals(
    (await handleSentinelChatTurn("/sentinel off", true, readSnapshot))
      ?.enabled,
    false,
  );
});

Deno.test("Sentinel chat limits the active mode to read-only graph commands", async () => {
  let reads = 0;
  const read = () => {
    reads++;
    return readSnapshot();
  };
  for (
    const command of ["cat /etc/passwd", "report other.json", "trace app 11"]
  ) {
    const turn = await handleSentinelChatTurn(command, true, read);
    assertStringIncludes(turn?.response ?? "", "Enter a Sentinel command");
  }
  assertEquals(reads, 0);
  for (
    const [command, expected] of [
      ["report", '"v1"'],
      ["coverage", '"withoutEvidenceLink": 1'],
      ['impact "primary db" 1', '"app"'],
      ["trace app 1", '"primary db"'],
    ]
  ) {
    const turn = await handleSentinelChatTurn(command, true, read);
    assertStringIncludes(turn?.response ?? "", expected);
  }
  assertEquals(reads, 4);
});

Deno.test("Sentinel chat paths support quoted IDs, depth and relationship direction", async () => {
  const run = async (command: string) => {
    const turn = await handleSentinelChatTurn(command, true, readSnapshot);
    return JSON.parse(turn!.response.split("\n").slice(1, -1).join("\n")).path;
  };
  const forward = await run('/sentinel path v1 "primary db" 2 outgoing');
  assertEquals(forward.nodes.map(({ id }: { id: string }) => id), [
    "v1",
    "app",
    "primary db",
  ]);
  assertEquals(
    await run('path v1 "primary db" 2 outgoing --relation depends_on'),
    null,
  );
  const mixedPath = await run(
    'path v1 "primary db" 2 outgoing --relation affects,depends_on',
  );
  assertEquals(mixedPath.edges, forward.edges);
  const dependencyPath = await run(
    'path app "primary db" --relation depends_on',
  );
  assertEquals(dependencyPath.edges, [snapshot.edges[0]]);
  const reverse = await run('path "primary db" v1 incoming');
  assertEquals(reverse.edges, [...forward.edges].reverse());
  const alternatives = await handleSentinelChatTurn(
    'path app "primary db" --limit 2',
    true,
    readSnapshot,
  );
  assertEquals(
    JSON.parse(alternatives!.response.split("\n").slice(1, -1).join("\n")),
    {
      paths: [dependencyPath],
      truncated: false,
    },
  );
  assertEquals(await run('path v1 "primary db" 1'), null);
  assertEquals(await run('path v1 "primary db" incoming'), null);
  assertStringIncludes(
    (await handleSentinelChatTurn("path app missing", true, readSnapshot))!
      .response,
    "endpoint is unavailable",
  );
});

Deno.test("Sentinel chat sanitizes display escapes and suppresses snapshot paths", async () => {
  const trace = await handleSentinelChatTurn(
    'trace "primary db" 0',
    true,
    readSnapshot,
  );
  const content = trace?.response ?? "";
  assertStringIncludes(content, "\\u003cb\\u003e");
  assertStringIncludes(content, "\\u0060\\u0060\\u0060");
  const result = JSON.parse(content.split("\n").slice(1, -1).join("\n"));
  assertEquals(result.nodes[0].label, snapshot.nodes[0].label);

  const unavailable = await handleSentinelChatTurn(
    "report",
    true,
    () => Promise.reject(new Error("Failed to open /private/managed/path")),
  );
  assertEquals(
    unavailable?.response,
    "The operator-managed Sentinel snapshot is unavailable or invalid.",
  );
});

Deno.test("Sentinel chat reads bounded regular snapshot files", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = dir + "/sentinel.json";
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    assertEquals(await readSentinelChatSnapshot(path), snapshot);
    await Deno.writeFile(path, new Uint8Array(1024 * 1024 + 1));
    await assertRejects(() => readSentinelChatSnapshot(path), Error, "1 MiB");
    await assertRejects(() => readSentinelChatSnapshot(dir), Error, "regular");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
