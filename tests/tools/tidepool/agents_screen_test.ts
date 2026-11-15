/**
 * Tests for agents screen types and handler.
 *
 * @module
 */

import { assertEquals } from "@std/assert";
import type {
  AgentSessionCard,
  AgentTeamCard,
} from "../../../src/tools/tidepool/screens/agents.ts";
import { createTidepoolAgentsHandler } from "../../../src/tools/tidepool/host/host_agents.ts";

Deno.test("AgentSessionCard type is assignable", () => {
  const card: AgentSessionCard = {
    sessionId: "sess-1",
    label: "Main Session",
    model: "kimi-k2.5",
    taint: "PUBLIC",
    status: "green",
    group: "main",
  };
  assertEquals(card.sessionId, "sess-1");
  assertEquals(card.group, "main");
});

Deno.test("AgentTeamCard type holds members", () => {
  const team: AgentTeamCard = {
    teamId: "team-1",
    name: "Research Squad",
    status: "green",
    taint: "CONFIDENTIAL",
    members: [
      {
        sessionId: "lead-1",
        label: "Coordinator",
        taint: "CONFIDENTIAL",
        status: "green",
        group: "teams",
        teamId: "team-1",
        teamRole: "lead",
      },
    ],
  };
  assertEquals(team.members.length, 1);
  assertEquals(team.members[0].teamRole, "lead");
});

Deno.test("TidepoolAgentsHandler manages list subscribers", () => {
  const handler = createTidepoolAgentsHandler();
  // No-op calls should not throw
  const fakeSocket = { readyState: 1 } as unknown as WebSocket;
  handler.subscribeList(fakeSocket);
  handler.unsubscribeList(fakeSocket);
  handler.removeSocket(fakeSocket);
});

Deno.test("buildTidepoolHtml includes agents screen", async () => {
  const { buildTidepoolHtml } = await import(
    "../../../src/tools/tidepool/ui.ts"
  );
  const html = buildTidepoolHtml();
  assertEquals(html.includes("agents-screen"), true);
  assertEquals(html.includes("agents-sidebar"), true);
  assertEquals(html.includes("agents-detail"), true);
  assertEquals(html.includes("detail-placeholder"), true);
});
