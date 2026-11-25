import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { executeOperatorRunArchive } from "../../src/gateway/operator_run_archive.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { createHash } from "node:crypto";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import {
  type AgentRecoveryPolicy,
  runRecoverableAgentTurn,
} from "../../src/gateway/agent_recovery.ts";
import {
  type ChannelId,
  createSession,
  restoreSession,
  type SessionId,
  type SessionState,
  type UserId,
} from "../../src/core/types/session.ts";
import {
  computeHmac,
  createCronManager,
  createSchedulerService,
  openSchedulerCronAdmissions,
  openSchedulerTriggerAdmissions,
  type SchedulerExecutionIdentity,
  type SchedulerServiceConfig,
} from "../../src/scheduler/mod.ts";
import { tickCronJobs } from "../../src/scheduler/service_cron.ts";
import {
  createScheduledAgent,
  schedulerExecutionIdentity,
  schedulerRecoveryState,
} from "../../src/scheduler/service_execution.ts";

async function restoreScheduledFixture(directory: string, id: string) {
  const ref = { kind: "scheduled", id } as const;
  const archiveId = crypto.randomUUID();
  const confirm = () => Promise.resolve(true);
  const archived = await executeOperatorRunArchive(directory, ref, {
    action: "archive",
    ...ref,
    requestId: archiveId,
  }, confirm);
  assert(typeof archived !== "string");
  assertEquals((archived.receipt as { status: string }).status, "succeeded");
  const kind = id.split("-")[1];
  for (
    const name of [
      "agent-recovery.db",
      "execution-traces.db",
      `scheduler-${kind}-admissions.db`,
    ]
  ) {
    await Deno.rename(
      join(directory, name),
      join(directory, "original-" + name),
    );
  }
  const restored = await executeOperatorRunArchive(directory, ref, {
    action: "restore",
    ...ref,
    archiveId,
    requestId: crypto.randomUUID(),
  }, confirm);
  assert(typeof restored !== "string");
  assertEquals((restored.receipt as { status: string }).status, "succeeded");
}

async function resumeThroughGateway(
  service: ReturnType<typeof createSchedulerService>,
  id: string,
) {
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({
    port: 0,
    token,
    schedulerService: service,
  });
  const { port } = await gateway.start();
  const endpoint = `http://127.0.0.1:${port}/recovery/scheduled/${id}`;
  try {
    const denied = await fetch(endpoint, { method: "POST" });
    assertEquals(denied.status, 401);
    await denied.text();
    for (const status of [200, 409]) {
      const reply = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      assertEquals(reply.status, status);
      await reply.json();
    }
  } finally {
    await gateway.stop();
  }
}

async function ownerScheduledControl(
  directory: string,
  id: string,
  action: "pause" | "resume",
  service?: ReturnType<typeof createSchedulerService>,
) {
  const registry = createProviderRegistry();
  let result = "";
  registry.register({
    name: "scheduled-owner-fixture",
    supportsStreaming: false,
    complete(messages) {
      const tool = messages.findLast(({ role }) => role === "tool");
      if (tool) result = String(tool.content);
      return Promise.resolve({
        content: tool ? "Received the control result." : "",
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: tool ? [] : [{
          id: "scheduled-control",
          type: "function",
          function: {
            name: "operator_runs",
            arguments: JSON.stringify({ action, kind: "scheduled", id }),
          },
        }],
      });
    },
  });
  registry.setDefault("scheduled-owner-fixture");
  const chatSession = createChatSession({
    session: createSession({
      userId: "owner" as UserId,
      channelId: "owner" as ChannelId,
      bumpersEnabled: false,
    }),
    providerRegistry: registry,
    hookRunner: {
      evaluateHook: () =>
        Promise.resolve({
          allowed: true,
          action: "ALLOW",
          ruleId: null,
          duration: 0,
        }),
    },
    toolExecutor: () => Promise.reject(new Error("Unexpected fixture tool")),
    enableStreaming: false,
    operatorRunExecutor: createOperatorRunToolExecutor({
      baseDir: directory,
      resumeScheduledExecution: service?.resumeScheduledExecution,
      confirm: () => Promise.resolve(true),
    }),
  });
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({ port: 0, token, chatSession });
  const { port } = await gateway.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  const done = Promise.withResolvers<void>();
  const timer = setTimeout(
    () => done.reject(new Error("No owner gateway turn_end")),
    3000,
  );
  try {
    socket.addEventListener(
      "open",
      () =>
        socket.send(
          JSON.stringify({
            type: "message",
            content: "Control scheduled run.",
          }),
        ),
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => done.reject(new Error("Owner socket failed")),
      { once: true },
    );
    socket.addEventListener("message", ({ data }) => {
      if (JSON.parse(data).type === "turn_end") done.resolve();
    });
    await done.promise;
    return JSON.parse(result).run;
  } finally {
    clearTimeout(timer);
    socket.close();
    await gateway.stop();
  }
}

function harness(triggerMdPath: string) {
  const sessions = new Map<string, SessionState>();
  const executions: {
    identity: SchedulerExecutionIdentity;
    sessionId: string;
  }[] = [];
  const deliveries: string[] = [];
  const completed = new Set<string>();
  let modelCalls = 0;
  let skipWebhook = false;
  const config: SchedulerServiceConfig = {
    orchestratorFactory: {
      create(channelId, opts) {
        const id = opts?.recoverySessionId;
        assert(id);
        let session = sessions.get(channelId);
        if (!session) {
          session = restoreSession({
            id,
            userId: "fixture" as UserId,
            channelId: channelId as ChannelId,
          });
          sessions.set(channelId, session);
        }
        return Promise.resolve({
          session,
          getSessionTaint: () => "INTERNAL" as const,
          toolExecutor: () => Promise.resolve(""),
          orchestrator: {
            executeAgentTurn() {
              modelCalls++;
              return Promise.resolve({
                ok: true as const,
                value: {
                  response: "Completed once",
                  tokenUsage: { inputTokens: 1, outputTokens: 1 },
                },
              });
            },
            getHistory: () => [],
            clearHistory() {},
            compactHistory: () =>
              Promise.resolve({
                messagesBefore: 0,
                messagesAfter: 0,
                tokensBefore: 0,
                tokensAfter: 0,
              }),
          },
        });
      },
    },
    recoverTurn(identity, orchestrator, options) {
      executions.push({ identity, sessionId: options.session.id });
      assertEquals(options.session.channelId, identity.id);
      assertEquals(options.targetClassification, "INTERNAL");
      if (
        completed.has(identity.id) ||
        (skipWebhook && identity.kind === "webhook")
      ) {
        return Promise.resolve({
          ok: false,
          error: "This execution does not permit delivery.",
        });
      }
      completed.add(identity.id);
      return orchestrator.executeAgentTurn(options);
    },
    triggerMdPath,
    trigger: {
      enabled: false,
      intervalMinutes: 30,
      classificationCeiling: "INTERNAL",
    },
    webhooks: {
      enabled: true,
      maxAgeMs: 0,
      sources: {
        provider: {
          secret: "fixture",
          classification: "INTERNAL",
          allowBodySignature: true,
        },
      },
    },
    onTriggerOutput(source) {
      deliveries.push(source);
    },
  };
  return {
    config,
    executions,
    deliveries,
    modelCalls: () => modelCalls,
    blockWebhook: () => {
      skipWebhook = true;
    },
  };
}

async function until(condition: () => boolean) {
  for (let step = 0; step < 50 && !condition(); step++) {
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  assert(condition());
}

Deno.test("Durable cron batches use the same isolated session for the same UTC minute only", async () => {
  const fixture = harness("/unused");
  const manager = createCronManager();
  const job = manager.create({
    expression: "* * * * *",
    task: "Review saved status.",
    classificationCeiling: "INTERNAL",
  });
  assert(job.ok);
  const time = new Date("2026-01-01T12:34:00Z");
  tickCronJobs(fixture.config, manager, time);
  tickCronJobs(fixture.config, manager, new Date("2026-01-01T12:34:59Z"));
  await until(() => manager.history(job.value.id).length === 1);
  assertEquals(fixture.executions.length, 1);

  tickCronJobs(
    { ...fixture.config },
    manager,
    new Date("2026-01-01T12:34:30Z"),
  );
  await until(() => fixture.executions.length === 2);
  assertEquals(fixture.executions[0], fixture.executions[1]);
  assertEquals(fixture.modelCalls(), 1);
  assertEquals(fixture.deliveries, [`cron:${job.value.id}`]);

  tickCronJobs(fixture.config, manager, new Date("2026-01-01T12:35:00Z"));
  await until(() => manager.history(job.value.id).length === 2);
  assertNotEquals(
    fixture.executions[2].identity.id,
    fixture.executions[0].identity.id,
  );
  assertEquals(fixture.modelCalls(), 2);
});

Deno.test("Durable manual triggers and verified webhook deliveries receive independent occurrence keys", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const triggerMdPath = join(dir, "TRIGGER.md");
    await Deno.writeTextFile(triggerMdPath, "Review saved status.");
    const fixture = harness(triggerMdPath);
    const service = createSchedulerService(fixture.config);
    let callbackCount = 0;
    service.webhookHandler.on("fixture", () => {
      callbackCount++;
      return Promise.resolve();
    });
    await service.runTrigger();
    await service.runTrigger();
    assertEquals(fixture.executions.map(({ identity }) => identity.kind), [
      "trigger",
      "trigger",
    ]);
    assertNotEquals(
      fixture.executions[0].identity.id,
      fixture.executions[1].identity.id,
    );

    const body = JSON.stringify({ event: "fixture", data: { attempt: 1 } });
    const signature = await computeHmac(body, "fixture");
    assertEquals(
      (await service.handleWebhookRequest("provider", body, {
        signature: "sha256=wrong",
      })).ok,
      false,
    );
    assertEquals(fixture.executions.length, 2);
    assertEquals(
      (await service.handleWebhookRequest("provider", body, { signature })).ok,
      true,
    );
    assertEquals(fixture.executions[2].identity.sourceId, "provider");
    assert(!JSON.stringify(fixture.executions[2].identity).includes(signature));
    assertEquals(
      (await service.handleWebhookRequest("provider", body, { signature })).ok,
      false,
    );

    fixture.blockWebhook();
    const second = JSON.stringify({ event: "fixture", data: { attempt: 2 } });
    assertEquals(
      (await service.handleWebhookRequest("provider", second, {
        signature: await computeHmac(second, "fixture"),
      })).ok,
      true,
    );
    assertEquals(fixture.executions.length, 4);
    assertNotEquals(
      fixture.executions[2].identity.id,
      fixture.executions[3].identity.id,
    );
    assertEquals(fixture.deliveries, [
      "trigger",
      "trigger",
      "webhook:provider",
    ]);
    assertEquals(callbackCount, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Durable cron restarts recover only leased admitted occurrences with the same current job", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const fixture = harness("/unused");
    const manager = createCronManager();
    const task = "Review exact approved evidence.";
    const job = manager.create({
      expression: "0 0 * * *",
      task,
      classificationCeiling: "INTERNAL",
    });
    assert(job.ok);
    const now = new Date(2026, 0, 23, 0, 1);
    let clock = now.getTime();
    const prior = Math.floor(new Date(2026, 0, 22, 0, 0).getTime() / 60_000);
    const original = Math.floor(new Date(2026, 0, 23, 0, 0).getTime() / 60_000);
    const path = join(dir, "cron-admissions.db");
    const initial = openSchedulerCronAdmissions(path, {
      now: () => clock,
      leaseMs: 10,
    });
    const snapshot = {
      jobId: job.value.id,
      promptSha256: createHash("sha256").update(task).digest("hex"),
      classificationCeiling: "INTERNAL" as const,
    };
    const restartId = schedulerExecutionIdentity(
      "cron",
      job.value.id,
      original,
    );
    const changedId = schedulerExecutionIdentity("cron", job.value.id, prior);
    initial.admit({ ...snapshot, id: restartId.id, occurrence: original });
    initial.admit({
      ...snapshot,
      id: changedId.id,
      occurrence: prior,
      promptSha256: "f".repeat(64),
    });
    const inFlight = initial.claim(restartId.id);
    assert(inFlight);
    assertEquals(initial.claim(restartId.id), undefined);
    const resumed = openSchedulerCronAdmissions(path, {
      now: () => clock,
      leaseMs: 10,
    });
    const config = { ...fixture.config, cronAdmissions: resumed };
    tickCronJobs(config, manager, now);
    assertEquals(fixture.executions, []);
    assertEquals(resumed.claim(changedId.id), undefined);

    clock += 11;
    tickCronJobs(config, manager, now);
    await until(() => manager.history(job.value.id).length === 1);
    assertEquals(fixture.executions.map(({ identity }) => identity), [
      restartId,
    ]);
    assertEquals(fixture.modelCalls(), 1);
    assertEquals(initial.finish(inFlight), false);
    assertEquals(resumed.available(), []);
    assert(!new TextDecoder().decode(await Deno.readFile(path)).includes(task));

    tickCronJobs({ ...config }, manager, now);
    assertEquals(fixture.executions.length, 1);
    assertEquals(fixture.deliveries, [`cron:${job.value.id}`]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Scoped cron recovery keeps prior admitted occurrences out of the ordinary execution path", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const fixture = harness("/unused");
    const manager = createCronManager();
    const task = "Review exact approved evidence.";
    const scoped = manager.create({
      expression: "* * * * *",
      task,
      classificationCeiling: "INTERNAL",
    });
    const ordinary = manager.create({
      expression: "* * * * *",
      task: "Run the ordinary job.",
      classificationCeiling: "INTERNAL",
    });
    assert(scoped.ok && ordinary.ok);
    const now = new Date("2026-01-23T01:01:00Z");
    const occurrence = Math.floor(now.getTime() / 60_000);
    const path = join(dir, "scoped-cron-admissions.db");
    const id = schedulerExecutionIdentity("cron", scoped.value.id, occurrence);
    const open = () =>
      openSchedulerCronAdmissions(path, { now: () => now.getTime() });
    open().admit({
      id: id.id,
      jobId: scoped.value.id,
      occurrence,
      promptSha256: createHash("sha256").update(task).digest("hex"),
      classificationCeiling: "INTERNAL",
    });
    let enabled = false;
    const newConfig = (): SchedulerServiceConfig => ({
      ...fixture.config,
      cronAdmissions: open(),
      recoveryEnabledForSource: ({ sourceId }) =>
        enabled && sourceId === scoped.value.id,
      orchestratorFactory: {
        create(channelId, options) {
          if (!options?.recoverySessionId) {
            assertEquals(options?.cronJobId, ordinary.value.id);
            assertEquals(options?.scheduledObservationSource, undefined);
          }
          return fixture.config.orchestratorFactory.create(channelId, {
            ...options,
            recoverySessionId: options?.recoverySessionId ??
              crypto.randomUUID() as SessionId,
          });
        },
      },
    });
    tickCronJobs(newConfig(), manager, now);
    await until(() => manager.history(ordinary.value.id).length === 1);
    assertEquals(fixture.executions, []);
    assertEquals(open().available().map(({ id }) => id), [id.id]);
    enabled = true;
    tickCronJobs(newConfig(), manager, now);
    await until(() => manager.history(scoped.value.id).length === 1);
    assertEquals(fixture.executions.map(({ identity }) => identity), [id]);
    assertEquals(open().available(), []);
    assertEquals(open().has(id.id), true);
    enabled = false;
    tickCronJobs(newConfig(), manager, now);
    await until(() => manager.history(ordinary.value.id).length === 3);
    assertEquals(manager.history(scoped.value.id).length, 1);
    assertEquals(fixture.executions.map(({ identity }) => identity), [id]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Durable periodic triggers reuse only their automatic interval identity after restart", async () => {
  const dir = await Deno.makeTempDir();
  const originalNow = Date.now;
  let time = Date.parse("2026-01-01T00:00:01Z");
  Date.now = () => time;
  const services: ReturnType<typeof createSchedulerService>[] = [];
  try {
    const triggerMdPath = join(dir, "TRIGGER.md");
    await Deno.writeTextFile(triggerMdPath, "Compare validated evidence.");
    const fixture = harness(triggerMdPath);
    const config = {
      ...fixture.config,
      trigger: { ...fixture.config.trigger, enabled: true },
    };
    const start = () => {
      const service = createSchedulerService({ ...config });
      services.push(service);
      service.start();
      return service;
    };
    const first = start();
    await until(() => fixture.deliveries.length === 1);
    first.stop();
    time += 1_000;
    const restarted = start();
    await until(() => fixture.executions.length === 2);
    restarted.stop();
    assertEquals(fixture.executions[1], fixture.executions[0]);
    assertEquals(fixture.modelCalls(), 1);

    time += 30 * 60_000;
    const next = start();
    await until(() => fixture.deliveries.length === 2);
    next.stop();
    assertNotEquals(
      fixture.executions[2].identity.id,
      fixture.executions[0].identity.id,
    );
  } finally {
    for (const service of services) service.stop();
    Date.now = originalNow;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Cron recovery reopens an actual saved tool batch without executing it twice", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const now = new Date(2026, 0, 23, 0, 1);
    const occurrence = Math.floor(
      new Date(2026, 0, 23, 0, 0).getTime() / 60_000,
    );
    let clock = now.getTime();
    const admissionPath = join(dir, "scheduler-cron-admissions.db");
    const recoveryPath = join(dir, "agent-recovery.db");
    const admissions = openSchedulerCronAdmissions(admissionPath, {
      now: () => clock,
      leaseMs: 10,
    });
    const cronManager = createCronManager();
    const task = "Use the recorded read-only control check.";
    const job = cronManager.create({
      expression: "0 0 * * *",
      task,
      classificationCeiling: "INTERNAL",
    });
    assert(job.ok);
    const execution = schedulerExecutionIdentity(
      "cron",
      job.value.id,
      occurrence,
    );
    admissions.admit({
      id: execution.id,
      jobId: job.value.id,
      occurrence,
      promptSha256: createHash("sha256").update(task).digest("hex"),
      classificationCeiling: "INTERNAL",
    });
    const originalLease = admissions.claim(execution.id);
    assert(originalLease);

    let interrupted = true;
    let reads = 0;
    let authorized = 0;
    let continued = false;
    const delivered: string[] = [];
    const policy: AgentRecoveryPolicy = {
      version: "test-exact-read",
      projectCall: (call) => call.name === "fixture_read" ? {} : undefined,
      projectResult: (_call, text) =>
        text === "exact control result" ? text : undefined,
      authorize(receipt) {
        authorized++;
        return Promise.resolve(receipt.name === "fixture_read");
      },
      classification: () => "INTERNAL",
    };
    const usage = { inputTokens: 1, outputTokens: 1 };
    const config: SchedulerServiceConfig = {
      orchestratorFactory: {
        create(channelId, opts) {
          assert(opts?.recoverySessionId);
          const session = restoreSession({
            id: opts.recoverySessionId,
            userId: "fixture" as UserId,
            channelId: channelId as ChannelId,
          });
          const registry = createProviderRegistry();
          registry.register({
            name: "fixture",
            supportsStreaming: false,
            complete(messages) {
              const read = messages.find(({ role }) => role === "tool");
              if (read) {
                assertEquals(read.content, "exact control result");
                if (interrupted) {
                  return Promise.reject(new Error("interrupted after batch"));
                }
                assertEquals(
                  messages.filter(({ content }) => content === task).length,
                  1,
                );
                continued = true;
                return Promise.resolve({
                  content: "Control verified.",
                  toolCalls: [],
                  usage,
                });
              }
              return Promise.resolve({
                content: "",
                toolCalls: [{
                  id: "read",
                  type: "function",
                  function: { name: "fixture_read", arguments: "{}" },
                }],
                usage,
              });
            },
          });
          registry.setDefault("fixture");
          const toolExecutor = () => {
            reads++;
            return Promise.resolve("exact control result");
          };
          return Promise.resolve({
            session,
            getSessionTaint: () => "INTERNAL",
            toolExecutor,
            orchestrator: createOrchestrator({
              providerRegistry: registry,
              hookRunner: {
                evaluateHook: () =>
                  Promise.resolve({
                    allowed: true,
                    action: "ALLOW",
                    ruleId: null,
                    duration: 0,
                  }),
              },
              tools: [{
                name: "fixture_read",
                description: "Read a fixed fixture.",
                parameters: {},
              }],
              toolExecutor,
            }),
          });
        },
      },
      executionTracePath: join(dir, "execution-traces.db"),
      recoveryState: (id) => schedulerRecoveryState(recoveryPath, id),
      recoverTurn: (identity, orchestrator, options) =>
        runRecoverableAgentTurn(
          recoveryPath,
          identity.id,
          policy,
          orchestrator,
          options,
          {
            resumeOnly: identity.resumeOnly,
            resumePaused: identity.resumePaused,
          },
        ),
      cronAdmissions: admissions,
      triggerMdPath: "/unused",
      trigger: {
        enabled: false,
        intervalMinutes: 30,
        classificationCeiling: "INTERNAL",
      },
      webhooks: { enabled: false, sources: {} },
      onTriggerOutput: (source) => delivered.push(source),
    };
    const original = await createScheduledAgent(config, "cron", {
      ceiling: "INTERNAL",
    }, execution);
    await assertRejects(
      () =>
        original.orchestrator.executeAgentTurn({
          session: original.session,
          message: task,
          targetClassification: "INTERNAL",
        }),
      Error,
    );
    assertEquals(reads, 1);
    assertEquals(delivered, []);

    assertEquals(
      (await ownerScheduledControl(dir, execution.id, "pause")).status,
      "paused",
    );
    assertEquals(schedulerRecoveryState(recoveryPath, execution.id), "paused");
    await restoreScheduledFixture(dir, execution.id);
    clock += 11;
    interrupted = false;
    const restarted = {
      ...config,
      cronAdmissions: openSchedulerCronAdmissions(admissionPath, {
        now: () => clock,
        leaseMs: 10,
      }),
    };
    tickCronJobs(restarted, cronManager, now);
    assertEquals(schedulerRecoveryState(recoveryPath, execution.id), "paused");
    assertEquals(restarted.cronAdmissions.available().map(({ id }) => id), [
      execution.id,
    ]);
    const resumed = await ownerScheduledControl(
      dir,
      execution.id,
      "resume",
      createSchedulerService({ ...restarted, cronManager }),
    );
    assertEquals(resumed.status, "completed");
    await until(() => cronManager.history(job.value.id).length === 1);
    assert(continued);
    assertEquals(reads, 1);
    assertEquals(authorized, 1);
    assertEquals(delivered, [`cron:${job.value.id}`]);
    assertEquals(admissions.finish(originalLease), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Admitted manual triggers recover a prepared batch after restart and block untrusted history", async () => {
  for (const historyState of ["same", "changed", "unavailable"]) {
    const dir = await Deno.makeTempDir();
    const release = Promise.withResolvers<void>();
    const committed = Promise.withResolvers<void>();
    let config: SchedulerServiceConfig | undefined;
    let initial: ReturnType<typeof createSchedulerService> | undefined;
    let restarted: ReturnType<typeof createSchedulerService> | undefined;
    let run: Promise<void> | undefined;
    try {
      const triggerMdPath = join(dir, "TRIGGER.md");
      const task = "Inspect verified state from the assigned read.";
      let memory = "Earlier approved trigger detail";
      let memoryAvailable = true;
      await Deno.writeTextFile(triggerMdPath, task);
      const admissionPath = join(dir, "scheduler-trigger-admissions.db");
      const recoveryPath = join(dir, "agent-recovery.db");
      let clock = Date.now() + 1_000;
      const admissions = openSchedulerTriggerAdmissions(admissionPath, {
        now: () => clock,
        leaseMs: 10,
      });
      const ids: SchedulerExecutionIdentity[] = [];
      const outputs: string[] = [];
      let firstProvider = true;
      let reads = 0;
      const usage = { inputTokens: 1, outputTokens: 1 };
      config = {
        orchestratorFactory: {
          create(channelId, opts) {
            assert(opts?.recoverySessionId);
            assert(opts?.isTrigger);
            assertEquals(opts?.ceiling, "INTERNAL");
            const session = restoreSession({
              id: opts.recoverySessionId,
              userId: "fixture" as UserId,
              channelId: channelId as ChannelId,
            });
            const waitOnInitial = firstProvider;
            firstProvider = false;
            const registry = createProviderRegistry();
            registry.register({
              name: "fixture",
              supportsStreaming: false,
              complete(messages) {
                const read = messages.find(({ role }) => role === "tool");
                if (read) {
                  assertEquals(read.content, "batch-result");
                  if (waitOnInitial) {
                    return Promise.reject(
                      new Error(
                        "Fixture interruption after the committed batch.",
                      ),
                    );
                  } else {
                    const users = messages.filter(({ role }) =>
                      role === "user"
                    );
                    assertEquals(users.length, 1);
                    assert(String(users[0].content).includes(task));
                    assert(String(users[0].content).includes(memory));
                  }
                  return Promise.resolve({
                    content: "Verified saved read.",
                    toolCalls: [],
                    usage,
                  });
                }
                return Promise.resolve({
                  content: "",
                  toolCalls: [{
                    id: "read",
                    type: "function",
                    function: { name: "fixture_read", arguments: "{}" },
                  }],
                  usage,
                });
              },
            });
            registry.setDefault("fixture");
            const toolExecutor = (name: string) => {
              if (name === "memory_get") {
                return Promise.resolve(
                  memoryAvailable
                    ? JSON.stringify({ found: true, content: memory })
                    : "Memory is unavailable",
                );
              }
              if (name === "memory_save") return Promise.resolve("saved");
              reads++;
              return Promise.resolve("batch-result");
            };
            return Promise.resolve({
              session,
              getSessionTaint: () => "INTERNAL",
              toolExecutor,
              orchestrator: createOrchestrator({
                providerRegistry: registry,
                hookRunner: {
                  evaluateHook: () =>
                    Promise.resolve({
                      allowed: true,
                      action: "ALLOW",
                      ruleId: null,
                      duration: 0,
                    }),
                },
                tools: [{
                  name: "fixture_read",
                  description: "Read a verified result.",
                  parameters: {},
                }],
                toolExecutor,
              }),
            });
          },
        },
        executionTracePath: join(dir, "execution-traces.db"),
        recoveryState: (id) => schedulerRecoveryState(recoveryPath, id),
        async recoverTurn(identity, orchestrator, options) {
          ids.push(identity);
          const result = await runRecoverableAgentTurn(
            recoveryPath,
            identity.id,
            {
              version: "fixture-v1",
              projectCall: (call) =>
                call.name === "fixture_read" ? {} : undefined,
              projectResult: (_call, text) =>
                text === "batch-result" ? text : undefined,
              authorize: () => Promise.resolve(true),
              classification: () => "INTERNAL",
            },
            orchestrator,
            options,
            {
              resumeOnly: identity.resumeOnly,
              resumePaused: identity.resumePaused,
            },
          ).catch((error) => {
            if (identity.resumeOnly) throw error;
            return { ok: false as const, error: "Fixture interruption." };
          });
          if (!identity.resumeOnly) {
            // Model execution has stopped and released the recovery lock.
            // Leave the old scheduler admission unacknowledged until takeover.
            committed.resolve();
            await release.promise;
          }
          return result;
        },
        triggerAdmissions: admissions,
        triggerMdPath,
        trigger: {
          enabled: false,
          intervalMinutes: 30,
          classificationCeiling: "INTERNAL",
        },
        webhooks: { enabled: false, sources: {} },
        onTriggerOutput(source) {
          outputs.push(source);
        },
      };
      initial = createSchedulerService(config);
      run = initial.runTrigger();
      await Promise.race([
        committed.promise,
        run.then(() => {
          throw new Error("Expected a committed saved trigger batch.");
        }),
      ]);
      assertEquals(ids.length, 1);
      const oldId = ids[0].id;
      if (historyState === "same") await restoreScheduledFixture(dir, oldId);
      clock += 60 * 60_000;
      if (historyState === "changed") memory = "Changed prior detail";
      if (historyState === "unavailable") memoryAvailable = false;
      const after = openSchedulerTriggerAdmissions(admissionPath, {
        now: () => clock,
        leaseMs: 10,
      });
      restarted = createSchedulerService({
        ...config,
        triggerAdmissions: after,
      });
      restarted.start();
      if (historyState === "same") {
        assertEquals(schedulerRecoveryState(recoveryPath, oldId), "paused");
        await resumeThroughGateway(restarted, oldId);
      }
      await until(() => after.readOutcome(oldId) !== undefined);
      assertEquals(
        after.readOutcome(oldId),
        historyState === "changed"
          ? "input_changed"
          : historyState === "unavailable"
          ? "history_unavailable"
          : "completed",
      );
      assertEquals(reads, 1);
      assertEquals(ids.length, historyState === "same" ? 2 : 1);
      if (historyState === "same") {
        assertEquals(ids[1], {
          ...ids[0],
          resumeOnly: true,
          resumePaused: true,
        });
        await until(() => outputs.length === 1);
      }
      release.resolve();
      await run;
      assertEquals(outputs, historyState === "same" ? ["trigger"] : []);
      const persisted = await Deno.readFile(admissionPath);
      const database = new TextDecoder().decode(persisted);
      assert(!database.includes(task));
      assert(!database.includes("Earlier approved trigger detail"));
    } finally {
      release.resolve();
      await run?.catch(() => {});
      initial?.stop();
      restarted?.stop();
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("An admitted periodic trigger keeps its old occurrence on restart in a new interval", async () => {
  const dir = await Deno.makeTempDir();
  const restoreNow = Date.now;
  let clock = Date.parse("2026-01-01T00:00:00Z");
  Date.now = () => clock;
  const releaseFirst = Promise.withResolvers<void>();
  const firstReturned = Promise.withResolvers<void>();
  const original = harness(join(dir, "TRIGGER.md"));
  let first: ReturnType<typeof createSchedulerService> | undefined;
  let restarted: ReturnType<typeof createSchedulerService> | undefined;
  const executions: SchedulerExecutionIdentity[] = [];
  try {
    const path = join(dir, "trigger.db");
    await Deno.writeTextFile(
      original.config.triggerMdPath,
      "Review saved findings.",
    );
    const storage = () =>
      openSchedulerTriggerAdmissions(path, { now: () => clock, leaseMs: 10 });
    const recoverTurn: SchedulerServiceConfig["recoverTurn"] = async (
      identity,
      orch,
      options,
    ) => {
      executions.push(identity);
      const initial = executions.length === 1;
      if (initial) {
        await releaseFirst.promise;
      }
      const result = await orch.executeAgentTurn(options);
      if (initial) firstReturned.resolve();
      return result;
    };
    const config: SchedulerServiceConfig = {
      ...original.config,
      trigger: { ...original.config.trigger, enabled: true },
      triggerAdmissions: storage(),
      recoverTurn,
      orchestratorFactory: {
        async create(channelId, options) {
          const bundle = await original.config.orchestratorFactory.create(
            channelId,
            options,
          );
          return {
            ...bundle,
            toolExecutor: () => Promise.resolve('{"found":false}'),
          };
        },
      },
    };
    first = createSchedulerService(config);
    first.start();
    await until(() => executions.length === 1);
    first.stop();
    const old = executions[0];
    clock += 2 * 30 * 60_000;
    const reopened = storage();
    restarted = createSchedulerService({
      ...config,
      triggerAdmissions: reopened,
    });
    restarted.start();
    await until(() => original.deliveries.length === 2);
    assertEquals(executions[1], { ...old, resumeOnly: true });
    assertNotEquals(executions[2].id, old.id);
    assertEquals(executions[2].resumeOnly, undefined);
    assertEquals(reopened.readOutcome(old.id), "completed");
    releaseFirst.resolve();
    await firstReturned.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(original.deliveries.length, 2);
  } finally {
    releaseFirst.resolve();
    first?.stop();
    restarted?.stop();
    Date.now = restoreNow;
    await Deno.remove(dir, { recursive: true });
  }
});
