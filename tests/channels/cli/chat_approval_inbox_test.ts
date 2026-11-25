import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dispatchSlashCommand } from "../../../src/channels/cli/chat_commands.ts";
import {
  type ChatReplState,
  respondToEnterKeypress,
} from "../../../src/channels/cli/chat_input.ts";
import { createWsMessageRouter } from "../../../src/channels/cli/chat_ws_router.ts";
import type {
  ChatReplDeps,
  WsRouterDeps,
  WsRouterState,
} from "../../../src/channels/cli/chat_ws_types.ts";
import { createInputHistory } from "../../../src/cli/chat/history.ts";
import type { ScreenManager } from "../../../src/cli/terminal/screen.ts";
import type { LineEditor } from "../../../src/cli/terminal/terminal.ts";
import type { TriggerFishConfig } from "../../../src/core/config.ts";
import { createLogger } from "../../../src/core/logger/logger.ts";

const id = "5749BA0D-0BB5-44C6-AB9E-33957949CF10";
const config = {} as TriggerFishConfig;

function fixture() {
  const sent: Record<string, unknown>[] = [];
  const output: string[] = [];
  const state = { isProcessing: true } as WsRouterState;
  const ws = {
    send: (body: string) => sent.push(JSON.parse(body)),
  } as unknown as WebSocket;
  const screen = {
    writeOutput: (text: string) => output.push(text),
    getTaint: () => "INTERNAL",
    redrawInput: () => {},
  } as unknown as ScreenManager;
  const input = {
    text: "/approvals",
    clear() {
      return this;
    },
  } as unknown as LineEditor;
  const deps: ChatReplDeps = {
    ws,
    screen,
    state,
    getEditor: () => input,
    log: createLogger("fixture"),
  };
  return { deps, input, sent, output };
}

Deno.test("terminal approval commands use an independent socket request while the parent is busy", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { deps, input, sent, output } = fixture();
    const local: ChatReplState = {
      editor: input,
      displayMode: "compact",
      stashedInput: "",
      pendingImages: [],
      lastCtrlCTime: 0,
      isPasting: false,
      inputHistory: createInputHistory(),
    };
    const messageQueue = ["Existing pending ordinary message"];
    const historyFilePath = join(dir, "history");
    assertEquals(
      respondToEnterKeypress(local, deps, {
        config,
        messageQueue,
        historyFilePath,
      }).shouldExit,
      false,
    );
    assertEquals(messageQueue, ["Existing pending ordinary message"]);
    assertEquals(deps.state.isProcessing, true);
    assertEquals(sent[0].type, "approval_inbox_list");
    const options = { config, displayMode: "compact" as const };
    for (
      const command of [
        `/approve ${id}`,
        `/deny ${id}`,
        "/approvals 42",
        "/approve invalid",
        "/deny",
        "/help",
      ]
    ) {
      assert(dispatchSlashCommand(command, deps, options).handled);
    }
    assertEquals(sent.map(({ requestId: _requestId, ...body }) => body), [
      { type: "approval_inbox_list" },
      {
        type: "approval_inbox_decide",
        approvalId: id.toLowerCase(),
        approved: true,
      },
      {
        type: "approval_inbox_decide",
        approvalId: id.toLowerCase(),
        approved: false,
      },
      { type: "approval_inbox_list", before: 42 },
    ]);
    assertEquals(new Set(sent.map(({ requestId }) => requestId)).size, 4);
    assert(output.some((line) => line.includes("/deny UUID")));
    // The native REPL writes command history asynchronously.
    for (let attempts = 0; attempts < 50; attempts++) {
      try {
        await Deno.stat(historyFilePath);
        break;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("terminal approval output keeps the parent turn and queue intact", () => {
  const { deps, output, sent } = fixture();
  const messageQueue = ["parent"];
  const router = createWsMessageRouter(
    {
      ...deps,
      messageQueue,
      isTty: true,
      eventHandler() {
        throw new Error(
          "Inbox must not enter the parent orchestrator event handler",
        );
      },
      resolveConnected() {},
    } satisfies WsRouterDeps,
  );
  router(
    new MessageEvent("message", {
      data: JSON.stringify({
        type: "approval_inbox_result",
        operation: "list",
        requestId: "list-1",
        ok: true,
        result: {
          records: [{
            id: id.toLowerCase(),
            tool: "fixture\x1b",
            status: "completed",
            decision: "approved",
            dispatchOutcome: "returned",
          }],
          nextBefore: 42,
        },
      }),
    }),
  );
  assertEquals(sent, []);
  assertEquals(messageQueue, ["parent"]);
  assert(deps.state.isProcessing);
  assertStringIncludes(output[0], id.toLowerCase());
  assertStringIncludes(output[0], "completed  approved  returned");
  assertStringIncludes(output[0], "/approvals 42");
  assert(!output[0].includes("\x1b"));
});
