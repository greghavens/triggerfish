import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { openAgentProfiles } from "../../src/core/agent_profiles.ts";
import { createMessageStore } from "../../src/core/conversation/conversation_store.ts";
import type { HookType } from "../../src/core/policy/rules.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { filterToolsForRole } from "../../src/gateway/tools/defs/role_filter.ts";
import { resolveToolsForProfile } from "../../src/gateway/tools/defs/tool_profile_defs.ts";
import {
  createSkillAuthor,
  createSkillContextTracker,
  createSkillLoader,
  createSkillScanner,
  createSkillToolExecutor,
} from "../../src/tools/skills/mod.ts";
import { computeSkillHash } from "../../src/tools/skills/integrity.ts";

async function writeSkill(
  dir: string,
  name: string,
  ceiling: "PUBLIC" | "INTERNAL" | "CONFIDENTIAL",
  content: string,
  status?: string,
) {
  const path = join(dir, name);
  await Deno.mkdir(path, { recursive: true });
  const file = join(path, "SKILL.md");
  await Deno.writeTextFile(
    file,
    [
      "---",
      `name: ${name}`,
      "version: 1.0.0",
      `classification_ceiling: ${ceiling}`,
      ...(status ? [`status: ${status}`] : []),
      "---",
      content,
    ].join("\n"),
  );
  return file;
}

Deno.test("Owner gateway discovers live skill grants and blocks pending draft activation", async () => {
  const dir = await Deno.makeTempDir();
  const bundled = join(dir, "bundled");
  const managed = join(dir, "managed");
  const workspace = join(dir, "workspace");
  const tools = resolveToolsForProfile("cli");
  assert(tools.some(({ name }) => name === "list_skills"));
  assert(tools.some(({ name }) => name === "inspect_skill_document"));
  assert(tools.some(({ name }) => name === "list_skill_usage"));
  assert(tools.some(({ name }) => name === "list_unavailable_skill_requests"));
  assert(tools.some(({ name }) => name === "list_skill_visibility"));
  assert(
    !filterToolsForRole(tools, false).some(({ name }) =>
      name === "list_skills" || name === "inspect_skill_document" ||
      name === "list_skill_usage" ||
      name === "list_unavailable_skill_requests" ||
      name === "list_skill_visibility"
    ),
  );
  assert(
    !resolveToolsForProfile("subagent").some(({ name }) =>
      name === "list_skills"
    ),
  );
  await writeSkill(
    bundled,
    "public-tool",
    "PUBLIC",
    "Public fixture instructions",
  );
  await writeSkill(
    bundled,
    "shared",
    "CONFIDENTIAL",
    "Bundled fixture instructions",
  );
  const managedFile = await writeSkill(
    managed,
    "local-tool",
    "INTERNAL",
    "Managed fixture instructions",
  );
  await writeSkill(
    workspace,
    "rejected",
    "INTERNAL",
    "Rejected fixture instructions",
    "REJECTED",
  );
  const authored = await createSkillAuthor({
    skillsDir: workspace,
    userCeiling: "CONFIDENTIAL",
  }).create({
    name: "shared",
    description: "Pending shadow",
    classificationCeiling: "CONFIDENTIAL",
    content: "Pending fixture instructions",
  });
  assert(authored.ok && authored.value.status === "PENDING_APPROVAL");

  const loader = createSkillLoader({
    directories: [bundled, managed, workspace],
    dirTypes: {
      [bundled]: "bundled",
      [managed]: "managed",
      [workspace]: "workspace",
    },
  });
  let discoveryCalls = 0;
  let replaceAfterDiscovery = false;
  const tracker = createSkillContextTracker();
  const session = {
    ...createSession({
      userId: "owner" as UserId,
      channelId: "skill-test" as ChannelId,
    }),
    taint: "INTERNAL" as const,
  };
  const storage = createMemoryStorage();
  const messageStore = createMessageStore(storage);
  let historyLoads = 0;
  let visibilityReads = 0;
  const execute = createSkillToolExecutor({
    skillLoader: {
      async discover() {
        discoveryCalls++;
        const result = await loader.discover();
        if (replaceAfterDiscovery) {
          replaceAfterDiscovery = false;
          await writeSkill(
            managed,
            "local-tool",
            "INTERNAL",
            "Unreviewed replacement instructions",
            "PENDING_APPROVAL",
          );
        }
        return result;
      },
    },
    skillScanner: createSkillScanner(),
    skillContextTracker: tracker,
    getSessionTaint: () => session.taint,
    loadOwnerSkillHistory: () => {
      historyLoads++;
      return createMessageStore(storage).loadSession(session.id);
    },
    listReviewedAgentProfiles: () => {
      visibilityReads++;
      return openAgentProfiles(dir).list();
    },
  });

  const registry = createProviderRegistry();
  let wanted = "list_skills";
  let args: Record<string, unknown> = {};
  let toolResult = "";
  registry.register({
    name: "skill-discovery-fixture",
    supportsStreaming: false,
    complete(messages, definitions) {
      const done = messages.at(-1)?.role === "tool";
      if (done) toolResult = String(messages.at(-1)?.content);
      else {
        assert(
          definitions?.some((definition) =>
            (definition as { function?: { name: string } }).function?.name ===
              wanted
          ),
        );
      }
      return Promise.resolve({
        content: done ? "Skill operation ended." : "",
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: done ? [] : [{
          type: "function",
          id: crypto.randomUUID(),
          function: { name: wanted, arguments: JSON.stringify(args) },
        }],
      });
    },
  });
  registry.setDefault("skill-discovery-fixture");
  let deny: HookType | undefined;
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({
    port: 0,
    token,
    chatSession: createChatSession({
      session,
      providerRegistry: registry,
      tools,
      messageStore,
      enableStreaming: false,
      targetClassification: "INTERNAL",
      hookRunner: {
        evaluateHook(hook) {
          const allowed = hook !== deny;
          return Promise.resolve({
            allowed,
            action: allowed ? "ALLOW" : "BLOCK",
            ruleId: null,
            duration: 0,
          });
        },
      },
      async toolExecutor(name, input, context) {
        return await execute(name, input, context) ?? "Unavailable";
      },
    }),
  });
  const { port } = await gateway.start();
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/chat?token=${token}`,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const turn = async (tool: string, parameters: Record<string, unknown>) => {
      wanted = tool;
      args = parameters;
      toolResult = "";
      const messages: string[] = [];
      const end = Promise.withResolvers<void>();
      const receive = ({ data }: MessageEvent) => {
        const event = JSON.parse(data);
        messages.push(event.type);
        if (event.type === "turn_end") end.resolve();
      };
      const timer = setTimeout(
        () => end.reject(new Error("No gateway turn end")),
        3_000,
      );
      socket.addEventListener("message", receive);
      try {
        socket.send(
          JSON.stringify({
            type: "message",
            content: "Inspect the skill registry.",
          }),
        );
        await end.promise;
        return { messages, result: toolResult };
      } finally {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
      }
    };
    deny = "PRE_TOOL_CALL";
    await turn("list_skills", {});
    assertEquals(discoveryCalls, 0);
    deny = "POST_TOOL_RESPONSE";
    assertEquals(
      (await turn("list_skills", {})).result,
      "Tool response withheld by policy.",
    );
    deny = "PRE_OUTPUT";
    const blocked = await turn("list_skills", {});
    assert(!blocked.messages.includes("response"));
    deny = undefined;
    const first = JSON.parse((await turn("list_skills", { limit: 1 })).result);
    assertEquals(first, {
      skills: [{
        name: "local-tool",
        type: "USER_PROVIDED",
        source: "managed",
        classification_ceiling: "INTERNAL",
        version: "1.0.0",
      }],
      next_after: "local-tool",
      _classification: "INTERNAL",
    });
    const second = JSON.parse(
      (await turn("list_skills", { after: first.next_after, limit: 1 })).result,
    );
    assertEquals(
      second.skills.map((
        { name, type }: { name: string; type: string },
      ) => [name, type]),
      [["shared", "BUNDLED"]],
    );
    assertEquals(second.next_after, null);
    assertEquals(tracker.getActive(), null);

    const inspect = { type: "BUNDLED", skill_name: "shared" };
    const callsBeforeInspection = discoveryCalls;
    deny = "PRE_TOOL_CALL";
    await turn("inspect_skill_document", inspect);
    assertEquals(discoveryCalls, callsBeforeInspection);
    deny = "POST_TOOL_RESPONSE";
    assertEquals(
      (await turn("inspect_skill_document", inspect)).result,
      "Tool response withheld by policy.",
    );
    deny = "PRE_OUTPUT";
    assert(
      !(await turn("inspect_skill_document", inspect)).messages.includes(
        "response",
      ),
    );
    deny = undefined;
    const document = JSON.parse(
      (await turn("inspect_skill_document", inspect)).result,
    );
    assertEquals(document.file, "SKILL.md");
    assertEquals(
      document.digest,
      await computeSkillHash(
        await Deno.readTextFile(join(bundled, "shared", "SKILL.md")),
      ),
    );
    assertStringIncludes(document.content, "Bundled fixture instructions");
    assertEquals(tracker.getActive(), null);
    assertEquals(
      JSON.parse((await turn("list_skill_usage", inspect)).result).calls,
      [],
    );
    assertStringIncludes(
      (await turn("inspect_skill_document", {
        type: "BUNDLED",
        skill_name: "public-tool",
      })).result,
      "classification ceiling",
    );

    for (const skill_name of ["shared", "rejected"]) {
      const denied = JSON.parse(
        (await turn("read_skill", { type: "USER_PROVIDED", skill_name }))
          .result,
      );
      assertEquals(denied.found, false);
      assertEquals(tracker.getActive(), null);
    }
    replaceAfterDiscovery = true;
    const stale = await turn("inspect_skill_document", {
      type: "USER_PROVIDED",
      skill_name: "local-tool",
    });
    assertStringIncludes(stale.result, "changed during activation");
    assertEquals(tracker.getActive(), null);
    assertStringIncludes(
      await Deno.readTextFile(managedFile),
      "PENDING_APPROVAL",
    );
    assertEquals(
      JSON.parse((await turn("list_skills", { type: "USER_PROVIDED" })).result)
        .skills,
      [],
    );

    const active = JSON.parse(
      (await turn("read_skill", { type: "BUNDLED", skill_name: "shared" }))
        .result,
    );
    assertEquals(
      active.content,
      "---\nname: shared\nversion: 1.0.0\nclassification_ceiling: CONFIDENTIAL\n---\nBundled fixture instructions",
    );
    assertEquals(tracker.getActive()?.source, "bundled");

    deny = "POST_TOOL_RESPONSE";
    await turn("read_skill", inspect);
    deny = "PRE_TOOL_CALL";
    const beforeHistoryDenial = historyLoads;
    await turn("list_skill_usage", inspect);
    assertEquals(historyLoads, beforeHistoryDenial);
    deny = "POST_TOOL_RESPONSE";
    assertEquals(
      (await turn("list_skill_usage", inspect)).result,
      "Tool response withheld by policy.",
    );
    deny = "PRE_OUTPUT";
    assert(
      !(await turn("list_skill_usage", inspect)).messages.includes("response"),
    );
    deny = undefined;
    const stored = (await messageStore.loadSession(session.id)).filter((row) =>
      row.tool_name === "read_skill" && row.tool_args?.type === "BUNDLED"
    );
    assertEquals(stored.length, 1);
    assertEquals(
      JSON.parse((await turn("list_skill_usage", inspect)).result),
      {
        calls: [{
          message_id: stored[0].message_id,
          accessed_at: stored[0].timestamp,
        }],
        _classification: "INTERNAL",
      },
    );
    const unavailable = {
      type: "USER_PROVIDED",
      skill_name: "fixture-missing",
    };
    await turn("read_skill", unavailable);
    await turn("read_skill", unavailable);
    deny = "PRE_TOOL_CALL";
    const beforeReport = historyLoads;
    await turn("list_unavailable_skill_requests", {});
    assertEquals(historyLoads, beforeReport);
    deny = "POST_TOOL_RESPONSE";
    await turn("read_skill", unavailable);
    assertEquals(
      (await turn("list_unavailable_skill_requests", {})).result,
      "Tool response withheld by policy.",
    );
    deny = "PRE_OUTPUT";
    assert(
      !(await turn("list_unavailable_skill_requests", {})).messages.includes(
        "response",
      ),
    );
    deny = undefined;
    const report = JSON.parse(
      (await turn("list_unavailable_skill_requests", { limit: 1 })).result,
    );
    assertEquals(report.unavailable.length, 1);
    assertEquals(report.unavailable[0].skill_name, unavailable.skill_name);
    assertEquals(report.unavailable[0].type, unavailable.type);
    assertEquals(report.unavailable[0].calls, 2);
    assertEquals(report._classification, "INTERNAL");

    const profile = {
      name: "Fixture profile",
      description: "Fixture profile grants",
      role: "assistant",
      prompt: "Use reviewed skills.",
      tools: ["read_skill"],
    };
    const updateProfile = (
      id: string,
      version: number,
      definition: typeof profile & { skills?: readonly string[] },
    ) => {
      assert(
        openAgentProfiles(dir).commit({
          id,
          expectedVersion: version,
          requestId: crypto.randomUUID(),
          definition,
        }, session.id),
      );
    };
    updateProfile("explicit-fixture", 0, { ...profile, skills: ["shared"] });
    updateProfile("inherited-fixture", 0, profile);
    updateProfile("blocked-fixture", 0, {
      ...profile,
      tools: [],
      skills: ["shared"],
    });
    deny = "PRE_TOOL_CALL";
    await turn("list_skill_visibility", { skill_name: "shared" });
    assertEquals(visibilityReads, 0);
    deny = "POST_TOOL_RESPONSE";
    assertEquals(
      (await turn("list_skill_visibility", { skill_name: "shared" })).result,
      "Tool response withheld by policy.",
    );
    deny = "PRE_OUTPUT";
    assert(
      !(await turn("list_skill_visibility", { skill_name: "shared" })).messages
        .includes("response"),
    );
    deny = undefined;
    const readVisibility = async () =>
      JSON.parse(
        (await turn("list_skill_visibility", { skill_name: "shared" })).result,
      );
    assertEquals((await readVisibility()).profiles, [
      { profile_id: "explicit-fixture", profile_version: 1, grant: "explicit" },
      {
        profile_id: "inherited-fixture",
        profile_version: 1,
        grant: "inherited",
      },
    ]);
    updateProfile("explicit-fixture", 1, { ...profile, skills: [] });
    assertEquals((await readVisibility()).profiles, [
      {
        profile_id: "inherited-fixture",
        profile_version: 1,
        grant: "inherited",
      },
    ]);
  } finally {
    if (socket.readyState < WebSocket.CLOSING) {
      const closed = Promise.withResolvers<void>();
      socket.addEventListener("close", () => closed.resolve(), { once: true });
      socket.close();
      await closed.promise;
    }
    await gateway.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
