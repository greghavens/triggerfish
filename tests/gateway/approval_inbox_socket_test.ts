import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { openApprovalInbox } from "../../src/core/approval_inbox.ts";
import type { ApprovalInboxRecord } from "../../src/core/approval_inbox.ts";
import { createToolApprovalService } from "../../src/core/tool_approval_service.ts";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import { computeContentHash } from "../../src/core/session/lineage_serde.ts";
import { GoalCompletionStore } from "../../src/core/goal_completion.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import {
  createDefaultRules,
  createHookRunner,
} from "../../src/core/policy/hooks/hooks.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
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

Deno.test("Owner model goal registration, revision, and completion use exact root approvals after reconnect", async () => {
  const directory = await Deno.makeTempDir();
  const goalPath = join(directory, "goals.db");
  const inbox = createToolApprovalService(join(directory, "tool-approvals.db"));
  const storage = createMemoryStorage();
  const messages = createMessageStore(storage);
  const evidenceResult = "The defensive control is healthy.";
  let evidenceAvailable = true;
  let revokeOnEvidenceRead = false;
  const currentMessages = {
    ...messages,
    async loadSession(sessionId: string) {
      const records = await messages.loadSession(sessionId);
      if (revokeOnEvidenceRead) {
        revokeOnEvidenceRead = false;
        engine.addRule({
          id: "deny-confirm-after-evidence-read",
          priority: 999,
          hook: "PRE_TOOL_CALL",
          conditions: [{
            field: "chat_goal_mutation",
            operator: "equals",
            value: "confirm",
          }],
          action: "BLOCK",
        });
      }
      return evidenceAvailable
        ? records
        : records.filter(({ tool_name }) => tool_name !== "fixture_tool");
    },
  };
  const session = createSession({
    userId: "owner" as UserId,
    channelId: "daemon" as ChannelId,
  });
  const registry = createProviderRegistry();
  const originalId = crypto.randomUUID();
  const reviseId = crypto.randomUUID();
  const initial = {
    action: "register",
    requestId: originalId,
    goal: "Verify the initial defensive control.",
    policy: "automatic",
    criteria: [{
      id: "check",
      description: "Verify the control.",
      tool: "fixture_tool",
      resultSha256: await computeContentHash(evidenceResult),
    }],
  };
  let proposed: Record<string, unknown> = initial;
  let proposedTool = "goal_report";
  let result = "";
  const registered: string[] = [];
  registry.register({
    name: "owner-goal-fixture",
    supportsStreaming: false,
    complete(history, tools) {
      const event = history.at(-1);
      const done = event?.role === "tool";
      if (done) result = String(event.content);
      else {assert(
          tools?.some((tool) =>
            (tool as { function?: { name: string } }).function?.name ===
              "goal_report"
          ),
        );}
      return Promise.resolve({
        content: done ? "Goal operation complete." : "",
        toolCalls: done ? [] : [{
          id: crypto.randomUUID(),
          type: "function",
          function: {
            name: proposedTool,
            arguments: JSON.stringify(proposed),
          },
        }],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
  });
  registry.setDefault("owner-goal-fixture");
  const engine = createPolicyEngine();
  for (const rule of createDefaultRules()) engine.addRule(rule);
  const hooks = createHookRunner(engine);
  const chat = createChatSession({
    session,
    providerRegistry: registry,
    messageStore: currentMessages,
    tools: [{
      name: "fixture_tool",
      description: "Read fixture health.",
      parameters: {},
    }],
    toolExecutor: () => Promise.resolve(evidenceResult),
    goalCompletionPath: goalPath,
    hookRunner: {
      ...hooks,
      toolApprovalInbox: inbox,
      evaluateHook(hook, input) {
        if (
          hook === "POST_TOOL_RESPONSE" &&
          typeof input.input.tool_response === "string"
        ) {
          try {
            const goal = JSON.parse(input.input.tool_response).goal;
            if (typeof goal === "string") registered.push(goal);
          } catch { /* Direct policy denial responses are plain text. */ }
        }
        return hooks.evaluateHook(hook, input);
      },
    },
    enableStreaming: false,
  });
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({ port: 0, token, chatSession: chat });
  const { port } = await gateway.start();
  let owner = await openSocket(port, token);
  const store = new GoalCompletionStore(goalPath);
  const family = `chat:${session.id}`;
  const send = () =>
    owner.socket.send(
      JSON.stringify({ type: "message", content: "Review this goal change." }),
    );
  async function waitRecord(
    predicate: (record: ApprovalInboxRecord) => boolean,
  ) {
    const deadline = Date.now() + 2000;
    do {
      const page = await owner.request({
        type: "approval_inbox_list",
        requestId: crypto.randomUUID(),
      });
      assertEquals(page.ok, true);
      assert(!JSON.stringify(page).includes(String(proposed.goal)));
      const record = (page.result as { records: ApprovalInboxRecord[] }).records
        .find(predicate);
      if (record) return record;
      await new Promise((resolve) => setTimeout(resolve, 5));
    } while (Date.now() < deadline);
    throw new Error("Owner goal request did not enter approval inbox");
  }
  function decide(record: ApprovalInboxRecord, approved: boolean) {
    return owner.request({
      type: "approval_inbox_decide",
      requestId: crypto.randomUUID(),
      approvalId: record.id,
      approved,
    });
  }
  async function apply(approved = true) {
    result = "";
    const ended = owner.next(({ type }) => type === "turn_end");
    send();
    const pending = await waitRecord(({ tool, status }) =>
      tool === "goal_report" && status === "pending"
    );
    assertEquals((await decide(pending, approved)).ok, true);
    await ended;
    return pending;
  }
  try {
    send();
    const first = await waitRecord(({ status }) => status === "pending");
    assertEquals(first.chatGoal, {
      action: "register",
      requestId: originalId,
      criterionCount: 1,
    });
    assertEquals(store.readRegistration(family), undefined);
    await owner.close();
    owner = await openSocket(port, token);
    assertEquals(
      (await waitRecord(({ id }) => id === first.id)).status,
      "pending",
    );
    assertEquals((await decide(first, true)).ok, true);
    const finished = await waitRecord(({ id, status }) =>
      id === first.id && status === "completed"
    );
    assertEquals(store.readRegistration(family)?.requestId, originalId);
    assertEquals(finished.dispatchOutcome, "returned");
    assertEquals((await decide(first, true)).result, finished);
    assertEquals(registered, [initial.goal]);

    proposed = {
      ...initial,
      action: "revise",
      requestId: reviseId,
      expectedRequestId: originalId,
      goal: "Verify a revised defensive control.",
      policy: "operator",
    };
    const declined = await apply(false);
    assertEquals(declined.chatGoal, {
      action: "revise",
      requestId: reviseId,
      expectedRequestId: originalId,
      criterionCount: 1,
    });
    assertEquals(store.readRegistration(family)?.requestId, originalId);

    const interrupted = owner.next(({ type }) => type === "turn_end");
    send();
    const held = await waitRecord(({ status }) => status === "pending");
    engine.addRule({
      id: "late-goal-deny",
      priority: 999,
      hook: "PRE_TOOL_CALL",
      conditions: [{
        field: "tool_name",
        operator: "equals",
        value: "goal_report",
      }],
      action: "BLOCK",
    });
    assertEquals((await decide(held, true)).ok, true);
    await interrupted;
    assertEquals(store.readRegistration(family)?.requestId, originalId);
    engine.removeRule("late-goal-deny");
    await apply();
    const revised = store.readRegistration(family);
    assertEquals(revised?.requestId, reviseId);
    assertEquals(revised?.revisesRequestId, originalId);
    assertEquals(
      store.readRegistration(family, originalId)?.record.goal,
      initial.goal,
    );
    await apply();
    assertEquals(store.readRegistration(family), revised);
    proposed = { ...proposed, requestId: crypto.randomUUID() };
    await apply();
    assertStringIncludes(result, "no longer current");
    assertEquals(store.readRegistration(family), revised);
    const turn = async (name: string, args = {}) => {
      proposedTool = name;
      proposed = args;
      result = "";
      const ended = owner.next(({ type }) => type === "turn_end");
      send();
      await ended;
      return result;
    };
    assertEquals(store.readRegistration(family)?.record.status, "open");
    assertEquals(await turn("fixture_tool"), evidenceResult);
    const proof = JSON.parse(await turn("goal_report", { criterion: "check" }));
    assertEquals(proof.status, "awaiting_confirmation");
    assertEquals(proof.confirmation.requestId, reviseId);
    const exact = { action: "confirm", ...proof.confirmation };
    proposed = { ...exact, decisionSha256: "0".repeat(64) };
    await apply();
    assertStringIncludes(result, "no longer current");
    assertEquals(
      store.readRegistration(family)?.record.status,
      "awaiting_confirmation",
    );

    proposed = exact;
    const denied = await apply(false);
    assertEquals(denied.chatGoal, exact);
    assertEquals(
      store.readRegistration(family)?.record.status,
      "awaiting_confirmation",
    );
    evidenceAvailable = false;
    await apply();
    assertStringIncludes(result, "evidence could not be reverified");
    assertEquals(
      store.readRegistration(family)?.record.status,
      "awaiting_confirmation",
    );
    evidenceAvailable = true;

    const policyDeniedEnd = owner.next(({ type }) => type === "turn_end");
    send();
    const heldConfirmation = await waitRecord(({ status }) =>
      status === "pending"
    );
    revokeOnEvidenceRead = true;
    assertEquals((await decide(heldConfirmation, true)).ok, true);
    await policyDeniedEnd;
    assertEquals(revokeOnEvidenceRead, false);
    assertStringIncludes(result, "no longer current");
    assertEquals(
      store.readRegistration(family)?.record.status,
      "awaiting_confirmation",
    );
    engine.removeRule("deny-confirm-after-evidence-read");

    send();
    const confirm = await waitRecord(({ chatGoal, status }) =>
      chatGoal?.action === "confirm" && status === "pending"
    );
    assertEquals(confirm.chatGoal, exact);
    assertEquals(
      store.readRegistration(family)?.record.status,
      "awaiting_confirmation",
    );
    assert(!JSON.stringify(confirm).includes(evidenceResult));
    await owner.close();
    owner = await openSocket(port, token);
    assertEquals(
      (await waitRecord(({ id }) => id === confirm.id)).status,
      "pending",
    );
    assertEquals((await decide(confirm, true)).ok, true);
    const confirmedApproval = await waitRecord(({ id, status }) =>
      id === confirm.id && status === "completed"
    );
    const finishedGoal = store.readRegistration(family)?.record;
    assertEquals(finishedGoal?.status, "completed");
    assertEquals(finishedGoal?.observations, proof.observations);
    assertEquals((await decide(confirm, true)).result, confirmedApproval);
    assertEquals(store.readRegistration(family)?.record, finishedGoal);
    await apply();
    assertEquals(store.readRegistration(family)?.record, finishedGoal);
  } finally {
    store.close();
    await owner.close();
    await gateway.stop();
    await storage.close();
    await Deno.remove(directory, { recursive: true });
  }
});

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
  let holdResponse = true;
  const releaseResponse = Promise.withResolvers<void>();
  let policyRecheck:
    | {
      entered: ReturnType<typeof Promise.withResolvers<void>>;
      release: ReturnType<typeof Promise.withResolvers<void>>;
    }
    | undefined;
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
      async evaluateHook(hook, { input }) {
        if (hook === "POST_TOOL_RESPONSE" && holdResponse) {
          await releaseResponse.promise;
        }
        const waiting = hook === "PRE_TOOL_CALL" &&
          (input.tool_call as { name?: string } | undefined)?.name === tool;
        if (waiting && policyRecheck) {
          policyRecheck.entered.resolve();
          await policyRecheck.release.promise;
        }
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
  let approver: Awaited<ReturnType<typeof openSocket>> | undefined;
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
    const returned = await waitRecord(
      owner,
      ({ id, status, handlerReturnedAt }) =>
        id === first.id && status === "claimed" &&
        handlerReturnedAt !== undefined,
    );
    assertEquals(returned.dispatchOutcome, undefined);
    assertEquals(invoked, [argument]);
    await owner.close();
    owner = await openSocket(port, token);
    assertEquals((await page(owner))[0], returned);
    holdResponse = false;
    releaseResponse.resolve();
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

    forcePolicyDeny = false;
    owner.socket.send(JSON.stringify({
      type: "message",
      content: "Record this fixture while switching sockets.",
    }));
    const switching = await waitRecord(
      owner,
      ({ status }) => status === "pending",
    );
    policyRecheck = {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    approver = await openSocket(port, token);
    assertEquals((await decide(approver, switching.id, true)).ok, true);
    await policyRecheck.entered.promise;
    await owner.close();
    assertEquals((await decide(approver, switching.id, true)).ok, true);
    policyRecheck.release.resolve();
    const settled = await waitRecord(
      approver,
      ({ id, status }) =>
        id === switching.id && (status === "completed" || status === "stale"),
    );
    assertEquals(settled.status, "completed");
    assertEquals(invoked, [argument, argument]);
  } finally {
    releaseResponse.resolve();
    policyRecheck?.release.resolve();
    await approver?.close();
    await owner?.close();
    await original.close();
    await gateway.stop();
    await Deno.remove(directory, { recursive: true });
  }
});
