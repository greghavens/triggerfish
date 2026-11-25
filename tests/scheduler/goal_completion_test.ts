import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import {
  type GoalCompletionRecord,
  GoalCompletionStore,
} from "../../src/core/goal_completion.ts";
import type { TriggerFishConfig } from "../../src/core/config_types.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import { computeContentHash } from "../../src/core/session/lineage_serde.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import {
  computeHmac,
  createCronManager,
  createSchedulerService,
  type OrchestratorFactory,
  type SchedulerGoalCompletionBinding,
} from "../../src/scheduler/mod.ts";
import { reportSchedulerGoalEvidence } from "../../src/scheduler/service_goal_completion.ts";
import { buildSchedulerGoalCompletion } from "../../src/gateway/startup/factory/scheduler_goal_completion.ts";

Deno.test("Scheduler cron, trigger and signed webhook contribute only bound verified goal evidence", async () => {
  const dir = await Deno.makeTempDir();
  const completion = new GoalCompletionStore(join(dir, "goal.db"));
  const proofs = new DatabaseSync(join(dir, "proof.db"));
  const cronManager = createCronManager();
  const cron = cronManager.create({
    expression: "* * * * *",
    task: "Check recorded backup.",
    classificationCeiling: "INTERNAL",
  });
  assert(cron.ok);
  const scope = "fixture:release-1";
  const bindings: readonly SchedulerGoalCompletionBinding[] = [
    { kind: "cron", sourceId: cron.value.id, scope, criterionId: "backup" },
    { kind: "trigger", sourceId: "trigger", scope, criterionId: "health" },
    { kind: "webhook", sourceId: "signed", scope, criterionId: "release" },
  ];
  completion.register(scope, "Verify release readiness.", [
    { id: "backup", description: "Backup evidence saved." },
    { id: "health", description: "Health evidence saved." },
    { id: "release", description: "Release evidence saved." },
  ], "automatic");
  proofs.exec(`CREATE TABLE proofs (
    reference TEXT PRIMARY KEY, source TEXT, session TEXT, scope TEXT,
    criterion TEXT, detail TEXT
  )`);
  const seen: { sourceId: string; sessionId: string }[] = [];
  let persistTriggerProof = false;
  const factory: OrchestratorFactory = {
    create(channelId) {
      const session = createSession({
        userId: "scheduler-fixture" as UserId,
        channelId: channelId as ChannelId,
      });
      return Promise.resolve({
        session,
        toolExecutor: () => Promise.resolve(""),
        getSessionTaint: () => "INTERNAL" as const,
        orchestrator: {
          executeAgentTurn() {
            const source = channelId === "cron"
              ? bindings[0]
              : channelId === "trigger" && persistTriggerProof
              ? bindings[1]
              : channelId === "webhook-signed"
              ? bindings[2]
              : undefined;
            if (source) {
              proofs.prepare("INSERT INTO proofs VALUES (?, ?, ?, ?, ?, ?)")
                .run(
                  `verified:${session.id}`,
                  `scheduler:${source.kind}:${source.sourceId}`,
                  session.id,
                  source.scope,
                  source.criterionId,
                  "Persisted fixture evidence",
                );
            }
            return Promise.resolve({
              ok: true as const,
              value: {
                response: "All criteria are complete.",
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
  };
  const triggerMdPath = join(dir, "TRIGGER.md");
  await Deno.writeTextFile(triggerMdPath, "Check the health record.");
  const service = createSchedulerService({
    orchestratorFactory: factory,
    cronManager,
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
        signed: {
          secret: "fixture-key",
          classification: "INTERNAL",
          allowBodySignature: true,
        },
        unbound: {
          secret: "another-key",
          classification: "INTERNAL",
          allowBodySignature: true,
        },
      },
    },
    goalCompletion: {
      store: completion,
      bindings,
      readEvidence(invocation) {
        const { sourceId, sessionId, classification } = invocation;
        assertEquals(classification, "INTERNAL");
        seen.push({ sourceId, sessionId });
        const rows = proofs.prepare(
          "SELECT reference, detail FROM proofs WHERE session = ? AND scope = ? AND criterion = ?",
        ).all(sessionId, invocation.scope, invocation.criterionId);
        return Promise.resolve([
          ...rows.map(({ reference, detail }) => ({
            reference: String(reference),
            detail: String(detail),
          })),
          { reference: "unverified-string", detail: "Expected rejection" },
        ]);
      },
      prepareVerification(scope) {
        return Promise.resolve((criterionId, { source, reference, detail }) =>
          !!proofs.prepare(
            "SELECT 1 FROM proofs WHERE source = ? AND reference = ? AND detail = ? AND scope = ? AND criterion = ?",
          ).get(source, reference, detail, scope, criterionId)
        );
      },
    },
  });
  try {
    service.start();
    for (
      let attempt = 0;
      !completion.read(scope)?.observations.length && attempt < 40;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    service.stop();
    const recordedCriteria = () =>
      completion.read(scope)?.observations.map(({ criterionId }) => criterionId)
        .sort();
    assertEquals(recordedCriteria(), ["backup"]);
    await service.runTrigger();
    assertEquals(recordedCriteria(), ["backup"]);
    assertEquals(completion.read(scope)?.status, "open");
    persistTriggerProof = true;
    await service.runTrigger();
    assertEquals(recordedCriteria(), ["backup", "health"]);
    // Payload attempts to identify itself as the trusted source and goal.
    const body = JSON.stringify({
      event: "release",
      data: { sourceId: "signed", scope, satisfied: true },
    });
    assertEquals(
      (await service.handleWebhookRequest("signed", body, {
        signature: "sha256=wrong",
      })).ok,
      false,
    );
    assertEquals(
      (await service.handleWebhookRequest("unbound", body, {
        signature: await computeHmac(body, "another-key"),
      })).ok,
      true,
    );
    assertEquals(recordedCriteria(), ["backup", "health"]);
    assertEquals(
      (await service.handleWebhookRequest("signed", body, {
        signature: await computeHmac(body, "fixture-key"),
      })).ok,
      true,
    );
    assertEquals(recordedCriteria(), ["backup", "health", "release"]);
    assertEquals(completion.read(scope)?.status, "completed");
    assertEquals(seen.map(({ sourceId }) => sourceId), [
      cron.value.id,
      "trigger",
      "trigger",
      "signed",
    ]);
    assertEquals(new Set(seen.map(({ sessionId }) => sessionId)).size, 4);
    assert(
      !JSON.stringify(completion.read(scope)).includes("unverified-string"),
    );
  } finally {
    service.stop();
    proofs.close();
    completion.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Scheduler startup binds named sources to exact persisted tool results on the shared store", async () => {
  const dir = await Deno.makeTempDir();
  const storage = createMemoryStorage();
  const messages = createMessageStore(storage);
  const content = "Canonical healthy result";
  const sha = await computeContentHash(content);
  const config = {
    scheduler: {
      goal_completion: [{
        scope: "release",
        goal: "Check release readiness.",
        policy: "operator",
        criteria: [
          {
            id: "health",
            description: "Read persisted health.",
            kind: "trigger",
            source_id: "trigger",
            tool: "health_check",
            result_sha256: sha,
          },
          {
            id: "release",
            description: "Read persisted release.",
            kind: "webhook",
            source_id: "signed",
            tool: "health_check",
            result_sha256: sha,
          },
        ],
      }],
      webhooks: {
        sources: {
          signed: { secret: "fixture-key", classification: "INTERNAL" },
          other: { secret: "other-key", classification: "INTERNAL" },
        },
      },
    },
  } as unknown as TriggerFishConfig;
  try {
    const scope = "scheduler:release";
    const integration = buildSchedulerGoalCompletion(config, dir, messages)!;
    const store = new GoalCompletionStore(join(dir, "goal-completion.db"));
    try {
      const publish = (
        sessionId: string,
        role: "assistant" | "tool_call",
        tool: string,
        value: string,
      ) =>
        messages.append({
          session_id: sessionId,
          role,
          tool_name: tool,
          classification: "INTERNAL",
          content: value,
        });
      const firstId = crypto.randomUUID();
      await publish(firstId, "assistant", "health_check", content);
      await publish(firstId, "tool_call", "different_tool", content);
      await publish(firstId, "tool_call", "health_check", "different result");
      const trigger = {
        kind: "trigger" as const,
        sourceId: "trigger",
        sessionId: firstId,
        classification: "INTERNAL" as const,
      };
      await reportSchedulerGoalEvidence(integration, trigger);
      assertEquals(store.read(scope)?.observations, []);
      const first = await publish(
        firstId,
        "tool_call",
        "health_check",
        content,
      );
      await reportSchedulerGoalEvidence(integration, {
        ...trigger,
        classification: "PUBLIC",
      });
      assertEquals(store.read(scope)?.observations, []);
      await reportSchedulerGoalEvidence(integration, trigger);
      assertEquals(store.read(scope)?.status, "open");
      assertEquals(
        store.read(scope)?.observations[0].evidence[0].reference,
        `${firstId}:${first.message_id}`,
      );

      const rebound = structuredClone(config.scheduler!.goal_completion!);
      const changed = {
        ...config,
        scheduler: {
          ...config.scheduler,
          goal_completion: [{
            ...rebound[0],
            criteria: [rebound[0].criteria[0], {
              ...rebound[0].criteria[1],
              source_id: "other",
            }],
          }],
        },
      };
      assertThrows(() => buildSchedulerGoalCompletion(changed, dir, messages));
      const secondId = crypto.randomUUID();
      await publish(secondId, "tool_call", "health_check", content);
      const webhook = {
        ...trigger,
        kind: "webhook" as const,
        sessionId: secondId,
      };
      await reportSchedulerGoalEvidence(integration, {
        ...webhook,
        sourceId: "other",
      });
      assertEquals(store.read(scope)?.status, "open");
      await reportSchedulerGoalEvidence(integration, {
        ...webhook,
        sourceId: "signed",
      });
      const awaiting = JSON.parse(
        await integration.runCommand("/goal scheduler status release"),
      );
      assertEquals(awaiting.status, "awaiting_confirmation");
      await assertRejects(() =>
        integration.runCommand("/goal scheduler confirm unconfigured")
      );
      const removed = await messages.applyRetention(
        { maxAgeDays: 1 },
        new Date(Date.now() + 2 * 86_400_000),
      );
      assert(removed.ok && removed.value > 0);
      const stale = JSON.parse(
        await integration.runCommand("/goal scheduler confirm release"),
      );
      assertEquals(stale.status, "open");
      assertEquals(stale.observations, []);

      for (const source of [trigger, { ...webhook, sourceId: "signed" }]) {
        const sessionId = crypto.randomUUID();
        await publish(sessionId, "tool_call", "health_check", content);
        await reportSchedulerGoalEvidence(integration, {
          ...source,
          sessionId,
        });
      }
      const record = JSON.parse(
        await integration.runCommand("/goal scheduler confirm release"),
      ) as GoalCompletionRecord;
      assertEquals(record?.status, "completed");
      assertEquals(
        record?.observations.map(({ evidence }) => evidence[0].source),
        [
          "scheduler:trigger:trigger",
          "scheduler:webhook:signed",
        ],
      );
      assert(!JSON.stringify(record).includes(content));
    } finally {
      store.close();
    }
  } finally {
    await storage.close();
    await Deno.remove(dir, { recursive: true });
  }
});
