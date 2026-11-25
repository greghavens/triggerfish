import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { HookType } from "../../src/core/policy/rules.ts";
import { createPathClassifier } from "../../src/core/security/path_classification.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createFilesystemSandbox } from "../../src/exec/sandbox/client.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { buildExecFileDefinitions } from "../../src/gateway/tools/defs/exec_tool_defs.ts";
import {
  modifyFileContent,
  queryFilesystem,
} from "../../src/gateway/tools/executor/executor_filesystem.ts";

Deno.test("Owner gateway validates a batch of file edits before writing through the sandbox", async () => {
  const workspace = await Deno.makeTempDir();
  const path = join(workspace, "fixture.txt");
  const hidden = join(workspace, "hidden.txt");
  await Deno.writeTextFile(path, "one two");
  const sandbox = createFilesystemSandbox({
    resolveWorkspacePath: () => workspace,
  });
  const token = crypto.randomUUID();
  const registry = createProviderRegistry();
  let args: Record<string, unknown> = {};
  let operation = "edit_file";
  let result = "";
  let deny: HookType | undefined;
  let calls = 0;
  const responseTaints: string[] = [];
  registry.register({
    name: "owner-edits-fixture",
    supportsStreaming: false,
    complete(messages, tools) {
      const done = messages.at(-1)?.role === "tool";
      if (done) result = String(messages.at(-1)?.content);
      else {assert(
          tools?.some((tool) =>
            (tool as { function?: { name: string } }).function?.name ===
              "edit_file"
          ),
        );}
      return Promise.resolve({
        content: done ? "File edit complete." : "",
        toolCalls: done ? [] : [{
          id: crypto.randomUUID(),
          type: "function",
          function: { name: operation, arguments: JSON.stringify(args) },
        }],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
  });
  registry.setDefault("owner-edits-fixture");
  const gateway = createGatewayServer({
    port: 0,
    token,
    chatSession: createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "edit-fixture" as ChannelId,
      }),
      providerRegistry: registry,
      tools: buildExecFileDefinitions(),
      enableStreaming: false,
      getWorkspacePath: () => workspace,
      pathClassifier: createPathClassifier({
        paths: new Map([[hidden, "RESTRICTED"], [path, "INTERNAL"]]),
        defaultClassification: "PUBLIC",
      }),
      targetClassification: "INTERNAL",
      toolClassifications: new Map([["edit_file", "INTERNAL"]]),
      hookRunner: {
        evaluateHook(hook, context) {
          if (hook === "POST_TOOL_RESPONSE") {
            responseTaints.push(context.session.taint);
          }
          const exactRejected = hook === "PRE_TOOL_CALL" &&
            context.input.resource_classification === "RESTRICTED";
          const allowed = hook !== deny && !exactRejected;
          return Promise.resolve({
            allowed,
            action: allowed ? "ALLOW" : "BLOCK",
            ruleId: null,
            duration: 0,
          });
        },
      },
      toolExecutor(name, input, context) {
        assertEquals(name, operation);
        calls++;
        return name === "search_files"
          ? queryFilesystem(
            input,
            sandbox,
            context?.authorizeRecursiveSearchFile,
            context?.classifyRecursiveSearchResponse,
          )
          : modifyFileContent(input, sandbox);
      },
    }),
  });
  const { port } = await gateway.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const turn = async (input: Record<string, unknown>) => {
      args = { path, ...input };
      result = "";
      const events: Record<string, unknown>[] = [];
      const done = Promise.withResolvers<void>();
      const receive = ({ data }: MessageEvent) => {
        const event = JSON.parse(data);
        events.push(event);
        if (event.type === "turn_end") done.resolve();
      };
      socket.addEventListener("message", receive);
      const timeout = setTimeout(
        () => done.reject(new Error("No turn end")),
        3000,
      );
      try {
        socket.send(
          JSON.stringify({
            type: "message",
            content: "Edit this fixture file.",
          }),
        );
        await done.promise;
        return { result, events };
      } finally {
        clearTimeout(timeout);
        socket.removeEventListener("message", receive);
      }
    };
    const edits = [
      { old_text: "one", new_text: "first" },
      { old_text: "first two", new_text: "$& done" },
    ];
    deny = "PRE_TOOL_CALL";
    await turn({ edits });
    assertEquals(calls, 0);
    assertEquals(await Deno.readTextFile(path), "one two");
    deny = undefined;
    const missing = await turn({
      edits: [edits[0], { old_text: "missing", new_text: "bad" }],
    });
    assertStringIncludes(missing.result, "Edit 2");
    assertEquals(await Deno.readTextFile(path), "one two");
    assertStringIncludes((await turn({ edits })).result, "Edited");
    assertEquals(await Deno.readTextFile(path), "$& done");
    assertEquals(responseTaints.at(-1), "INTERNAL");
    deny = "POST_TOOL_RESPONSE";
    assertEquals(
      (await turn({ old_text: "done", new_text: "reviewed" })).result,
      "Tool response withheld by policy.",
    );
    assertEquals(await Deno.readTextFile(path), "$& reviewed");
    deny = "PRE_OUTPUT";
    const output = await turn({ old_text: "reviewed", new_text: "checked" });
    assert(!JSON.stringify(output.events).includes("File edit complete."));
    assert(!JSON.stringify(output.events).includes("Edited fixture.txt"));
    assert(!JSON.stringify(output.events).includes(path));

    operation = "search_files";
    deny = undefined;
    await Deno.writeTextFile(path, "context\n-Needle\nlater\n");
    const search = {
      content_search: true,
      pattern: "-needle",
      ignore_case: true,
    };
    assertEquals(
      (await turn({
        ...search,
        path: workspace,
        file_glob: "*.txt",
      })).result,
      "fixture.txt",
    );
    assertEquals(
      (await turn({ ...search, output_mode: "count" })).result,
      "fixture.txt:1",
    );
    assertStringIncludes(
      (await turn({
        ...search,
        output_mode: "content",
        context: 1,
      })).result,
      "fixture.txt:2:-Needle",
    );
    const before = (await turn({
      ...search,
      output_mode: "content",
      before: 1,
    })).result;
    assertStringIncludes(before, "fixture.txt-1-context");
    assert(!before.includes("later"));
    const after = (await turn({
      ...search,
      output_mode: "content",
      after: 1,
    })).result;
    assertStringIncludes(after, "fixture.txt-3-later");
    assert(!after.includes("context"));
    assertStringIncludes(
      (await turn({ ...search, output_mode: "content", before: -1 })).result,
      "Invalid content search options",
    );
    assertStringIncludes(
      (await turn({
        ...search,
        output_mode: "content",
        path: workspace,
      })).result,
      "requires one exact workspace file",
    );
    await Deno.writeTextFile(hidden, "-Needle classified-content\n");
    await Deno.writeTextFile(
      join(workspace, "SPINE.md"),
      "-Needle managed-content\n",
    );
    await Deno.writeTextFile(join(workspace, "next.txt"), "second -Needle\n");
    const legacyDirectory = { ...search, path: workspace, file_glob: "*.txt" };
    const legacy = await turn(legacyDirectory);
    assertEquals(legacy.result, "fixture.txt\nnext.txt");
    assert(!JSON.stringify(legacy.events).includes("hidden.txt"));
    deny = "POST_TOOL_RESPONSE";
    assertEquals(
      (await turn(legacyDirectory)).result,
      "Tool response withheld by policy.",
    );
    deny = undefined;
    const nameSearch = { path: workspace, pattern: "[fhn]*.txt" };
    const names = await turn(nameSearch);
    assertEquals(names.result.split("\n").sort(), ["fixture.txt", "next.txt"]);
    assert(!JSON.stringify(names.events).includes("hidden.txt"));
    deny = "PRE_TOOL_CALL";
    const callsBeforeDeniedSearch = calls;
    await turn(nameSearch);
    assertEquals(calls, callsBeforeDeniedSearch);
    deny = "POST_TOOL_RESPONSE";
    assertEquals(
      (await turn(nameSearch)).result,
      "Tool response withheld by policy.",
    );
    deny = "PRE_OUTPUT";
    const nameOutput = await turn(nameSearch);
    assert(!JSON.stringify(nameOutput.events).includes("next.txt"));
    deny = undefined;
    const recursive = {
      ...search,
      output_mode: "content",
      recursive: true,
      path: workspace,
      limit: 1,
    };
    const firstPage = JSON.parse((await turn(recursive)).result);
    assertEquals(firstPage.matches, ["fixture.txt:2:-Needle"]);
    assertEquals(firstPage.nextOffset, 1);
    const secondPage = JSON.parse(
      (await turn({ ...recursive, offset: 1 })).result,
    );
    assertEquals(secondPage.matches, ["next.txt:1:second -Needle"]);
    assertEquals(secondPage.nextOffset, undefined);
    const counts = JSON.parse(
      (await turn({
        ...recursive,
        output_mode: "count",
        limit: 10,
      })).result,
    );
    assertEquals(counts.matches, ["fixture.txt:1", "next.txt:1"]);
    assertEquals(counts.nextOffset, undefined);
    await Deno.writeTextFile(join(workspace, "view.TSX"), "// -Needle\n");
    await Deno.writeTextFile(join(workspace, "setup.ts"), "// -Needle\n");
    const typedSearch = {
      ...recursive,
      file_type: "typescript",
      output_mode: "files_with_matches",
      limit: 10,
    };
    assertEquals(
      JSON.parse((await turn(typedSearch)).result).matches,
      ["setup.ts", "view.TSX"],
    );
    assertEquals(
      JSON.parse((await turn({ ...typedSearch, file_glob: "*.ts" })).result)
        .matches,
      ["setup.ts"],
    );
    assertStringIncludes(
      (await turn({ ...typedSearch, file_type: "../ts" })).result,
      "Invalid recursive search filter",
    );
    await Deno.writeTextFile(path, "💡 context\n-Needle\nlater\n");
    const multiline = {
      ...recursive,
      pattern: "context.*-needle",
      multiline: true,
      limit: 10,
    };
    assertEquals(
      JSON.parse((await turn(multiline)).result).matches,
      ["fixture.txt:1:💡 context", "fixture.txt:2:-Needle"],
    );
    assertEquals(
      (await turn({
        ...multiline,
        recursive: false,
        path,
        output_mode: "count",
      }))
        .result,
      "fixture.txt:2",
    );
    assertStringIncludes(
      (await turn({
        ...multiline,
        recursive: false,
        path,
        pattern: "(?=later)",
      }))
        .result,
      "Invalid RE2 multiline search pattern",
    );
    deny = "POST_TOOL_RESPONSE";
    assertEquals(
      (await turn(multiline)).result,
      "Tool response withheld by policy.",
    );
    deny = "PRE_OUTPUT";
    const recursiveOutput = await turn(multiline);
    assert(!JSON.stringify(recursiveOutput.events).includes("-Needle"));
    const alias = join(workspace, "alias.txt");
    await Deno.symlink(path, alias);
    assertStringIncludes(
      (await turn({
        ...search,
        output_mode: "content",
        path: alias,
      })).result,
      "requires one exact workspace file",
    );
    deny = "POST_TOOL_RESPONSE";
    assertEquals(
      (await turn({
        ...search,
        output_mode: "content",
      })).result,
      "Tool response withheld by policy.",
    );
  } finally {
    socket.close();
    await gateway.stop();
    await sandbox.shutdown();
    await Deno.remove(workspace, { recursive: true });
  }
});
