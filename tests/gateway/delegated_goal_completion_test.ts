import { assertEquals, assertRejects } from "@std/assert";
import type { DelegatedGoalConfig } from "../../src/core/delegated_goal_config.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import { computeContentHash } from "../../src/core/session/lineage_serde.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import type { Orchestrator } from "../../src/core/types/orchestrator.ts";
import type { OrchestratorFactory } from "../../src/scheduler/service_types.ts";
import { buildDelegatedGoalCompletion } from "../../src/gateway/startup/factory/delegated_goal_completion.ts";
import { buildSubagentFactory } from "../../src/gateway/startup/factory/subagent.ts";
import {
  buildSpawnMemberSession,
  createSessionRegistry,
} from "../../src/gateway/startup/factory/team_session_registry.ts";

Deno.test("Configured delegated goals use only exact tool evidence from normal subagent and team turns", async () => {
  const directory = await Deno.makeTempDir();
  const storage = createMemoryStorage();
  const messages = createMessageStore(storage);
  const exact = "Verified artifact checksum";
  const sha256 = await computeContentHash(exact);
  const settings: DelegatedGoalConfig[] = [{
    scope: "work",
    goal: "Verify both independently captured records",
    policy: "operator",
    criteria: [
      {
        id: "child",
        description: "Subagent record",
        kind: "subagent",
        tool: "read_report",
        result_sha256: sha256,
      },
      {
        id: "team",
        description: "Team record",
        kind: "team",
        tool: "read_report",
        result_sha256: sha256,
      },
    ],
  }];
  try {
    const completion = buildDelegatedGoalCompletion(
      directory,
      settings,
      messages,
    )!;
    const fixtureProofAccess = {
      ownerSessionId: crypto.randomUUID(),
      current: () => true,
      reopen: () => Promise.resolve(""),
      authorizeTranscript: (
        _source: string,
        row: { readonly content: string },
      ) => Promise.resolve(row.content === exact),
    };
    const state = async () =>
      JSON.parse(
        (await completion.runCommand(
          "/goal delegated status work",
          "PUBLIC",
          fixtureProofAccess,
        ))!,
      );
    const factory: OrchestratorFactory = {
      async create(channelId, options) {
        const session = createSession({
          userId: "owner" as UserId,
          channelId: channelId as ChannelId,
        });
        await messages.append({
          session_id: session.id,
          role: "tool_call",
          content: exact,
          classification: "PUBLIC",
          tool_name: "read_report",
        });
        const orchestrator: Orchestrator = {
          async executeAgentTurn(input) {
            const accepted = input.message === "perform exact read" ||
              input.message === "perform classified read";
            await messages.append({
              session_id: input.session.id,
              role: accepted ? "tool_call" : "assistant",
              content: exact,
              classification: input.message === "perform classified read"
                ? "RESTRICTED"
                : "PUBLIC",
              ...(accepted && { tool_name: "read_report" }),
            });
            return {
              ok: true,
              value: {
                response: exact,
                tokenUsage: { inputTokens: 0, outputTokens: 0 },
              },
            };
          },
          getHistory: () => [],
          clearHistory: () => {},
          compactHistory: () =>
            Promise.resolve({
              messagesBefore: 0,
              messagesAfter: 0,
              tokensBefore: 0,
              tokensAfter: 0,
              summary: "",
            }),
        };
        return {
          orchestrator: options?.delegatedKind
            ? completion.wrap(orchestrator, options.delegatedKind, session.id)
            : orchestrator,
          session,
          toolExecutor: () => Promise.resolve(exact),
          getSessionTaint: () => "PUBLIC",
        };
      },
    };
    const subagent = buildSubagentFactory(factory);
    await subagent("assert result without a current tool call");
    await subagent("perform classified read");
    assertEquals((await state()).satisfied, []);
    await subagent("perform exact read");
    assertEquals((await state()).satisfied, ["child"]);
    await assertRejects(
      () => completion.runCommand("/goal delegated confirm work"),
      Error,
      "requires the exact decision digest",
    );

    const sessions = createSessionRegistry();
    const spawn = buildSpawnMemberSession(factory, sessions);
    const member = await spawn({
      role: "reviewer",
      description: "Verify retained artifact.",
      teamRosterPrompt: "",
      classificationCeiling: "PUBLIC",
    });
    const team = sessions.get(member.sessionId)!;
    await team.orchestrator.executeAgentTurn({
      session: team.session,
      message: "perform exact read",
      targetClassification: "PUBLIC",
    });
    const waiting = await state();
    assertEquals(waiting.status, "awaiting_confirmation");
    assertEquals(waiting.satisfied, ["child", "team"]);
    assertEquals(
      waiting.observations.map(
        (entry: { evidence: { source: string }[] }) => entry.evidence[0].source,
      ),
      ["delegated:subagent", "delegated:team"],
    );
    const confirm = () =>
      completion.runCommand(
        `/goal delegated confirm work ${waiting.confirmation.decisionSha256}`,
        "PUBLIC",
        fixtureProofAccess,
      );
    const completed = JSON.parse((await confirm())!);
    assertEquals(completed.status, "completed");
    assertEquals(JSON.parse((await confirm())!), completed);
    assertEquals(
      await completion.runCommand("/goal chat confirm work"),
      undefined,
    );
  } finally {
    await storage.close();
    await Deno.remove(directory, { recursive: true });
  }
});
