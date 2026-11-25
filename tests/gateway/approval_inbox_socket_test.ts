import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { openApprovalInbox } from "../../src/core/approval_inbox.ts";
import type { ApprovalInboxRecord } from "../../src/core/approval_inbox.ts";
import { createToolApprovalService } from "../../src/core/tool_approval_service.ts";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import type { ApprovalInboxSocketService } from "../../src/gateway/approval_inbox_socket.ts";
import type { ChatSession } from "../../src/gateway/chat_session_interface.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";

const scope = "chat:owner";
const sessionId = crypto.randomUUID();

function chatWithInbox(
  approvalInbox: ApprovalInboxSocketService,
  executeAgentTurn: ChatSession["executeAgentTurn"],
) {
  return {
    approvalInbox,
    executeAgentTurn,
    providerName: "fixture",
    modelName: "fixture",
    workspacePath: "",
    sessionTaint: "INTERNAL",
    bumpersEnabled: true,
    loadChatHistory: () => Promise.resolve([]),
  } as unknown as ChatSession;
}

async function openSocket(port: number, token?: string) {
  const suffix = token ? `?token=${token}` : "";
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat${suffix}`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  function next(predicate: (event: Record<string, unknown>) => boolean) {
    const reply = Promise.withResolvers<Record<string, unknown>>();
    const timer = setTimeout(
      () => reply.reject(new Error("No socket response")),
      2000,
    );
    const listener = (event: MessageEvent) => {
      const response = JSON.parse(event.data);
      if (predicate(response)) reply.resolve(response);
    };
    socket.addEventListener("message", listener);
    return reply.promise.finally(() => {
      clearTimeout(timer);
      socket.removeEventListener("message", listener);
    });
  }
  function request(body: Record<string, unknown>) {
    const reply = next((event) =>
      event.type === "approval_inbox_result" &&
      event.requestId === body.requestId
    );
    socket.send(JSON.stringify(body));
    return reply;
  }
  async function close() {
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve(), { once: true })
    );
    socket.close();
    await closed;
  }
  return { socket, next, request, close };
}

Deno.test("authenticated approval inbox lists and decides an exact held request after reconnect", async () => {
  const directory = await Deno.makeTempDir();
  const journal = openApprovalInbox(join(directory, "approval.db"));
  const id = crypto.randomUUID();
  const foreign = crypto.randomUUID();
  const entry = {
    id,
    scope,
    sessionId,
    tool: "workflow_fixture",
    binding: "a".repeat(64),
    expiresAt: Date.now() + 30_000,
  };
  assert(journal.submit({ ...entry, id: foreign, scope: "different:owner" }));
  const started = Promise.withResolvers<AbortSignal>();
  const released = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  let held: AbortSignal | undefined;
  let runs = 0;
  const inbox: ApprovalInboxSocketService = {
    list(limit, before) {
      const page = journal.list(scope, limit, before);
      return {
        ...page,
        records: page.records.map((record) => ({
          ...record,
          binding: "must-not-project",
        })),
      };
    },
    decide(approvalId, decision) {
      const record = journal.decide(scope, approvalId, decision);
      if (record?.id === id && record.status === "approved") released.resolve();
      return record;
    },
    isWaiting: (signal) => signal === held,
  };
  const chat = chatWithInbox(inbox, async (_content, _send, signal) => {
    assertExists(signal);
    ++runs;
    assert(journal.submit(entry));
    held = signal;
    started.resolve(signal);
    await released.promise;
    assert(!signal.aborted);
    held = undefined;
    finished.resolve();
  });
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({ port: 0, token, chatSession: chat });
  const { port } = await gateway.start();
  const initial = await openSocket(port, token);
  let reconnect: Awaited<ReturnType<typeof openSocket>> | undefined;
  try {
    initial.socket.send(
      JSON.stringify({ type: "message", content: "Held tool dispatch" }),
    );
    const signal = await started.promise;
    const same = await initial.request({
      type: "approval_inbox_list",
      requestId: "initial-list",
    });
    assertEquals(same.ok, true);
    await initial.close();
    reconnect = await openSocket(port, token);
    const page = await reconnect.request({
      type: "approval_inbox_list",
      requestId: "reopened-list",
      limit: 1,
    });
    assertEquals(page.ok, true);
    assertEquals(page.result, {
      records: [journal.read(scope, id)],
      nextBefore: null,
    });
    assert(!JSON.stringify(page).includes("must-not-project"));
    const invalid = await reconnect.request({
      type: "approval_inbox_decide",
      requestId: "foreign",
      approvalId: foreign,
      approved: true,
    });
    assertEquals(invalid.ok, false);
    assertEquals(journal.read("different:owner", foreign)?.status, "pending");
    assert(!signal.aborted);
    const decision = await reconnect.request({
      type: "approval_inbox_decide",
      requestId: "approve",
      approvalId: id,
      approved: true,
    });
    assertEquals(decision.ok, true);
    await finished.promise;
    assertEquals(runs, 1);
    assertEquals(journal.read(scope, id)?.status, "approved");
  } finally {
    released.resolve();
    await reconnect?.close();
    await initial.close();
    await gateway.stop();
    journal.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("inbox requires authenticated owner and explicit parent cancellation still aborts a held turn", async () => {
  let reached = Promise.withResolvers<AbortSignal>();
  let listed = 0;
  const inbox: ApprovalInboxSocketService = {
    list() {
      ++listed;
      return { records: [], nextBefore: null };
    },
    decide: () => undefined,
    isWaiting: () => true,
  };
  const chat = chatWithInbox(inbox, async (_content, _send, signal) => {
    assertExists(signal);
    reached.resolve(signal);
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true })
    );
  });
  const anonymous = createGatewayServer({ port: 0, chatSession: chat });
  const address = await anonymous.start();
  const guest = await openSocket(address.port);
  try {
    const denied = await guest.request({
      type: "approval_inbox_list",
      requestId: "guest-list",
    });
    assertEquals(denied.ok, false);
    assertEquals(listed, 0);
  } finally {
    await guest.close();
    await anonymous.stop();
  }
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({ port: 0, token, chatSession: chat });
  const { port } = await gateway.start();
  const owner = await openSocket(port, token);
  try {
    reached = Promise.withResolvers<AbortSignal>();
    owner.socket.send(
      JSON.stringify({ type: "message", content: "Waiting for approval" }),
    );
    const signal = await reached.promise;
    const ended = owner.next(({ type }) => type === "turn_end");
    owner.socket.send(JSON.stringify({ type: "cancel" }));
    await ended;
    assert(signal.aborted);
  } finally {
    await owner.close();
    await gateway.stop();
  }
});

Deno.test("normal gateway tool dispatch resumes one exact approval after reconnect and blocks decline or stale approval", async () => {
  const directory = await Deno.makeTempDir();
  const inbox = createToolApprovalService(join(directory, "approvals.db"));
  const tool = "append_fixture_record";
  const argument = "Fixture content must never appear in approval metadata";
  const invoked: unknown[] = [];
  const registry = createProviderRegistry();
  let calls = 0;
  let forcePolicyDeny = false;
  registry.register({
    name: "approval-fixture",
    supportsStreaming: false,
    complete(messages) {
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (messages.at(-1)?.role === "tool") {
        return Promise.resolve({
          usage,
          content: "The requested fixture turn ended.",
          toolCalls: [],
        });
      }
      return Promise.resolve({
        usage,
        content: "",
        toolCalls: [{
          type: "function",
          id: `fixture-${++calls}`,
          function: {
            name: tool,
            arguments: JSON.stringify({ value: argument }),
          },
        }],
      });
    },
  });
  registry.setDefault("approval-fixture");
  const chat = createChatSession({
    session: createSession({
      userId: "owner" as UserId,
      channelId: "daemon" as ChannelId,
    }),
    providerRegistry: registry,
    hookRunner: {
      toolApprovalInbox: inbox,
      evaluateHook(hook, { input }) {
        const waiting = hook === "PRE_TOOL_CALL" &&
          (input.tool_call as { name?: string } | undefined)?.name === tool;
        return Promise.resolve({
          allowed: !waiting,
          action: waiting
            ? forcePolicyDeny ? "BLOCK" : "REQUIRE_APPROVAL"
            : "ALLOW",
          ruleId: waiting
            ? forcePolicyDeny ? "fixture.deny" : "fixture.approve"
            : null,
          duration: 0,
        });
      },
    },
    tools: [{
      name: tool,
      description: "Append a local fixture record.",
      parameters: { value: { type: "string", description: "Fixture marker" } },
    }],
    toolExecutor(name, input) {
      assertEquals(name, tool);
      invoked.push(input.value);
      return Promise.resolve("Recorded the approved fixture value.");
    },
    enableStreaming: false,
  });
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({ port: 0, token, chatSession: chat });
  const { port } = await gateway.start();
  const original = await openSocket(port, token);
  let owner: Awaited<ReturnType<typeof openSocket>> | undefined;
  let requests = 0;
  async function page(client: typeof original) {
    const reply = await client.request({
      type: "approval_inbox_list",
      requestId: `page-${++requests}`,
    });
    assertEquals(reply.ok, true);
    assert(!JSON.stringify(reply).includes(argument));
    return (reply.result as { records: readonly ApprovalInboxRecord[] })
      .records;
  }
  async function waitRecord(
    client: typeof original,
    predicate: (record: ApprovalInboxRecord) => boolean,
  ) {
    const deadline = Date.now() + 2500;
    do {
      const record = (await page(client)).find(predicate);
      if (record) return record;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    throw new Error("Approval record did not reach its expected status");
  }
  function decide(client: typeof original, id: string, approved: boolean) {
    return client.request({
      type: "approval_inbox_decide",
      requestId: `decision-${++requests}`,
      approvalId: id,
      approved,
    });
  }
  try {
    original.socket.send(
      JSON.stringify({
        type: "message",
        content: "Record confirmed fixture data.",
      }),
    );
    const first = await waitRecord(
      original,
      ({ status }) => status === "pending",
    );
    assertEquals(first.tool, tool);
    assertEquals(invoked, []);
    await original.close();
    owner = await openSocket(port, token);
    assertEquals((await page(owner))[0]?.id, first.id);
    assertEquals((await decide(owner, first.id, true)).ok, true);
    const completed = await waitRecord(
      owner,
      ({ id, status }) => id === first.id && status === "completed",
    );
    assertEquals(completed.id, first.id);
    assertEquals(completed.decision, "approved");
    assertEquals(completed.dispatchOutcome, "returned");
    const retry = await decide(owner, first.id, true);
    assertEquals(retry.ok, true);
    assertEquals(retry.result, completed);
    assertEquals(invoked, [argument]);

    const deniedTurn = owner.next(({ type }) => type === "turn_end");
    owner.socket.send(
      JSON.stringify({ type: "message", content: "Decline this fixture." }),
    );
    const declined = await waitRecord(
      owner,
      ({ id, status }) => id !== first.id && status === "pending",
    );
    assertEquals((await decide(owner, declined.id, false)).ok, true);
    await deniedTurn;
    assertEquals(invoked, [argument]);

    const staleTurn = owner.next(({ type }) => type === "turn_end");
    owner.socket.send(
      JSON.stringify({ type: "message", content: "Cancel this fixture." }),
    );
    const stale = await waitRecord(
      owner,
      ({ id, status }) =>
        id !== first.id && id !== declined.id && status === "pending",
    );
    owner.socket.send(JSON.stringify({ type: "cancel" }));
    await staleTurn;
    await waitRecord(
      owner,
      ({ id, status }) => id === stale.id && status === "stale",
    );
    assertEquals((await decide(owner, stale.id, true)).ok, false);
    assertEquals(invoked, [argument]);

    const changedTurn = owner.next(({ type }) => type === "turn_end");
    owner.socket.send(
      JSON.stringify({
        type: "message",
        content: "Review this previously allowed fixture.",
      }),
    );
    const changed = await waitRecord(
      owner,
      ({ status }) => status === "pending",
    );
    forcePolicyDeny = true;
    assertEquals((await decide(owner, changed.id, true)).ok, true);
    await changedTurn;
    const blocked = await waitRecord(
      owner,
      ({ id, status }) => id === changed.id && status === "stale",
    );
    assertEquals(blocked.decision, "approved");
    assertEquals(invoked, [argument]);
  } finally {
    await owner?.close();
    await original.close();
    await gateway.stop();
    await Deno.remove(directory, { recursive: true });
  }
});
